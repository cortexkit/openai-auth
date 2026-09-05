import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
import { refreshInert } from '../core/custody.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import { claustrumConfig, localCustody } from './custody-fixtures.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

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

describe('AccountManager custody injection', () => {
  it('does not allow manager construction without custody injection', () => {
    const omitted = { configPath: cfgPath }
    // @ts-expect-error Required because an omitted policy reader silently re-enables local refresh.
    const rejected: AccountManagerOptions = omitted
    void rejected
  })
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

describe('request-path bookkeeping never fails the caller', () => {
  // The store lock is shared by every session in the host process, so a burst of
  // concurrent turns can legitimately exhaust the acquire window. Both writes
  // below run on the request path — markUsed after a response is already in hand
  // — so propagating a persistence failure discards a successful, already-billed
  // provider response to record a telemetry timestamp.
  //
  // An unwritable state path stands in for any save failure, lock timeout
  // included, because it fails deterministically instead of after the multi
  // second wait window.
  function breakStateWrites() {
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not-a-directory\n')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(blocked, 'state.json')
  }

  it('markUsed swallows a save failure and leaves the served response intact', async () => {
    const { FallbackAccountManager, saveAccounts } = await import(
      '../core/accounts.ts'
    )
    const account = oauthAccount('fb-1')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
      },
      cfgPath,
    )

    breakStateWrites()
    const manager = new FallbackAccountManager({
      custody: localCustody,
      configPath: cfgPath,
    })

    // Must resolve, not reject: the caller has a provider response to return.
    expect(await manager.markUsed(account).then(() => 'resolved')).toBe(
      'resolved',
    )
  })

  it('fallback selection swallows a bookkeeping save failure and still returns candidates', async () => {
    const { FallbackAccountManager, saveAccounts, loadAccounts } = await import(
      '../core/accounts.ts'
    )
    // An expired token forces the refresh branch, which sets `changed` and makes
    // selection attempt the bookkeeping save.
    const account = oauthAccount('fb-2', { expires: Date.now() - 1_000 })
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [account],
      },
      cfgPath,
    )
    const storage = await loadAccounts(cfgPath)
    expect(storage).not.toBeNull()

    breakStateWrites()
    const manager = new FallbackAccountManager({
      custody: localCustody,
      configPath: cfgPath,
      refreshFn: async () => ({
        access: 'rotated-access',
        refresh: 'rotated-refresh',
        expires: Date.now() + 3600_000,
        expiresIn: 3600,
      }),
    } as AccountManagerOptions)

    // Resolves rather than aborting a request that has not been sent yet.
    const usable = await manager.getUsableFallbackAccounts(storage)
    expect(Array.isArray(usable)).toBe(true)
  })
})

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
  it('RETAINS a corrupt OAuth row as gone and refresh-inert when its binding exists', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')
    const { enrollmentManifest } = await import('./custody-fixtures.ts')
    writeFileSync(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'corrupt-fallback',
            type: 'oauth',
            enabled: true,
            refresh: '',
          },
        ],
      })}\n`,
    )
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, accounts: {} })}\n`,
    )

    const storage = await loadAccounts(cfgPath)
    const account = storage?.accounts[0]

    expect(account).toEqual({
      id: 'corrupt-fallback',
      type: 'oauth',
      enabled: true,
      corrupt: true,
    })
    expect(
      account?.type === 'oauth' &&
        refreshInert(account, enrollmentManifest(account.id), 'openai'),
    ).toBe(true)
  })

  it('round-trips a corrupt OAuth marker through save without changing roster order', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [
          { id: 'first', type: 'oauth', refresh: 'first-refresh' },
          { id: 'corrupt-fallback', type: 'oauth', refresh: '' },
          { id: 'last', type: 'oauth', refresh: 'last-refresh' },
        ],
      })}\n`,
    )
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, accounts: {} })}\n`,
    )

    const loaded = await loadAccounts(cfgPath)
    if (!loaded) throw new Error('expected account storage')
    await saveAccounts(loaded, cfgPath)
    const reloaded = await loadAccounts(cfgPath)

    expect(reloaded?.accounts.map((account) => account.id)).toEqual([
      'first',
      'corrupt-fallback',
      'last',
    ])
    expect(reloaded?.accounts[1]).toMatchObject({
      id: 'corrupt-fallback',
      type: 'oauth',
      corrupt: true,
    })
  })

  it('keeps a corrupt OAuth marker when a sibling row is mutated', async () => {
    const { loadAccounts, mutateAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [
          { id: 'corrupt-fallback', type: 'oauth', refresh: '' },
          { id: 'healthy', type: 'oauth', refresh: 'healthy-refresh' },
        ],
      })}\n`,
    )
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, accounts: {} })}\n`,
    )

    await mutateAccounts((current) => {
      const healthy = current.accounts.find(
        (account) => account.id === 'healthy',
      )
      if (healthy) healthy.enabled = false
      return current
    }, cfgPath)

    const reloaded = await loadAccounts(cfgPath)
    expect(reloaded?.accounts.map((account) => account.id)).toEqual([
      'corrupt-fallback',
      'healthy',
    ])
    expect(reloaded?.accounts[0]).toMatchObject({
      id: 'corrupt-fallback',
      corrupt: true,
    })
    expect(reloaded?.accounts[1]?.enabled).toBe(false)
  })

  it('missing claustrum config loads as local without rewriting the file', async () => {
    const accounts = await import('../core/accounts.ts')
    const beforeExists = existsSync(cfgPath)
    const beforeBytes = beforeExists ? readFileSync(cfgPath, 'utf8') : undefined
    const beforeMtimeMs = beforeExists ? statSync(cfgPath).mtimeMs : undefined

    const storage = await accounts.loadAccounts(cfgPath)

    expect(accounts.claustrumMode(storage)).toBe('local')
    expect(existsSync(cfgPath)).toBe(beforeExists)
    expect(
      existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : undefined,
    ).toBe(beforeBytes)
    expect(existsSync(cfgPath) ? statSync(cfgPath).mtimeMs : undefined).toBe(
      beforeMtimeMs,
    )

    const existingSource = JSON.stringify({ version: 1, accounts: [] })
    writeFileSync(cfgPath, existingSource)
    const existingBytes = readFileSync(cfgPath, 'utf8')
    const existingMtimeMs = statSync(cfgPath).mtimeMs

    expect(accounts.claustrumMode(await accounts.loadAccounts(cfgPath))).toBe(
      'local',
    )
    expect(readFileSync(cfgPath, 'utf8')).toBe(existingBytes)
    expect(statSync(cfgPath).mtimeMs).toBe(existingMtimeMs)
  })

  it('legacy claustrum switches are rejected instead of bypassing the readiness barrier', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')

    for (const claustrum of [{ enabled: false }, { manifestWrite: false }]) {
      writeFileSync(
        cfgPath,
        JSON.stringify({ version: 1, accounts: [], claustrum }),
      )

      await expect(loadAccounts(cfgPath)).rejects.toThrow(
        'Remove the legacy claustrum switches and run /openai-account claustrum',
      )
    }
  })

  it('claustrum mode never arms the enrollment-completion write', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        claustrum: claustrumConfig({ mode: 'claustrum' }),
      }),
    )

    expect((await loadAccounts(cfgPath))?.claustrum?.manifestWrite).toBe(false)
  })

  it('in-memory legacy enabled state serializes as local mode', async () => {
    const { saveAccounts } = await import('../core/accounts.ts')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        claustrum: { enabled: true },
      },
      cfgPath,
    )

    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).claustrum.mode).toBe(
      'local',
    )
  })

  it('mode and takeover fingerprints round-trip in one config write', async () => {
    const accounts = await import('../core/accounts.ts')
    const transition = {
      manifestRevision: 'manifest-revision',
      storeGeneration: 'store-generation',
      fingerprints: {
        main: 'main-fingerprint',
        fallbacks: { 'fallback-1': 'fallback-fingerprint' },
      },
    }
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: [], unknownSetting: true }),
    )

    await accounts.writeClaustrumModeAndTransition(
      cfgPath,
      'claustrum',
      transition,
    )

    expect(existsSync(statePath)).toBe(false)
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(config.unknownSetting).toBe(true)
    expect(config.claustrum.mode).toBe('claustrum')
    expect(config.claustrum.transition).toEqual(transition)
    expect(accounts.claustrumMode(await accounts.loadAccounts(cfgPath))).toBe(
      'claustrum',
    )
  })

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

  it('round-trips sticky-balanced routing mode', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'sticky-balanced' },
        accounts: [],
      },
      cfgPath,
    )

    expect((await loadAccounts(cfgPath))?.routing?.mode).toBe('sticky-balanced')
  })

  it('round-trips cachekeep sustain', async () => {
    const { loadAccounts, saveAccounts } = await import('../core/accounts.ts')

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        cachekeep: { enabled: true, sustain: true },
      },
      cfgPath,
    )

    expect((await loadAccounts(cfgPath))?.cachekeep?.sustain).toBe(true)
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
        resetCreditsApplicable: 3,
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
    const quota = (loaded?.accounts[0] as OAuthAccount | undefined)?.quota
    expect(quota?.primary?.windowMinutes).toBe(10_080)
    expect(quota?.resetCreditsAvailable).toBe(4)
    expect(quota?.resetCreditsApplicable).toBe(3)
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
    const quota = (loaded?.accounts[0] as OAuthAccount | undefined)?.quota
    expect(quota?.primary?.windowMinutes).toBeUndefined()
    expect(quota?.resetCreditsAvailable).toBeUndefined()
  })

  it('drops missing and malformed reset state while retaining storage version', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')

    for (const reset of [undefined, null, [], 'invalid']) {
      const config: Record<string, unknown> = { version: 1, accounts: [] }
      if (reset !== undefined) config.reset = reset
      writeFileSync(cfgPath, `${JSON.stringify(config)}\n`)

      const loaded = await loadAccounts(cfgPath)
      expect(loaded?.version).toBe(1)
      expect(loaded?.reset).toBeUndefined()
    }
  })

  it('normalizes reset state per account without discarding valid siblings', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [],
        reset: {
          main: {
            inFlight: {
              redeemRequestId: 'redeem-main',
              creditId: 'credit-main',
              startedAt: 100,
            },
            lastOutcome: { code: 'completed', at: 200 },
            cooldownUntil: 300,
          },
          'fallback-a': {
            inFlight: { redeemRequestId: 'partial', startedAt: 400 },
            lastOutcome: { code: 'failed', at: 500 },
            cooldownUntil: 'later',
          },
          'fallback-b': {
            inFlight: { creditId: 'credit-b', startedAt: 600 },
            cooldownUntil: 700,
          },
          'fallback-c': {
            inFlight: {
              redeemRequestId: 'redeem-c',
              creditId: 'credit-c',
              startedAt: 'now',
            },
            lastOutcome: { code: 'failed', at: 800 },
          },
          garbage: 'invalid',
          empty: {
            inFlight: {
              redeemRequestId: '',
              creditId: 'credit-empty',
              startedAt: 600,
            },
            lastOutcome: { code: '', at: 700 },
            cooldownUntil: Number.NaN,
          },
          '': {
            lastOutcome: { code: 'completed', at: 800 },
          },
        },
      })}\n`,
    )

    const loaded = await loadAccounts(cfgPath)
    expect(loaded).toMatchObject({
      version: 1,
      reset: {
        main: {
          inFlight: {
            redeemRequestId: 'redeem-main',
            creditId: 'credit-main',
            startedAt: 100,
          },
          lastOutcome: { code: 'completed', at: 200 },
          cooldownUntil: 300,
        },
        'fallback-a': {
          inFlight: { redeemRequestId: 'partial', startedAt: 400 },
          lastOutcome: { code: 'failed', at: 500 },
        },
        'fallback-b': {
          inFlight: { creditId: 'credit-b', startedAt: 600 },
          cooldownUntil: 700,
        },
        'fallback-c': {
          inFlight: {
            redeemRequestId: 'redeem-c',
            creditId: 'credit-c',
            startedAt: 'now',
          },
          lastOutcome: { code: 'failed', at: 800 },
        },
        empty: {
          inFlight: {
            redeemRequestId: '',
            creditId: 'credit-empty',
            startedAt: 600,
          },
        },
      },
    })
    expect(Object.keys(loaded?.reset ?? {}).sort()).toEqual([
      'empty',
      'fallback-a',
      'fallback-b',
      'fallback-c',
      'main',
    ])
  })

  it('drops prototype-sensitive reset account keys without polluting lookups', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      '{"version":1,"accounts":[],"reset":{"__proto__":{"cooldownUntil":999},"constructor":{"cooldownUntil":999},"prototype":{"cooldownUntil":999},"safe":{"cooldownUntil":123}}}\n',
    )

    const loaded = await loadAccounts(cfgPath)

    expect(loaded?.reset).toEqual({ safe: { cooldownUntil: 123 } })
    expect(
      Object.getOwnPropertyDescriptor(loaded?.reset ?? {}, '__proto__'),
    ).toBeUndefined()
    expect(Object.getPrototypeOf(loaded?.reset ?? {})).toBeNull()
    expect(loaded?.reset?.constructor).toBeUndefined()
    expect(({} as Record<string, unknown>).cooldownUntil).toBeUndefined()
  })

  it('mutateAccounts persists independent reset states and unknown config keys', async () => {
    const { loadAccounts, mutateAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [],
        futureConfig: { retained: true },
      })}\n`,
    )

    await mutateAccounts((current) => {
      current.reset = {
        main: {
          inFlight: {
            redeemRequestId: 'redeem-main',
            creditId: 'credit-main',
            startedAt: 100,
          },
          cooldownUntil: 200,
        },
        'fallback-a': {
          lastOutcome: { code: 'completed', at: 300 },
          cooldownUntil: 400,
        },
      }
      return current
    }, cfgPath)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.reset).toEqual({
      main: {
        inFlight: {
          redeemRequestId: 'redeem-main',
          creditId: 'credit-main',
          startedAt: 100,
        },
        cooldownUntil: 200,
      },
      'fallback-a': {
        lastOutcome: { code: 'completed', at: 300 },
        cooldownUntil: 400,
      },
    })
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).futureConfig).toEqual({
      retained: true,
    })
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
        custody: localCustody,
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
      custody: localCustody,
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
        custody: localCustody,
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

