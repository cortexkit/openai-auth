// Runs the account-pool migration (`pool-migration.ts`) and later adoptions
// of host-slot logins in the background of a plugin process.
//
// What runs when:
// - `start()`, called by the auth loader once this process's heartbeat is
//   written, runs the migration once, without being awaited by anything.
// - A migration that cannot run yet (an older openai-auth process is alive,
//   `deferred`) or that ended retryably (`retry`, `error`, a throw) is tried
//   again on an unref'd timer: one minute first, doubling to fifteen minutes,
//   each delay jittered.
// - Once the install is migrated, the same timer keeps running every fifteen
//   minutes (jittered) and runs an adoption each time, so a credential the
//   host writes into its login slot while no request arrives still moves into
//   the pool. A retryable adoption brings the timer back to the short delays.
// - `requestAdoption()` runs one adoption now: after a login through the
//   plugin's own auth methods, and (through `noticeRealSlot`) when a request
//   finds a real credential in the slot of a migrated install.
//
// - While `paused` reports true (the host is in vault mode: enrolled with the
//   Claustrum vault), neither runs: the slot and the account files are left
//   exactly as they are. The timer keeps checking every minute (jittered),
//   so once the host disconnects the migration or adoption runs then; a
//   request that finds a real login in the slot afterwards asks for one at
//   once.
//
// Every run goes through one queue, so a migration and an adoption never run
// at once in this process, and an adoption asked for while one is already
// waiting or running joins it instead of starting another. Across processes
// the runs serialise on the migration's own run lock. Nothing here is awaited
// by a request, and nothing here throws: a failure is logged at warn.

import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { createLogger } from '../logger'
import { POOL_LOGIN_REQUIRED_MESSAGE } from './pool-main.ts'
import {
  adoptHostSlotLogin,
  type HostSlotAdapter,
  migrateToPool,
  type PoolMigrationDeps,
  type PoolMigrationLogger,
  type PoolTransferOutcome,
} from './pool-migration.ts'
import { migrationFenceOpen, type VersionFenceResult } from './version-fence.ts'

/** First retry delay, and the step the backoff doubles from. */
export const POOL_RETRY_BASE_MS = 60_000
/** Longest retry delay, and the adoption interval once migrated. */
export const POOL_RETRY_MAX_MS = 15 * 60_000

