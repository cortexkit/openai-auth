import { AsyncLocalStorage } from 'node:async_hooks'
import { parseJwtClaims } from '@cortexkit/openai-auth-core/internal'
import {
  type PiCodexWireSession,
  shapePiCodexUpgrade,
  shapePiCodexWebSocketFrame,
} from './codex-wire.ts'
import { RawWebSocket } from './raw-ws-node.ts'

type WebSocketOptions = string | string[] | { headers?: Record<string, string> }
type WebSocketArgs = [url: string | URL, options?: WebSocketOptions]
type GlobalWebSocketSlot = { WebSocket?: unknown }
const global = globalThis as unknown as GlobalWebSocketSlot

type WebSocketAttempt = {
  /** Match the SDK's original URL so other socket constructors pass through. */
  sdkUrl: string
  endpoint: string
  token: string
  owner: object
  session: PiCodexWireSession | undefined
  onSend(): void
  onMessage(data: string): void
}

type ScopedAttempt = WebSocketAttempt & {
  cacheKey?: string | undefined
  settled: boolean
}

const attemptScope = new AsyncLocalStorage<ScopedAttempt>()
const cachedSockets = new Map<string, PiRawCodexWebSocket>()

function cacheKey({ session, token }: WebSocketAttempt): string | undefined {
  if (!session) return
  // pi-ai keys the cache by the original session ID and the nested JWT claim,
  // not by the prompt_cache_key sent on the wire or the plugin's routing account ID.
  const accountId =
    parseJwtClaims(token)?.['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof accountId === 'string' && accountId)
    return JSON.stringify([session.threadID, accountId])
}

export function retireIdlePiCodexWebSocket(): void {
  const attempt = attemptScope.getStore()
  if (!attempt?.cacheKey) return
  cachedSockets.get(attempt.cacheKey)?.retireIfIdle(attempt)
}

export function withPiCodexWebSocketAttempt<
  T extends { result(): Promise<unknown> },
>(attempt: WebSocketAttempt, run: () => T): T {
  const scoped = { ...attempt, cacheKey: cacheKey(attempt), settled: false }
  return attemptScope.run(scoped, () => {
    retireIdlePiCodexWebSocket()
    const finish = () => {
      scoped.settled = true
    }
    try {
      const stream = run()
      // pi-ai releases the socket before publishing its terminal stream event.
      void stream.result().then(finish, finish)
      return stream
    } catch (error) {
      finish()
      throw error
    }
  })
}

let installCount = 0
let originalWebSocket: unknown

class PiRawCodexWebSocket extends RawWebSocket {
  private readonly binding: Pick<
    WebSocketAttempt,
    'endpoint' | 'token' | 'owner'
  >
  private readonly cacheKey?: string
  private activeAttempt?: ScopedAttempt

  constructor(attempt: ScopedAttempt, headers: Record<string, string>) {
    const { endpoint, token, owner, cacheKey } = attempt
    super(endpoint, shapePiCodexUpgrade(headers, attempt.session))
    this.binding = { endpoint, token, owner }
    // An open incumbent means pi-ai opened this as a temporary socket while
    // the cached connection was busy. It must not displace the cached one.
    if (cacheKey && cachedSockets.get(cacheKey)?.readyState !== 1) {
      this.cacheKey = cacheKey
      this.addEventListener('close', () => this.forget())
    }
    this.addEventListener('message', (event) => {
      const data = (event as { data?: unknown } | null)?.data
      if (typeof data === 'string') this.activeAttempt?.onMessage(data)
    })
  }

  private matches(attempt: WebSocketAttempt): boolean {
    return (
      attempt.owner === this.binding.owner &&
      attempt.endpoint === this.binding.endpoint &&
      attempt.token === this.binding.token
    )
  }

  retireIfIdle(attempt: ScopedAttempt): void {
    if (
      this.readyState === 1 &&
      this.activeAttempt?.settled &&
      !this.matches(attempt)
    ) {
      this.close()
    }
  }

  private forget(): void {
    if (this.cacheKey && cachedSockets.get(this.cacheKey) === this)
      cachedSockets.delete(this.cacheKey)
  }

  override close(): void {
    this.forget()
    super.close()
  }

  override send(data: string): void {
    const attempt = attemptScope.getStore()
    if (!attempt || !this.matches(attempt)) {
      // This is a transport guard, not a provider error to show the user.
      throw new Error()
    }
    // pi-ai has acquired the socket by the first send. An aborted handshake
    // never gets here and must not replace the cached entry.
    if (!this.activeAttempt && this.cacheKey && this.readyState === 1)
      cachedSockets.set(this.cacheKey, this)
    this.activeAttempt = attempt
    attempt.onSend()
    super.send(shapePiCodexWebSocketFrame(data, attempt.session))
  }
}

const shim: typeof PiRawCodexWebSocket = new Proxy(PiRawCodexWebSocket, {
  construct(target, args: WebSocketArgs, newTarget) {
    const [url, options] = args
    const attempt = attemptScope.getStore()
    if (installCount && attempt && String(url) === attempt.sdkUrl) {
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
