// Pi's account pool as the request path's source of fallback accounts.
//
// The pool lives in Pi's own openai-auth files (`paths.ts`), in the format of
// `@cortexkit/common-auth/store`: each row's credential, recorded wire
// identity and quota map. A config written before the pool existed holds only
// the legacy roster; the first read turns it into a pool in the background
// (`store.initialize`, which keeps every roster row), and until that write
// lands no pool row serves.
//
// Nothing a request does may wait on a store lock:
//
// - Rows are read into memory. A request re-reads them only when the files
//   changed since the last read, lock-free and within `POOL_READ_BUDGET_MS`;
//   past it the last snapshot serves and the read finishes for the next
//   request.
// - A token is refreshed through the store (`store.refresh`, which holds the
//   row's lock and the provider-wide lock), always in the background: a
//   token inside the refresh window is still used meanwhile, and a row whose
//   token has run out sits out the requests made before its refresh lands.
//   Only a command (`pollRows`) waits for a refresh.
// - Quota observed on responses and WebSocket frames is merged into the
//   in-memory rows at once, so the next routing decision sees it, and written
//   to the store in the background, one write at a time per row.
// - Unknown quota blocks admission (`@cortexkit/common-auth/routing`), so no
//   row may stay without a reading: every row gets a quota poll as soon as
//   this process sees it, and admission asks for another whenever it refuses
//   a row for want of one.
//
// The OpenCode package's `core/pool-account-source.ts` is the same source for
// OpenCode; this one has no migration bookkeeping and no legacy refresh locks,
// because no Pi build before this one refreshed or routed pool accounts.

import { readFileSync, statSync } from 'node:fs'
import {
  mergeQuotaObservation,
  type QuotaObservation,
  quotaCodec,
} from '@cortexkit/common-auth/quota'
import {
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolLoad,
  type PoolRow,
  type PoolStore,
  type ProviderRefresh,
  type PullRequest,
} from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  buildRefreshOperationError,
  hashRefreshToken,
  isTransientRefreshError,
  type OAuthQuotaSnapshot,
  refreshBeforeExpiryMs,
} from '@cortexkit/openai-auth-core/internal'
import { observationFromSnapshot } from '@cortexkit/openai-auth-core/pool-quota'
import { identityOfToken } from './main-account.ts'

/**
 * Longest a request waits for a lock-free re-read of the pool files before
 * it goes ahead with the previous snapshot. A read of these small files
 * normally takes well under a millisecond; the budget only bounds a
 * pathological disk.
 */
export const POOL_READ_BUDGET_MS = 500

/** Minimum interval between two quota-poll requests this process makes for the same row. */
export const POOL_PULL_RETRY_MS = 15_000

/**
 * Retry delay after a refresh that failed without reaching the provider, such
 * as a lock that did not come free in time.
 */
const LOCAL_REFRESH_RETRY_MS = 30_000

/** Observations kept per row to re-apply over a re-read the store write has not reached yet. */
const PENDING_OBSERVATIONS_PER_ROW = 8
const PENDING_OBSERVATION_MAX_AGE_MS = 30 * 60_000

/** One quota poll of a row: the full snapshot, for display, and its observation. */
export interface RowPoll {
  snapshot: OAuthQuotaSnapshot
  observation: QuotaObservation
}

export interface PiPoolView {
  /** True once the pool reads as ready; its rows may serve requests. */
  active: boolean
  rows: readonly PoolRow[]
}

export interface PiPoolSourceDeps {
  /** Read on every use, so the source follows the configured store path. */
  paths: () => AccountPaths
  /** Refreshes one OAuth credential with the provider. */
  refreshProvider: ProviderRefresh
  /** Polls one row's quota. */
  pullQuota: (request: PullRequest) => Promise<RowPoll>
  now?: () => number
  readBudgetMs?: number
  pullRetryMs?: number
  /** Pass-through store options (tests). */
  store?: Partial<
    Pick<OpenPoolStoreOptions, 'lockOptions' | 'rowLockOptions' | 'hold'>
  >
  log?: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
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

type Snapshot = PiPoolView & { key: string | undefined; readAt: number }

/** How one row's quota poll ended, for the `/openai` quota check. */
export interface PoolPollResult {
  id: string
  ok: boolean
  error?: string
}

/**
 * Settles with `read` if it settles within `budgetMs`, otherwise with the
 * value `stale` returns at that moment. A rejection within the budget is
 * passed on; one after it is dropped, because the caller has moved on.
 */
export function settleWithinBudget<T>(
  read: Promise<T>,
  budgetMs: number,
  stale: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(stale()), budgetMs)
    timer.unref?.()
    read.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function fileKey(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return '-'
  }
}

