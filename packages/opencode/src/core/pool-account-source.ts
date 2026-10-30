// The account pool as the request path's source of accounts, once the
// install is migrated.
//
// After the migration (`pool-migration.ts`) every account, main included, is
// a row of the pool in `@cortexkit/common-auth/store`: the row's credential,
// its recorded wire identity and its quota map all live there. This module
// is what the request path reads them through, under one rule: nothing a
// request does may wait on a store lock except getting a usable token.
//
// - Rows are read into memory. A request re-reads them only when the files
//   changed since the last read, lock-free and within the same budget the
//   sidebar cache uses (`HOT_PATH_READ_BUDGET_MS`); past it the last snapshot
//   serves and the read finishes for the next request.
// - A token is refreshed through the store (`refreshPoolRow`, so the legacy
//   `main-refresh` and per-row fallback locks are held as extra locks and an
//   older process refreshing the same row is honoured). A request waits for
//   that only when the token has run out; a token that is merely inside the
//   refresh window is refreshed in the background and still used.
// - Quota observed on responses and WebSocket frames is merged into the
//   in-memory map at once, so the next routing decision sees it, and written
//   to the store in the background, one write at a time per row.
// - Unknown quota blocks admission (`@cortexkit/common-auth/routing`), so no
//   row may stay without a reading: every row gets a quota poll as soon as
//   this process sees it (at load, when it is added, and when the install
//   turns migrated; at startup only once the vault has read which accounts
//   it holds), and admission asks for another whenever it refuses a row for
//   want of one.
//
// State that belongs to an account (rate-limit marks, pending quota) is keyed
// by the row's wire identity where the row records one, so a row that comes
// to hold a different account never inherits the old account's state.

import { readFileSync } from 'node:fs'
import {
  isQuotaMap,
  projectQuota,
  type QuotaObservation,
  quotaCodec,
} from '@cortexkit/common-auth/quota'
import {
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolRow,
  type PoolStore,
  type ProviderRefresh,
  type PullRequest,
} from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  poolAccountKey as accountKey,
  applyPendingPoolObservations,
  type PoolRefreshBackoff as BackoffEntry,
  extractAccountIdFromClaims,
  poolFileKey as fileKey,
  hashRefreshToken,
  mergePoolObservation,
  nextPoolRefreshBackoff,
  poolOAuthAccess as oauthAccess,
  type PoolPendingObservation as PendingObservation,
  parseJwtClaims,
  poolRefreshBackoffFor,
  refreshBackoffActive,
  refreshBeforeExpiryMs,
  rememberPoolObservation,
} from '@cortexkit/openai-auth-core/internal'
import { createLogger } from '../logger'
import { HOT_PATH_READ_BUDGET_MS, settleWithinBudget } from '../sidebar-state'
import {
  type LegacyLockOptions,
  readPoolMigrationBookkeeping,
  refreshPoolRow,
} from './pool-migration'
import { observationFromSnapshot } from './pool-quota'

/**
 * A request waits for a refresh only when its token has less than this left;
 * anything longer is sent as it is and refreshed in the background.
 */
export const POOL_TOKEN_MIN_VALIDITY_MS = 60_000

/** Minimum interval between two quota-poll requests this process makes for the same row. */
export const POOL_PULL_RETRY_MS = 15_000

/**
 * Longest a request's token step waits for the vault's first roster (see
 * `PoolAccountSourceDeps.vaultFirstRoster`) before it goes ahead with the
 * vault accounts known so far.
 */
export const VAULT_FIRST_ROSTER_WAIT_MS = 2_000

/**
 * Longest background work waits for the vault's first roster: the first
 * quota polls of new rows here, and each host's adoption of a slot login.
 * Past it that work is skipped for now (nothing is done under uncertainty)
 * and tried again later.
 */
export const VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS = 10_000

/**
 * Whether `promise` settles (resolves or rejects) within `ms`. Never rejects,
 * and its timer never keeps the process alive.
 */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
  return settled
}

export interface PoolView {
  /** True when the install is migrated and the pool loaded; the pool serves requests. */
  active: boolean
  rows: readonly PoolRow[]
}

