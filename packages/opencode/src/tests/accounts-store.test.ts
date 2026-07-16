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
import type {
  AccountManagerOptions,
  AccountStorage,
  OAuthAccount,
} from '../core/accounts.ts'
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

function oauthAccount(
  id: string,
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `acc-${id}`,
    refresh: `ref-${id}`,
    expires: Date.now() + 3600_000,
    addedAt: Date.now(),
    lastUsed: Date.now(),
    ...overrides,
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FallbackAccountManagerConstructor =
  typeof import('../core/accounts.ts').FallbackAccountManager
type MutateAccountsFn = typeof import('../core/accounts.ts').mutateAccounts

function createManagerRemovingAccountOnFirstLoad(
  FallbackAccountManagerCtor: FallbackAccountManagerConstructor,
  mutateAccounts: MutateAccountsFn,
  accountId: string,
  configPath: string,
  options: AccountManagerOptions,
) {
  class RemovingManager extends FallbackAccountManagerCtor {
    private removed = false

    override async load() {
      const loaded = await super.load()
      if (!this.removed) {
        this.removed = true
        await mutateAccounts((current) => {
          current.accounts = current.accounts.filter(
            (candidate) => candidate.id !== accountId,
          )
          return current
        }, configPath)
      }
      return loaded
    }
  }

  return new RemovingManager(options)
}

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

  it('round-trips optional dynamic quota metadata through the runtime state file', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')
    const account = oauthAccount('quota-metadata', {
      quota: {
        primary: {
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: '2026-07-23T00:00:00.000Z',
          checkedAt: 1_752_710_400_000,
          windowMinutes: 10_080,
        },
        resetCreditsAvailable: 4,
      },
    })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
      },
      cfgPath,
    )

    const loaded = await loadAccounts(cfgPath)
    const quota = (loaded?.accounts[0] as OAuthAccount).quota
    expect(quota?.primary?.windowMinutes).toBe(10_080)
    expect(quota?.resetCreditsAvailable).toBe(4)
  })

  it('loads an older quota snapshot without dynamic metadata', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')
    const account = oauthAccount('old-quota', {
      quota: {
        primary: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 1_752_710_400_000,
        },
      },
    })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
      },
      cfgPath,
    )

    const loaded = await loadAccounts(cfgPath)
    const quota = (loaded?.accounts[0] as OAuthAccount).quota
    expect(quota?.primary?.windowMinutes).toBeUndefined()
    expect(quota?.resetCreditsAvailable).toBeUndefined()
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

describe('account store migration locking', () => {
  it('serializes first-run migration with a concurrent structural add', async () => {
    const { loadAccounts, migrateIfNeeded, mutateAccounts } = await import(
      '../core/accounts.ts'
    )
    writeFileSync(
      cfgPath,
      `${JSON.stringify({ webSockets: true, dump: false })}\n`,
    )

    const lock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: cfgPath,
    })
    expect(lock).not.toBeNull()

    let migrationSettled = false
    let mutationSettled = false
    const existingToken = {
      type: 'oauth' as const,
      access: 'existing-access',
      refresh: 'existing-refresh',
      expires: Date.now() + 3600_000,
    }
    const migration = migrateIfNeeded(existingToken, cfgPath).finally(() => {
      migrationSettled = true
    })
    const addFallback = mutateAccounts((current) => {
      current.accounts.push(oauthAccount('concurrent-fallback'))
      return current
    }, cfgPath).finally(() => {
      mutationSettled = true
    })

    try {
      await wait(75)
      expect(migrationSettled).toBe(false)
      expect(mutationSettled).toBe(false)
    } finally {
      await lock?.release()
    }

    await Promise.race([
      Promise.all([migration, addFallback]),
      wait(5_000).then(() => {
        throw new Error('migration and structural add did not complete')
      }),
    ])

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.main?.provider).toBe('openai')
    expect(loaded?.accounts.map((account) => account.id)).toContain(
      'concurrent-fallback',
    )

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.version).toBe(1)
    expect(Array.isArray(cfg.accounts)).toBe(true)
    expect(cfg.webSockets).toBe(true)
  })

  it('leaves an already migrated store unchanged on a second migration', async () => {
    const { migrateIfNeeded } = await import('../core/accounts.ts')
    writeFileSync(cfgPath, `${JSON.stringify({ webSockets: true })}\n`)

    await migrateIfNeeded(
      {
        type: 'oauth' as const,
        access: 'first-access',
        refresh: 'first-refresh',
        expires: Date.now() + 3600_000,
      },
      cfgPath,
    )
    const firstConfig = readFileSync(cfgPath, 'utf8')
    const firstState = readFileSync(statePath, 'utf8')

    await migrateIfNeeded(
      {
        type: 'oauth' as const,
        access: 'second-access',
        refresh: 'second-refresh',
        expires: Date.now() + 3600_000,
      },
      cfgPath,
    )

    expect(readFileSync(cfgPath, 'utf8')).toBe(firstConfig)
    expect(readFileSync(statePath, 'utf8')).toBe(firstState)
  })
})

