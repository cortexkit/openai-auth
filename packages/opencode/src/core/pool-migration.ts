// Moves openai-auth's accounts into the shared account pool of
// `@cortexkit/common-auth/store`, and keeps adopting real logins that later
// land in OpenCode's own login slot.
//
// Before the pool, the main account's credential lived in OpenCode's login
// slot (`auth.json`, key `openai`) and fallbacks lived in openai-auth's
// config and state files. In the pool every account is a row of those files
// and the slot holds a placeholder that is never sent. The plugin runs the
// migration and later adoptions in the background (`pool-lifecycle.ts`),
// never on the request path.
//
// Crash-safety rule: the slot keeps the only unmoved copy of its credential
// until the pool holds it and a reload has proved it; only then is the
// placeholder written, and only through a fence (the slot must still hold
// the exact access/refresh pair that was read). A durable pending-transfer
// record, written before a row is touched, lets any later run tell whether
// an interrupted transfer never happened, finished, or was overtaken.
//
// While a transfer is in flight the slot and the row may hold the same
// token, and `mainAccountId` (the shield) names the row's identity so older
// builds leave the row alone. The shield is dropped only after the
// placeholder is in the slot, in the same write that clears the record, so
// the two copies never stand unshielded, crash or not.
//
// Pre-tolerant openai-auth builds (0.11.0 and earlier) honour the shield
// only when picking a fallback for a request: their background refresh
// refreshes every enabled roster row (the migrated `main` row included)
// under a per-account fallback lock, and the slot credential under the
// `main-refresh` lock plus a lease in `state.main`. After a crash with both
// copies in place they would refresh one token twice, and with the
// placeholder in while the shield is still up they cannot serve main at
// all. So the migration runs only while no older process is alive (the
// version fence, `version-fence.ts`, is a required input of
// `migrateToPool`). The tolerant release shipped ahead of this migration
// honours the shield in its background refresh too, and serves main from
// row `main` whenever the slot holds the placeholder. Every step here that
// copies a credential still takes the legacy locks, which covers an older
// process the fence could not see: one started after the check. What the
// fence does not cover is a downgrade, after a migration ran or crashed, to
// a pre-tolerant version (older than the first release that writes the
// process heartbeat `version-fence.ts` reads); that downgrade is
// unsupported.
//
// Lock order. A pool refresh (`refreshPoolRow`) takes the row's pool lock,
// then the provider-wide lock, then the legacy `main-refresh` and fallback
// locks. A transfer's row write takes the same locks in the same order: the
// legacy locks go to the store as `extraLocks`, never held before it. So a
// run holds only its transfer locks (the shared auth.json lock and
// `POOL_MIGRATION_LOCK_NAME`, neither waited for by refresh) while the store
// waits for a row lock, and a refresh waiting
// for `main-refresh` can never be waiting on this run. `main-refresh` is
// taken on its own again, after the row write, around the placeholder write.
//
// The whole plugin's file locks, outermost first. A code path that holds one
// of them and waits for another always waits for one further down this list.
// "Waited" means polled until a timeout (the store's own locks, this file's
// `acquireLock`, `withMainRefreshLock`, the legacy `save` pair); "tried"
// means one attempt that gives up at once when the lock is held.
//  0. `pool-slot-transfer` at auth.json: a migration or adoption run, held
//     from start to end across config roots. No refresh path takes it.
//  1. `pool-migration` at the config path: a migration or adoption run,
//     held from start to end (waited). Only tried anywhere else.
//  2. `bg-quota-refresh` at the config path: one background quota pass
//     (`background-quota-refresh.ts`, tried), around the pool refreshes and
//     polls or the legacy fallback refreshes and polls of that pass. Never
//     held together with lock 1.
//  3. The store's row lock, `row-<identity or id>` at the state path
//     (waited, by the store: row writes, refresh, identity records).
//  4. The store's provider-wide lock, `provider-openai` at the state path
//     (waited, by the store, after the row lock: OAuth row writes, refresh).
//  5. `main-refresh` at the config path. Waited when the store takes it as
//     an extra lock (pool refresh, row writes, the `/openai` menu, settings
//     writes: `legacyRefreshLocks`, `poolSettingsLocks` in
//     `pool-accounts.ts`), here around the placeholder write
//     (`finishTransfer`) and by the login's slot write
//     (`withMainRefreshLock`, from `auth/methods.ts`). Tried by the slot refresh
//     (`refreshMainWithLease` in `index.ts`).
//  6. `fallback-refresh-<id>` at the config path. Waited as the store's
//     extra lock after `main-refresh`; tried by the legacy fallback refresh
//     (`FallbackAccountManager` in the core package).
//  7. The quota-poll locks `opencode-main-quota-refresh` and
//     `opencode-fallback-quota-refresh-<id>` at the config path (the core
//     package's `QuotaManager`, tried; nothing of this plugin is taken while
//     one is held).
//  8. `save` at the config path, then `save` at the state path (waited): the
//     store's own locks, which it takes last in every operation and releases
//     before it calls a refresh's provider; the legacy `mutateAccounts`,
//     `saveAccounts` and `saveAccountState` (the last takes the state one
//     alone); and `updateConfig` below. Nothing is taken while they are held.
// Leaf locks of their own files, never held while another lock is taken and
// never taken while one of the above is held: `sidebar-write` at the sidebar
// file, and the vault's `claustrum-roster` then `claustrum-roster-write` at
// the vault roster file (both in `@cortexkit/common-auth`).
//
// One acquisition runs against this order, and only as a try: the slot
// refresh holds `main-refresh` (5) and tries the run lock (1) in
// `reclaimExpiredPoolTransfer`. A run that holds the run lock and waits for
// `main-refresh` therefore never waits on a slot refresh that waits on it:
// the try fails at once and the record is kept.
//
// Between reading the slot and the row write nothing legacy is held, so the
// slot's token could be refreshed (and spent) in that gap. The pending
// record closes it: the record is written first, then any active legacy
// lease and then the slot are read again. This build's own slot refresh
// (`refreshMainWithLease` in `index.ts`) checks for a record covering its
// token in the same locked write that sets its lease, and stands down if it
// finds one (`poolTransferPendingFor`). Either its lease was set first (the
// re-read sees the lease, or the rotated slot once the lease is gone) or the
// record was (and it never refreshes). An older build does not look for the
// record; the version fence keeps older builds away from the migration, the
// background runner (`pool-lifecycle.ts`) applies the same fence before each
// adoption, and the placeholder fence below restarts a transfer whose slot
// moved on to a new token of the same account.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  acquireRefreshFileLock,
  writeJsonAtomic,
} from '@cortexkit/common-auth/fs'
import { type QuotaObservation, quotaCodec } from '@cortexkit/common-auth/quota'
import {
  fingerprintOf,
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolLockSpec,
  PoolOperationError,
  type PoolRow,
  type PoolStore,
  type ProviderRefresh,
  type RefreshOptions,
  type RefreshOutcome,
} from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  extractAccountIdFromClaims,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  fallbackRefreshLockName,
  hashRefreshToken,
  isOAuthAccount,
  loadAccounts,
  type OAuthQuotaSnapshot,
  parseJwtClaims,
  saveAccountState,
  tokenFingerprint,
} from '@cortexkit/openai-auth-core/internal'
import { createLogger } from '../logger'
import {
  asCompleteMainOauthSlot,
  confirmMainAuthSlot,
  HostSlotChangedError,
  MAIN_REFRESH_LOCK_NAME,
  mainSlotFamilyFingerprint,
  opencodeAuthPath,
} from './host-slot.ts'
import type {
  VersionFenceBlocker,
  VersionFenceResult,
} from './version-fence.ts'

const PROVIDER = 'openai'

/** The refresh value of the slot placeholder. Only an exact match counts. */
export const POOL_PLACEHOLDER_REFRESH = 'common-auth-placeholder:v1:openai'

/**
 * What the host slot holds once its credential lives in the pool. The empty
 * access token means nothing can ever be sent from it. It is deliberately not
 * the tombstone the removed vault custody wrote (`claustrum-tombstone:v1:`),
 * so a slot holding one is never taken for a completed migration.
 */
export const POOL_PLACEHOLDER = Object.freeze({
  type: 'oauth' as const,
  access: '',
  refresh: POOL_PLACEHOLDER_REFRESH,
  expires: 0,
})

/** Exact placeholder match: a near miss is a real credential. */
export function isPoolPlaceholder(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    value.type === POOL_PLACEHOLDER.type &&
    value.access === POOL_PLACEHOLDER.access &&
    value.refresh === POOL_PLACEHOLDER.refresh &&
    value.expires === POOL_PLACEHOLDER.expires
  )
}

/**
 * openai-auth's own top-level config key for migration bookkeeping. Both the
 * pool store and every older openai-auth writer keep unknown top-level config
 * keys, so it survives every writer of the file.
 */
export const POOL_MIGRATION_KEY = 'openaiAuthPool'

