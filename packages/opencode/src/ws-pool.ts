import { createHash } from 'node:crypto'
import { isRecord } from '@cortexkit/openai-auth-core/internal'
import { sanitizeHttpFallbackInit } from './codex-http'
import { DUMP_SESSION_HEADER, dumpCodexRequest, dumpDiagnostic } from './dump'
import { ResponseStreamError } from './response-stream-error'
import { stableStringify } from './util/stable-json'
import { uuidV7 } from './util/uuid-v7'
import { OpenAIWebSocket } from './ws'

export const TITLE_HEADER = 'x-opencode-title'
// Internal-only header carrying the quota STORAGE key ('main' or a fallback id)
// for the account this request is sent on. Quota frames must be attributed by
// this internal key, not the wire `chatgpt-account-id` (which can differ from the
// plugin's fallback id, or be present for the main account — both misroute quota).
// Stripped before the socket upgrade / HTTP fallback like every internal header.
export const QUOTA_ACCOUNT_HEADER = 'x-openai-auth-quota-account'
const INTERNAL_HEADERS = new Set([
  TITLE_HEADER,
  DUMP_SESSION_HEADER,
  QUOTA_ACCOUNT_HEADER,
  'x-opencode-session',
])

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
  /** Milliseconds to wait for an immediate provider-side WS error before returning response headers. */
  firstEventGraceMs?: number
  /** Use the hand-rolled raw TCP/TLS WebSocket client instead of native WebSocket. */
  rawWebSocket?: boolean
  /**
   * Push per-turn quota from a codex.rate_limits in-band frame.
   *
   * Receives the snapshot plus the per-request account identity (access token,
   * internal quota account key, and served ChatGPT account id) captured at send
   * time so the frame is attributed to the connection's own account, not a
   * shared mutable global.
   */
  onQuota?: (
    s: Record<string, unknown>,
    accessToken: string,
    accountId: string | undefined,
    servedChatgptAccountId: string | undefined,
  ) => void
  /** Receives quota exhaustion plus the account identity captured at send time. */
  onRateLimitReached?: (
    window: string,
    accountId: string | undefined,
    resetAt?: number,
  ) => void
}

interface PoolEntry {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
  continuation?: ContinuationState
  // Codex keeps ONE turn_id + turn_started_at across a user turn's whole tool-loop, minting a new
  // one only when a fresh (non-*_output) message starts a turn. Tracked here because the trimmed
  // continuation input is only known at send time.
  turnID?: string
  turnStartedAt?: number
  // Last full replay input seen for this logical turn. Unlike continuation,
  // this survives socket reconnects so a replay of prior user messages does
  // not look like a fresh turn.
  turnInput?: unknown[]
  turnSignature?: string
}

interface ContinuationState {
  responseID: string
  input: unknown[]
  signature: string
  // call_ids the chained response actually finalized. Only these may be trimmed
  // from a later continuation suffix; an unfinalized function_call (e.g. an
  // aborted partial whose output is still replayed) must be kept inline.
  finalizedCallIds: Set<string>
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = 'websocket_connection_limit_reached'

/**
 * Derive a short, stable per-account discriminator for the pool key.
 *
 * Prefer the ChatGPT account identity: it survives an OAuth token refresh, so
 * a refresh no longer changes the key. That matters because a changed key
 * hands the next turn a cold socket, and continuation state is connection
 * scoped (see `invalidate`), so the whole `previous_response_id` chain is lost
 * and the prompt cache goes cold on an event that happens on a routine
 * refresh cadence.
 *
 * Fall back to the bearer token only when the wire identity is absent. Do NOT
 * fall back to the internal quota key: that value is the literal 'main' for
 * whichever account is currently primary, so keying on it would let a
 * re-login to a DIFFERENT ChatGPT account reuse the previous account's
 * socket — leaking its codex.rate_limits frames and its continuation chain.
 * The token hash keeps those two accounts apart.
 *
 * The two sources are namespaced so a token can never collide with an id.
 */
function accountDiscriminator(headers: Record<string, string>): string {
  const accountId =
    typeof headers['chatgpt-account-id'] === 'string'
      ? headers['chatgpt-account-id']
      : ''
  const bearer =
    typeof headers.authorization === 'string' &&
    headers.authorization.startsWith('Bearer ')
      ? headers.authorization.slice('Bearer '.length)
      : ''
  const source = accountId ? `acct:${accountId}` : `tok:${bearer}`
  // A short hash is sufficient — we only need stable equality, not secrecy.
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}
export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge =
    options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? 5
  const firstEventGraceMs = options?.firstEventGraceMs ?? 250
  const rawWebSocket = options?.rawWebSocket ?? false
  const onQuota = options?.onQuota
  const onRateLimitReached = options?.onRateLimitReached
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (
    typeof pruneTimer === 'object' &&
    'unref' in pruneTimer &&
    typeof pruneTimer.unref === 'function'
  ) {
    pruneTimer.unref()
  }

