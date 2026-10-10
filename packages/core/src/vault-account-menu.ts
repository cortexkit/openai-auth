import {
  type AccountMenuOptions,
  accountMenuActions,
  runMenu,
} from '@cortexkit/common-auth/auth-menu'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import {
  formatQuota,
  isQuotaMap,
  projectQuota,
  quotaTextParts,
} from '@cortexkit/common-auth/quota'
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

/**
 * Read the vault's account identities and active routes, as request routing
 * reads them. The identities include accounts the vault holds but will not
 * serve right now (cold: no usable credential; declined: switched off by the
 * operator), so their local copies still count as vault-owned.
 */
export async function readVaultMenu(vault: MenuVault): Promise<VaultMenuView> {
  return {
    status: await vault.status(),
    identities: vault.identities(),
    routes: new Set(vault.routes().map((route) => route.id)),
  }
}

export function vaultAccountName(row: VaultRosterRow): string {
  return row.email || row.label || row.routeId
}

/**
 * Why a local row is set aside (not used, refreshed or polled), or undefined
 * when it is not. In vault mode (the host is connected to the vault) every
 * local row is, whatever account it signs in as, since only the vault's
 * accounts serve; outside it none is. A row signing in as an account the
 * vault holds names the vault account that serves it.
 */
export function setAsideDetail(
  row: Pick<PoolRow, 'identity'>,
  view: VaultMenuView,
): string | undefined {
  if (!isVaultMenuConnected(view)) return undefined
  const owner =
    row.identity === undefined
      ? undefined
      : view.status.accounts.find(
          (account) => account.accountIdentity === row.identity,
        )
  return owner
    ? `set aside (served by vault ${vaultAccountName(owner)})`
    : SET_ASIDE
}

function datedQuotaLines(row: PoolRow, now: number): string[] {
  const projection = projectQuota(isQuotaMap(row.quota) ? row.quota : undefined)
  const parts = quotaTextParts(projection, { now })
  return (parts.length > 0 ? parts : [formatQuota(projection, { now })]).map(
    (line) => `  ${line}`,
  )
}

const SET_ASIDE = 'set aside (this host uses only its vault accounts)'

/** Shown in place of the local accounts while the host is in vault mode. */
export const VAULT_MODE_LOCAL_NOTE =
  'Accounts are managed in the vault with ck. Disconnect to use local accounts.'

/** Message refusing a local account action selected before vault enrollment. */
export const VAULT_LOCAL_ACTION_REFUSAL =
  'Nothing was changed: accounts are managed in the vault with ck. Disconnect to use local accounts.'

function localLine(row: PoolRow): string {
  const parts = [
    ...(row.label ? [row.label] : []),
    row.invalid
      ? `invalid ${row.invalid}`
      : row.enabled
        ? 'enabled'
        : `disabled${row.disabledReason ? `: ${row.disabledReason}` : ''}`,
  ]
  return `${row.id}: ${parts.join(', ')}`
}

/**
 * List and poll only vault accounts while enrolled. Local account management
 * returns after disconnecting; an action selected before enrollment is refused
 * before it can start a login, inspect credentials or repair the local store.
 */
export async function runVaultAccountMenu(
  options: AccountMenuOptions,
  vault: MenuVault,
) {
  await vault.refresh()
  const view = await readVaultMenu(vault)
  const { status } = view
  // In vault mode the local store is not read for the listing.
  const load = isVaultMenuConnected(view)
    ? undefined
    : await options.store.read()
  const localActions = await accountMenuActions(options)
  const vaultActionIds = new Set([
    'check-quotas',
    ...(options.extraActions ?? []).map((action) => action.id),
  ])
  const actions = localActions
    .filter(
      (action) => !isVaultMenuConnected(view) || vaultActionIds.has(action.id),
    )
    .map((action) => ({
      ...action,
      run: async (context: Parameters<typeof action.run>[0]) => {
        if (
          !vaultActionIds.has(action.id) &&
          isVaultMenuConnected(await readVaultMenu(vault))
        ) {
          context.print(VAULT_LOCAL_ACTION_REFUSAL)
          return
        }
        await action.run(context)
      },
    }))
  const quotaAction = actions.find((action) => action.id === 'check-quotas')
  if (quotaAction) {
    quotaAction.run = async (context) => {
      await vault.refresh()
      const currentView = await readVaultMenu(vault)
      const before = isVaultMenuConnected(currentView)
        ? undefined
        : await options.store.read()
      if (!before) {
        context.print(VAULT_MODE_LOCAL_NOTE)
      } else if (before.status !== 'ready') {
        context.print('The local account store could not be read.')
      } else {
        for (const row of before.rows) {
          context.print(localLine(row))
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
          for (const line of datedQuotaLines(
            current ?? row,
            (options.now ?? Date.now)(),
          ))
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
        for (const line of datedQuotaLines(
          {
            quota: current?.quota,
          } as PoolRow,
          (options.now ?? Date.now)(),
        ))
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
      ...(!load
        ? [VAULT_MODE_LOCAL_NOTE]
        : load.status === 'ready'
          ? load.rows.map((row) => localLine(row))
          : ['The local account store could not be read.']),
    ],
    actions,
    ...(options.terminal ? { terminal: options.terminal } : {}),
  })
}