/**
 * Lease length of the `main-refresh` file lock, the same value older builds
 * use (`MAIN_REFRESH_LOCK_TTL_MS` in the plugin entry `index.ts`), so a
 * crashed holder on either side blocks the other for the same bounded time.
 */
export const LEGACY_MAIN_REFRESH_LOCK_TTL_MS = 2 * 60_000

/**
 * The file lock (at the config path) one migration or adoption run holds from
 * start to end, so two plugin processes never interleave their transfers. It
 * is always taken after the shared auth.json transfer lock and before row
 * locks; no refresh path ever waits for either transfer lock. Its lease is
 * the `main-refresh` lease (`LegacyLockOptions.mainRefreshTtlMs`): a crashed
 * run blocks the next one for the same bounded time.
 */
export const POOL_MIGRATION_LOCK_NAME = 'pool-migration'

/** The host login slot, shaped like the plugin's `client.auth`. */
export interface HostSlotAdapter {
  /** The shared auth.json path, independent of a plugin's config root. */
  path?: string
  migrationDisabledReason?: () => string | undefined
  get(input: { path: { id: string } }): Promise<unknown>
  set(input: { path: { id: string }; body: unknown }): Promise<unknown>
  all(): Promise<Record<string, unknown>>
}

export interface PoolMigrationLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

/** Named points between this module's own writes; awaited, for crash tests. */
export type PoolMigrationStep =
  | 'after-pool-key-write'
  | 'after-record-write'
  | 'after-row-write'
  | 'after-verify'
  | 'after-carry-over'
  | 'before-placeholder-write'
  | 'after-placeholder-write'
  | 'after-record-clear'
  | 'after-marker-write'

/** Timing of the legacy file locks and of waits on them. */
export interface LegacyLockOptions {
  mainRefreshTtlMs: number
  fallbackTtlMs: number
  /** Lease of the `save` lock pair around this module's own config writes. */
  saveTtlMs: number
  renew: boolean
  renewIntervalMs?: number
  /** How long to wait for a held legacy lock before giving up (real clock). */
  timeoutMs: number
  retryMs: number
}

export const LEGACY_LOCK_DEFAULTS: Readonly<LegacyLockOptions> = Object.freeze({
  mainRefreshTtlMs: LEGACY_MAIN_REFRESH_LOCK_TTL_MS,
  fallbackTtlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
  saveTtlMs: 10_000,
  renew: true,
  timeoutMs: 15_000,
  retryMs: 50,
})

export interface PoolMigrationDeps {
  paths: AccountPaths
  slot: HostSlotAdapter
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Id for a new row whose login carries no usable wire identity. */
  newId?: () => string
  log?: PoolMigrationLogger
  legacyLocks?: Partial<LegacyLockOptions>
  /** Bound and poll interval for waiting out an active legacy main lease. */
  leaseWait?: { timeoutMs: number; pollMs: number }
  /** Pass-through options for the pool store this module opens. */
  store?: Partial<
    Pick<
      OpenPoolStoreOptions,
      | 'lockOptions'
      | 'rowLockOptions'
      | 'providerLock'
      | 'storeLocks'
      | 'onStep'
      | 'onLockEvent'
    >
  >
  onStep?: (step: PoolMigrationStep) => void | Promise<void>
  /**
   * Whether the Claustrum vault serves this host's accounts. Adoption still
   * restores the placeholder; the account source sets aside any pool row
   * whose identity the vault owns, without routing or refreshing it.
   */
  vaultServes?: () => boolean
}

export type SlotNothingKind =
  | 'api'
  | 'placeholder'
  | 'empty'
  | 'tombstone'
  | 'slot-absent'
  | 'declined'

export type PoolTransferOutcome =
  | { status: 'slot-read-only'; reason: string }
  /** Legacy/custom adoption outcome; the built-in adopter now restores the slot even while vault accounts serve. */
  | { status: 'vault-owns-accounts' }
  /**
   * An openai-auth process older than this one is running (see
   * `version-fence.ts`); nothing was written. The migration runs once they
   * are gone.
   */
  | {
      status: 'deferred'
      reason: 'older-version-running'
      blockers: VersionFenceBlocker[]
    }
  /** Migration already recorded as done; nothing was imported. */
  | { status: 'already-migrated' }
  /**
   * The slot holds the placeholder but this store has no `main` row and no
   * transfer of its own in progress: another store sharing this login slot
   * moved the login. Nothing is written.
   */
  | { status: 'refused'; reason: 'placeholder-without-main' }
  /** Adoption asked for before the migration ran. */
  | { status: 'not-migrated' }
  | { status: 'nothing-to-import'; slot: SlotNothingKind }
  | {
      status: 'completed'
      rowId: string
      operation: 'add' | 'rotate' | 'replace' | 'resumed'
      /**
       * `written`: the placeholder was written and read back.
       * `already-present`: a resumed run found the placeholder in place.
       * `slot-moved-on`: the slot changed to another value before the fence;
       * it is left for the next adoption. (A placeholder replaced between its
       * write and the readback ends the run as `retry`,
       * `placeholder-overwritten`, not here.)
       */
      placeholder: 'written' | 'already-present' | 'slot-moved-on'
    }
  /**
   * An interrupted transfer's row holds neither its old credential nor the
   * slot's: someone rotated it after the interruption, so the slot copy may
   * be stale. The slot is left alone and this exact slot value is declined
   * for adoption; the user's next login resolves it.
   */
  | { status: 'ambiguous'; rowId: string }
  | {
      status: 'retry'
      reason:
        | 'host-slot-indeterminate'
        | 'legacy-refresh-in-progress'
        | 'lock-contention'
        | 'verify-failed'
        | 'torn-read'
        | 'slot-changed'
        /**
         * Something replaced the placeholder between its write and the
         * readback. The record and the shield stay, since the slot may hold
         * the very token the row now holds; the next run reads the slot
         * again and finishes the transfer from what it finds.
         */
        | 'placeholder-overwritten'
        | 'unsettled'
        /**
         * An adoption found the vault's first roster read still unfinished
         * after its wait, so whether the vault serves this host was unknown;
         * nothing was adopted.
         */
        | 'vault-roster-pending'
        | `store-${string}`
    }
  | { status: 'error'; reason: string }

type SlotCredential = { access: string; refresh: string; expires?: number }

type SlotView =
  | {
      kind: 'real'
      credential: SlotCredential
      /** Fence fingerprint over the exact (access, refresh) pair. */
      fingerprint: string
      /** The pool's credential fingerprint (refresh token only). */
      credentialFingerprint: string
      identity?: string
    }
  | { kind: 'placeholder'; origin?: string }
  | { kind: Exclude<SlotNothingKind, 'declined' | 'placeholder'> }
  | { kind: 'indeterminate' }

function placeholderWithoutMain(
  slot: SlotView,
  hasMain: boolean,
  book: PoolMigrationBookkeeping,
): boolean {
  return slot.kind === 'placeholder' && !hasMain && !book.pending
}

/** Durable record of one slot-to-row transfer, written before the row. */
export interface PendingTransfer {
  rowId: string
  operation: 'add' | 'rotate' | 'replace'
  /** The row's credential fingerprint before the transfer; null if none. */
  rowFingerprint: string | null
  slotFingerprint: string
  credentialFingerprint: string
  identity?: string
  /** Carry the legacy `state.main` quota and backoff onto the row. */
  carryLegacyMain: boolean
  recordedAt: number
}

export interface PoolMigrationBookkeeping {
  migratedAt?: number
  pending?: PendingTransfer
  /**
   * Fence fingerprint of a host-slot value that must not be imported: the
   * slot copy left behind by an `ambiguous` outcome, which may be a spent
   * token. Any new login changes the slot value and is adopted normally.
   */
  declinedSlotFingerprint?: string
}

type Context = {
  paths: AccountPaths
  slot: HostSlotAdapter
  now: () => number
  sleep: (ms: number) => Promise<void>
  newId: () => string
  log: PoolMigrationLogger
  locks: LegacyLockOptions
  leaseWait: { timeoutMs: number; pollMs: number }
  store: PoolStore
  onStep: (step: PoolMigrationStep) => Promise<void>
  vaultServes?: () => boolean
}

type HeldLock = { release(): Promise<void>; assertOwned(): Promise<void> }