  // Every HTTP exit taken by a request that was prepared for the WebSocket has
  // to rotate its own turn_id. prepareCodexRequest skips updateHttpTurnMetadata
  // whenever websocket is true (index.ts), leaving rotation to the pool; if the
  // pool then hands the request to httpFetch untouched, nothing rotates it and
  // the session sends one frozen turn_id for the rest of its life, busting the
  // prompt cache on every later user turn.
  //
  // The body's client_metadata copy is already stripped by
  // sanitizeHttpFallbackBody, so on this path the turn lives in the header
  // alone. Turn state still advances through the shared primitive, so a session
  // that falls back mid-conversation keeps counting turns the same way it did
  // on the socket.
  function httpFallbackInit(
    entry: PoolEntry,
    body: Record<string, unknown> | undefined,
    httpInit: RequestInit | undefined,
  ): RequestInit | undefined {
    if (!body || !httpInit) return httpInit
    // Normalize first: the socket path records its turn input from the
    // normalized body, and advanceTurn compares against that record to decide
    // whether this is a fresh turn. Handing it the raw body would fail that
    // comparison and mint a spurious turn_id on the very fallback we are here
    // to keep stable.
    advanceTurn(entry, normalizeResponseBody(body))
    const headers = new Headers(httpInit.headers)
    const existing = headers.get('x-codex-turn-metadata')
    if (!existing) return httpInit
    const turnMetadata = rewriteTurnMetadata(
      existing,
      entry.turnID,
      entry.turnStartedAt,
    )
    if (!turnMetadata) return httpInit
    headers.set('x-codex-turn-metadata', turnMetadata)
    return { ...httpInit, headers }
  }

  async function websocketFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === 'string'
          ? input
          : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const wsInit = withoutInternalHeaders(init)
    const httpInit = sanitizeHttpFallbackInit(wsInit)

    if (
      init?.method !== 'POST' ||
      !new URL(url).pathname.endsWith('/responses')
    ) {
      return httpFetch(input, httpInit)
    }

