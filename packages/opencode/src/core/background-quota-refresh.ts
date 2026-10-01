import {
  type AccountStorage,
  acquireRefreshFileLock,
  type RefreshAllQuotaDeps,
  type RefreshAllQuotaResult,
  refreshAllQuota,
} from '@cortexkit/openai-auth-core/internal'

export const BACKGROUND_QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000
export const BACKGROUND_QUOTA_REFRESH_JITTER_MS = 30_000
export const BACKGROUND_QUOTA_FRESHNESS_MS = 4 * 60_000
export const BACKGROUND_QUOTA_REFRESH_LOCK_NAME = 'bg-quota-refresh'
// The lock must outlive the worst-case serial refresh: each fallback account
// costs a token refresh plus a wham fetch (up to ~15s each), so a fleet of
// accounts can run well past a minute. A TTL that expires mid-run lets a second
// process start a concurrent refresh — 120s covers a multi-account pass with
// margin while still releasing a crashed owner's lock within one poll interval.
export const BACKGROUND_QUOTA_REFRESH_LOCK_TTL_MS = 120_000

type TimerHandle = ReturnType<typeof setInterval>

interface BackgroundQuotaRefreshOptions {
  setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle
  clearIntervalFn?: (timer: TimerHandle) => void
  random?: () => number
  onError?: (error: unknown) => void
}

type RefreshAllQuotaFn = (
  deps: RefreshAllQuotaDeps,
) => Promise<RefreshAllQuotaResult[]>

type BackgroundLockHandle = { release: () => Promise<void> }
export type BackgroundLockAcquirer = () => Promise<BackgroundLockHandle | null>

/**
 * Acquire the cross-process lock that serializes the background refresh.
 * `renew` re-arms the TTL on an interval until release(), so a serial pass that
 * outlasts the TTL (a fleet of accounts each costing a token refresh plus a
 * wham fetch) never lets the lock expire mid-run — an expiry would let a second
 * process start a concurrent refresh. Overrides exist so tests can drive the
 * renewal with a mock clock and a fast interval.
 */
export function acquireBackgroundRefreshLock(
  configPath: string,
  overrides?: { now?: () => number; renewIntervalMs?: number },
): Promise<BackgroundLockHandle | null> {
  return acquireRefreshFileLock({
    name: BACKGROUND_QUOTA_REFRESH_LOCK_NAME,
    ttlMs: BACKGROUND_QUOTA_REFRESH_LOCK_TTL_MS,
    path: configPath,
    renew: true,
    ...overrides,
  })
}

export function refreshQuotaInBackground(
  deps: RefreshAllQuotaDeps,
  refreshFn: RefreshAllQuotaFn = refreshAllQuota,
  acquireLock: BackgroundLockAcquirer = () =>
    acquireBackgroundRefreshLock(deps.paths.configPath),
): Promise<RefreshAllQuotaResult[]> {
  // The lock is advisory and only serializes the fetch across processes. A
  // clean null means another live owner is already refreshing, so this tick
  // skips — that process will update the shared sidebar file. A lock-mechanism
  // failure fails open and refreshes anyway, matching the pre-lock behavior
  // rather than stranding quota freshness on a broken lock.
  return claimBackgroundRefresh(deps, refreshFn, acquireLock)
}

function claimBackgroundRefresh(
  deps: RefreshAllQuotaDeps,
  refreshFn: RefreshAllQuotaFn,
  acquireLock: BackgroundLockAcquirer,
): Promise<RefreshAllQuotaResult[]> {
  return runUnderBackgroundLease(
    async () =>
      refreshFn({
        ...deps,
        respectBackoff: true,
        skipFresherThanMs: BACKGROUND_QUOTA_FRESHNESS_MS,
      }),
    acquireLock,
    [],
  )
}