export interface PoolLifecycleTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: PoolLifecycleTimers = {
  set(run, ms) {
    const handle = setTimeout(run, ms)
    // A pending retry must never keep the process alive on its own.
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface PoolLifecycleDeps {
  /** Read at every run, so it follows the configured store path. */
  paths: () => AccountPaths
  slot: HostSlotAdapter
  /** This build's version, for the version fence. */
  version: string
  log?: PoolMigrationLogger
  /** Defaults to `migrationFenceOpen` for `version`. */
  fence?: () => Promise<VersionFenceResult>
  migrate?: typeof migrateToPool
  adopt?: typeof adoptHostSlotLogin
  timers?: PoolLifecycleTimers
  random?: () => number
  /** Passed through to every migration and adoption run (tests). */
  runDeps?: Partial<PoolMigrationDeps>
  /**
   * True while no migration or adoption may run: the host is in vault mode,
   * which writes no local account file. Read before every run.
   */
  paused?: () => boolean
}

export interface PoolLifecycle {
  /** Starts the background migration; later calls do nothing. */
  start(): void
  /**
   * Runs one adoption of the host slot, joining one already waiting or
   * running. Resolves when it has ended; never rejects.
   */
  requestAdoption(): Promise<void>
  /**
   * For the request path: the slot holds a real credential (not the
   * placeholder, not empty). On a migrated install this schedules one
   * adoption per distinct refresh token and returns at once; otherwise it
   * does nothing.
   */
  noticeRealSlot(refreshToken: string): void
  /**
   * Logs once that OpenCode's login slot holds this plugin's placeholder while
   * this store has no `main` row: the login was moved into some other store.
   */
  noticePlaceholderWithoutMain(): void
  /** Stops the timer; a run already under way finishes on its own. */
  dispose(): void
  /** Resolves once no run is waiting or running (tests). */
  idle(): Promise<void>
  /** Whether this process has seen the install migrated. */
  migrated(): boolean
}

/** Outcomes after which the install counts as migrated. */
function marksMigrated(outcome: PoolTransferOutcome): boolean {
  return (
    outcome.status === 'completed' ||
    outcome.status === 'already-migrated' ||
    outcome.status === 'nothing-to-import' ||
    outcome.status === 'ambiguous'
  )
}

/** Outcomes that call for another attempt soon. */
function wantsRetry(outcome: PoolTransferOutcome): boolean {
  return (
    outcome.status === 'deferred' ||
    outcome.status === 'retry' ||
    outcome.status === 'error'
  )
}

export function createPoolLifecycle(deps: PoolLifecycleDeps): PoolLifecycle {
  const log = deps.log ?? createLogger('pool-migration')
  const timers = deps.timers ?? realTimers
  const random = deps.random ?? Math.random
  const migrate = deps.migrate ?? migrateToPool
  const adopt = deps.adopt ?? adoptHostSlotLogin
  const fence =
    deps.fence ?? (() => migrationFenceOpen({ currentVersion: deps.version }))

  let started = false
  let stopped = false
  let isMigrated = false
  let failures = 0
  let timer: unknown
  let queue: Promise<void> = Promise.resolve()
  let pendingAdoption: Promise<void> | undefined
  let lastNoticedRefresh: string | undefined
  // Logged once per set of blocking processes, not on every retry.
  let lastAdoptionBlockers: string | undefined
  let missingMainLogged = false

  function noticePlaceholderWithoutMain(): void {
    if (missingMainLogged) return
    missingMainLogged = true
    log.warn(POOL_LOGIN_REQUIRED_MESSAGE, {
      reason: 'placeholder-without-main',
    })
  }

  const runDeps = (): PoolMigrationDeps => ({
    paths: deps.paths(),
    slot: deps.slot,
    log,
    ...deps.runDeps,
  })

  /** Runs `task` after everything queued before it; never rejects. */
  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = queue.then(task).catch((error: unknown) => {
      log.warn('account pool background run failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    queue = next
    return next
  }

  function schedule(ms: number): void {
    if (stopped) return
    if (timer !== undefined) timers.clear(timer)
    timer = timers.set(() => {
      timer = undefined
      void enqueue(tick)
    }, ms)
  }

  /** The next delay after a retryable outcome: 1, 2, 4, 8, 15, 15 … minutes. */
  function retryDelay(): number {
    const base = Math.min(
      POOL_RETRY_BASE_MS * 2 ** Math.min(failures, 10),
      POOL_RETRY_MAX_MS,
    )
    failures++
    return jitter(base)
  }

  // Up to a fifth shorter, so processes started together drift apart.
  const jitter = (ms: number) => Math.round(ms * (1 - 0.2 * random()))

  /**
   * True, and the next check scheduled, while runs are paused. The check
   * keeps the short base delay (no backoff), so a disconnect is noticed
   * within about a minute.
   */
  function pausedNow(): boolean {
    if (!deps.paused?.()) return false
    schedule(jitter(POOL_RETRY_BASE_MS))
    return true
  }

  async function runMigration(): Promise<void> {
    if (pausedNow()) return
    let outcome: PoolTransferOutcome
    try {
      outcome = await migrate({ ...runDeps(), fence })
    } catch (error) {
      log.warn('account pool migration failed; it will be tried again', {
        error: error instanceof Error ? error.message : String(error),
      })
      schedule(retryDelay())
      return
    }
    if (outcome.status === 'refused') {
      if (outcome.reason === 'placeholder-without-main')
        noticePlaceholderWithoutMain()
      // Signing in for this setup, or pointing it at the store that holds the
      // login, resolves the refusal. Stay unmigrated and check again at the
      // quiet adoption interval, without repeating the warning.
      schedule(jitter(POOL_RETRY_MAX_MS))
      return
    }
    if (marksMigrated(outcome)) {
      isMigrated = true
      failures = 0
      if (outcome.status === 'completed')
        log.info('account pool migration completed', { rowId: outcome.rowId })
      // A login may have landed in the slot while no process could adopt it
      // (or during this run, after its fence read): look once now.
      await runAdoption()
      return
    }
    if (wantsRetry(outcome)) {
      if (outcome.status !== 'deferred')
        log.warn('account pool migration will be tried again', { outcome })
      schedule(retryDelay())
    }
  }

  async function runAdoption(): Promise<void> {
    if (pausedNow()) return
    let outcome: PoolTransferOutcome
    try {
      // Adoption copies a slot token into the pool the same way migration
      // does, so it waits behind the same fence: an older process that does
      // not know the pending-transfer record could refresh the slot token
      // between the copy and the placeholder. Until it exits, the login is
      // served from the slot as before.
      const gate = await fence()
      if (!gate.open) {
        const key = JSON.stringify(gate.blockers)
        if (key !== lastAdoptionBlockers) {
          lastAdoptionBlockers = key
          log.info('host login adoption waits for older plugin versions', {
            blockers: gate.blockers,
          })
        }
        schedule(retryDelay())
        return
      }
      outcome = await adopt(runDeps())
    } catch (error) {
      log.warn('adopting the host login into the account pool failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      schedule(retryDelay())
      return
    }
    if (outcome.status === 'not-migrated') {
      // Only possible before this process has seen the migration; the
      // migration's own run adopts afterwards.
      return
    }
    if (outcome.status === 'slot-read-only') return
    // Every other outcome means the install is migrated.
    isMigrated = true
    if (outcome.status === 'completed')
      log.info('host login adopted into the account pool', {
        rowId: outcome.rowId,
        operation: outcome.operation,
      })
    if (wantsRetry(outcome)) {
      log.warn('host login adoption will be tried again', { outcome })
      schedule(retryDelay())
      return
    }
    failures = 0
    if (isMigrated) schedule(jitter(POOL_RETRY_MAX_MS))
  }

  async function tick(): Promise<void> {
    if (stopped) return
    if (isMigrated) await runAdoption()
    else await runMigration()
  }

  function requestAdoption(): Promise<void> {
    if (pendingAdoption) return pendingAdoption
    const run = enqueue(async () => {
      // Taken off before the run starts: a request made while it runs
      // starts the next one, since its slot read may already be behind.
      pendingAdoption = undefined
      if (!stopped) {
        // A new login in the slot also lets a refused migration proceed: it
        // moves that login into this store as `main`. Adoption only works on
        // a store that has already migrated, so run the migration here.
        if (isMigrated) await runAdoption()
        else await runMigration()
      }
    })
    pendingAdoption = run
    return run
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      void enqueue(runMigration)
    },
    requestAdoption,
    noticePlaceholderWithoutMain,
    noticeRealSlot(refreshToken) {
      if (!isMigrated || stopped || refreshToken === lastNoticedRefresh) return
      lastNoticedRefresh = refreshToken
      void requestAdoption()
    },
    dispose() {
      stopped = true
      if (timer !== undefined) timers.clear(timer)
      timer = undefined
    },
    idle: async () => {
      // A run can queue another (a migration its adoption); wait them out.
      for (;;) {
        const current = queue
        await current
        if (current === queue) return
      }
    },
    migrated: () => isMigrated,
  }
}
