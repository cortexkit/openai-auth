import {
  type AccountMenuOptions,
  accountMenuActions,
  quotaLines,
  runMenu,
} from '@cortexkit/common-auth/auth-menu'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import { isQuotaMap, projectQuota } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { OpenAiVault, VaultStatus } from './vault'

export type MenuVault = Pick<
  OpenAiVault,
  'refresh' | 'status' | 'identities' | 'routes' | 'pollQuota' | 'snapshot'
>

export interface VaultMenuView {
  status: VaultStatus
  identities: ReadonlySet<string>
  routes: ReadonlySet<string>
}

export function isVaultMenuConnected(view: VaultMenuView): boolean {
  return view.status.enrollment.state === 'approved'
}

/** Read the vault identities and active routes used by request routing, including cold and declined owners. */
export async function readVaultMenu(vault: MenuVault): Promise<VaultMenuView> {
  return {
    status: await vault.status(),
    identities: vault.identities(),
    routes: new Set(vault.routes().map((route) => route.id)),
  }
}

export function vaultAccountName(row: VaultRosterRow): string {
  return row.label || row.email || row.routeId
}

/** Ownership includes declined and cold accounts, just as request routing does. */
export function isVaultShadowed(
  row: Pick<PoolRow, 'identity'>,
  view: VaultMenuView,
): boolean {
  return row.identity !== undefined && view.identities.has(row.identity)
}

export function setAsideDetail(
  row: Pick<PoolRow, 'identity'>,
  view: VaultMenuView,
): string | undefined {
  if (!isVaultShadowed(row, view)) return undefined
  const owner = view.status.accounts.find(
    (account) => account.accountIdentity === row.identity,
  )
  return owner
    ? `set aside (served by vault ${vaultAccountName(owner)})`
    : 'set aside (the vault serves this account)'
}

/** Use the oldest quota window reading so a newer window cannot make an older one appear current. */
export function quotaReadingAge(
  quota: unknown,
  now: number,
): string | undefined {
  if (!isQuotaMap(quota)) return undefined
  const readings = projectQuota(quota).limits.filter(
    (limit) => limit.kind === 'reading',
  )
  if (readings.length === 0) return undefined
  const age = now - Math.min(...readings.map((limit) => limit.checkedAt))
  if (age <= 15 * 60_000) return undefined
  const minutes = Math.floor(age / 60_000)
  const elapsed =
    minutes >= 1440
      ? `${Math.floor(minutes / 1440)}d`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h`
        : `${minutes}m`
  return `quota read ${elapsed} ago`
}

function datedQuotaLines(row: PoolRow): string[] {
  const age = quotaReadingAge(row.quota, Date.now())
  return [...quotaLines(row), ...(age ? [`  ${age}`] : [])]
}

const SET_ASIDE = 'set aside (the vault serves this account)'

function localLine(row: PoolRow, view: VaultMenuView): string {
  const parts = [
    ...(row.label ? [row.label] : []),
    row.invalid
      ? `invalid ${row.invalid}`
      : row.enabled
        ? 'enabled'
        : `disabled${row.disabledReason ? `: ${row.disabledReason}` : ''}`,
    ...(isVaultShadowed(row, view) ? [SET_ASIDE] : []),
  ]
  return `${row.id}: ${parts.join(', ')}`
}

/** Retain local add/remove and enable/disable actions; list vault accounts and check their quota through the vault. */
export async function runVaultAccountMenu(
  options: AccountMenuOptions,
  vault: MenuVault,
) {
  await vault.refresh()
  const view = await readVaultMenu(vault)
  const { status } = view
  const load = await options.store.read()
  const actions = await accountMenuActions(options)
  const quotaAction = actions.find((action) => action.id === 'check-quotas')
  if (quotaAction) {
    quotaAction.run = async (context) => {
      await vault.refresh()
      const currentView = await readVaultMenu(vault)
      const before = await options.store.read()
      if (before.status !== 'ready') {
        context.print('The local account store could not be read.')
      } else {
        for (const row of before.rows) {
          context.print(localLine(row, currentView))
          if (isVaultShadowed(row, currentView)) continue
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
          for (const line of datedQuotaLines(current ?? row))
            context.print(line)
        }
      }
      const routes = currentView.routes
      for (const row of vault.snapshot()?.rows ?? []) {
        context.print(
          `Vault ${vaultAccountName(row)}: ${row.enabled ? row.state : 'declined'}`,
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
        for (const line of datedQuotaLines({
          quota: current?.quota,
        } as PoolRow))
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
          `Vault ${vaultAccountName(row)}: ${row.enabled ? `enabled (${row.state})` : 'declined'}`,
      ),
      ...(load.status === 'ready'
        ? load.rows.map((row) => localLine(row, view))
        : ['The local account store could not be read.']),
    ],
    actions,
    ...(options.terminal ? { terminal: options.terminal } : {}),
  })
}