// ---------------------------------------------------------------------------
// Roster-drop preservation — a load-dropped entry (raw config roster has it,
// but normalizeAccount rejected the merged record so it is absent from
// current.accounts) is carried through to the written config verbatim. The
// alternative — refusing to write — breaks any code path that shares the
// writer with a load-dropped entry (e.g. updateMainRefreshState) and blocks
// the only paths that could repair the account (remove, re-add). Preserve
// is the right primitive: the dropped entry survives the write, the
// operator gets a WARN, and a deliberate removal uses the allowDrop option
// to override preservation for a single id.
// ---------------------------------------------------------------------------

describe('mutateAccounts load-time roster preservation', () => {
  // The mutator is free to write whatever it likes; preserve is a wrapper
  // around the disk write that re-inserts raw entries whose ids normalize
  // rejected, so they cannot be silently erased by the next config write.
  function writeConfigWithMixedEntries(accounts: unknown[]) {
    writeFileSync(cfgPath, `${JSON.stringify({ version: 1, accounts })}\n`)
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, accounts: {} })}\n`,
    )
  }

  // Anti-regression for the original incident: a load-dropped entry survives
  // an unrelated mutateAccounts call. The mutator never even touches 'b';
  // preservation is what keeps it on disk.
  it('PRESERVES a load-dropped entry after an unrelated mutateAccounts call (writes through)', async () => {
    const { saveAccounts, mutateAccounts } = await import('../core/accounts.ts')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('a'), oauthAccount('b')],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts.b
    writeFileSync(statePath, JSON.stringify(stateObj))

    // Mutator only touches the refresh metadata, never the accounts list —
    // mirrors updateMainRefreshState's shape.
    await mutateAccounts((current) => {
      current.refresh = current.refresh ?? {}
      current.refresh.intervalMinutes = 7
      return current
    }, cfgPath)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    // 'b' is still on disk, verbatim from the original raw entry.
    expect(cfg.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      'a',
      'b',
    ])
    const preservedB = cfg.accounts.find((a: { id: string }) => a.id === 'b')
    expect(preservedB).toBeDefined()
    // Mutator's refresh change persisted too — preservation does not block
    // legitimate mutator writes.
    expect(cfg.refresh?.intervalMinutes).toBe(7)
  })

  // updateMainRefreshState goes through mutateAccounts on the same config
  // path. A broken FALLBACK state entry (raw config has the id but state
  // has no refresh for it) must not break MAIN refresh. This test pins
  // that failure mode directly.
  it('updateMainRefreshState-shaped mutation succeeds while a broken fallback exists (main refresh must not break)', async () => {
    const { saveAccounts, mutateAccounts } = await import('../core/accounts.ts')
    const main = oauthAccount('main')
    const broken = oauthAccount('broken')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [main, broken],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts.broken
    writeFileSync(statePath, JSON.stringify(stateObj))

    // Same shape as updateMainRefreshState in src/index.ts: touches only
    // refresh/main lease metadata. Must not throw.
    let resolved = false
    let rejected: unknown
    try {
      await mutateAccounts((current) => {
        current.refresh = current.refresh ?? {}
        current.refresh.mainRefreshLeaseId = 'lease-1'
        current.refresh.mainRefreshLeaseUntil = Date.now() + 60_000
        return current
      }, cfgPath)
      resolved = true
    } catch (error) {
      rejected = error
    }

    expect(resolved).toBe(true)
    expect(rejected).toBeUndefined()

    // Both accounts still on disk.
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      'broken',
      'main',
    ])
    // The mutator's refresh metadata went to the state file (where
    // configFromStorage routes refresh lease fields) — the test only
    // asserts the call did not throw, which is the MUST invariant.
    expect(typeof cfg.refresh).toBe('object')
  })

  // Removal of a load-dropped account via allowDrop: the entry is in raw
  // config (so the operator could see it via cli list, which reads raw),
  // absent from current.accounts (load-dropped), and the allowDrop option
  // suppresses preservation so it is gone from disk after the call.
  it('removes a load-dropped account end to end when allowDrop is set', async () => {
    const { saveAccounts, mutateAccounts } = await import('../core/accounts.ts')
    const a = oauthAccount('a')
    const broken = oauthAccount('broken')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [a, broken],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts.broken
    writeFileSync(statePath, JSON.stringify(stateObj))

    // The mutator cannot find 'broken' in current.accounts (it was
    // load-dropped). Without allowDrop, preserve would put it back. With
    // allowDrop set, preservation is skipped and the entry is gone.
    await mutateAccounts(
      (current) => {
        const idx = current.accounts.findIndex(
          (candidate) => candidate.id === 'broken',
        )
        if (idx !== -1) current.accounts.splice(idx, 1)
        return current
      },
      cfgPath,
      { allowDrop: ['broken'] },
    )

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id)).toEqual(['a'])
  })

  // A normal removal (target id is in current.accounts) still works
  // without allowDrop.
  it('allows a normal removal through the mutator', async () => {
    const { loadAccounts, saveAccounts, mutateAccounts } = await import(
      '../core/accounts.ts'
    )
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('a'), oauthAccount('b'), oauthAccount('c')],
      },
      cfgPath,
    )

    await mutateAccounts((current) => {
      current.accounts = current.accounts.filter(
        (account) => account.id !== 'b',
      )
      return current
    }, cfgPath)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.accounts.map((a) => a.id)).toEqual(['a', 'c'])
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id)).toEqual(['a', 'c'])
  })

  // First-run with no config file: no raw roster to preserve from; the
  // mutator runs as before.
  it('does not throw on first run with no config file', async () => {
    const { mutateAccounts } = await import('../core/accounts.ts')
    expect(existsSync(cfgPath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)

    await expect(
      mutateAccounts((current) => {
        current.accounts.push(oauthAccount('first'))
        return current
      }, cfgPath),
    ).resolves.toBeDefined()

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id)).toEqual(['first'])
  })

  // The roster predicate aligns with normalizeAccountBase: trim, skip
  // blank/whitespace-only. A garbage entry that synthesize-a-uuid on load
  // must not be treated as "dropped" and preserved spuriously.
  it('blank and whitespace-padded raw ids do not trigger spurious preservation', async () => {
    const { mutateAccounts } = await import('../core/accounts.ts')
    writeConfigWithMixedEntries([
      { id: 'real-a', type: 'oauth', enabled: true },
      { id: '   ', type: 'oauth', enabled: true }, // whitespace only → not in roster
      { id: '', type: 'oauth', enabled: true }, // empty → not in roster
      { id: 7, type: 'oauth', enabled: true }, // non-string id → not in roster
      { id: '   padded   ', type: 'oauth', enabled: true }, // padded with content → trimmed to 'padded', in roster
      {}, // no id → not in roster
      null, // not a record → not in roster
      'string', // not a record → not in roster
    ])

    await mutateAccounts((current) => current, cfgPath)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const ids = cfg.accounts.map((a: { id: string }) => a.id)
    // 'real-a' and '   padded   ' are the only records whose id (after
    // trim) was a non-empty string; both are load-dropped in this scenario
    // (state is empty) so both are preserved verbatim. The blank /
    // non-string / non-record entries were never in the roster.
    expect(ids.sort()).toEqual(['   padded   ', 'real-a'].sort())
  })

  // An api-type account rejected for a bad baseURL is also load-dropped, and
  // the raw entry is preserved verbatim so re-add or re-login can fix it.
  it('also preserves a load-dropped api-type account (verbatim from raw)', async () => {
    const { mutateAccounts } = await import('../core/accounts.ts')
    writeFileSync(
      cfgPath,
      `${JSON.stringify({
        version: 1,
        accounts: [
          { id: 'good-api', type: 'api', baseURL: 'https://example.test' },
          { id: 'bad-api', type: 'api', baseURL: 'not-a-url' },
        ],
      })}\n`,
    )
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, accounts: {} })}\n`,
    )

    await mutateAccounts((current) => current, cfgPath)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      'bad-api',
      'good-api',
    ])
    const preserved = cfg.accounts.find(
      (a: { id: string }) => a.id === 'bad-api',
    )
    // Verbatim: the bad baseURL is kept so the operator can repair it via
    // re-add or fix the URL — the loader does not silently swallow it.
    expect(preserved?.baseURL).toBe('not-a-url')
  })

  // N1 regression: when the mutator re-adds a load-dropped entry (the
  // exact shape of `re-login` for an account whose state entry is missing),
  // the preserved raw entry must not be appended alongside the mutator's
  // fresh version. The two id sets the helper accepts answer distinct
  // questions — `loadedIds` (pre-mutator) decides what to preserve, and
  // `emittedIds` (post-mutator) decides whether the writer is already
  // emitting that id — and the F3 extraction dropped the second one.
  it('mutator re-add of a load-dropped entry does NOT append a duplicate raw entry', async () => {
    const { saveAccounts, mutateAccounts } = await import('../core/accounts.ts')
    const healthy = oauthAccount('healthy')
    const broken = oauthAccount('broken')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [healthy, broken],
      },
      cfgPath,
    )
    // Strip 'broken' from state — it is now load-dropped.
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts.broken
    writeFileSync(statePath, JSON.stringify(stateObj))

    // Mutator re-adds 'broken' with fresh tokens — the shape of re-login.
    await mutateAccounts((current) => {
      current.accounts.push({
        ...oauthAccount('broken'),
        access: 'fresh-access-broken',
        refresh: 'fresh-refresh-broken',
        expires: Date.now() + 3600_000,
      })
      return current
    }, cfgPath)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const brokenEntries = cfg.accounts.filter(
      (a: { id: string }) => a.id === 'broken',
    )
    // Exactly ONE entry for 'broken' — the mutator's fresh one. A second
    // (stale raw) entry here is the F3-extraction regression.
    expect(brokenEntries.length).toBe(1)
    // Pin where the survivor lives: the state file carries the fresh
    // tokens because accountConfig strips them from config, so the test
    // asserts on state.broken.refresh rather than the config-side
    // accountConfig projection.
    const stateAfter = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(stateAfter.accounts.broken.refresh).toBe('fresh-refresh-broken')
  })

  // Padded id variant of the same regression: a load-dropped entry whose
  // raw id is `   padded   ` (whitespace) loads with no state record
  // and would re-append against the mutator's trimmed `padded` entry
  // unless the writer's "already emitting" set is built with trim() on
  // both sides. collectConfigRosterIds trims on the load side; this
  // test pins the trim on the writer side.
  it('mutator re-add of a load-dropped WHITESPACE-PADDED id does NOT duplicate', async () => {
    const { saveAccounts, mutateAccounts } = await import('../core/accounts.ts')
    const rawId = '   padded   '
    const trimmedId = 'padded'
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('healthy'), oauthAccount(rawId)],
      },
      cfgPath,
    )
    // Strip the state entry for the padded id so it is load-dropped.
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts[rawId]
    writeFileSync(statePath, JSON.stringify(stateObj))

    // Mutator re-adds under the trimmed id (normalizeAccountBase trims
    // the raw whitespace from any id the caller passes).
    await mutateAccounts((current) => {
      current.accounts.push({
        ...oauthAccount(trimmedId),
        access: 'fresh-access',
        refresh: 'fresh-refresh',
        expires: Date.now() + 3600_000,
      })
      return current
    }, cfgPath)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const paddedEntries = cfg.accounts.filter(
      (a: { id: string }) => a.id === trimmedId,
    )
    expect(paddedEntries.length).toBe(1)
    // The raw padded entry must NOT be present (its trimmed form is the
    // fresh one already on disk; the raw is what would duplicate).
    const rawEntries = cfg.accounts.filter(
      (a: { id: string }) => a.id === rawId,
    )
    expect(rawEntries.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// saveAccounts is exported but currently has no production callers. The same
// roster invariant applies (a load-dropped id stays on disk verbatim), so the
// preserve logic from mutateAccounts is mirrored here. This test pins that
// parallelism so a future regression to either writer is caught.
// ---------------------------------------------------------------------------

describe('saveAccounts load-time roster preservation', () => {
  it('preserves a load-dropped entry on a re-save even when the caller passes a storage without it (parallel to mutateAccounts)', async () => {
    const { saveAccounts } = await import('../core/accounts.ts')
    // Seed config + state for [a, broken].
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('a'), oauthAccount('broken')],
      },
      cfgPath,
    )
    // Strip 'broken' from the state file so the next saveAccounts call
    // re-reads a config where 'broken' is load-dropped — and the caller
    // passes a storage that does NOT mention 'broken' (the typical
    // caller-side view, since they cannot see load-dropped ids via
    // loadAccounts either).
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts.broken
    writeFileSync(statePath, JSON.stringify(stateObj))

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('a')],
      },
      cfgPath,
    )

    // 'broken' must come back to disk verbatim because saveAccounts
    // preserves load-dropped entries — the caller-side storage doesn't
    // know about it, but it was in the original raw roster.
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      'a',
      'broken',
    ])
  })
})