    const body = (() => {
      try {
        if (typeof init?.body !== 'string') return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === 'object' && parsed !== null
          ? parsed
          : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return httpFetch(input, httpInit)
    if (internalHeaders[TITLE_HEADER] === 'true') {
      return httpFetch(input, httpInit)
    }

    const sessionID =
      internalHeaders[DUMP_SESSION_HEADER] ??
      internalHeaders['x-session-affinity'] ??
      internalHeaders['session-id']
    const dumpSessionID = sessionID
    if (!sessionID) {
      return httpFetch(input, httpInit)
    }
    // Include the account identity in the pool key so a socket is NEVER reused
    // across accounts. An account switch mid-session produces a different
    // accountDiscriminator → different key → fresh socket → no cross-account
    // codex.rate_limits frame leakage. Same account + same session → same key
    // → socket reuse preserved.
    const sourceHeadersForKey = OpenAIWebSocket.normalizeHeaders(
      wsInit?.headers,
    )
    const acctDisc = accountDiscriminator(sourceHeadersForKey)
    const key = `${sessionID}:${acctDisc}:conversation`
    const requestAccountId =
      typeof internalHeaders[QUOTA_ACCOUNT_HEADER] === 'string'
        ? internalHeaders[QUOTA_ACCOUNT_HEADER]
        : undefined
    const requestOnRateLimitReached = onRateLimitReached
      ? (window: string, resetAt?: number) =>
          onRateLimitReached(window, requestAccountId, resetAt)
      : undefined

    const entry = pool.get(key) ?? {
      lastUsedAt: Date.now(),
      busy: false,
      fallback: false,
      streamFailures: 0,
    }
    pool.set(key, entry)

    if (entry.fallback) {
      return httpFetch(input, httpFallbackInit(entry, body, httpInit))
    }
    if (entry.busy) {
      return httpFetch(input, httpFallbackInit(entry, body, httpInit))
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      const sourceBody = normalizeResponseBody(body)
      const sourceHeaders = OpenAIWebSocket.normalizeHeaders(wsInit?.headers)

      // Capture the per-request account identity at send time so that any
      // codex.rate_limits frame arriving asynchronously is attributed to THIS
      // connection's account, not a shared mutable global that may have been
      // overwritten by a concurrent request.
      const requestAccessToken =
        typeof sourceHeaders.authorization === 'string' &&
        sourceHeaders.authorization.startsWith('Bearer ')
          ? sourceHeaders.authorization.slice('Bearer '.length)
          : ''
      // Attribute quota by the internal storage key threaded from the loader
      // (the account this request was actually sent on), NOT the wire
      // chatgpt-account-id header. The internal key was read from the raw init
      // before internal-header stripping.
      const requestServedChatgptAccountId =
        typeof sourceHeaders['chatgpt-account-id'] === 'string'
          ? sourceHeaders['chatgpt-account-id']
          : undefined
      const requestOnQuota = onQuota
        ? (s: Record<string, unknown>) =>
            onQuota(
              s,
              requestAccessToken,
              requestAccountId,
              requestServedChatgptAccountId,
            )
        : undefined
      const socketHeaders =
        !entry.socket && !entry.continuation
          ? prewarmHeaders(sourceHeaders)
          : sourceHeaders
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        socketHeaders,
        connectTimeout,
        maxConnectionAge,
        rawWebSocket,
        init?.signal,
      )
      if (shouldPrewarm(entry, sourceBody)) {
        await prewarm(entry, sourceBody, idleTimeout, {
          signal: init?.signal ?? undefined,
          sessionID: dumpSessionID,
          url: options?.url ?? url,
          headers: wsInit?.headers,
          onRateLimitReached: requestOnRateLimitReached,
        })
      }
      let resolveFirstEvent: (
        event: boolean | OpenAIWebSocket.WrappedError,
      ) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>(
        (resolve, reject) => {
          resolveFirstEvent = resolve
          rejectFirstEvent = reject
        },
      )
      const continuedBody = withContinuation(entry, sourceBody)
      const requestBody = orderCodexBody(
        applyTurnId(entry, continuedBody, sourceBody),
      )
      // The request chained to the prior continuation iff it carries a
      // previous_response_id (withContinuation only sets it when it actually
      // trimmed against the prior response; an empty-suffix full replay does not).
      const mainChainedToPrior =
        typeof requestBody.previous_response_id === 'string'
      await dumpCodexRequest({
        sessionID: dumpSessionID,
        transport: 'websocket',
        phase: 'main',
        bodyText: JSON.stringify(requestBody),
        url: options?.url ?? url,
        method: wsInit?.method,
        headers: wsInit?.headers,
      })
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body: requestBody,
        sessionID: dumpSessionID ?? undefined,
        idleTimeout,
        signal: init?.signal ?? undefined,
        onQuota: requestOnQuota,
        onRateLimitReached: requestOnRateLimitReached,
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onComplete: (event, finalizedCallIds) => {
          const usage = responseUsage(event)
          void dumpDiagnostic({
            component: 'ws-pool',
            event: 'main_completed',
            sessionID: dumpSessionID,
            responseID: responseID(event),
            usage,
          })
          updateContinuation(
            entry,
            sourceBody,
            event,
            finalizedCallIds,
            mainChainedToPrior,
          )
        },
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (
            event.type !== 'response.completed' &&
            event.type !== 'response.done'
          ) {
            entry.continuation = undefined
            invalidate(entry)
          }
        },
        onConnectionInvalid: (error) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          // A frame the socket refuses for its size will be refused again at
          // the same size, so this session finishes over HTTP, which does not
          // carry the same limit. Codex reaches the same destination after
          // exhausting its WebSocket retries; going straight there skips
          // resending a body already known to be too large.
          if (OpenAIWebSocket.isOversizedFrame(error)) entry.fallback = true
          if (!entry.fallback) recordStreamFailure(entry)
          entry.continuation = undefined
          invalidate(entry)
          resolveFirstEvent(false)
        },
        onAbort: (error) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          entry.continuation = undefined
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          const error = connectionLimitError(event)
          if (!error) return undefined
          entry.fallback = true
          throw error
        },
      })
      const first = await withGrace(firstEvent, firstEventGraceMs)
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599)
          return response
        return new Response(first.body, {
          status: first.status,
          headers: { 'content-type': 'application/json', ...first.headers },
        })
      }
      // advanceTurn is idempotent for a body already applied this send, so the
      // post-attempt exits re-stamp the header without minting a second turn.
      const runHttpFallback = () =>
        httpFetch(input, httpFallbackInit(entry, body, httpInit))
      if (!entry.fallback)
        return relayWithOversizedFallback(response, runHttpFallback)
      return runHttpFallback()
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        entry.streamFailures = 0
        entry.continuation = undefined
        invalidate(entry)
        throw error
      }

      const admissionRateLimit = OpenAIWebSocket.parseRateLimitSignal(error)
      if (admissionRateLimit) {
        requestOnRateLimitReached?.(
          admissionRateLimit.window,
          admissionRateLimit.resetAt,
        )
      }

      // A native (non-raw) WebSocket exposes no HTTP status/body on a failed
      // upgrade, so an admission 429 there is invisible to parseRateLimitSignal.
      // Fall back to HTTP — which surfaces the real status — on any upgrade
      // failure for the standard client. The raw client classifies its own
      // upgrade 429s above and keeps its mark-and-reroute path.
      if (OpenAIWebSocket.isUpgradeFailure(error) && !rawWebSocket) {
        entry.fallback = true
      }

      recordStreamFailure(entry)
      entry.continuation = undefined
      invalidate(entry)
      if (entry.fallback)
        return httpFetch(input, httpFallbackInit(entry, body, httpInit))
      return failedResponse(
        new ResponseStreamError(
          error instanceof Error ? error.message : String(error),
          {
            cause: error,
          },
        ),
      )
    }
  }

  function recordStreamFailure(entry: PoolEntry) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy) continue
      if (now - entry.lastUsedAt < idleTimeout) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    clearInterval(pruneTimer)
    for (const entry of pool.values()) invalidate(entry)
    pool.clear()
  }

  function remove(sessionID: string) {
    // The pool key is now `${sessionID}:${acctDisc}:conversation` — there may
    // be multiple entries for the same session (one per account used). Remove
    // all entries whose key starts with `${sessionID}:` so cleanup is complete
    // regardless of which account was active when the session ended.
    const prefix = `${sessionID}:`
    for (const [key, entry] of pool) {
      if (!key.startsWith(prefix)) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  return Object.assign(websocketFetch, { close, remove })
}

function connectionLimitError(event: Record<string, unknown>) {
  if (
    event.type !== 'error' ||
    !isRecord(event.error) ||
    event.error.code !== CONNECTION_LIMIT_REACHED_CODE
  )
    return
  return new Error(
    typeof event.error.message === 'string'
      ? event.error.message
      : CONNECTION_LIMIT_REACHED_CODE,
  )
}

async function withGrace<T>(promise: Promise<T>, graceMs: number) {
  if (graceMs <= 0) return false as const
  return new Promise<T | false>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), graceMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Hand back a body this pool controls, so an oversized frame can still be
 * answered over HTTP.
 *
 * The verdict arrives late: writing a large request takes longer than the
 * first-event grace, and the peer only refuses it after reading enough to
 * judge. By then this response has been returned to the caller, so the choice
 * of transport cannot be made before handing it over — it has to be made when
 * the failure lands.
 *
 * Swapping is only safe while the consumer has seen nothing. One byte out and
 * a second source would duplicate a stream the reader has already begun.
 */
function relayWithOversizedFallback(
  response: Response,
  fallback: () => Promise<Response>,
): Response {
  const source = response.body
  if (!source) return response
  let delivered = false
  const relayed = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      const pump = async (from: ReadableStreamDefaultReader<Uint8Array>) => {
        while (true) {
          const { done, value } = await from.read()
          if (done) return
          if (value && value.length > 0) {
            delivered = true
            controller.enqueue(value)
          }
        }
      }
      try {
        await pump(reader)
        controller.close()
      } catch (error) {
        if (delivered || !OpenAIWebSocket.isOversizedFrame(error)) {
          controller.error(error)
          return
        }
        try {
          const http = await fallback()
          if (!http.ok) {
            controller.error(
              new ResponseStreamError(
                `HTTP fallback after an oversized WebSocket frame failed with ${http.status}`,
              ),
            )
            return
          }
          if (http.body) await pump(http.body.getReader())
          controller.close()
        } catch (fallbackError) {
          controller.error(fallbackError)
        }
      }
    },
    cancel(reason) {
      void source.cancel(reason)
    },
  })
  return new Response(relayed, {
    status: response.status,
    headers: response.headers,
  })
}

