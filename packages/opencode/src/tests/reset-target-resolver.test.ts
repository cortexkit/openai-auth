import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ResetCreditsDeps,
  resetCreditsSection,
  settingsMutateAccounts,
} from '@cortexkit/openai-auth-core'
// Snapshot the REAL oauth module exports at load time (before any mock.module
// runs). bun's mock.module leaks process-wide and mock.restore() does NOT undo
// it, so without restoring here the beginAccountLogin stub below would poison
// every later test file that imports the core oauth module. We spread into a PLAIN object
// so the snapshot holds the original function references even after the live
// namespace is later replaced; afterAll re-installs it.
import * as oauthLiveNamespace from '../../../core/src/oauth.ts'

const _oauthRealExports = { ...oauthLiveNamespace }

import {
  type AccountQuotaWindow,
  type AccountStorage,
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  QuotaManager,
  renderResetCoordinatorResult,
  runResetCreditRedemption,
  saveAccounts,
} from '@cortexkit/openai-auth-core/internal'
import {
  getAccountPaths,
  getAccountStatePath,
  getAccountStoragePath,
} from '../core/account-paths'
import { openAccountPool } from '../core/pool-accounts'
import { buildResetRedemptionDeps, createResetTargetResolver } from '../index'
import { resetNotificationsForTest } from '../rpc/notifications'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

