// Managing the accounts of a migrated install: what `/openai-account` and the
// auth menu do once every account is a row of the account pool
// (`@cortexkit/common-auth/store`).
//
// - A new login becomes a row through `store.add`; a login of an account a row
//   already holds replaces that row's credential (`store.replace`), the way the
//   legacy roster merged a re-added account into its existing entry.
// - Disabling goes through `store.disable`. The store has no enable or remove
//   operation, so enabling flips the roster row's `enabled` flag, and removing
//   drops the roster row and its credential, both through the legacy roster
//   writer (`mutateAccounts`). That writer takes the same `save` locks the
//   store holds around its own writes, so the two never interleave, and the
//   store drops the removed row's pool entry on its next write.
// - Reordering swaps two roster rows; the roster order is the pool's order.
// - Row `main` holds the account OpenCode's login slot points at (the slot
//   keeps only a placeholder), so it is never removed.

import { readFileSync } from 'node:fs'
import { type QuotaObservation, quotaCodec } from '@cortexkit/common-auth/quota'
import {
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolRow,
  type PoolStore,
  type PullRequest,
} from '@cortexkit/common-auth/store'
import type { CommandContext } from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  mutateAccounts,
  POOL_MAIN_ROW_ID,
} from '@cortexkit/openai-auth-core/internal'
import { readPoolMigrationBookkeeping } from './pool-migration'

/** The `disabledReason` value the store records on a row the user disabled. */
export const POOL_USER_DISABLED_REASON = 'disabled-by-user'

/** The message shown when the user asks to remove row `main`. */
export const POOL_MAIN_REMOVAL_REFUSED =
  'The `main` account holds the login OpenCode signs in with (its login slot only points at it), so it cannot be removed. Sign in with another account through `opencode auth login` to replace it.'

/** A login to add: the shape `beginAccountLogin` resolves to. */
export interface PoolLogin {
  id: string
  label?: string
  access?: string
  refresh: string
  expires?: number
  /** The account's ChatGPT identity, when the login's access token names one. */
  accountId?: string
}

export type PoolAddOutcome =
  | { status: 'added'; id: string }
  /**
   * Another enabled row is the same ChatGPT account under a different id: the
   * store keeps the new row but disables it, so one account never serves twice.
   */
  | { status: 'added-disabled'; id: string }
  /**
   * A row already held this ChatGPT account (or, with no identity to match,
   * this id); that row's credential was replaced with the new login.
   */
  | { status: 'replaced'; id: string }
  /** Row `main` (the account OpenCode signs in with) already holds this account. */
  | { status: 'main-identity'; id: string }

export type PoolRemoveOutcome = 'removed' | 'not-found' | 'main-refused'

/** Opens the store at `paths`, with a quota poll hook when one is given. */
export function openAccountPool(
  paths: AccountPaths,
  options: Pick<OpenPoolStoreOptions, 'pull' | 'onPullFailure'> = {},
): PoolStore {
  return openPoolStore({
    provider: 'openai',
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: quotaCodec,
    ...options,
  })
}

/**
 * Polls the quota of every candidate OAuth row once, through the store's own
 * pull path (the store records each reading against the row it was taken
 * for), and resolves once every poll has ended. For a process that runs no
 * pool source (the auth menu); it never refreshes a token.
 */
