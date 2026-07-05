import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandContext } from '../commands'
// Static import for tests that don't need mocking.
import { buildDialogPayload } from '../commands'
// Snapshot the REAL oauth module exports at load time (before any mock.module
// runs). bun's mock.module leaks process-wide and mock.restore() does NOT undo
// it, so without restoring here the beginAccountLogin stub below would poison
// every later test file that imports ../core/oauth. We spread into a PLAIN object
// so the snapshot holds the original function references even after the live
// namespace is later replaced; afterAll re-installs it.
import * as oauthLiveNamespace from '../core/oauth'

const oauthRealExports = { ...oauthLiveNamespace }

import type { AccountQuotaWindow, OAuthQuotaSnapshot } from '../core/accounts'
import { loadAccounts, type OAuthAccount, saveAccounts } from '../core/accounts'
import { QuotaManager } from '../core/quota-manager'
import { createLogger, flushForTest, setLogLevel } from '../logger'
import { resetNotificationsForTest } from '../rpc/notifications'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

function makeAccount(
  id: string,
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 3600_000,
    enabled: true,
    ...overrides,
  } as OAuthAccount
}

function makeClient(): CommandContext['client'] {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as unknown as CommandContext['client']
}

describe('commands', () => {
  let tmpDir: string
  let configPath: string
  let statePath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openai-auth-cmd-'))
    configPath = join(tmpDir, 'openai-auth.json')
    statePath = join(tmpDir, 'openai-auth-state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
    resetNotificationsForTest()
  })

  afterEach(() => {
    // Restore to the floor (not delete) so any in-flight write resolves to a
    // temp path rather than the operator's live default. afterEach (not
    // afterAll) so each test's tmpDir is torn down before the next beforeEach
    // creates a new one — otherwise an in-flight write from test N can bleed
    // into test N+1's tmpDir.
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  // -----------------------------------------------------------------------
  // (a) command.execute.before for /openai-routing pushes a dialog payload;
  //     apply runs the persistent command + returns {text,knobs}
  // -----------------------------------------------------------------------
  test('routing command builds dialog payload with mode knob', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await buildDialogPayload('openai-routing', '', ctx)
    expect(payload.command).toBe('openai-routing')
    expect(payload.text).toContain('Routing')
    expect(payload.knobs).toHaveProperty('mode')
  })

  test('routing command apply changes mode', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    // Set to fallback-first
    const payload = await buildDialogPayload(
      'openai-routing',
      'fallback-first',
      ctx,
    )
    expect(payload.knobs.mode).toBe('fallback-first')

    // Verify persisted
    const storage = await loadAccounts(configPath)
    expect(storage?.routing?.mode).toBe('fallback-first')
  })

  test('scalar command (routing) does not resurrect a removed account or its secrets', async () => {
    // Seed a fallback account with real secrets, then remove it, then run a
    // scalar command. The scalar path now goes through mutateAccounts (reads
    // fresh under the lock, no union), so the removed account and its state-file
    // secrets must stay gone.
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          {
            id: 'gone',
            type: 'oauth',
            access: 'acc-gone-secret',
            refresh: 'ref-gone-secret',
            expires: Date.now() + 3600_000,
            addedAt: Date.now(),
            lastUsed: Date.now(),
          },
        ],
      },
      configPath,
    )
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
    }

    await buildDialogPayload('openai-account', 'remove gone', ctx)
    // A scalar command runs afterward.
    await buildDialogPayload('openai-routing', 'fallback-first', ctx)

    const storage = await loadAccounts(configPath)
    expect(storage?.accounts.map((a) => a.id)).toEqual([])
    expect(storage?.routing?.mode).toBe('fallback-first')
    // Secrets must not linger in the state file.
    const stateRaw = readFileSync(statePath, 'utf8')
    expect(stateRaw).not.toContain('acc-gone-secret')
    expect(stateRaw).not.toContain('ref-gone-secret')
  })

  test('/openai-cachekeep status reflects persisted enabled and state-aware knobs', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        cachekeep: { enabled: true },
      },
      configPath,
    )
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      cacheKeepManager: {
        status: () => ({
          running: false,
          tracked: 0,
          generatedAt: 1700000000000,
          startedAt: null,
          maxIdleWarmMs: 60 * 60 * 1000,
          maxSubagentIdleMs: 30 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          leadMs: 5000,
          targets: [],
        }),
      } as unknown as CommandContext['cacheKeepManager'],
    }

    const payload = await buildDialogPayload('openai-cachekeep', '', ctx)

    expect(payload.command).toBe('openai-cachekeep')
    expect(payload.text).toContain('Status: **ON**')
    expect(payload.text).toContain('Timer: **idle**')
    expect(payload.knobs.enabled).toBe(true)
    expect(payload.knobs.running).toBe(false)
    expect(payload.knobs.tracked).toBe(0)
  })

  test('/openai-cachekeep on/off persists enabled and toggles the manager', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      },
      configPath,
    )
    const start = mock(() => {})
    const stop = mock(() => {})
    const setCacheKeepEnabled = mock(() => {})
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      setCacheKeepEnabled,
      cacheKeepManager: {
        start,
        stop,
        status: () => ({
          running: true,
          tracked: 0,
          generatedAt: 1700000000000,
          startedAt: 1700000000000,
          maxIdleWarmMs: 60 * 60 * 1000,
          maxSubagentIdleMs: 30 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          leadMs: 5000,
          targets: [],
        }),
      } as unknown as CommandContext['cacheKeepManager'],
    }

    const on = await buildDialogPayload('openai-cachekeep', 'on', ctx)
    expect(on.knobs.enabled).toBe(true)
    expect((await loadAccounts(configPath))?.cachekeep?.enabled).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(setCacheKeepEnabled).toHaveBeenCalledWith(true)

    const off = await buildDialogPayload('openai-cachekeep', 'off', ctx)
    expect(off.knobs.enabled).toBe(false)
    expect((await loadAccounts(configPath))?.cachekeep?.enabled).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(setCacheKeepEnabled).toHaveBeenCalledWith(false)
  })

  test('/openai-cachekeep subagents on/off persists and flips the live gate', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        cachekeep: { enabled: true, subagents: false },
      },
      configPath,
    )
    const setCacheKeepSubagents = mock(() => {})
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      setCacheKeepSubagents,
      cacheKeepManager: {
        status: () => ({
          running: true,
          tracked: 0,
          generatedAt: 1700000000000,
          startedAt: 1700000000000,
          maxIdleWarmMs: 60 * 60 * 1000,
          maxSubagentIdleMs: 30 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          leadMs: 5000,
          targets: [],
        }),
      } as unknown as CommandContext['cacheKeepManager'],
    }

    const on = await buildDialogPayload('openai-cachekeep', 'subagents on', ctx)
    expect(on.knobs.subagents).toBe(true)
    expect((await loadAccounts(configPath))?.cachekeep?.subagents).toBe(true)
    expect(setCacheKeepSubagents).toHaveBeenCalledWith(true)

    const off = await buildDialogPayload(
      'openai-cachekeep',
      'subagents off',
      ctx,
    )
    expect(off.knobs.subagents).toBe(false)
    expect((await loadAccounts(configPath))?.cachekeep?.subagents).toBe(false)
    expect(setCacheKeepSubagents).toHaveBeenCalledWith(false)
  })

  test('/openai-cachekeep on creates a store when none exists', async () => {
    expect(existsSync(configPath)).toBe(false)
    const start = mock(() => {})
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      cacheKeepManager: {
        start,
        status: () => ({
          running: true,
          tracked: 0,
          generatedAt: 1700000000000,
          startedAt: 1700000000000,
          maxIdleWarmMs: 60 * 60 * 1000,
          maxSubagentIdleMs: 30 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          leadMs: 5000,
          targets: [],
        }),
      } as unknown as CommandContext['cacheKeepManager'],
    }

    await buildDialogPayload('openai-cachekeep', 'on', ctx)

    const storage = await loadAccounts(configPath)
    expect(storage?.accounts).toEqual([])
    expect(storage?.cachekeep?.enabled).toBe(true)
  })

  // -----------------------------------------------------------------------
  // refreshSidebar is called after remove/order mutations
  // -----------------------------------------------------------------------
  test('refreshSidebar called after remove', async () => {
    const account = makeAccount('acct-1')
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [account] },
    })
    const client = makeClient()

    const refreshCalls: number[] = []
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client,
      refreshSidebar: async () => {
        refreshCalls.push(1)
      },
    }

    const initial = {
      version: 1 as const,
      accounts: [account],
    }
    await saveAccounts(initial, configPath)

    await buildDialogPayload('openai-account', 'remove acct-1', ctx)
    expect(refreshCalls.length).toBe(1)
  })

  test('refreshSidebar called after order', async () => {
    const account = makeAccount('acct-1')
    const acct2 = makeAccount('acct-2')
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [account, acct2] },
    })
    const client = makeClient()

    const refreshCalls: number[] = []
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client,
      refreshSidebar: async () => {
        refreshCalls.push(1)
      },
    }

    const initial = {
      version: 1 as const,
      accounts: [account, acct2],
    }
    await saveAccounts(initial, configPath)

    await buildDialogPayload('openai-account', 'order acct-1 acct-2', ctx)
    expect(refreshCalls.length).toBe(1)
  })

  // -----------------------------------------------------------------------
  // (c) /openai-logging debug → setLogLevel updates the effective
  //     level (a subsequent debug line is emitted that was suppressed before)
  // -----------------------------------------------------------------------
  test('/openai-logging debug → setLogLevel updates effective level (runtime)', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'oai-cmd-log-'))
    const logFile = join(logDir, 'test.log')
    const savedLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
    const savedLogLevel = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
    try {
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
      delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL

      const qm = new QuotaManager({
        storage: { version: 1 as const, accounts: [] },
      })
      const ctx: CommandContext = {
        accountStoragePath: configPath,
        quotaManager: qm,
        loadAccounts,
        client: makeClient(),
      }

      // Gate: start from 'info' (debug suppressed)
      setLogLevel('info')
      const log = createLogger('cmd-test')
      log.debug('SHOULD_BE_SUPPRESSED')
      log.info('baseline-info-line')
      await flushForTest()

      let txt = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
      expect(txt).not.toContain('SHOULD_BE_SUPPRESSED')
      expect(txt).toContain('baseline-info-line')

      // Switch to debug via /openai-logging debug
      const payload = await buildDialogPayload('openai-logging', 'debug', ctx)
      expect(payload.command).toBe('openai-logging')
      expect(payload.text).toContain('debug')
      expect(payload.knobs).toHaveProperty('level', 'debug')

      // Prove runtime: debug is NOW emitted
      log.debug('SHOULD_APPEAR_NOW')
      await flushForTest()

      txt = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
      expect(txt).toContain('SHOULD_APPEAR_NOW')

      // Verify persistent read-back matches
      const statusPayload = await buildDialogPayload('openai-logging', '', ctx)
      expect(statusPayload.knobs.level).toBe('debug')
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = savedLogFile
      if (savedLogLevel !== undefined)
        process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = savedLogLevel
      // This test set a module-global runtime level via the logging command;
      // clear it so it can't leak into another test's effective level.
      setLogLevel(undefined)
      try {
        rmSync(logDir, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  })

  // -----------------------------------------------------------------------
  // Dump command toggle
  // -----------------------------------------------------------------------
  test('dump command toggles enabled state', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const offPayload = await buildDialogPayload('openai-dump', '', ctx)
    expect(offPayload.knobs.enabled).toBe(false)

    const onPayload = await buildDialogPayload('openai-dump', 'on', ctx)
    expect(onPayload.knobs.enabled).toBe(true)

    // After toggle: verify persistence in account storage
    const storage = await loadAccounts(configPath)
    expect(storage?.dump?.enabled).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Killswitch command status
  // -----------------------------------------------------------------------
  test('killswitch command shows status with knobs', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await buildDialogPayload('openai-killswitch', '', ctx)
    expect(payload.command).toBe('openai-killswitch')
    expect(payload.knobs).toHaveProperty('config')
    expect(payload.knobs).toHaveProperty('accountIds')
  })

  // -----------------------------------------------------------------------
  // Quota command shows snapshot
  // -----------------------------------------------------------------------
  test('quota command returns text (quota snapshot)', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await buildDialogPayload('openai-quota', '', ctx)
    expect(payload.command).toBe('openai-quota')
    expect(typeof payload.text).toBe('string')
  })

  // -----------------------------------------------------------------------
  // Quota command with refreshAllQuota wired → shows fresh per-account quota
  // -----------------------------------------------------------------------

  function makeQuotaSnapshot(usedPercent: number): OAuthQuotaSnapshot {
    const window: AccountQuotaWindow = {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      checkedAt: Date.now(),
    }
    return { primary: window }
  }

  test('refreshAllQuota populates main + 2 fallbacks → output shows quota', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })

    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      refreshAllQuota: async () => {
        qm.setMain('access-main', {
          quota: makeQuotaSnapshot(15),
          refreshAfter: Date.now() + 5 * 60 * 1000,
          checkedAt: Date.now(),
        })
        qm.setFallback('fb-1', {
          quota: makeQuotaSnapshot(42),
          refreshAfter: Date.now() + 5 * 60 * 1000,
          checkedAt: Date.now(),
        })
        qm.setFallback('fb-2', {
          quota: makeQuotaSnapshot(78),
          refreshAfter: Date.now() + 5 * 60 * 1000,
          checkedAt: Date.now(),
        })
        return [
          { account: 'main', ok: true },
          { account: 'fb-1', ok: true },
          { account: 'fb-2', ok: true },
        ]
      },
    }

    const payload = await buildDialogPayload('openai-quota', '', ctx)
    expect(payload.command).toBe('openai-quota')

    // Main with bar
    expect(payload.text).toContain('### Main account')
    expect(payload.text).toContain('15% used')
    expect(payload.text).toContain('85% remaining')

    // Fallbacks
    expect(payload.text).toContain('### Fallback accounts')
    expect(payload.text).toContain('**fb-1**')
    expect(payload.text).toContain('42% used')
    expect(payload.text).toContain('**fb-2**')
    expect(payload.text).toContain('78% used')
  })

  test('refreshAllQuota with one failure → ⚠ line for failing account', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })

    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      refreshAllQuota: async () => {
        qm.setMain('access-main', {
          quota: makeQuotaSnapshot(10),
          refreshAfter: Date.now() + 5 * 60 * 1000,
          checkedAt: Date.now(),
        })
        qm.setFallback('fb-1', {
          quota: makeQuotaSnapshot(50),
          refreshAfter: Date.now() + 5 * 60 * 1000,
          checkedAt: Date.now(),
        })
        return [
          { account: 'main', ok: true },
          { account: 'fb-1', ok: true },
          { account: 'fb-2', ok: false, error: 'wham usage check failed: 401' },
        ]
      },
    }

    const payload = await buildDialogPayload('openai-quota', '', ctx)

    // Successful accounts still show
    expect(payload.text).toContain('10% used')
    expect(payload.text).toContain('50% used')

    // Failure line
    expect(payload.text).toContain(
      '⚠ fb-2: could not fetch (wham usage check failed: 401)',
    )
  })

  test('refreshAllQuota undefined → falls back to cached display', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    // Pre-populate cache
    qm.setMain('access-main', {
      quota: makeQuotaSnapshot(25),
      refreshAfter: Date.now() + 5 * 60 * 1000,
      checkedAt: Date.now(),
    })

    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      // refreshAllQuota intentionally omitted
    }

    const payload = await buildDialogPayload('openai-quota', '', ctx)

    // Shows cached quota
    expect(payload.text).toContain('### Main account')
    expect(payload.text).toContain('25% used')

    // No ⚠ lines (no refresh happened)
    expect(payload.text).not.toContain('⚠')
  })
})

