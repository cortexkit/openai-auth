// Low-level OpenAI Responses WebSocket protocol helpers. Session pooling,
// fallback, and continuation state intentionally live above this file.

import { APICallError } from "ai"
import { RawWebSocket } from './raw-ws';
import { ResponseStreamError } from "./response-stream-error"
import { errorMessage } from "./util/error"
import { ProxyEnv } from "./util/proxy-env"
import { isRecord } from "./util/record"

export const PROTOCOL_HEADER = "responses_websockets=2026-02-06"

// Real Codex (Rust tokio-tungstenite) emits its WS upgrade application headers in
// this exact order. Bun's WebSocket reorders them, which (with Cloudflare in front)
// could change edge fingerprinting/routing. We can only control the order of our own
// application headers — Bun owns the order of the WS control headers (host/connection/
// upgrade/sec-websocket-*). This normalizes the application headers to Codex's order.
// Gated by CORTEXKIT_OPENAI_AUTH_WS_HEADER_ORDER=1.
const CODEX_WS_HEADER_ORDER = [
  "chatgpt-account-id",
  "authorization",
  "user-agent",
  "originator",
  "openai-beta",
  "version",
  "x-codex-beta-features",
  "x-codex-turn-metadata",
  "x-client-request-id",
  "session-id",
  "thread-id",
  "x-codex-window-id",
]

// Order the WS upgrade headers to match Codex's request (lowercase app headers first, in
// Codex's order). Note: Bun's native WebSocket ignores headers-object insertion order on the
// wire; the hand-rolled RawWebSocket honors it. Kept for parity on both paths.
function orderCodexWsHeaders(headers: Record<string, string>): Record<string, string> {
  const lowerToKey = new Map<string, string>()
  for (const key of Object.keys(headers)) lowerToKey.set(key.toLowerCase(), key)
  const out: Record<string, string> = {}
  for (const want of CODEX_WS_HEADER_ORDER) {
    const actual = lowerToKey.get(want)
    if (actual !== undefined) out[actual] = headers[actual]!
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!CODEX_WS_HEADER_ORDER.includes(key.toLowerCase())) out[key] = value
  }
  return out
}

export interface ConnectResponsesWebSocketOptions {
  url: string
  headers: Record<string, string>
  timeout?: number
  /** Use the hand-rolled Bun.connect WebSocket client instead of Bun's native WebSocket. */
  rawWebSocket?: boolean
  signal?: AbortSignal
}

export interface StreamResponsesWebSocketOptions {
  socket: WebSocket
  body: Record<string, unknown>
  idleTimeout?: number
  signal?: AbortSignal
  onFirstEvent?: (error?: WrappedError) => void
  onComplete?: (event: Record<string, unknown>) => void
  onTerminal?: (event: Record<string, unknown>) => void
  onRetryableTerminal?: (event: Record<string, unknown>) => Promise<WebSocket | undefined>
  onConnectionInvalid?: (error: ResponseStreamError) => void
  onAbort?: (error: Error) => void
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
  return url.replace(/^http/, "ws")
}

export function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
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
  return error instanceof DOMException && error.name === "AbortError"
}

