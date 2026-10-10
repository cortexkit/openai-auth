import type { Api, Model } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
// Imported from `/compat` rather than the deep `/api/openai-codex-responses`
// path. Pi's extension loader rewrites pi-ai specifiers so extensions share its
// SDK instance, and its alias table has entries only for the bare root,
// `/compat`, `/oauth`, and `/providers/all`. A deep path prefix-matches the root
// entry, so the remainder is appended to that alias target — a single file —
// producing `dist/compat.js/api/openai-codex-responses` and failing the whole
// extension load. The deep import is valid under the package's own exports map,
// so this only breaks under pi's loader.
//
// `/compat` is the specifier that works in both places: it is aliased
// explicitly by the loader, and it resolves to the same file under plain Node.
// The bare root does NOT work outside pi — it resolves to `dist/index.js`,
// which does not export `streamSimple`.
import { streamSimple as streamSimpleOpenAICodexResponses } from '@earendil-works/pi-ai/compat'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerCommands } from './commands.ts'
import { RawWebSocket } from './raw-ws-node.ts'
import { errorEvent, PiOpenAIRuntime } from './runtime.ts'

const BASE_URL = 'https://chatgpt.com/backend-api'

type CodexModel = Model<'openai-codex-responses'>
type WebSocketOptions =
  | string
  | string[]
  | { headers?: Record<string, string> }
  | undefined

type GlobalWebSocketSlot = { WebSocket?: unknown }

/**
 * Receives every text frame of a Codex WebSocket with the headers the socket
 * was opened with, so a `codex.rate_limits` frame is recorded against the
 * account whose token opened it. Set by the extension.
 */
let webSocketObserver:
  | ((headers: Record<string, string>, data: string) => void)
  | undefined

class PiRawCodexWebSocket extends RawWebSocket {
  constructor(url: string | URL, options?: WebSocketOptions) {
    const headers =
      options && typeof options === 'object' && !Array.isArray(options)
        ? (options.headers ?? {})
        : {}
    super(String(url), headers)
    const observer = webSocketObserver
    if (observer) {
      this.addEventListener('message', (event) => {
        const data = (event as { data?: unknown } | null)?.data
        if (typeof data === 'string') observer(headers, data)
      })
    }
  }
}

let rawWebSocketInstallCount = 0
let originalWebSocket: unknown

export function installRawCodexWebSocket() {
  const global = globalThis as unknown as GlobalWebSocketSlot
  if (rawWebSocketInstallCount === 0) {
    originalWebSocket = global.WebSocket
    global.WebSocket = PiRawCodexWebSocket
  }
  rawWebSocketInstallCount++

  return () => {
    rawWebSocketInstallCount = Math.max(0, rawWebSocketInstallCount - 1)
    if (rawWebSocketInstallCount === 0) {
      if (global.WebSocket === PiRawCodexWebSocket) {
        global.WebSocket = originalWebSocket
      }
      originalWebSocket = undefined
    }
  }
}

const OPENAI_CODEX_MODELS: CodexModel[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text'],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 128_000,
  },
]

/**
 * The provider Pi's models are registered under in vault mode (Pi connected
 * to the Claustrum vault). Pi resolves a provider's auth from its stored
 * credential before it calls the provider's stream, and for a stored OAuth
 * login that means refreshing and storing it when it is close to expiry; with
 * no stored login the models are not offered at all. Pi's own
 * `openai-codex` login must not be touched in vault mode, so the models move
 * to this provider, whose only auth is `VAULT_PLACEHOLDER_KEY`, and
 * `openai-codex` keeps no model to select.
 */
export const VAULT_PROVIDER_ID = 'openai-codex-vault'

/**
 * The static key Pi resolves for `VAULT_PROVIDER_ID`. It is never sent: each
 * attempt authenticates with the token the vault serves for it.
 */
export const VAULT_PLACEHOLDER_KEY = 'openai-auth-vault-mode-not-a-credential'

/** The message for a vault-provider request made after Pi disconnected. */
export const VAULT_PROVIDER_DISCONNECTED_MESSAGE = `Pi is not connected to the credential vault, so the ${VAULT_PROVIDER_ID} models cannot be used. Choose an openai-codex model, or connect Pi to the vault in /openai.`

/** How often the extension checks whether Pi entered or left vault mode. */
const PROVIDER_SYNC_INTERVAL_MS = 5_000

