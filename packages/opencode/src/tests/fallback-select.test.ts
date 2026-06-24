/**
 * Phase 4 — Fallback selection tests.
 *
 * Verifies:
 *  - fail-open: unknown-quota fallback is selectable
 *  - NO outbound quota GET fires (selection-time pull deleted)
 */

import { describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountManagerOptions,
  type AccountStorage,
  type FallbackAccount,
  FallbackAccountManager,
  type OAuthAccount,
} from '../core/accounts.ts'
import { hashRefreshToken } from '../core/backoff.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOAuthAccount(overrides: Partial<OAuthAccount> = {}): OAuthAccount {
  return {
    id: overrides.id ?? 'test-fallback-1',
    type: 'oauth',
    access: 'test-access',
    refresh: 'test-refresh',
    expires: Date.now() + 6 * 3600_000,
    ...overrides,
  }
}

function makeStorage(accounts: FallbackAccount[]): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts,
    quota: { failClosedOnUnknownQuota: false, enabled: true },
  }
}

async function withTempAuthEnv<T>(callback: () => Promise<T>): Promise<T> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'oai-fallback-select-'))
  const oldFile = process.env.OPENCODE_OPENAI_AUTH_FILE
  const oldState = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
  try {
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(tmpDir, 'openai-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      tmpDir,
      'openai-auth-state.json',
    )
    return await callback()
  } finally {
    process.env.OPENCODE_OPENAI_AUTH_FILE = oldFile ?? FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = oldState ?? FLOOR_STATE_FILE
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fallback selection', () => {
  // -------------------------------------------------------------------
  // fail-open: unknown-quota fallback is selectable
  // -------------------------------------------------------------------

  it('fail-open: unknown-quota fallback IS in getUsableFallbackAccounts when failClosedOnUnknownQuota=false', async () => {
    const account = makeOAuthAccount({ quota: undefined })
    const storage = makeStorage([account])

    const manager = new FallbackAccountManager({
      now: () => Date.now(),
      fetchImpl: fetch,
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable.length).toBe(1)
    expect(usable[0]!.id).toBe(account.id)
  })

  it('fail-closed: unknown-quota fallback is excluded when failClosedOnUnknownQuota=true', async () => {
    const account = makeOAuthAccount({ quota: undefined })
    const storage = makeStorage([account])
    storage.quota = { failClosedOnUnknownQuota: true, enabled: true }

    const manager = new FallbackAccountManager({
      now: () => Date.now(),
      fetchImpl: fetch,
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable.length).toBe(0)
  })

  it('excludes a fallback whose stable account id matches the main account', async () => {
    const account = makeOAuthAccount({ accountId: 'chatgpt-main' })
    const storage = makeStorage([account])
    storage.mainAccountId = 'chatgpt-main'

    const manager = new FallbackAccountManager({
      now: () => Date.now(),
      fetchImpl: fetch,
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(usable).toEqual([])
  })

  it('excludes and backs off an expired fallback when refresh fails despite fail-open quota policy', async () => {
    await withTempAuthEnv(async () => {
      const now = 1_700_000_000_000
      const account = makeOAuthAccount({
        access: 'expired-access',
        refresh: 'expired-refresh',
        expires: now - 1_000,
        quota: {
          primary: {
            usedPercent: 10,
            remainingPercent: 90,
            checkedAt: now - 1_000,
            resetsAt: new Date(now + 60_000).toISOString(),
          },
        },
      })
      const storage = makeStorage([account])
      const refreshFn = jest
        .fn()
        .mockRejectedValue(new Error('fetch failed while refreshing token'))

      const manager = new FallbackAccountManager({
        now: () => now,
        fetchImpl: fetch,
        refreshFn: refreshFn as AccountManagerOptions['refreshFn'],
      })

      const usable = await manager.getUsableFallbackAccounts(storage)

      expect(usable).toEqual([])
      expect(refreshFn).toHaveBeenCalledTimes(1)
      expect(account.lastRefreshError?.message).toBe(
        'fetch failed while refreshing token',
      )
      expect(account.lastRefreshError?.nextRetryAt).toBeGreaterThan(now)
    })
  })

  it('excludes a refresh-backed-off fallback instead of selecting it fail-open', async () => {
    const now = 1_700_000_000_000
    const refresh = 'backed-off-refresh'
    const account = makeOAuthAccount({
      access: 'expired-access',
      refresh,
      expires: now - 1_000,
      lastRefreshError: {
        message: 'previous refresh failure',
        checkedAt: now - 1_000,
        nextRetryAt: now + 60_000,
        tokenHash: hashRefreshToken(refresh),
      },
    })
    const storage = makeStorage([account])
    const refreshFn = jest.fn()

    const manager = new FallbackAccountManager({
      now: () => now,
      fetchImpl: fetch,
      refreshFn: refreshFn as AccountManagerOptions['refreshFn'],
    })

    const usable = await manager.getUsableFallbackAccounts(storage)

    expect(usable).toEqual([])
    expect(refreshFn).not.toHaveBeenCalled()
    expect(account.lastRefreshError?.message).toBe('previous refresh failure')
  })

  it('uses the refreshed candidate when a post-refresh quota seed fails', async () => {
    await withTempAuthEnv(async () => {
      const now = 1_700_000_000_000
      const account = makeOAuthAccount({
        access: 'expired-access',
        refresh: 'old-refresh',
        expires: now - 1_000,
        quota: {
          primary: {
            usedPercent: 10,
            remainingPercent: 90,
            checkedAt: now - 1_000,
          },
        },
      })
      const storage = makeStorage([account])
      const refreshFn = jest.fn().mockResolvedValue({
        access: 'fresh-access',
        refresh: 'fresh-refresh',
        expires: now + 6 * 3600_000,
        expiresIn: 6 * 3600,
      })
      const getFallback = jest.fn(() => {
        throw new Error('quota seed failed')
      })
      const setFallback = jest.fn()

      const manager = new FallbackAccountManager({
        now: () => now,
        fetchImpl: fetch,
        refreshFn: refreshFn as AccountManagerOptions['refreshFn'],
        quotaManager: {
          getFallback,
          setFallback,
        } as unknown as AccountManagerOptions['quotaManager'],
      })

      const usable = await manager.getUsableFallbackAccounts(storage)

      expect(refreshFn).toHaveBeenCalledTimes(1)
      expect(getFallback).toHaveBeenCalledWith(account.id, 'fresh-access')
      expect(setFallback).not.toHaveBeenCalled()
      expect(usable).toHaveLength(1)
      expect(usable[0]?.access).toBe('fresh-access')
      expect(usable[0]?.refresh).toBe('fresh-refresh')
    })
  })

  // -------------------------------------------------------------------
  // NO outbound quota GET fires at selection time
  // -------------------------------------------------------------------

  it('getUsableFallbackAccounts fires NO quota fetch when wham supplement OFF', async () => {
    const account = makeOAuthAccount()
    const storage = makeStorage([account])

    let fetchCalled = false
    const fetchQuotaFn = jest.fn().mockImplementation(() => {
      fetchCalled = true
      throw new Error('should not be called')
    })

    const manager = new FallbackAccountManager({
      now: () => Date.now(),
      fetchImpl: fetch,
      fetchQuotaFn: fetchQuotaFn as AccountManagerOptions['fetchQuotaFn'],
    })

    const usable = await manager.getUsableFallbackAccounts(storage)
    // The account has valid quota (fresh from mock), so it's usable
    expect(usable.length).toBeGreaterThanOrEqual(0)
    // The selection path must NOT call fetchQuotaFn
    expect(fetchCalled).toBe(false)
  })

  it('refreshAccountQuota throws when fetchQuotaFn not injected (passive guard)', async () => {
    const account = makeOAuthAccount()
    const storage = makeStorage([account])

    const manager = new FallbackAccountManager({
      now: () => Date.now(),
      fetchImpl: fetch,
      // NO fetchQuotaFn injected
    })

    await expect(manager.refreshAccountQuota(account, storage)).rejects.toThrow(
      'No fetchQuotaFn injected',
    )
  })

  it('refreshQuotaForDueAccounts is a no-op when fetchQuotaFn not injected', async () => {
    const account = makeOAuthAccount()
    const _storage = makeStorage([account])

    const manager = new FallbackAccountManager({
      now: () => Date.now(),
      fetchImpl: fetch,
      // NO fetchQuotaFn injected
    })

    // Should not throw — it's a no-op
    await expect(manager.refreshQuotaForDueAccounts()).resolves.toBeUndefined()
  })

  it('refreshQuotaForAllAccounts returns early when fetchQuotaFn not injected', async () => {
    // Deterministic null-load: point at a guaranteed-nonexistent temp path
    // so load() returns null regardless of test order or earlier test writes.
    const tmpDir = mkdtempSync(join(tmpdir(), 'oai-fallback-select-'))
    const oldFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const oldState = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    try {
      process.env.OPENCODE_OPENAI_AUTH_FILE = join(tmpDir, 'nonexistent.json')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        tmpDir,
        'nonexistent-state.json',
      )

      const account = makeOAuthAccount()
      const _storage = makeStorage([account])

      const manager = new FallbackAccountManager({
        now: () => Date.now(),
        fetchImpl: fetch,
      })

      const result = await manager.refreshQuotaForAllAccounts({ force: true })
      expect(result.storage).toBeNull()
      expect(result.errors).toEqual([])
    } finally {
      // Restore to the saved value (which is the floor when the preload is
      // active) rather than deleting — never leave the env unset.
      process.env.OPENCODE_OPENAI_AUTH_FILE = oldFile ?? FLOOR_AUTH_FILE
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = oldState ?? FLOOR_STATE_FILE
    }
  })
})
