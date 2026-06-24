import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  loadAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
} from '../core/accounts.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

let dir: string
let cfgPath: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-account-runtime-'))
  cfgPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = cfgPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
})

afterEach(() => {
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  rmSync(dir, { recursive: true, force: true })
})

function quotaAt(checkedAt: number): OAuthAccount['quota'] {
  return {
    primary: {
      usedPercent: 25,
      remainingPercent: 75,
      checkedAt,
    },
  }
}

function makeStorage(account: OAuthAccount): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts: [account],
  }
}

describe('account runtime state merge', () => {
  it('does not roll back a rotated token when a stale snapshot later saves newer quota', async () => {
    const original: OAuthAccount = {
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access-token',
      refresh: 'old-refresh-token',
      expires: 1_700_000_100_000,
      lastRefreshedAt: 1_700_000_000_000,
      quota: quotaAt(100),
    }
    await saveAccounts(makeStorage(original), cfgPath)

    const rotated: OAuthAccount = {
      ...original,
      access: 'new-access-token',
      refresh: 'new-refresh-token',
      expires: 1_700_003_600_000,
      lastRefreshedAt: 1_700_000_500_000,
      quota: quotaAt(100),
    }
    await saveAccountState(makeStorage(rotated), cfgPath)

    const staleSnapshotWithNewerQuota: OAuthAccount = {
      ...original,
      quota: quotaAt(1_700_000_600_000),
    }
    await saveAccountState(makeStorage(staleSnapshotWithNewerQuota), cfgPath)

    const loaded = await loadAccounts(cfgPath)
    const account = loaded?.accounts[0] as OAuthAccount

    expect(account.access).toBe('new-access-token')
    expect(account.refresh).toBe('new-refresh-token')
    expect(account.expires).toBe(1_700_003_600_000)
    expect(account.lastRefreshedAt).toBe(1_700_000_500_000)
    expect(account.quota?.primary?.checkedAt).toBe(1_700_000_600_000)
  })

  it('preserves a later-expiry token without lastRefreshedAt when a stale save has newer quota', async () => {
    const freshWithoutRefreshTime: OAuthAccount = {
      id: 'fallback-absent-refresh-time',
      type: 'oauth',
      access: 'fresh-access-token',
      refresh: 'fresh-refresh-token',
      expires: 1_700_003_600_000,
      quota: quotaAt(100),
    }
    await saveAccounts(makeStorage(freshWithoutRefreshTime), cfgPath)

    const staleWithNewerQuota: OAuthAccount = {
      id: freshWithoutRefreshTime.id,
      type: 'oauth',
      access: 'stale-access-token',
      refresh: 'stale-refresh-token',
      expires: 1_700_000_100_000,
      quota: quotaAt(1_700_000_600_000),
    }
    await saveAccountState(makeStorage(staleWithNewerQuota), cfgPath)

    const loaded = await loadAccounts(cfgPath)
    const account = loaded?.accounts[0] as OAuthAccount

    expect(account.access).toBe('fresh-access-token')
    expect(account.refresh).toBe('fresh-refresh-token')
    expect(account.expires).toBe(1_700_003_600_000)
    expect(account.lastRefreshedAt).toBeUndefined()
    expect(account.quota?.primary?.checkedAt).toBe(1_700_000_600_000)
  })

  it('uses expires as the token tie-breaker when lastRefreshedAt values match', async () => {
    const laterExpiry: OAuthAccount = {
      id: 'fallback-equal-refresh-time',
      type: 'oauth',
      access: 'later-expiry-access-token',
      refresh: 'later-expiry-refresh-token',
      expires: 1_700_003_600_000,
      lastRefreshedAt: 1_700_000_000_000,
      quota: quotaAt(100),
    }
    await saveAccounts(makeStorage(laterExpiry), cfgPath)

    const staleEqualRefreshTime: OAuthAccount = {
      id: laterExpiry.id,
      type: 'oauth',
      access: 'earlier-expiry-access-token',
      refresh: 'earlier-expiry-refresh-token',
      expires: 1_700_000_100_000,
      lastRefreshedAt: laterExpiry.lastRefreshedAt,
      quota: quotaAt(1_700_000_600_000),
    }
    await saveAccountState(makeStorage(staleEqualRefreshTime), cfgPath)

    const loaded = await loadAccounts(cfgPath)
    const account = loaded?.accounts[0] as OAuthAccount

    expect(account.access).toBe('later-expiry-access-token')
    expect(account.refresh).toBe('later-expiry-refresh-token')
    expect(account.expires).toBe(1_700_003_600_000)
    expect(account.lastRefreshedAt).toBe(1_700_000_000_000)
    expect(account.quota?.primary?.checkedAt).toBe(1_700_000_600_000)
  })

  it('keeps the winning token lastRefreshError when token timestamps tie', async () => {
    const accountWithBackoff: OAuthAccount = {
      id: 'fallback-refresh-error',
      type: 'oauth',
      access: 'backed-off-access-token',
      refresh: 'backed-off-refresh-token',
      expires: 1_700_003_600_000,
      lastRefreshError: {
        message: 'active refresh backoff',
        checkedAt: 1_700_000_000_000,
        nextRetryAt: 1_700_000_300_000,
      },
      quota: quotaAt(100),
    }
    await saveAccounts(makeStorage(accountWithBackoff), cfgPath)

    const staleWithoutError: OAuthAccount = {
      id: accountWithBackoff.id,
      type: 'oauth',
      access: accountWithBackoff.access,
      refresh: accountWithBackoff.refresh,
      expires: accountWithBackoff.expires,
      quota: quotaAt(1_700_000_600_000),
    }
    await saveAccountState(makeStorage(staleWithoutError), cfgPath)

    const loaded = await loadAccounts(cfgPath)
    const account = loaded?.accounts[0] as OAuthAccount

    expect(account.lastRefreshError?.message).toBe('active refresh backoff')
    expect(account.lastRefreshError?.nextRetryAt).toBe(1_700_000_300_000)
    expect(account.quota?.primary?.checkedAt).toBe(1_700_000_600_000)
  })
})
