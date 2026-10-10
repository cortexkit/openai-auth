// Pi's one `/openai` command: the same menu OpenCode opens (`createOpenAiMenu`
// in the core), drawn with Pi's extension UI by the shared Pi renderer.
//
// The menu works on Pi's account pool. Pi's own `openai-codex` login is not a
// row of it: it is routed as `main` and replaced through Pi's `/login`, so the
// menu shows its quota in a section of its own and refuses to add that
// account again as a row. Its Vault section connects Pi to the Claustrum
// vault; while connected (vault mode) the vault's OpenAI accounts are the only
// ones routed, and Pi's login and the pool are left untouched.
import {
  CommandError,
  type CommandMenu,
  runPiCommandMenu,
} from '@cortexkit/common-auth/commands'
import {
  formatQuota,
  projectQuota,
  quotaTextParts,
} from '@cortexkit/common-auth/quota'
import {
  createOpenAiMenu,
  OPENAI_COMMAND_NAME,
  sessionSection,
  vaultSection,
} from '@cortexkit/openai-auth-core'
import {
  beginAccountLogin,
  type OAuthQuotaSnapshot,
  type VaultWaitOptions,
} from '@cortexkit/openai-auth-core/internal'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'

import packageJson from '../package.json' with { type: 'json' }
import { clearPiStickyRouting, getPiStickyRouting } from './routing.ts'
import type { PiPoolCommands } from './runtime.ts'

export type PiCommandDependencies = {
  beginAccountLogin?: typeof beginAccountLogin
  packageVersion?: string
  /** The account pool the request path routes across; the menu works on it. */
  pool?: PiPoolCommands
  /** How the Vault section's Connect polls for the approval (tests shorten it). */
  vaultWait?: VaultWaitOptions
  /**
   * Runs after every change the menu applies, for example a Connect or a
   * Disconnect in the Vault section (the extension re-registers its models).
   */
  afterApply?: () => void
}

/** Pi's own login: its last quota reading. */
function piLoginSection(quota: () => OAuthQuotaSnapshot | undefined) {
  return {
    id: 'pi-login',
    title: 'Pi login',
    build: () => {
      const snapshot = quota()
      const now = Date.now()
      const projection = projectQuota({
        limits: (['primary', 'secondary'] as const).flatMap((label) => {
          const window = snapshot?.[label]
          return window
            ? [
                {
                  ...window,
                  kind: 'reading' as const,
                  scope: 'all',
                  label,
                  checkedAt: window.checkedAt ?? now,
                },
              ]
            : []
        }),
        ...(snapshot?.spendControl
          ? {
              budget: {
                ...snapshot.spendControl,
                kind: 'reading' as const,
                checkedAt: now,
              },
            }
          : {}),
      })
      const parts = quotaTextParts(projection, { now })
      return {
        lines: [
          'Managed by Pi /login',
          ...(parts.length > 0 ? parts : [formatQuota(projection, { now })]),
        ],
      }
    },
  }
}

/** The `/openai` menu over Pi's pool. */
export function createPiMenu(
  pool: PiPoolCommands,
  dependencies: PiCommandDependencies = {},
): CommandMenu {
  const begin = dependencies.beginAccountLogin ?? beginAccountLogin
  const version = dependencies.packageVersion ?? packageJson.version
  return createOpenAiMenu({
    store: pool.store(),
    vault: pool.vault,
    login: {
      begin: (options) => begin({ ...options, version }),
      mainIdentity: async () => pool.mainIdentity(),
    },
    quotaCheck: async (ids) => {
      if (ids.length === 1) {
        const store = pool.store()
        for (const id of ids) await store.requestReading(id)
        await store.pullsSettled()
        return
      }
      const failures = (await pool.refreshAllQuota()).filter(
        (result) => !result.ok,
      )
      // A CommandError, so the menu shows which accounts failed and why (it
      // shows a generic line for any other error); the text is still redacted.
      if (failures.length > 0)
        throw new CommandError(
          'quota-check-failed',
          failures
            .map(
              (failure) =>
                `${failure.account}: ${failure.error ?? 'quota check failed'}`,
            )
            .join('\n'),
        )
    },
    extras: [
      piLoginSection(() => pool.mainQuota()),
      sessionSection({
        getPin: async (sessionId) => getPiStickyRouting(sessionId),
        clearPin: async (sessionId) => clearPiStickyRouting(sessionId),
      }),
      vaultSection({
        vault: pool.vault,
        ...(dependencies.vaultWait ? { wait: dependencies.vaultWait } : {}),
      }),
    ],
    afterApply: () => {
      dependencies.afterApply?.()
      return pool.reload()
    },
  })
}

async function runOpenAiCommand(
  ctx: ExtensionCommandContext,
  dependencies: PiCommandDependencies,
): Promise<void> {
  const pool = dependencies.pool
  if (!pool) {
    ctx.ui.notify('The OpenAI account pool is not available.', 'error')
    return
  }
  // Take the token Pi holds for its login now, as a request would, so the
  // menu knows which account Pi signs in with. Not in vault mode: asking Pi
  // for the key makes Pi refresh and store an expired login.
  if (!pool.vaultMode()) {
    try {
      pool.observeLogin(
        await ctx.modelRegistry?.getApiKeyForProvider('openai-codex'),
      )
    } catch {
      // No login: the menu shows the pool's rows alone.
    }
  }
  await runPiCommandMenu(createPiMenu(pool, dependencies), ctx.ui, {
    sessionId: ctx.sessionManager.getSessionId(),
  })
}

export function registerCommands(
  pi: ExtensionAPI,
  dependencies: PiCommandDependencies = {},
): void {
  pi.registerCommand(OPENAI_COMMAND_NAME, {
    description:
      'OpenAI accounts: add and manage accounts, quota, routing and limits',
    handler: (_args, ctx) => runOpenAiCommand(ctx, dependencies),
  })
}