/**
 * Runs one background pass while holding the cross-process
 * `bg-quota-refresh` lease. When another live process holds it, the pass is
 * skipped and `skipped` is returned: that process polls for everyone and
 * writes the shared files. A failure of the lock mechanism itself fails
 * open and runs the pass anyway.
 */
export async function runUnderBackgroundLease<T>(
  run: () => Promise<T>,
  acquireLock: BackgroundLockAcquirer,
  skipped: T,
): Promise<T> {
  let lock: BackgroundLockHandle | null | undefined
  try {
    lock = await acquireLock()
  } catch {
    lock = undefined
  }
  if (lock === null) return skipped
  try {
    return await run()
  } finally {
    await lock?.release().catch(() => {})
  }
}

/** What the background pass of a migrated install needs from the account pool. */
export interface PoolBackgroundSource {
  active(): Promise<boolean>
  refreshDueTokens(storage: AccountStorage | null): Promise<void>
  pollRows(
    storage: AccountStorage | null,
    options: { skipReadWithinMs?: number },
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>>
}

/**
 * The idle background pass of a migrated install, under the same lease as
 * the legacy pass: refresh every pool row's due token, then poll the quota
 * of every row whose reading is older than `BACKGROUND_QUOTA_FRESHNESS_MS`,
 * all through the pool source (the legacy refreshers never touch a pool
 * row). Resolves to the rows it polled, or to an empty list when another
 * process holds the lease.
 */
export function refreshPoolInBackground(
  source: PoolBackgroundSource,
  storage: AccountStorage | null,
  acquireLock: BackgroundLockAcquirer,
): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  return runUnderBackgroundLease(
    async () => {
      await source.refreshDueTokens(storage)
      return source.pollRows(storage, {
        skipReadWithinMs: BACKGROUND_QUOTA_FRESHNESS_MS,
      })
    },
    acquireLock,
    [],
  )
}

export class BackgroundQuotaRefresh {
  private readonly setIntervalFn: NonNullable<
    BackgroundQuotaRefreshOptions['setIntervalFn']
  >
  private readonly clearIntervalFn: NonNullable<
    BackgroundQuotaRefreshOptions['clearIntervalFn']
  >
  private readonly random: () => number
  private onError: ((error: unknown) => void) | undefined
  private run: (() => Promise<void>) | undefined
  private timer: TimerHandle | undefined
  private tickPromise: Promise<void> | undefined
  private stopped = false

  constructor(options: BackgroundQuotaRefreshOptions = {}) {
    this.setIntervalFn = options.setIntervalFn ?? setInterval
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
    this.random = options.random ?? Math.random
    this.onError = options.onError
  }

  start(
    run: () => Promise<void>,
    onError: ((error: unknown) => void) | undefined = this.onError,
  ): void {
    this.run = run
    this.onError = onError
    this.stopped = false
    if (this.timer) return

    const jitter = Math.round(
      (this.random() * 2 - 1) * BACKGROUND_QUOTA_REFRESH_JITTER_MS,
    )
    this.timer = this.setIntervalFn(() => {
      const currentRun = this.run
      if (this.stopped || !currentRun || this.tickPromise) return
      const tickPromise = currentRun()
        .catch((error) => {
          try {
            this.onError?.(error)
          } catch {}
        })
        .finally(() => {
          if (this.tickPromise === tickPromise) this.tickPromise = undefined
        })
      this.tickPromise = tickPromise
    }, BACKGROUND_QUOTA_REFRESH_INTERVAL_MS + jitter)
    if ('unref' in this.timer) this.timer.unref()
  }

  // Non-blocking stop: clears the timer and bars further ticks, but lets an
  // in-flight run finish naturally (it checks isStopped() before committing
  // sidebar state, so a stopping poller never writes a stale snapshot).
  stop(): void {
    this.stopped = true
    this.run = undefined
    if (!this.timer) return
    this.clearIntervalFn(this.timer)
    this.timer = undefined
  }

  isStopped(): boolean {
    return this.stopped
  }
}
