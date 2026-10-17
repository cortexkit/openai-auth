// The sidebar's account list on a migrated install, projected from the
// account pool's rows.
//
// The sidebar file keeps its shape (an older TUI process may be reading it):
// the account the user signs in with is the pool row `main` and is written as
// the file's `main` entry, never as a fallback; every other row follows in
// roster order as a fallback entry. Quota comes from each row's pool quota
// map. `accountPool: true` is the one field added, and a reader that does not
// know it ignores it.
//
// In vault mode the file lists the vault accounts instead, in the additive
// `vaultAccounts` field, and the old fields list no local account.

import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import { isQuotaMap, projectQuota } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  POOL_MAIN_ROW_ID,
} from '@cortexkit/openai-auth-core/internal'
import { poolKillswitchVerdicts } from '@cortexkit/openai-auth-core/pool-routing'
import type {
  AccountQuota,
  SidebarAccountState,
  SidebarMachineState,
  SpendControlReading,
} from '../sidebar-state'
import { windowsFromQuotaMap } from './pool-quota'

const VAULT_STATES = new Map<string, SidebarAccountState['vaultState']>([
  ['needs_reauth', 'needs sign-in'],
  ['retired', 'turned off in vault'],
  ['corrupt', 'unavailable'],
])

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The credit budget in the sidebar's reading shape, when the pool map holds a
 * full reading of it. A partial reading (no limit or usage numbers) is left
 * out rather than shown with made-up numbers.
 */
function spendControlOf(map: unknown): SpendControlReading | undefined {
  if (!isQuotaMap(map)) return undefined
  const budget = map.budget
  if (budget?.kind !== 'reading') return undefined
  const { limit, used, remaining, usedPercent, remainingPercent } = budget
  if (
    !finite(limit) ||
    !finite(used) ||
    !finite(remaining) ||
    !finite(usedPercent) ||
    !finite(remainingPercent)
  )
    return undefined
  return {
    limit,
    used,
    remaining,
    usedPercent,
    remainingPercent,
    reached: budget.reached,
    ...(budget.resetsAt !== undefined ? { resetsAt: budget.resetsAt } : {}),
    ...(budget.unit !== undefined ? { unit: budget.unit } : {}),
  }
}

/** A row's pool quota map as the sidebar's quota snapshot, or null when it has no reading. */
export function sidebarQuotaFromPoolMap(
  map: unknown,
  resetCredits?: number,
): AccountQuota | null {
  const windows = windowsFromQuotaMap(map)
  const spendControl = spendControlOf(map)
  if (!windows && !spendControl) return null
  const checkedAt = isQuotaMap(map) ? projectQuota(map).checkedAt : undefined
  return {
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(windows?.primary ? { primary: windows.primary } : {}),
    ...(windows?.secondary ? { secondary: windows.secondary } : {}),
    ...(spendControl ? { spendControl } : {}),
    ...(resetCredits !== undefined
      ? { resetCreditsAvailable: resetCredits }
      : {}),
  }
}

/**
 * The sidebar's account snapshot in vault mode: the vault accounts that
 * serve this host instead of its local accounts. The old fields stay in the
 * file for an older TUI, but carry no local account: `main` has no quota and
 * `fallbacks` is empty. The host toggle is separate from vault availability,
 * so an account the vault cannot serve stays visible with its last reading.
 */
export function buildVaultSidebarMachineState(
  rows: readonly VaultRosterRow[],
  routable: ReadonlySet<string>,
  store:
    | Pick<AccountStorage, 'routing' | 'killswitch' | 'quota'>
    | null
    | undefined,
  now: number,
): SidebarMachineState {
  const verdicts = poolKillswitchVerdicts(
    rows.map((row) => ({ id: row.routeId, quota: row.quota })),
    { version: 1, accounts: [], ...store },
    now,
  )
  return {
    main: { quota: null, killed: false },
    fallbacks: [],
    vaultAccounts: rows.map((row, index) => {
      const credits = row.quota?.counters?.resetCredits?.value
      return {
        id: row.routeId,
        credentialId: row.credentialId,
        label:
          row.label && !row.label.includes('@')
            ? row.label
            : `Vault account ${index + 1}`,
        ...(row.accountIdentity !== undefined
          ? { accountId: row.accountIdentity }
          : {}),
        quota: sidebarQuotaFromPoolMap(row.quota, credits),
        killed: verdicts.get(row.routeId) === false,
        enabled: row.enabled,
        routable: routable.has(row.routeId),
        ...(row.state !== 'active' ||
        row.stale ||
        row.unclaimed ||
        (row.enabled && !routable.has(row.routeId))
          ? { vaultState: VAULT_STATES.get(row.state) ?? 'unavailable' }
          : {}),
        ...(credits !== undefined ? { resetCredits: credits } : {}),
      }
    }),
    route: store?.routing?.mode ?? 'main-first',
    lastUpdated: now,
  }
}

/**
 * The machine part of the sidebar state for an install using the account pool. `rows` are
 * the pool's rows in roster order; `resetCreditsFor` supplies the reset-credit
 * count last read by this process for a row id, independently of persisted quota.
 */
export function buildPoolSidebarMachineState(
  rows: readonly PoolRow[],
  store:
    | Pick<AccountStorage, 'routing' | 'killswitch' | 'quota'>
    | null
    | undefined,
  now: number,
  resetCreditsFor: (id: string) => number | undefined = () => undefined,
): SidebarMachineState & { accountPool: true } {
  const verdicts = poolKillswitchVerdicts(
    rows,
    { version: 1, accounts: [], ...store },
    now,
  )
  const main = rows.find((row) => row.id === POOL_MAIN_ROW_ID)
  const mainCredits = main ? resetCreditsFor(main.id) : undefined
  return {
    main: {
      quota: main ? sidebarQuotaFromPoolMap(main.quota, mainCredits) : null,
      ...(main?.identity !== undefined ? { mainAccountId: main.identity } : {}),
      killed: verdicts.get(POOL_MAIN_ROW_ID) === false,
      ...(mainCredits !== undefined ? { resetCredits: mainCredits } : {}),
    },
    fallbacks: rows
      .filter((row) => row.id !== POOL_MAIN_ROW_ID && row.enabled)
      .map((row) => {
        const credits = resetCreditsFor(row.id)
        return {
          id: row.id,
          label: row.label,
          ...(row.identity !== undefined ? { accountId: row.identity } : {}),
          quota: sidebarQuotaFromPoolMap(row.quota, credits),
          killed: verdicts.get(row.id) === false,
          enabled: true,
          ...(credits !== undefined ? { resetCredits: credits } : {}),
        }
      }),
    route: store?.routing?.mode ?? 'main-first',
    lastUpdated: now,
    accountPool: true,
  }
}