class LegacyLockContention extends Error {
  constructor(name: string) {
    super(`timed out waiting for the legacy ${name} lock`)
    this.name = 'LegacyLockContention'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function context(deps: PoolMigrationDeps): Context {
  const now = deps.now ?? Date.now
  return {
    paths: deps.paths,
    slot: deps.slot,
    now,
    sleep:
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    newId: deps.newId ?? (() => crypto.randomUUID()),
    log: deps.log ?? createLogger('pool-migration'),
    ...(deps.vaultServes ? { vaultServes: deps.vaultServes } : {}),
    locks: { ...LEGACY_LOCK_DEFAULTS, ...deps.legacyLocks },
    leaseWait: deps.leaseWait ?? { timeoutMs: 4_000, pollMs: 50 },
    store: openPoolStore({
      provider: PROVIDER,
      configPath: deps.paths.configPath,
      statePath: deps.paths.statePath,
      quota: quotaCodec,
      now,
      ...deps.store,
    }),
    onStep: async (step) => {
      await deps.onStep?.(step)
    },
  }
}

// ---------------------------------------------------------------------------
// Files and locks
// ---------------------------------------------------------------------------

async function readConfig(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('config root is not an object')
  return value
}

/**
 * The part of a run's context that `acquireLock` and `updateConfig` use:
 * the file paths, the clock, the sleep between lock attempts and the lock
 * timings. Code outside a run builds just this much to write the config.
 */
type LockContext = Pick<Context, 'paths' | 'now' | 'sleep' | 'locks'>

/** Takes one file lock, polling while a live holder has it. */
async function acquireLock(
  ctx: LockContext,
  name: string,
  path: string,
  ttlMs: number,
): Promise<HeldLock> {
  const started = performance.now()
  for (;;) {
    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs,
      now: ctx.now,
      renew: ctx.locks.renew,
      ...(ctx.locks.renewIntervalMs !== undefined
        ? { renewIntervalMs: ctx.locks.renewIntervalMs }
        : {}),
    })
    if (lock) return lock
    if (performance.now() - started >= ctx.locks.timeoutMs)
      throw new LegacyLockContention(name)
    await ctx.sleep(ctx.locks.retryMs)
  }
}

/**
 * Runs `write` holding the legacy `main-refresh` lock at the config path.
 * Every writer of OpenCode's `openai` slot in this plugin holds that lock:
 * the slot refresh (`refreshMainWithLease` in `index.ts`), the placeholder
 * write below (`finishTransfer`) and the auth doctor's restore repair. So
 * none of them can land between another one's last read of the slot and
 * its write. A held lock is waited for up to the legacy lock timeout; then
 * this throws without running `write`. `write` must not take the lock
 * again: it is a plain file lock, not re-entrant.
 */
export async function withMainRefreshLock<T>(
  configPath: string,
  write: () => Promise<T>,
  options: Partial<LegacyLockOptions> = {},
): Promise<T> {
  const locks = { ...LEGACY_LOCK_DEFAULTS, ...options }
  const started = performance.now()
  for (;;) {
    const lock = await acquireRefreshFileLock({
      name: MAIN_REFRESH_LOCK_NAME,
      path: configPath,
      ttlMs: locks.mainRefreshTtlMs,
      renew: locks.renew,
      ...(locks.renewIntervalMs !== undefined
        ? { renewIntervalMs: locks.renewIntervalMs }
        : {}),
    })
    if (lock) {
      try {
        return await write()
      } finally {
        await lock.release().catch(() => {})
      }
    }
    if (performance.now() - started >= locks.timeoutMs)
      throw new LegacyLockContention(MAIN_REFRESH_LOCK_NAME)
    await new Promise((resolve) => setTimeout(resolve, locks.retryMs))
  }
}

/**
 * One read-modify-write of the config under the older writers' `save` lock
 * pair (config, then state) — the pair the pool store and every legacy
 * writer serialise on.
 */
async function updateConfig(
  ctx: LockContext,
  mutate: (config: Record<string, unknown>) => boolean | Promise<boolean>,
): Promise<void> {
  const ttlMs = ctx.locks.saveTtlMs
  const configLock = await acquireLock(ctx, 'save', ctx.paths.configPath, ttlMs)
  try {
    const stateLock = await acquireLock(ctx, 'save', ctx.paths.statePath, ttlMs)
    try {
      const config = await readConfig(ctx.paths.configPath)
      if (!(await mutate(config))) return
      await writeJsonAtomic(ctx.paths.configPath, config, {
        beforeRename: async () => {
          await configLock.assertOwned()
          await stateLock.assertOwned()
        },
      })
    } finally {
      await stateLock.release().catch(() => {})
    }
  } finally {
    await configLock.release().catch(() => {})
  }
}

function parsePending(value: unknown): PendingTransfer | undefined {
  if (!isRecord(value)) return undefined
  const { rowId, operation, rowFingerprint, slotFingerprint } = value
  const { credentialFingerprint, carryLegacyMain, recordedAt, identity } = value
  if (typeof rowId !== 'string' || !rowId) return undefined
  if (operation !== 'add' && operation !== 'rotate' && operation !== 'replace')
    return undefined
  if (rowFingerprint !== null && typeof rowFingerprint !== 'string')
    return undefined
  if (typeof slotFingerprint !== 'string') return undefined
  if (typeof credentialFingerprint !== 'string') return undefined
  return {
    rowId,
    operation,
    rowFingerprint,
    slotFingerprint,
    credentialFingerprint,
    ...(typeof identity === 'string' && identity ? { identity } : {}),
    carryLegacyMain: carryLegacyMain === true,
    recordedAt: typeof recordedAt === 'number' ? recordedAt : 0,
  }
}

/**
 * Whether a slot-to-row transfer is in flight for this refresh token: the
 * config's pending record names it. While one is, the slot's token is being
 * copied into a row, and refreshing it would put a spent token into the pool
 * (see the lock-order note at the top of this file). `config` is the parsed
 * config file, read under the `save` lock pair.
 */
export function poolTransferPendingFor(
  config: unknown,
  refreshToken: string,
): boolean {
  if (!isRecord(config) || !refreshToken) return false
  const pending = readPoolMigrationBookkeeping(config).pending
  return (
    pending?.credentialFingerprint ===
    fingerprintOf({ type: 'oauth', refresh: refreshToken })
  )
}

/**
 * Runs `poolTransferPendingFor` on the config file on disk, read synchronously
 * so it can run inside a `mutateAccounts` callback (which holds the `save` lock
 * pair the record is written under). A file that cannot be read or parsed
 * holds no record this check can honour, so it answers false.
 */
export function poolTransferPendingInConfigFile(
  configPath: string,
  refreshToken: string,
): boolean {
  let config: unknown
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return false
  }
  return poolTransferPendingFor(config, refreshToken)
}

/**
 * Thrown by the plugin's own slot refresh, from inside its locked lease
 * write, when a pending transfer covers the token it was about to refresh.
 */
export class PoolTransferPendingError extends Error {
  constructor() {
    super('the account-pool migration is moving this token; not refreshing it')
    this.name = 'PoolTransferPendingError'
  }
}

/**
 * Age after which a pending-transfer record no longer keeps the slot refresh
 * standing down by itself. A run finishes a transfer in well under a minute
 * (every lock it waits for gives up after `LEGACY_LOCK_DEFAULTS.timeoutMs`),
 * so a record this old belongs to a run that crashed or stopped and was
 * never resumed: a downgrade to a build with the migration switched off, or
 * a fence that keeps deferring. Without a limit, main's slot token would
 * never be refreshed again while the slot still serves it.
 */
export const PENDING_TRANSFER_TTL_MS = 10 * 60_000

/**
 * Called by the slot refresh while it holds `main-refresh`, before it
 * checks for a pending record covering `refreshToken`. Drops that record
 * when it is older than `PENDING_TRANSFER_TTL_MS` and dropping it cannot
 * leave two refreshers of the token, and answers whether it did. With the
 * record gone the refresh goes ahead, and the next migration or adoption run
 * starts over the way it does after a crash: with no record, it plans from
 * the slot as it then stands.
 *
 * The record stays when:
 * - a run is live (it holds the run lock, `POOL_MIGRATION_LOCK_NAME`, which
 *   is only tried here, never waited for): that run owns the transfer;
 * - the install is migrated and the record's row already holds the token:
 *   the pool's own refresh of that row now owns it, and the slot refreshing
 *   it too would spend one token twice. Before the migration is marked done
 *   the pool refreshes no row, and older builds' background refresh skips
 *   the row the shield (`mainAccountId`, which stays up) names, so there the
 *   slot is the only refresher left and the record can go.
 *
 * When the record's row holds neither its credential from before the
 * transfer nor the slot's (it was rotated since, the case `plan` calls
 * ambiguous), the slot's token may already be spent: the transfer may have
 * copied it into the row before the row was rotated. The record still goes,
 * so the slot refresh can try the token, but the slot value is declined for
 * adoption in the same write (`declinedSlotFingerprint`, as an `ambiguous`
 * run leaves it). A refresh that renews the token changes the slot value and
 * the renewed login is adopted as usual; a spent token fails to refresh,
 * stays in the slot as it was, and never replaces the row.
 *
 * `slotAccess` is the access token the slot holds beside `refreshToken`; the
 * declined value is that exact pair. Without it the record's own slot value
 * is declined.
 */
