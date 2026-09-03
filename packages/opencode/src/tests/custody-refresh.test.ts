/**
 * Phase 5 — Custody refresh gates (plan task 3).
 *
 * Each local fallback refresh path must refuse to invoke the injected refresh
 * provider when the account is `refreshInert` (custody-manifest entry OR
 * tombstone sentinel in storage), regardless of `claustrum.enabled`. The
 * storage toggle never participates in this gate: enabling or disabling it
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
 * Each mutation listed in the plan's mutation table is exercised by the
 * standard RED-then-GREEN run: applying the mutation makes the relevant test
 * fail RED; reverting returns it to GREEN. The named tests here are the
 * witnesses the gate run references when confirming the mutation cycle.
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
import {
  CUSTODY_TOMBSTONE_PREFIX,
  CustodyTombstoneRefreshError,
} from '../core/custody.ts'
import type { CustodyManifestReadResult } from '../core/custody-manifest.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_CLAUSTRUM_HANDLES,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

const TOMBSTONE_OPENAI = `${CUSTODY_TOMBSTONE_PREFIX}openai`
const CUSTODY_PROVIDER = 'openai'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSentinelAccount(
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id: 'custody-1',
    type: 'oauth',
    access: TOMBSTONE_OPENAI,
    refresh: TOMBSTONE_OPENAI,
    expires: 0,
    addedAt: 1_000,
    ...overrides,
  }
}

function liveAccount(
  id: string,
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `acc-${id}`,
    refresh: `ref-${id}`,
    expires: Date.now() + 3_600_000,
    addedAt: 1_000,
    ...overrides,
  }
}

function liveStorage(
  accounts: OAuthAccount[],
  overrides: Partial<AccountStorage> = {},
): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts,
    ...overrides,
  }
}

function emptyManifest(): CustodyManifestReadResult {
  return { ok: true, value: { version: 1, providers: [] } }
}

function enrollmentManifest(label: string): CustodyManifestReadResult {
  const handle = `ckh_${'a'.repeat(43)}`
  return {
    ok: true,
    value: {
      version: 1,
      providers: [
        {
          provider: CUSTODY_PROVIDER,
          shape: 'oauth',
          serve: 'openai-auth',
          accounts: [{ label, handle, credential_id: `oauth:openai:${label}` }],
        },
      ],
    },
  }
}

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
// 2a — Choke point: refreshAccountNow throws on refreshInert
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

    // Mutation witness: removing the choke-point assertion lets refreshFn
    // observe the sentinel as the refresh token. The assertion below fires
    // RED until the gate is in place.
    expect(refreshFnCalls).toBe(0)
    expect(observedRefreshToken).toBeUndefined()
    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
  })

  it('enrolled manifest account (live storage, toggle off) → throws before refreshFn', async () => {
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
})

// ---------------------------------------------------------------------------
// Manager entry gates — four groups
// ---------------------------------------------------------------------------

async function _makeManager(opts: {
  refreshFn?: AccountManagerOptions['refreshFn']
  readManifest?: () => Promise<CustodyManifestReadResult>
}): Promise<{
  manager: FallbackAccountManager
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
  const manager = new FallbackAccountManager({
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
    expect(usable).toEqual([])
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
// D11 — enrolled + claustrum.enabled=false + live secret → ZERO refreshFn
// ---------------------------------------------------------------------------

describe('D11: enrolled + claustrum.enabled=false → skip local refresh', () => {
  it('getUsableFallbackAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('d11-1', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)
    const storage = (await loadAccounts(cfgPath))!

    const { manager: rawManager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('d11-1')),
    })

    await rawManager.getUsableFallbackAccounts(storage)
    expect(refreshCalls()).toBe(0)
    expect(rawManager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshDueAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('d11-2', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('d11-2')),
    })

    await manager.refreshDueAccounts()
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshQuotaForDueAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('d11-3', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('d11-3')),
    })

    await manager.refreshQuotaForDueAccounts()
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })

  it('refreshQuotaForAllAccounts: ZERO refreshFn calls', async () => {
    const account = liveAccount('d11-4', { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    const { manager, refreshCalls } = await makeSpyManager({
      readManifest: () => Promise.resolve(enrollmentManifest('d11-4')),
    })

    await manager.refreshQuotaForAllAccounts({ force: true })
    expect(refreshCalls()).toBe(0)
    expect(manager.refreshAccountCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2g — error writers ignore CustodyTombstoneRefreshError
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
// 10d — waiter (waitForConcurrentFallbackRefresh) per-poll refreshInert re-check
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
  it('10d: force:true caller enters before the tombstone, lands inside the wait → throws', async () => {
    const accountId = 'waiter-10d'
    const account = liveAccount(accountId, { expires: Date.now() - 1_000 })
    await saveAccounts(liveStorage([account]), cfgPath)

    const holder = await acquireLockExternally(accountId)
    expect(holder).not.toBeNull()
    if (!holder) throw new Error('failed to acquire lock externally')

    let _refreshFnCalls = 0
    let observedRefreshToken: string | undefined
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      custody: { readManifest: () => Promise.resolve(emptyManifest()) },
      refreshFn: async ({ refreshToken }) => {
        _refreshFnCalls++
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

  it('D11 (waiter): manifest-only change while polling → throws before any return', async () => {
    const accountId = 'waiter-d11'
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
    manifestMode = 'enrolled' // claustrum.enabled:false is implicit (omitted)

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
  it('permanent error stamped on T1 + storage token now T2 → refreshFn invoked', async () => {
    const now = 1_700_000_000_000
    const account = liveAccount('bk-1', {
      access: 'old-access',
      refresh: 'T2-fresh',
      expires: now - 1_000,
      lastRefreshError: {
        message: 'Token refresh failed: 401',
        checkedAt: now - 60_000,
        nextRetryAt: now + 24 * 60 * 60_000,
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

    const storage = (await loadAccounts(cfgPath))!
    await manager.refreshAccount(account, storage, { force: true })
    expect(refreshFnCalls).toBe(1)
    expect(observedRefreshToken).toBe('T2-fresh')
  })
})

// ---------------------------------------------------------------------------
// Exports — task 8 reads these
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
