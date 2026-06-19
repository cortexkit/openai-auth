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
  onComplete?: (event: Record<string, unknown>) => void
  onTerminal?: (event: Record<string, unknown>) => void
  onRetryableTerminal?: (
    event: Record<string, unknown>,
  ) => Promise<WebSocket | undefined>
  onConnectionInvalid?: (error: ResponseStreamError) => void
  onAbort?: (error: Error) => void
  /** Push per-turn quota from a codex.rate_limits in-band frame. */
  onQuota?: (s: Record<string, unknown>) => void
  /** Display+classify only: called when response.failed carries a rate_limit_reached_type. */
  onRateLimitReached?: (window: string) => void
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
      reject(new Error(errorMessage(error), { cause: error }))
    }

    function onClose(event: CloseEvent) {
      cleanup()
      reject(
        new Error(
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
  let emitted = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

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
    idleTimer = setTimeout(
      () => invalidate(new ResponseStreamError(message)),
      options.idleTimeout,
    )
  }

  async function onMessage(message: MessageEvent) {
    if (completed) return
    if (typeof message.data !== 'string') {
      invalidate(new ResponseStreamError('Unexpected binary WebSocket frame'))
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
      options.onQuota?.(normalizeWsFrame(event as any))
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
        invalidate(
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

    if (event) {
      void logProviderNativeWebSearchEvent(event, options.sessionID)
    }

    const translatedEvent = event ? translateHostedWebSearchEvent(event) : event
    if (!translatedEvent) {
      if (!emitted) options.onFirstEvent?.()
      emitted = true
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
    resetIdleTimeout('idle timeout waiting for websocket')

    if (!translatedEvent) return

    if (
      translatedEvent.type === 'response.completed' ||
      translatedEvent.type === 'response.done'
    ) {
      completed = true
      options.onComplete?.(translatedEvent)
      options.onTerminal?.(translatedEvent)
      closeCompleted()
      return
    }

    if (
      translatedEvent.type === 'response.failed' ||
      translatedEvent.type === 'response.incomplete' ||
      translatedEvent.type === 'error'
    ) {
      completed = true
      // Extract rate_limit_reached_type from response.failed events for
      // display/classification only; do not trigger mid-stream fallback
      // (that decision is locked).
      if (translatedEvent.type === 'response.failed') {
        const rateLimitType = isRecord(translatedEvent.response)
          ? (translatedEvent.response as Record<string, unknown>)?.failed
          : undefined
        if (isRecord(rateLimitType)) {
          const label = (rateLimitType as Record<string, unknown>)
            .rate_limit_reached_type
          if (typeof label === 'string') options.onRateLimitReached?.(label)
        }
      }
      options.onTerminal?.(translatedEvent)
      closeCompleted()
    }
  }

  function onError(error: Event) {
    invalidate(new ResponseStreamError(errorMessage(error), { cause: error }))
  }

  function onClose(event: CloseEvent) {
    if (completed) return
    invalidate(
      new ResponseStreamError(
        closeMessage(
          'WebSocket closed before response.completed',
          event.code,
          event.reason,
        ),
      ),
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
      socket.send(JSON.stringify({ type: 'response.create', ...payload }))
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

function closeMessage(message: string, code: number, reason: string | Buffer) {
  const details = [`code ${code}`]
  if (code === 1009) details.push('message too big')
  if (reason.length > 0) details.push(reason.toString())
  return `${message} (${details.join(': ')})`
}

export * as OpenAIWebSocket from './ws'