export interface PoolAccountSourceDeps {
  /** Read on every use, so the source follows the configured store path. */
  paths: () => AccountPaths
  /** Refreshes one OAuth credential with the provider. */
  refreshProvider: ProviderRefresh
  /** Polls one row's quota; resolves to the observation to record. */
  pullQuota: (request: PullRequest) => Promise<QuotaObservation | undefined>
  now?: () => number
  readBudgetMs?: number
  pullRetryMs?: number
  legacyLocks?: Partial<LegacyLockOptions>
  /** Pass-through store options (tests). */
  store?: Partial<
    Pick<
      OpenPoolStoreOptions,
      'lockOptions' | 'rowLockOptions' | 'hold' | 'onStep'
    >
  >
  log?: Pick<ReturnType<typeof createLogger>, 'debug' | 'info' | 'warn'>
  /**
   * Where rate-limit marks are kept: account key to mark expiry (epoch ms).
   * OpenCode 2 passes one map per account store, shared by every location in
   * the process, so a 429 seen in one project keeps the others off the
   * account too. Without it the source keeps its own.
   */
  rateLimitMarks?: Map<string, number>
  /**
   * The ChatGPT accounts the Claustrum vault holds for this host. A row
   * signing in as one of them is not this host's to use (one account has
   * one owner, and the vault owns it): request routing skips it, and this
   * source never refreshes it or polls its quota either.
   */
  vaultIdentities?: () => ReadonlySet<string>
  /**
   * True while this host is in vault mode (enrolled with the Claustrum
   * vault). Every row is then set aside, whatever account it signs in as:
   * this source refreshes no token, polls no quota and offers no bearer, so
   * the files stay exactly as they are until the host disconnects. Read on
   * every use, so a disconnect restores local work at once.
   */
  vaultMode?: () => boolean
  /** Read enrollment before local refreshes, quota polls or writes; vaultMode blocks synchronous callbacks until that read completes. */
  vaultAuthority?: () => Promise<'vault' | 'local' | 'unreadable'>
  /**
   * Settles (resolved or rejected) once the vault has read its first roster.
   * Until then `vaultIdentities` is empty even for an account the vault
   * holds, so the first-sight quota polls of new rows wait for it (at most
   * `vaultFirstRosterBackgroundWaitMs`, else they are skipped this time),
   * and a token step waits for it at most `vaultFirstRosterWaitMs`. Nothing
   * else waits for it. Absent: there is no vault roster to wait for.
   */
  vaultFirstRoster?: Promise<unknown>
  /** Overrides `VAULT_FIRST_ROSTER_WAIT_MS` (tests). */
  vaultFirstRosterWaitMs?: number
  /** Overrides `VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS` (tests). */
  vaultFirstRosterBackgroundWaitMs?: number
}

type Snapshot = PoolView & { key: string | undefined; readAt: number }

/** How one row's quota poll ended, for callers that report it (the `/openai` quota check). */
export interface PoolPollResult {
  id: string
  ok: boolean
  error?: string
}

/**
 * The time of a row's oldest quota reading, or undefined when it has none: a
 * row is only as fresh as its stalest window.
 */
export function quotaReadAt(row: Pick<PoolRow, 'quota'>): number | undefined {
  if (!isQuotaMap(row.quota)) return undefined
  const projection = projectQuota(row.quota)
  return projection.limits.some((limit) => limit.kind === 'reading')
    ? projection.checkedAt
    : undefined
}

function identityOfToken(access: string | undefined): string | undefined {
  if (!access) return undefined
  const claims = parseJwtClaims(access)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

function readMigratedAt(configPath: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return undefined
    return readPoolMigrationBookkeeping(parsed as Record<string, unknown>)
      .migratedAt
  } catch {
    return undefined
  }
}

/**
 * Whether a row gets its first quota poll: a candidate OAuth row, or an
 * enabled OAuth row marked `torn`. A row is torn when a credential replace
 * wrote the new credential to the state file and stopped before its config
 * write (the new account and epoch); the store then never offers it for
 * routing (`candidate` is false) until its next write on the row records
 * what the state file says. A quota poll is such a write: the store's pull
 * completes the row before it reads the credential to poll with, so polling
 * a torn row is what makes it routable again. The store's own `load()` would
 * fire that pull, but this source reads with `read()`, which fires nothing.
 */
function pollable(row: PoolRow): boolean {
  if (row.type !== 'oauth') return false
  return row.candidate || (row.torn === true && row.enabled)
}

