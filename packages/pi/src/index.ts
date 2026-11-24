import {
  type AccountPaths,
  isVaultHosted,
} from '@cortexkit/openai-auth-core/internal'
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
import {
  getModels as getBuiltinModels,
  streamSimple as streamSimpleOpenAICodexResponses,
} from '@earendil-works/pi-ai/compat'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { installRawCodexWebSocket } from './codex-websocket.ts'
import { PI_CODEX_BASE_URL } from './codex-wire.ts'
import { registerCommands } from './commands.ts'
import { PiOpenAIRuntime, type PiOpenAIRuntimeDeps } from './runtime.ts'
import { preparePiSettingsStartup } from './settings-startup.ts'
import { installHostedVaultKey, VAULT_PLACEHOLDER_KEY } from './vault-slot.ts'

export { installRawCodexWebSocket } from './codex-websocket.ts'

type CodexModel = Model<'openai-codex-responses'>

/**
 * Codex models a ChatGPT login can use that a Pi release may not list yet, each
 * built from the Pi entry of its nearest predecessor (`from`). The Codex
 * backend serves both 6.2 models from client 0.166.0 (measured 2026-11-18);
 * pi-ai's Codex stream sends no client version header, which the backend
 * accepts for them. Context windows are the Codex catalog's defaults, as Pi
 * uses for its own entries. Costs are OpenAI's list prices (models.dev).
 */
const ADDED_CODEX_MODELS: ReadonlyArray<{
  id: string
  name: string
  from: string
  contextWindow: number
  cost: CodexModel['cost']
}> = [
  {
    id: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    from: 'gpt-6.1-sol',
    contextWindow: 500_000,
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 4,
          output: 15,
          cacheRead: 0.2,
          cacheWrite: 5,
        },
      ],
    },
  },
  {
    id: 'gpt-6.2-astra',
    name: 'GPT-6.2 Astra',
    from: 'gpt-6-astra',
    contextWindow: 272_000,
    cost: {
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 16,
          output: 60,
          cacheRead: 0.8,
          cacheWrite: 20,
        },
      ],
    },
  },
]

/**
 * The model list this extension registers for `openai-codex`. Pi replaces its
 * built-in list with an extension's `models`, so this starts from Pi's own
 * Codex models and only adds what that Pi release does not list yet.
 */
export function openAICodexModels(
  builtin: readonly CodexModel[] = getBuiltinModels(
    'openai-codex',
  ) as CodexModel[],
): CodexModel[] {
  const models = [...builtin]
  for (const added of ADDED_CODEX_MODELS) {
    if (models.some((model) => model.id === added.id)) continue
    const template = builtin.find((model) => model.id === added.from)
    if (!template) continue
    models.push({
      ...template,
      id: added.id,
      name: added.name,
      contextWindow: added.contextWindow,
      cost: structuredClone(added.cost),
    })
  }
  return models
}

/** How often enrollment approved outside the menu is noticed. */
const PROVIDER_SYNC_INTERVAL_MS = 5_000

/** The same provider and model ids are used for local and vault accounts. */
export function registerPiProvider(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
  runtime: PiOpenAIRuntime,
): void {
  pi.registerProvider('openai-codex', {
    baseUrl: PI_CODEX_BASE_URL,
    api: 'openai-codex-responses',
    name: 'OpenAI Codex (CortexKit)',
    // Pi's built-in Codex provider is OAuth-only. This enables its api_key
    // resolver for the vault slot without replacing Pi's OAuth login method.
    ...(isVaultHosted() || runtime.vaultMode()
      ? { apiKey: VAULT_PLACEHOLDER_KEY }
      : {}),
    models: openAICodexModels(),
    streamSimple: (model: Model<Api>, context, options) =>
      runtime.stream(model, context, options),
  })
}

/**
 * Creates the request path for one loaded extension: requests are routed
 * across Pi's own login and the account pool (see `runtime.ts`).
 */
export function createPiOpenAIRuntime(
  paths?: AccountPaths,
  settings?: PiOpenAIRuntimeDeps['settings'],
): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    ...(paths ? { paths: () => paths } : {}),
    ...(settings ? { settings } : {}),
    streamSimple: (model, context, options) =>
      streamSimpleOpenAICodexResponses(model as CodexModel, context, options),
    createStream: createAssistantMessageEventStream,
    installWebSocket: installRawCodexWebSocket,
  })
}

export default async function cortexKitPiOpenAIAuth(pi: ExtensionAPI) {
  const settingsStartup = await preparePiSettingsStartup()
  if (settingsStartup.refusal) {
    registerCommands(pi, { settingsStartup })
    return
  }
  const runtime = createPiOpenAIRuntime(
    settingsStartup.paths,
    settingsStartup.snapshot,
  )
  let refresh: (() => unknown) | undefined
  let notify: ((message: string, level: 'error') => void) | undefined
  const syncSlot = (explicit = true) =>
    runtime.syncVaultSlot(
      refresh
        ? async () => {
            registerPiProvider(pi, runtime)
            await refresh?.()
          }
        : undefined,
      explicit,
    )
  const syncInBackground = () => {
    void syncSlot(false).catch(() => {
      notify?.(
        'Pi could not load the vault login slot. Reopen the session or disconnect in /openai.',
        'error',
      )
    })
  }
  registerCommands(pi, {
    settingsStartup,
    pool: runtime.commandSupport(),
    afterApply: syncSlot,
    onContext: (ctx) => {
      refresh = () => ctx.modelRegistry.refresh()
      runtime.resolveMainToken = () =>
        ctx.modelRegistry.getApiKeyForProvider('openai-codex')
      notify = (message, level) => ctx.ui.notify(message, level)
      runtime.setWorkingMessage =
        ctx.hasUI && typeof ctx.ui.setWorkingMessage === 'function'
          ? (message) => ctx.ui.setWorkingMessage(message)
          : undefined
    },
  })
  // Startup can move the login before a session context is available. The
  // first session reloads Pi's auth snapshot before looking up any login.
  await syncSlot().catch(() => {})
  registerPiProvider(pi, runtime)
  const syncTimer = setInterval(syncInBackground, PROVIDER_SYNC_INTERVAL_MS)
  syncTimer.unref?.()
  if (typeof pi.on === 'function') {
    pi.on('session_shutdown', async () => {
      clearInterval(syncTimer)
      settingsStartup.snapshot?.dispose()
      await runtime.dispose()
    })
    pi.on('session_start', async (_event, ctx) => {
      refresh = () => ctx.modelRegistry.refresh()
      runtime.resolveMainToken = () =>
        ctx.modelRegistry.getApiKeyForProvider('openai-codex')
      notify = (message, level) => ctx.ui.notify(message, level)
      runtime.setWorkingMessage =
        ctx.hasUI && typeof ctx.ui.setWorkingMessage === 'function'
          ? (message) => ctx.ui.setWorkingMessage(message)
          : undefined
      void runtime.start()
      try {
        if (isVaultHosted()) {
          await installHostedVaultKey(ctx.modelRegistry, settingsStartup.log)
          return
        }
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
        await runtime
          .commandSupport()
          .observeLogin(
            await ctx.modelRegistry.getApiKeyForProvider('openai-codex'),
          )
      } catch {
        // No login yet: the first request hands one over.
      }
    })
  }
}