function failedResponse(error: ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  rawWebSocket: boolean,
  signal?: AbortSignal | null,
) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge
  ) {
    return entry.socket
  }

  invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    rawWebSocket,
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  return next
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.close()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
  // previous_response_id only resolves on the connection that produced it (store:false),
  // so a dropped/reconnected socket must discard continuation to avoid previous_response_not_found.
  entry.continuation = undefined
}

async function prewarm(
  entry: PoolEntry,
  body: Record<string, unknown>,
  idleTimeout: number,
  options: {
    signal?: AbortSignal
    sessionID?: string
    url?: string
    headers?: HeadersInit
    onRateLimitReached?: (window: string, resetAt?: number) => void
  },
) {
  if (!entry.socket || !Array.isArray(body.input) || body.input.length === 0)
    return
  const request = prewarmBody(body)
  await dumpCodexRequest({
    sessionID: options.sessionID,
    transport: 'websocket',
    phase: 'prewarm',
    bodyText: JSON.stringify(request),
    url: options.url,
    method: 'POST',
    headers: options.headers,
  })
  const response = OpenAIWebSocket.streamResponsesWebSocket({
    socket: entry.socket,
    body: request,
    sessionID: options.sessionID,
    idleTimeout,
    signal: options.signal,
    // A rate-limit response.failed can arrive on the prewarm connection too;
    // mark the account here so the retry (the prewarm failure surfaces as a
    // retryable stream error) reroutes off it instead of hitting it again.
    onRateLimitReached: options.onRateLimitReached,
    onComplete: (event, finalizedCallIds) => {
      void dumpDiagnostic({
        component: 'ws-pool',
        event: 'prewarm_completed',
        sessionID: options.sessionID,
        responseID: responseID(event),
        usage: responseUsage(event),
      })
      // A prewarm always starts a fresh chain (previous_response_id:null), so it
      // never inherits the prior turn's finalized set.
      updateContinuation(entry, request, event, finalizedCallIds, false)
    },
    onTerminal: (event) => {
      if (event.type !== 'response.completed' && event.type !== 'response.done')
        entry.continuation = undefined
    },
    onConnectionInvalid: () => {
      entry.continuation = undefined
    },
    onAbort: () => {
      entry.continuation = undefined
    },
    // The connection limit is a property of the lane, not of this request, so
    // it will reject the main turn too. Mark the session for HTTP and throw
    // into the caller's catch: the main WebSocket attempt is never made, and
    // the request takes a single HTTP fallback instead of wasting a second
    // doomed round-trip to learn the same thing.
    onRetryableTerminal: async (event) => {
      const error = connectionLimitError(event)
      if (!error) return undefined
      entry.fallback = true
      throw error
    },
  })
  await drain(response)
}