/**
 * The key pending quota observations are kept under: the row's recorded
 * ChatGPT identity (its wire identity), else the row id.
 */
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

/**
 * Whether the config at `configPath` is the pool's format already. A config
 * that does not exist counts: the store writes the pool format from scratch.
 */
export function poolFormat(configPath: string): boolean {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return true
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Boolean(
      parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'commonAuthPool' in parsed,
    )
  } catch {
    return false
  }
}

const noopLog: NonNullable<PiPoolSourceDeps['log']> = {
  info() {},
  warn() {},
}

export class PiPoolSource {
  private readonly deps: PiPoolSourceDeps
  private readonly now: () => number
  private readonly log: NonNullable<PiPoolSourceDeps['log']>
  private snapshot: Snapshot = {
    active: false,
    rows: [],
    key: undefined,
    readAt: 0,
  }
  private inflightRead: { key: string; promise: Promise<Snapshot> } | undefined
  private store: { configPath: string; store: PoolStore } | undefined
  private initializing:
    | { configPath: string; promise: Promise<void> }
    | undefined
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly backoff = new Map<string, BackoffEntry>()
  private readonly rotated = new Map<string, PoolRow['credential']>()
  private readonly pending = new Map<string, PendingObservation[]>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly lastPull = new Map<string, number>()
  private readonly polled = new Set<string>()
  /** The latest full poll snapshot per row id, for the `/openai` quota check. */
  private readonly polledSnapshots = new Map<string, OAuthQuotaSnapshot>()
  private readonly pollOutcomes = new Map<string, PoolPollResult>()
  private disposed = false