type ProviderRegistrar = Pick<ExtensionAPI, 'registerProvider'> &
  Partial<Pick<ExtensionAPI, 'unregisterProvider'>>

/**
 * Registers this extension's providers for the mode Pi is in now, and
 * re-registers them when the mode changed since the last call: outside vault
 * mode the models live under `openai-codex`, in vault mode under
 * `VAULT_PROVIDER_ID`. Returns the function to call again after a possible
 * change (a Connect or Disconnect, a new session, a request).
 */
export function createProviderSync(
  pi: ProviderRegistrar,
  runtime: PiOpenAIRuntime,
): () => void {
  let registeredVaultMode: boolean | undefined
  const base = {
    baseUrl: BASE_URL,
    api: 'openai-codex-responses' as const,
  }
  return () => {
    const vaultMode = runtime.vaultMode()
    if (registeredVaultMode === vaultMode) return
    const first = registeredVaultMode === undefined
    registeredVaultMode = vaultMode
    if (vaultMode) {
      // No model is left under `openai-codex`, so Pi never resolves (and
      // refreshes) its own login for one of this extension's requests.
      pi.registerProvider('openai-codex', {
        ...base,
        name: 'OpenAI Codex (CortexKit OAuth)',
        models: [],
        streamSimple: (model: Model<Api>, context, options) =>
          runtime.stream(model, context, options),
      })
      pi.registerProvider(VAULT_PROVIDER_ID, {
        ...base,
        name: 'OpenAI Codex (CortexKit vault)',
        apiKey: VAULT_PLACEHOLDER_KEY,
        models: OPENAI_CODEX_MODELS,
        streamSimple: (model: Model<Api>, context, options) => {
          if (!runtime.vaultMode()) {
            const stream = createAssistantMessageEventStream()
            stream.push(errorEvent(model, VAULT_PROVIDER_DISCONNECTED_MESSAGE))
            stream.end()
            return stream
          }
          // The placeholder key is dropped here; it is never sent.
          const { apiKey: _placeholder, ...rest } = options ?? {}
          return runtime.stream(model, context, rest)
        },
      })
      return
    }
    if (!first) pi.unregisterProvider?.(VAULT_PROVIDER_ID)
    pi.registerProvider('openai-codex', {
      ...base,
      name: 'OpenAI Codex (CortexKit OAuth)',
      models: OPENAI_CODEX_MODELS,
      streamSimple: (model: Model<Api>, context, options) =>
        runtime.stream(model, context, options),
    })
  }
}

/**
 * Creates the request path for one loaded extension: requests are routed
 * across Pi's own login and the account pool (see `runtime.ts`).
 */
export function createPiOpenAIRuntime(): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple: (model, context, options) =>
      streamSimpleOpenAICodexResponses(model as CodexModel, context, options),
    createStream: createAssistantMessageEventStream,
    installWebSocket: installRawCodexWebSocket,
  })
}

export default function cortexKitPiOpenAIAuth(pi: ExtensionAPI) {
  const runtime = createPiOpenAIRuntime()
  webSocketObserver = (headers, data) =>
    runtime.observeWebSocketMessage(headers, data)
  const syncProviders = createProviderSync(pi, runtime)
  registerCommands(pi, {
    pool: runtime.commandSupport(),
    afterApply: syncProviders,
  })
  syncProviders()
  // A Connect approved later (its wait runs in the background) or a
  // Disconnect made from another Pi process changes the mode without a menu
  // change here, so the mode is also checked every few seconds.
  setInterval(syncProviders, PROVIDER_SYNC_INTERVAL_MS).unref?.()
  // At session start, read the pool (which starts every row's first quota
  // poll) and take Pi's login, which starts its first quota poll, so the
  // first request finds readings instead of being refused for want of one.
  // In vault mode Pi's login is not asked for: asking Pi for the key makes
  // Pi refresh and store an expired login.
  if (typeof pi.on === 'function') {
    pi.on('session_start', async (_event, ctx) => {
      void runtime.start()
      syncProviders()
      if (runtime.vaultMode()) return
      try {
        runtime.main.observeToken(
          await ctx.modelRegistry.getApiKeyForProvider('openai-codex'),
        )
      } catch {
        // No login yet: the first request hands one over.
      }
    })
  }
}