function responseID(event: Record<string, unknown>) {
  const response = event.response
  if (!isRecord(response)) return undefined
  return typeof response.id === 'string' ? response.id : undefined
}

function responseUsage(event: Record<string, unknown>) {
  const response = event.response
  if (!isRecord(response)) return undefined
  return isRecord(response.usage) ? response.usage : undefined
}

async function drain(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return
  while (true) {
    const next = await reader.read()
    if (next.done) return
  }
}

function prewarmBody(body: Record<string, unknown>) {
  return orderCodexBody({
    ...body,
    generate: false,
    input: [],
    previous_response_id: undefined,
    client_metadata: prewarmClientMetadata(body.client_metadata),
  })
}

// Codex prewarm turn-metadata: same field set/order as a turn MINUS turn_started_at_unix_ms,
// with turn_id="" and request_kind="prewarm".
function prewarmTurnMetadata(metadata: Record<string, unknown>) {
  return JSON.stringify({
    session_id: metadata.session_id,
    thread_id: metadata.thread_id,
    thread_source: metadata.thread_source,
    turn_id: '',
    sandbox: metadata.sandbox,
    request_kind: 'prewarm',
    window_id: metadata.window_id,
  })
}

function prewarmClientMetadata(input: unknown) {
  if (!isRecord(input)) return input
  if (typeof input['x-codex-turn-metadata'] !== 'string') return input
  try {
    const metadata = JSON.parse(input['x-codex-turn-metadata'])
    if (!isRecord(metadata)) return input
    return {
      ...input,
      'x-codex-turn-metadata': prewarmTurnMetadata(metadata),
      'x-codex-ws-stream-request-start-ms': String(Date.now()),
    }
  } catch {
    return input
  }
}