// -----------------------------------------------------------------------
// Account add command (uses mock.module for beginAccountLogin)
// -----------------------------------------------------------------------
describe('commands (add)', () => {
  let tmpDir: string
  let configPath: string
  let statePath: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openai-auth-cmd-add-'))
    configPath = join(tmpDir, 'openai-auth.json')
    statePath = join(tmpDir, 'openai-auth-state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
    resetNotificationsForTest()
    // Reset module mocks before each test
    mock.restore()
  })

  // afterEach (not afterAll) so env vars are cleaned up between tests.
  // A detached .then from test N must not see test N+1's env vars — with
  // getAccountStatePath now reading OPENCODE_OPENAI_AUTH_STATE_FILE, a
  // stale detached promise from the previous test would otherwise acquire
  // the state lock on the next test's path and cause a spurious block.
  // Restore to the floor (not delete) so any in-flight write resolves to a
  // temp path rather than the operator's live default.
  afterEach(() => {
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    mock.restore()
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  // mock.module('../core/oauth', ...) below leaks process-wide; re-install the
  // real module so later test files (e.g. oauth.test.ts) see the genuine exports.
  afterAll(() => {
    mock.module('../core/oauth', () => oauthRealExports)
  })

  test('/openai-account add returns dialog with auth URL', async () => {
    const resolveAccount = makeAccount('added-acct', { label: 'work' })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock instructions',
        completion: Promise.resolve(resolveAccount),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    // Dynamic re-import to pick up the mock
    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await bdp('openai-account', 'add work', ctx)

    expect(payload.command).toBe('openai-account')
    expect(payload.text).toContain('https://auth.openai.com/oauth/authorize')
    expect(payload.text).toContain('Add OpenAI Account')
  })

  test('/openai-account add completion writes account to storage (detached)', async () => {
    let resolveAccount!: (account: OAuthAccount) => void
    const completionPromise = new Promise<OAuthAccount>((resolve) => {
      resolveAccount = resolve
    })

    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock instructions',
        completion: completionPromise,
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const client = makeClient()
    const setSpy = spyOn(client.auth, 'set')

    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client,
    }

    const payload = await bdp('openai-account', 'add work', ctx)
    expect(payload.text).toContain('Add OpenAI Account')

    // Resolve the detached completion
    resolveAccount(makeAccount('added-acct', { label: 'work' }))

    // Wait for the detached .then to flush
    await new Promise((r) => setTimeout(r, 50))

    // Verify the account was persisted
    const storage = await loadAccounts(configPath)
    expect(storage?.accounts).toHaveLength(1)
    expect(storage?.accounts[0]?.id).toBe('added-acct')

    // INVARIANT: opencode's auth slot was NEVER called for the add path.
    expect(setSpy).not.toHaveBeenCalled()
  })

  test('/openai-account add is idempotent by label', async () => {
    const resolveAccount = makeAccount('added-acct-2', { label: 'personal' })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock instructions',
        completion: Promise.resolve(resolveAccount),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    // First add
    await bdp('openai-account', 'add personal', ctx)
    await new Promise((r) => setTimeout(r, 50))

    // Second add with same label
    await bdp('openai-account', 'add personal', ctx)
    await new Promise((r) => setTimeout(r, 50))

    const storage = await loadAccounts(configPath)
    expect(storage?.accounts).toHaveLength(1)
  })

  test('INVARIANT: accounts[] does not contain "main" after add', async () => {
    const resolveAccount = makeAccount('fallback-1', { label: 'fb' })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock',
        completion: Promise.resolve(resolveAccount),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    await bdp('openai-account', 'add fb', ctx)
    await new Promise((r) => setTimeout(r, 50))

    const storage = await loadAccounts(configPath)
    for (const a of storage?.accounts ?? []) {
      expect(a.id).not.toBe('main')
    }
  })

  test('main-account rejection: adding same ChatGPT account as main does NOT push', async () => {
    // Pre-seed storage with a mainAccountId
    const seed = {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      mainAccountId: 'chatgpt-main-999',
      accounts: [] as OAuthAccount[],
    }
    await saveAccounts(seed, configPath)

    const resolveAccount = makeAccount('would-be-fallback', {
      accountId: 'chatgpt-main-999',
    })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock',
        completion: Promise.resolve(resolveAccount),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    await bdp('openai-account', 'add test', ctx)
    await new Promise((r) => setTimeout(r, 50))

    // Storage accounts[] should still be empty — main was rejected
    const storage = await loadAccounts(configPath)
    expect(storage?.accounts).toHaveLength(0)
  })

  test('C3/M3: main-rejection calls notify with error message', async () => {
    const seed = {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      mainAccountId: 'chatgpt-main-999',
      accounts: [] as OAuthAccount[],
    }
    await saveAccounts(seed, configPath)

    const resolveAccount = makeAccount('would-be-fallback', {
      accountId: 'chatgpt-main-999',
    })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock',
        completion: Promise.resolve(resolveAccount),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const notifyCalls: Array<{ text: string }> = []
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      notify: (payload) => {
        notifyCalls.push({ text: payload.text })
      },
    }

    await bdp('openai-account', 'add test', ctx)
    await new Promise((r) => setTimeout(r, 50))

    expect(notifyCalls.length).toBe(1)
    expect(notifyCalls[0]?.text).toContain('already your main account')
  })

  test('C3/M3: failure path calls notify with error message', async () => {
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock',
        completion: Promise.reject(new Error('OAuth timeout')),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const notifyCalls: Array<{ text: string }> = []
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      notify: (payload) => {
        notifyCalls.push({ text: payload.text })
      },
    }

    await bdp('openai-account', 'add test', ctx)
    await new Promise((r) => setTimeout(r, 50))

    expect(notifyCalls.length).toBe(1)
    expect(notifyCalls[0]?.text).toContain('OAuth timeout')
  })

  test('/openai-account add returns knobs.url + knobs.instructions for browser flow', async () => {
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Complete authorization in your browser.',
        completion: new Promise(() => {}),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await bdp('openai-account', 'add work', ctx)

    expect(payload.command).toBe('openai-account')
    expect(payload.knobs.url).toBe(
      'https://auth.openai.com/oauth/authorize?mock=true',
    )
    expect(payload.knobs.instructions).toBe(
      'Complete authorization in your browser.',
    )
    expect(payload.text).toContain('Add OpenAI Account')
  })

  test('/openai-account add --headless returns knobs.verificationUrl + knobs.userCode', async () => {
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/codex/device',
        instructions: 'Enter code: ABCD-1234',
        completion: new Promise(() => {}),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await bdp('openai-account', 'add --headless', ctx)

    expect(payload.command).toBe('openai-account')
    expect(payload.knobs.verificationUrl).toBe(
      'https://auth.openai.com/codex/device',
    )
    expect(payload.knobs.userCode).toContain('ABCD-1234')
    expect(payload.text).toContain('Device Code')
  })

  test('/openai-account add completion calls refreshSidebar', async () => {
    const resolveAccount = makeAccount('added-acct', { label: 'work' })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock instructions',
        completion: Promise.resolve(resolveAccount),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const refreshCalls: number[] = []
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      refreshSidebar: async () => {
        refreshCalls.push(1)
      },
    }

    await bdp('openai-account', 'add work', ctx)
    await new Promise((r) => setTimeout(r, 50))

    expect(refreshCalls.length).toBe(1)
    const storage = await loadAccounts(configPath)
    expect(storage?.accounts).toHaveLength(1)
  })

  test('/openai-account add passes label to beginAccountLogin', async () => {
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock',
        completion: new Promise(() => {}),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    await bdp('openai-account', 'add my-label', ctx)

    expect(beginSpy).toHaveBeenCalled()
    const callArg = beginSpy.mock.calls[0]?.[0] as
      | { label?: string }
      | undefined
    expect(callArg?.label).toBe('my-label')
  })

  test('/openai-account add --headless passes headless:true to beginAccountLogin', async () => {
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/codex/device',
        instructions: 'Enter code: XY-99',
        completion: new Promise(() => {}),
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    await bdp('openai-account', 'add --headless my-label', ctx)

    expect(beginSpy).toHaveBeenCalled()
    const callArg = beginSpy.mock.calls[0]?.[0] as
      | { headless?: boolean; label?: string }
      | undefined
    expect(callArg?.headless).toBe(true)
    expect(callArg?.label).toBe('my-label')
  })

  test('/openai-account add completion notifies the session that started the add', async () => {
    let resolveAccount!: (account: OAuthAccount) => void
    const completionPromise = new Promise<OAuthAccount>((resolve) => {
      resolveAccount = resolve
    })
    const beginSpy = mock((_opts?: unknown) =>
      Promise.resolve({
        url: 'https://auth.openai.com/oauth/authorize?mock=true',
        instructions: 'Mock instructions',
        completion: completionPromise,
      }),
    )
    mock.module('../core/oauth', () => {
      const actual = require('../core/oauth')
      return { ...actual, beginAccountLogin: beginSpy }
    })

    const { buildDialogPayload: bdp } = await import('../commands')

    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    const firstSessionCalls: string[] = []
    const secondSessionCalls: string[] = []
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
      sessionId: 'session-one',
      notify: (payload) => {
        firstSessionCalls.push(payload.text)
      },
    }

    await bdp('openai-account', 'add work', ctx)
    ctx.sessionId = 'session-two'
    ctx.notify = (payload) => {
      secondSessionCalls.push(payload.text)
    }

    resolveAccount(makeAccount('added-acct', { label: 'work' }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(firstSessionCalls).toHaveLength(1)
    expect(firstSessionCalls[0]).toContain('Account Added')
    expect(secondSessionCalls).toHaveLength(0)
  })
})
