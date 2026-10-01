// Managing the accounts of a migrated install: what `/openai-account` and the
// auth menu do once every account is a row of the account pool
// (`@cortexkit/common-auth/store`).
//
// - A new login becomes a row through `store.add`; a login of an account a row
//   already holds replaces that row's credential (`store.replace`), the way the
//   legacy roster merged a re-added account into its existing entry.
// - Disabling, enabling and removing go through `store.disable`,
//   `store.enable` and `store.remove`. Each takes the row's pool lock, then
//   the legacy `main-refresh` lock and the row's legacy fallback refresh lock
//   (passed as `extraLocks`, the order `refreshPoolRow` takes them in), then
//   the store locks. An older openai-auth process refreshes a roster row under
//   those legacy locks, so none of the three lands in the middle of such a
//   refresh, nor in the middle of this build's own refresh of the row.
// - Reordering swaps two roster rows; the roster order is the pool's order.
//   The store has no reorder operation, so this goes through the legacy
//   roster writer (`mutateAccounts`), which takes the same `save` locks the
//   store holds around its own writes.
// - Row `main` holds the account OpenCode's login slot points at (the slot
//   keeps only a placeholder), so it is never removed. Neither is a row the
//   migration's pending-transfer record names: the migration is copying the
//   login slot's credential into that row and will write it again.

import { readFileSync } from 'node:fs'
import { type QuotaObservation, quotaCodec } from '@cortexkit/common-auth/quota'
import {
  type OpenPoolStoreOptions,
  PoolOperationError,
  openPoolStore,
  type PoolRow,
  type PoolStore,
  type PullRequest,
  type RemoveView,
} from '@cortexkit/common-auth/store'
import type { CommandContext } from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  mutateAccounts,
  POOL_MAIN_ROW_ID,
} from '@cortexkit/openai-auth-core/internal'
import {
  type LegacyLockOptions,
  legacyRefreshLocks,
  readPoolMigrationBookkeeping,
} from './pool-migration'

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

/**
 * The message shown when the user asks to remove a row the account-pool
 * migration is still moving the login slot's credential into.
 */
export function poolTransferRemovalRefused(id: string): string {
  return `The account-pool migration is moving OpenCode's login into \`${id}\` right now, so it cannot be removed yet. Try again once the migration has finished.`
}

/**
 * The message shown when enabling a row would let one ChatGPT account serve
 * from two enabled rows. `holder` is the enabled row holding it, when known.
 */
export function poolDuplicateIdentityRefused(
  id: string,
  holder: string | undefined,
): string {
  const other = holder ? `\`${holder}\`` : 'another enabled account'
  return `\`${id}\` is the same ChatGPT account as ${other}, so it stays disabled: one account never serves from two rows. Disable or remove ${other} first.`
}

/** What enabling, disabling or removing one row came to. */
export type PoolRowOutcome =
  | { status: 'done' }
  | { status: 'not-found' }
  /** The pool refused the change; `message` tells the user why. */
  | { status: 'refused'; message: string }

/** Lock timing for the legacy locks the row writes take; tests shorten it. */
export type PoolRowWriteOptions = { legacyLocks?: Partial<LegacyLockOptions> }

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

function isFailure(error: unknown, kind: PoolOperationError['kind']): boolean {
  return error instanceof PoolOperationError && error.kind === kind
}

/**
 * Why `remove` must leave row `id` alone, judged on the files the store read
 * under its locks: row `main`, or the row a pending migration transfer names.
 */
export function poolRemovalRefusal(
  id: string,
  view: Pick<RemoveView, 'config'>,
): string | undefined {
  if (id === POOL_MAIN_ROW_ID) return POOL_MAIN_REMOVAL_REFUSED
  const pending = readPoolMigrationBookkeeping(
    view.config as Record<string, unknown>,
  ).pending
  if (pending?.rowId === id) return poolTransferRemovalRefused(id)
  return undefined
}

/** Disables a row through the store. */
export async function disablePoolAccount(
  store: PoolStore,
  paths: AccountPaths,
  id: string,
  options: PoolRowWriteOptions = {},
): Promise<PoolRowOutcome> {
  try {
    await store.disable(id, POOL_USER_DISABLED_REASON, {
      extraLocks: legacyRefreshLocks(paths, id, options.legacyLocks),
    })
    return { status: 'done' }
  } catch (error) {
    if (isFailure(error, 'unknown-row')) return { status: 'not-found' }
    throw error
  }
}

/**
 * Enables a row through the store. A row whose ChatGPT account another
 * enabled row already holds stays disabled, and the outcome says which row.
 */
export async function enablePoolAccount(
  store: PoolStore,
  paths: AccountPaths,
  id: string,
  options: PoolRowWriteOptions = {},
): Promise<PoolRowOutcome> {
  try {
    await store.enable(id, {
      extraLocks: legacyRefreshLocks(paths, id, options.legacyLocks),
    })
    return { status: 'done' }
  } catch (error) {
    if (isFailure(error, 'unknown-row')) return { status: 'not-found' }
    if (isFailure(error, 'duplicate-identity')) {
      const load = await store.read()
      const rows = load.status === 'ready' ? load.rows : []
      const identity = rows.find((row) => row.id === id)?.identity
      const holder = identity
        ? rows.find(
            (row) =>
              row.id !== id &&
              row.enabled &&
              row.type === 'oauth' &&
              row.identity === identity,
          )?.id
        : undefined
      return {
        status: 'refused',
        message: poolDuplicateIdentityRefused(id, holder),
      }
    }
    throw error
  }
}

/**
 * Removes a row and its credential through the store. Row `main` and a row a
 * pending migration transfer names are refused (`poolRemovalRefusal`).
 */
export async function removePoolAccount(
  store: PoolStore,
  paths: AccountPaths,
  id: string,
  options: PoolRowWriteOptions = {},
): Promise<PoolRowOutcome> {
  let refusal: string | undefined
  try {
    await store.remove(id, {
      extraLocks: legacyRefreshLocks(paths, id, options.legacyLocks),
      protect: (target, view) => {
        refusal = poolRemovalRefusal(target, view)
        return refusal
      },
    })
    return { status: 'done' }
  } catch (error) {
    if (isFailure(error, 'row-protected') && refusal !== undefined)
      return { status: 'refused', message: refusal }
    if (isFailure(error, 'unknown-row')) return { status: 'not-found' }
    throw error
  }
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
  rowWrites?: PoolRowWriteOptions
}): NonNullable<CommandContext['accountPool']> {
  const written = async <T>(result: T): Promise<T> => {
    await deps.afterWrite?.()
    return result
  }
  return {
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
    disable: async (id) =>
      written(
        await disablePoolAccount(deps.store(), deps.paths(), id, deps.rowWrites),
      ),
    enable: async (id) =>
      written(
        await enablePoolAccount(deps.store(), deps.paths(), id, deps.rowWrites),
      ),
    remove: async (id) =>
      written(
        await removePoolAccount(deps.store(), deps.paths(), id, deps.rowWrites),
      ),
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
