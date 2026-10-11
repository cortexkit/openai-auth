// Pi's one `/openai` command: the same menu OpenCode opens (`createOpenAiMenu`
// in the core), drawn with Pi's extension UI by the shared Pi renderer.
//
// The menu works on Pi's account pool. Pi's own `openai-codex` login is not a
// row of it: it is routed as `main` and replaced through Pi's `/login`, so the
// menu shows its quota in a section of its own and refuses to add that
// account again as a row. Its Vault section connects Pi to the Claustrum
// vault; while connected (vault mode) the vault's OpenAI accounts are the only
// ones routed. Pi's login is stashed until disconnect; the pool is untouched.
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
import { VAULT_SLOT_CONFLICT } from './vault-slot.ts'

export type PiCommandDependencies = {
  beginAccountLogin?: typeof beginAccountLogin
  packageVersion?: string
  /** The account pool the request path routes across; the menu works on it. */
  pool?: PiPoolCommands
  /** How the Vault section's Connect polls for the approval (tests shorten it). */
  vaultWait?: VaultWaitOptions
  /**
   * Runs after every change the menu applies, for example a Connect or a
   * Disconnect in the Vault section (Pi reloads its auth snapshot).
   */
  afterApply?: () => unknown
  onContext?: (ctx: ExtensionCommandContext) => void
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
  const vaultMenu = vaultSection({
    vault: pool.vault,
    changed: dependencies.afterApply,
    ...(dependencies.vaultWait ? { wait: dependencies.vaultWait } : {}),
  })
  // The shared account menu uses an approved status to select its no-local
  // view. Pi keeps that view even if approved enrollment loses its token or
  // becomes unreadable; the Vault section below still shows the real status.
  const menuVault: NonNullable<
    Parameters<typeof createOpenAiMenu>[0]['vault']
  > = {
    status: async () => {
      const status = await pool.vault.status()
      return pool.vaultMode()
        ? {
            ...status,
            enrollment: {
              state: 'approved' as const,
              proposedName: pool.vault.name,
              tokenGeneration: 0,
            },
          }
        : status
    },
    refresh: () => pool.vault.refresh(),
    identities: () => pool.vault.identities(),
    routes: () => pool.vault.routes(),
    snapshot: () => pool.vault.snapshot(),
    pollQuota: (id) => pool.vault.pollQuota(id),
  }
  const menu = createOpenAiMenu({
    store: pool.store(),
    vault: menuVault,
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
      {
        ...vaultMenu,
        build: async (invocation) => {
          const view = await vaultMenu.build(invocation)
          const disconnect = {
            id: 'disconnect',
            label: 'Disconnect',
            confirm:
              'Disconnect this Pi host from the vault and restore its original login?',
            run: async () => {
              let result:
                | Awaited<
                    ReturnType<NonNullable<PiPoolCommands['disconnectVault']>>
                  >
                | undefined
              try {
                result = await pool.disconnectVault?.()
              } catch {
                let reloadFailed = false
                try {
                  await dependencies.afterApply?.()
                } catch {
                  reloadFailed = true
                }
                const authority = await pool.readAuthority()
                throw new CommandError(
                  'vault-disconnect-failed',
                  [
                    authority === 'local'
                      ? 'Disconnect did not finish cleanly; local accounts are active. Retry Disconnect if Pi login restoration did not complete.'
                      : 'Disconnect failed; Pi is still enrolled or enrollment is unreadable. Local accounts remain disabled; retry Disconnect to restore the login.',
                    ...(reloadFailed
                      ? [
                          'Pi could not reload its auth snapshot; reopen the session.',
                        ]
                      : []),
                  ].join('\n'),
                )
              }
              await dependencies.afterApply?.()
              return [
                `Disconnected: ${pool.vault.name} no longer reads from the vault. Run \`ck auth enroll revoke --name ${pool.vault.name}\` to revoke it in the vault too.`,
                ...(result === 'conflict' ? [VAULT_SLOT_CONFLICT] : []),
              ].join('\n')
            },
          }
          const actions = view.actions ?? []
          return {
            ...view,
            actions: [
              ...actions.map((action) =>
                action.id === 'disconnect' && pool.disconnectVault
                  ? { ...action, run: disconnect.run }
                  : action,
              ),
              ...(pool.vaultMode() &&
              pool.disconnectVault &&
              !actions.some((action) => action.id === 'disconnect')
                ? [disconnect]
                : []),
            ],
          }
        },
      },
    ],
    afterApply: async () => {
      await dependencies.afterApply?.()
      return pool.reload()
    },
  })
  return {
    command: menu.command,
    open: async (invocation) => {
      await pool.readAuthority()
      return menu.open(invocation)
    },
    apply: async (request, invocation) => {
      await pool.readAuthority()
      return menu.apply(request, invocation)
    },
  }
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
  dependencies.onContext?.(ctx)
  if (dependencies.afterApply) await dependencies.afterApply()
  else await pool.syncVaultSlot?.(() => ctx.modelRegistry.refresh(), true)
  // Take the token Pi holds for its login now, as a request would, so the
  // menu knows which account Pi signs in with. Not in vault mode: asking Pi
  // for the key makes Pi refresh and store an expired login.
  if (!pool.vaultMode()) {
    try {
      await pool.observeLogin(
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
