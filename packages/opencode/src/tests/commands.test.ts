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
import { buildDialogPayload, renderResetCoordinatorResult } from '../commands'
// Snapshot the REAL oauth module exports at load time (before any mock.module
// runs). bun's mock.module leaks process-wide and mock.restore() does NOT undo
// it, so without restoring here the beginAccountLogin stub below would poison
// every later test file that imports ../core/oauth. We spread into a PLAIN object
// so the snapshot holds the original function references even after the live
// namespace is later replaced; afterAll re-installs it.
import * as oauthLiveNamespace from '../core/oauth'

const oauthRealExports = { ...oauthLiveNamespace }

import type {
  AccountQuotaWindow,
  AccountStorage,
  OAuthQuotaSnapshot,
} from '../core/accounts'
import {
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
  saveAccounts,
} from '../core/accounts'
import { QuotaManager } from '../core/quota-manager'
import { runResetCreditRedemption } from '../core/reset-credits'
import { buildResetRedemptionDeps, createResetTargetResolver } from '../index'
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

// Unsigned JWT carrying a single claim — parseJwtClaims only base64url-decodes
// the payload segment and never verifies the signature.
function jwtWithAccountId(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ chatgpt_account_id: accountId }),
  ).toString('base64url')
  return `test-header.${payload}.test-signature`
}

function makeClient(): CommandContext['client'] {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as unknown as CommandContext['client']
}

function fetchStub(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, {
    preconnect: (
      ..._args: Parameters<typeof globalThis.fetch.preconnect>
    ) => {},
  })
}

type ResetWireFixture = {
  usedPercent: Record<string, number>
  applicableCount: Record<string, number>
  availableCount: Record<string, number>
  outcome: 'reset' | 'already_redeemed' | 'nothing_to_reset' | 'no_credit'
  postStatus?: number
  throwOnPost?: boolean
  freshAfterPost?: boolean
  applicableAfterPost?: number
  calls: Array<{ method: string; accountId: string; url: string }>
  targetRefreshes: string[]
  sidebarRefreshes: number
}

function resetFixture(
  overrides: Partial<ResetWireFixture> = {},
): ResetWireFixture {
  return {
    usedPercent: {
      'chatgpt-main': 100,
      'chatgpt-fallback-a': 100,
    },
    applicableCount: {
      'chatgpt-main': 2,
      'chatgpt-fallback-a': 2,
    },
    availableCount: {
      'chatgpt-main': 2,
      'chatgpt-fallback-a': 2,
    },
    outcome: 'reset',
    calls: [],
    targetRefreshes: [],
    sidebarRefreshes: 0,
    ...overrides,
  }
}

function resetCreditResponse(
  accountId: string,
  fixture: ResetWireFixture,
): Response {
  const count = fixture.applicableCount[accountId] ?? 0
  const credits = Array.from({ length: count }, (_, index) => ({
    id: `credit-${accountId}-${index + 1}`,
    status: 'available',
    expires_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    reset_type: 'codex_rate_limits',
    is_supported_by_plan: true,
  }))
  return Response.json({
    credits,
    available_count: fixture.availableCount[accountId] ?? count,
  })
}

function makeResetWire(fixture: ResetWireFixture): typeof globalThis.fetch {
  return fetchStub(async (input, init) => {
    const url = input.toString()
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const accountId = headers.get('chatgpt-account-id') || 'chatgpt-main'
    fixture.calls.push({ method, accountId, url })
    if (method === 'POST') {
      if (fixture.throwOnPost) throw new Error('connection lost')
      if (fixture.postStatus) {
        return Response.json(
          { error: 'upstream failed' },
          { status: fixture.postStatus },
        )
      }
      if (fixture.freshAfterPost) fixture.usedPercent[accountId] = 0
      if (fixture.applicableAfterPost !== undefined) {
        fixture.applicableCount[accountId] = fixture.applicableAfterPost
        fixture.availableCount[accountId] = fixture.applicableAfterPost
      }
      return Response.json({ code: fixture.outcome })
    }
    if (url.endsWith('/wham/usage')) {
      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: fixture.usedPercent[accountId] ?? 0,
            limit_window_seconds: 18_000,
            reset_at: '2026-07-18T00:00:00.000Z',
          },
        },
        rate_limit_reset_credits: {
          available_count: fixture.availableCount[accountId] ?? 0,
          applicable_available_count: fixture.applicableCount[accountId] ?? 0,
        },
      })
    }
    return resetCreditResponse(accountId, fixture)
  })
}

function resetQuotaSnapshot(
  usedPercent: number,
  availableCount: number,
  applicableCount: number,
): OAuthQuotaSnapshot {
  return {
    primary: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      checkedAt: Date.parse('2026-07-17T12:00:00.000Z'),
    },
    resetCreditsAvailable: availableCount,
    resetCreditsApplicable: applicableCount,
  }
}

