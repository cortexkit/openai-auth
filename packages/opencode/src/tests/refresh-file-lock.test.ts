import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-refresh-file-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolvesWithin(promise: Promise<void>, ms: number) {
  return await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

async function readLockOwner(lockPath: string) {
  return JSON.parse(await readFile(lockPath, 'utf8')) as {
    ownerId: string
    expiresAt: number
  }
}

describe('acquireRefreshFileLock', () => {
  it('creates a missing parent directory before acquiring the lock', async () => {
    const path = join(dir, 'missing-sub', 'state.json')
    const lockPath = `${path}.missing-parent.lock`

    const lock = await acquireRefreshFileLock({
      name: 'missing-parent',
      path,
      ttlMs: 5_000,
    })

    expect(lock).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)

    await lock?.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('allows only one contender when the parent directory is missing', async () => {
    const path = join(dir, 'missing-race', 'state.json')
    const options = {
      name: 'missing-parent-contention',
      path,
      ttlMs: 5_000,
    }

    const contenders = await Promise.all([
      acquireRefreshFileLock(options),
      acquireRefreshFileLock(options),
    ])
    const winners = contenders.filter((lock) => lock !== null)

    expect(winners).toHaveLength(1)

    await winners[0]?.release()
    const retry = await acquireRefreshFileLock(options)
    expect(retry).not.toBeNull()
    await retry?.release()
  })

  it('does not let a stalled renewal overwrite a successor that stole its marker', async () => {
    const path = join(dir, 'renewal-race.json')
    const name = 'renewal-race'
    const lockPath = `${path}.${name}.lock`
    const renewalConfirmed = deferred()
    const releaseRenewal = deferred()
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-owner-confirmed') {
          renewalConfirmed.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await withTimeout(renewalConfirmed.promise, 1_000)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRenewal.resolve()
    await withTimeout(renewalFinished.promise, 1_000)

    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await first?.release()
    await successor?.release()
  })

  it('does not let a stalled release remove a successor that stole its marker', async () => {
    const path = join(dir, 'release-race.json')
    const name = 'release-race'
    const lockPath = `${path}.${name}.lock`
    const releaseConfirmed = deferred()
    const releaseRemoval = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      onStep: async (step) => {
        if (step === 'release-owner-confirmed') {
          releaseConfirmed.resolve()
          await releaseRemoval.promise
        }
      },
    })
    expect(first).not.toBeNull()

    const firstRelease = first!.release()
    await withTimeout(releaseConfirmed.promise, 1_000)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRemoval.resolve()
    await firstRelease

    expect(existsSync(lockPath)).toBe(true)
    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await successor?.release()
  })

  it('waits for an in-flight renewal before release can remove the lock', async () => {
    const path = join(dir, 'release-renewal-race.json')
    const name = 'release-renewal-race'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteFenced = deferred()
    const releaseRenewal = deferred()
    const renewalFinished = deferred()
    const currentNow = Date.now()

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-fenced') {
          renewalWriteFenced.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await withTimeout(renewalWriteFenced.promise, 1_000)
    const release = first!.release()
    releaseRenewal.resolve()
    await withTimeout(renewalFinished.promise, 1_000)
    await release

    expect(existsSync(lockPath)).toBe(false)
  })

  it('re-checks ownership after the renewal write seam before writing', async () => {
    const path = join(dir, 'renewal-write-seam-race.json')
    const name = 'renewal-write-seam-race'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteFenced = deferred()
    const releaseRenewal = deferred()
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-fenced') {
          renewalWriteFenced.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await withTimeout(renewalWriteFenced.promise, 1_000)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRenewal.resolve()
    await withTimeout(renewalFinished.promise, 1_000)

    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await first?.release()
    await successor?.release()
  })

  it('relinquishes the lock when its marker is stolen after the final renewal check', async () => {
    const path = join(dir, 'renewal-post-write-race.json')
    const name = 'renewal-post-write-race'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteReady = deferred()
    const releaseRenewal = deferred()
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready') {
          renewalWriteReady.resolve()
          await releaseRenewal.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await withTimeout(renewalWriteReady.promise, 1_000)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()

    releaseRenewal.resolve()
    await withTimeout(renewalFinished.promise, 1_000)

    expect(existsSync(lockPath)).toBe(false)
    await first?.release()
    await successor?.release()
  })

  it('preserves a successor record during post-write relinquish', async () => {
    const path = join(dir, 'renewal-relinquish-successor.json')
    const name = 'renewal-relinquish-successor'
    const lockPath = `${path}.${name}.lock`
    const renewalWriteReady = deferred()
    const relinquishRead = deferred()
    const allowRelinquishRead = deferred()
    const releaseRenewal = deferred()
    const renewalFinished = deferred()
    const start = Date.now()
    let currentNow = start

    const first = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 1,
      onStep: async (step) => {
        if (step === 'renewal-write-ready') {
          renewalWriteReady.resolve()
          await releaseRenewal.promise
        }
        if (step === 'relinquish-read') {
          relinquishRead.resolve()
          await allowRelinquishRead.promise
        }
        if (step === 'renewal-finished') renewalFinished.resolve()
      },
    })
    expect(first).not.toBeNull()

    await withTimeout(renewalWriteReady.promise, 1_000)
    currentNow = start + 10_000
    const successor = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 100,
      now: () => currentNow,
    })
    expect(successor).not.toBeNull()
    const successorOwner = await readLockOwner(lockPath)

    releaseRenewal.resolve()
    await withTimeout(relinquishRead.promise, 1_000)
    await writeFile(lockPath, `${JSON.stringify(successorOwner)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    allowRelinquishRead.resolve()
    await withTimeout(renewalFinished.promise, 1_000)

    expect(existsSync(lockPath)).toBe(true)
    expect(await readLockOwner(lockPath)).toEqual(successorOwner)
    await first?.release()
    await successor?.release()
  })

  it('reschedules after marker contention and advances the lease', async () => {
    const path = join(dir, 'renewal-contention.json')
    const name = 'renewal-contention'
    const lockPath = `${path}.${name}.lock`
    const markerPath = `${lockPath}.evicting`
    const markerUnavailable = deferred()
    const renewed = deferred()
    const start = Date.now()
    let currentNow = start
    let sawRenewalWrite = false

    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 10_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 10,
      onStep: (step) => {
        if (step === 'renewal-marker-unavailable') markerUnavailable.resolve()
        if (step === 'renewal-write-fenced') sawRenewalWrite = true
        if (step === 'renewal-finished' && sawRenewalWrite) renewed.resolve()
      },
    })
    expect(lock).not.toBeNull()
    const before = await readLockOwner(lockPath)
    await mkdir(markerPath)

    await withTimeout(markerUnavailable.promise, 1_000)
    currentNow = start + 100
    await rm(markerPath, { recursive: true, force: true })
    expect(await resolvesWithin(renewed.promise, 500)).toBe(true)

    const after = await readLockOwner(lockPath)
    expect(after.ownerId).toBe(before.ownerId)
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)
    await lock?.release()
  })

  it('reschedules after a renewal marker failure throws', async () => {
    const path = join(dir, 'renewal-throw.json')
    const name = 'renewal-throw'
    const lockPath = `${path}.${name}.lock`
    const injectedFailure = deferred()
    const renewed = deferred()
    const start = Date.now()
    let currentNow = start
    let injected = false
    let sawRenewalWrite = false

    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: 10_000,
      now: () => currentNow,
      renew: true,
      renewIntervalMs: 10,
      onStep: (step) => {
        if (step === 'renewal-owner-confirmed' && !injected) {
          injected = true
          injectedFailure.resolve()
          throw new Error('injected renewal marker failure')
        }
        if (step === 'renewal-write-fenced') sawRenewalWrite = true
        if (step === 'renewal-finished' && sawRenewalWrite) renewed.resolve()
      },
    })
    expect(lock).not.toBeNull()
    const before = await readLockOwner(lockPath)

    await withTimeout(injectedFailure.promise, 1_000)
    currentNow = start + 100
    expect(await resolvesWithin(renewed.promise, 500)).toBe(true)

    const after = await readLockOwner(lockPath)
    expect(after.ownerId).toBe(before.ownerId)
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)
    await lock?.release()
  })

  it('retries release after recovering a stale marker', async () => {
    const path = join(dir, 'release-stale-marker.json')
    const name = 'release-stale-marker'
    const lockPath = `${path}.${name}.lock`
    const markerPath = `${lockPath}.evicting`
    const lock = await acquireRefreshFileLock({ name, path, ttlMs: 10_000 })
    expect(lock).not.toBeNull()

    await mkdir(markerPath)
    await writeFile(
      join(markerPath, 'owner.json'),
      `${JSON.stringify({ ownerId: 'stale-marker', createdAt: 0 })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    const staleAt = new Date(Date.now() - 10_000)
    await utimes(markerPath, staleAt, staleAt)

    await lock?.release()

    expect(existsSync(lockPath)).toBe(false)
  })

  it('elects one owner across 512 plain stale-lock contentions', async () => {
    // Deterministic seam tests cover the race proofs; this is ordinary contention smoke.
    const path = join(dir, 'plain-contention.json')
    const name = 'plain-contention'
    const lockPath = `${path}.${name}.lock`

    for (let round = 0; round < 512; round++) {
      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: 0 })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      const contenders = await Promise.all([
        acquireRefreshFileLock({ name, path, ttlMs: 1_000 }),
        acquireRefreshFileLock({ name, path, ttlMs: 1_000 }),
      ])
      const winners = contenders.filter((lock) => lock !== null)

      expect(winners).toHaveLength(1)
      await winners[0]?.release()
    }
  })
})
