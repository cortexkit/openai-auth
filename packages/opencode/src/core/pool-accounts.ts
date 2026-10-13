// OpenCode's pool access and migration protection hooks for the shared menu.
// The common-auth menu owns row mutations; these callbacks retain the legacy
// locks and refuse removal of main or a pending slot-transfer destination.
import { readFileSync } from 'node:fs'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import {
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolLockSpec,
  type PoolRow,
  type PoolStore,
  type RemoveView,
} from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  POOL_MAIN_ROW_ID,
} from '@cortexkit/openai-auth-core/internal'
import { MAIN_REFRESH_LOCK_NAME } from './host-slot'
import {
  type LegacyLockOptions,
  legacyRefreshLocks,
  readPoolMigrationBookkeeping,
} from './pool-migration'

/** The message shown when the user asks to remove row `main`. */
export const POOL_MAIN_REMOVAL_REFUSED =
  'The `main` account holds the login OpenCode signs in with (its login slot only points at it), so it cannot be removed. Sign in with another account through `opencode auth login` to replace it.'

/**
 * The message shown when the user asks to remove a row the account-pool
 * migration is still moving the login slot's credential into.
 */
export function poolTransferRemovalRefused(id: string): string {
  return `The account-pool migration is moving OpenCode's login into \`${id}\` right now, so it cannot be removed yet. Try again once the migration has finished.`
}

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

/**
 * The legacy lock a write of the roster order holds: `main-refresh` only.
 * The order names no single row and changes no row's credential, so it takes
 * no row's fallback refresh lock.
 */
function legacyRosterOrderLocks(
  paths: AccountPaths,
  options: PoolRowWriteOptions,
): PoolLockSpec[] {
  return legacyRefreshLocks(
    paths,
    POOL_MAIN_ROW_ID,
    options.legacyLocks,
  ).filter((lock) => lock.name === MAIN_REFRESH_LOCK_NAME)
}

/**
 * The legacy lock every settings write and every write of the `/openai`
 * menu holds on a migrated install: `main-refresh`, which the older writers
 * of the same config file take.
 */
export function poolSettingsLocks(
  paths: AccountPaths,
  options: PoolRowWriteOptions = {},
): PoolLockSpec[] {
  return legacyRosterOrderLocks(paths, options)
}
