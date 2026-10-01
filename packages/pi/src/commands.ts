// Pi's one `/openai` command: the same menu OpenCode opens (`createOpenAiMenu`
// in the core), drawn with Pi's extension UI by the shared Pi renderer.
//
// The menu works on Pi's account pool. Pi's own `openai-codex` login is not a
// row of it: it is routed as `main` and replaced through Pi's `/login`, so the
// menu shows its quota in a section of its own and refuses to add that
// account again as a row.
import {
  type CommandMenu,
  runPiCommandMenu,
} from '@cortexkit/common-auth/commands'
import {
  createOpenAiMenu,
  OPENAI_COMMAND_NAME,
  sessionSection,
} from '@cortexkit/openai-auth-core'
import {
  beginAccountLogin,
  type OAuthQuotaSnapshot,
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
}

function windowLine(
  name: string,
  window: { usedPercent: number; remainingPercent: number } | undefined,
): string[] {
  return window
    ? [
        `${name}: ${Math.round(window.usedPercent)}% used (${Math.round(window.remainingPercent)}% left)`,
      ]
    : []
}

/** Pi's own login: its last quota reading. */
function piLoginSection(quota: () => OAuthQuotaSnapshot | undefined) {
  return {
    id: 'pi-login',
    title: 'Pi login',
    build: () => {
      const snapshot = quota()
      return {
        lines: [
          "The account Pi signs in with is routed as `main`. Pi's `/login` replaces it.",
          ...(snapshot
            ? [
                ...windowLine('primary', snapshot.primary),
                ...windowLine('secondary', snapshot.secondary),
              ]
            : ['No quota reading yet.']),
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
    login: {
      begin: (options) => begin({ ...options, version }),
      mainIdentity: async () => pool.mainIdentity(),
    },
    quotaCheck: async () => {
      const failures = (await pool.refreshAllQuota()).filter(
        (result) => !result.ok,
      )
      if (failures.length > 0)
        throw new Error(
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
    ],
    afterApply: () => pool.reload(),
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
  // menu knows which account Pi signs in with.
  try {
    pool.observeLogin(
      await ctx.modelRegistry?.getApiKeyForProvider('openai-codex'),
    )
  } catch {
    // No login: the menu shows the pool's rows alone.
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