function prewarmHeaders(input: Record<string, string>) {
  const metadataText = input['x-codex-turn-metadata']
  if (!metadataText) return input
  try {
    const metadata = JSON.parse(metadataText)
    if (!isRecord(metadata)) return input
    return {
      ...input,
      'x-codex-turn-metadata': prewarmTurnMetadata(metadata),
    }
  } catch {
    return input
  }
}

// Codex serializes the response.create body in this exact key order.
export const CODEX_BODY_KEY_ORDER = [
  'type',
  'model',
  'instructions',
  'previous_response_id',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'include',
  'prompt_cache_key',
  'text',
  'generate',
  'client_metadata',
]

function normalizeResponseBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...body }
  if (Array.isArray(body.input))
    next.input = body.input.map(normalizeResponseInputItem)
  return next
}

// Reconstruct the body in Codex's exact key order; append any unexpected keys at the end.
// Applied at the final send so continuation/prewarm fields land in the right position.
export function orderCodexBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = {}
  for (const key of CODEX_BODY_KEY_ORDER) if (key in body) next[key] = body[key]
  for (const key of Object.keys(body)) if (!(key in next)) next[key] = body[key]
  return next
}

function normalizeResponseInputItem(item: unknown) {
  if (!isRecord(item)) return item
  if (typeof item.type === 'string') return item
  if (typeof item.role !== 'string') return item
  if (!('content' in item)) return item
  return {
    ...item,
    type: 'message',
  }
}

function updateContinuation(
  entry: PoolEntry,
  fullBody: Record<string, unknown>,
  event: Record<string, unknown>,
  finalizedCallIds: Set<string>,
  // Whether the request that produced this response actually chained via
  // previous_response_id to the PRIOR continuation. Only then does this response's
  // reconstructable context include the prior chain's finalized calls.
  chainedToPrior: boolean,
) {
  const response = event.response
  const responseID =
    isRecord(response) && typeof response.id === 'string'
      ? response.id
      : undefined
  if (!responseID || !Array.isArray(fullBody.input)) {
    entry.continuation = undefined
    return
  }
  // Accumulate finalized call ids across the previous_response_id chain, not just
  // the latest response: a suffix can carry the output of a call finalized several
  // responses back (delayed/parallel tool output) — already in the chained context,
  // so still safe to trim. CRUCIAL: only inherit the prior set when THIS request
  // actually chained to it. A request sent WITHOUT previous_response_id (a prewarm,
  // or a full replay emitted when the continuation suffix filtered to empty) starts
  // a fresh reconstructable context; inheriting a stale set there could later trim a
  // function_call this response's context does not contain → re-orphan → 400.
  const chainFinalized = chainedToPrior
    ? new Set(entry.continuation?.finalizedCallIds)
    : new Set<string>()
  for (const id of finalizedCallIds) chainFinalized.add(id)
  entry.continuation = {
    responseID,
    input: fullBody.input,
    signature: bodySignature(fullBody),
    finalizedCallIds: chainFinalized,
  }
}