  constructor(deps: PiPoolSourceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? noopLog
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  /** The rows as last read; never touches the disk. */
  peek(): PiPoolView {
    return { active: this.snapshot.active, rows: this.snapshot.rows }
  }

  /**
   * The rows for one request: the snapshot when the files are unchanged
   * (two `stat`s), otherwise a lock-free re-read the request waits for at
   * most the read budget.
   */
  async current(): Promise<PiPoolView> {
    const key = this.filesKey()
    if (this.snapshot.key === key) return this.peek()
    const settled = await settleWithinBudget(
      this.startRead(key),
      this.deps.readBudgetMs ?? POOL_READ_BUDGET_MS,
      () => this.snapshot,
    )
    return { active: settled.active, rows: settled.rows }
  }

  /** Reads the rows now (the extension's first read, commands, and tests). */
  async load(): Promise<PiPoolView> {
    const snapshot = await this.startRead(this.filesKey())
    return { active: snapshot.active, rows: snapshot.rows }
  }

  /** The store the rows live in, for account management. */
  poolStore(): PoolStore {
    return this.storeFor(this.deps.paths())
  }

  /** The latest full poll snapshot of a row (reset credits, credit budget). */
  polledSnapshot(id: string): OAuthQuotaSnapshot | undefined {
    return this.polledSnapshots.get(id)
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
    let load: PoolLoad
    try {
      load = await this.storeFor(paths).read()
    } catch (error) {
      this.log.warn('account pool read failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // An unreadable file keeps the last good rows rather than dropping
      // every account from routing.
      return this.snapshot
    }
    if (load.status === 'pending-migration') this.initialize(paths)
    else if (load.status === 'error') {
      this.log.warn('account pool is unreadable', {
        file: load.file,
        reason: load.reason,
      })
    }
    const next: Snapshot =
      load.status === 'ready'
        ? { active: true, rows: load.rows, key, readAt }
        : { active: false, rows: [], key, readAt }
    if (readAt >= this.snapshot.readAt) {
      this.snapshot = { ...next, rows: this.withLocalState(next.rows) }
    }
    if (this.snapshot.active) this.pollUnseenRows()
    return this.snapshot
  }

  /**
   * Turns a config written before the pool existed into the pool's format,
   * once per config path, in the background. The store keeps the legacy
   * roster rows; the write changes the files' key, so the next request
   * re-reads them as a ready pool.
   */
  private initialize(paths: AccountPaths): void {
    if (this.disposed || this.initializing?.configPath === paths.configPath)
      return
    const promise = this.storeFor(paths)
      .initialize()
      .then(
        (outcome) => {
          this.log.info('account pool initialized', { status: outcome.status })
        },
        (error: unknown) => {
          this.log.warn('account pool initialization failed', {
            error: error instanceof Error ? error.message : String(error),
          })
          // Let a later read try again.
          if (this.initializing?.promise === promise)
            this.initializing = undefined
        },
      )
    this.initializing = { configPath: paths.configPath, promise }
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
   * at the first read, a row added since, and a replaced credential. Never
   * waits.
   */
  private pollUnseenRows(): void {
    if (this.disposed) return
    for (const row of this.snapshot.rows) {
      // An enabled OAuth row torn by a replace that stopped between its two
      // writes is never a candidate until a store write completes it. The
      // poll's pull is such a write (it completes the row before reading the
      // credential), so it is polled too; the store's own `load()` would fire
      // the same pull, but this source reads with `read()`.
      const torn = row.torn === true && row.enabled
      if (!(row.candidate || torn) || row.type !== 'oauth') continue
      const key = `${row.id}\u0000${row.credentialEpoch ?? 0}\u0000${row.identity ?? ''}`
      if (this.polled.has(key)) continue
      this.polled.add(key)
      this.requestReading(row.id, true)
    }
  }

  /**
   * Asks the store for a quota poll of one row, at most once per
   * `POOL_PULL_RETRY_MS` unless `force`. Admission calls this for every row
   * it refuses for want of a reading, so it never waits.
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
    let poll: RowPoll
    try {
      poll = await this.deps.pullQuota(request)
    } catch (error) {
      this.pollOutcomes.set(request.id, {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    this.pollOutcomes.set(request.id, { id: request.id, ok: true })
    this.polledSnapshots.set(request.id, poll.snapshot)
    const row = this.snapshot.rows.find((r) => r.id === request.id)
    if (
      row &&
      row.credentialEpoch === request.credentialEpoch &&
      row.identity === request.identity
    ) {
      this.applyObservation(row, poll.observation)
    }
    return poll.observation
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

  /**
   * The row `accessToken` belongs to, for a WebSocket frame: the row whose
   * recorded ChatGPT identity matches the token's, or, when either identity
   * is unknown, the row holding exactly this token.
   */
  rowForToken(accessToken: string): PoolRow | undefined {
    const identity = identityOfToken(accessToken)
    return this.snapshot.rows.find((row) =>
      identity && row.identity
        ? row.identity === identity
        : oauthAccess(row)?.access === accessToken,
    )
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /**
   * Starts a refresh, through the store, of every candidate row whose token
   * is missing, run out or inside the refresh window; rows in a refresh
   * backoff are left alone. Resolves once those refreshes have ended, which
   * the request path never waits for. Never rejects.
   */
  refreshDueTokens(
    rows: readonly PoolRow[],
    storage: AccountStorage | null,
  ): Promise<void> {
    const now = this.now()
    const windowMs = refreshBeforeExpiryMs(storage)
    const runs: Promise<void>[] = []
    for (const row of rows) {
      if (!row.candidate) continue
      const token = oauthAccess(row)
      if (!token) continue
      const left = (token.expires ?? 0) - now
      const due = !token.access || !token.expires || left <= windowMs
      if (!due || this.refreshBackedOff(row, now)) continue
      runs.push(this.refresh(row.id))
    }
    return Promise.all(runs).then(() => {})
  }

  /** True while a failed refresh of this row's current refresh token may not be retried. */
  refreshBackedOff(row: PoolRow, now = this.now()): boolean {
    const token = oauthAccess(row)
    if (!token) return false
    const own = this.backoff.get(row.id)
    return Boolean(
      own &&
        own.tokenHash === hashRefreshToken(token.refresh) &&
        own.nextRetryAt > now,
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
    const before = this.snapshot.rows.find((row) => row.id === id)
    const refreshToken = before ? oauthAccess(before)?.refresh : undefined
    try {
      const outcome = await this.storeFor(this.deps.paths()).refresh(
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
    const now = this.now()
    const tokenHash = hashRefreshToken(refreshToken)
    const previous = this.backoff.get(id)
    // A provider answer (an HTTP status) or a network failure backs off the
    // way the legacy refresher does. Anything else is local (a lock that did
    // not come free) and is retried soon: a day-long backoff would strand a
    // healthy account.
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
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Polls the quota of every candidate OAuth row through the store, the same
   * pull path the first and admission polls take, and resolves once every
   * poll has ended. Due tokens are refreshed first.
   */
  async pollRows(storage: AccountStorage | null): Promise<PoolPollResult[]> {
    const view = await this.load()
    if (!view.active || this.disposed) return []
    const targets = view.rows.filter(
      (row) => row.candidate && row.type === 'oauth',
    )
    if (targets.length === 0) return []
    await this.refreshDueTokens(targets, storage)
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

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Stops new polls and writes; ones already started finish on their own. */
  dispose(): void {
    this.disposed = true
  }

  /** Resolves once every queued quota write, poll, refresh and initialization has settled (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [
        ...this.writes.values(),
        ...this.refreshing.values(),
        ...(this.initializing ? [this.initializing.promise] : []),
      ]
      await Promise.allSettled(pending)
      await this.store?.store.pullsSettled()
      if (this.writes.size === 0 && this.refreshing.size === 0) return
    }
  }
}
