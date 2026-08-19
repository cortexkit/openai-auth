import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAccountStoragePath } from './account-paths'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

// A concurrent contender renaming the freshly-created eviction-marker directory
// away surfaces the vanished parent differently per platform: ENOENT on Linux,
// EINVAL or ENOTDIR on macOS/APFS. All three mean the marker is no longer ours
// to hold — a lost race the caller should retry, not a fatal lock error.
export function isLostMarkerRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'EINVAL' || code === 'ENOTDIR'
}

export async function acquireRefreshFileLock(options: {
  name: string
  ttlMs: number
  path?: string
  now?: () => number
  renew?: boolean
  renewIntervalMs?: number
  onStep?: (
    step:
      | 'stale-marker-stat'
      | 'stale-marker-claimed'
      | 'stale-lock-confirmed'
      | 'eviction-marker-acquired'
      | 'renewal-owner-confirmed'
      | 'renewal-marker-unavailable'
      | 'renewal-write-fenced'
      | 'renewal-write-ready'
      | 'relinquish-read'
      | 'renewal-finished'
      | 'release-owner-confirmed',
  ) => void | Promise<void>
}): Promise<{ release: () => Promise<void> } | null> {
  const accountPath = options.path ?? getAccountStoragePath()
  const lockPath = `${accountPath}.${options.name}.lock`
  const legacyOwnerPath = join(lockPath, 'owner.json')
  const ownerId = randomUUID()
  const now = options.now ?? Date.now
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let released = false
  let renewalInFlight: Promise<void> | null = null
  // Fencing-token eviction: a directory-based marker (mkdir O_EXCL) serializes
  // destructive removal and generation-sensitive owner mutations. The marker
  // holds an owner file so ownership survives a stale-marker recovery rename:
  // the recovering contender renames the stale directory, then must re-check
  // ownership before acting — preventing the 3rd interleaving where a stale
  // observer renames the FRESH marker the mkdir-winner created.
  const evictPath = `${lockPath}.evicting`
  const evictOwnerPath = join(evictPath, 'owner.json')
  const evictOwnerId = randomUUID()
  const EVICT_TTL = 5_000
  const MAX_STEAL_ATTEMPTS = 8

  async function readOwner() {
    try {
      return JSON.parse(await readFile(lockPath, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EISDIR') throw error
      return JSON.parse(await readFile(legacyOwnerPath, 'utf8'))
    }
  }

  async function writeOwner() {
    await writeFile(
      lockPath,
      `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  async function tryAcquire() {
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EISDIR') return false
      if (code === 'ENOENT') {
        // Reboots can clear runtime temp directories before the next lock acquisition.
        await mkdir(dirname(lockPath), { recursive: true })
        try {
          await writeFile(
            lockPath,
            `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
            { encoding: 'utf8', mode: 0o600, flag: 'wx' },
          )
          return true
        } catch (retryError) {
          const retryCode = (retryError as NodeJS.ErrnoException).code
          if (retryCode === 'EEXIST' || retryCode === 'EISDIR') return false
          throw retryError
        }
      }
      throw error
    }
  }

  async function backoff() {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.floor(Math.random() * 4)),
    )
  }

  async function lockIsLive() {
    try {
      const currentOwner = await readOwner()
      return Number(currentOwner?.expiresAt) > now()
    } catch {
      try {
        const current = await stat(lockPath)
        return current.mtimeMs + options.ttlMs > now()
      } catch {
        // Lock doesn't exist — safe to acquire.
        return false
      }
    }
  }

  // Fail-closed: any read error means we do NOT own the marker.
  async function ownsEvictionMarker() {
    try {
      const owner = JSON.parse(await readFile(evictOwnerPath, 'utf8'))
      return owner?.ownerId === evictOwnerId
    } catch {
      return false
    }
  }

  async function releaseEvictionMarker() {
    if (await ownsEvictionMarker()) {
      await rm(evictPath, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function tryAcquireEvictionMarker() {
    await mkdir(evictPath)
    try {
      await writeFile(
        evictOwnerPath,
        `${JSON.stringify({ ownerId: evictOwnerId, createdAt: now() })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
    } catch (error) {
      // A competing contender can rename our just-created marker directory
      // away between the mkdir above and this write (the stale-marker steal
      // path below does exactly that). That is a lost race, not a failure, so
      // report it as such and let the caller back off and retry rather than
      // failing the whole lock acquisition.
      if (isLostMarkerRaceError(error)) return false
      await releaseEvictionMarker()
      throw error
    }
    if (options.onStep) await options.onStep('eviction-marker-acquired')
    return true
  }

  async function recoverStaleEvictionMarker(): Promise<
    'fresh' | 'missing' | 'recovered'
  > {
    let evictStat: Awaited<ReturnType<typeof stat>>
    try {
      evictStat = await stat(evictPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    if (evictStat.mtimeMs + EVICT_TTL > now()) return 'fresh'

    if (options.onStep) await options.onStep('stale-marker-stat')
    const claimedPath = `${evictPath}.${randomUUID()}`
    try {
      await rename(evictPath, claimedPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    if (options.onStep) await options.onStep('stale-marker-claimed')
    await rm(claimedPath, { recursive: true, force: true }).catch(() => {})
    return 'recovered'
  }

  async function withEvictionMarker(action: () => Promise<void>) {
    try {
      if (!(await tryAcquireEvictionMarker())) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }

    try {
      await action()
    } finally {
      await releaseEvictionMarker()
    }
    return true
  }

  // Marker loss after a write may mean our record replaced a successor's.
  // Delete only a record still owned by us; a concurrent successor write can
  // then yield zero winners, never two.
  async function relinquishLockAfterMarkerLoss() {
    for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
      if (options.onStep) await options.onStep('relinquish-read')
      let owner: { ownerId?: string } | undefined
      try {
        owner = await readOwner()
      } catch {
        return
      }
      if (owner?.ownerId !== ownerId) return
      try {
        await rm(lockPath, { recursive: true, force: true })
        return
      } catch {
        await backoff()
      }
    }
  }

  function scheduleRenewal() {
    if (!options.renew || released) return
    const intervalMs =
      options.renewIntervalMs ?? Math.max(1_000, Math.floor(options.ttlMs / 3))
    renewTimer = setRefreshLockRenewalTimeout(() => {
      const renewal = (async () => {
        let shouldReschedule = !released
        try {
          const markerAcquired = await withEvictionMarker(async () => {
            const owner = await readOwner()
            const currentNow = now()
            if (released || owner?.ownerId !== ownerId) {
              shouldReschedule = false
              return
            }
            // An expired lease is no longer ours to extend; a contender may
            // already be eligible to acquire it.
            if (Number(owner?.expiresAt) <= currentNow) {
              shouldReschedule = false
              return
            }
            if (options.onStep) await options.onStep('renewal-owner-confirmed')
            if (released) {
              shouldReschedule = false
              return
            }
            if (!(await ownsEvictionMarker())) return
            if (options.onStep) await options.onStep('renewal-write-fenced')
            if (released) {
              shouldReschedule = false
              return
            }
            if (!(await ownsEvictionMarker())) return
            if (options.onStep) await options.onStep('renewal-write-ready')
            await writeOwner()
            if (!(await ownsEvictionMarker())) {
              // Marker read errors fail closed: prompt relinquish avoids ambiguity
              // instead of waiting for TTL; both outcomes keep zero or one winner.
              shouldReschedule = false
              await relinquishLockAfterMarkerLoss()
              return
            }
          })
          if (!markerAcquired && options.onStep) {
            await options.onStep('renewal-marker-unavailable')
          }
        } catch {
          // Transient marker and filesystem failures retry on the next interval.
        } finally {
          if (options.onStep) {
            try {
              await options.onStep('renewal-finished')
            } catch {
              // Test seams must not turn an otherwise-safe renewal into a rejection.
            }
          }
          if (shouldReschedule && !released) scheduleRenewal()
        }
      })()
      renewalInFlight = renewal
      void renewal.finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null
      })
    }, intervalMs)
    if ('unref' in renewTimer) renewTimer.unref()
  }

  let acquired = await tryAcquire()
  if (!acquired) {
    for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
      acquired = await tryAcquire()
      if (acquired) break
      if (await lockIsLive()) return null

      try {
        if (!(await tryAcquireEvictionMarker())) {
          await backoff()
          continue
        }
      } catch (evictError) {
        const code = (evictError as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw evictError

        const recovered = await recoverStaleEvictionMarker()
        if (recovered === 'fresh') return null
        await backoff()
        continue
      }

      try {
        if (await lockIsLive()) return null
        // Fence check 1: verify we still own the marker before acting on the
        // stale-lock-confirmed decision.
        if (!(await ownsEvictionMarker())) return null
        if (options.onStep) await options.onStep('stale-lock-confirmed')
        // Fence check 2: re-verify ownership after the seam (another contender
        // may have renamed our fresh marker while we were paused here).
        if (!(await ownsEvictionMarker())) return null
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        // Fence check 3: re-verify ownership after removing the stale lock.
        if (!(await ownsEvictionMarker())) return null
        acquired = await tryAcquire()
        if (!acquired) return null
        // Fence check 4: re-verify ownership after acquiring the lock. If the
        // marker was stolen between tryAcquire and this check, release the
        // just-acquired lock and return null (fail-closed).
        if (!(await ownsEvictionMarker())) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {})
          acquired = false
          return null
        }
        break
      } finally {
        await releaseEvictionMarker()
      }
    }
  }

  if (!acquired) return null

  scheduleRenewal()

  return {
    release: async () => {
      released = true
      if (renewTimer) {
        clearRefreshLockRenewalTimeout(renewTimer)
        renewTimer = null
      }
      await renewalInFlight
      for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
        try {
          const markerAcquired = await withEvictionMarker(async () => {
            const owner = await readOwner()
            if (owner?.ownerId !== ownerId) return
            if (options.onStep) await options.onStep('release-owner-confirmed')
            if (!(await ownsEvictionMarker())) return
            await rm(lockPath, { recursive: true, force: true }).catch(() => {})
          })
          if (markerAcquired) return
          await recoverStaleEvictionMarker()
        } catch {
          return
        }
        await backoff()
      }
      // Do not delete by pathname without the marker: bounded retries leave the
      // lease to expire rather than risking removal of a successor's lock.
    },
  }
}
