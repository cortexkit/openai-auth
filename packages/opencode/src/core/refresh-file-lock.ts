import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

export const ACCOUNT_FILE_NAME = 'openai-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'openai-auth-state.json'

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

// A concurrent contender renaming the freshly-created eviction-marker directory
// away surfaces the vanished parent differently per platform: ENOENT on Linux,
// EINVAL or ENOTDIR on macOS/APFS. All three mean the marker is no longer ours
// to hold — a lost race the caller should retry, not a fatal lock error.
export function isLostMarkerRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'EINVAL' || code === 'ENOTDIR'
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_OPENAI_AUTH_FILE?.trim() ||
    join(getConfigDir(), ACCOUNT_FILE_NAME)
  )
}

export function getAccountStatePath(configPath = getAccountStoragePath()) {
  const explicit = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE?.trim()
  if (explicit) return explicit
  return configPath.endsWith(ACCOUNT_FILE_NAME)
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
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
      | 'eviction-marker-acquired',
  ) => void | Promise<void>
}): Promise<{ release: () => Promise<void> } | null> {
  const accountPath = options.path ?? getAccountStoragePath()
  const lockPath = `${accountPath}.${options.name}.lock`
  const legacyOwnerPath = join(lockPath, 'owner.json')
  const ownerId = randomUUID()
  const now = options.now ?? Date.now
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let released = false

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
      throw error
    }
  }

  function scheduleRenewal() {
    if (!options.renew || released) return
    const intervalMs =
      options.renewIntervalMs ?? Math.max(1_000, Math.floor(options.ttlMs / 3))
    renewTimer = setRefreshLockRenewalTimeout(() => {
      void (async () => {
        try {
          const owner = await readOwner()
          const currentNow = now()
          if (
            released ||
            owner?.ownerId !== ownerId ||
            Number(owner?.expiresAt) <= currentNow
          ) {
            return
          }
          await writeOwner()
          scheduleRenewal()
        } catch {
          // If renewal fails, contenders will wait until the last written expiry.
        }
      })()
    }, intervalMs)
    if ('unref' in renewTimer) renewTimer.unref()
  }

  let acquired = await tryAcquire()
  if (!acquired) {
    // Fencing-token eviction: a directory-based marker (mkdir O_EXCL) serializes
    // destructive removal to one contender at a time. The marker holds an owner
    // file so ownership survives a stale-marker recovery rename: the recovering
    // contender renames the stale directory, then must re-check ownership before
    // acting — preventing the 3rd interleaving where a stale observer renames the
    // FRESH marker the mkdir-winner created.
    const evictPath = `${lockPath}.evicting`
    const evictOwnerPath = join(evictPath, 'owner.json')
    const evictOwnerId = randomUUID()
    const EVICT_TTL = 5_000
    const MAX_STEAL_ATTEMPTS = 8

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
      await options.onStep?.('eviction-marker-acquired')
      return true
    }

    async function releaseEvictionMarker() {
      if (await ownsEvictionMarker()) {
        await rm(evictPath, { recursive: true, force: true }).catch(() => {})
      }
    }

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

        let evictStat: Awaited<ReturnType<typeof stat>>
        try {
          evictStat = await stat(evictPath)
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            await backoff()
            continue
          }
          throw statError
        }
        if (evictStat.mtimeMs + EVICT_TTL > now()) return null

        await options.onStep?.('stale-marker-stat')
        const claimedPath = `${evictPath}.${randomUUID()}`
        try {
          await rename(evictPath, claimedPath)
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
            await backoff()
            continue
          }
          throw renameError
        }
        await options.onStep?.('stale-marker-claimed')
        await rm(claimedPath, { recursive: true, force: true }).catch(() => {})
        await backoff()
        continue
      }

      try {
        if (await lockIsLive()) return null
        // Fence check 1: verify we still own the marker before acting on the
        // stale-lock-confirmed decision.
        if (!(await ownsEvictionMarker())) return null
        await options.onStep?.('stale-lock-confirmed')
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
      try {
        const owner = await readOwner()
        if (owner?.ownerId !== ownerId) return
      } catch {
        return
      }
      await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    },
  }
}
