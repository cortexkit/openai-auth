// Low-level OpenAI Responses WebSocket protocol helpers. Session pooling,
// fallback, and continuation state intentionally live above this file.

import { APICallError } from 'ai'
import { DUMP_SESSION_HEADER, dumpDiagnostic } from './dump'
import { translateHostedWebSearchEvent } from './hosted-web-search'
import { createLogger } from './logger'
import { normalizeWsFrame } from './quota-normalize'
import { RawWebSocket } from './raw-ws'
import { ResponseStreamError } from './response-stream-error'
import { errorMessage } from './util/error'
import { ProxyEnv } from './util/proxy-env'
import { isRecord } from './util/record'

const logQ = createLogger('quota')
// Transport lifecycle. Separate from the request dumper on purpose: a stream
// failure the user sees as a hard error has to leave a record at the normal log
// level, and dumps are off by default.
const logT = createLogger('transport')

export const PROTOCOL_HEADER = 'responses_websockets=2026-02-06'

// Real Codex (Rust tokio-tungstenite) emits its WS upgrade application headers in
// this exact order. Bun's WebSocket reorders them, which (with Cloudflare in front)
// could change edge fingerprinting/routing. We can only control the order of our own
// application headers — Bun owns the order of the WS control headers (host/connection/
// upgrade/sec-websocket-*). This normalizes the application headers to Codex's order.
const CODEX_WS_HEADER_ORDER = [
  'chatgpt-account-id',
  'authorization',
  'user-agent',
  'originator',
  'openai-beta',
  'version',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
  'x-client-request-id',
  'session-id',
  'thread-id',
  'x-codex-window-id',
]

const INTERNAL_WS_HEADERS = new Set([DUMP_SESSION_HEADER, 'x-opencode-title'])

// Order the WS upgrade headers to match Codex's request (lowercase app headers first, in
// Codex's order). Note: Bun's native WebSocket ignores headers-object insertion order on the
// wire; the hand-rolled RawWebSocket honors it. Kept for parity on both paths.
function orderCodexWsHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const lowerToKey = new Map<string, string>()
  for (const key of Object.keys(headers)) lowerToKey.set(key.toLowerCase(), key)
  const out: Record<string, string> = {}
  for (const want of CODEX_WS_HEADER_ORDER) {
    const actual = lowerToKey.get(want)
    const value = actual === undefined ? undefined : headers[actual]
    if (actual !== undefined && value !== undefined) out[actual] = value
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!CODEX_WS_HEADER_ORDER.includes(key.toLowerCase())) out[key] = value
  }
  return out
}

function stripInternalWsHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (INTERNAL_WS_HEADERS.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

export interface ConnectResponsesWebSocketOptions {
  url: string
  headers: Record<string, string>
  timeout?: number
  /** Use the hand-rolled raw TCP/TLS WebSocket client instead of native WebSocket. */
  rawWebSocket?: boolean
  signal?: AbortSignal
}

export interface StreamResponsesWebSocketOptions {
  socket: WebSocket
  body: Record<string, unknown>
  sessionID?: string
  idleTimeout?: number
  signal?: AbortSignal
  onFirstEvent?: (error?: WrappedError) => void
  /**
   * Fires on response.completed/response.done. `finalizedFunctionCallIds` is the
   * set of function/custom tool call ids the response actually finalized (emitted
   * a response.output_item.done for). The pool uses it to decide which suffix
   * function_call items are safe to trim from a continuation: only those present
   * in the chained response may be dropped — an unfinalized call (e.g. an aborted
   * partial) must be kept inline or its function_call_output orphans → 400.
   */
  onComplete?: (
    event: Record<string, unknown>,
    finalizedFunctionCallIds: Set<string>,
  ) => void
  onTerminal?: (event: Record<string, unknown>) => void
  onRetryableTerminal?: (
    event: Record<string, unknown>,
  ) => Promise<WebSocket | undefined>
  onConnectionInvalid?: (error: ResponseStreamError) => void
  onAbort?: (error: Error) => void
  /** Push per-turn quota from a codex.rate_limits in-band frame. */
  onQuota?: (s: Record<string, unknown>) => void
  /** Called when the transport reports quota exhaustion for the current connection. */
  onRateLimitReached?: (window: string, resetAt?: number) => void
}

export interface WrappedError {
  status: number
  headers?: Record<string, string>
  body: string
}

type BunWebSocketConstructor = new (
  url: string,
  options?: {
    headers?: Record<string, string>
    proxy?: string
    perMessageDeflate?: boolean
  },
) => WebSocket

export function toWebSocketUrl(url: string) {
  return url.replace(/^http/, 'ws')
}

export function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
    return result
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key.toLowerCase()] = value
    }
    return result
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) result[key.toLowerCase()] = String(value)
  }
  return result
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError'
}

