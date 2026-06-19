import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountStorage, OAuthAccount } from '../core/accounts.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

let dir: string
let cfgPath: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-acct-'))
  cfgPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = cfgPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
})

afterEach(() => {
  // Restore to the floor (not delete) so any in-flight write resolves to a
  // temp path rather than the operator's live default.
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('accounts store', () => {
  it('load/save round-trip: accounts, main provider, version', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    const account: OAuthAccount = {
      id: randomUUID(),
      type: 'oauth',
      access: 'acc-token',
      refresh: 'ref-token',
      expires: Date.now() + 3600_000,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }

    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [account],
    }

    await saveAccounts(storage, cfgPath)
    expect(existsSync(cfgPath)).toBe(true)
    expect(existsSync(statePath)).toBe(true)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.main?.provider).toBe('openai')
    expect(loaded!.accounts.length).toBe(1)
    expect(loaded!.accounts[0]!.type).toBe('oauth')
    expect((loaded!.accounts[0] as OAuthAccount).refresh).toBe('ref-token')

    // Secrets are NOT in the config file (state-only)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts[0].refresh).toBeUndefined()
    expect(cfg.accounts[0].access).toBeUndefined()

    // Secrets ARE in the state file
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.accounts[account.id].refresh).toBe('ref-token')
    expect(state.accounts[account.id].access).toBe('acc-token')
  })

  it('state file has 0600 permissions', async () => {
    const { saveAccounts } = await import('../core/accounts.ts')
    const { statSync } = await import('node:fs')

    const account: OAuthAccount = {
      id: randomUUID(),
      type: 'oauth',
      access: 'acc-token',
      refresh: 'ref-token',
      expires: Date.now() + 3600_000,
    }

    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [account],
    }

    await saveAccounts(storage, cfgPath)
    const mode = statSync(statePath).mode & 0o777
    // 0600 or 0o600 — on some systems umask may apply; at minimum the file must NOT be world-readable
    expect(mode & 0o077).toBe(0)
    expect(mode & 0o400).toBe(0o400) // owner read
  })

  it('atomic write: no partial/tmp file left behind', async () => {
    const { saveAccounts } = await import('../core/accounts.ts')
    const { readdirSync } = await import('node:fs')

    const account: OAuthAccount = {
      id: randomUUID(),
      type: 'oauth',
      access: 'acc-token',
      refresh: 'ref-token',
      expires: Date.now() + 3600_000,
    }

    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [account],
    }

    await saveAccounts(storage, cfgPath)

    // No .tmp files left behind
    const files = readdirSync(dir)
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
    expect(tmpFiles.length).toBe(0)
  })

  it('saveAccountState writes state that loadAccounts merges back', async () => {
    const { saveAccounts, saveAccountState, loadAccounts } = await import(
      '../core/accounts.ts'
    )

    const acct1: OAuthAccount = {
      id: 'id-1',
      type: 'oauth',
      refresh: 'ref-1',
      access: 'acc-1',
      expires: Date.now() + 3600_000,
    }

    const acct2: OAuthAccount = {
      id: 'id-2',
      type: 'oauth',
      refresh: 'ref-2',
      access: 'acc-2',
      expires: Date.now() + 3600_000,
    }

    // Save both accounts via saveAccounts (writes config + state)
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [acct1, acct2],
    }
    await saveAccounts(storage, cfgPath)

    // Now update only acct2's state via saveAccountState
    const updatedAcct2: OAuthAccount = {
      ...acct2,
      access: 'acc-2-updated',
      lastUsed: Date.now(),
    }
    const updateStorage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [acct1, updatedAcct2],
    }
    await saveAccountState(updateStorage, cfgPath)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded!.accounts.length).toBe(2)

    // acct2 access token should be the updated one from state
    const loadedAcct2 = loaded!.accounts.find(
      (a) => a.id === 'id-2',
    ) as OAuthAccount
    expect(loadedAcct2.access).toBe('acc-2-updated')

    // acct1 should be unchanged
    const loadedAcct1 = loaded!.accounts.find(
      (a) => a.id === 'id-1',
    ) as OAuthAccount
    expect(loadedAcct1.access).toBe('acc-1')
  })

  it('saveAccounts waits for the file lock and merges with the latest on-disk accounts', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    const staleAccount: OAuthAccount = {
      id: 'stale-writer',
      type: 'oauth',
      access: 'acc-stale',
      refresh: 'ref-stale',
      expires: Date.now() + 3600_000,
    }
    const latestAccount: OAuthAccount = {
      id: 'latest-writer',
      type: 'oauth',
      access: 'acc-latest',
      refresh: 'ref-latest',
      expires: Date.now() + 3600_000,
    }

    const lock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: cfgPath,
    })
    expect(lock).not.toBeNull()

    let settled = false
    const staleSave = saveAccounts(
      { version: 1, accounts: [staleAccount] },
      cfgPath,
    ).finally(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    await writeFile(
      cfgPath,
      `${JSON.stringify({ version: 1, accounts: [{ id: latestAccount.id, type: 'oauth', enabled: true }] })}\n`,
    )
    await writeFile(
      statePath,
      `${JSON.stringify({ version: 1, accounts: { [latestAccount.id]: latestAccount } })}\n`,
    )

    await lock?.release()
    await staleSave

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((account) => account.id).sort()).toEqual([
      'latest-writer',
      'stale-writer',
    ])
  })
})