describe('normalizeStorage roster drop is loud on every load', () => {
  // The same drop path is hit by plain loadAccounts — not just by mutations —
  // and the previous version was silent, which is why the original incident
  // had no log trail. The accounts-channel WARN names the dropped ids.
  let logFile: string

  beforeEach(() => {
    logFile = join(dir, 'drop.log')
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'info'
  })
  afterEach(() => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
  })

  it('emits a WARN naming the dropped ids when loadAccounts filters them out', async () => {
    const { saveAccounts, loadAccounts } = await import('../core/accounts.ts')
    const { flushForTest } = await import('../logger.ts')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('keep-a'), oauthAccount('silent-drop')],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts['silent-drop']
    writeFileSync(statePath, JSON.stringify(stateObj))

    const loaded = await loadAccounts(cfgPath)
    await flushForTest()
    // The dropped id must not have survived the load.
    expect(loaded?.accounts.map((a) => a.id)).toEqual(['keep-a'])

    const logTxt = readFileSync(logFile, 'utf8')
    // WARN on the accounts channel naming the dropped id.
    expect(logTxt).toMatch(/WARN \[accounts\]/)
    expect(logTxt).toContain('silent-drop')
    // No token values are leaked through the WARN.
    expect(logTxt).not.toContain('ref-silent-drop')
    expect(logTxt).not.toContain('acc-silent-drop')
  })

  // The write-debug log exists specifically so the post-incident forensic
  // trail reflects what landed on disk — not what the mutator returned.
  // Preserved entries are appended to nextConfig.accounts after the
  // mutator runs, so logging next.accounts would under-report.
  it('write-debug log lists the actual written roster (preserved entry included)', async () => {
    const { saveAccounts, mutateAccounts } = await import('../core/accounts.ts')
    const { flushForTest } = await import('../logger.ts')
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    // Use a UUID so the dropped-id dedup state does not collide with
    // any other test in this process.
    const preservedId = `preserve-${randomUUID()}`
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('healthy'), oauthAccount(preservedId)],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts[preservedId]
    writeFileSync(statePath, JSON.stringify(stateObj))

    // Mutator touches only refresh metadata — mirrors updateMainRefreshState.
    await mutateAccounts((current) => {
      current.refresh = current.refresh ?? {}
      current.refresh.intervalMinutes = 11
      return current
    }, cfgPath)
    await flushForTest()

    const logTxt = readFileSync(logFile, 'utf8')
    // Pull only the DEBUG line for the config write — the WARN line also
    // contains the preserved id (as preservedIds), so a flat toContain()
    // would be ambiguous between DEBUG and WARN.
    const debugLine = logTxt
      .split('\n')
      .find((line) => line.includes('account config written'))
    expect(debugLine).toBeDefined()
    // The DEBUG payload must list BOTH the healthy entry and the preserved
    // entry — exactly what landed on disk. This is the assertion that
    // reddens when the log uses next.accounts (only the healthy entry).
    expect(debugLine).toContain(preservedId)
    expect(debugLine).toContain('healthy')
  })
})

