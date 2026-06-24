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
})
