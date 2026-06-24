import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthAccount } from '../core/accounts.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

let dir: string
let cfgPath: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-acct-rm-'))
  cfgPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = cfgPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
})

afterEach(() => {
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

function makeAccount(id: string): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `acc-${id}`,
    refresh: `ref-${id}`,
    expires: Date.now() + 3600_000,
  }
}

describe('account removal', () => {
  it('saveAccounts removal round-trip: splice out an account, save, reload — only the kept account remains', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    const acctA = makeAccount('acct-a')
    const acctB = makeAccount('acct-b')

    // Seed both accounts
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )

    // Reload to confirm both are present
    let loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id).sort()).toEqual([
      'acct-a',
      'acct-b',
    ])

    // Simulate a removal: splice out acctB
    const storage = loaded!
    const idx = storage.accounts.findIndex((a) => a.id === 'acct-b')
    expect(idx).not.toBe(-1)
    storage.accounts.splice(idx, 1)

    await saveAccounts(storage, cfgPath)

    // Reload — acctB must be gone
    loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id).sort()).toEqual(['acct-a'])
  })

  it('saveAccounts: incoming account set is authoritative over disk state (removal must stick)', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    const acctA = makeAccount('acct-a')
    const acctB = makeAccount('acct-b')

    // Write disk state with two accounts directly (simulating a prior save)
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )

    // Now save with only acctA — acctB should be gone afterwards
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA],
      },
      cfgPath,
    )

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id).sort()).toEqual(['acct-a'])
  })

  it('saveAccounts: non-account top-level fields from disk still merge with incoming', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    // First save establishes routing on disk
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [makeAccount('acct-a')],
        routing: { activeId: 'acct-a', mode: 'fallback-first' as const },
      },
      cfgPath,
    )

    // Now save with a different set of top-level fields (e.g., quota set but no routing)
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [makeAccount('acct-a')],
        quota: { enabled: false },
      },
      cfgPath,
    )

    const loaded = await loadAccounts(cfgPath)
    // The incoming spread ({...latest, ...incoming}) means incoming wins for
    // fields it sets, but fields it omits survive from latest.  Here incoming
    // sets quota.enabled=false but omits routing — so routing should persist.
    expect(loaded?.quota?.enabled).toBe(false)
    expect(loaded?.routing?.activeId).toBe('acct-a')
    expect(loaded?.routing?.mode).toBe('fallback-first')
  })

  it('production removal path cleans state file (stateFromStorage rebuild drops removed account)', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    const acctA = makeAccount('acct-a')
    const acctB = makeAccount('acct-b')

    // Seed both accounts via saveAccounts (which writes config + state files)
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )

    // Confirm both have state entries
    const stateBefore = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(stateBefore.accounts).toHaveProperty('acct-a')
    expect(stateBefore.accounts).toHaveProperty('acct-b')

    // Reload, splice out acctB, save — simulating the production removal path
    const loaded = await loadAccounts(cfgPath)
    const idx = loaded!.accounts.findIndex((a) => a.id === 'acct-b')
    expect(idx).not.toBe(-1)
    loaded!.accounts.splice(idx, 1)
    await saveAccounts(loaded!, cfgPath)

    // State file must not contain acctB — stateFromStorage rebuilds
    // state.accounts from the merged storage's accounts array, so a removed
    // account is dropped without any explicit prune in saveAccountState.
    const stateAfter = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(stateAfter.accounts).toHaveProperty('acct-a')
    expect(stateAfter.accounts).not.toHaveProperty('acct-b')
  })

  it('saveAccountState scoped save does not prune accounts outside the scope', async () => {
    const { saveAccounts, saveAccountState } = await import(
      '../core/accounts.ts'
    )

    const acctA = makeAccount('acct-a')
    const acctB = makeAccount('acct-b')

    // Seed both accounts
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )

    // Save state with storage containing only acctA, but scope limited to acctA
    const updatedAcctA: OAuthAccount = {
      ...acctA,
      access: 'acc-a-updated',
      lastUsed: Date.now(),
    }
    await saveAccountState(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [updatedAcctA],
      },
      cfgPath,
      { accounts: ['acct-a'] },
    )

    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    // acctA should be updated
    expect(state.accounts['acct-a'].access).toBe('acc-a-updated')
    // acctB must remain untouched — scoped saves are partial
    expect(state.accounts).toHaveProperty('acct-b')
    expect(state.accounts['acct-b'].access).toBe('acc-acct-b')
  })
})

describe('mutateAccounts', () => {
  it('removal: splice out an account, reload — only kept accounts remain', async () => {
    const { loadAccounts, mutateAccounts, saveAccounts } = await import(
      '../core/accounts.ts'
    )

    const acctA = makeAccount('acct-a')
    const acctB = makeAccount('acct-b')

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )

    await mutateAccounts((fresh) => {
      const i = fresh.accounts.findIndex((a) => a.id === 'acct-b')
      expect(i).not.toBe(-1)
      fresh.accounts.splice(i, 1)
    }, cfgPath)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id).sort()).toEqual(['acct-a'])
  })

  it('concurrency: preserves a concurrent addition that would be wiped by naive load→mutate→saveAccounts', async () => {
    const { loadAccounts, mutateAccounts, saveAccounts } = await import(
      '../core/accounts.ts'
    )

    const acctA = makeAccount('acct-a')
    const acctB = makeAccount('acct-b')
    const acctC = makeAccount('acct-c')

    // 1. Write {a} to disk
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA],
      },
      cfgPath,
    )

    // 2. Capture a stale in-memory snapshot {a}
    const stale = await loadAccounts(cfgPath)
    expect(stale!.accounts.map((a) => a.id)).toEqual(['acct-a'])

    // 3. Concurrently write {a,b} to disk (simulating another process adding b)
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )

    // 4. Apply mutation through mutateAccounts: add c
    await mutateAccounts((fresh) => {
      fresh.accounts.push(acctC)
    }, cfgPath)

    // 5. Reload — accounts should be [a, b, c] (b preserved, c added)
    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id).sort()).toEqual([
      'acct-a',
      'acct-b',
      'acct-c',
    ])

    // 6. Contrast: a naive saveAccounts with stale snapshot + c would wipe b
    // Reset disk to {a}
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA],
      },
      cfgPath,
    )
    // Concurrently add b again
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [acctA, acctB],
      },
      cfgPath,
    )
    // Now use the stale snapshot + c via saveAccounts (the naive approach)
    const staleWithC = { ...stale!, accounts: [...stale!.accounts, acctC] }
    await saveAccounts(staleWithC, cfgPath)

    const afterNaive = await loadAccounts(cfgPath)
    // b is wiped — only a and c remain
    expect(afterNaive?.accounts.map((a) => a.id).sort()).toEqual([
      'acct-a',
      'acct-c',
    ])
  })
})