export async function reclaimExpiredPoolTransfer(
  paths: AccountPaths,
  refreshToken: string,
  options: {
    now?: () => number
    legacyLocks?: Partial<LegacyLockOptions>
    log?: PoolMigrationLogger
    slotAccess?: string
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now
  const expired = (config: Record<string, unknown>) => {
    const record = readPoolMigrationBookkeeping(config).pending
    return record &&
      poolTransferPendingFor(config, refreshToken) &&
      now() - record.recordedAt >= PENDING_TRANSFER_TTL_MS
      ? record
      : undefined
  }
  const record = expired(await readConfig(paths.configPath))
  if (!record) return false
  const locks = { ...LEGACY_LOCK_DEFAULTS, ...options.legacyLocks }
  const runLock = await acquireRefreshFileLock({
    name: POOL_MIGRATION_LOCK_NAME,
    path: paths.configPath,
    ttlMs: locks.mainRefreshTtlMs,
    now,
  })
  if (!runLock) return false
  try {
    const config = await readConfig(paths.configPath)
    const migrated =
      readPoolMigrationBookkeeping(config).migratedAt !== undefined
    const load = await openPoolStore({
      provider: PROVIDER,
      configPath: paths.configPath,
      statePath: paths.statePath,
      quota: quotaCodec,
      now,
    }).read()
    // A migrated install whose pool cannot be read keeps the record: which
    // copy of the token the pool refreshes cannot be told.
    if (migrated && load.status !== 'ready') return false
    let declinedSlotFingerprint: string | undefined
    if (load.status === 'ready') {
      const row = load.rows.find((r) => r.id === record.rowId && !r.invalid)
      const rowFingerprint = row?.fingerprint ?? null
      if (migrated && row && rowFingerprint === record.credentialFingerprint)
        return false
      if (
        row &&
        rowFingerprint !== record.credentialFingerprint &&
        rowFingerprint !== record.rowFingerprint
      )
        declinedSlotFingerprint =
          options.slotAccess !== undefined
            ? mainSlotFamilyFingerprint({
                type: 'oauth',
                access: options.slotAccess,
                refresh: refreshToken,
              })
            : record.slotFingerprint
    }
    let dropped = false
    await updateConfig(
      {
        paths,
        now,
        locks,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      (current) => {
        const book = readPoolMigrationBookkeeping(current)
        const still = expired(current)
        if (!still || still.recordedAt !== record.recordedAt) return false
        const { pending: _dropped, ...rest } = book
        writeBookkeeping(
          current,
          declinedSlotFingerprint !== undefined
            ? { ...rest, declinedSlotFingerprint }
            : rest,
        )
        dropped = true
        return true
      },
    )
    if (dropped)
      (options.log ?? createLogger('pool-migration')).warn(
        declinedSlotFingerprint !== undefined
          ? 'dropped an expired account-pool transfer record whose row was rotated since; the slot login is not adopted unless its refresh renews it'
          : 'dropped an expired account-pool transfer record so the slot refresh can resume',
        { rowId: record.rowId, recordedAt: record.recordedAt },
      )
    return dropped
  } finally {
    await runLock.release().catch(() => {})
  }
}

/** Reads this module's bookkeeping key from a parsed config. */
export function readPoolMigrationBookkeeping(
  config: Record<string, unknown>,
): PoolMigrationBookkeeping {
  const raw = config[POOL_MIGRATION_KEY]
  if (!isRecord(raw)) return {}
  const pending = parsePending(raw.pending)
  return {
    ...(typeof raw.migratedAt === 'number'
      ? { migratedAt: raw.migratedAt }
      : {}),
    ...(pending ? { pending } : {}),
    ...(typeof raw.declinedSlotFingerprint === 'string'
      ? { declinedSlotFingerprint: raw.declinedSlotFingerprint }
      : {}),
  }
}

function writeBookkeeping(
  config: Record<string, unknown>,
  next: PoolMigrationBookkeeping,
): void {
  const prior = isRecord(config[POOL_MIGRATION_KEY])
    ? config[POOL_MIGRATION_KEY]
    : {}
  const out: Record<string, unknown> = { ...prior }
  for (const key of ['migratedAt', 'pending', 'declinedSlotFingerprint'])
    delete out[key]
  Object.assign(out, next)
  config[POOL_MIGRATION_KEY] = out
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

function identityOf(access: string): string | undefined {
  const claims = access ? parseJwtClaims(access) : undefined
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

function realView(credential: SlotCredential): SlotView {
  const fingerprint = mainSlotFamilyFingerprint({
    type: 'oauth',
    ...credential,
  })
  const identity = identityOf(credential.access)
  return {
    kind: 'real',
    credential,
    fingerprint: fingerprint as string,
    credentialFingerprint: fingerprintOf({
      type: 'oauth',
      refresh: credential.refresh,
    }),
    ...(identity ? { identity } : {}),
  }
}

/** Classifies a single slot value that is known to exist. */
function viewOf(value: unknown): SlotView {
  if (isPoolPlaceholder(value))
    return {
      kind: 'placeholder',
      ...(isRecord(value) && typeof value.accountId === 'string'
        ? { origin: value.accountId }
        : {}),
    }
  const complete = asCompleteMainOauthSlot(value)
  if (!complete?.refresh.trim()) return { kind: 'empty' }
  return realView(complete)
}

/**
 * Reads the slot with the host-slot rules openai-auth already uses: a single
 * missing read is not trusted (the host may be mid-write), so absence needs
 * two reads apart with a non-empty auth map both times.
 */
async function readSlot(ctx: Context): Promise<SlotView> {
  const verdict = await confirmMainAuthSlot({
    client: {
      auth: {
        get: (input) => ctx.slot.get(input),
        all: () => ctx.slot.all(),
      },
    },
    now: ctx.now,
    sleep: ctx.sleep,
  })
  if (verdict.kind === 'real') return viewOf(verdict.oauth)
  return verdict.kind === 'slot-absent' || verdict.kind === 'indeterminate'
    ? { kind: verdict.kind }
    : { kind: verdict.kind }
}

/**
 * Whether a freshly read host slot is a placeholder without this store's
 * main row or pending transfer. The request paths use the migration's exact
 * predicate, not an empty legacy roster: that roster can be empty while a
 * real login waits in the slot for the version fence to open.
 *
 * Read the store after the slot. Our own placeholder is written only after
 * the row and pending record are durable, so an older store snapshot must
 * not be combined with that newer slot value to declare the login missing.
 * This only reads files; it neither takes a store lock nor starts a migration.
 */
export async function poolPlaceholderWithoutMain(
  paths: AccountPaths,
  slot: unknown,
): Promise<boolean> {
  if (!isPoolPlaceholder(slot)) return false
  const config = await readConfig(paths.configPath)
  const load = await openPoolStore({
    provider: PROVIDER,
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: quotaCodec,
  }).read()
  if (load.status === 'error') return false
  const hasMain =
    load.status === 'ready'
      ? load.rows.some((row) => row.id === 'main')
      : load.roster.some((row) => isRecord(row) && row.id === 'main')
  return placeholderWithoutMain(
    { kind: 'placeholder' },
    hasMain,
    readPoolMigrationBookkeeping(config),
  )
}

/**
 * The slot view, after waiting out an active legacy main-refresh lease on
 * the slot's own refresh token, exactly as the plugin's `refreshMainWithLease`
 * does before it refreshes: a lease is active while `refreshLeaseUntil` lies
 * in the future and its token hash matches. Copying a token an older build
 * is rotating right now would put a consumed token into the pool.
 */
async function readSlotHonouringLease(
  ctx: Context,
): Promise<SlotView | { kind: 'retry' }> {
  const deadline = ctx.now() + ctx.leaseWait.timeoutMs
  for (;;) {
    const view = await readSlot(ctx)
    if (view.kind !== 'real') return view
    if (!(await legacyLeaseActive(ctx, view.credential.refresh))) return view
    if (ctx.now() >= deadline) return { kind: 'retry' }
    await ctx.sleep(ctx.leaseWait.pollMs)
  }
}

async function legacyLeaseActive(
  ctx: Context,
  refreshToken: string,
): Promise<boolean> {
  const legacy = await loadAccounts(ctx.paths)
  const until = legacy?.refresh?.mainRefreshLeaseUntil
  return Boolean(
    until &&
      until > ctx.now() &&
      legacy?.refresh?.mainRefreshLeaseTokenHash ===
        hashRefreshToken(refreshToken),
  )
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type Plan =
  | { kind: 'nothing'; slot: SlotNothingKind }
  | { kind: 'drop-record' }
  | { kind: 'ambiguous'; record: PendingTransfer }
  | { kind: 'finish'; record: PendingTransfer }
  | {
      kind: 'transfer'
      record: PendingTransfer
      credential: SlotCredential
      fresh: boolean
    }

function usableAsId(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    !['__proto__', 'constructor', 'prototype', 'main'].includes(value)
  )
}

/**
 * Picks the row a slot credential goes to. The same refresh token wins first
 * (it already lives in that row: a rotate, never a second copy). Then a
 * missing or empty `main` is filled, the row pins, quota, killswitch, reset
 * credits, cachekeep and lock names all key on. Otherwise the wire identity picks an enabled
 * row (a re-login: replace), and failing that the login becomes a new row
 * named like the plugin's own logins name theirs (its identity, else a uuid).
 */
function resolveTarget(
  mode: 'migrate' | 'adopt',
  rows: readonly PoolRow[],
  slot: Extract<SlotView, { kind: 'real' }>,
  idHint: string | undefined,
  newId: () => string,
): Omit<
  PendingTransfer,
  'slotFingerprint' | 'credentialFingerprint' | 'recordedAt'
> {
  const identity = slot.identity ? { identity: slot.identity } : {}
  const same = rows.find(
    (row) => !row.invalid && row.fingerprint === slot.credentialFingerprint,
  )
  if (same)
    return {
      rowId: same.id,
      operation: 'rotate',
      rowFingerprint: same.fingerprint ?? null,
      ...identity,
      carryLegacyMain: mode === 'migrate' && same.id === 'main',
    }
  // Row `main` is filled whenever it is missing or holds no credential, by
  // an adoption too: a migration that found no login in the slot leaves the
  // pool without one, and the first login that lands in the slot afterwards
  // is the account OpenCode signs in with. Only the migration carries the
  // legacy `state.main` over; an adoption's login may be another account.
  const main = rows.find((row) => row.id === 'main')
  if (!main || (!main.invalid && !main.credential))
    return {
      rowId: 'main',
      operation: 'add',
      rowFingerprint: null,
      ...identity,
      carryLegacyMain: mode === 'migrate',
    }
  if (slot.identity) {
    const holder = rows.find(
      (row) =>
        !row.invalid &&
        row.type === 'oauth' &&
        row.enabled &&
        row.identity === slot.identity,
    )
    if (holder)
      return {
        rowId: holder.id,
        operation: 'replace',
        rowFingerprint: holder.fingerprint ?? null,
        ...identity,
        carryLegacyMain: mode === 'migrate' && holder.id === 'main',
      }
  }
  const taken = new Set(rows.map((row) => row.id))
  const rowId =
    idHint ??
    (slot.identity && usableAsId(slot.identity) && !taken.has(slot.identity)
      ? slot.identity
      : newId())
  return {
    rowId,
    operation: 'add',
    rowFingerprint: null,
    ...identity,
    carryLegacyMain: false,
  }
}

/**
 * Decides what one run does. With a pending record, the recorded row's
 * credential says how far the interrupted transfer got: still its old
 * credential (or still absent, for a new row) means it never happened;
 * the slot's credential means it happened; anything else means the row was
 * rotated after the interruption, and whether the slot copy is stale can no
 * longer be told.
 */
function plan(
  mode: 'migrate' | 'adopt',
  book: PoolMigrationBookkeeping,
  rows: readonly PoolRow[],
  slot: SlotView,
  idHint: string | undefined,
  now: number,
  newId: () => string,
): Plan {
  const record = book.pending
  if (record) {
    const row = rows.find((r) => r.id === record.rowId && !r.invalid)
    const rowFingerprint = row?.fingerprint ?? null
    const slotIsRecorded =
      slot.kind === 'real' && slot.fingerprint === record.slotFingerprint
    if (row && rowFingerprint === record.credentialFingerprint)
      return { kind: 'finish', record }
    if (
      (row || record.rowFingerprint === null) &&
      rowFingerprint === record.rowFingerprint
    )
      return slotIsRecorded && slot.kind === 'real'
        ? {
            kind: 'transfer',
            record,
            credential: slot.credential,
            fresh: false,
          }
        : { kind: 'drop-record' }
    if (!row) return { kind: 'drop-record' }
    return slotIsRecorded
      ? { kind: 'ambiguous', record }
      : { kind: 'drop-record' }
  }
  if (slot.kind === 'indeterminate') return { kind: 'drop-record' }
  if (slot.kind !== 'real') return { kind: 'nothing', slot: slot.kind }
  if (book.declinedSlotFingerprint === slot.fingerprint)
    return { kind: 'nothing', slot: 'declined' }
  return {
    kind: 'transfer',
    record: {
      ...resolveTarget(mode, rows, slot, idHint, newId),
      slotFingerprint: slot.fingerprint,
      credentialFingerprint: slot.credentialFingerprint,
      recordedAt: now,
    },
    credential: slot.credential,
    fresh: true,
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function applyToRow(
  ctx: Context,
  record: PendingTransfer,
  credential: SlotCredential,
): Promise<void> {
  const oauth = {
    type: 'oauth' as const,
    access: credential.access,
    refresh: credential.refresh,
    ...(credential.expires !== undefined
      ? { expires: credential.expires }
      : {}),
  }
  const identity = record.identity ? { identity: record.identity } : {}
  // The legacy locks an older build refreshes this row (and the slot's
  // token) under. The store takes them after the row's pool lock and the
  // provider-wide lock, the order `refreshPoolRow` takes them in, so a row
  // write and a pool refresh of the same row can never wait on each other.
  const locks = {
    extraLocks: legacyRefreshLocks(ctx.paths, record.rowId, ctx.locks),
  }
  if (record.operation === 'add') {
    await ctx.store.add(
      { id: record.rowId, credential: oauth, ...identity },
      locks,
    )
  } else if (record.operation === 'replace') {
    await ctx.store.replace(record.rowId, oauth, identity, locks)
  } else {
    const load = await ctx.store.read()
    const row =
      load.status === 'ready'
        ? load.rows.find((r) => r.id === record.rowId)
        : undefined
    // A rotate records an identity only where the row has none yet.
    await ctx.store.rotate(
      record.rowId,
      oauth,
      row?.identity === undefined ? identity : {},
      locks,
    )
  }
}

async function verifyRow(
  ctx: Context,
  record: PendingTransfer,
): Promise<PoolRow | undefined> {
  const load = await ctx.store.read()
  if (load.status !== 'ready') return undefined
  const row = load.rows.find((r) => r.id === record.rowId && !r.invalid)
  return row?.fingerprint === record.credentialFingerprint ? row : undefined
}

/** A legacy quota window snapshot as one pool quota observation each. */
export function observationsFromLegacySnapshot(
  snapshot: OAuthQuotaSnapshot,
  budgetCheckedAt: number | undefined,
): QuotaObservation[] {
  const out: QuotaObservation[] = []
  const windows: Array<[string, OAuthQuotaSnapshot['primary']]> = [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary],
  ]
  let latest = 0
  for (const [label, window] of windows) {
    if (
      !window ||
      !Number.isFinite(window.checkedAt) ||
      !Number.isFinite(window.usedPercent)
    )
      continue
    latest = Math.max(latest, window.checkedAt)
    out.push({
      checkedAt: window.checkedAt,
      readings: [
        {
          label,
          usedPercent: window.usedPercent,
          ...(typeof window.resetsAt === 'string'
            ? { resetsAt: window.resetsAt }
            : {}),
          ...(Number.isFinite(window.windowMinutes)
            ? { windowMinutes: window.windowMinutes as number }
            : {}),
        },
      ],
    })
  }
  const at = budgetCheckedAt ?? (latest || undefined)
  const spend = snapshot.spendControl
  if (at !== undefined && spend) {
    out.push({
      checkedAt: at,
      budget: {
        kind: 'reading',
        reached: spend.reached,
        remainingPercent: spend.remainingPercent,
        usedPercent: spend.usedPercent,
        limit: spend.limit,
        used: spend.used,
        remaining: spend.remaining,
        ...(spend.resetsAt !== undefined ? { resetsAt: spend.resetsAt } : {}),
        ...(spend.unit !== undefined ? { unit: spend.unit } : {}),
      },
    })
  } else if (at !== undefined && snapshot.spendControlCleared) {
    out.push({ checkedAt: at, budget: { kind: 'cleared' } })
  }
  return out.sort((a, b) => a.checkedAt - b.checkedAt)
}

/**
 * Moves what the legacy store kept about the slot account (`state.main`'s
 * quota snapshot and refresh backoff) onto the row that now holds it. The
 * pool map gets the quota attributed to the row's current credential and
 * wire identity; the legacy per-row state gets both too, through the legacy
 * writer, so an older build serving the row as a fallback keeps honouring
 * the backoff. Advisory data: a failure is logged and never blocks the move.
 */
async function carryLegacyMainState(ctx: Context, row: PoolRow): Promise<void> {
  const legacy = await loadAccounts(ctx.paths)
  if (!legacy) return
  // The legacy quota manager records, beside main's quota, a fingerprint of
  // the access token it was read with (`mainQuotaToken`), and refuses to
  // reuse the reading for a different token: it may belong to an account
  // that was signed in before. The same rule applies here, against the
  // token the row now holds, so another login's quota is never attributed
  // to this row. A reading with no fingerprint is carried, as the legacy
  // manager would use it.
  const recordedToken = legacy.quota?.mainQuotaToken
  const rowAccess =
    row.credential?.type === 'oauth' ? row.credential.access : undefined
  const quotaIsRows =
    !recordedToken ||
    (rowAccess !== undefined && recordedToken === tokenFingerprint(rowAccess))
  const snapshot = quotaIsRows ? legacy.quota?.mainQuota : undefined
  if (snapshot && row.credentialEpoch !== undefined) {
    const attribution = {
      credentialEpoch: row.credentialEpoch,
      ...(row.identity !== undefined ? { identity: row.identity } : {}),
    }
    for (const observation of observationsFromLegacySnapshot(
      snapshot,
      legacy.quota?.mainQuotaCheckedAt,
    )) {
      try {
        await ctx.store.recordQuota(row.id, attribution, observation)
      } catch (error) {
        ctx.log.warn('legacy main quota not carried to the pool row', {
          rowId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  const mainError = legacy.refresh?.mainLastRefreshError
  const account = legacy.accounts.find((a) => a.id === row.id)
  if (!account || !isOAuthAccount(account) || account.corrupt) return
  if (!mainError && !snapshot) return
  const next: AccountStorage = {
    ...legacy,
    accounts: [
      {
        ...account,
        ...(account.lastRefreshError || !mainError
          ? {}
          : { lastRefreshError: mainError }),
        ...(account.quota || !snapshot ? {} : { quota: snapshot }),
      },
    ],
  }
  try {
    await saveAccountState(next, ctx.paths, { accounts: [row.id] })
  } catch (error) {
    ctx.log.warn('legacy main backoff not carried to the pool row', {
      rowId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Bookkeeping written once a transfer (or a migration with nothing to
 * import) is over, in one write: the record goes, `mainAccountId` goes with
 * it, and a migration is marked done. Older builds skip every roster row
 * whose wire identity equals `mainAccountId`, which is what hides the
 * migrated `main` row from them while the slot may still hold the same
 * token; this runs only once the slot no longer does (the placeholder is in,
 * or the slot moved on). From then on the row is the only live copy, so
 * older builds must see it: otherwise a pre-tolerant build could not use the
 * account as a fallback, and a tolerant one would not refresh the row in the
 * background.
 *
 * The write that first marks a migration done also pins the routing mode
 * when none is set (`pinLegacyRoutingDefault`), so the marker and the mode
 * land together and no crash can leave a migrated install without it.
 */
async function writeFinished(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  extra: Pick<PoolMigrationBookkeeping, 'declinedSlotFingerprint'> = {},
): Promise<void> {
  await updateConfig(ctx, (config) => {
    const book = readPoolMigrationBookkeeping(config)
    delete config.mainAccountId
    if (mode === 'migrate' && book.migratedAt === undefined)
      pinLegacyRoutingDefault(config)
    writeBookkeeping(config, {
      ...(book.migratedAt !== undefined || mode === 'migrate'
        ? { migratedAt: book.migratedAt ?? ctx.now() }
        : {}),
      ...(extra.declinedSlotFingerprint !== undefined
        ? { declinedSlotFingerprint: extra.declinedSlotFingerprint }
        : book.declinedSlotFingerprint !== undefined
          ? { declinedSlotFingerprint: book.declinedSlotFingerprint }
          : {}),
    })
    return true
  })
}

/**
 * Before the migration, an unset `routing.mode` meant main-first. The pool's
 * own routing reads an unset mode as roster order, and the migration appends
 * `main` at the end of the roster, so leaving it unset would quietly turn
 * main into the last account tried. The legacy meaning is written out
 * instead. A mode that is set, to anything, is left alone.
 */
function pinLegacyRoutingDefault(config: Record<string, unknown>): void {
  const routing = config.routing
  if (routing === undefined) {
    config.routing = { mode: 'main-first' }
  } else if (isRecord(routing) && routing.mode === undefined) {
    config.routing = { ...routing, mode: 'main-first' }
  }
}

async function clearRecord(ctx: Context): Promise<void> {
  await updateConfig(ctx, (config) => {
    const book = readPoolMigrationBookkeeping(config)
    if (!book.pending) return false
    const { pending: _dropped, ...rest } = book
    writeBookkeeping(config, rest)
    return true
  })
}

/**
 * Writes the record and, while the slot and the row may share one token,
 * shields the row from older builds by naming its identity in
 * `mainAccountId`. Tolerant builds honour the shield in request routing and
 * in background refresh; pre-tolerant builds only in request routing, which
 * is why the migration itself waits for the version fence.
 */
async function writeRecord(
  ctx: Context,
  record: PendingTransfer,
): Promise<void> {
  await updateConfig(ctx, (config) => {
    const book = readPoolMigrationBookkeeping(config)
    if (record.identity) config.mainAccountId = record.identity
    writeBookkeeping(config, { ...book, pending: record })
    return true
  })
}

/**
 * Puts the placeholder into the slot through the fence: the slot must still
 * hold exactly the (access, refresh) pair the record names. Both adapters
 * re-read immediately before dispatch/rename and refuse a visible change.
 * OpenCode 1's server still reads and writes the whole file without a lock
 * shared with us: a host login landing after the adapter's last read but
 * before the server's write can be lost, undetectably if overwritten. On
 * OpenCode 2 the corresponding residual window is the adapter's last file
 * read through its atomic rename. Readback detects only writes that survive
 * our write, not ones erased by it; no API returns the erased prior value.
 * The plugin's same-config writers hold `main-refresh` and cannot race it.
 *
 * It runs under the legacy `main-refresh` lock, taken here on its own after
 * the row write (never before the store's row lock: see the lock-order note
 * at the top of this file). Every slot refresh takes that lock and re-reads
 * the slot under it, so while it is held nobody can start refreshing the
 * token this fence reads, and once the placeholder is in a refresh that
 * starts later finds nothing to refresh.
 */
async function finishTransfer(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  record: PendingTransfer,
  operation: 'add' | 'rotate' | 'replace' | 'resumed',
): Promise<FinishStep> {
  const mainLock = await acquireLock(
    ctx,
    MAIN_REFRESH_LOCK_NAME,
    ctx.paths.configPath,
    ctx.locks.mainRefreshTtlMs,
  )
  try {
    return await finishUnderMainLock(ctx, mode, record, operation)
  } finally {
    await mainLock.release().catch(() => {})
  }
}

/** A run's next move: an outcome, or plan again from the top. */
type RunStep = PoolTransferOutcome | { status: 'restart' }
type FinishStep = RunStep | { status: 'foreign-placeholder' }

async function finishUnderMainLock(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  record: PendingTransfer,
  operation: 'add' | 'rotate' | 'replace' | 'resumed',
): Promise<FinishStep> {
  const completed = (
    placeholder: Extract<
      PoolTransferOutcome,
      { status: 'completed' }
    >['placeholder'],
  ): PoolTransferOutcome => ({
    status: 'completed',
    rowId: record.rowId,
    operation,
    placeholder,
  })
  // This fence read decides whether the transfer may end without the
  // placeholder ("the slot moved on"), which drops the record and the shield
  // and leaves whatever the slot holds live. So it follows `readSlot`'s
  // rule, never a single raw read: a transient absence while the host
  // rewrites its file must not pass for a slot that moved on while it still
  // holds the token the row now holds too. An unsettled read, or an auth map
  // that reads empty (a torn read of the host file), ends the run retryably
  // with the record kept; the next run resumes here.
  const current = await readSlot(ctx)
  if (current.kind === 'indeterminate')
    return { status: 'retry', reason: 'host-slot-indeterminate' }
  if (current.kind === 'placeholder') {
    if (current.origin !== placeholderOrigin(ctx))
      return { status: 'foreign-placeholder' }
    await writeFinished(ctx, mode)
    await ctx.onStep('after-record-clear')
    return completed('already-present')
  }
  if (Object.keys(await ctx.slot.all()).length === 0)
    return { status: 'retry', reason: 'torn-read' }
  if (
    current.kind === 'real' &&
    current.fingerprint !== record.slotFingerprint &&
    record.identity !== undefined &&
    current.identity === record.identity
  ) {
    // A new token of the same account. It may be the result of a refresh
    // of the very token just copied into the row, by a process that does
    // not look for the pending record (an older build), in which case the
    // row now holds a spent token. So the shield stays up, the record goes,
    // and the run plans again from the top: the new token replaces the
    // copy before the placeholder goes in.
    await clearRecord(ctx)
    await ctx.onStep('after-record-clear')
    return { status: 'restart' }
  }
  if (
    current.kind !== 'real' ||
    current.fingerprint !== record.slotFingerprint
  ) {
    await writeFinished(ctx, mode)
    await ctx.onStep('after-record-clear')
    return completed('slot-moved-on')
  }
  // The shield (`mainAccountId`) stays up across the placeholder write and
  // goes only in `writeFinished` below, so there is no moment when the slot
  // and the row share the token without it. Once the placeholder is in, a
  // tolerant build serves main from row `main` itself (lifting the shield
  // for that one path); its background refresh keeps skipping the row until
  // the shield goes. A crash in between leaves exactly that, and the next
  // run finds the placeholder and drops the shield.
  await ctx.onStep('before-placeholder-write')
  // The fence read above can take a while (a confirmed read may sleep
  // between two reads), so the slot is read once more immediately before
  // the write. Every slot writer of this plugin holds `main-refresh`, which
  // this run holds, so only the host's own login can land here. Any change
  // ends the run retryably with the record kept: the next run's fence read
  // sees the new value and leaves it in the slot.
  const last = await ctx.slot.get({ path: { id: PROVIDER } })
  const lastView =
    last === undefined || last === null ? undefined : viewOf(last)
  if (
    lastView?.kind !== 'real' ||
    lastView.fingerprint !== record.slotFingerprint
  )
    return { status: 'retry', reason: 'slot-changed' }
  try {
    await ctx.slot.set({
      path: { id: PROVIDER },
      body: {
        ...POOL_PLACEHOLDER,
        accountId: placeholderOrigin(ctx),
      },
    })
  } catch (error) {
    if (error instanceof HostSlotChangedError)
      return { status: 'retry', reason: 'slot-changed' }
    throw error
  }
  await ctx.onStep('after-placeholder-write')
  const readback = await ctx.slot.get({ path: { id: PROVIDER } })
  // Whatever replaced the placeholder may be the token just copied into the
  // row (the host writing back its own earlier read of the file), and then
  // the slot and the row hold one token again. Dropping the record and the
  // shield here would leave two refreshers of it, so both stay and the run
  // ends retryably. The next run's fence read above tells the cases apart:
  // the same token gets the placeholder again, a new token of the same
  // account restarts the transfer, and anything else has moved on.
  if (!isPoolPlaceholder(readback))
    return { status: 'retry', reason: 'placeholder-overwritten' }
  if (isRecord(readback) && readback.accountId !== placeholderOrigin(ctx))
    return { status: 'foreign-placeholder' }
  await writeFinished(ctx, mode)
  await ctx.onStep('after-record-clear')
  return completed('written')
}

async function executeTransfer(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  step: Extract<Plan, { kind: 'transfer' }>,
): Promise<RunStep> {
  const { record } = step
  if (step.fresh) {
    await writeRecord(ctx, record)
    await ctx.onStep('after-record-write')
  }
  // With the record on disk, this build's own slot refresh stands down for
  // this token. One that set its lease before the record landed shows up
  // here: its lease is still active, or it is gone and the slot holds the
  // rotated token (a refresh writes the slot before it clears its lease).
  // The lease is read before the slot for exactly that reason. Either way
  // the copy would be stale, so the run plans again.
  if (await legacyLeaseActive(ctx, step.credential.refresh))
    return { status: 'restart' }
  const confirmed = await readSlot(ctx)
  if (
    confirmed.kind !== 'real' ||
    confirmed.fingerprint !== record.slotFingerprint
  )
    return { status: 'restart' }
  await applyToRow(ctx, record, step.credential)
  await ctx.onStep('after-row-write')
  return completeTransfer(
    ctx,
    mode,
    record,
    step.fresh ? record.operation : 'resumed',
  )
}

/**
 * Everything after the row write: prove the row holds the slot credential,
 * carry the legacy main state over, then the placeholder. A run resuming a
 * transfer whose row write already landed starts here too, so the carry-over
 * is never skipped by a crash (it is idempotent: the same readings merge to
 * the same map and the legacy per-row copy is written with the same token).
 */
async function completeTransfer(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  record: PendingTransfer,
  operation: 'add' | 'rotate' | 'replace' | 'resumed',
): Promise<RunStep> {
  const row = await verifyRow(ctx, record)
  if (!row) return { status: 'retry', reason: 'verify-failed' }
  await ctx.onStep('after-verify')
  if (record.carryLegacyMain) {
    await carryLegacyMainState(ctx, row)
    await ctx.onStep('after-carry-over')
  }
  const result = await finishTransfer(ctx, mode, record, operation)
  if (result.status !== 'foreign-placeholder') return result
  // Another store won custody. Remove only this transfer's exact copy, after
  // releasing main-refresh, so removal takes row -> legacy locks as usual.
  await ctx.store.remove(record.rowId, {
    extraLocks: legacyRefreshLocks(ctx.paths, record.rowId, ctx.locks),
    protect: (_id, view) =>
      view.row?.fingerprint !== record.credentialFingerprint
        ? 'the transfer row changed before rollback'
        : undefined,
  })
  await clearRecord(ctx)
  await repairShield(ctx)
  return { status: 'refused', reason: 'placeholder-without-main' }
}

const deferredLogged = new Set<string>()
const readOnlyLogged = new Set<string>()

function placeholderOrigin(ctx: Context): string {
  // accountId is an allowed OpenCode OAuth field and survives its schema
  // decoder; an unknown extension field would be stripped by the host.
  return `openai-auth-pool:${createHash('sha256').update(resolve(ctx.paths.configPath)).digest('hex')}`
}

/**
 * The processes that block the migration. A fence check that throws counts
 * as blocked: the migration then writes nothing, as for an older process.
 */
async function fenceBlockers(
  fence: () => Promise<VersionFenceResult>,
): Promise<VersionFenceBlocker[]> {
  try {
    const result = await fence()
    return result.open ? [] : result.blockers
  } catch (error) {
    return [
      {
        pid: 'unknown',
        version: 'unknown',
        detail: error instanceof Error ? error.message : String(error),
      },
    ]
  }
}

async function run(
  deps: PoolMigrationDeps,
  mode: 'migrate' | 'adopt',
  fence?: () => Promise<VersionFenceResult>,
): Promise<PoolTransferOutcome> {
  const ctx = context(deps)
  const disabled = ctx.slot.migrationDisabledReason?.()
  if (disabled) {
    const key = ctx.slot.path ?? opencodeAuthPath()
    if (!readOnlyLogged.has(key)) {
      readOnlyLogged.add(key)
      ctx.log.info(
        'account pool migration is off: the host login slot is read-only',
        { reason: disabled },
      )
    }
    return { status: 'slot-read-only', reason: disabled }
  }
  let config: Record<string, unknown>
  try {
    config = await readConfig(ctx.paths.configPath)
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const early = await gate(ctx, mode, config)
  if (early) {
    if (early.status === 'already-migrated' && 'mainAccountId' in config)
      await repairShield(ctx)
    return early
  }
  if (fence) {
    // Checked before any lock or write. An older process starting after
    // this check and before the run ends is not seen; the next run is.
    const blockers = await fenceBlockers(fence)
    if (blockers.length > 0) {
      // Logged once per set of blockers (pid and version), so a waiting
      // migration names what it waits for without repeating it every retry.
      const key = `${ctx.paths.configPath}\0${blockers.map((b) => `${b.pid}@${b.version}`).join(',')}`
      if (!deferredLogged.has(key)) {
        deferredLogged.add(key)
        ctx.log.info(
          'account pool migration deferred: an older openai-auth version is running',
          { blockers },
        )
      }
      return {
        status: 'deferred',
        reason: 'older-version-running',
        blockers,
      }
    }
  }

  let runLock: HeldLock | undefined
  let slotLock: HeldLock | undefined
  try {
    // Shared slot first, config run lock second, then row/provider/legacy/save.
    // No refresh takes this outer lock, so it cannot invert the row order.
    slotLock = await acquireLock(
      ctx,
      'pool-slot-transfer',
      ctx.slot.path ?? opencodeAuthPath(),
      ctx.locks.mainRefreshTtlMs,
    )
    runLock = await acquireLock(
      ctx,
      POOL_MIGRATION_LOCK_NAME,
      ctx.paths.configPath,
      ctx.locks.mainRefreshTtlMs,
    )
  } catch (error) {
    await slotLock?.release().catch(() => {})
    if (error instanceof LegacyLockContention)
      return { status: 'retry', reason: 'lock-contention' }
    throw error
  }
  try {
    return await runLocked(ctx, mode)
  } catch (error) {
    if (error instanceof LegacyLockContention)
      return { status: 'retry', reason: 'lock-contention' }
    if (error instanceof PoolOperationError)
      return {
        status: 'retry',
        // The store ran out of time waiting for a lock (a legacy lock passed
        // to it included): the same retryable contention as a lock this
        // module waited for itself.
        reason:
          error.kind === 'lock-contention'
            ? 'lock-contention'
            : `store-${error.kind}`,
      }
    throw error
  } finally {
    await runLock?.release().catch(() => {})
    await slotLock?.release().catch(() => {})
  }
}

/**
 * The checks that end a run before any lock: the migration marker. A pending
 * transfer always reaches the planner, regardless of marker or vault state.
 */
async function gate(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  config: Record<string, unknown>,
): Promise<PoolTransferOutcome | undefined> {
  const book = readPoolMigrationBookkeeping(config)
  if (book.pending) return undefined
  if (mode === 'migrate' && book.migratedAt !== undefined) {
    // Older builds marked a store migrated even when the placeholder in the
    // slot came from another store and no login was moved into this one.
    // Report that state as refused, and leave the store as it is.
    const load = await ctx.store.read()
    if (
      load.status === 'ready' &&
      !load.rows.some((row) => row.id === 'main') &&
      !book.pending &&
      placeholderWithoutMain(
        await readSlot(ctx),
        load.rows.some((row) => row.id === 'main'),
        book,
      )
    )
      return { status: 'refused', reason: 'placeholder-without-main' }
    return { status: 'already-migrated' }
  }
  if (mode === 'adopt' && book.migratedAt === undefined)
    return { status: 'not-migrated' }
  // Vault custody is enforced by the account source's identity filter, not
  // by leaving a real login in the slot. Adoption restores the placeholder
  // that lets OpenCode install its fetch; vault-owned rows remain set aside.
  return undefined
}

async function runLocked(
  ctx: Context,
  mode: 'migrate' | 'adopt',
): Promise<PoolTransferOutcome> {
  let idHint: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    const config = await readConfig(ctx.paths.configPath)
    const early = await gate(ctx, mode, config)
    if (early) {
      if (early.status === 'already-migrated') await repairShield(ctx)
      return early
    }
    let load = await ctx.store.read()
    const book = readPoolMigrationBookkeeping(config)
    if (load.status === 'pending-migration') {
      // The placeholder proves that some store moved a login, not that this
      // store did. Check before even initializing the pool key. Our own crash
      // after the placeholder write has a main row and pending record/shield;
      // let that record resume through the ordinary crash-safe planner.
      if (
        placeholderWithoutMain(
          await readSlot(ctx),
          load.roster.some((row) => isRecord(row) && row.id === 'main'),
          book,
        )
      )
        return { status: 'refused', reason: 'placeholder-without-main' }
      // The store refuses every write to a legacy roster until its pool key
      // exists. `mainAccountId` is deliberately kept here: older builds skip
      // the roster row whose identity it names, which keeps them off the
      // `main` row while the slot still holds the same token. It is dropped
      // only after the placeholder has landed (see `finishTransfer`).
      await ctx.store.initialize()
      await ctx.onStep('after-pool-key-write')
      load = await ctx.store.read()
    }
    if (load.status !== 'ready')
      return {
        status: 'error',
        reason:
          load.status === 'error'
            ? `${load.file}: ${load.reason}`
            : 'pool still pending migration',
      }
    const slot = await readSlotHonouringLease(ctx)
    if (slot.kind === 'retry')
      return { status: 'retry', reason: 'legacy-refresh-in-progress' }
    if (slot.kind === 'indeterminate')
      return { status: 'retry', reason: 'host-slot-indeterminate' }
    if (
      placeholderWithoutMain(
        slot,
        load.rows.some((row) => row.id === 'main'),
        book,
      )
    )
      return { status: 'refused', reason: 'placeholder-without-main' }
    const first = plan(
      mode,
      book,
      load.rows,
      slot,
      idHint,
      ctx.now(),
      ctx.newId,
    )

    if (first.kind === 'nothing') {
      if (mode === 'migrate') {
        await writeFinished(ctx, mode)
        await ctx.onStep('after-marker-write')
      }
      return { status: 'nothing-to-import', slot: first.slot }
    }
    if (first.kind === 'drop-record') {
      await clearRecord(ctx)
      await ctx.onStep('after-record-clear')
      continue
    }
    if (first.kind === 'ambiguous') {
      await writeFinished(ctx, mode, {
        declinedSlotFingerprint: first.record.slotFingerprint,
      })
      await ctx.onStep('after-record-clear')
      ctx.log.warn(
        'interrupted slot transfer left alone: the row was rotated since, so the slot copy may be stale; the next login resolves it',
        { rowId: first.record.rowId },
      )
      return { status: 'ambiguous', rowId: first.record.rowId }
    }
    if (first.kind === 'transfer' && first.fresh) idHint = first.record.rowId

    // No legacy lock is held here. The row write takes the row's legacy
    // fallback lock and `main-refresh` through the store (`applyToRow`), and
    // the store re-checks the row under its own lock: an `add` whose token
    // another row already holds becomes a rotate of that row, and a replace
    // or rotate refuses (retryably) a row whose wire identity changed since
    // this read. What was read here is proved afterwards by `verifyRow`.
    const step =
      first.kind === 'finish'
        ? await completeTransfer(ctx, mode, first.record, 'resumed')
        : await executeTransfer(ctx, mode, first)
    if (step.status !== 'restart') return step
  }
  return { status: 'retry', reason: 'unsettled' }
}

/**
 * An older build holding a pre-migration snapshot can write `mainAccountId`
 * back (its full-store save merges its snapshot over the file). With no
 * transfer in flight nothing needs the shield, so a finished migration
 * removes it again rather than let older builds skip the `main` row.
 */
async function repairShield(ctx: Context): Promise<void> {
  await updateConfig(ctx, (config) => {
    if (!('mainAccountId' in config)) return false
    if (readPoolMigrationBookkeeping(config).pending) return false
    delete config.mainAccountId
    return true
  })
}

/** What the migration needs beyond an adoption run. */
export interface PoolMigrationFenceDeps {
  /**
   * The version fence (`migrationFenceOpen` in `version-fence.ts`, bound to
   * this build's version). While it is shut the migration writes nothing.
   */
  fence: () => Promise<VersionFenceResult>
}

/**
 * One-time move of the host-slot credential into the pool row `main`
 * (fallback rows are already pool rows: same ids, same files). It writes
 * nothing while an older openai-auth process runs (`deferred`). A re-run
 * after completion does nothing.
 */
export function migrateToPool(
  deps: PoolMigrationDeps & PoolMigrationFenceDeps,
): Promise<PoolTransferOutcome> {
  return run(deps, 'migrate', deps.fence)
}

/**
 * After migration: a real login found in the host slot (someone ran
 * `/login openai` in OpenCode) moves into the pool, matched by wire identity,
 * and the placeholder goes back into the slot.
 */
export function adoptHostSlotLogin(
  deps: PoolMigrationDeps,
): Promise<PoolTransferOutcome> {
  return run(deps, 'adopt')
}

// ---------------------------------------------------------------------------
// Refresh of a pool row while older builds may run
// ---------------------------------------------------------------------------

export interface PoolRowRefreshDeps {
  paths: AccountPaths
  store: PoolStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  legacyLocks?: Partial<LegacyLockOptions>
  /** Bound and poll interval for waiting out an active legacy main lease. */
  leaseWait?: { timeoutMs: number; pollMs: number }
}

/** Thrown from the provider seam when a legacy main lease covers the token. */
export class LegacyMainRefreshInFlightError extends Error {
  constructor() {
    super(
      'an older build holds a refresh lease on this token; not refreshing it here',
    )
    this.name = 'LegacyMainRefreshInFlightError'
  }
}

/**
 * The legacy locks a pool refresh of `rowId` must also hold: `main-refresh`
 * (an older build refreshes the slot's token under it, and any row can share
 * the slot's token while a transfer is interrupted) and the row's fallback
 * lock (an older build refreshes every enabled roster row under it, the
 * migrated `main` row included). The provider-wide lock already serialises
 * every refresh, so these cost no concurrency.
 */
export function legacyRefreshLocks(
  paths: AccountPaths,
  rowId: string,
  options: Partial<LegacyLockOptions> = {},
): PoolLockSpec[] {
  const locks = { ...LEGACY_LOCK_DEFAULTS, ...options }
  const tuning = {
    renew: locks.renew,
    timeoutMs: locks.timeoutMs,
    retryMs: locks.retryMs,
    ...(locks.renewIntervalMs !== undefined
      ? { renewIntervalMs: locks.renewIntervalMs }
      : {}),
  }
  return [
    {
      name: MAIN_REFRESH_LOCK_NAME,
      path: paths.configPath,
      ttlMs: locks.mainRefreshTtlMs,
      ...tuning,
    },
    {
      name: fallbackRefreshLockName(rowId),
      path: paths.configPath,
      ttlMs: locks.fallbackTtlMs,
      ...tuning,
    },
  ]
}

/**
 * Refreshes one pool row with the legacy locks as the store's extra locks,
 * and honours an active legacy main lease on the row's token the way
 * `refreshMainWithLease` does: it waits (bounded) and never refreshes that
 * token itself. Once such a lease was seen the token may already be spent by
 * the older build (which writes its result to the host slot, not the row),
 * so the refresh fails retryably and adoption of the slot takes over.
 */
export async function refreshPoolRow(
  deps: PoolRowRefreshDeps,
  rowId: string,
  provider: ProviderRefresh,
  options: Omit<RefreshOptions, 'extraLocks'> = {},
): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const wait = deps.leaseWait ?? { timeoutMs: 4_000, pollMs: 50 }
  const guarded: ProviderRefresh = async (credential, row) => {
    const hash = hashRefreshToken(credential.refresh)
    const active = async () => {
      const legacy = await loadAccounts(deps.paths)
      const until = legacy?.refresh?.mainRefreshLeaseUntil
      return Boolean(
        until &&
          until > now() &&
          legacy?.refresh?.mainRefreshLeaseTokenHash === hash,
      )
    }
    if (await active()) {
      const deadline = now() + wait.timeoutMs
      while (now() < deadline && (await active())) await sleep(wait.pollMs)
      throw new LegacyMainRefreshInFlightError()
    }
    return provider(credential, row)
  }
  return deps.store.refresh(rowId, guarded, {
    ...options,
    extraLocks: legacyRefreshLocks(deps.paths, rowId, deps.legacyLocks),
  })
}