async function makeResetCommandHarness(
  configPath: string,
  now: number,
  fixture: ResetWireFixture,
) {
  const quotaManager = new QuotaManager({
    storage: (await loadAccounts(configPath)) ?? { version: 1, accounts: [] },
    now: () => now,
  })
  const resolveResetTarget = createResetTargetResolver({
    getAuth: async () => ({
      type: 'oauth',
      access: 'main-token',
      refresh: 'main-refresh',
      expires: now + 6 * 60 * 60_000,
    }),
    refreshMainWithLease: async () => ({
      access: 'refreshed-main-token',
      refresh: 'main-refresh',
      expires: now + 6 * 60 * 60_000,
    }),
    refreshFallbackAccount: async (account) => account,
    loadAccounts,
    accountStoragePath: configPath,
    now: () => now,
  })
  const ctx: CommandContext = {
    accountStoragePath: configPath,
    quotaManager,
    loadAccounts,
    client: makeClient(),
    resolveResetTarget,
    fetchImpl: makeResetWire(fixture),
    now: () => now,
    randomUUID: () => 'reset-request-id',
    refreshResetTargetQuota: async (accountKey) => {
      fixture.sidebarRefreshes += 1
      fixture.targetRefreshes.push(accountKey)
      const storage = await loadAccounts(configPath)
      const fallback = storage?.accounts.find(
        (account) => account.id === accountKey && account.type === 'oauth',
      ) as OAuthAccount | undefined
      const accountId =
        accountKey === 'main' ? 'chatgpt-main' : fallback?.accountId
      const quota = resetQuotaSnapshot(
        fixture.usedPercent[accountId ?? ''] ?? 0,
        fixture.availableCount[accountId ?? ''] ?? 0,
        fixture.applicableCount[accountId ?? ''] ?? 0,
      )
      if (quota.primary) {
        quota.primary = {
          ...quota.primary,
          resetsAt: '2026-07-18T00:00:00.000Z',
        }
      }
      if (accountKey === 'main') {
        quotaManager.setMain('main-token', {
          quota,
          checkedAt: now,
          refreshAfter: now + 300_000,
        })
      } else {
        quotaManager.setFallback(
          accountKey,
          { quota, checkedAt: now, refreshAfter: now + 300_000 },
          fallback?.access,
        )
      }
      return { account: accountKey, ok: true }
    },
    refreshSidebar: async () => {},
  }
  return { ctx, quotaManager }
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

  test('scalar command (routing) with a STALE snapshot does not resurrect a removed account or its secrets', async () => {
    // Disk authoritatively has only account `a` (e.g. `gone` was just removed by
    // another session). The scalar command handler, however, loaded a STALE
    // snapshot that still contains `gone` with real secrets. The scalar write
    // must go through mutateAccounts (fresh disk read, no union), so `gone`'s
    // secrets must NOT be re-written into the state file. This test fails if the
    // routing executor is reverted to loadAccounts+saveAccounts.
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          {
            id: 'a',
            type: 'oauth',
            access: 'acc-a',
            refresh: 'ref-a',
            expires: Date.now() + 3600_000,
            addedAt: Date.now(),
            lastUsed: Date.now(),
          },
        ],
      },
      configPath,
    )

    // A stale in-memory snapshot the command handler "loaded" before the remove.
    const staleSnapshot = {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      accounts: [
        {
          id: 'a',
          type: 'oauth' as const,
          access: 'acc-a',
          refresh: 'ref-a',
          expires: Date.now() + 3600_000,
          addedAt: Date.now(),
          lastUsed: Date.now(),
        },
        {
          id: 'gone',
          type: 'oauth' as const,
          access: 'acc-gone-secret',
          refresh: 'ref-gone-secret',
          expires: Date.now() + 3600_000,
          addedAt: Date.now(),
          lastUsed: Date.now(),
        },
      ],
    }
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      // Inject the stale snapshot as what the handler reads for display.
      loadAccounts: (async () => staleSnapshot) as typeof loadAccounts,
      client: makeClient(),
    }

    await buildDialogPayload('openai-routing', 'fallback-first', ctx)

    // Authoritative disk read: `gone` must not have been resurrected.
    const storage = await loadAccounts(configPath)
    expect(storage?.accounts.map((acc) => acc.id)).toEqual(['a'])
    expect(storage?.routing?.mode).toBe('fallback-first')
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
  // Clock-hour window: HH-HH / window clear
  // -----------------------------------------------------------------------
  test('/openai-cachekeep HH-HH persists window and updates the live gate', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      },
      configPath,
    )
    const setCacheKeepWindow = mock(() => {})
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      setCacheKeepWindow,
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

    const payload = await buildDialogPayload('openai-cachekeep', '9-18', ctx)
    expect(payload.knobs.window).toEqual({ startHour: 9, endHour: 18 })
    expect(setCacheKeepWindow).toHaveBeenCalledWith({
      startHour: 9,
      endHour: 18,
    })
    const storage = await loadAccounts(configPath)
    expect(storage?.cachekeep?.startHour).toBe(9)
    expect(storage?.cachekeep?.endHour).toBe(18)
  })

  test('/openai-cachekeep window clear drops startHour/endHour and clears the live gate', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        cachekeep: {
          enabled: true,
          subagents: false,
          startHour: 9,
          endHour: 18,
        },
      },
      configPath,
    )
    const setCacheKeepWindow = mock(() => {})
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      setCacheKeepWindow,
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

    const payload = await buildDialogPayload(
      'openai-cachekeep',
      'window clear',
      ctx,
    )
    expect(payload.knobs.window).toBeUndefined()
    expect(setCacheKeepWindow).toHaveBeenCalledWith(undefined)
    const storage = await loadAccounts(configPath)
    expect(storage?.cachekeep?.startHour).toBeUndefined()
    expect(storage?.cachekeep?.endHour).toBeUndefined()
    // enabled/subagents stay — only the window fields are dropped.
    expect(storage?.cachekeep?.enabled).toBe(true)
    expect(storage?.cachekeep?.subagents).toBe(false)
  })

  test('/openai-cachekeep HH-HH with equal hours reports invalid and persists nothing', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      },
      configPath,
    )
    const setCacheKeepWindow = mock(() => {})
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      setCacheKeepWindow,
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

    const payload = await buildDialogPayload('openai-cachekeep', '9-9', ctx)
    expect(payload.text.toLowerCase()).toContain('invalid')
    expect(setCacheKeepWindow).not.toHaveBeenCalled()
    const storage = await loadAccounts(configPath)
    expect(storage?.cachekeep?.startHour).toBeUndefined()
    expect(storage?.cachekeep?.endHour).toBeUndefined()
  })

  test('/openai-cachekeep status includes window knob and text label', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        cachekeep: { enabled: true, startHour: 9, endHour: 18 },
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
          running: true,
          tracked: 0,
          generatedAt: 1700000000000,
          startedAt: 1700000000000,
          maxIdleWarmMs: 60 * 60 * 1000,
          maxSubagentIdleMs: 30 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          leadMs: 5000,
          window: { startHour: 9, endHour: 18 },
          targets: [],
        }),
      } as unknown as CommandContext['cacheKeepManager'],
    }
    const payload = await buildDialogPayload('openai-cachekeep', '', ctx)
    expect(payload.knobs.window).toEqual({ startHour: 9, endHour: 18 })
    expect(payload.text).toContain('Window: **09-18**')

    const noWindow = await buildDialogPayload('openai-cachekeep', '', {
      ...ctx,
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
    })
    expect(noWindow.knobs.window).toBeUndefined()
    expect(noWindow.text).toContain('Window: **always (no window)**')
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

  function makeQuotaSnapshot(
    usedPercent: number,
    resetCreditsAvailable?: number,
  ): OAuthQuotaSnapshot {
    const window: AccountQuotaWindow = {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      checkedAt: Date.now(),
    }
    return {
      primary: window,
      ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    }
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

  test('quota command shows reset credits under their own account only', async () => {
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })
    qm.setMain('access-main', {
      quota: makeQuotaSnapshot(15, 4),
      refreshAfter: Date.now() + 5 * 60 * 1000,
      checkedAt: Date.now(),
    })
    qm.setFallback('fb-1', {
      quota: makeQuotaSnapshot(42, 2),
      refreshAfter: Date.now() + 5 * 60 * 1000,
      checkedAt: Date.now(),
    })
    qm.setFallback('fb-2', {
      quota: makeQuotaSnapshot(78),
      refreshAfter: Date.now() + 5 * 60 * 1000,
      checkedAt: Date.now(),
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: qm,
      loadAccounts,
      client: makeClient(),
    }

    const payload = await buildDialogPayload('openai-quota', '', ctx)
    const [mainSection, fallbackSection = ''] = payload.text.split(
      '### Fallback accounts',
    )
    const [fb1Section, fb2Section = ''] = fallbackSection.split('**fb-2**')

    expect(mainSection).toContain('- resets: 4')
    expect(fb1Section).toContain('  - resets: 2')
    expect(fb2Section).not.toContain('resets:')
  })

  test('refreshAllQuota with one failure → short retry state for failing account', async () => {
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

    expect(payload.text).toContain('- fb-2: fetch failed — Refresh to retry')
    expect(payload.text).not.toContain('wham usage check failed: 401')
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

  test('reset coordinator uses the freshly resolved identity for main and the selected fallback only', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        mainAccountId: 'chatgpt-main',
        accounts: [
          makeAccount('fallback-a', {
            access: 'fresh-fallback-a-token',
            accountId: 'chatgpt-fallback-a',
            expires: now + 5 * 60 * 60_000,
          }),
          makeAccount('fallback-b', {
            access: 'fresh-fallback-b-token',
            accountId: 'chatgpt-fallback-b',
            expires: now + 5 * 60 * 60_000,
          }),
        ],
      },
      configPath,
    )

    const refreshMainWithLease = mock(async () => ({
      access: 'unexpected-refreshed-main-token',
      refresh: 'fresh-main-refresh',
      expires: now + 6 * 60 * 60_000,
    }))
    const refreshFallbackAccount = mock(
      async (account: OAuthAccount) => account,
    )
    const resolveTarget = createResetTargetResolver({
      getAuth: async () => ({
        type: 'oauth',
        access: 'fresh-main-token',
        refresh: 'fresh-main-refresh',
        expires: now + 5 * 60 * 60_000,
      }),
      refreshMainWithLease,
      refreshFallbackAccount,
      loadAccounts,
      accountStoragePath: configPath,
      now: () => now,
    })

    const requests: Array<{
      method: string
      headers: Record<string, string>
    }> = []
    const fetchImpl = fetchStub(async (_input, init) => {
      const method = init?.method ?? 'GET'
      requests.push({
        method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (method === 'POST') return Response.json({ code: 'reset' })
      return Response.json({
        credits: [
          {
            id: 'credit-1',
            status: 'available',
            expires_at: '2026-08-01T00:00:00.000Z',
            reset_type: 'codex_rate_limits',
            is_supported_by_plan: true,
          },
        ],
        available_count: 1,
      })
    })
    const deps = {
      configPath,
      mutateAccountsFn: mutateAccounts,
      loadAccountsFn: loadAccounts,
      now: () => now,
      randomUUID: () => 'reset-request-id',
      fetchImpl,
      resolveTarget,
      fetchUsage: async () => ({
        primary: {
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: now,
        },
        resetCreditsApplicable: 1,
      }),
      hasActiveRateLimitMark: () => false,
    }

    await expect(
      runResetCreditRedemption(deps, {
        accountKey: 'main',
        expectedChatgptAccountId: 'stale-chatgpt-main',
        retry: false,
      }),
    ).rejects.toMatchObject({ kind: 'identity_mismatch' })
    expect(requests).toHaveLength(0)

    await runResetCreditRedemption(deps, {
      accountKey: 'main',
      expectedChatgptAccountId: 'chatgpt-main',
      retry: false,
    })
    await runResetCreditRedemption(deps, {
      accountKey: 'fallback-a',
      expectedChatgptAccountId: 'chatgpt-fallback-a',
      retry: false,
    })

    const consumeRequests = requests.filter(
      (request) => request.method === 'POST',
    )
    expect(consumeRequests).toHaveLength(2)
    const [mainConsume, fallbackConsume] = consumeRequests
    expect(mainConsume?.headers.authorization).toBe('Bearer fresh-main-token')
    expect(mainConsume?.headers['chatgpt-account-id']).toBeUndefined()
    expect(fallbackConsume?.headers.authorization).toBe(
      'Bearer fresh-fallback-a-token',
    )
    expect(fallbackConsume?.headers['chatgpt-account-id']).toBe(
      'chatgpt-fallback-a',
    )
    expect(Object.values(fallbackConsume?.headers ?? {})).not.toContain(
      'Bearer fresh-fallback-b-token',
    )
    expect(Object.values(fallbackConsume?.headers ?? {})).not.toContain(
      'chatgpt-fallback-b',
    )
    expect(refreshMainWithLease).toHaveBeenCalledTimes(0)
    expect(refreshFallbackAccount).toHaveBeenCalledTimes(0)
  })

  test('production reset redemption dependencies generate a UUID', () => {
    const deps = buildResetRedemptionDeps()

    expect(deps.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  test('opening reset modal reuses all tokens outside the refresh horizon', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          makeAccount('fallback-a', {
            expires: now + 5 * 60 * 60_000,
            accountId: 'chatgpt-fallback-a',
          }),
          makeAccount('fallback-b', {
            expires: now + 6 * 60 * 60_000,
            accountId: 'chatgpt-fallback-b',
          }),
        ],
      },
      configPath,
    )
    const refreshMainWithLease = mock(async () => ({
      access: 'refreshed-main',
      refresh: 'refresh-main',
      expires: now + 6 * 60 * 60_000,
    }))
    const refreshFallbackAccount = mock(
      async (account: OAuthAccount) => account,
    )
    const resolveResetTarget = createResetTargetResolver({
      getAuth: async () => ({
        type: 'oauth',
        access: 'main-token',
        refresh: 'main-refresh',
        expires: now + 5 * 60 * 60_000,
      }),
      refreshMainWithLease,
      refreshFallbackAccount,
      loadAccounts,
      accountStoragePath: configPath,
      now: () => now,
    })
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
      resolveResetTarget,
      fetchImpl: fetchStub(async () => Response.json({})),
      now: () => now,
      randomUUID: () => 'uuid',
      refreshResetTargetQuota: async (accountKey) => ({
        account: accountKey,
        ok: true,
      }),
    }

    const payload = await buildDialogPayload('openai-reset', '', ctx)

    expect(payload.command).toBe('openai-reset')
    expect(payload.knobs.accounts).toHaveLength(3)
    expect(refreshMainWithLease).toHaveBeenCalledTimes(0)
    expect(refreshFallbackAccount).toHaveBeenCalledTimes(0)
  })

  test('reset command reports unavailable when runtime dependencies are not wired', async () => {
    const ctx: CommandContext = {
      accountStoragePath: configPath,
      quotaManager: new QuotaManager({ storage: { version: 1, accounts: [] } }),
      loadAccounts,
      client: makeClient(),
    }

    const payload = await buildDialogPayload('openai-reset', '', ctx)

    expect(payload.command).toBe('openai-reset')
    expect(payload.text).toContain('Unavailable')
    expect(payload.knobs).toEqual({})
  })

  test('reset identity resolver returns tagged displayable target errors', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    const resolver = () =>
      createResetTargetResolver({
        getAuth: async () => ({
          type: 'oauth',
          access: 'main-token',
          refresh: 'main-refresh',
          expires: now + 5 * 60 * 60_000,
        }),
        refreshMainWithLease: async () => ({
          access: 'main-token',
          refresh: 'main-refresh',
          expires: now + 5 * 60 * 60_000,
        }),
        refreshFallbackAccount: async (account) => account,
        loadAccounts,
        accountStoragePath: configPath,
        now: () => now,
      })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      },
      configPath,
    )
    await expect(resolver()('missing')).rejects.toMatchObject({
      code: 'unknown_account',
      message: expect.stringContaining('not found'),
    })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [makeAccount('disabled', { enabled: false })],
      },
      configPath,
    )
    await expect(resolver()('disabled')).rejects.toMatchObject({
      code: 'disabled_account',
      message: expect.stringContaining('disabled'),
    })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          {
            id: 'api-account',
            type: 'api',
            baseURL: 'https://api.openai.com/v1',
          },
        ],
      },
      configPath,
    )
    await expect(resolver()('api-account')).rejects.toMatchObject({
      code: 'non_oauth_account',
      message: expect.stringContaining('not an OAuth account'),
    })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [makeAccount('tokenless', { access: '', expires: 0 })],
      },
      configPath,
    )
    await expect(resolver()('tokenless')).rejects.toMatchObject({
      code: 'token_unavailable',
      message: expect.stringContaining('no usable access token'),
    })
  })

  test('reset identity resolver derives the main account id from the live access token JWT', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        mainAccountId: 'old-account',
        accounts: [],
      },
      configPath,
    )
    const resolveTarget = createResetTargetResolver({
      getAuth: async () => ({
        type: 'oauth',
        access: jwtWithAccountId('new-account'),
        refresh: 'main-refresh',
        expires: now + 5 * 60 * 60_000,
      }),
      refreshMainWithLease: async () => ({
        access: 'unused-main-token',
        refresh: 'unused-main-refresh',
        expires: now + 6 * 60 * 60_000,
      }),
      refreshFallbackAccount: async (account) => account,
      loadAccounts,
      accountStoragePath: configPath,
      now: () => now,
    })

    const target = await resolveTarget('main')
    expect(target.chatgptAccountId).toBe('new-account')
  })

  test('reset identity resolver falls back to persisted main account id when the token carries no claims', async () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        mainAccountId: 'old-account',
        accounts: [],
      },
      configPath,
    )
    const resolveTarget = createResetTargetResolver({
      getAuth: async () => ({
        type: 'oauth',
        access: 'opaque-token-without-jwt-shape',
        refresh: 'main-refresh',
        expires: now + 5 * 60 * 60_000,
      }),
      refreshMainWithLease: async () => ({
        access: 'unused-main-token',
        refresh: 'unused-main-refresh',
        expires: now + 6 * 60 * 60_000,
      }),
      refreshFallbackAccount: async (account) => account,
      loadAccounts,
      accountStoragePath: configPath,
      now: () => now,
    })

    const target = await resolveTarget('main')
    expect(target.chatgptAccountId).toBe('old-account')
  })

  for (const mutation of ['removed', 'disabled'] as const) {
    test(`reset identity resolver rejects a fallback ${mutation} before its fresh snapshot`, async () => {
      const now = Date.parse('2026-07-17T12:00:00.000Z')
      const account = makeAccount('fallback-a', {
        accountId: 'chatgpt-fallback-a',
        expires: now + 60_000,
      })
      const initial: AccountStorage = { version: 1, accounts: [account] }
      const fresh: AccountStorage = {
        version: 1,
        accounts:
          mutation === 'removed' ? [] : [{ ...account, enabled: false }],
      }
      let loadCount = 0
      const loadAccountsFn: typeof loadAccounts = async () => {
        loadCount += 1
        return loadCount === 1 ? initial : fresh
      }
      const refreshFallbackAccount = mock(async (candidate: OAuthAccount) => ({
        ...candidate,
        access: 'refreshed-fallback-token',
        expires: now + 6 * 60 * 60_000,
      }))
      const resolveTarget = createResetTargetResolver({
        getAuth: async () => ({ type: 'oauth' }),
        refreshMainWithLease: async () => ({
          access: 'unused-main-token',
          refresh: 'unused-main-refresh',
          expires: now + 6 * 60 * 60_000,
        }),
        refreshFallbackAccount,
        loadAccounts: loadAccountsFn,
        accountStoragePath: configPath,
        now: () => now,
      })

      await expect(resolveTarget('fallback-a')).rejects.toMatchObject({
        code: mutation === 'removed' ? 'unknown_account' : 'disabled_account',
      })
      expect(loadCount).toBe(2)
      expect(refreshFallbackAccount).toHaveBeenCalledTimes(1)
    })
  }

  for (const tokenCase of ['missing', 'expired', 'near-expiry'] as const) {
    test(`reset identity resolver refreshes only its ${tokenCase} target exactly once`, async () => {
      const now = Date.parse('2026-07-17T12:00:00.000Z')
      const access = tokenCase === 'missing' ? '' : 'stale-token'
      const expires =
        tokenCase === 'expired'
          ? now - 1
          : tokenCase === 'near-expiry'
            ? now + 60_000
            : now + 5 * 60 * 60_000
      await saveAccounts(
        {
          version: 1,
          main: { type: 'opencode', provider: 'openai' },
          accounts: [
            makeAccount('fallback-a', {
              access,
              expires,
              accountId: 'chatgpt-fallback-a',
            }),
          ],
        },
        configPath,
      )
      const refreshMainWithLease = mock(async () => ({
        access: 'refreshed-main-token',
        refresh: 'refreshed-main-refresh',
        expires: now + 6 * 60 * 60_000,
      }))
      const refreshFallbackAccount = mock(async (account: OAuthAccount) => ({
        ...account,
        access: 'refreshed-fallback-token',
        expires: now + 6 * 60 * 60_000,
      }))
      const resolveTarget = createResetTargetResolver({
        getAuth: async () => ({
          type: 'oauth',
          access,
          refresh: 'main-refresh',
          expires,
        }),
        refreshMainWithLease,
        refreshFallbackAccount,
        loadAccounts,
        accountStoragePath: configPath,
        now: () => now,
      })

      await resolveTarget('main')
      expect(refreshMainWithLease).toHaveBeenCalledTimes(1)
      expect(refreshFallbackAccount).toHaveBeenCalledTimes(0)

      await resolveTarget('fallback-a')
      expect(refreshMainWithLease).toHaveBeenCalledTimes(1)
      expect(refreshFallbackAccount).toHaveBeenCalledTimes(1)
    })
  }

  describe('reset command safety flow', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z')

    async function saveResetAccounts(
      accounts: OAuthAccount[] = [
        makeAccount('fallback-a', {
          accountId: 'chatgpt-fallback-a',
          expires: now + 6 * 60 * 60_000,
        }),
      ],
    ) {
      await saveAccounts(
        {
          version: 1,
          main: { type: 'opencode', provider: 'openai' },
          mainAccountId: 'chatgpt-main',
          accounts,
        },
        configPath,
      )
    }

    test('empty args builds visible account rows with advisory quota and exact credit data', async () => {
      await saveResetAccounts([
        makeAccount('fallback-a', {
          label: 'Fallback A',
          accountId: 'chatgpt-fallback-a',
          expires: now + 6 * 60 * 60_000,
        }),
        makeAccount('healthy', {
          accountId: 'chatgpt-healthy',
          expires: now + 6 * 60 * 60_000,
        }),
        makeAccount('no-credits', {
          accountId: 'chatgpt-no-credits',
          expires: now + 6 * 60 * 60_000,
        }),
        makeAccount('disabled', {
          accountId: 'chatgpt-disabled',
          enabled: false,
        }),
      ])
      const fixture = resetFixture({
        usedPercent: {
          'chatgpt-main': 100,
          'chatgpt-fallback-a': 100,
          'chatgpt-healthy': 42,
          'chatgpt-no-credits': 100,
        },
        applicableCount: {
          'chatgpt-main': 2,
          'chatgpt-fallback-a': 3,
          'chatgpt-healthy': 1,
          'chatgpt-no-credits': 0,
        },
        availableCount: {
          'chatgpt-main': 4,
          'chatgpt-fallback-a': 5,
          'chatgpt-healthy': 1,
          'chatgpt-no-credits': 2,
        },
      })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload('openai-reset', '', ctx)
      const rows = payload.knobs.accounts as Array<Record<string, unknown>>

      expect(payload.knobs.stage).toBe('accounts')
      expect(rows.map((row) => row.accountKey)).toEqual([
        'main',
        'fallback-a',
        'healthy',
        'no-credits',
      ])
      expect(rows[1]).toMatchObject({
        accountKey: 'fallback-a',
        label: 'Fallback A',
        usedPercent: 100,
        availableCount: 5,
        applicableAvailableCount: 3,
        eligible: true,
        selectedCreditId: 'credit-chatgpt-fallback-a-1',
        selectedCreditExpiresAt: '2026-08-01T00:00:00.000Z',
      })
      expect(rows.find((row) => row.accountKey === 'healthy')).toMatchObject({
        eligible: false,
        reason: 'not exhausted',
      })
      expect(rows.find((row) => row.accountKey === 'no-credits')).toMatchObject(
        {
          eligible: false,
          reason: 'no applicable credits',
        },
      )
      expect(payload.text).toContain('not exhausted')
      expect(payload.text).toContain('no applicable credits')
    })

    test('exhausted main preview is eligible when usage reports three applicable credits', async () => {
      await saveResetAccounts([])
      const fixture = resetFixture({
        usedPercent: { 'chatgpt-main': 100 },
        applicableCount: { 'chatgpt-main': 3 },
        availableCount: { 'chatgpt-main': 3 },
      })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload('openai-reset', '', ctx)
      const rows = payload.knobs.accounts as Array<Record<string, unknown>>

      expect(rows).toContainEqual(
        expect.objectContaining({
          accountKey: 'main',
          availableCount: 3,
          applicableAvailableCount: 3,
          eligible: true,
        }),
      )
    })

    test('account preview keeps per-account failures visible and requires a stable identity for action', async () => {
      await saveResetAccounts([
        makeAccount('broken', {
          accountId: 'chatgpt-broken',
          expires: now + 6 * 60 * 60_000,
        }),
        makeAccount('missing-identity', {
          accountId: undefined,
          expires: now + 6 * 60 * 60_000,
        }),
      ])
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      const resolveTarget = ctx.resolveResetTarget
      if (!resolveTarget) throw new Error('reset target resolver is not wired')
      ctx.resolveResetTarget = async (accountKey) => {
        if (accountKey === 'broken')
          throw new Error('quota endpoint unavailable')
        return resolveTarget(accountKey)
      }

      const payload = await buildDialogPayload('openai-reset', '', ctx)
      const rows = payload.knobs.accounts as Array<Record<string, unknown>>

      expect(rows.find((row) => row.accountKey === 'broken')).toMatchObject({
        eligible: false,
        reason: 'quota endpoint unavailable',
      })
      expect(
        rows.find((row) => row.accountKey === 'missing-identity'),
      ).toMatchObject({
        eligible: false,
        reason: 'stable ChatGPT account identity unavailable',
      })
      expect(payload.text).toContain('quota endpoint unavailable')
      expect(payload.text).toContain(
        'stable ChatGPT account identity unavailable',
      )
    })

    test('select decodes the account key and returns a fresh token-free confirmation preview', async () => {
      const accountKey = 'fallback/a b'
      const accountId = 'chatgpt/fallback a'
      await saveResetAccounts([
        makeAccount(accountKey, {
          label: 'Encoded fallback',
          accountId,
          expires: now + 6 * 60 * 60_000,
        }),
      ])
      const fixture = resetFixture({
        usedPercent: { [accountId]: 100 },
        applicableCount: { [accountId]: 2 },
        availableCount: { [accountId]: 4 },
      })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload(
        'openai-reset',
        `select ${encodeURIComponent(accountKey)}`,
        ctx,
      )

      expect(payload.knobs.stage).toBe('confirm')
      expect(payload.knobs.preview).toMatchObject({
        accountKey,
        chatgptAccountId: accountId,
      })
      expect(payload.text).toContain('Encoded fallback')
      expect(payload.text).toContain('100%')
      expect(payload.text).toContain('Spend 1 of 2')
      expect(payload.text).toContain('2026-08-01T00:00:00.000Z')
      expect(payload.text).toContain('2026-07-18T00:00:00.000Z')
      expect(JSON.stringify(payload.knobs)).not.toContain('fallback/a b-token')
      expect(JSON.stringify(payload.knobs)).not.toContain('access')
    })

    test('select returns an informational result instead of confirmation for an ineligible account', async () => {
      await saveResetAccounts()
      const fixture = resetFixture({
        usedPercent: { 'chatgpt-fallback-a': 42 },
        applicableCount: { 'chatgpt-fallback-a': 3 },
        availableCount: { 'chatgpt-fallback-a': 3 },
      })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload(
        'openai-reset',
        'select fallback-a',
        ctx,
      )

      expect(payload.knobs).toMatchObject({
        stage: 'result',
        code: 'not_eligible',
        accountKey: 'fallback-a',
      })
      expect(payload.knobs).not.toHaveProperty('preview')
      expect(payload.text).toContain('Cannot reset:')
      expect(payload.text).toContain('not exhausted')
    })

    test('select refuses prototype-sensitive decoded account keys before resolution', async () => {
      await saveResetAccounts()
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      const resolveResetTarget = mock(ctx.resolveResetTarget!)
      ctx.resolveResetTarget = resolveResetTarget

      const payload = await buildDialogPayload(
        'openai-reset',
        `select ${encodeURIComponent('__proto__')}`,
        ctx,
      )

      expect(payload.knobs).toMatchObject({
        stage: 'result',
        code: 'invalid_command',
      })
      expect(payload.text).toContain('Usage:')
      expect(resolveResetTarget).not.toHaveBeenCalled()
    })

    test('preview reset time prefers a still-live exhausted window over a stale exhausted window', async () => {
      await saveResetAccounts()
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      const liveReset = '2026-07-18T00:00:00.000Z'
      ctx.fetchImpl = fetchStub(async (input) => {
        if (input.toString().endsWith('/wham/usage')) {
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 100,
                reset_at: '2026-07-17T11:00:00.000Z',
              },
              secondary_window: {
                used_percent: 100,
                reset_at: liveReset,
              },
            },
            rate_limit_reset_credits: {
              available_count: 2,
              applicable_available_count: 2,
            },
          })
        }
        return resetCreditResponse('chatgpt-fallback-a', fixture)
      })

      const payload = await buildDialogPayload(
        'openai-reset',
        'select fallback-a',
        ctx,
      )

      expect(payload.knobs.preview).toMatchObject({ resetTime: liveReset })
    })

    for (const mutation of [
      'removed fallback',
      'disabled fallback',
      'changed fallback account id',
      'changed main account id',
    ] as const) {
      test(`confirm refuses a ${mutation} before list or consume`, async () => {
        await saveResetAccounts()
        const fixture = resetFixture()
        const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
        const accountKey =
          mutation === 'changed main account id' ? 'main' : 'fallback-a'
        const expectedId =
          accountKey === 'main' ? 'chatgpt-main' : 'chatgpt-fallback-a'

        await buildDialogPayload(
          'openai-reset',
          `select ${encodeURIComponent(accountKey)}`,
          ctx,
        )
        const callsBeforeConfirm = fixture.calls.length
        await mutateAccounts((storage) => {
          if (mutation === 'removed fallback') storage.accounts = []
          if (mutation === 'disabled fallback') {
            const first = storage.accounts[0]
            if (first) first.enabled = false
          }
          if (mutation === 'changed fallback account id') {
            const first = storage.accounts[0]
            if (first?.type === 'oauth') {
              first.accountId = 'chatgpt-fallback-replacement'
            }
          }
          if (mutation === 'changed main account id') {
            storage.mainAccountId = 'chatgpt-main-replacement'
          }
          return storage
        }, configPath)

        const payload = await buildDialogPayload(
          'openai-reset',
          `confirm ${encodeURIComponent(accountKey)} ${encodeURIComponent(expectedId)}`,
          ctx,
        )

        const expectedCode =
          mutation === 'removed fallback'
            ? 'unknown_account'
            : mutation === 'disabled fallback'
              ? 'disabled_account'
              : 'identity_mismatch'
        expect(payload.knobs).toMatchObject({
          stage: 'result',
          code: expectedCode,
        })
        expect(payload.text).toContain(
          expectedCode === 'identity_mismatch'
            ? 'account identity changed'
            : 'Account unavailable',
        )
        expect(fixture.calls).toHaveLength(callsBeforeConfirm)
      })
    }

    for (const { code, expected } of [
      {
        code: 'non_oauth_account',
        expected: 'not authenticated with OAuth',
      },
      { code: 'token_unavailable', expected: 'token is unavailable' },
    ] as const) {
      test(`confirm renders truthful ${code} copy`, async () => {
        await saveResetAccounts()
        const fixture = resetFixture()
        const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
        ctx.resolveResetTarget = async () => {
          throw Object.assign(new Error('internal resolver detail'), { code })
        }

        const payload = await buildDialogPayload(
          'openai-reset',
          'confirm fallback-a chatgpt-fallback-a',
          ctx,
        )

        expect(payload.knobs.code).toBe(code)
        expect(payload.text).toContain(expected)
        expect(payload.text).not.toContain('identity changed')
      })
    }

    test('confirm rechecks a stale exhausted preview and refuses when the fresh quota is healthy', async () => {
      await saveResetAccounts()
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      await buildDialogPayload('openai-reset', 'select fallback-a', ctx)
      expect(
        (await loadAccounts(configPath))?.reset?.['fallback-a'],
      ).toBeUndefined()
      fixture.usedPercent['chatgpt-fallback-a'] = 20
      const postsBefore = fixture.calls.filter(
        (call) => call.method === 'POST',
      ).length
      const listsBefore = fixture.calls.filter((call) =>
        call.url.endsWith('/rate_limit_reset_credits'),
      ).length

      const payload = await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        ctx,
      )

      expect(payload.knobs).toMatchObject({
        stage: 'result',
        code: 'not_exhausted',
      })
      expect(payload.text).toContain('not exhausted')
      expect(
        fixture.calls.filter((call) => call.method === 'POST'),
      ).toHaveLength(postsBefore)
      expect(
        fixture.calls.filter((call) =>
          call.url.endsWith('/rate_limit_reset_credits'),
        ),
      ).toHaveLength(listsBefore)
      expect(
        (await loadAccounts(configPath))?.reset?.['fallback-a'],
      ).toBeUndefined()
    })

    test('confirm refuses a near-limit 99.9% snapshot', async () => {
      await saveResetAccounts()
      const fixture = resetFixture({
        usedPercent: { 'chatgpt-fallback-a': 99.9 },
      })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        ctx,
      )

      expect(payload.knobs.code).toBe('not_exhausted')
      expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false)
    })

    test('confirm reports cooldown before POST and tells the user quota is being rechecked', async () => {
      await saveResetAccounts()
      await mutateAccounts((storage) => {
        storage.reset = {
          'fallback-a': { cooldownUntil: now + 30_000 },
        }
        return storage
      }, configPath)
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        ctx,
      )

      expect(payload.knobs.code).toBe('cooldown_active')
      expect(payload.text).toContain('just reset — re-checking quota')
      expect(fixture.calls).toHaveLength(0)
    })

    test('confirm refuses an expired unreconciled attempt with bound retry guidance and no wire call', async () => {
      await saveResetAccounts()
      await mutateAccounts((storage) => {
        storage.reset = {
          'fallback-a': {
            inFlight: {
              redeemRequestId: 'expired-request',
              creditId: 'expired-credit',
              startedAt: now - 5 * 60_000 - 1,
            },
          },
        }
        return storage
      }, configPath)
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        ctx,
      )

      expect(payload.knobs).toMatchObject({
        stage: 'result',
        code: 'expired_unreconciled',
        accountKey: 'fallback-a',
        chatgptAccountId: 'chatgpt-fallback-a',
        retryGuidance: expect.any(String),
      })
      expect(payload.text).toContain('previous attempt outcome is unknown')
      expect(payload.text).toContain('retry replays the same identifiers')
      expect(fixture.calls).toHaveLength(0)
    })

    for (const outcome of ['reset', 'already_redeemed'] as const) {
      test(`${outcome} runs targeted post-verification and reports a fresh window only from the refreshed snapshot`, async () => {
        await saveResetAccounts()
        const fixture = resetFixture({
          outcome,
          freshAfterPost: true,
          applicableAfterPost: 0,
        })
        const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

        const payload = await buildDialogPayload(
          'openai-reset',
          'confirm fallback-a chatgpt-fallback-a',
          ctx,
        )

        expect(payload.knobs).toMatchObject({
          stage: 'result',
          code: outcome,
          verifiedFresh: true,
          remainingCredits: 0,
        })
        expect(payload.knobs).not.toHaveProperty('chatgptAccountId')
        expect(payload.text).toContain('window fresh')
        expect(fixture.targetRefreshes).toEqual(['fallback-a'])
        expect(fixture.sidebarRefreshes).toBe(1)
      })
    }

    test('post-verification refresh failure is logged and surfaced without claiming a fresh window', async () => {
      await saveResetAccounts()
      const fixture = resetFixture({ outcome: 'reset' })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      ctx.refreshResetTargetQuota = async () => {
        throw new Error('targeted refresh unavailable')
      }
      const logDir = mkdtempSync(join(tmpdir(), 'oai-reset-post-verify-'))
      const logFile = join(logDir, 'test.log')
      const savedLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
      const savedLogLevel = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
      try {
        process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
        setLogLevel('info')

        const payload = await buildDialogPayload(
          'openai-reset',
          'confirm fallback-a chatgpt-fallback-a',
          ctx,
        )
        await flushForTest()
        const logged = readFileSync(logFile, 'utf8')

        expect(payload.text).toContain('window not yet refreshed')
        expect(payload.text).toContain('quota re-check failed — see log')
        expect(logged).toContain('reset quota re-check failed')
        expect(logged).toContain('fallback-a')
        expect(logged).toContain('targeted refresh unavailable')
      } finally {
        process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = savedLogFile
        if (savedLogLevel !== undefined) {
          process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = savedLogLevel
        }
        setLogLevel(undefined)
        rmSync(logDir, { recursive: true, force: true })
      }
    })

    test('generic reset failures hide internal details from the dialog and log them', async () => {
      await saveResetAccounts()
      const fixture = resetFixture()
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      ctx.resolveResetTarget = async () => {
        throw new Error('/private/plugin/path: sensitive internal detail')
      }
      const logDir = mkdtempSync(join(tmpdir(), 'oai-reset-generic-error-'))
      const logFile = join(logDir, 'test.log')
      const savedLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
      try {
        process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
        setLogLevel('info')

        const payload = await buildDialogPayload(
          'openai-reset',
          'confirm fallback-a chatgpt-fallback-a',
          ctx,
        )
        await flushForTest()
        const logged = readFileSync(logFile, 'utf8')

        expect(payload.text).toContain(
          'internal command failure — see plugin log',
        )
        expect(payload.text).not.toContain('/private/plugin/path')
        expect(logged).toContain('/private/plugin/path')
      } finally {
        process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = savedLogFile
        setLogLevel(undefined)
        rmSync(logDir, { recursive: true, force: true })
      }
    })

    test('ambiguous local renderer preserves no-request guidance without success or retry guarantees', async () => {
      const result = {
        target: {
          accountKey: 'fallback-a',
          label: 'Fallback A',
          accessToken: 'secret-token',
          chatgptAccountId: 'chatgpt-fallback-a',
        },
        selectedCredit: undefined,
        beforeState: undefined,
        outcome: {
          kind: 'ambiguous_local' as const,
          raw: { reason: 'corrupt_in_flight' as const },
        },
        retrySafety:
          'No request was sent because the saved redemption identity was incomplete.',
      }

      const payload = await renderResetCoordinatorResult(
        result,
        {} as Parameters<typeof renderResetCoordinatorResult>[1],
      )

      expect(payload.text).toContain('No request was sent')
      expect(payload.text.toLowerCase()).not.toContain('success')
      expect(payload.text).not.toContain('retry is free')
      expect(payload.text).not.toContain('guaranteed')
      expect(payload.text).not.toContain('secret-token')
    })

    test('retry-safe renderer carries the preview-bound identity instead of rebuilding it from the result target', async () => {
      const result = {
        target: {
          accountKey: 'fallback/a b',
          label: 'Fallback A',
          accessToken: 'secret-token',
          chatgptAccountId: 'resolved-target-id',
        },
        selectedCredit: { id: 'credit-1' },
        beforeState: undefined,
        outcome: {
          kind: 'ambiguous' as const,
          raw: new Error('connection lost'),
        },
        retrySafety:
          'The outcome is uncertain. A retry reuses the same request and credit identifiers.',
      }

      const payload = await renderResetCoordinatorResult(
        result,
        {} as Parameters<typeof renderResetCoordinatorResult>[1],
        'preview-bound/id',
      )

      expect(payload.knobs).toMatchObject({
        accountKey: 'fallback/a b',
        chatgptAccountId: 'preview-bound/id',
      })
      expect(payload.text).toContain(encodeURIComponent('preview-bound/id'))
      expect(payload.text).not.toContain('resolved-target-id')
      expect(payload.text).not.toContain('secret-token')
    })

    test('terminal result with a failed finalize write keeps the known outcome and offers identifier reuse', async () => {
      const result = {
        target: {
          accountKey: 'fallback-a',
          label: 'Fallback A',
          accessToken: 'secret-token',
          chatgptAccountId: 'chatgpt-fallback-a',
        },
        selectedCredit: { id: 'credit-1' },
        beforeState: undefined,
        outcome: { kind: 'reset' as const, raw: { code: 'reset' } },
        retrySafety: 'same identifiers',
        finalizeStateWriteFailed: true,
      }

      const payload = await renderResetCoordinatorResult(
        result,
        {} as Parameters<typeof renderResetCoordinatorResult>[1],
        'chatgpt-fallback-a',
      )

      expect(payload.knobs).toMatchObject({
        code: 'reset',
        stateWriteFailed: true,
        chatgptAccountId: 'chatgpt-fallback-a',
      })
      expect(payload.text).toContain('outcome recorded as `reset`')
      expect(payload.text).toContain('state write failed')
      expect(payload.text).toContain('same request and credit identifiers')
    })

    test('reset does not call an exhausted post-refresh snapshot fresh', async () => {
      await saveResetAccounts()
      const fixture = resetFixture({ outcome: 'reset' })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

      const payload = await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        ctx,
      )

      expect(payload.knobs).toMatchObject({
        code: 'reset',
        verifiedFresh: false,
      })
      expect(payload.text).toContain('window not yet refreshed')
      expect(payload.text).not.toContain('window fresh')
    })

    for (const outcome of ['nothing_to_reset', 'no_credit'] as const) {
      test(`${outcome} preserves the exact no-op code without claiming success`, async () => {
        await saveResetAccounts()
        const fixture = resetFixture({ outcome })
        const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

        const payload = await buildDialogPayload(
          'openai-reset',
          'confirm fallback-a chatgpt-fallback-a',
          ctx,
        )

        expect(payload.knobs.code).toBe(outcome)
        expect(payload.knobs).not.toHaveProperty('chatgptAccountId')
        expect(payload.text).toContain(outcome)
        expect(payload.text.toLowerCase()).not.toContain('success')
        expect(payload.text).toContain(
          'A new attempt starts fresh and must pass the current preconditions.',
        )
        expect(fixture.targetRefreshes).toHaveLength(0)
      })
    }

    for (const outcome of ['ambiguous', 'http_error'] as const) {
      test(`${outcome} reports an unknown outcome with bounded retry guidance and no post-verification`, async () => {
        await saveResetAccounts()
        const fixture = resetFixture(
          outcome === 'ambiguous' ? { throwOnPost: true } : { postStatus: 503 },
        )
        const { ctx } = await makeResetCommandHarness(configPath, now, fixture)

        const payload = await buildDialogPayload(
          'openai-reset',
          'confirm fallback-a chatgpt-fallback-a',
          ctx,
        )

        expect(payload.knobs.code).toBe(outcome)
        expect(payload.knobs).toMatchObject({
          accountKey: 'fallback-a',
          chatgptAccountId: 'chatgpt-fallback-a',
        })
        expect(payload.text).toContain('outcome is unknown')
        expect(payload.text).toContain('same request and credit identifiers')
        expect(payload.text).not.toContain('retry is free')
        expect(payload.text).not.toContain('guaranteed')
        expect(fixture.targetRefreshes).toHaveLength(0)
      })
    }

    test('retry decodes the bound identity and reuses the persisted in-flight request', async () => {
      await saveResetAccounts()
      const firstFixture = resetFixture({ throwOnPost: true })
      const harness = await makeResetCommandHarness(
        configPath,
        now,
        firstFixture,
      )
      await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        harness.ctx,
      )
      const state = (await loadAccounts(configPath))?.reset?.['fallback-a']
      expect(state?.inFlight?.redeemRequestId).toBe('reset-request-id')
      firstFixture.throwOnPost = false
      firstFixture.outcome = 'nothing_to_reset'

      const payload = await buildDialogPayload(
        'openai-reset',
        `retry ${encodeURIComponent('fallback-a')} ${encodeURIComponent('chatgpt-fallback-a')}`,
        harness.ctx,
      )

      expect(payload.knobs.code).toBe('nothing_to_reset')
      const postBodies = firstFixture.calls.filter(
        (call) => call.method === 'POST',
      )
      expect(postBodies).toHaveLength(2)
    })

    test('result text remains useful without a connected TUI', async () => {
      await saveResetAccounts()
      const fixture = resetFixture({ outcome: 'no_credit' })
      const { ctx } = await makeResetCommandHarness(configPath, now, fixture)
      ctx.notify = undefined

      const payload = await buildDialogPayload(
        'openai-reset',
        'confirm fallback-a chatgpt-fallback-a',
        ctx,
      )

      expect(payload.text.length).toBeGreaterThan(60)
      expect(payload.text).toContain('fallback-a')
      expect(payload.text).toContain('no_credit')
    })
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
