import { spyOn } from 'bun:test'
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import type * as fileLocks from '@cortexkit/common-auth/fs'
import { type ChildRun, CRASH_EXIT_CODE } from './pool-migration-harness.ts'

// Observe the defining module, not just its barrel: store and legacy readers
// import the same lock through different entry points. The spy delegates every
// call unchanged and is restored before another test can use the module.
const lockModule = (await import(
  new URL(
    'refresh-file-lock.js',
    import.meta.resolve('@cortexkit/common-auth/fs'),
  ).href
)) as Pick<typeof fileLocks, 'acquireRefreshFileLock'>

type Lease = { ownerId: string; expiresAt: number }
type EvictionMarker = { ownerId?: string; remainingMs: number }
export function readEvictionMarker(path: string): EvictionMarker | undefined {
  try {
    const mtimeMs = statSync(`${path}.evicting`).mtimeMs
    let ownerId: string | undefined
    try {
      ownerId = JSON.parse(
        readFileSync(`${path}.evicting/owner.json`, 'utf8'),
      ).ownerId
    } catch {
      // A crash may interrupt the mkdir before its owner file is written.
    }
    // The file-lock implementation fences renewal and stale-lock eviction
    // with a marker whose independent lifetime is five seconds.
    return { ownerId, remainingMs: mtimeMs + 5_000 - Date.now() }
  } catch {
    return undefined
  }
}
export function readLease(path: string): Lease | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Lease>
    if (
      typeof value.ownerId === 'string' &&
      typeof value.expiresAt === 'number'
    )
      return value as Lease
  } catch {
    // An absent or partially written lease is not evidence of a dead holder.
  }
}

export type LockTiming = {
  name: string
  path: string
  offsetMs: number
  waitMs?: number
  attempts: number
  contended: boolean
  holder?: Lease
  holderRemainingMs?: number
  marker?: EvictionMarker
  ownerId?: string
}

/**
 * Call only after the sole writer of an isolated crash fixture has exited.
 * Expire, rather than delete, its leases and renewal markers so the survivor
 * still exercises stale-lock recovery without waiting for a dead process.
 */
export function expireDeadChildLocks(child: ChildRun, timings: LockTiming[]) {
  if (child.code !== CRASH_EXIT_CODE)
    throw new Error('cannot expire locks before the expected crash exit')
  for (const entry of timings) {
    const lease = readLease(entry.path)
    if (!lease || lease.ownerId !== entry.ownerId) continue
    writeFileSync(entry.path, `${JSON.stringify({ ...lease, expiresAt: 0 })}\n`)
    // Renewal can be interrupted after creating its independent five-second
    // eviction marker. An expired lease alone cannot bypass a fresh marker.
    if (readEvictionMarker(entry.path))
      utimesSync(`${entry.path}.evicting`, 0, 0)
  }
}

/** Measure real lock attempts without changing clocks, retries or lease TTLs. */
export function observeMigrationLocks() {
  const started = performance.now()
  const timings: LockTiming[] = []
  const pending = new Map<string, LockTiming>()
  const acquire = lockModule.acquireRefreshFileLock
  const spy = spyOn(lockModule, 'acquireRefreshFileLock').mockImplementation(
    async (options) => {
      const path = `${options.path}.${options.name}.lock`
      let timing = pending.get(path)
      if (!timing) {
        timing = {
          name: options.name,
          path,
          offsetMs: performance.now() - started,
          attempts: 0,
          contended: false,
        }
        timings.push(timing)
        pending.set(path, timing)
      }
      timing.attempts++
      const entry = timing
      const lock = await acquire({
        ...options,
        onContended: () => {
          if (!entry.contended) {
            entry.contended = true
            entry.holder = readLease(path)
            if (entry.holder)
              entry.holderRemainingMs = entry.holder.expiresAt - Date.now()
          }
          options.onContended?.()
        },
      })
      if (lock) {
        entry.waitMs = performance.now() - started - entry.offsetMs
        entry.ownerId = lock.ownerId
        pending.delete(path)
      } else if (!entry.contended) {
        // A fresh eviction marker refuses acquisition without onContended:
        // it fences a renewal/steal even when the lock lease is already stale.
        entry.contended = true
        entry.holder = readLease(path)
        if (entry.holder)
          entry.holderRemainingMs = entry.holder.expiresAt - Date.now()
      }
      if (!lock && entry.attempts === 1) entry.marker = readEvictionMarker(path)
      return lock
    },
  )
  return {
    snapshot: () =>
      timings.map((entry) => ({
        ...entry,
        waitMs: entry.waitMs ?? performance.now() - started - entry.offsetMs,
        inFlight: entry.waitMs === undefined,
      })),
    restore: () => spy.mockRestore(),
  }
}
