import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

describe('mutateAccounts (authoritative structural edits)', () => {
  function oauth(id: string): OAuthAccount {
    return {
      id,
      type: 'oauth',
      access: `acc-${id}`,
      refresh: `ref-${id}`,
      expires: Date.now() + 3600_000,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }
  }

  it('removal persists and is NOT resurrected by a load/save round-trip', async () => {
    const { loadAccounts, saveAccounts, mutateAccounts } = await import(
      '../core/accounts.ts'
    )
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauth('a'), oauth('b'), oauth('c')],
      },
      cfgPath,
    )

    await mutateAccounts((current) => {
      const idx = current.accounts.findIndex((a) => a.id === 'b')
      current.accounts.splice(idx, 1)
      return current
    }, cfgPath)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id)).toEqual(['a', 'c'])

    // The config file on disk must also no longer contain the removed id —
    // proving the deletion was authoritative, not just an in-memory filter.
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id)).toEqual(['a', 'c'])

    // The state file is rebuilt from the authoritative account set, so the
    // removed account's per-account secrets must not linger at rest — a stale
    // access/refresh token for a deleted account is a credential leak.
    const stateRaw = readFileSync(statePath, 'utf8')
    const state = JSON.parse(stateRaw)
    expect(Object.keys(state.accounts ?? {}).sort()).toEqual(['a', 'c'])
    expect(state.accounts?.b).toBeUndefined()
    // Parsed exact-secret check (not just substring): no surviving entry may
    // carry the removed account's tokens.
    for (const entry of Object.values(
      state.accounts as Record<string, { access?: string; refresh?: string }>,
    )) {
      expect(entry.access).not.toBe('acc-b')
      expect(entry.refresh).not.toBe('ref-b')
    }
  })

  it('saveAccountState with a stale snapshot does NOT re-add a removed account to state (incl. api-key)', async () => {
    const { loadAccounts, saveAccounts, mutateAccounts, saveAccountState } =
      await import('../core/accounts.ts')
    const apiAccount = {
      id: 'api-1',
      type: 'api' as const,
      apiKey: 'sk-secret-api-1',
      baseURL: 'https://example.test',
      enabled: true,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }
    const initial = {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      accounts: [oauth('a'), oauth('b'), apiAccount],
    }
    await saveAccounts(initial, cfgPath)

    // Background worker holds a stale snapshot (still has b + api-1).
    const stale = (await loadAccounts(cfgPath))!

    // b and api-1 are removed authoritatively.
    await mutateAccounts((current) => {
      current.accounts = current.accounts.filter((acc) => acc.id === 'a')
      return current
    }, cfgPath)

    // Stale worker writes state (default scope accounts:true). The roster gate
    // must drop the removed ids instead of re-writing their secrets.
    await saveAccountState(stale, cfgPath)

    const stateRaw = readFileSync(statePath, 'utf8')
    const state = JSON.parse(stateRaw)
    expect(Object.keys(state.accounts ?? {}).sort()).toEqual(['a'])
    expect(stateRaw).not.toContain('ref-b')
    expect(stateRaw).not.toContain('sk-secret-api-1')
  })

  it('saveAccountState prunes a pre-existing orphan state entry absent from config', async () => {
    const { saveAccounts, saveAccountState } = await import(
      '../core/accounts.ts'
    )
    // Config roster = [a]; but the state file already has an orphan b at rest
    // (e.g. left by an earlier crash between the config and state writes).
    await saveAccounts(
      {
        version: 1 as const,
        main: { type: 'opencode' as const, provider: 'openai' as const },
        accounts: [oauth('a')],
      },
      cfgPath,
    )
    const orphanState = {
      version: 1,
      accounts: {
        a: { access: 'acc-a', refresh: 'ref-a' },
        b: { access: 'acc-b', refresh: 'ref-b' },
      },
    }
    writeFileSync(statePath, `${JSON.stringify(orphanState)}\n`)

    // Any state write (here scoped to main quota) must prune the orphan b.
    await saveAccountState(
      {
        version: 1 as const,
        main: { type: 'opencode' as const, provider: 'openai' as const },
        accounts: [oauth('a')],
      },
      cfgPath,
    )

    const stateRaw = readFileSync(statePath, 'utf8')
    expect(JSON.parse(stateRaw).accounts?.b).toBeUndefined()
    expect(stateRaw).not.toContain('ref-b')
  })

  it('reordering persists (union-merge would have ignored it)', async () => {
    const { loadAccounts, saveAccounts, mutateAccounts } = await import(
      '../core/accounts.ts'
    )
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauth('x'), oauth('y'), oauth('z')],
      },
      cfgPath,
    )

    // Swap x and z.
    await mutateAccounts((current) => {
      const tmp = current.accounts[0]!
      current.accounts[0] = current.accounts[2]!
      current.accounts[2] = tmp
      return current
    }, cfgPath)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id)).toEqual(['z', 'y', 'x'])
  })

  it('preserves a concurrent add committed by another writer before the lock', async () => {
    const { loadAccounts, saveAccounts, mutateAccounts } = await import(
      '../core/accounts.ts'
    )
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauth('keep')],
      },
      cfgPath,
    )

    // Hold the save lock so the mutate call blocks until we release it.
    const lock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: cfgPath,
    })
    expect(lock).not.toBeNull()

    // Start a removal of 'keep' — it will block on the lock.
    const mutate = mutateAccounts((current) => {
      const idx = current.accounts.findIndex((a) => a.id === 'keep')
      if (idx !== -1) current.accounts.splice(idx, 1)
      return current
    }, cfgPath)

    // While blocked, another writer commits a brand-new account directly to disk
    // (writeFile, not saveAccounts — saveAccounts would block on the same lock).
    await new Promise((r) => setTimeout(r, 50))
    await writeFile(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [
          { id: 'keep', type: 'oauth', enabled: true },
          { id: 'concurrent', type: 'oauth', enabled: true },
        ],
      })}\n`,
    )
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        accounts: {
          keep: oauth('keep'),
          concurrent: oauth('concurrent'),
        },
      })}\n`,
    )

    await lock?.release()
    await mutate

    // mutateAccounts read the freshest state under the lock, so it removed
    // 'keep' WITHOUT losing the concurrently-added 'concurrent'.
    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id).sort()).toEqual(['concurrent'])
  })
})