export class PoolAccountSource {
  private readonly listeners = new Set<() => void>()
  private readonly deps: PoolAccountSourceDeps
  private readonly now: () => number
  private readonly log: NonNullable<PoolAccountSourceDeps['log']>
  private snapshot: Snapshot = {
    active: false,
    rows: [],
    key: undefined,
    readAt: 0,
  }
  private inflightRead: { key: string; promise: Promise<Snapshot> } | undefined
  private store: { configPath: string; store: PoolStore } | undefined
  private readonly stores = new Set<PoolStore>()
  private disposal: Promise<void> | undefined
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly backoff = new Map<string, BackoffEntry>()
  /**
   * Credentials this process rotated, by row id, with the credential epoch
   * of the row they were rotated from. A rotation keeps the epoch; a
   * replacement (a re-login, another account) bumps it, so an entry whose
   * epoch no longer matches the row's belongs to a credential the row no
   * longer holds.
   */
  private readonly rotated = new Map<
    string,
    { credential: PoolRow['credential']; credentialEpoch: number | undefined }
  >()
  private readonly pending = new Map<string, PendingObservation[]>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly marks: Map<string, number>
  private readonly lastPull = new Map<string, number>()
  private readonly quotaPulls = new Map<
    string,
    Promise<QuotaObservation | undefined>
  >()
  private readonly polled = new Set<string>()
  /** The latest poll outcome per row id, read back by `pollRows`. */
  private readonly pollOutcomes = new Map<string, PoolPollResult>()
  private disposed = false
  /** Whether `deps.vaultFirstRoster` has settled (true when there is none). */
  private vaultRosterSettled: boolean
  /** Set once the first-sight polls are queued behind the vault's first roster. */
  private pollsAwaitVault = false

  constructor(deps: PoolAccountSourceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? createLogger('pool')
    this.marks = deps.rateLimitMarks ?? new Map()
    this.vaultRosterSettled = deps.vaultFirstRoster === undefined
    const settled = () => {
      this.vaultRosterSettled = true
    }
    deps.vaultFirstRoster?.then(settled, settled)
  }

