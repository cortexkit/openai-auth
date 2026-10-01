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
//   turns migrated), and admission asks for another whenever it refuses a row
//   for want of one.
//
// State that belongs to an account (rate-limit marks, pending quota) is keyed
// by the row's wire identity where the row records one, so a row that comes
// to hold a different account never inherits the old account's state.

import { readFileSync, statSync } from 'node:fs'
import {
  isQuotaMap,
  mergeQuotaObservation,
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
  buildRefreshOperationError,
  extractAccountIdFromClaims,
  hashRefreshToken,
  isTransientRefreshError,
  parseJwtClaims,
  refreshBackoffActive,
  refreshBeforeExpiryMs,
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
 * Retry delay after a refresh that failed without reaching the provider: a
 * lock that did not come free in time, or an older process's lease on the
 * same token.
 */
const LOCAL_REFRESH_RETRY_MS = 30_000

/** Observations kept per row to re-apply over a re-read the store write has not reached yet. */
const PENDING_OBSERVATIONS_PER_ROW = 8
const PENDING_OBSERVATION_MAX_AGE_MS = 30 * 60_000

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
    Pick<OpenPoolStoreOptions, 'lockOptions' | 'rowLockOptions' | 'hold'>
  >
  log?: Pick<ReturnType<typeof createLogger>, 'debug' | 'info' | 'warn'>
}

type BackoffEntry = {
  nextRetryAt: number
  tokenHash: string
  retryCount: number
}

