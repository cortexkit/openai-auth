import {
  type AccountMenuOptions,
  accountMenuActions,
  quotaLines,
  runMenu,
} from '@cortexkit/common-auth/auth-menu'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { OpenAiVault } from '@cortexkit/openai-auth-core/internal'

type MenuVault = Pick<
  OpenAiVault,
  'refresh' | 'status' | 'identities' | 'routes' | 'pollQuota' | 'snapshot'
>

const SET_ASIDE = 'set aside (the vault serves this account)'

function localLine(row: PoolRow, identities: ReadonlySet<string>): string {
  const parts = [
    ...(row.label ? [row.label] : []),
    row.invalid
      ? `invalid ${row.invalid}`
      : row.enabled
        ? 'enabled'
        : `disabled${row.disabledReason ? `: ${row.disabledReason}` : ''}`,
    ...(row.identity !== undefined && identities.has(row.identity)
      ? [SET_ASIDE]
      : []),
  ]
  return `${row.id}: ${parts.join(', ')}`
}

/** Keep local account management while listing vault accounts and polling their quota through the vault. */
export async function runVaultAccountMenu(
  options: AccountMenuOptions,
  vault: MenuVault,
) {
  await vault.refresh()
  const status = await vault.status()
  const identities = vault.identities()
  const load = await options.store.read()
  const actions = await accountMenuActions(options)
  const quotaAction = actions.find((action) => action.id === 'check-quotas')
  if (quotaAction) {
    quotaAction.run = async (context) => {
      await vault.refresh()
      const owned = vault.identities()
      const before = await options.store.read()
      if (before.status !== 'ready') {
        context.print('The local account store could not be read.')
      } else {
        for (const row of before.rows) {
          context.print(localLine(row, owned))
          if (row.identity !== undefined && owned.has(row.identity)) continue
          try {
            if (options.pollQuota && row.credentialEpoch !== undefined) {
              const observation = await options.pollQuota(row)
              await options.store.recordQuota(
                row.id,
                {
                  credentialEpoch: row.credentialEpoch,
                  ...(row.identity !== undefined
                    ? { identity: row.identity }
                    : {}),
                },
                observation,
              )
            }
          } catch (error) {
            context.print(
              `  quota check failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          const after = await options.store.read()
          const current =
            after.status === 'ready'
              ? after.rows.find((item) => item.id === row.id)
              : undefined
          for (const line of quotaLines(current ?? row)) context.print(line)
        }
      }
      const routes = new Set(vault.routes().map((route) => route.id))
      for (const row of vault.snapshot()?.rows ?? []) {
        context.print(
          `Vault ${row.label || row.email || row.routeId}: ${row.enabled ? row.state : 'declined'}`,
        )
        if (!routes.has(row.routeId)) {
          context.print(
            '  quota check skipped: account is not enabled and active',
          )
          continue
        }
        const result = await vault.pollQuota(row.routeId)
        if (!result.ok)
          context.print(
            `  quota check failed: ${result.error ?? 'vault unavailable'}`,
          )
        const current = vault
          .snapshot()
          ?.rows.find((item) => item.routeId === row.routeId)
        for (const line of quotaLines({ quota: current?.quota } as PoolRow))
          context.print(line)
      }
      const after = await vault.status()
      if (after.lastError)
        context.print(`Claustrum vault unreachable: ${after.lastError}`)
    }
  }
  return runMenu({
    title: options.title,
    subtitle: 'Select an account action',
    status: [
      ...((await options.status?.()) ?? []),
      ...(status.lastError
        ? [`Claustrum vault unreachable: ${status.lastError}`]
        : []),
      ...status.accounts.map(
        (row) =>
          `Vault ${row.label || row.email || row.routeId}: ${row.enabled ? `enabled (${row.state})` : 'declined'}`,
      ),
      ...(load.status === 'ready'
        ? load.rows.map((row) => localLine(row, identities))
        : ['The local account store could not be read.']),
    ],
    actions,
    ...(options.terminal ? { terminal: options.terminal } : {}),
  })
}
