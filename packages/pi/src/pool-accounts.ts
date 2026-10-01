// `/openai-account` on Pi once its accounts are rows of the account pool
// (`@cortexkit/common-auth/store`).
//
// - Pi's own `openai-codex` login is listed as row `main`, the main account.
//   It lives in Pi's auth storage, not in the pool, so it cannot be disabled,
//   removed or reordered here; Pi's `/login` replaces it.
// - A new login becomes a row through `store.add`; a login of an account a row
//   already holds replaces that row's credential (`store.replace`), the way the
//   legacy roster merged a re-added account into its existing entry. A login
//   of the account Pi already signs in with is refused: that account serves
//   as `main`, refreshed by Pi alone.
// - Disabling, enabling and removing go through `store.disable`,
//   `store.enable` and `store.remove`.
// - Reordering swaps two roster rows; the roster order is the pool's order.
//   The store has no reorder operation, so this goes through the legacy
//   roster writer (`mutateAccounts`), which takes the same `save` locks the
//   store holds around its own writes.

import {
  PoolOperationError,
  type PoolRow,
  type PoolStore,
} from '@cortexkit/common-auth/store'
import type { CommandContext } from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  mutateAccounts,
} from '@cortexkit/openai-auth-core/internal'

import { FORMER_MAIN_ID } from '@cortexkit/openai-auth-core/pool-routing'

type CommandAccountPool = NonNullable<CommandContext['accountPool']>
type PoolRowOutcome = Awaited<ReturnType<CommandAccountPool['disable']>>

/** The `disabledReason` value the store records on a row the user disabled. */
export const POOL_USER_DISABLED_REASON = 'disabled-by-user'

/** Why row `main` cannot be changed through `/openai-account`. */
export const PI_MAIN_ROW_REFUSED =
  "`main` is the login Pi signs in with (Pi's `/login`). It is kept in Pi's own auth storage, not in this account list, so it cannot be disabled, removed or reordered here; sign in with another account through Pi's `/login` to replace it."

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

export type PoolAddOutcome = Awaited<ReturnType<CommandAccountPool['add']>>

function isFailure(error: unknown, kind: PoolOperationError['kind']): boolean {
  return error instanceof PoolOperationError && error.kind === kind
}

/**
 * Adds a login as a pool row, or replaces the credential of the row that
 * already holds its account. `mainIdentity` is the ChatGPT account of Pi's own
 * login, which is never added again.
 */
export async function addPoolAccount(
  store: PoolStore,
  login: PoolLogin,
  mainIdentity: string | undefined,
): Promise<PoolAddOutcome> {
  const identity = login.accountId
  if (identity && mainIdentity && identity === mainIdentity) {
    return { status: 'main-identity', id: FORMER_MAIN_ID }
  }
  const load = await store.read()
  const rows = load.status === 'ready' ? load.rows : []
  const credential = {
    type: 'oauth' as const,
    refresh: login.refresh,
    ...(login.access !== undefined ? { access: login.access } : {}),
    ...(login.expires !== undefined ? { expires: login.expires } : {}),
  }
  const existing =
    (identity
      ? rows.find((row) => row.type === 'oauth' && row.identity === identity)
      : undefined) ??
    rows.find((row) => row.id === login.id && row.type === 'oauth')
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

/** The message shown when enabling a row would let one ChatGPT account serve from two enabled rows. */
export function poolDuplicateIdentityRefused(
  id: string,
  holder: string | undefined,
): string {
  const other = holder ? `\`${holder}\`` : 'another enabled account'
  return `\`${id}\` is the same ChatGPT account as ${other}, so it stays disabled: one account never serves from two rows. Disable or remove ${other} first.`
}

async function toggle(
  store: PoolStore,
  id: string,
  enable: boolean,
): Promise<PoolRowOutcome> {
  if (id === FORMER_MAIN_ID)
    return { status: 'refused', message: PI_MAIN_ROW_REFUSED }
  try {
    if (enable) await store.enable(id)
    else await store.disable(id, POOL_USER_DISABLED_REASON)
    return { status: 'done' }
  } catch (error) {
    if (isFailure(error, 'unknown-row')) return { status: 'not-found' }
    if (enable && isFailure(error, 'duplicate-identity')) {
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

async function removeRow(
  store: PoolStore,
  id: string,
): Promise<PoolRowOutcome> {
  if (id === FORMER_MAIN_ID)
    return { status: 'refused', message: PI_MAIN_ROW_REFUSED }
  try {
    await store.remove(id)
    return { status: 'done' }
  } catch (error) {
    if (isFailure(error, 'unknown-row')) return { status: 'not-found' }
    throw error
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

/**
 * The `accountPool` the account commands use (see `CommandContext`).
 * `rows` resolves to the pool's rows, behind row `main` while Pi holds a
 * login, or to undefined while the pool is not in use yet (the commands then
 * work on the legacy account list). `afterWrite` runs after every change, so
 * the request path re-reads the rows it routes across.
 */
export function piCommandAccountPool(deps: {
  paths: () => AccountPaths
  store: () => PoolStore
  /** The pool's rows, or undefined while the pool is not in use. */
  poolRows: () => Promise<readonly PoolRow[] | undefined>
  /** Pi's login: whether it exists, and its ChatGPT identity. */
  main: () => { present: boolean; identity: string | undefined }
  afterWrite?: () => unknown
}): CommandAccountPool {
  const written = async <T>(result: T): Promise<T> => {
    await deps.afterWrite?.()
    return result
  }
  return {
    rows: async () => {
      const rows = await deps.poolRows()
      if (!rows) return undefined
      const listed = rows
        .filter((row) => row.id !== FORMER_MAIN_ID)
        .map((row) => ({
          id: row.id,
          type: row.type,
          enabled: row.enabled,
          ...(row.label !== undefined ? { label: row.label } : {}),
        }))
      return deps.main().present
        ? [
            { id: FORMER_MAIN_ID, type: 'oauth' as const, enabled: true },
            ...listed,
          ]
        : listed
    },
    add: async (account) =>
      written(
        await addPoolAccount(
          deps.store(),
          {
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
          },
          deps.main().identity,
        ),
      ),
    disable: async (id) => written(await toggle(deps.store(), id, false)),
    enable: async (id) => written(await toggle(deps.store(), id, true)),
    remove: async (id) => written(await removeRow(deps.store(), id)),
    reorder: async (first, second) =>
      first === FORMER_MAIN_ID || second === FORMER_MAIN_ID
        ? false
        : written(await swapPoolAccounts(deps.paths(), first, second)),
  }
}