// The preserve invariant keeps a load-dropped entry on disk indefinitely.
// That guarantees the WARN condition persists forever — every main-refresh
// tick, every loadAccounts — which the original fix would spam. The dedup
// keeps the first occurrence loud and suppresses identical repeats; a
// change in the dropped-id set (any new id appearing) still re-warns. Each
// test uses UUID ids so dedup state does not leak between tests.
describe('roster-drop WARN dedupes identical repeats, re-warns on set change', () => {
  let logFile: string

  beforeEach(() => {
    logFile = join(dir, 'dedup.log')
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'info'
  })
  afterEach(() => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
  })

  it('two consecutive loads with the same dropped id emit exactly one WARN', async () => {
    const { saveAccounts, loadAccounts } = await import('../core/accounts.ts')
    const { flushForTest } = await import('../logger.ts')
    const droppedId = `dedup-${randomUUID()}`
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('keep'), oauthAccount(droppedId)],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts[droppedId]
    writeFileSync(statePath, JSON.stringify(stateObj))

    await loadAccounts(cfgPath)
    await loadAccounts(cfgPath) // identical dropped set — should be deduped
    await flushForTest()

    const logTxt = readFileSync(logFile, 'utf8')
    const warns = logTxt.match(/WARN \[accounts\]/g) ?? []
    expect(warns.length).toBe(1)
    expect(logTxt).toContain(droppedId)
  })

  it('a new dropped id (different from the previously-warned set) re-warns', async () => {
    const { saveAccounts, loadAccounts } = await import('../core/accounts.ts')
    const { flushForTest } = await import('../logger.ts')
    const firstId = `dedup-A-${randomUUID()}`
    const secondId = `dedup-B-${randomUUID()}`
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('keep'), oauthAccount(firstId)],
      },
      cfgPath,
    )
    const stateRaw = readFileSync(statePath, 'utf8')
    const stateObj = JSON.parse(stateRaw)
    delete stateObj.accounts[firstId]
    writeFileSync(statePath, JSON.stringify(stateObj))
    await loadAccounts(cfgPath)

    // Different broken id — warn again.
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [oauthAccount('keep'), oauthAccount(secondId)],
      },
      cfgPath,
    )
    const stateRaw2 = readFileSync(statePath, 'utf8')
    const stateObj2 = JSON.parse(stateRaw2)
    delete stateObj2.accounts[secondId]
    writeFileSync(statePath, JSON.stringify(stateObj2))
    await loadAccounts(cfgPath)
    await flushForTest()

    const logTxt = readFileSync(logFile, 'utf8')
    const warns = logTxt.match(/WARN \[accounts\]/g) ?? []
    expect(warns.length).toBe(2)
    expect(logTxt).toContain(firstId)
    expect(logTxt).toContain(secondId)
  })

  // The dedup key must not allow a single id containing a comma to hash
  // to the same value as two ids whose join-string is identical. Set A
  // = {`<prefix>:a,b`} and Set B = {`<prefix>:a`, `b`} (where the prefix
  // is constructed to start with a char < `b` so the sort order lines up
  // both setups to the same joined string) have different ids but the
  // same `[...droppedIds].sort().join(',')` output. The bug suppresses
  // the second WARN silently. Use JSON.stringify so the two sets map to
  // distinct keys and both WARN.
  //
  // `warnedRosterDrops` is module-level and never reset, so the dropped-id
  // sets here are built from a unique randomUUID() prefix to keep them
  // from colliding with any earlier test in the process. The prefix is
  // itself load-bearing for the bug-trigger: the two setups' sort+join
  // characters must be byte-identical, which is impossible to arrange
  // when both setups use the same prefix-segmented ids on each side, so
  // Setup 2's second id is left unprefixed (just `b`) and the prefix's
  // leading character is forced below `b` in lex order.
  it('warn dedup key resists comma-collision in id strings', async () => {
    const { loadAccounts } = await import('../core/accounts.ts')
    const { flushForTest } = await import('../logger.ts')

    function writeConfigAndState(
      accounts: Array<{ id: string; refresh: string }>,
    ) {
      const cfg = {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: accounts.map((a) => ({
          id: a.id,
          type: 'oauth',
          enabled: true,
        })),
      }
      const state = {
        version: 1,
        accounts: Object.fromEntries(
          accounts.map((a) => [
            a.id,
            {
              access: `acc-${a.id}`,
              refresh: a.refresh,
              expires: Date.now() + 3600_000,
            },
          ]),
        ),
      }
      writeFileSync(cfgPath, `${JSON.stringify(cfg)}\n`)
      writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    }

    // Prefix starts with `a` so `${prefix}:a` < `b` lexicographically;
    // that ordering is what makes Setup 2's two-id join
    // (`${prefix}:a,b`) equal Setup 1's one-id join. randomUUID() makes
    // the prefix unique within the process so the dedup set cannot be
    // polluted by prior tests.
    const prefix = `a${randomUUID().slice(0, 8)}`
    const healthyId = `${prefix}:healthy`
    const collapsedId = `${prefix}:a,b`
    const split1Id = `${prefix}:a`
    const split2Id = 'b'

    writeConfigAndState([
      { id: healthyId, refresh: `r-${healthyId}` },
      { id: collapsedId, refresh: `r-${collapsedId}` },
    ])
    const stateRaw1 = readFileSync(statePath, 'utf8')
    const stateObj1 = JSON.parse(stateRaw1)
    delete stateObj1.accounts[collapsedId]
    writeFileSync(statePath, JSON.stringify(stateObj1))
    await loadAccounts(cfgPath) // load 1: drops = [collapsedId]

    writeConfigAndState([
      { id: healthyId, refresh: `r-${healthyId}` },
      { id: split1Id, refresh: `r-${split1Id}` },
      { id: split2Id, refresh: `r-${split2Id}` },
    ])
    const stateRaw2 = readFileSync(statePath, 'utf8')
    const stateObj2 = JSON.parse(stateRaw2)
    delete stateObj2.accounts[split1Id]
    delete stateObj2.accounts[split2Id]
    writeFileSync(statePath, JSON.stringify(stateObj2))
    await loadAccounts(cfgPath) // load 2: drops = [split1Id, split2Id]
    await flushForTest()

    const logTxt = readFileSync(logFile, 'utf8')
    const warns = logTxt.match(/WARN \[accounts\]/g) ?? []
    // Buggy join(',') dedup: `${prefix}:a,b` (load 1) and `${prefix}:a,b`
    // (load 2, after sort) collide; second WARN suppressed → 1.
    // JSON dedup: keys differ (`["${prefix}:a,b"]` vs
    // `["${prefix}:a","b"]`) → 2.
    expect(warns.length).toBe(2)
  })
})