// Stabilize turn_id/turn_started_at across a turn's tool-loop, matching Codex. The *sent* input
// is authoritative on the normal continuation path: a fresh user turn carries a user/developer
// message; a tool continuation carries only tool *_output items (and possibly an inline,
// unfinalized function_call kept by the continuation guard) and reuses the active turn_id. When a
// reconnect forces a full replay, compare against the previous full input so historical user
// messages do not look like a fresh turn. We key on a user/developer message — matching the HTTP
// path's startsHttpUserTurn — rather than "any non-_output item", so a kept inline function_call
// does not spuriously mint a new turn_id mid tool-loop (which would bust the cache).
// Advance the entry's turn state for this send, minting a new turn_id only when a fresh user turn
// starts. Split from the metadata rewrite because the WebSocket path carries turn metadata in the
// body's client_metadata while the HTTP-fallback path carries it in a header — both must rotate off
// the same decision, or a session that falls back mid-conversation freezes its turn_id.
export function advanceTurn(
  entry: PoolEntry,
  body: Record<string, unknown>,
  fullBody: Record<string, unknown> = body,
) {
  const input = Array.isArray(body.input) ? body.input : []
  const fullInput = Array.isArray(fullBody.input) ? fullBody.input : input
  const fullSignature = bodySignature(fullBody)
  const prefixLength =
    entry.turnInput && entry.turnSignature === fullSignature
      ? matchingInputPrefixLength(entry.turnInput, fullInput)
      : undefined
  const turnInput =
    prefixLength === undefined ? input : fullInput.slice(prefixLength)
  const isNewTurn = turnInput.length > 0 && turnInput.some(isUserTurnMessage)
  if (isNewTurn || !entry.turnID) {
    entry.turnID = uuidV7()
    entry.turnStartedAt = Date.now()
  }
  entry.turnInput = fullInput.slice()
  entry.turnSignature = fullSignature
}

// Stabilize turn_id/turn_started_at across a turn's tool-loop, matching Codex. The *sent* input
// is authoritative on the normal continuation path: a fresh user turn carries a user/developer
// message; a tool continuation carries only tool *_output items (and possibly an inline,
// unfinalized function_call kept by the continuation guard) and reuses the active turn_id. When a
// reconnect forces a full replay, compare against the previous full input so historical user
// messages do not look like a fresh turn. We key on a user/developer message — matching the HTTP
// path's startsHttpUserTurn — rather than "any non-_output item", so a kept inline function_call
// does not spuriously mint a new turn_id mid tool-loop (which would bust the cache).
export function applyTurnId(
  entry: PoolEntry,
  body: Record<string, unknown>,
  fullBody: Record<string, unknown> = body,
) {
  advanceTurn(entry, body, fullBody)
  const cm = body.client_metadata
  if (!isRecord(cm) || typeof cm['x-codex-turn-metadata'] !== 'string')
    return body
  const turnMetadata = rewriteTurnMetadata(
    cm['x-codex-turn-metadata'],
    entry.turnID,
    entry.turnStartedAt,
  )
  if (!turnMetadata) return body
  return {
    ...body,
    client_metadata: { ...cm, 'x-codex-turn-metadata': turnMetadata },
  }
}

// Re-stamp an existing Codex turn-metadata blob with the entry's current turn.
// Returns undefined when the blob is absent or unparseable, so callers leave
// whatever was there untouched rather than inventing a shape.
function rewriteTurnMetadata(
  serialized: string,
  turnID: string | undefined,
  turnStartedAt: number | undefined,
): string | undefined {
  let meta: unknown
  try {
    meta = JSON.parse(serialized)
  } catch {
    return undefined
  }
  if (!isRecord(meta)) return undefined
  return JSON.stringify({
    session_id: meta.session_id,
    thread_id: meta.thread_id,
    thread_source: meta.thread_source,
    turn_id: turnID,
    sandbox: meta.sandbox,
    turn_started_at_unix_ms: turnStartedAt,
    request_kind: 'turn',
    window_id: meta.window_id,
  })
}