export function connectResponsesWebSocket(options: ConnectResponsesWebSocketOptions) {
  return new Promise<WebSocket>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options.signal))
      return
    }

    let headers: Record<string, string> = {
      ...options.headers,
      "openai-beta": options.headers["openai-beta"] ?? PROTOCOL_HEADER,
    }
    delete headers["content-length"]
    headers = orderCodexWsHeaders(headers)

    // Bun does not apply HTTP(S)_PROXY to WebSockets unless the proxy is supplied explicitly.
    const proxy =
      typeof Bun === "undefined"
        ? undefined
        : ProxyEnv.getProxyForUrl(options.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"))
    // Codex negotiates `permessage-deflate; client_max_window_bits`; match it for wire parity.
    const perMessageDeflate = true
    // Hand-rolled raw client (opt-in): full control of the upgrade header order + RFC 6455
    // framing via Bun.connect, which surfaces Codex-style incremental streaming that Bun's
    // native WebSocket suppresses. Default native Bun WS otherwise.
    const socket = options.rawWebSocket
      ? (new RawWebSocket(options.url, headers) as unknown as WebSocket)
      : new (globalThis.WebSocket as unknown as BunWebSocketConstructor)(options.url, {
          headers,
          ...(proxy ? { proxy } : {}),
          perMessageDeflate,
        })
    const timeout = options.timeout
      ? setTimeout(() => {
          cleanup()
          socket.close()
          reject(new Error("WebSocket connect timed out"))
        }, options.timeout)
      : undefined

    function cleanup() {
      if (timeout) clearTimeout(timeout)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
      options.signal?.removeEventListener("abort", onAbort)
    }

    function onOpen() {
      cleanup()
      resolve(socket)
    }

    function onError(error: Event) {
      cleanup()
      reject(new Error(errorMessage(error), { cause: error }))
    }

    function onClose(event: CloseEvent) {
      cleanup()
      reject(new Error(closeMessage("WebSocket closed before open", event.code, event.reason)))
    }

    function onAbort() {
      cleanup()
      socket.close()
      reject(abortError(options.signal))
    }

    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function streamResponsesWebSocket(options: StreamResponsesWebSocketOptions) {
  const encoder = new TextEncoder()

  let socket = options.socket
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cleanupSocket = () => {}
  let completed = false
  let emitted = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer)
    cleanupSocket()
    options.signal?.removeEventListener("abort", onAbort)
  }

  function terminateSocket(target = socket) {
    target.close()
  }

  function closeCompleted() {
    cleanup()
    controller?.enqueue(encoder.encode("data: [DONE]\n\n"))
    controller?.close()
  }

  function invalidate(error: ResponseStreamError) {
    if (completed) return
    completed = true
    cleanup()
    options.onConnectionInvalid?.(error)
    controller?.error(error)
  }

  function resetIdleTimeout(message: string) {
    if (completed) return
    if (!options.idleTimeout) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => invalidate(new ResponseStreamError(message)), options.idleTimeout)
  }

  async function onMessage(message: MessageEvent) {
    if (completed) return
    if (typeof message.data !== "string") {
      invalidate(new ResponseStreamError("Unexpected binary WebSocket frame"))
      return
    }

    const text = message.data
    const event = (() => {
      try {
        const parsed = JSON.parse(text)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()

    if (event?.type === "error" && options.onRetryableTerminal) {
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
        invalidate(
          new ResponseStreamError(error instanceof Error ? error.message : String(error), {
            cause: error,
          }),
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
      controller?.error(
        new APICallError({
          message: wrappedError.message,
          url: socket.url,
          requestBodyValues: options.body,
          statusCode: wrappedError.status,
          responseHeaders: wrappedError.headers,
          responseBody: wrappedError.body,
        }),
      )
      return
    }

    if (!emitted) options.onFirstEvent?.()
    controller?.enqueue(
      encoder.encode(
        `${text
          .split(/\r?\n/)
          .map((line) => `data: ${line}`)
          .join("\n")}\n\n`,
      ),
    )
    emitted = true
    resetIdleTimeout("idle timeout waiting for websocket")

    if (!event) return

    if (event.type === "response.completed" || event.type === "response.done") {
      completed = true
      options.onComplete?.(event)
      options.onTerminal?.(event)
      closeCompleted()
      return
    }

    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      completed = true
      options.onTerminal?.(event)
      closeCompleted()
    }
  }

  function onError(error: Event) {
    invalidate(new ResponseStreamError(errorMessage(error), { cause: error }))
  }

  function onClose(event: CloseEvent) {
    if (completed) return
    invalidate(
      new ResponseStreamError(closeMessage("WebSocket closed before response.completed", event.code, event.reason)),
    )
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
    socket.addEventListener("message", onMessage)
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
    cleanupSocket = () => {
      socket.removeEventListener("message", onMessage)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
    }
    const { background: _background, ...payload } = options.body
    resetIdleTimeout("idle timeout sending websocket request")
    try {
      socket.send(JSON.stringify({ type: "response.create", ...payload }))
      resetIdleTimeout("idle timeout waiting for websocket")
    } catch (error) {
      if (completed) return
      invalidate(new ResponseStreamError(error instanceof Error ? error.message : String(error), { cause: error }))
    }
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        options.signal?.addEventListener("abort", onAbort, { once: true })

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
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function parseWrappedError(event: Record<string, unknown> | undefined, body: string) {
  if (event?.type !== "error") return
  const status = event.status ?? event.status_code
  if (typeof status !== "number" || (status >= 200 && status < 300)) return
  return {
    status,
    headers: isRecord(event.headers)
      ? Object.fromEntries(
          Object.entries(event.headers).flatMap(([key, value]) =>
            typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? [[key, String(value)]]
              : [],
          ),
        )
      : undefined,
    body,
    message: isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : `${status}`,
  }
}

function cancelError(reason: unknown) {
  if (isAbortError(reason)) return reason
  if (reason instanceof Error) return reason
  return new DOMException(typeof reason === "string" ? reason : "Aborted", "AbortError")
}

function abortError(signal: AbortSignal | undefined) {
  const reason = signal?.reason
  if (isAbortError(reason)) return reason
  return new DOMException(reason instanceof Error ? reason.message : "Aborted", "AbortError")
}

function closeMessage(message: string, code: number, reason: string | Buffer) {
  const details = [`code ${code}`]
  if (code === 1009) details.push("message too big")
  if (reason.length > 0) details.push(reason.toString())
  return `${message} (${details.join(": ")})`
}

export * as OpenAIWebSocket from "./ws"