describe('removed fallback refresh guard', () => {
  it('throws a distinct error and avoids the refresh call after removal', async () => {
    const {
      AccountRemovedDuringRefreshError,
      FallbackAccountManager,
      loadAccounts,
      mutateAccounts,
      saveAccounts,
    } = await import('../core/accounts.ts')
    const now = 1_700_000_000_000
    const account = oauthAccount('removed-during-refresh', {
      access: 'stale-access',
      refresh: 'stale-refresh',
      expires: now - 1_000,
    })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
      },
      cfgPath,
    )
    const snapshot = (await loadAccounts(cfgPath))!
    let refreshCalls = 0

    const manager = createManagerRemovingAccountOnFirstLoad(
      FallbackAccountManager,
      mutateAccounts,
      account.id,
      cfgPath,
      {
        configPath: cfgPath,
        now: () => now,
        refreshFn: async () => {
          refreshCalls++
          return {
            access: 'fresh-access',
            refresh: 'fresh-refresh',
            expires: now + 3600_000,
            expiresIn: 3600,
          }
        },
      },
    )

    let thrown: unknown
    try {
      await manager.refreshAccount(
        snapshot.accounts[0] as OAuthAccount,
        snapshot,
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AccountRemovedDuringRefreshError)
    expect((thrown as { code?: string }).code).toBe(
      'ACCOUNT_REMOVED_DURING_REFRESH',
    )
    expect(refreshCalls).toBe(0)
    expect((await loadAccounts(cfgPath))?.accounts).toEqual([])
  })

  it('rejects and skips an account removed while provider refresh is in flight', async () => {
    const {
      AccountRemovedDuringRefreshError,
      FallbackAccountManager,
      loadAccounts,
      mutateAccounts,
      saveAccounts,
    } = await import('../core/accounts.ts')
    const now = 1_700_000_000_000
    const account = oauthAccount('removed-during-provider-refresh', {
      access: 'expired-access',
      refresh: 'refresh-in-flight',
      expires: now - 1_000,
    })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
        quota: { failClosedOnUnknownQuota: false },
      },
      cfgPath,
    )
    const snapshot = (await loadAccounts(cfgPath))!
    let signalRefreshStarted: (() => void) | undefined
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve
    })
    let resolveRefresh:
      | ((tokens: {
          access: string
          refresh: string
          expires: number
          expiresIn: number
        }) => void)
      | undefined
    const manager = new FallbackAccountManager({
      configPath: cfgPath,
      now: () => now,
      refreshFn: async () => {
        signalRefreshStarted?.()
        return new Promise((resolve) => {
          resolveRefresh = resolve
        })
      },
    })

    const selectionPromise = manager.getUsableFallbackAccounts(snapshot)
    await refreshStarted
    const directRefreshPromise = manager.refreshAccount(
      snapshot.accounts[0] as OAuthAccount,
      snapshot,
    )
    await mutateAccounts((current) => {
      current.accounts = current.accounts.filter(
        (candidate) => candidate.id !== account.id,
      )
      return current
    }, cfgPath)
    resolveRefresh?.({
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      expires: now + 3600_000,
      expiresIn: 3600,
    })

    const [selectionResult, directRefreshResult] = await Promise.allSettled([
      selectionPromise,
      directRefreshPromise,
    ])
    expect(selectionResult.status).toBe('fulfilled')
    expect(
      selectionResult.status === 'fulfilled' ? selectionResult.value : null,
    ).toEqual([])
    expect(directRefreshResult.status).toBe('rejected')
    expect(
      directRefreshResult.status === 'rejected'
        ? directRefreshResult.reason
        : null,
    ).toBeInstanceOf(AccountRemovedDuringRefreshError)
    expect((await loadAccounts(cfgPath))?.accounts).toEqual([])
  })

  it('skips a removed account instead of selecting it through fail-open', async () => {
    const {
      FallbackAccountManager,
      loadAccounts,
      mutateAccounts,
      saveAccounts,
    } = await import('../core/accounts.ts')
    const now = 1_700_000_000_000
    const account = oauthAccount('removed-before-selection', {
      access: 'still-unexpired-access',
      refresh: 'stale-refresh',
      expires: now + 60_000,
    })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
        quota: { failClosedOnUnknownQuota: false },
      },
      cfgPath,
    )
    const snapshot = (await loadAccounts(cfgPath))!
    let refreshCalls = 0

    const manager = createManagerRemovingAccountOnFirstLoad(
      FallbackAccountManager,
      mutateAccounts,
      account.id,
      cfgPath,
      {
        configPath: cfgPath,
        now: () => now,
        refreshFn: async () => {
          refreshCalls++
          throw new Error('refresh endpoint unavailable')
        },
      },
    )

    const usable = await manager.getUsableFallbackAccounts(snapshot)

    expect(usable).toEqual([])
    expect(refreshCalls).toBe(0)
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