export async function pollPoolRowsOnce(
  paths: AccountPaths,
  poll: (request: PullRequest) => Promise<QuotaObservation | undefined>,
  open: typeof openAccountPool = openAccountPool,
): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const outcomes = new Map<string, { ok: boolean; error?: string }>()
  const store = open(paths, {
    pull: async (request) => {
      try {
        const observation = await poll(request)
        if (!observation) throw new Error('the quota poll returned no reading')
        outcomes.set(request.id, { ok: true })
        return observation
      } catch (error) {
        outcomes.set(request.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
    onPullFailure: (id, error) => {
      outcomes.set(id, { ok: false, error: error.message })
    },
  })
  const rows = (await migratedPoolRows(paths, store)) ?? []
  const targets = rows.filter((row) => row.candidate && row.type === 'oauth')
  for (const row of targets) store.requestReading(row.id)
  await store.pullsSettled()
  return targets.map((row) => ({
    id: row.id,
    ...(outcomes.get(row.id) ?? {
      ok: false,
      error: 'the quota poll did not run',
    }),
  }))
}

/** Whether the config at `configPath` records a completed pool migration. */
export function poolMigrated(configPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return false
    return (
      readPoolMigrationBookkeeping(parsed as Record<string, unknown>)
        .migratedAt !== undefined
    )
  } catch {
    return false
  }
}

/**
 * The pool's rows in roster order when the install is migrated and its pool
 * reads cleanly; undefined otherwise, and the legacy account list applies.
 */
export async function migratedPoolRows(
  paths: AccountPaths,
  store: PoolStore,
): Promise<PoolRow[] | undefined> {
  if (!poolMigrated(paths.configPath)) return undefined
  const load = await store.read()
  return load.status === 'ready' ? load.rows : undefined
}

export async function addPoolAccount(
  store: PoolStore,
  login: PoolLogin,
): Promise<PoolAddOutcome> {
  const load = await store.read()
  const rows = load.status === 'ready' ? load.rows : []
  const credential = {
    type: 'oauth' as const,
    refresh: login.refresh,
    ...(login.access !== undefined ? { access: login.access } : {}),
    ...(login.expires !== undefined ? { expires: login.expires } : {}),
  }
  const identity = login.accountId
  const sameAccount = identity
    ? rows.find((row) => row.type === 'oauth' && row.identity === identity)
    : undefined
  if (sameAccount?.id === POOL_MAIN_ROW_ID) {
    return { status: 'main-identity', id: POOL_MAIN_ROW_ID }
  }
  const existing =
    sameAccount ??
    rows.find(
      (row) =>
        row.id === login.id &&
        row.type === 'oauth' &&
        row.id !== POOL_MAIN_ROW_ID,
    )
  if (existing) {
    const replaced = await store.replace(
      existing.id,
      credential,
      identity !== undefined ? { identity } : {},
    )
    return { status: 'replaced', id: replaced.id }
  }
  const added = await store.add({
    id: login.id,
    credential,
    ...(identity !== undefined ? { identity } : {}),
    ...(login.label !== undefined ? { label: login.label } : {}),
  })
  return {
    status: added.outcome === 'added-disabled' ? 'added-disabled' : 'added',
    id: added.id,
  }
}

/** Disables a row through the store; false when no such row exists. */
export async function disablePoolAccount(
  store: PoolStore,
  id: string,
): Promise<boolean> {
  const load = await store.read()
  if (load.status !== 'ready' || !load.rows.some((row) => row.id === id))
    return false
  await store.disable(id, POOL_USER_DISABLED_REASON)
  return true
}

/** Enables a roster row; false when no such row exists. */
export async function enablePoolAccount(
  paths: AccountPaths,
  id: string,
): Promise<boolean> {
  let found = false
  await mutateAccounts((current) => {
    const account = current.accounts.find((candidate) => candidate.id === id)
    if (!account) return current
    found = true
    account.enabled = true
    return current
  }, paths)
  return found
}

/** Removes a row and its credential; row `main` is refused. */
export async function removePoolAccount(
  paths: AccountPaths,
  id: string,
): Promise<PoolRemoveOutcome> {
  if (id === POOL_MAIN_ROW_ID) return 'main-refused'
  let removed = false
  await mutateAccounts(
    (current) => {
      const index = current.accounts.findIndex((account) => account.id === id)
      if (index === -1) return current
      current.accounts.splice(index, 1)
      removed = true
      return current
    },
    paths,
    { allowDrop: [id] },
  )
  return removed ? 'removed' : 'not-found'
}

/**
 * Removes every row except `main`, and the credentials they hold. Resolves to
 * the removed ids.
 */
export async function removeAllPoolAccountsExceptMain(
  paths: AccountPaths,
): Promise<string[]> {
  const allowDrop: string[] = []
  await mutateAccounts(
    (current, context) => {
      const removed = new Set(
        [
          ...(context?.rawRosterIds ?? []),
          ...current.accounts.map((account) => account.id),
        ].filter((id) => id !== POOL_MAIN_ROW_ID),
      )
      allowDrop.splice(0, allowDrop.length, ...removed)
      current.accounts = current.accounts.filter(
        (account) => account.id === POOL_MAIN_ROW_ID,
      )
      return current
    },
    paths,
    { allowDrop },
  )
  return allowDrop
}

/**
 * The `accountPool` the account commands use (see `CommandContext`), over the
 * store at `paths`. `afterWrite` runs after every change, so a plugin process
 * can re-read the rows its requests are routed across.
 */
export function commandAccountPool(deps: {
  paths: () => AccountPaths
  store: () => PoolStore
  afterWrite?: () => unknown
}): NonNullable<CommandContext['accountPool']> {
  const written = async <T>(result: T): Promise<T> => {
    await deps.afterWrite?.()
    return result
  }
  return {
    mainRemovalRefused: POOL_MAIN_REMOVAL_REFUSED,
    rows: async () => {
      const rows = await migratedPoolRows(deps.paths(), deps.store())
      return rows?.map((row) => ({
        id: row.id,
        type: row.type,
        enabled: row.enabled,
        ...(row.label !== undefined ? { label: row.label } : {}),
      }))
    },
    add: async (account) =>
      written(
        await addPoolAccount(deps.store(), {
          id: account.id,
          refresh: account.refresh,
          ...(account.label !== undefined ? { label: account.label } : {}),
          ...(account.access !== undefined ? { access: account.access } : {}),
          ...(account.expires !== undefined
            ? { expires: account.expires }
            : {}),
          ...(account.accountId !== undefined
            ? { accountId: account.accountId }
            : {}),
        }),
      ),
    disable: async (id) => written(await disablePoolAccount(deps.store(), id)),
    enable: async (id) => written(await enablePoolAccount(deps.paths(), id)),
    remove: async (id) => written(await removePoolAccount(deps.paths(), id)),
    reorder: async (first, second) =>
      written(await swapPoolAccounts(deps.paths(), first, second)),
  }
}

/** Swaps two rows' positions in the roster; false unless both exist. */
export async function swapPoolAccounts(
  paths: AccountPaths,
  first: string,
  second: string,
): Promise<boolean> {
  let swapped = false
  await mutateAccounts((current) => {
    const a = current.accounts.findIndex((account) => account.id === first)
    const b = current.accounts.findIndex((account) => account.id === second)
    if (a === -1 || b === -1) return current
    const held = current.accounts[a]
    const other = current.accounts[b]
    if (!held || !other) return current
    current.accounts[a] = other
    current.accounts[b] = held
    swapped = true
    return current
  }, paths)
  return swapped
}