type PendingObservation = {
  credentialEpoch: number | undefined
  identity: string | undefined
  observation: QuotaObservation
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

function fileKey(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return '-'
  }
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

/** The key account state is partitioned by: the wire identity, else the row id. */
function accountKey(row: Pick<PoolRow, 'id' | 'identity'>): string {
  return row.identity ? `identity:${row.identity}` : `row:${row.id}`
}

export function oauthAccess(row: PoolRow):
  | {
      access: string
      expires: number | undefined
      refresh: string
    }
  | undefined {
  const credential = row.credential
  if (credential?.type !== 'oauth') return undefined
  return {
    access: credential.access ?? '',
    expires: credential.expires,
    refresh: credential.refresh,
  }
}

export class PoolAccountSource {
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
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly backoff = new Map<string, BackoffEntry>()
  private readonly rotated = new Map<string, PoolRow['credential']>()
  private readonly pending = new Map<string, PendingObservation[]>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly marks = new Map<string, number>()
  private readonly lastPull = new Map<string, number>()
  private readonly polled = new Set<string>()
  /** The latest poll outcome per row id, read back by `pollRows`. */
  private readonly pollOutcomes = new Map<string, PoolPollResult>()
  private disposed = false

  constructor(deps: PoolAccountSourceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? createLogger('pool')
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  /** The rows as last read; never touches the disk. */
  peek(): PoolView {
    return { active: this.snapshot.active, rows: this.snapshot.rows }
  }

  /**
   * The rows for one request: the snapshot when the files are unchanged
   * (two `stat`s), otherwise a lock-free re-read that the request waits for
   * at most the hot-path read budget.
   */
  async current(): Promise<PoolView> {
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
      now: this.now,
      pull: (request) => this.pull(request),
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
    })
    this.store = { configPath: paths.configPath, store }
    return store
  }

  private startRead(key: string): Promise<Snapshot> {
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
    const wasActive = this.snapshot.active
    if (readAt >= this.snapshot.readAt) {
      this.snapshot = { ...next, rows: this.withLocalState(next.rows) }
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
      const rotated = this.rotated.get(row.id)
      if (rotated?.type === 'oauth' && row.credential?.type === 'oauth') {
        const fileStamp = row.credential.lastRefreshedAt ?? 0
        const ownStamp = rotated.lastRefreshedAt ?? 0
        if (fileStamp >= ownStamp) this.rotated.delete(row.id)
        else next = { ...next, credential: rotated }
      }
      const pending = (this.pending.get(accountKey(row)) ?? []).filter(
        (entry) =>
          now - entry.observation.checkedAt <= PENDING_OBSERVATION_MAX_AGE_MS,
      )
      for (const entry of pending) {
        if (
          entry.credentialEpoch !== row.credentialEpoch ||
          entry.identity !== row.identity
        )
          continue
        next = { ...next, quota: this.merged(next.quota, entry.observation) }
      }
      return next
    })
  }

  private merged(stored: unknown, observation: QuotaObservation): unknown {
    try {
      return mergeQuotaObservation(stored, observation)
    } catch {
      return stored
    }
  }

  private replaceRow(id: string, update: (row: PoolRow) => PoolRow): void {
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.map((row) =>
        row.id === id ? update(row) : row,
      ),
    }
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  /**
   * Polls every row this process has not polled for its current credential:
   * at the first load, a row added since, a replaced credential, and every
   * row once the install turns migrated. Never waits.
   */
  private pollUnseenRows(): void {
    if (this.disposed) return
    for (const row of this.snapshot.rows) {
      if (!row.candidate || row.type !== 'oauth') continue
      const key = `${row.id}\u0000${row.credentialEpoch ?? 0}\u0000${row.identity ?? ''}`
      if (this.polled.has(key)) continue
      this.polled.add(key)
      this.requestReading(row.id, true)
    }
  }

  /**
   * Asks the store for a quota poll of one row, at most once per
   * `POOL_PULL_RETRY_MS`. Admission calls this for every row it refuses for
   * want of a reading, so it must never wait and must stay cheap.
   */
  requestReading(id: string, force = false): void {
    if (this.disposed) return
    const now = this.now()
    const last = this.lastPull.get(id)
    if (
      !force &&
      last !== undefined &&
      now - last < (this.deps.pullRetryMs ?? POOL_PULL_RETRY_MS)
    )
      return
    this.lastPull.set(id, now)
    this.storeFor(this.deps.paths()).requestReading(id)
  }

  private async pull(
    request: PullRequest,
  ): Promise<QuotaObservation | undefined> {
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
    const key = accountKey(row)
    const list = [
      ...(this.pending.get(key) ?? []),
      {
        credentialEpoch: row.credentialEpoch,
        identity: row.identity,
        observation,
      },
    ].slice(-PENDING_OBSERVATIONS_PER_ROW)
    this.pending.set(key, list)
    this.replaceRow(row.id, (current) => ({
      ...current,
      quota: this.merged(current.quota, observation),
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
    if (!this.snapshot.active || this.disposed) return
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
      .then(() => store.recordQuota(row.id, attribution, observation))
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
    const now = this.now()
    const windowMs = refreshBeforeExpiryMs(storage)
    const waits: Promise<void>[] = []
    for (const row of rows) {
      if (!row.candidate) continue
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

  /** The bearer to send for a row, or undefined when it holds no unexpired token. */
  usableToken(row: PoolRow, now = this.now()): string | undefined {
    const token = oauthAccess(row)
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
    const paths = this.deps.paths()
    const before = this.snapshot.rows.find((row) => row.id === id)
    const refreshToken = before ? oauthAccess(before)?.refresh : undefined
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
        this.deps.refreshProvider,
      )
      if (outcome.status === 'rotated') {
        this.backoff.delete(id)
        this.rotated.set(id, outcome.credential)
        this.replaceRow(id, (row) => ({
          ...row,
          credential: outcome.credential,
          ...(outcome.identity !== undefined && row.identity === undefined
            ? { identity: outcome.identity }
            : {}),
        }))
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
    const now = this.now()
    const tokenHash = hashRefreshToken(refreshToken)
    const previous = this.backoff.get(id)
    // A provider answer (an HTTP status) or a network failure backs off the
    // way the legacy refresher does. Anything else is local (a lock that did
    // not come free, an older process's lease on the token) and is retried
    // soon: a day-long backoff would strand a healthy account.
    const fromProvider =
      typeof (error as { status?: unknown } | null)?.status === 'number' ||
      isTransientRefreshError(error)
    if (fromProvider) {
      const built = buildRefreshOperationError({
        error,
        now,
        refreshToken,
        ...(previous
          ? {
              previous: {
                message: '',
                checkedAt: now,
                nextRetryAt: previous.nextRetryAt,
                retryCount: previous.retryCount,
                tokenHash: previous.tokenHash,
              },
            }
          : {}),
      })
      this.backoff.set(id, {
        nextRetryAt: built.nextRetryAt,
        tokenHash,
        retryCount: built.retryCount,
      })
    } else {
      this.backoff.set(id, {
        nextRetryAt: now + LOCAL_REFRESH_RETRY_MS,
        tokenHash,
        retryCount: previous?.tokenHash === tokenHash ? previous.retryCount : 0,
      })
    }
  }

  /** Row id to the time a failed refresh may be retried, for rows with no usable token. */
  refreshBackoffFor(rows: readonly PoolRow[]): Map<string, number> {
    const now = this.now()
    const out = new Map<string, number>()
    for (const row of rows) {
      if (this.usableToken(row, now)) continue
      const own = this.backoff.get(row.id)
      out.set(
        row.id,
        own && own.nextRetryAt > now
          ? own.nextRetryAt
          : now + LOCAL_REFRESH_RETRY_MS,
      )
    }
    return out
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
      if (!row.candidate || row.type !== 'oauth') return false
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

  /** Stops new polls and writes; ones already started finish on their own. */
  dispose(): void {
    this.disposed = true
  }

  /** Resolves once every queued quota write, poll and refresh has settled (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.writes.values(), ...this.refreshing.values()]
      await Promise.allSettled(pending)
      await this.store?.store.pullsSettled()
      if (this.writes.size === 0 && this.refreshing.size === 0) return
    }
  }
}