  /**
   * Waits for the vault's first roster for at most `ms`, then returns either
   * way. Never rejects.
   */
  private async awaitVaultRoster(ms: number): Promise<void> {
    const first = this.deps.vaultFirstRoster
    if (this.vaultRosterSettled || !first) return
    await settlesWithin(first, ms)
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  /** The rows as last read; never touches the disk. */
  peek(): PoolView {
    return { active: this.snapshot.active, rows: this.snapshot.rows }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Read a display snapshot without starting first-sight quota polls or refreshing tokens. */
  async sidebarView(): Promise<PoolView> {
    const paths = this.deps.paths()
    if (readMigratedAt(paths.configPath) === undefined)
      return { active: false, rows: [] }
    const load = await this.storeFor(paths).read()
    return load.status === 'ready'
      ? { active: true, rows: this.withLocalState(load.rows) }
      : { active: false, rows: [] }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  /**
   * The rows for one request: the snapshot when the files are unchanged
   * (two `stat`s), otherwise a lock-free re-read that the request waits for
   * at most the hot-path read budget.
   */
  async current(): Promise<PoolView> {
    if (this.disposed) return this.peek()
    const key = this.filesKey()
    if (this.snapshot.key === key) return this.peek()
    const read = this.startRead(key)
    const settled = await settleWithinBudget(
      read,
      this.deps.readBudgetMs ?? HOT_PATH_READ_BUDGET_MS,
      () => this.snapshot,
    )
    return { active: settled.active, rows: settled.rows }
  }

  /** Reads the rows now (the loader's first read, and tests). */
  async load(): Promise<PoolView> {
    if (this.disposed) return this.peek()
    await this.deps.vaultAuthority?.()
    if (this.disposed) return this.peek()
    const snapshot = await this.startRead(this.filesKey())
    return { active: snapshot.active, rows: snapshot.rows }
  }

  private filesKey(): string {
    const paths = this.deps.paths()
    return `${paths.configPath}|${fileKey(paths.configPath)}|${fileKey(paths.statePath)}`
  }

  private storeFor(paths: AccountPaths): PoolStore {
    if (this.store?.configPath === paths.configPath) return this.store.store
    const store = openPoolStore({
      provider: 'openai',
      configPath: paths.configPath,
      statePath: paths.statePath,
      quota: quotaCodec,
      coalesceQuota: true,
      now: this.now,
      pull: (request) => this.coalescedPull(request),
      onPullFailure: (rowId, error) => {
        this.pollOutcomes.set(rowId, {
          id: rowId,
          ok: false,
          error: error.message,
        })
        this.log.warn('pool quota poll failed', {
          rowId,
          kind: error.kind,
          error: error.message,
        })
      },
      logger: this.log,
      ...this.deps.store,
      onStep: async (step, info) => {
        await this.deps.store?.onStep?.(step, info)
        // Enrollment can change while an operation waits for locks or the
        // provider, so check again before writing local account data.
        if (
          info.operation !== 'updateSettings' &&
          step.startsWith('before-') &&
          this.deps.vaultAuthority &&
          (await this.deps.vaultAuthority()) !== 'local'
        )
          throw new Error(
            'Local account writes are disabled while connected to the vault.',
          )
      },
    })
    this.store = { configPath: paths.configPath, store }
    this.stores.add(store)
    return store
  }

  private startRead(key: string): Promise<Snapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot)
    if (this.inflightRead?.key === key) return this.inflightRead.promise
    const readAt = this.now()
    const promise = this.read(key, readAt)
    const entry = { key, promise }
    this.inflightRead = entry
    const clear = () => {
      if (this.inflightRead === entry) this.inflightRead = undefined
    }
    promise.then(clear, clear)
    return promise
  }

  private async read(key: string, readAt: number): Promise<Snapshot> {
    const paths = this.deps.paths()
    let next: Snapshot = { active: false, rows: [], key, readAt }
    try {
      const migratedAt = readMigratedAt(paths.configPath)
      if (migratedAt !== undefined) {
        const load = await this.storeFor(paths).read()
        if (load.status === 'ready') {
          next = { active: true, rows: load.rows, key, readAt }
        } else {
          this.log.warn('migrated install has no readable account pool', {
            status: load.status,
            ...(load.status === 'error' ? { reason: load.reason } : {}),
          })
        }
      }
    } catch (error) {
      this.log.warn('account pool read failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // An unreadable file keeps the last good rows rather than dropping
      // every account from routing.
      return this.snapshot
    }
    if (this.disposed) return this.snapshot
    const wasActive = this.snapshot.active
    if (readAt >= this.snapshot.readAt) {
      this.snapshot = { ...next, rows: this.withLocalState(next.rows) }
      this.changed()
    }
    if (this.snapshot.active) {
      if (!wasActive) this.log.info('account pool serves requests')
      this.pollUnseenRows()
    }
    return this.snapshot
  }

  /**
   * Re-applies what this process knows and the files may not show yet: a
   * credential it rotated whose write a concurrent read missed, and quota it
   * observed whose store write has not landed.
   */
  private withLocalState(rows: readonly PoolRow[]): PoolRow[] {
    const now = this.now()
    return rows.map((row) => {
      let next = row
      const own = this.rotated.get(row.id)
      const rotated = own?.credential
      if (own && own.credentialEpoch !== row.credentialEpoch) {
        // The row's credential was replaced since this process rotated it.
        this.rotated.delete(row.id)
      } else if (
        rotated?.type === 'oauth' &&
        row.credential?.type === 'oauth'
      ) {
        const fileStamp = row.credential.lastRefreshedAt ?? 0
        const ownStamp = rotated.lastRefreshedAt ?? 0
        if (fileStamp >= ownStamp) this.rotated.delete(row.id)
        else next = { ...next, credential: rotated }
      }
      return applyPendingPoolObservations(next, this.pending, now)
    })
  }

  private replaceRow(id: string, update: (row: PoolRow) => PoolRow): void {
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.map((row) =>
        row.id === id ? update(row) : row,
      ),
    }
    this.changed()
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  /**
   * Polls every row this process has not polled for its current credential:
   * at the first load, a row added since, a replaced credential, and every
   * row once the install turns migrated. Never waits.
   */
  /**
   * Whether this row is not this host's to use: the host is in vault mode,
   * or the vault owns the account the row signs in as.
   */
  private vaultOwned(row: Pick<PoolRow, 'identity'>): boolean {
    if (this.deps.vaultMode?.()) return true
    return (
      row.identity !== undefined &&
      (this.deps.vaultIdentities?.().has(row.identity) ?? false)
    )
  }

  private pollUnseenRows(): void {
    if (this.disposed) return
    const first = this.deps.vaultFirstRoster
    if (!this.vaultRosterSettled && first && !this.deps.vaultMode?.()) {
      // Which rows the vault owns is not known yet. These polls run in the
      // background anyway, so they wait for the roster (for a bounded time)
      // rather than poll a vault account's local row with that row's own
      // token. One deferred pass covers every read until then: it polls the
      // rows as they are. When the roster does not come within the bound the
      // polls are skipped this time; a later read tries again, and admission
      // still asks for a reading of any row it refuses for want of one.
      if (this.pollsAwaitVault) return
      this.pollsAwaitVault = true
      void settlesWithin(
        first,
        this.deps.vaultFirstRosterBackgroundWaitMs ??
          VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS,
      ).then((settled) => {
        this.pollsAwaitVault = false
        if (settled) this.pollUnseenRows()
        else
          this.log.info(
            'first quota polls skipped: the vault has not read its accounts yet',
          )
      })
      return
    }
    for (const row of this.snapshot.rows) {
      if (!pollable(row) || this.vaultOwned(row)) continue
      const key = `${row.id}\u0000${row.credentialEpoch ?? 0}\u0000${row.identity ?? ''}`
      if (this.polled.has(key)) continue
      this.polled.add(key)
      this.requestReading(row.id, true)
    }
  }

  /**
   * Asks the store for a quota poll of one row, at most once per
   * `POOL_PULL_RETRY_MS`. Admission calls this for every row it refuses for
   * want of a reading. The returned promise lets first-reading admission join
   * the store's pending polls without blocking callers that do not await it.
   */
  requestReading(id: string, force = false): Promise<void> | undefined {
    if (this.disposed || this.deps.vaultMode?.()) return
    const now = this.now()
    const last = this.lastPull.get(id)
    if (
      !force &&
      last !== undefined &&
      now - last < (this.deps.pullRetryMs ?? POOL_PULL_RETRY_MS)
    )
      return this.storeFor(this.deps.paths()).pullsSettled()
    this.lastPull.set(id, now)
    const store = this.storeFor(this.deps.paths())
    store.requestReading(id)
    return store.pullsSettled()
  }

  private coalescedPull(
    request: PullRequest,
  ): Promise<QuotaObservation | undefined> {
    const key = JSON.stringify([
      this.deps.paths().configPath,
      request.id,
      request.credentialEpoch,
      request.identity,
    ])
    const pending = this.quotaPulls.get(key)
    if (pending) return pending
    const pull = this.pull(request).finally(() => this.quotaPulls.delete(key))
    this.quotaPulls.set(key, pull)
    return pull
  }

  private async pull(
    request: PullRequest,
  ): Promise<QuotaObservation | undefined> {
    if (
      this.deps.vaultAuthority &&
      (await this.deps.vaultAuthority()) !== 'local'
    )
      throw new Error(
        'local accounts are not polled while this host is connected to the vault',
      )
    let observation: QuotaObservation | undefined
    try {
      observation = await this.deps.pullQuota(request)
      if (!observation) throw new Error('the quota poll returned no reading')
    } catch (error) {
      this.pollOutcomes.set(request.id, {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    this.pollOutcomes.set(request.id, { id: request.id, ok: true })
    const row = this.snapshot.rows.find((r) => r.id === request.id)
    if (
      row &&
      row.credentialEpoch === request.credentialEpoch &&
      row.identity === request.identity
    ) {
      this.applyObservation(row, observation)
    }
    return observation
  }

  private applyObservation(row: PoolRow, observation: QuotaObservation): void {
    rememberPoolObservation(this.pending, row, observation)
    this.replaceRow(row.id, (current) => ({
      ...current,
      quota: mergePoolObservation(current.quota, observation),
      needsFirstReading: false,
    }))
  }

  /**
   * Records a quota snapshot that arrived with a response or a WebSocket
   * frame sent with `accessToken` on row `rowId`. A token whose own identity
   * differs from the row's recorded one belongs to another account and is
   * dropped. The store write is queued; this returns at once.
   */
  recordSnapshot(
    rowId: string,
    snapshot: Record<string, unknown>,
    accessToken: string,
    complete: boolean,
  ): void {
    if (!this.snapshot.active || this.disposed || this.deps.vaultMode?.())
      return
    const row = this.snapshot.rows.find((r) => r.id === rowId)
    if (row?.type !== 'oauth') return
    // The token must be the row's own: its wire identity matches the row's
    // recorded one, or, when either is unknown, it is the row's current
    // access token. Anything else describes another account.
    const tokenIdentity = identityOfToken(accessToken)
    const belongs =
      tokenIdentity && row.identity
        ? tokenIdentity === row.identity
        : oauthAccess(row)?.access === accessToken
    if (!belongs) return
    const observation = observationFromSnapshot(snapshot, this.now(), complete)
    if (!observation) return
    this.applyObservation(row, observation)
    if (row.credentialEpoch === undefined) return
    const attribution = {
      credentialEpoch: row.credentialEpoch,
      ...(row.identity !== undefined ? { identity: row.identity } : {}),
    }
    const store = this.storeFor(this.deps.paths())
    const previous = this.writes.get(row.id) ?? Promise.resolve()
    const write = previous
      .then(async () => {
        if (
          this.deps.vaultAuthority &&
          (await this.deps.vaultAuthority()) !== 'local'
        )
          return
        return store.recordQuota(row.id, attribution, observation)
      })
      .catch((error: unknown) => {
        this.log.warn('pool quota not recorded', {
          rowId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    this.writes.set(row.id, write)
    void write.finally(() => {
      if (this.writes.get(row.id) === write) this.writes.delete(row.id)
    })
  }

  // -------------------------------------------------------------------------
  // Rate-limit marks
  // -------------------------------------------------------------------------

  /** Marks a row's account rate-limited until `untilMs` (a WebSocket signal). */
  markRateLimited(rowId: string, untilMs: number): void {
    const row = this.snapshot.rows.find((r) => r.id === rowId)
    if (!row) return
    const key = accountKey(row)
    const existing = this.marks.get(key)
    if (existing !== undefined && existing > untilMs) return
    this.marks.set(key, untilMs)
  }

  /** For each given row with a live rate-limit mark: row id to the mark's expiry time (ms). */
  rateLimitMarks(rows: readonly PoolRow[]): Map<string, number> {
    const out = new Map<string, number>()
    for (const row of rows) {
      const until = this.marks.get(accountKey(row))
      if (until !== undefined) out.set(row.id, until)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /**
   * Refreshes the tokens the rows need. Waits only for rows whose token has
   * run out (or is about to, `POOL_TOKEN_MIN_VALIDITY_MS`); a token inside
   * the refresh window but still valid is refreshed in the background. Rows
   * in a refresh backoff are left alone. Never rejects.
   */
  async prepareTokens(
    rows: readonly PoolRow[],
    storage: AccountStorage | null,
    options: { waitForAll?: boolean } = {},
  ): Promise<void> {
    if (
      this.deps.vaultAuthority &&
      (await this.deps.vaultAuthority()) !== 'local'
    )
      return
    // A row signing in as a vault account must not be refreshed, and before
    // the vault's first roster no such account is known. Bounded, so a vault
    // that never answers costs a request at most this wait. In vault mode
    // every row is set aside already, so there is nothing to wait for.
    if (!this.deps.vaultMode?.())
      await this.awaitVaultRoster(
        this.deps.vaultFirstRosterWaitMs ?? VAULT_FIRST_ROSTER_WAIT_MS,
      )
    const now = this.now()
    const windowMs = refreshBeforeExpiryMs(storage)
    const waits: Promise<void>[] = []
    for (const row of rows) {
      if (!row.candidate || this.vaultOwned(row)) continue
      const token = oauthAccess(row)
      if (!token) continue
      const left = (token.expires ?? 0) - now
      const due = !token.access || !token.expires || left <= windowMs
      if (!due || this.refreshBackedOff(row, storage, now)) continue
      const refresh = this.refresh(row.id)
      if (
        options.waitForAll ||
        !token.access ||
        !token.expires ||
        left <= POOL_TOKEN_MIN_VALIDITY_MS
      )
        waits.push(refresh)
    }
    await Promise.all(waits)
  }

  /**
   * True while a failed refresh of this row's current refresh token may not
   * be retried: one this process saw, or one the legacy store recorded for
   * the same token (an older process, or the legacy background refresher).
   */
  refreshBackedOff(
    row: PoolRow,
    storage: AccountStorage | null,
    now = this.now(),
  ): boolean {
    const token = oauthAccess(row)
    if (!token) return false
    const tokenHash = hashRefreshToken(token.refresh)
    const own = this.backoff.get(row.id)
    if (own && own.tokenHash === tokenHash && own.nextRetryAt > now) return true
    const legacy = storage?.accounts.find((account) => account.id === row.id)
    return Boolean(
      legacy?.type === 'oauth' &&
        legacy.corrupt !== true &&
        refreshBackoffActive(legacy.lastRefreshError, token.refresh, now),
    )
  }

  /**
   * The bearer to send for `row`, or undefined when it holds no unexpired
   * token. The row is looked up again in the current snapshot, so a row
   * chosen from an older snapshot never sends a login that has since been
   * disabled, replaced (another identity or credential epoch), or found to
   * belong to an account the vault holds.
   */
  usableToken(row: PoolRow, now = this.now()): string | undefined {
    const current = this.snapshot.rows.find(
      (candidate) => candidate.id === row.id,
    )
    if (
      !current?.enabled ||
      !current.candidate ||
      current.type !== 'oauth' ||
      current.identity !== row.identity ||
      current.credentialEpoch !== row.credentialEpoch ||
      this.vaultOwned(current)
    )
      return undefined
    const token = oauthAccess(current)
    if (!token?.access.trim()) return undefined
    if (typeof token.expires !== 'number' || token.expires <= now)
      return undefined
    return token.access
  }

  private refresh(id: string): Promise<void> {
    const inflight = this.refreshing.get(id)
    if (inflight) return inflight
    const run = this.runRefresh(id).finally(() => {
      if (this.refreshing.get(id) === run) this.refreshing.delete(id)
    })
    this.refreshing.set(id, run)
    return run
  }

  private async runRefresh(id: string): Promise<void> {
    if (
      this.deps.vaultAuthority &&
      (await this.deps.vaultAuthority()) !== 'local'
    )
      return
    const paths = this.deps.paths()
    const before = this.snapshot.rows.find((row) => row.id === id)
    const refreshToken = before ? oauthAccess(before)?.refresh : undefined
    // The epoch of the row the store actually refreshed, read under its
    // locks. A rotation keeps it, so the rotated credential belongs to it.
    let refreshedEpoch: number | undefined
    const provider: ProviderRefresh = (credential, row) => {
      refreshedEpoch = row.credentialEpoch
      return this.deps.refreshProvider(credential, row)
    }
    try {
      const outcome = await refreshPoolRow(
        {
          paths,
          store: this.storeFor(paths),
          now: this.now,
          ...(this.deps.legacyLocks
            ? { legacyLocks: this.deps.legacyLocks }
            : {}),
        },
        id,
        provider,
      )
      if (outcome.status === 'rotated') {
        this.backoff.delete(id)
        this.rotated.set(id, {
          credential: outcome.credential,
          credentialEpoch: refreshedEpoch,
        })
        this.replaceRow(id, (row) =>
          row.credentialEpoch !== refreshedEpoch
            ? row
            : {
                ...row,
                credential: outcome.credential,
                ...(outcome.identity !== undefined && row.identity === undefined
                  ? { identity: outcome.identity }
                  : {}),
              },
        )
        return
      }
      if (outcome.status === 'identity-contradicted') {
        // The provider handed back a different account's tokens. The store has
        // already kept them on the row and disabled it, so this row stops
        // serving here too; backing off would only retry a row that is off.
        // The identities stay out of the log: they are ChatGPT account ids.
        this.backoff.delete(id)
        this.replaceRow(id, (row) => ({
          ...row,
          enabled: false,
          candidate: false,
        }))
        this.log.warn(
          'pool row disabled: its refresh returned a different account',
          { rowId: id },
        )
        return
      }
      this.recordRefreshFailure(id, refreshToken, new Error(outcome.reason))
    } catch (error) {
      this.recordRefreshFailure(id, refreshToken, error)
    }
  }

  private recordRefreshFailure(
    id: string,
    refreshToken: string | undefined,
    error: unknown,
  ): void {
    this.log.warn('pool row refresh failed', {
      rowId: id,
      error: error instanceof Error ? error.message : String(error),
    })
    if (!refreshToken) return
    this.backoff.set(
      id,
      nextPoolRefreshBackoff(
        refreshToken,
        error,
        this.now(),
        this.backoff.get(id),
      ),
    )
  }

  /** Row id to the time a failed refresh may be retried, for rows with no usable token. */
  refreshBackoffFor(rows: readonly PoolRow[]): Map<string, number> {
    return poolRefreshBackoffFor(rows, this.backoff, this.now(), (row, now) =>
      this.usableToken(row, now),
    )
  }

  // -------------------------------------------------------------------------
  // Callers outside the request path: the background poller, commands,
  // cachekeep and reset credits. None of them may refresh or poll a pool row
  // any other way, so a row has one refresher and one poller.
  // -------------------------------------------------------------------------

  /** Whether the pool serves this install now (re-reads changed files). */
  async active(): Promise<boolean> {
    return (await this.current()).active
  }

  /** The store the rows live in, for account management (add, disable). */
  poolStore(): PoolStore {
    return this.storeFor(this.deps.paths())
  }

  /**
   * Refreshes every candidate row whose token is inside the refresh window,
   * waiting for all of them; rows in a refresh backoff are left alone. The
   * idle counterpart of `prepareTokens`, for the background poller.
   */
  async refreshDueTokens(storage: AccountStorage | null): Promise<void> {
    const view = await this.current()
    if (!view.active || this.disposed) return
    await this.prepareTokens(view.rows, storage, { waitForAll: true })
  }

  /**
   * Polls the quota of every candidate OAuth row (or of the rows named in
   * `ids`) through the store, the same pull path the first and admission
   * polls take, and resolves once every poll has ended. A row whose oldest
   * reading is newer than `skipReadWithinMs` is left out. Due tokens are
   * refreshed first so a poll is not sent with a token that ran out.
   */
  async pollRows(
    storage: AccountStorage | null,
    options: { ids?: readonly string[]; skipReadWithinMs?: number } = {},
  ): Promise<PoolPollResult[]> {
    const view = await this.load()
    if (!view.active || this.disposed) return []
    const now = this.now()
    const targets = view.rows.filter((row) => {
      if (!row.candidate || row.type !== 'oauth' || this.vaultOwned(row))
        return false
      if (options.ids && !options.ids.includes(row.id)) return false
      if (options.skipReadWithinMs === undefined) return true
      const readAt = quotaReadAt(row)
      return readAt === undefined || now - readAt >= options.skipReadWithinMs
    })
    if (targets.length === 0) return []
    await this.prepareTokens(targets, storage, { waitForAll: true })
    for (const row of targets) {
      this.pollOutcomes.delete(row.id)
      this.requestReading(row.id, true)
    }
    await this.poolStore().pullsSettled()
    return targets.map(
      (row) =>
        this.pollOutcomes.get(row.id) ?? {
          id: row.id,
          ok: false,
          error: 'the quota poll did not run',
        },
    )
  }

  /**
   * The bearer to use for one row outside a request (cachekeep, reset
   * credits), refreshed through the pool first when it is due. Undefined when
   * the row is missing, not a candidate, or holds no usable token.
   */
  async accessFor(
    id: string,
    storage: AccountStorage | null,
  ): Promise<{ row: PoolRow; token: string } | undefined> {
    const view = await this.current()
    if (!view.active) return undefined
    const row = view.rows.find((candidate) => candidate.id === id)
    if (!row?.candidate) return undefined
    await this.prepareTokens([row], storage)
    const current =
      this.snapshot.rows.find((candidate) => candidate.id === id) ?? row
    // The refresh just run can take the row out of routing (it returned
    // another account's tokens), and then it has no bearer to offer.
    if (!current.candidate) return undefined
    const token = this.usableToken(current)
    return token ? { row: current, token } : undefined
  }

  /**
   * The row behind an account key (`main` is row `main`) and its bearer,
   * refreshed through the pool when due. For a caller that words its own
   * refusal for a missing or disabled row (the reset-credit command).
   * Undefined when the install is not migrated; `row` is absent when no row
   * has the id, `token` when the row holds no usable one.
   */
  async rowAccess(
    id: string,
    storage: AccountStorage | null,
  ): Promise<
    | {
        row?: Pick<PoolRow, 'id' | 'type' | 'enabled' | 'label' | 'identity'>
        token?: string
      }
    | undefined
  > {
    const view = await this.current()
    if (!view.active) return undefined
    const row = view.rows.find((candidate) => candidate.id === id)
    if (!row) return {}
    const access = await this.accessFor(id, storage)
    return {
      row: {
        id: row.id,
        type: row.type,
        enabled: row.enabled,
        ...(row.label !== undefined ? { label: row.label } : {}),
        ...(row.identity !== undefined ? { identity: row.identity } : {}),
      },
      ...(access ? { token: access.token } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Stop admission, submit accepted snapshots, then drain each serving store. */
  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= (async () => {
      await Promise.allSettled([...this.writes.values()])
      await Promise.all([...this.stores].map((store) => store.close()))
    })()
    return this.disposal
  }

  /** Joins the cached in-flight read, quota writes, polls and refreshes. */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [
        ...this.writes.values(),
        ...this.refreshing.values(),
        ...(this.inflightRead ? [this.inflightRead.promise] : []),
      ]
      await Promise.allSettled(pending)
      await this.store?.store.pullsSettled()
      if (
        this.writes.size === 0 &&
        this.refreshing.size === 0 &&
        !this.inflightRead
      ) {
        await this.disposal
        return
      }
    }
  }
}