// The account-add completion runs detached from buildDialogPayload and performs
// lock-based file I/O, so its duration tracks machine load rather than any fixed
// interval. Poll for the observable effect instead of sleeping a guessed amount:
// a fixed tick either fails under CPU contention or wastes time on every run.
async function _waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}
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
  calls: Array<{
    method: string
    accountId: string
    url: string
    body?: string
  }>
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
  const count = fixture.availableCount[accountId] ?? 0
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
    fixture.calls.push({
      method,
      accountId,
      url,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
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

async function makeResetHarness(
  configPath: string,
  now: number,
  fixture: ResetWireFixture,
) {
  const quotaManager = new QuotaManager({
    configPath: getAccountStoragePath(),
    storage: (await loadAccounts(getAccountPaths(configPath))) ?? {
      version: 1,
      accounts: [],
    },
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
    accountStatePath: getAccountStatePath(configPath),
    now: () => now,
  })
  const deps: ResetCreditsDeps = {
    configPath,
    statePath: getAccountStatePath(configPath),
    quotaManager,
    loadAccounts,
    // The reset state is written through the pool store's settings write,
    // as on a migrated install, never by rewriting the account files.
    mutateAccounts: settingsMutateAccounts(
      openAccountPool(getAccountPaths(configPath)),
      undefined,
    ),
    accountKeys: async () => ['main', 'fallback-a'],
    resolveResetTarget,
    fetchImpl: makeResetWire(fixture),
    now: () => now,
    randomUUID: () => 'reset-request-id',
    refreshResetTargetQuota: async (accountKey) => {
      fixture.sidebarRefreshes += 1
      fixture.targetRefreshes.push(accountKey)
      const storage = await loadAccounts(getAccountPaths(configPath))
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
  }
  return { deps, quotaManager }
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
  // Quota command with refreshAllQuota wired → shows fresh per-account quota
  // -----------------------------------------------------------------------

  function _makeQuotaSnapshot(
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
      getAccountPaths(configPath),
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
      accountStatePath: getAccountStatePath(configPath),
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
      statePath: getAccountStatePath(configPath),
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
        accountStatePath: getAccountStatePath(configPath),
        now: () => now,
      })

    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      },
      getAccountPaths(configPath),
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
      getAccountPaths(configPath),
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
      getAccountPaths(configPath),
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
      getAccountPaths(configPath),
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
      getAccountPaths(configPath),
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
      accountStatePath: getAccountStatePath(configPath),
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
      getAccountPaths(configPath),
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
      accountStatePath: getAccountStatePath(configPath),
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
        accountStatePath: getAccountStatePath(configPath),
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
        getAccountPaths(configPath),
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
        accountStatePath: getAccountStatePath(configPath),
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
        getAccountPaths(configPath),
      )
    }

    const noticeInvocation = { notify: () => {} }

    /**
     * The reset section as one process builds it. `restart` leaves the files
     * as an earlier process left them (no fresh accounts) and builds the
     * section anew, with nothing carried over in memory.
     */
    async function resetSection(
      fixture: ResetWireFixture,
      options: { restart?: boolean; at?: number } = {},
    ) {
      if (!options.restart) {
        await saveResetAccounts()
        const init = await openAccountPool(
          getAccountPaths(configPath),
        ).initialize()
        expect(init.status).toBe('initialized')
      }
      const { deps } = await makeResetHarness(
        configPath,
        options.at ?? now,
        fixture,
      )
      const content = await resetCreditsSection(deps).build(noticeInvocation)
      const run = (item: string, action: string) => {
        const found = content.items
          ?.find((entry) => entry.id === item)
          ?.actions?.find((entry) => entry.id === action)
        if (!found) throw new Error(`no ${action} action on ${item}`)
        return found.run({
          values: {},
          itemId: item,
          invocation: noticeInvocation,
        })
      }
      return { content, run }
    }

    test('/openai reset credits: lists main and the accounts, and previews one without spending', async () => {
      const fixture = resetFixture()
      const { content, run } = await resetSection(fixture)

      expect(content.items?.map((item) => item.id)).toEqual([
        'main',
        'fallback-a',
      ])
      const spend = content.items?.[1]?.actions?.find((a) => a.id === 'spend')
      // Spending a credit is irreversible, so the menu confirms it first.
      expect(spend?.irreversible).toBe(true)

      const preview = await run('fallback-a', 'preview')
      const text = typeof preview === 'string' ? preview : preview.text
      expect(text).toContain('100% used')
      expect(text).toContain('2/2 applicable/available')
      expect(text).toContain('Spend a reset credit')
      expect(text).not.toContain('secret')
      expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false)
    })

    test('/openai reset credits: spending redeems on the previewed account and verifies the window', async () => {
      const fixture = resetFixture({ freshAfterPost: true })
      const { run } = await resetSection(fixture)

      const outcome = await run('fallback-a', 'spend')

      expect(typeof outcome === 'string' ? true : outcome.ok).toBe(true)
      const text = typeof outcome === 'string' ? outcome : outcome.text
      expect(text).toContain('Code: `reset`')
      expect(text).toContain('window fresh')
      const posts = fixture.calls.filter((call) => call.method === 'POST')
      expect(posts.map((call) => call.accountId)).toEqual([
        'chatgpt-fallback-a',
      ])
      expect(fixture.targetRefreshes).toEqual(['fallback-a'])
    })

    test('/openai reset credits: a healthy account is refused before anything is spent', async () => {
      const fixture = resetFixture({
        usedPercent: { 'chatgpt-main': 10, 'chatgpt-fallback-a': 10 },
      })
      const { run } = await resetSection(fixture)

      const outcome = await run('fallback-a', 'spend')

      expect(typeof outcome === 'string' ? true : outcome.ok).toBe(false)
      expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false)
    })

    function text(outcome: string | { ok: boolean; text: string }) {
      return typeof outcome === 'string' ? outcome : outcome.text
    }

    function postIds(fixture: ResetWireFixture) {
      return fixture.calls
        .filter((call) => call.method === 'POST')
        .map((call) => {
          const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>
          return [body.redeem_request_id, body.credit_id]
        })
    }

    function savedReset(): Record<string, Record<string, unknown>> {
      return (
        (JSON.parse(readFileSync(configPath, 'utf8')).reset as
          | Record<string, Record<string, unknown>>
          | undefined) ?? {}
      )
    }

    test('/openai reset credits: Retry with no redemption in flight sends nothing', async () => {
      const fixture = resetFixture()
      const { run } = await resetSection(fixture)

      const outcome = await run('main', 'retry')

      expect(text(outcome)).toContain('no active reset redemption to retry')
      expect(postIds(fixture)).toEqual([])
    })

    test('/openai reset credits: an unknown outcome, a restart, then Retry replays the same ids', async () => {
      const first = resetFixture({ throwOnPost: true })
      const { run } = await resetSection(first)
      const stateBefore = readFileSync(statePath, 'utf8')

      const ambiguous = await run('fallback-a', 'spend')

      expect(text(ambiguous)).toContain('outcome is unknown')
      const sent = postIds(first)
      expect(sent).toHaveLength(1)
      // The pair is saved through the store's settings write, in the config;
      // the credential file is not rewritten.
      expect(savedReset()['fallback-a']?.inFlight).toMatchObject({
        redeemRequestId: sent[0]?.[0],
        creditId: sent[0]?.[1],
      })
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore)

      const second = resetFixture({ freshAfterPost: true })
      const restarted = await resetSection(second, { restart: true })
      const retried = await restarted.run('fallback-a', 'retry')

      expect(postIds(second)).toEqual(sent)
      expect(text(retried)).toContain('Code: `reset`')
      expect(savedReset()['fallback-a']?.inFlight).toBeUndefined()
    })

    test('/openai reset credits: Spend while a pair is in flight replays it instead of spending again', async () => {
      const first = resetFixture({ throwOnPost: true })
      await (await resetSection(first)).run('fallback-a', 'spend')
      const sent = postIds(first)

      const second = resetFixture({ outcome: 'already_redeemed' })
      const restarted = await resetSection(second, { restart: true })
      await restarted.run('fallback-a', 'spend')

      expect(postIds(second)).toEqual(sent)
    })

    test('/openai reset credits: Spend is refused while an expired pair is unreconciled, and Retry still replays it', async () => {
      const first = resetFixture({ throwOnPost: true })
      await (await resetSection(first)).run('fallback-a', 'spend')
      const sent = postIds(first)
      const later = now + 6 * 60_000

      const refusedWire = resetFixture()
      const refused = await (
        await resetSection(refusedWire, { restart: true, at: later })
      ).run('fallback-a', 'spend')

      expect(text(refused)).toContain('outcome is unknown')
      expect(text(refused)).toContain('expired_unreconciled')
      expect(refusedWire.calls).toEqual([])

      const retryWire = resetFixture({ outcome: 'already_redeemed' })
      await (await resetSection(retryWire, { restart: true, at: later })).run(
        'fallback-a',
        'retry',
      )
      expect(postIds(retryWire)).toEqual(sent)
    })

    test('/openai reset credits: a restart between the redemption and its result is finished by Retry with the saved ids', async () => {
      const fixture = resetFixture({ outcome: 'already_redeemed' })
      await resetSection(fixture)
      // What a process leaves when it stops after the server took the
      // redemption but before it recorded the result.
      await settingsMutateAccounts(
        openAccountPool(getAccountPaths(configPath)),
        undefined,
      )((current) => {
        current.reset = {
          'fallback-a': {
            inFlight: {
              redeemRequestId: 'request-before-restart',
              creditId: 'credit-chatgpt-fallback-a-1',
              startedAt: now - 1_000,
            },
          },
        }
        return current
      }, getAccountPaths(configPath))

      const restarted = await resetSection(fixture, { restart: true })
      const outcome = await restarted.run('fallback-a', 'retry')

      expect(postIds(fixture)).toEqual([
        ['request-before-restart', 'credit-chatgpt-fallback-a-1'],
      ])
      expect(text(outcome)).toContain('Code: `already_redeemed`')
      const saved = savedReset()['fallback-a']
      expect(saved?.inFlight).toBeUndefined()
      expect(saved?.cooldownUntil).toBeGreaterThan(now)
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

    test('an unknown outcome points at the retry action and shows no identity or token', async () => {
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

      expect(payload.code).toBe('ambiguous')
      expect(payload.ok).toBe(false)
      expect(payload.text).toContain('Retry the last redemption')
      expect(payload.text).not.toContain('preview-bound')
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

      expect(payload.code).toBe('reset')
      expect(payload.text).toContain('outcome recorded as `reset`')
      expect(payload.text).toContain('state write failed')
      expect(payload.text).toContain('same request and credit identifiers')
    })
  })
})
