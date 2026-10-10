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
import { PiOpenAIRuntime } from './runtime.ts'
import { VAULT_PLACEHOLDER_KEY } from './vault-slot.ts'

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

/** How often enrollment approved outside the menu is noticed. */
const PROVIDER_SYNC_INTERVAL_MS = 5_000

/** The same provider and model ids are used for local and vault accounts. */
export function registerPiProvider(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
  runtime: PiOpenAIRuntime,
): void {
  pi.registerProvider('openai-codex', {
    baseUrl: BASE_URL,
    api: 'openai-codex-responses',
    name: 'OpenAI Codex (CortexKit)',
    // Pi's built-in Codex provider is OAuth-only. This enables its api_key
    // resolver for the vault slot without replacing Pi's OAuth login method.
    ...(runtime.vaultMode() ? { apiKey: VAULT_PLACEHOLDER_KEY } : {}),
    models: OPENAI_CODEX_MODELS,
    streamSimple: (model: Model<Api>, context, options) =>
      runtime.stream(model, context, options),
  })
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

export default async function cortexKitPiOpenAIAuth(pi: ExtensionAPI) {
  const runtime = createPiOpenAIRuntime()
  webSocketObserver = (headers, data) =>
    runtime.observeWebSocketMessage(headers, data)
  registerPiProvider(pi, runtime)
  let refresh: (() => unknown) | undefined
  let notify: ((message: string, level: 'error') => void) | undefined
  const syncSlot = () =>
    runtime.syncVaultSlot(
      refresh
        ? async () => {
            registerPiProvider(pi, runtime)
            await refresh?.()
          }
        : undefined,
    )
  const syncInBackground = () => {
    void syncSlot().catch(() => {
      notify?.(
        'Pi could not load the vault login slot. Reopen the session or disconnect in /openai.',
        'error',
      )
    })
  }
  registerCommands(pi, {
    pool: runtime.commandSupport(),
    afterApply: syncSlot,
    onContext: (ctx) => {
      refresh = () => ctx.modelRegistry.refresh()
      notify = (message, level) => ctx.ui.notify(message, level)
    },
  })
  // Startup can move the login before a session context is available. The
  // first session reloads Pi's auth snapshot before looking up any login.
  await syncSlot().catch(() => {})
  setInterval(syncInBackground, PROVIDER_SYNC_INTERVAL_MS).unref?.()
  if (typeof pi.on === 'function') {
    pi.on('session_start', async (_event, ctx) => {
      refresh = () => ctx.modelRegistry.refresh()
      notify = (message, level) => ctx.ui.notify(message, level)
      void runtime.start()
      try {
        await syncSlot()
      } catch {
        notify(
          'Pi could not load the vault login slot. Reopen the session or disconnect in /openai.',
          'error',
        )
        return
      }
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
