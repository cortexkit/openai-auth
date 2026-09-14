/**
 * Custody refresh gates.
 *
 * Each local fallback refresh path must refuse to invoke the injected refresh
 * provider when the account is `refreshInert` (custody-manifest entry OR
 * tombstone sentinel in storage), regardless of claustrum mode. The storage
 * mode never participates in this gate: changing it
 * must not resurrect a local refresher over a vault-held family.
 *
 * The choke point lives in `refreshAccountNow` — every `this.load()` inside
 * it (and inside `waitForConcurrentFallbackRefresh`) re-evaluates the gate
 * with the reloaded account and the current manifest snapshot, throwing
 * `CustodyTombstoneRefreshError` when true.
 *
 * The error writers (`recordRefreshError`, `recordQuotaRefreshError`) refuse
 * to persist a tombstone refresh — the tombstone class is the wired-in
 * short-circuit, and stamping `lastRefreshError` with it would re-arm the
 * refresh backoff against an inert account.
 *
 * Each gated branch is exercised by a standard RED-then-GREEN run; the
 * named tests are the witnesses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountManagerOptions,
  type AccountStorage,
  FallbackAccountManager,
  fallbackRefreshLockName,
  loadAccounts,
  type OAuthAccount,
  saveAccounts,
} from '../core/accounts.ts'
import { CustodyTombstoneRefreshError } from '../core/custody.ts'
import type { CustodyManifestReadResult } from '../core/custody-manifest.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import {
  claustrumConfig,
  emptyManifest,
  enrollmentManifest,
  liveAccount,
  liveStorage,
  makeSentinelAccount,
  TOMBSTONE_OPENAI,
} from './custody-fixtures.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_CLAUSTRUM_HANDLES,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

const CUSTODY_PROVIDER = 'openai'

let dir: string
let cfgPath: string
let statePath: string
let handlesPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'custody-refresh-'))
  cfgPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = cfgPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
  handlesPath = join(dir, 'opencode-handles.json')
  process.env.CLAUSTRUM_OPENCODE_HANDLES = handlesPath
})

afterEach(() => {
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  process.env.CLAUSTRUM_OPENCODE_HANDLES = FLOOR_CLAUSTRUM_HANDLES
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------------------
// Contract: error shape itself
// ---------------------------------------------------------------------------

describe('CustodyTombstoneRefreshError contract', () => {
  it('has status 503 and isRefreshError=true', () => {
    const error = new CustodyTombstoneRefreshError(CUSTODY_PROVIDER)
    expect(error.status).toBe(503)
    expect(error.isRefreshError).toBe(true)
    expect(error.code).toBe('CUSTODY_TOMBSTONED')
    expect(error.name).toBe('CustodyTombstoneRefreshError')
  })
})

// ---------------------------------------------------------------------------
// Choke point: refreshAccountNow throws on refreshInert
// ---------------------------------------------------------------------------

describe('choke point (refreshAccountNow) refuses refreshInert accounts', () => {
  it('tombstoned storage account + no manifest entry → throws before refreshFn', async () => {
    const account = makeSentinelAccount()
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    let refreshFnCalls = 0
    let observedRefreshToken: string | undefined
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: { readManifest: () => Promise.resolve(emptyManifest()) },
      refreshFn: async ({ refreshToken }) => {
        refreshFnCalls++
        observedRefreshToken = refreshToken
        return {
          access: 'unused',
          refresh: 'unused',
          expires: Date.now() + 3_600_000,
          expiresIn: 3600,
        }
      },
    })

    let thrown: unknown
    try {
      await manager.refreshAccount(account, storage, { force: true })
    } catch (e) {
      thrown = e
    }

    // Removing the choke-point assertion lets refreshFn observe the sentinel
    // as the refresh token — the assertion below pins the gate in place.
    expect(refreshFnCalls).toBe(0)
    expect(observedRefreshToken).toBeUndefined()
    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
  })

  it('enrolled manifest account in local mode → throws before refreshFn', async () => {
    const account = liveAccount('enrolling-1')
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    let refreshFnCalls = 0
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: {
        readManifest: () => Promise.resolve(enrollmentManifest('enrolling-1')),
      },
      refreshFn: async () => {
        refreshFnCalls++
        return {
          access: 'unused',
          refresh: 'unused',
          expires: Date.now() + 3_600_000,
          expiresIn: 3600,
        }
      },
    })

    let thrown: unknown
    try {
      await manager.refreshAccount(account, storage, { force: true })
    } catch (e) {
      thrown = e
    }

    expect(refreshFnCalls).toBe(0)
    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
  })

  it('tombstoned storage account refuses before a manifest read can fail', async () => {
    const account = makeSentinelAccount({ access: '' })
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!
    let manifestReads = 0
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: {
        readManifest: async () => {
          manifestReads++
          throw new Error('manifest reader must not run')
        },
      },
    })

    await expect(
      manager.refreshAccount(account, storage, { force: true }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(manifestReads).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getUsableFallbackAccounts candidate shape
// ---------------------------------------------------------------------------

describe('getUsableFallbackAccounts candidate shape', () => {
  it('enrolling + valid local token → present in usable, zero refreshFn calls', async () => {
    // Enrolling (manifest entry, not tombstoned) stays a usable candidate —
    // it serves its local access token while that token is valid. The local
    // refresher must NOT run.
    const account = liveAccount('enr-1', { expires: Date.now() + 3_600_000 })
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('enr-1')),
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable).toHaveLength(1)
    expect(usable[0]?.id).toBe('enr-1')
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('keeps an expired enrolling account for the request resolver without refreshing it', async () => {
    // The resolver completes an expired enrollment inline. Selection must keep
    // the account available while still preventing a local refresh.
    const account = liveAccount('enr-2', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('enr-2')),
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable).toHaveLength(1)
    expect(usable[0]?.id).toBe('enr-2')
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('tombstoned account stays selectable without local refresh', async () => {
    const account = makeSentinelAccount({ id: 'tomb-1' })
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(emptyManifest()),
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable).toHaveLength(1)
    expect(usable[0]?.id).toBe('tomb-1')
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// refreshAccountNow — per-reload re-checks (one test per reload site)
// ---------------------------------------------------------------------------

// Overrides `load` so the manager injects the tombstone sentinel into the
// in-memory storage on the Nth call. Each test sets `injectAt` to the call
// number that should observe the tombstone.
class InjectTombstoneOnLoad extends FallbackAccountManager {
  loadCalls = 0
  constructor(
    options: AccountManagerOptions,
    private readonly injectAt: number,
    private readonly targetId: string,
  ) {
    super(options)
  }
  override async load(): Promise<AccountStorage | null> {
    this.loadCalls++
    const loaded = await super.load()
    if (
      this.loadCalls === this.injectAt &&
      loaded &&
      Array.isArray(loaded.accounts)
    ) {
      const target = loaded.accounts.find((a) => a.id === this.targetId)
      if (target && target.type === 'oauth') {
        target.access = TOMBSTONE_OPENAI
        target.refresh = TOMBSTONE_OPENAI
        target.expires = 0
      }
    }
    return loaded
  }
}

describe('refreshAccountNow per-reload choke-point re-checks', () => {
  it('under-lock load (call 2) sees tombstone injected mid-flight → throws', async () => {
    const accountId = 'ul-1'
    const account = liveAccount(accountId, { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    let refreshFnCalls = 0
    let observedRefreshToken: string | undefined
    const manager = new InjectTombstoneOnLoad(
      {
        configPath: cfgPath,
        custody: { readManifest: () => Promise.resolve(emptyManifest()) },
        refreshFn: async ({ refreshToken }) => {
          refreshFnCalls++
          observedRefreshToken = refreshToken
          return {
            access: 'unused',
            refresh: 'unused',
            expires: Date.now() + 3_600_000,
            expiresIn: 3600,
          }
        },
      },
      2,
      accountId,
    )

    const storage = (await loadAccounts(cfgPath))!
    let thrown: unknown
    try {
      await manager.refreshAccount(account, storage, { force: true })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(refreshFnCalls).toBe(0)
    expect(observedRefreshToken).toBeUndefined()
  })

  it('post-save load (call 3) sees tombstone injected mid-flight → throws', async () => {
    const accountId = 'ps-1'
    const account = liveAccount(accountId, { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    let refreshFnCalls = 0
    const manager = new InjectTombstoneOnLoad(
      {
        configPath: cfgPath,
        custody: { readManifest: () => Promise.resolve(emptyManifest()) },
        refreshFn: async () => {
          refreshFnCalls++
          return {
            access: 'rotated-access',
            refresh: 'rotated-refresh',
            expires: Date.now() + 3_600_000,
            expiresIn: 3600,
          }
        },
      },
      3,
      accountId,
    )

    const storage = (await loadAccounts(cfgPath))!
    let thrown: unknown
    try {
      await manager.refreshAccount(account, storage, { force: true })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
    // The refreshFn ran successfully (it returned valid tokens); the choke
    // point fires only on the post-save load, AFTER the save.
    expect(refreshFnCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Manager entry gates — four groups
// ---------------------------------------------------------------------------

// Spies on the public `refreshAccount` method so the entry-gate tests can
// observe that the manager entry-gate prevents the call to `refreshAccount`
// itself, distinct from the choke-point preventing refreshFn inside it.
class SpyManager extends FallbackAccountManager {
  refreshAccountCalls: OAuthAccount[] = []
  override async refreshAccount(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean } = {},
  ): Promise<OAuthAccount> {
    this.refreshAccountCalls.push(account)
    return super.refreshAccount(account, storage, options)
  }
}

async function makeSpyManager(opts: {
  refreshFn?: AccountManagerOptions['refreshFn']
  readManifest?: () => Promise<CustodyManifestReadResult>
}): Promise<{
  manager: SpyManager
  refreshCalls: () => number
}> {
  let calls = 0
  const refreshFn =
    opts.refreshFn ??
    (async () => {
      calls++
      return {
        access: 'unused',
        refresh: 'unused',
        expires: Date.now() + 3_600_000,
        expiresIn: 3600,
      }
    })
  const tracked: AccountManagerOptions['refreshFn'] = async (input) => {
    calls++
    return refreshFn(input)
  }
  const manager = new SpyManager({
    configPath: cfgPath,
    custody: {
      readManifest:
        opts.readManifest ?? (() => Promise.resolve(emptyManifest())),
    },
    refreshFn: tracked,
    fetchQuotaFn: async () => {
      throw new Error('no fetchQuotaFn configured for this test')
    },
  })
  return { manager, refreshCalls: () => calls }
}

describe('manager entry gates skip refreshInert accounts', () => {
  it('getUsableFallbackAccounts: tombstoned account → refreshAccount NOT invoked', async () => {
    const account = makeSentinelAccount({ id: 'a-1' })
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(emptyManifest()),
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable.map((candidate) => candidate.id)).toEqual(['a-1'])
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshDueAccounts: tombstoned account → refreshAccount NOT invoked', async () => {
    const account = makeSentinelAccount({ id: 'a-2' })
    await saveAccounts(liveStorage([account]), cfgPath)

    const { manager, refreshCalls } = await makeSpyManager({})
    await manager.refreshDueAccounts()
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshQuotaForDueAccounts: tombstoned account → refreshAccount NOT invoked', async () => {
    const account = makeSentinelAccount({ id: 'a-3' })
    await saveAccounts(liveStorage([account]), cfgPath)

    const { manager, refreshCalls } = await makeSpyManager({})
    await manager.refreshQuotaForDueAccounts()
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshQuotaForAllAccounts: tombstoned account → refreshAccount NOT invoked', async () => {
    const account = makeSentinelAccount({ id: 'a-4' })
    await saveAccounts(liveStorage([account]), cfgPath)

    const { manager, refreshCalls } = await makeSpyManager({})
    await manager.refreshQuotaForAllAccounts({ force: true })
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// enrolled + local mode + live secret → ZERO refreshFn
// ---------------------------------------------------------------------------

describe('enrolled + local mode → skip local refresh', () => {
  it('getUsableFallbackAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('enrolled-1', { expires: Date.now() - 1_000 })
    await saveAccounts(
      liveStorage([account], {
        claustrum: claustrumConfig({ mode: 'local' }),
      }),
      cfgPath,
    )
    const storage = (await loadAccounts(cfgPath))!

    const { manager: rawManager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('enrolled-1')),
    })

    await rawManager.getUsableFallbackAccounts(storage)
    expect(refreshCalls()).toBe(0)
    expect(rawManager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshDueAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('enrolled-2', { expires: Date.now() - 1_000 })
    await saveAccounts(
      liveStorage([account], {
        claustrum: claustrumConfig({ mode: 'local' }),
      }),
      cfgPath,
    )

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('enrolled-2')),
    })

    await manager.refreshDueAccounts()
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshQuotaForDueAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('enrolled-3', { expires: Date.now() - 1_000 })
    await saveAccounts(
      liveStorage([account], {
        claustrum: claustrumConfig({ mode: 'local' }),
      }),
      cfgPath,
    )

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('enrolled-3')),
    })

    await manager.refreshQuotaForDueAccounts()
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshQuotaForAllAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('enrolled-4', { expires: Date.now() - 1_000 })
    await saveAccounts(
      liveStorage([account], {
        claustrum: claustrumConfig({ mode: 'local' }),
      }),
      cfgPath,
    )

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('enrolled-4')),
    })

    await manager.refreshQuotaForAllAccounts({ force: true })
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// error writers ignore CustodyTombstoneRefreshError
// ---------------------------------------------------------------------------

describe('recordRefreshError refuses to persist CustodyTombstoneRefreshError', () => {
  it('refreshDueAccounts catch path: tombstone error → lastRefreshError undefined on disk', async () => {
    // Live account + empty manifest — the entry gate does NOT fire (refreshInert
    // is false), so refreshFn is invoked and recordRefreshError runs in the
    // catch. Without the ignore, the tombstone class stamps a permanent error.
    const account = liveAccount('er-1', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    let refreshFnCalls = 0
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: { readManifest: () => Promise.resolve(emptyManifest()) },
      refreshFn: async () => {
        refreshFnCalls++
        throw new CustodyTombstoneRefreshError(CUSTODY_PROVIDER)
      },
    })

    await manager.refreshDueAccounts()
    expect(refreshFnCalls).toBe(1)

    const persisted = await loadAccounts(cfgPath)
    const stored = persisted?.accounts.find((a) => a.id === 'er-1') as
      | OAuthAccount
      | undefined
    expect(stored).toBeDefined()
    if (stored && stored.type === 'oauth') {
      expect(stored.lastRefreshError).toBeUndefined()
    }
  })

  it('refreshQuotaForDueAccounts catch path: tombstone error → neither error stamped', async () => {
    const account = liveAccount('er-2', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    let quotaCalls = 0
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: { readManifest: () => Promise.resolve(emptyManifest()) },
      refreshFn: async () => ({
        access: 'rotated',
        refresh: 'rotated',
        expires: Date.now() + 3_600_000,
        expiresIn: 3600,
      }),
      fetchQuotaFn: async () => {
        quotaCalls++
        throw new CustodyTombstoneRefreshError(CUSTODY_PROVIDER)
      },
    })

    await manager.refreshQuotaForDueAccounts()
    expect(quotaCalls).toBe(1)

    const persisted = await loadAccounts(cfgPath)
    const stored = persisted?.accounts.find((a) => a.id === 'er-2') as
      | OAuthAccount
      | undefined
    expect(stored).toBeDefined()
    if (stored && stored.type === 'oauth') {
      expect(stored.lastQuotaRefreshError).toBeUndefined()
      expect(stored.lastRefreshError).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// waiter (waitForConcurrentFallbackRefresh) per-poll refreshInert re-check
// ---------------------------------------------------------------------------

async function acquireLockExternally(accountId: string) {
  return acquireRefreshFileLock({
    name: fallbackRefreshLockName(accountId),
    ttlMs: 60_000,
    path: cfgPath,
    renew: false,
  })
}

describe('waiter (waitForConcurrentFallbackRefresh) re-evaluates refreshInert per poll', () => {
  it('force:true caller enters before the tombstone, lands inside the wait → throws', async () => {
    const accountId = 'waiter-poll'
    const account = liveAccount(accountId, { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    const holder = await acquireLockExternally(accountId)
    expect(holder).not.toBeNull()
    if (!holder) throw new Error('failed to acquire lock externally')

    let observedRefreshToken: string | undefined
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: { readManifest: () => Promise.resolve(emptyManifest()) },
      refreshFn: async ({ refreshToken }) => {
        observedRefreshToken = refreshToken
        return {
          access: 'unused',
          refresh: 'unused',
          expires: Date.now() + 3_600_000,
          expiresIn: 3600,
        }
      },
    })

    const storage = (await loadAccounts(cfgPath))!
    const refreshPromise = manager.refreshAccount(account, storage, {
      force: true,
    })

    // Wait long enough for the waiter to be inside its first poll cycle, then
    // tombstone the storage on disk. The poll picks up the new state on its
    // next read.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const tombstoned = (await loadAccounts(cfgPath))!
    const target = tombstoned.accounts.find((a) => a.id === accountId) as
      | OAuthAccount
      | undefined
    expect(target).toBeDefined()
    if (target && target.type === 'oauth') {
      target.access = TOMBSTONE_OPENAI
      target.refresh = TOMBSTONE_OPENAI
      target.expires = 0
    }
    await saveAccounts(tombstoned, cfgPath)

    let thrown: unknown
    try {
      await refreshPromise
    } catch (e) {
      thrown = e
    }

    await holder.release()

    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
    // Sentinel must NEVER reach refreshFn.
    expect(observedRefreshToken).not.toBe(TOMBSTONE_OPENAI)
  })

  it('manifest-only change while polling → throws before any return', async () => {
    const accountId = 'waiter-poll'
    const account = liveAccount(accountId, { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    const holder = await acquireLockExternally(accountId)
    expect(holder).not.toBeNull()
    if (!holder) throw new Error('failed to acquire lock externally')

    let manifestMode: 'empty' | 'enrolled' = 'empty'
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: {
        readManifest: () =>
          Promise.resolve(
            manifestMode === 'empty'
              ? emptyManifest()
              : enrollmentManifest(accountId),
          ),
      },
      refreshFn: async () => {
        return {
          access: 'unused',
          refresh: 'unused',
          expires: Date.now() + 3_600_000,
          expiresIn: 3600,
        }
      },
    })

    const storage = (await loadAccounts(cfgPath))!
    const refreshPromise = manager.refreshAccount(account, storage, {
      force: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    manifestMode = 'enrolled' // local mode is implicit when claustrum is omitted

    let thrown: unknown
    try {
      await refreshPromise
    } catch (e) {
      thrown = e
    }

    await holder.release()

    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
  })
})

// ---------------------------------------------------------------------------
// Backoff key — permanent error + changed refresh token → attempts again
// ---------------------------------------------------------------------------

describe('refresh backoff keyed by refresh-token hash', () => {
  // The non-force path is the only path that consults refreshBackoffActive.
  // Driving `refreshDueAccounts` (or any caller that lets the per-call
  // backoff check run) is the only way to exercise the hash-keying —
  // `refreshAccount({force:true})` short-circuits before the check and
  // would never observe a key mismatch.
  it('permanent error stamped on T1 + storage token now T2 → refreshDueAccounts attempts again', async () => {
    const now = 1_700_000_000_000
    const account = liveAccount('bk-1', {
      access: 'old-access',
      refresh: 'T2-fresh',
      expires: now - 1_000, // expired → due path runs the backoff check
      lastRefreshError: {
        message: 'Token refresh failed: 401',
        checkedAt: now - 60_000,
        nextRetryAt: now + 24 * 60 * 60_000, // 24h permanent backoff window
        retryCount: 1,
        tokenHash:
          // sha256("T1-stale") — distinct from the storage's current T2 hash.
          '0'.repeat(64),
      },
    })
    await saveAccounts(liveStorage([account]), cfgPath)

    let refreshFnCalls = 0
    let observedRefreshToken: string | undefined
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      now: () => now,
      custody: { readManifest: () => Promise.resolve(emptyManifest()) },
      refreshFn: async ({ refreshToken }) => {
        refreshFnCalls++
        observedRefreshToken = refreshToken
        return {
          access: 'T2-rotated-access',
          refresh: 'T2-rotated-refresh',
          expires: now + 3_600_000,
          expiresIn: 3600,
        }
      },
    })

    await manager.refreshDueAccounts()
    // Token-hash mismatch on the backoff key is the bypass: the account's
    // current refresh token (T2) does not hash to the key the error was
    // stamped with (T1), so the backoff is inert.
    expect(refreshFnCalls).toBe(1)
    expect(observedRefreshToken).toBe('T2-fresh')
  })
})

// ---------------------------------------------------------------------------
// Exports consumed by the enroll verb
// ---------------------------------------------------------------------------

describe('lock-name + TTL exports for the refresh choke point', () => {
  it('exports FALLBACK_REFRESH_LOCK_TTL_MS and fallbackRefreshLockName', async () => {
    const mod = await import('../core/accounts.ts')
    expect(typeof mod.FALLBACK_REFRESH_LOCK_TTL_MS).toBe('number')
    expect(typeof mod.fallbackRefreshLockName).toBe('function')
    expect(mod.FALLBACK_REFRESH_LOCK_TTL_MS).toBe(10 * 60_000)
    expect(
      mod.fallbackRefreshLockName('a').startsWith('fallback-oauth-refresh-'),
    ).toBe(true)
  })
})