// Errors rejected during the connect/upgrade phase (before the socket opens),
// as opposed to failures mid-stream. The standard WebSocket API exposes no HTTP
// status/body on a failed upgrade, so the pool keys off this marker to fall back
// to HTTP (which surfaces the real status) rather than treat it as a stream error.
const upgradeFailures = new WeakSet<object>()

export function isUpgradeFailure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && upgradeFailures.has(error)
  )
}

// Close code 1009: the peer refused the frame for its size. Marked rather than
// matched on the message so the transport decision does not depend on wording.
const oversizedFrames = new WeakSet<object>()

export function isOversizedFrame(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && oversizedFrames.has(error)
  )
}

export function markOversizedFrame<T extends object>(error: T): T {
  oversizedFrames.add(error)
  return error
}

function upgradeFailure(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  upgradeFailures.add(error)
  return error
}

export function connectResponsesWebSocket(
  options: ConnectResponsesWebSocketOptions,
) {
  return new Promise<WebSocket>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options.signal))
      return
    }

    let headers: Record<string, string> = {
      ...options.headers,
      'openai-beta': options.headers['openai-beta'] ?? PROTOCOL_HEADER,
    }
    const diagnosticSessionID =
      headers[DUMP_SESSION_HEADER] ?? headers['session-id']
    delete headers['content-length']
    headers = orderCodexWsHeaders(stripInternalWsHeaders(headers))

    // Bun does not apply HTTP(S)_PROXY to WebSockets unless the proxy is supplied explicitly.
    const proxy =
      typeof Bun === 'undefined'
        ? undefined
        : ProxyEnv.getProxyForUrl(
            options.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'),
          )
    // Codex negotiates `permessage-deflate; client_max_window_bits`; match it for wire parity.
    const perMessageDeflate = true
    // Hand-rolled raw client (opt-in): full control of the upgrade header order + RFC 6455
    // framing. Bun uses Bun.connect; Node/OpenCode Desktop uses node:net/tls.
    const socket = options.rawWebSocket
      ? (new RawWebSocket(options.url, headers, {
          sessionID: diagnosticSessionID,
        }) as unknown as WebSocket)
      : new (globalThis.WebSocket as unknown as BunWebSocketConstructor)(
          options.url,
          {
            headers,
            ...(proxy ? { proxy } : {}),
            perMessageDeflate,
          },
        )
    const timeout = options.timeout
      ? setTimeout(() => {
          cleanup()
          socket.close()
          reject(new Error('WebSocket connect timed out'))
        }, options.timeout)
      : undefined

    function cleanup() {
      if (timeout) clearTimeout(timeout)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      options.signal?.removeEventListener('abort', onAbort)
    }

    function onOpen() {
      cleanup()
      resolve(socket)
    }

    function onError(error: Event) {
      cleanup()
      reject(upgradeFailure(errorMessage(error), error))
    }

    function onClose(event: CloseEvent) {
      cleanup()
      reject(
        upgradeFailure(
          closeMessage(
            'WebSocket closed before open',
            event.code,
            event.reason,
          ),
        ),
      )
    }

    function onAbort() {
      cleanup()
      socket.close()
      reject(abortError(options.signal))
    }

    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
    socket.addEventListener('close', onClose, { once: true })
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function streamResponsesWebSocket(
  options: StreamResponsesWebSocketOptions,
) {
  const encoder = new TextEncoder()

  let socket = options.socket
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cleanupSocket = () => {}
  let completed = false
  /** Serialized size of the request frame, reported when the peer rejects it. */
  let sentBytes = 0
  let emitted = false
  let emittedOutput = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  // The opening frame types, for diagnosing a response that dies early.
  // emittedOutput is one bit and trips on every frame that is not a lifecycle
  // frame, so it cannot say whether what reached the reader was a part-start or
  // an actual text delta. Those carry different replay risk, and the difference
  // is not recoverable after the fact. Bounded, because only the opening of a
  // response is ever in question.
  const openingFrameTypes: string[] = []
  const OPENING_FRAME_LIMIT = 12
  // Enough to describe a killed response to the provider. Without the id a
  // response that never completed can only be identified as "the one after
  // <previous_response_id>", and without the frame counters the gap between the
  // last frame and the close cannot be bounded after the fact.
  const previousResponseID =
    typeof options.body.previous_response_id === 'string'
      ? options.body.previous_response_id
      : undefined
  // The log carries two session identifiers: socket events are keyed by the
  // Codex thread id, while request and completion records are keyed by the
  // host's session id. Anyone reading one set cannot find the matching records
  // in the other without joining on pid and timestamp, so both identifiers are
  // attached to every line written below.
  const codexSessionID =
    typeof options.body.prompt_cache_key === 'string'
      ? options.body.prompt_cache_key
      : undefined
  const sessionKeys = {
    sessionID: options.sessionID,
    codexSessionID,
  }
  let createdResponseID: string | undefined
  let framesSinceCreated = 0
  let lastFrameAt: number | undefined
  // Call ids the response finalizes (one response.output_item.done per item).
  // Only these are guaranteed present in the response previous_response_id will
  // chain to, so only these are safe to trim from a later continuation suffix.
  const finalizedFunctionCallIds = new Set<string>()

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer)
    cleanupSocket()
    options.signal?.removeEventListener('abort', onAbort)
  }

  function terminateSocket(target = socket) {
    target.close()
  }

  function closeCompleted() {
    cleanup()
    controller?.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller?.close()
  }

  function invalidate(error: ResponseStreamError) {
    fail(error, error)
  }

  // Gated on generated output rather than user-visible text: a
  // `response.output_item.done` carrying a function_call produces no text at
  // all, yet it is exactly the point after which a replay would re-run a
  // side-effecting tool and bill for it twice. Duplicate text is the cheap
  // half of the hazard; a re-dispatched tool call is the expensive one.
  //
  // What that conservatism costs: a transport failure in the window after the
  // first output item but before anything the user would notice now ends the
  // turn instead of rerouting. We give up a reroute rather than risk a double
  // charge. Narrowing this further needs a dispatch-based discriminator (has
  // OpenCode acted on the frame yet?), not a visibility-based one.
  function invalidateTransport(error: ResponseStreamError) {
    // What the response was and how it was progressing when it died. A close
    // carries no such context, so without this the gap between the last frame
    // and the close cannot be bounded afterwards, and a killed continuation
    // cannot be distinguished from a killed fresh request.
    const shape = {
      ...sessionKeys,
      openingFrameTypes,
      responseID: createdResponseID,
      previousResponseID,
      hasContinuation: previousResponseID !== undefined,
      framesSinceCreated,
      msSinceLastFrame:
        lastFrameAt === undefined ? undefined : Date.now() - lastFrameAt,
    }
    if (emittedOutput) {
      // Say why this is terminal. Without the suffix the message is identical
      // to the retryable case, so a deliberate no-replay reads as a transport
      // bug and sends the reader hunting for a fault that is not there.
      //
      // On a continuation the prior response id is named too: the turn cannot
      // be retried here, so the operator resending it by hand is the recovery,
      // and that is the identifier the provider can act on.
      // Deliberately fixed text, carrying neither the provider's wording nor
      // any identifier. The host decides retries by pattern-matching this
      // string (opencode v1.18.30, session/retry.ts `retryable`), and a match
      // wins even over an explicit non-retryable flag. So a provider message
      // like "Rate limit reached", a peer close reason, or an id that happens
      // to contain 429 or 503 would turn this no-replay into a replay and
      // duplicate output the user already saw. What died is in the log line
      // below, which is written at warn and not gated on the dump setting.
      const message = TERMINAL_AFTER_OUTPUT_MESSAGE
      logT.warn('stream failed after output; not retried', {
        reason: error.message,
        emittedOutput: true,
        ...shape,
      })
      fail(
        new Error(message, { cause: error }),
        new ResponseStreamError(message, { cause: error }),
      )
      return
    }
    logT.warn('stream failed before output; retryable', {
      reason: error.message,
      emittedOutput: false,
      ...shape,
    })
    invalidate(error)
  }

  function fail(error: Error, connectionError: ResponseStreamError) {
    if (completed) return
    completed = true
    cleanup()
    options.onConnectionInvalid?.(connectionError)
    controller?.error(error)
  }

  function resetIdleTimeout(message: string) {
    if (completed) return
    if (!options.idleTimeout) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => invalidateTransport(new ResponseStreamError(message)),
      options.idleTimeout,
    )
  }

  async function onMessage(message: MessageEvent) {
    if (completed) return
    if (typeof message.data !== 'string') {
      invalidateTransport(
        new ResponseStreamError('Unexpected binary WebSocket frame'),
      )
      return
    }

    const text = message.data
    const event = (() => {
      try {
        const parsed = JSON.parse(text)
        return typeof parsed === 'object' && parsed !== null
          ? parsed
          : undefined
      } catch {
        return undefined
      }
    })()

    if (event?.type === 'codex.rate_limits') {
      logQ.debug('codex.rate_limits frame received', { pid: process.pid })
      // A received frame counts as activity — reset the idle timer so a
      // stream that sends rate_limits frames but sparse data is not
      // falsely disconnected.
      resetIdleTimeout('idle timeout waiting for websocket')
      // biome-ignore lint/suspicious/noExplicitAny: ws event parsed from JSON
      const quotaFrame = normalizeWsFrame(event as any)
      options.onQuota?.(quotaFrame as Record<string, unknown>)
      return
    }

    const admissionRateLimit = !emittedOutput
      ? parseRateLimitSignal(event)
      : undefined
    if (admissionRateLimit && event) {
      completed = true
      cleanup()
      options.onRateLimitReached?.(
        admissionRateLimit.window,
        admissionRateLimit.resetAt,
      )
      options.onTerminal?.(event)
      options.onFirstEvent?.()
      controller?.error(
        new ResponseStreamError(
          `OpenAI account rate limit reached at admission (${admissionRateLimit.window})`,
        ),
      )
      return
    }

    if (event?.type === 'error' && options.onRetryableTerminal) {
      cleanupSocket()
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      try {
        const next = await options.onRetryableTerminal(event)
        if (completed) {
          if (next) terminateSocket(next)
          return
        }
        if (next) {
          attach(next)
          return
        }
      } catch (error) {
        invalidateTransport(
          new ResponseStreamError(
            error instanceof Error ? error.message : String(error),
            {
              cause: error,
            },
          ),
        )
        return
      }
    }

    const wrappedError = parseWrappedError(event, text)
    if (wrappedError && event) {
      if (!emitted) options.onFirstEvent?.(wrappedError)
      completed = true
      cleanup()
      options.onTerminal?.(event)
      const error = new APICallError({
        message: wrappedError.message,
        url: socket.url,
        requestBodyValues: options.body,
        statusCode: wrappedError.status,
        responseHeaders: wrappedError.headers,
        responseBody: wrappedError.body,
      })
      controller?.error(
        emittedOutput ? new Error(error.message, { cause: error }) : error,
      )
      return
    }

    // Mid-stream quota exhaustion: a response.failed carrying a
    // rate_limit_reached_type means THIS account ran out of quota
    // mid-generation. We already returned status:200 at socket upgrade, so the
    // only way to make OpenCode reroute to another account is to error the
    // response body with a RETRYABLE stream error — its outer retry loop then
    // re-issues the request and our fetch override picks a different account.
    // Enqueuing the response.failed frame and closing normally produces no
    // error part on the stock AI-SDK runtime: the turn ends silently with no
    // reroute (OpenCode session/retry.ts only re-issues on a retryable
    // APICallError or specific error text). So handle it here, BEFORE the
    // frame is enqueued: mark route state first (the loader's callback marks
    // synchronously, so the mark is set when OpenCode re-issues), then error
    // the body; do not enqueue the frame or [DONE].
    //
    // Runtime scope: this drives a same-turn reroute on the STOCK @ai-sdk/openai
    // runtime, where the errored body rejects fullStream with our retryable
    // APICallError and OpenCode's outer retry re-issues. It does NOT reroute on
    // the experimental native runtime (OPENCODE_EXPERIMENTAL_NATIVE_LLM=1): that
    // transport wraps any body-stream error as a non-retryable
    // InvalidProviderOutput (llm/route/transport/http.ts) and replaces the
    // message, so neither the isRetryable marker nor the text below reaches the
    // retry predicate. On native mode the mark still steers the NEXT turn off
    // this account; same-turn reroute there needs an upstream fix. The message
    // stays human-readable regardless.
    if (isRecord(event) && event.type === 'response.failed') {
      const failed = isRecord(event.response)
        ? (event.response as Record<string, unknown>).failed
        : undefined
      const label = isRecord(failed)
        ? (failed as Record<string, unknown>).rate_limit_reached_type
        : undefined
      if (typeof label === 'string') {
        completed = true
        cleanup()
        // Always mark the account (route future turns away from it), attributed
        // to THIS connection via the captured callback.
        options.onRateLimitReached?.(label)
        options.onTerminal?.(event)
        if (!emittedOutput) {
          // Nothing was streamed yet (rate limit at admission, the common
          // case): force a retryable stream error so OpenCode re-issues and the
          // fetch override reroutes to a healthy account THIS turn.
          options.onFirstEvent?.()
          controller?.error(
            new ResponseStreamError(
              `OpenAI account rate limit reached mid-stream (${label})`,
            ),
          )
        } else {
          // Output/reasoning/tool parts already streamed and OpenCode persisted
          // them. Retrying would replay the whole turn — duplicate text, re-run
          // side-effecting tools, and double-bill — so end the turn WITHOUT a
          // retry. The mark still steers the next turn off this account.
          closeCompleted()
        }
        return
      }
    }

    if (event) {
      void logProviderNativeWebSearchEvent(event, options.sessionID)
      recordFinalizedFunctionCall(event, finalizedFunctionCallIds)
    }

    const translatedEvent = event ? translateHostedWebSearchEvent(event) : event
    if (!translatedEvent) {
      // Filtered/control frame (e.g. a hosted-web-search lifecycle event) — no
      // SSE output is enqueued, so it must NOT set `emitted`. Setting it here
      // would block the no-replay reroute for a later admission-time rate limit
      // (the `!emitted` gate above). onFirstEvent still fires so the idle timer
      // and the pool's first-event gate register the activity.
      if (!emitted) options.onFirstEvent?.()
      resetIdleTimeout('idle timeout waiting for websocket')
      return
    }
    const outputText =
      translatedEvent === event ? text : JSON.stringify(translatedEvent)

    if (!emitted) options.onFirstEvent?.()
    controller?.enqueue(
      encoder.encode(
        `${outputText
          .split(/\r?\n/)
          .map((line) => `data: ${line}`)
          .join('\n')}\n\n`,
      ),
    )
    emitted = true
    lastFrameAt = Date.now()
    if (createdResponseID !== undefined) framesSinceCreated++
    if (openingFrameTypes.length < OPENING_FRAME_LIMIT) {
      openingFrameTypes.push(String(translatedEvent.type))
    }
    if (translatedEvent.type === 'response.created') {
      createdResponseID = responseIDOf(translatedEvent)
      // Logged rather than dumped: a response that dies before completing has
      // no id anywhere else, and dumps are off by default, so without this the
      // only way to name it to the provider is "the one after <previous id>".
      logT.debug('response created', {
        ...sessionKeys,
        responseID: createdResponseID,
        previousResponseID,
        hasContinuation: previousResponseID !== undefined,
      })
    }
    if (
      translatedEvent.type !== 'response.created' &&
      translatedEvent.type !== 'response.in_progress'
    ) {
      emittedOutput = true
    }
    resetIdleTimeout('idle timeout waiting for websocket')

    if (!translatedEvent) return

    if (
      translatedEvent.type === 'response.completed' ||
      translatedEvent.type === 'response.done'
    ) {
      completed = true
      // Belt-and-suspenders: the completed frame may carry the full output list;
      // fold any finalized function_call ids it lists into the streamed set.
      collectFinalizedFromResponse(translatedEvent, finalizedFunctionCallIds)
      options.onComplete?.(translatedEvent, finalizedFunctionCallIds)
      options.onTerminal?.(translatedEvent)
      closeCompleted()
      return
    }

    if (
      translatedEvent.type === 'response.failed' ||
      translatedEvent.type === 'response.incomplete' ||
      translatedEvent.type === 'error'
    ) {
      // A rate-limit response.failed is intercepted earlier (errored as a
      // retryable stream failure so OpenCode reroutes). Any OTHER terminal
      // failure/incomplete/error reaching here is non-reroutable and closes
      // the stream benignly.
      completed = true
      options.onTerminal?.(translatedEvent)
      closeCompleted()
    }
  }

  function onError(error: Event) {
    invalidateTransport(
      new ResponseStreamError(errorMessage(error), { cause: error }),
    )
  }

  function onClose(event: CloseEvent) {
    if (completed) return
    // 1009 is the peer refusing this request's size. Resending the same bytes
    // over the same transport is pointless, so it is not retryable here; the
    // pool routes it to HTTP instead when nothing has streamed yet.
    const oversized = event.code === 1009
    // The host can override a non-retryable flag by matching the message text,
    // so this one is built without the peer's reason and without the size: a
    // reason mentioning a lost connection, or a size that reads as 503 KB,
    // would revive the resend loop this flag exists to stop. Both are logged.
    const failure = new ResponseStreamError(
      oversized
        ? OVERSIZED_FRAME_MESSAGE
        : closeMessage(
            'WebSocket closed before response.completed',
            event.code,
            event.reason,
          ),
      { retryable: !oversized },
    )
    if (oversized) {
      logT.warn('websocket peer refused the request size', {
        ...sessionKeys,
        requestBytes: sentBytes,
        reason: event.reason.toString(),
      })
    }
    invalidateTransport(oversized ? markOversizedFrame(failure) : failure)
  }

  function onAbort() {
    const error = abortError(options.signal)
    if (completed) return
    completed = true
    cleanup()
    terminateSocket()
    options.onAbort?.(error)
    controller?.error(error)
  }

  function onCancel(reason: unknown) {
    if (completed) return
    completed = true
    cleanup()
    terminateSocket()
    options.onAbort?.(cancelError(reason))
  }

  function attach(next: WebSocket) {
    cleanupSocket()
    socket = next
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError, { once: true })
    socket.addEventListener('close', onClose, { once: true })
    cleanupSocket = () => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const { background: _background, ...payload } = options.body
    resetIdleTimeout('idle timeout sending websocket request')
    try {
      const frame = JSON.stringify({ type: 'response.create', ...payload })
      sentBytes = frame.length
      socket.send(frame)
      resetIdleTimeout('idle timeout waiting for websocket')
    } catch (error) {
      if (completed) return
      invalidate(
        new ResponseStreamError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        ),
      )
    }
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        options.signal?.addEventListener('abort', onAbort, { once: true })

        if (options.signal?.aborted) {
          onAbort()
          return
        }

        attach(socket)
      },
      cancel(reason) {
        onCancel(reason)
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

async function logProviderNativeWebSearchEvent(
  event: Record<string, unknown>,
  sessionID: string | undefined,
) {
  if (!isProviderNativeWebSearchEvent(event)) return
  await dumpDiagnostic({
    component: 'ws',
    event: 'provider_native_web_search_event',
    sessionID,
    serverEventType: event.type,
    itemType: isRecord(event.item) ? event.item.type : undefined,
    serverEvent: event,
  })
}

function isProviderNativeWebSearchEvent(event: Record<string, unknown>) {
  if (
    typeof event.type === 'string' &&
    (event.type.startsWith('response.web_search_call.') ||
      event.type.startsWith('response.web_search_preview_call.'))
  ) {
    return true
  }
  if (isRecord(event.item) && typeof event.item.type === 'string') {
    return (
      event.item.type === 'web_search_call' ||
      event.item.type === 'web_search_preview_call'
    )
  }
  return false
}

// A function/custom tool call is "finalized" once the response emits its
// response.output_item.done. Its call_id is then guaranteed to live in the
// stored response, so a later continuation chained via previous_response_id may
// safely omit the matching function_call from its input.
function recordFinalizedFunctionCall(
  event: Record<string, unknown>,
  into: Set<string>,
) {
  if (event.type !== 'response.output_item.done') return
  if (!isRecord(event.item)) return
  addFinalizedCallId(event.item, into)
}

// The response.completed/done frame may carry the full output[] list. Fold any
// finalized function_call ids it lists into the set, in case an output_item.done
// was missed (e.g. coalesced frames).
function collectFinalizedFromResponse(
  event: Record<string, unknown>,
  into: Set<string>,
) {
  const response = event.response
  if (!isRecord(response) || !Array.isArray(response.output)) return
  for (const item of response.output) {
    if (isRecord(item)) addFinalizedCallId(item, into)
  }
}

function addFinalizedCallId(item: Record<string, unknown>, into: Set<string>) {
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return
  const callId =
    typeof item.call_id === 'string'
      ? item.call_id
      : typeof item.id === 'string'
        ? item.id
        : undefined
  if (callId) into.add(callId)
}

function parseWrappedError(
  event: Record<string, unknown> | undefined,
  body: string,
) {
  if (event?.type !== 'error') return
  const status = event.status ?? event.status_code
  if (typeof status !== 'number' || (status >= 200 && status < 300)) return
  return {
    status,
    headers: isRecord(event.headers)
      ? Object.fromEntries(
          Object.entries(event.headers).flatMap(([key, value]) =>
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
              ? [[key, String(value)]]
              : [],
          ),
        )
      : undefined,
    body,
    message:
      isRecord(event.error) && typeof event.error.message === 'string'
        ? event.error.message
        : `${status}`,
  }
}

export function parseRateLimitSignal(value: unknown):
  | {
      window: string
      resetAt?: number
    }
  | undefined {
  if (typeof value === 'string') {
    try {
      return parseRateLimitSignal(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined

  const causeSignal = parseRateLimitSignal(value.cause)
  if (causeSignal) return causeSignal
  const bodySignal = parseRateLimitSignal(value.body)
  if (bodySignal) return bodySignal

  const detail = isRecord(value.error) ? value.error : value
  const type = typeof detail.type === 'string' ? detail.type : undefined
  const status = value.status ?? value.status_code
  if (type !== 'usage_limit_reached' && status !== 429) return undefined

  const resetsAtSeconds = detail.resets_at
  const resetsInSeconds = detail.resets_in_seconds
  const resetAt =
    typeof resetsAtSeconds === 'number' &&
    Number.isFinite(resetsAtSeconds) &&
    resetsAtSeconds > 0
      ? resetsAtSeconds * 1000
      : typeof resetsInSeconds === 'number' &&
          Number.isFinite(resetsInSeconds) &&
          resetsInSeconds > 0
        ? Date.now() + resetsInSeconds * 1000
        : undefined

  return { window: type ?? 'primary', resetAt }
}

function cancelError(reason: unknown) {
  if (isAbortError(reason)) return reason
  if (reason instanceof Error) return reason
  return new DOMException(
    typeof reason === 'string' ? reason : 'Aborted',
    'AbortError',
  )
}

function abortError(signal: AbortSignal | undefined) {
  const reason = signal?.reason
  if (isAbortError(reason)) return reason
  if (isProviderRetryableAbortReason(reason)) return reason
  return new DOMException(
    reason instanceof Error ? reason.message : 'Aborted',
    'AbortError',
  )
}

function isProviderRetryableAbortReason(reason: unknown): reason is Error {
  return (
    reason instanceof Error &&
    (reason.name === 'ProviderHeaderTimeoutError' ||
      reason.name === 'ProviderResponseStreamError')
  )
}

function responseIDOf(event: Record<string, unknown>) {
  const response = event.response
  if (!isRecord(response)) return undefined
  return typeof response.id === 'string' ? response.id : undefined
}

/**
 * Surfaced when a stream dies after output has reached the reader.
 *
 * Must not contain any substring the host reads as retryable — no provider
 * wording, no response ids, no byte counts. `ws-pool.test.ts` pins it against
 * the host's pattern set.
 */
export const TERMINAL_AFTER_OUTPUT_MESSAGE =
  'The response ended early after part of it had already been shown. It was not sent again, because repeating it would duplicate that output and re-run any tools it had started. The transport log records what ended it.'

/**
 * Surfaced when the peer refuses the request frame as too large (close 1009).
 *
 * Fixed text for the same reason as {@link TERMINAL_AFTER_OUTPUT_MESSAGE}: the
 * host can override this error's non-retryable flag by matching the message,
 * and resending a frame the peer has already measured and refused is the one
 * outcome this path exists to prevent. The size and the peer's reason are
 * logged instead.
 */
export const OVERSIZED_FRAME_MESSAGE =
  'The request was larger than the websocket would carry, so it was sent over HTTP instead. Resending it unchanged over the same socket cannot succeed. The transport log records the size.'

function closeMessage(message: string, code: number, reason: string | Buffer) {
  const details = [`code ${code}`]
  if (reason.length > 0) details.push(reason.toString())
  return `${message} (${details.join(': ')})`
}

export * as OpenAIWebSocket from './ws'
