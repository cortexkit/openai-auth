import { ResponseStreamError } from "./response-stream-error"
import { isRecord } from "./util/record"
import { OpenAIWebSocket } from "./ws"

export const TITLE_HEADER = "x-opencode-title"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
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
}

interface ContinuationState {
  responseID: string
  input: unknown[]
  signature: string
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"
export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? 5
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalHeaders(init)

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) {
      return httpFetch(input, httpInit)
    }

    const body = (() => {
      try {
        if (typeof init?.body !== "string") return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return httpFetch(input, httpInit)
    if (internalHeaders[TITLE_HEADER] === "true") {
      return httpFetch(input, httpInit)
    }

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) {
      return httpFetch(input, httpInit)
    }
    const key = `${sessionID}:conversation`

    const entry = pool.get(key) ?? { lastUsedAt: Date.now(), busy: false, fallback: false, streamFailures: 0 }
    pool.set(key, entry)

    if (entry.fallback) {
      return httpFetch(input, httpInit)
    }
    if (entry.busy) {
      return httpFetch(input, httpInit)
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      const sourceBody = normalizeResponseBody(body)
      const sourceHeaders = OpenAIWebSocket.normalizeHeaders(httpInit?.headers)
      const socketHeaders = !entry.socket && !entry.continuation ? prewarmHeaders(sourceHeaders) : sourceHeaders
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        socketHeaders,
        connectTimeout,
        maxConnectionAge,
        init?.signal,
      )
      if (!entry.continuation) {
        await prewarm(entry, sourceBody, idleTimeout, init?.signal ?? undefined)
      }
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      const requestBody = orderCodexBody(applyTurnId(entry, withContinuation(entry, sourceBody)))
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body: requestBody,
        idleTimeout,
        signal: init?.signal ?? undefined,
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onComplete: (event) => updateContinuation(entry, sourceBody, event),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            entry.continuation = undefined
            invalidate(entry)
          }
        },
        onConnectionInvalid: (error) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
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
          throw error
        },
      })
      const first = await firstEvent
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      if (!entry.fallback) return response
      return httpFetch(input, httpInit)
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        entry.streamFailures = 0
        entry.continuation = undefined
        invalidate(entry)
        throw error
      }

      recordStreamFailure(entry)
      entry.continuation = undefined
      invalidate(entry)
      if (entry.fallback) return httpFetch(input, httpInit)
      return failedResponse(
        new ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
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
      if (entry.fallback) continue
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
    const key = `${sessionID}:conversation`
    const entry = pool.get(key)
    if (!entry) return
    invalidate(entry)
    pool.delete(key)
  }

  return Object.assign(websocketFetch, { close, remove })
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) return
  return new Error(typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE)
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
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
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

async function prewarm(entry: PoolEntry, body: Record<string, unknown>, idleTimeout: number, signal?: AbortSignal) {
  if (!entry.socket || !Array.isArray(body.input) || body.input.length === 0) return
  const request = prewarmBody(body)
  const response = OpenAIWebSocket.streamResponsesWebSocket({
    socket: entry.socket,
    body: request,
    idleTimeout,
    signal,
    onComplete: (event) => updateContinuation(entry, request, event),
    onTerminal: (event) => {
      if (event.type !== "response.completed" && event.type !== "response.done") entry.continuation = undefined
    },
    onConnectionInvalid: () => {
      entry.continuation = undefined
    },
    onAbort: () => {
      entry.continuation = undefined
    },
  })
  await drain(response)
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
    turn_id: "",
    sandbox: metadata.sandbox,
    request_kind: "prewarm",
    window_id: metadata.window_id,
  })
}

function prewarmClientMetadata(input: unknown) {
  if (!isRecord(input)) return input
  if (typeof input["x-codex-turn-metadata"] !== "string") return input
  try {
    const metadata = JSON.parse(input["x-codex-turn-metadata"])
    if (!isRecord(metadata)) return input
    return {
      ...input,
      "x-codex-turn-metadata": prewarmTurnMetadata(metadata),
      "x-codex-ws-stream-request-start-ms": String(Date.now()),
    }
  } catch {
    return input
  }
}

function prewarmHeaders(input: Record<string, string>) {
  const metadataText = input["x-codex-turn-metadata"]
  if (!metadataText) return input
  try {
    const metadata = JSON.parse(metadataText)
    if (!isRecord(metadata)) return input
    return {
      ...input,
      "x-codex-turn-metadata": prewarmTurnMetadata(metadata),
    }
  } catch {
    return input
  }
}

// Codex serializes the response.create body in this exact key order.
const CODEX_BODY_KEY_ORDER = [
  "type",
  "model",
  "instructions",
  "previous_response_id",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
  "generate",
  "client_metadata",
]

function normalizeResponseBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...body }
  if (Array.isArray(body.input)) next.input = body.input.map(normalizeResponseInputItem)
  // Codex WS sends reasoning as { effort } only; it never requests reasoning summaries.
  if (isRecord(body.reasoning) && "summary" in body.reasoning) {
    const { summary: _summary, ...reasoning } = body.reasoning
    next.reasoning = reasoning
  }
  return next
}

// Reconstruct the body in Codex's exact key order; append any unexpected keys at the end.
// Applied at the final send so continuation/prewarm fields land in the right position.
function orderCodexBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = {}
  for (const key of CODEX_BODY_KEY_ORDER) if (key in body) next[key] = body[key]
  for (const key of Object.keys(body)) if (!(key in next)) next[key] = body[key]
  return next
}

function normalizeResponseInputItem(item: unknown) {
  if (!isRecord(item)) return item
  if (typeof item.type === "string") return item
  if (typeof item.role !== "string") return item
  if (!("content" in item)) return item
  return {
    ...item,
    type: "message",
  }
}

function updateContinuation(entry: PoolEntry, fullBody: Record<string, unknown>, event: Record<string, unknown>) {
  const response = event.response
  const responseID = isRecord(response) && typeof response.id === "string" ? response.id : undefined
  if (!responseID || !Array.isArray(fullBody.input)) {
    entry.continuation = undefined
    return
  }
  entry.continuation = {
    responseID,
    input: fullBody.input,
    signature: bodySignature(fullBody),
  }
}

// Stabilize turn_id/turn_started_at across a turn's tool-loop, matching Codex. The *sent* input
// is authoritative: a fresh turn carries a non-*_output message; a tool continuation carries only
// *_output items and reuses the active turn_id.
export function applyTurnId(entry: PoolEntry, body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? body.input : []
  const isNewTurn =
    input.length > 0 &&
    input.some((item) => !(isRecord(item) && typeof item.type === "string" && item.type.endsWith("_output")))
  if (isNewTurn || !entry.turnID) {
    entry.turnID = crypto.randomUUID()
    entry.turnStartedAt = Date.now()
  }
  const cm = body.client_metadata
  if (!isRecord(cm) || typeof cm["x-codex-turn-metadata"] !== "string") return body
  let meta: unknown
  try {
    meta = JSON.parse(cm["x-codex-turn-metadata"])
  } catch {
    return body
  }
  if (!isRecord(meta)) return body
  const turnMetadata = JSON.stringify({
    session_id: meta.session_id,
    thread_id: meta.thread_id,
    thread_source: meta.thread_source,
    turn_id: entry.turnID,
    sandbox: meta.sandbox,
    turn_started_at_unix_ms: entry.turnStartedAt,
    request_kind: "turn",
    window_id: meta.window_id,
  })
  return { ...body, client_metadata: { ...cm, "x-codex-turn-metadata": turnMetadata } }
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
  const suffix = input.slice(entry.continuation.input.length)
  const nextInput = continuationInput(suffix)
  if (nextInput.length === 0) return body
  return {
    ...body,
    previous_response_id: entry.continuation.responseID,
    input: nextInput,
  }
}

function continuationInput(input: unknown[]) {
  return input.filter((item) => {
    if (!isRecord(item)) return true
    if (typeof item.type === "string" && item.type.endsWith("_output")) return true
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return true
    if (item.type === "message") return item.role !== "assistant"
    if (typeof item.role === "string") return item.role !== "assistant"
    return false
  })
}

function bodySignature(body: Record<string, unknown>) {
  return stableStringify(
    normalizeSignatureBody(
      Object.fromEntries(
        Object.entries(body).filter(
          ([key]) =>
            key !== "input" &&
            key !== "stream" &&
            key !== "background" &&
            key !== "previous_response_id" &&
            key !== "generate",
        ),
      ),
    ),
  )
}

function normalizeSignatureBody(body: Record<string, unknown>) {
  if (!isRecord(body.client_metadata)) return body
  const client_metadata = Object.fromEntries(
    Object.entries(body.client_metadata).filter(
      ([key]) => key !== "x-codex-turn-metadata" && key !== "x-codex-ws-stream-request-start-ms",
    ),
  )
  return { ...body, client_metadata }
}

function hasInputPrefix(prefix: unknown[], input: unknown[]) {
  if (prefix.length >= input.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index])) return false
  }
  return true
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stable(value)) ?? "undefined"
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return { ...init, headers: init.headers.filter((item) => item[0].toLowerCase() !== TITLE_HEADER) }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => key.toLowerCase() !== TITLE_HEADER)),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"
