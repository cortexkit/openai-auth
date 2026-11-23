import { AsyncLocalStorage } from 'node:async_hooks'
import { shapePiCodexWebSocketFrame } from './codex-wire.ts'
import { RawWebSocket } from './raw-ws-node.ts'

type WebSocketOptions = string | string[] | { headers?: Record<string, string> }
type WebSocketArgs = [url: string | URL, options?: WebSocketOptions]
type GlobalWebSocketSlot = { WebSocket?: unknown }
const global = globalThis as unknown as GlobalWebSocketSlot

type WebSocketAttempt = {
  url: string
  token: string
  owner: object
  onMessage(data: string): void
}

const attemptScope = new AsyncLocalStorage<WebSocketAttempt>()

export function withPiCodexWebSocketAttempt<T>(
  attempt: WebSocketAttempt,
  run: () => T,
): T {
  return attemptScope.run(attempt, run)
}

let installCount = 0
let originalWebSocket: unknown

class PiRawCodexWebSocket extends RawWebSocket {
  private readonly binding: Omit<WebSocketAttempt, 'onMessage'>
  private onAttemptMessage?: WebSocketAttempt['onMessage']

  constructor(
    { url, token, owner }: WebSocketAttempt,
    headers: Record<string, string>,
  ) {
    super(url, headers)
    this.binding = { url, token, owner }
    this.addEventListener('message', (event) => {
      const data = (event as { data?: unknown } | null)?.data
      if (typeof data === 'string') this.onAttemptMessage?.(data)
    })
  }

  override send(data: string): void {
    const attempt = attemptScope.getStore()
    if (
      !attempt ||
      attempt.owner !== this.binding.owner ||
      attempt.url !== this.binding.url ||
      attempt.token !== this.binding.token
    ) {
      // pi-ai caches by session and account, not by endpoint or bearer token.
      // A stale connection must not send with the previous attempt's credential.
      throw new Error('Cached Codex WebSocket does not match the request')
    }
    this.onAttemptMessage = attempt.onMessage
    super.send(shapePiCodexWebSocketFrame(data))
  }
}

const shim: typeof PiRawCodexWebSocket = new Proxy(PiRawCodexWebSocket, {
  construct(target, args: WebSocketArgs, newTarget) {
    const [url, options] = args
    const attempt = attemptScope.getStore()
    if (installCount && attempt && String(url) === attempt.url) {
      const headers =
        options && typeof options === 'object' && !Array.isArray(options)
          ? (options.headers ?? {})
          : {}
      if (
        new Headers(headers).get('authorization') === `Bearer ${attempt.token}`
      )
        return Reflect.construct(target, [attempt, headers], newTarget)
    }

    // Bun's pi-ai constructor can retain this shim after the global is restored.
    const original = installCount ? originalWebSocket : global.WebSocket
    if (typeof original !== 'function' || original === shim) {
      throw new TypeError(
        'WebSocket transport is not available in this runtime',
      )
    }
    return Reflect.construct(original, args)
  },
})

export function installRawCodexWebSocket(): () => void {
  if (installCount++ === 0) {
    originalWebSocket = global.WebSocket
    global.WebSocket = shim
  }
  let installed = true
  return () => {
    if (!installed) return
    installed = false
    if (--installCount === 0) {
      if (global.WebSocket === shim) global.WebSocket = originalWebSocket
      originalWebSocket = undefined
    }
  }
}