function matchingInputPrefixLength(prefix: unknown[], input: unknown[]) {
  if (prefix.length > input.length) return undefined
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index]))
      return undefined
  }
  return prefix.length
}

function withContinuation(entry: PoolEntry, body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? body.input : undefined
  if (!input || !entry.continuation) return body
  if (entry.continuation.signature !== bodySignature(body)) {
    entry.continuation = undefined
    return body
  }
  if (!hasInputPrefix(entry.continuation.input, input)) {
    entry.continuation = undefined
    return body
  }
  if (entry.continuation.input.length === 0) {
    return {
      ...body,
      previous_response_id: entry.continuation.responseID,
    }
  }
  const suffix = input.slice(entry.continuation.input.length)
  const nextInput = continuationInput(
    suffix,
    entry.continuation.finalizedCallIds,
  )
  if (nextInput.length === 0) return body
  return {
    ...body,
    previous_response_id: entry.continuation.responseID,
    input: nextInput,
  }
}

function shouldPrewarm(entry: PoolEntry, body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? body.input : undefined
  if (!entry.continuation) return true
  if (!input) return false
  if (!hasInputPrefix(entry.continuation.input, input)) return true
  const suffix = input.slice(entry.continuation.input.length)
  return suffix.some(isUserTurnMessage)
}

function isUserTurnMessage(item: unknown) {
  if (!isRecord(item)) return false
  if (!(item.type === 'message' || 'role' in item)) return false
  return item.role === 'user' || item.role === 'developer'
}

function continuationInput(input: unknown[], finalizedCallIds: Set<string>) {
  return input.filter((item) => {
    if (!isRecord(item)) return true
    if (typeof item.type === 'string' && item.type.endsWith('_output'))
      return true
    if (
      item.type === 'function_call_output' ||
      item.type === 'custom_tool_call_output'
    )
      return true
    // A function_call is normally dropped from the continuation because the
    // chained response (previous_response_id) already holds it. That only holds
    // when the response actually FINALIZED it. An unfinalized call (e.g. an
    // aborted partial that OpenCode still replays as a function_call/output pair)
    // is NOT in the chained response, so trimming it orphans its output → 400.
    // Keep such a function_call inline so the backend can match it.
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const callId =
        typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : undefined
      return callId ? !finalizedCallIds.has(callId) : true
    }
    if (item.type === 'message') return item.role !== 'assistant'
    if (typeof item.role === 'string') return item.role !== 'assistant'
    return false
  })
}

function bodySignature(body: Record<string, unknown>) {
  return stableStringify(
    normalizeSignatureBody(
      Object.fromEntries(
        Object.entries(body).filter(
          ([key]) =>
            key !== 'input' &&
            key !== 'stream' &&
            key !== 'background' &&
            key !== 'previous_response_id' &&
            key !== 'generate',
        ),
      ),
    ),
  )
}

function normalizeSignatureBody(body: Record<string, unknown>) {
  if (!isRecord(body.client_metadata)) return body
  const client_metadata = Object.fromEntries(
    Object.entries(body.client_metadata).filter(
      ([key]) =>
        key !== 'x-codex-turn-metadata' &&
        key !== 'x-codex-ws-stream-request-start-ms',
    ),
  )
  return { ...body, client_metadata }
}

function hasInputPrefix(prefix: unknown[], input: unknown[]) {
  if (prefix.length >= input.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index]))
      return false
  }
  return true
}

export {
  hasWebSocketResponsesLiteMetadata,
  sanitizeHttpFallbackBody,
} from './codex-http'

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(
  init: T | undefined,
): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    for (const header of INTERNAL_HEADERS) headers.delete(header)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return {
      ...init,
      headers: init.headers.filter(
        (item) => !INTERNAL_HEADERS.has(item[0].toLowerCase()),
      ),
    }
  }

  return {
    ...init,
    headers: Object.fromEntries(
      Object.entries(init.headers).filter(
        ([key]) => !INTERNAL_HEADERS.has(key.toLowerCase()),
      ),
    ),
  }
}

export * as OpenAIWebSocketPool from './ws-pool'
