/**
 * Tests for behavioral fixes from PR review.
 *
 * Covers:
 *   #1  refresh-file-lock: two contenders don't both end up owning a stale lock
 *   #3  quota-manager: concurrent refreshMain with two different tokens → two
 *       separate fetches, not a shared stale promise
 *   #5  accounts: concurrent saveAccountState calls don't lose updates
 *   #6  accounts: readJsonIfPresent parse error throws, ENOENT returns not-present
 *   #12 quota-normalize: NaN used_percent → no window / quota gate still applies
 */

import { afterEach, beforeEach, describe, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAccountPaths, getAccountStoragePath } from '../core/account-paths'
import { createFailurePhaseClock } from './failure-phase-clock'
import { createRequestTestScope } from './request-test-scope'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

// ---------------------------------------------------------------------------
// Shared temp-dir setup
// ---------------------------------------------------------------------------

let dir: string
let cfgPath: string
let statePath: string
const scope = createRequestTestScope()
const it = scope.it
const clock = createFailurePhaseClock()
const phaseIt = (name: string, body: () => Promise<void>) =>
  scope.it(name, () => clock.run(name, body))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-review-fixes-'))
  cfgPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = cfgPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
})

afterEach(async () => {
  await scope.teardown(async () => {})
  // Restore to the floor (not delete) so any in-flight write resolves to a
  // temp path rather than the operator's live default.
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------------------
// #1 — refresh-file-lock: stale-lock steal guard
//
// The multi-process race (P1 and P2 both see a stale lock, P1 steals it,
// P2 deletes P1's fresh lock) cannot be reproduced in a single-process test
// because JS is single-threaded. Instead we verify the guard logic directly:
// if the lock file is refreshed between the first read and the re-read (as
// would happen when another process steals first), the contender must abort.
// ---------------------------------------------------------------------------

describe('#1 refresh-file-lock: stale-lock steal guard', () => {
  it('a fresh lock (different ownerId) written between reads causes the steal to abort', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const lockPath = join(dir, 'openai-auth.json')
    const lockFile = `${lockPath}.guard-test.lock`

    // Write a stale lock (expired) so the first tryAcquire fails.
    await writeFile(
      lockFile,
      `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: 0 })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    // Now overwrite with a FRESH lock owned by a different process before
    // the contender's re-read. The contender should see the new ownerId and
    // return null instead of deleting the fresh lock.
    await writeFile(
      lockFile,
      `${JSON.stringify({
        ownerId: 'fresh-owner',
        expiresAt: Date.now() + 60_000,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    // The contender should fail to steal because the re-read shows a fresh lock.
    const result = await acquireRefreshFileLock({
      name: 'guard-test',
      ttlMs: 5_000,
      path: lockPath,
    })

    // Must return null — the fresh lock must not be stolen.
    expect(result).toBeNull()

    // The fresh lock file must still exist and still be owned by fresh-owner.
    const { readFile } = await import('node:fs/promises')
    const content = JSON.parse(await readFile(lockFile, 'utf8'))
    expect(content.ownerId).toBe('fresh-owner')
  })

  it('a stale lock with the same ownerId on re-read is correctly stolen', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const lockPath = join(dir, 'openai-auth.json')

    // Write a stale lock — same ownerId on both reads (no other process raced).
    await writeFile(
      `${lockPath}.same-owner-test.lock`,
      `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: 0 })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    const result = await acquireRefreshFileLock({
      name: 'same-owner-test',
      ttlMs: 5_000,
      path: lockPath,
    })

    // Should have successfully stolen the stale lock.
    expect(result).not.toBeNull()
    await result?.release()
  })
})

// ---------------------------------------------------------------------------
// #3 — quota-manager: concurrent refreshMain with different tokens → two fetches
// ---------------------------------------------------------------------------

describe('#3 QuotaManager.refreshMain: token-keyed deduplication', () => {
  phaseIt(
    'two concurrent calls with DIFFERENT tokens each trigger their own fetch',
    async () => {
      const { QuotaManager } = await clock.phase(
        'import QuotaManager',
        () => import('@cortexkit/openai-auth-core/internal'),
      )

      let fetchCount = 0
      const qm = new QuotaManager({
        configPath: getAccountStoragePath(),
        storage: null,
        fetchQuotaFn: async ({ accessToken }) => {
          fetchCount++
          // Hold the first refresh open while the other token's refresh is\n          // queued; the manager spaces the two API calls by one second.
          await clock.phase(
            `mock quota timer for ${accessToken}`,
            () => new Promise((r) => setTimeout(r, 20)),
          )
          return {
            primary: {
              usedPercent: accessToken === 'token-A' ? 10 : 20,
              remainingPercent: accessToken === 'token-A' ? 90 : 80,
              checkedAt: Date.now(),
            },
          }
        },
      })

      // Fire both concurrently with different tokens
      const [snapA, snapB] = await Promise.all([
        clock.phase('refresh token-A including persistence', () =>
          qm.refreshMain('token-A'),
        ),
        clock.phase('refresh token-B including persistence', () =>
          qm.refreshMain('token-B'),
        ),
      ])

      // Both fetches must have run (not shared a single in-flight promise)
      expect(fetchCount).toBe(2)
      // Each snapshot must reflect its own token's data
      expect(snapA.primary?.usedPercent).toBe(10)
      expect(snapB.primary?.usedPercent).toBe(20)
    },
  )

  it('two concurrent calls with the SAME token share one in-flight fetch', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    let fetchCount = 0
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      fetchQuotaFn: async () => {
        fetchCount++
        await new Promise((r) => setTimeout(r, 20))
        return {
          primary: {
            usedPercent: 42,
            remainingPercent: 58,
            checkedAt: Date.now(),
          },
        }
      },
    })

    const [snap1, snap2] = await Promise.all([
      qm.refreshMain('same-token'),
      qm.refreshMain('same-token'),
    ])

    // Only one fetch should have run
    expect(fetchCount).toBe(1)
    expect(snap1.primary?.usedPercent).toBe(42)
    expect(snap2.primary?.usedPercent).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// #5 — accounts: concurrent saveAccountState calls don't lose updates
// ---------------------------------------------------------------------------

describe('#5 saveAccountState: concurrent writes are serialized', () => {
  it('saveAccountState with a held lock waits rather than corrupting the file', async () => {
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const { saveAccounts, saveAccountState, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const acct = {
      id: 'acct-lock',
      type: 'oauth' as const,
      access: 'acc-v1',
      refresh: 'ref-1',
      expires: Date.now() + 3_600_000,
    }
    await saveAccounts(
      { version: 1, accounts: [acct] },
      getAccountPaths(cfgPath),
    )

    // Hold the state-save lock so saveAccountState must wait
    const lock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: statePath,
    })
    expect(lock).not.toBeNull()

    let settled = false
    const savePromise = saveAccountState(
      { version: 1, accounts: [{ ...acct, access: 'acc-v2' }] },
      getAccountPaths(cfgPath),
    ).finally(() => {
      settled = true
    })

    // Should still be waiting while lock is held
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)

    // Release the lock — saveAccountState should now complete
    await lock!.release()
    await savePromise

    const loaded = await loadAccounts(getAccountPaths(cfgPath))
    const la = loaded!.accounts.find((a) => a.id === 'acct-lock') as {
      access?: string
    }
    expect(la?.access).toBe('acc-v2')
  })
})

// ---------------------------------------------------------------------------
// #6 — accounts: readJsonIfPresent error handling
// ---------------------------------------------------------------------------

describe('#6 readJsonIfPresent error handling', () => {
  it('ENOENT → saveAccountState treats file as absent (no throw)', async () => {
    const { saveAccountState } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    // statePath does not exist yet — should not throw
    expect(existsSync(statePath)).toBe(false)
    await expect(
      saveAccountState({ version: 1, accounts: [] }, getAccountPaths(cfgPath)),
    ).resolves.toBeUndefined()
    expect(existsSync(statePath)).toBe(true)
  })

  it('corrupt JSON in state file → saveAccountState throws instead of silently overwriting', async () => {
    const { saveAccountState } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    // Write a corrupt state file
    writeFileSync(statePath, 'NOT VALID JSON', { mode: 0o600 })

    await expect(
      saveAccountState({ version: 1, accounts: [] }, getAccountPaths(cfgPath)),
    ).rejects.toThrow()

    // The corrupt file must NOT have been silently overwritten
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(statePath, 'utf8')).toBe('NOT VALID JSON')
  })
})

// ---------------------------------------------------------------------------
// MUST 1 (R2) — refresh-file-lock: fencing-token eviction marker
//
// Deterministic race test: two contenders (A and C), coordinated through the
// onStep hook, race over a stale refresh lock. C renames the fresh eviction
// marker that A created after winning the mkdir. The ownsEvictionMarker()
// checks in the critical section must detect the theft and let exactly one
// contender acquire the lock.
// ---------------------------------------------------------------------------

// Seed a stale lock + stale eviction-marker directory (back-dated past EVICT_TTL).
async function seedStaleRefreshLock(lockPath: string, name: string) {
  const { mkdir, rm, utimes, writeFile } = await import('node:fs/promises')
  const lockFile = `${lockPath}.${name}.lock`
  const evictPath = `${lockFile}.evicting`
  await rm(lockFile, { recursive: true, force: true })
  await rm(evictPath, { recursive: true, force: true })
  await writeFile(
    lockFile,
    `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: 0 })}\n`,
    'utf8',
  )
  await mkdir(evictPath)
  await utimes(evictPath, 0, 0)
  return { lockFile, evictPath }
}

// Count leftover eviction-marker entries for a lock name (should be 0 once the winner releases).
async function countRefreshLockLeaks(lockPath: string, name: string) {
  const { readdir } = await import('node:fs/promises')
  const { basename, dirname: pathDirname } = await import('node:path')
  const lockFile = `${lockPath}.${name}.lock`
  const prefix = `${basename(lockFile)}.evicting`
  const entries = await readdir(pathDirname(lockFile))
  return entries.filter((entry) => entry.startsWith(prefix) || entry === prefix)
    .length
}

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

describe('MUST 1 (R2) — fencing-token eviction marker: single winner under 3rd-race interleaving', () => {
  it('refresh file lock stale-marker steal has a single winner under forced recreate race', async () => {
    // Deterministic seam test: reproduces the 3rd interleaving where contender C
    // renames the FRESH eviction-marker directory that contender A (the mkdir-winner)
    // created. The four ownsEvictionMarker() fence checks must detect the theft.
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const lockPath = join(dir, 'openai-auth.json')
    const name = 'test-refresh-forced-stale-steal'
    const ttlMs = 1_000
    await seedStaleRefreshLock(lockPath, name)

    const cSawStaleMarker = deferred()
    const releaseCFromStaleMarker = deferred()
    const cClaimedMarker = deferred()
    const releaseCFromClaim = deferred()
    const cConfirmedStaleLock = deferred()
    const releaseCFromStaleLock = deferred()
    const aAcquiredMarker = deferred()
    const releaseAFromMarker = deferred()

    const contenderC = acquireRefreshFileLock({
      name,
      ttlMs,
      path: lockPath,
      onStep: async (step) => {
        if (step === 'stale-marker-stat') {
          cSawStaleMarker.resolve()
          await releaseCFromStaleMarker.promise
        }
        if (step === 'stale-marker-claimed') {
          cClaimedMarker.resolve()
          await releaseCFromClaim.promise
        }
        if (step === 'stale-lock-confirmed') {
          cConfirmedStaleLock.resolve()
          await releaseCFromStaleLock.promise
        }
      },
    })

    await withTimeout(cSawStaleMarker.promise, 1_000)

    const contenderA = acquireRefreshFileLock({
      name,
      ttlMs,
      path: lockPath,
      onStep: (step) => {
        if (step === 'eviction-marker-acquired') {
          aAcquiredMarker.resolve()
          return releaseAFromMarker.promise
        }
      },
    })

    await withTimeout(aAcquiredMarker.promise, 1_000)
    releaseCFromStaleMarker.resolve()
    await withTimeout(cClaimedMarker.promise, 1_000)
    releaseCFromClaim.resolve()
    await withTimeout(cConfirmedStaleLock.promise, 1_000)

    releaseAFromMarker.resolve()
    const aLock = await withTimeout(contenderA, 1_000)
    releaseCFromStaleLock.resolve()
    const cLock = await withTimeout(contenderC, 1_000)
    const winners = [aLock, cLock].filter(Boolean)

    await Promise.all(winners.map((lock) => lock?.release()))

    expect(winners).toHaveLength(1)
    expect(await countRefreshLockLeaks(lockPath, name)).toBe(0)
  })

  it('classifies a renamed-away marker (ENOENT/EINVAL/ENOTDIR) as a lost race, not a fatal error', async () => {
    // A contender that renames our fresh eviction-marker directory away between
    // our mkdir and owner-file write makes the write fail with a platform-
    // dependent errno: ENOENT on Linux, EINVAL/ENOTDIR on macOS/APFS. All three
    // must be treated as a lost race so the acquire retries instead of throwing.
    const { isLostMarkerRaceError } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    for (const code of ['ENOENT', 'EINVAL', 'ENOTDIR']) {
      const err = Object.assign(new Error(code), { code })
      expect(isLostMarkerRaceError(err), code).toBe(true)
    }
    // A genuine failure (e.g. permissions, disk full) must NOT be swallowed as a
    // lost race — the acquire has to surface it.
    for (const code of ['EACCES', 'EEXIST', 'ENOSPC', undefined]) {
      const err = Object.assign(new Error(String(code)), code ? { code } : {})
      expect(isLostMarkerRaceError(err), String(code)).toBe(false)
    }
    expect(isLostMarkerRaceError(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// MUST 2 (R2) — accounts: saveAccounts holds state-lock across the state READ
//
// The state-lock must be acquired BEFORE loadAccounts (which reads the state
// file) so that a concurrent saveAccountState cannot write the state file in
// the window between saveAccounts' read and its write.
// ---------------------------------------------------------------------------

describe('MUST 2 (R2) — saveAccounts: state-lock held across state-file read', () => {
  it('externally-held state-lock blocks saveAccounts before it reads the state file', async () => {
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const { saveAccounts, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const acct = {
      id: 'acct-must2r2b',
      type: 'oauth' as const,
      access: 'acc-v1',
      refresh: 'ref-1',
      expires: Date.now() + 3_600_000,
    }

    await saveAccounts(
      { version: 1, accounts: [acct] },
      getAccountPaths(cfgPath),
    )

    // Hold the state lock externally — saveAccounts must block before reading
    // the state file (not just before writing it).
    const stateLock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: statePath,
    })
    expect(stateLock).not.toBeNull()

    let settled = false
    const savePromise = saveAccounts(
      { version: 1, accounts: [{ ...acct, access: 'acc-v2' }] },
      getAccountPaths(cfgPath),
    ).finally(() => {
      settled = true
    })

    // saveAccounts must be blocked (state-lock held before loadAccounts).
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)

    // Release the state lock — saveAccounts should now complete.
    await stateLock!.release()
    await savePromise

    const loaded = await loadAccounts(getAccountPaths(cfgPath))
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts.find((a) => a.id === acct.id)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// MUST 2 (R2) — accounts: saveAccountState reads state AFTER acquiring lock
// ---------------------------------------------------------------------------

describe('MUST 2 (R2) — saveAccountState: reads state file after acquiring lock', () => {
  it('externally-held state-lock blocks saveAccountState before it reads', async () => {
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const { saveAccounts, saveAccountState, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const acct = {
      id: 'acct-must2r2c',
      type: 'oauth' as const,
      access: 'acc-v1',
      refresh: 'ref-1',
      expires: Date.now() + 3_600_000,
    }

    await saveAccounts(
      { version: 1, accounts: [acct] },
      getAccountPaths(cfgPath),
    )

    // Hold the state lock — saveAccountState must block before reading.
    const stateLock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: statePath,
    })
    expect(stateLock).not.toBeNull()

    let settled = false
    const savePromise = saveAccountState(
      { version: 1, accounts: [{ ...acct, access: 'acc-v2' }] },
      getAccountPaths(cfgPath),
    ).finally(() => {
      settled = true
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)

    await stateLock!.release()
    await savePromise

    const loaded = await loadAccounts(getAccountPaths(cfgPath))
    const la = loaded!.accounts.find((a) => a.id === acct.id) as {
      access?: string
    }
    expect(la?.access).toBe('acc-v2')
  })
})

// ---------------------------------------------------------------------------
// MUST 2 — quota-manager: second-token fetch's inflight survives first's finally
// ---------------------------------------------------------------------------

describe('MUST 2 — QuotaManager._fetchMain: token-scoped inflight clear', () => {
  it("second token's inflight slot survives the first token's finally", async () => {
    // The _enqueueApiFetch gate serializes API calls, so fetches for different
    // tokens run sequentially (not simultaneously). The invariant we verify:
    // after fetch-A completes, its finally must NOT clear fetch-B's inflight
    // slot — so a same-token-B caller that arrives AFTER fetch-A's finally
    // still dedups with the in-flight fetch-B (fetchCount stays at 2, not 3).
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    let fetchCount = 0

    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      fetchQuotaFn: async ({ accessToken }) => {
        fetchCount++
        // Small delay so the inflight slot is visible to concurrent callers
        await new Promise((r) => setTimeout(r, 20))
        return {
          primary: {
            usedPercent: accessToken === 'token-A' ? 10 : 20,
            remainingPercent: accessToken === 'token-A' ? 90 : 80,
            checkedAt: Date.now(),
          },
        }
      },
    })

    // Start fetch A and fetch B concurrently with different tokens.
    // The gate serializes them: A runs first, B queues behind it.
    const promiseA = qm.refreshMain('token-A')
    const promiseB = qm.refreshMain('token-B')

    // While A and B are in flight, start a second B call — it must dedup
    // with the already-queued fetch-B (not start a third fetch).
    const promiseB2 = qm.refreshMain('token-B')

    const [snapA, snapB, snapB2] = await Promise.all([
      promiseA,
      promiseB,
      promiseB2,
    ])

    // Exactly 2 fetches: one for token-A, one for token-B
    expect(fetchCount).toBe(2)
    expect(snapA.primary?.usedPercent).toBe(10)
    expect(snapB.primary?.usedPercent).toBe(20)
    // B2 must have deduped with B (same result, no extra fetch)
    expect(snapB2.primary?.usedPercent).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// MUST 4 — accounts: saveAccounts holds state-path lock for state-file write
// ---------------------------------------------------------------------------

describe('MUST 4 — saveAccounts: state-file write is protected by state-path lock', () => {
  it('concurrent saveAccounts + saveAccountState do not lose the state-file update', async () => {
    const { saveAccounts, saveAccountState, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const acct = {
      id: 'acct-must4',
      type: 'oauth' as const,
      access: 'acc-v1',
      refresh: 'ref-1',
      expires: Date.now() + 3_600_000,
    }

    // Establish baseline
    await saveAccounts(
      { version: 1, accounts: [acct] },
      getAccountPaths(cfgPath),
    )

    // Run saveAccounts and saveAccountState concurrently many times.
    // If the state-file lock is not held by saveAccounts, one of these
    // will produce a lost update (the state file will be partially written).
    const iterations = 10
    const tasks: Promise<unknown>[] = []
    for (let i = 0; i < iterations; i++) {
      const updatedAcct = { ...acct, access: `acc-v${i + 2}` }
      tasks.push(
        saveAccounts(
          { version: 1, accounts: [updatedAcct] },
          getAccountPaths(cfgPath),
        ),
        saveAccountState(
          { version: 1, accounts: [updatedAcct] },
          getAccountPaths(cfgPath),
        ),
      )
    }

    // All must complete without error
    await expect(Promise.all(tasks)).resolves.toBeDefined()

    // The state file must be valid JSON after all concurrent writes
    const loaded = await loadAccounts(getAccountPaths(cfgPath))
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts.length).toBe(1)
  })

  it('saveAccounts holds state-lock: a concurrent saveAccountState waits', async () => {
    // Verify the lock ordering: config-lock (outer) → state-lock (inner).
    // We hold the state lock externally and verify that saveAccounts eventually
    // completes (it must acquire the state lock after the config lock).
    const { acquireRefreshFileLock } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const { saveAccounts, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const acct = {
      id: 'acct-must4b',
      type: 'oauth' as const,
      access: 'acc-v1',
      refresh: 'ref-1',
      expires: Date.now() + 3_600_000,
    }

    await saveAccounts(
      { version: 1, accounts: [acct] },
      getAccountPaths(cfgPath),
    )

    // Hold the state lock
    const stateLock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: statePath,
    })
    expect(stateLock).not.toBeNull()

    let settled = false
    const savePromise = saveAccounts(
      { version: 1, accounts: [{ ...acct, access: 'acc-v2' }] },
      getAccountPaths(cfgPath),
    ).finally(() => {
      settled = true
    })

    // saveAccounts should be blocked on the state lock
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)

    // Release the state lock — saveAccounts should now complete
    await stateLock!.release()
    await savePromise

    const loaded = await loadAccounts(getAccountPaths(cfgPath))
    expect(loaded).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Override-consistency — saveAccounts must honor OPENCODE_OPENAI_AUTH_STATE_FILE
//
// When the env override is set, saveAccounts must write the state to the
// override path (not the derived-default path), consistent with every other
// state-file accessor (loadAccounts, saveAccountState, migrate).
// ---------------------------------------------------------------------------

describe('saveAccounts: honors OPENCODE_OPENAI_AUTH_STATE_FILE override', () => {
  it('writes state to the override path, not the derived-default path', async () => {
    // Use a fresh temp dir so the override path is clearly distinct from the
    // derived-default (which would be <dir>/openai-auth-state.json).
    const overrideDir = mkdtempSync(join(tmpdir(), 'oai-override-'))
    const overrideCfgPath = join(overrideDir, 'openai-auth.json')
    // Override state path is in a subdirectory — clearly not the derived default.
    const overrideStateDir = mkdtempSync(join(tmpdir(), 'oai-override-state-'))
    const overrideStatePath = join(overrideStateDir, 'custom-state.json')

    const savedFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const savedState = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_FILE = overrideCfgPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = overrideStatePath

    try {
      const { saveAccounts } = await import(
        '@cortexkit/openai-auth-core/internal'
      )

      const acct = {
        id: 'acct-override',
        type: 'oauth' as const,
        access: 'acc-v1',
        refresh: 'ref-1',
        expires: Date.now() + 3_600_000,
      }

      await saveAccounts(
        { version: 1, accounts: [acct] },
        getAccountPaths(overrideCfgPath),
      )

      // State must be written to the override path.
      expect(existsSync(overrideStatePath)).toBe(true)

      // The derived-default path (same dir as cfg, different name) must NOT exist.
      const derivedDefault = join(overrideDir, 'openai-auth-state.json')
      expect(existsSync(derivedDefault)).toBe(false)
    } finally {
      // Restore to the saved value (which is the floor when the preload is
      // active) rather than deleting — never leave the env unset.
      process.env.OPENCODE_OPENAI_AUTH_FILE = savedFile ?? FLOOR_AUTH_FILE
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE =
        savedState ?? FLOOR_STATE_FILE
      try {
        rmSync(overrideDir, { recursive: true, force: true })
        rmSync(overrideStateDir, { recursive: true, force: true })
      } catch {}
    }
  })
})

// ---------------------------------------------------------------------------
// REFRESH-BACKOFF — recordQuotaRefreshError arms refresh backoff only on
// token-refresh-step failures (isRefreshError===true), not on quota-endpoint
// errors (including 401 from wham/usage).
//
// Bug: the condition was `status === 401` only, so a non-401 refresh failure
// (400 invalid_grant / 429 / 500) during a quota loop never armed the refresh
// backoff → the token endpoint was hammered every quota cycle.
//
// Fix: gate solely on `isRefreshError===true` (tagged at the throw site in
// codexRefreshFn). A quota-endpoint 401 must NOT arm the refresh backoff:
// isTransientRefreshError(401)===false → long non-transient delay, and
// refreshBackoffActive would then block the very refresh the 401 implies is
// needed, leaving the bad token stuck. The quota backoff (buildQuotaOperationError)
// already throttles the quota endpoint for all non-refresh failures.
// ---------------------------------------------------------------------------

describe('REFRESH-BACKOFF — recordQuotaRefreshError arms refresh backoff only on refresh-step failures', () => {
  it('RED→GREEN: non-401 token-refresh failure (500, isRefreshError) during quota loop arms refresh backoff', async () => {
    // RED: on the old code (status===401 only), a 500 refresh error during a
    // quota loop left lastRefreshError undefined. GREEN: with isRefreshError===true
    // the refresh backoff is armed regardless of status.
    const { FallbackAccountManager, saveAccounts, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    // Account with an expired token so tokenNeedsRefresh returns true.
    const account = {
      id: 'acct-refresh-backoff-500',
      type: 'oauth' as const,
      access: 'access-expired',
      refresh: 'refresh-token',
      expires: Date.now() - 1_000, // expired
      enabled: true,
    }

    await saveAccounts(
      { version: 1 as const, accounts: [account] },
      getAccountPaths(cfgPath),
    )

    // refreshFn throws a non-401 error tagged as a refresh error (as codexRefreshFn does).
    const refreshError = Object.assign(new Error('Token refresh failed: 500'), {
      status: 500,
      isRefreshError: true,
    })

    const manager = new FallbackAccountManager({
      paths: getAccountPaths(cfgPath),
      refreshFn: async () => {
        throw refreshError
      },
      // fetchQuotaFn must be present so the quota path is not short-circuited.
      fetchQuotaFn: async () => ({
        primary: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: Date.now(),
        },
      }),
    })

    await manager.refreshQuotaForAllAccounts({ force: true })

    // Reload from disk — the manager persists the updated account after the catch.
    const reloaded = await loadAccounts(getAccountPaths(cfgPath))
    const stored = reloaded?.accounts.find((a) => a.id === account.id) as
      | { lastRefreshError?: unknown }
      | undefined

    // GREEN: refresh backoff must be armed (lastRefreshError set).
    expect(stored?.lastRefreshError).toBeDefined()
  })

  it('quota-endpoint 401 (no isRefreshError) does NOT arm refresh backoff, only quota backoff', async () => {
    // A 401 from the quota endpoint (wham/usage) must NOT arm the refresh backoff:
    // doing so would set a long non-transient delay and block the very refresh
    // the 401 implies is needed. Only the quota backoff (lastQuotaRefreshError)
    // must be armed, correctly throttling the quota endpoint.
    const { FallbackAccountManager, saveAccounts, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    // Token is valid — no refresh needed. The 401 comes from the quota endpoint.
    const account = {
      id: 'acct-quota-401-boundary',
      type: 'oauth' as const,
      access: 'access-valid',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      enabled: true,
    }

    await saveAccounts(
      { version: 1 as const, accounts: [account] },
      getAccountPaths(cfgPath),
    )

    // fetchQuotaFn throws a 401 with no isRefreshError (exactly as whamUsageFn does).
    const manager = new FallbackAccountManager({
      paths: getAccountPaths(cfgPath),
      fetchQuotaFn: async () => {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
          // no isRefreshError — this is a quota-endpoint rejection, not a refresh failure
        })
      },
    })

    await manager.refreshQuotaForAllAccounts({ force: true })

    const reloaded = await loadAccounts(getAccountPaths(cfgPath))
    const stored = reloaded?.accounts.find((a) => a.id === account.id) as
      | { lastRefreshError?: unknown; lastQuotaRefreshError?: unknown }
      | undefined

    // Quota backoff must be armed (quota endpoint throttled).
    expect(stored?.lastQuotaRefreshError).toBeDefined()
    // Refresh backoff must NOT be armed — the token is fine; only the quota API rejected it.
    expect(stored?.lastRefreshError).toBeUndefined()
  })

  it('pure quota-fetch failure (non-401, no isRefreshError) does NOT arm refresh backoff', async () => {
    // A 429 from the quota endpoint (not a refresh error) must only arm quota
    // backoff, not refresh backoff. This is the correct boundary.
    const { FallbackAccountManager, saveAccounts, loadAccounts } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const account = {
      id: 'acct-quota-only-backoff',
      type: 'oauth' as const,
      access: 'access-valid',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000, // not expired — no refresh needed
      enabled: true,
    }

    await saveAccounts(
      { version: 1 as const, accounts: [account] },
      getAccountPaths(cfgPath),
    )

    // fetchQuotaFn throws a non-401 quota error (no isRefreshError).
    const manager = new FallbackAccountManager({
      paths: getAccountPaths(cfgPath),
      fetchQuotaFn: async () => {
        throw Object.assign(new Error('wham usage check failed: 429'), {
          status: 429,
          // no isRefreshError — pure quota-fetch failure
        })
      },
    })

    await manager.refreshQuotaForAllAccounts({ force: true })

    const reloaded = await loadAccounts(getAccountPaths(cfgPath))
    const stored = reloaded?.accounts.find((a) => a.id === account.id) as
      | { lastRefreshError?: unknown; lastQuotaRefreshError?: unknown }
      | undefined

    // Quota backoff must be armed.
    expect(stored?.lastQuotaRefreshError).toBeDefined()
    // Refresh backoff must NOT be armed (only quota failed, not the refresh).
    expect(stored?.lastRefreshError).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// #12 — quota-normalize: NaN used_percent → no window, quota gate still applies
// ---------------------------------------------------------------------------

describe('#12 NaN used_percent → no quota window', () => {
  it('normalizeWsFrame: NaN primary used_percent → no primary window in snapshot', async () => {
    const { normalizeWsFrame } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const snap = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: Number.NaN, window_minutes: 300 },
        secondary: { used_percent: 5, window_minutes: 10080 },
      },
    })

    // NaN primary must be absent — not a bogus window
    expect(snap.primary).toBeUndefined()
    // Valid secondary must still be present
    expect(snap.secondary?.usedPercent).toBe(5)
    expect(snap.secondary?.remainingPercent).toBe(95)
  })

  it('normalizeWham: NaN primary used_percent → no primary window in snapshot', async () => {
    const { normalizeWham } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const snap = normalizeWham({
      rate_limit: {
        primary_window: {
          used_percent: Number.NaN,
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 604800,
        },
      },
    })

    expect(snap.primary).toBeUndefined()
    expect(snap.secondary?.usedPercent).toBe(20)
  })

  it('Infinity used_percent → no window (also non-finite)', async () => {
    const { normalizeWsFrame } = await import(
      '@cortexkit/openai-auth-core/internal'
    )

    const snap = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: Infinity, window_minutes: 300 },
      },
    })

    expect(snap.primary).toBeUndefined()
  })
})
