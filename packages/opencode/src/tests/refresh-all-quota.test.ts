import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountQuotaWindow,
  CUSTODY_REFUSE,
  type FallbackAccount,
  hashRefreshToken,
  type OAuthQuotaSnapshot,
  QuotaManager,
  type RefreshAllQuotaDeps,
  refreshAllQuota,
} from '@cortexkit/openai-auth-core/internal'

import { getAccountStoragePath } from '../core/account-paths'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarState,
  normalizeSidebarState,
} from '../sidebar-state'

function makeQuotaSnapshot(usedPercent: number): OAuthQuotaSnapshot {
  const window: AccountQuotaWindow = {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    checkedAt: Date.now(),
  }
  return { primary: window }
}

function sidebarSnapshot(checkedAt: unknown) {
  return {
    main: {
      mainAccountId: 'chatgpt-main',
      quota: { primary: { checkedAt } },
    },
    fallbacks: [
      {
        id: 'fb-1',
        accountId: 'chatgpt-fb1',
        quota: { primary: { checkedAt } },
      },
      {
        id: 'fb-2',
        accountId: 'chatgpt-fb2',
        quota: { primary: { checkedAt } },
      },
    ],
  }
}

async function withSidebarFile(
  contents: string | undefined,
  run: (path: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'oai-quota-refresh-'))
  const path = join(dir, 'sidebar.json')
  try {
    if (contents !== undefined) writeFileSync(path, contents)
    await run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface MakeDepsOptions extends Partial<RefreshAllQuotaDeps> {
  accounts?: FallbackAccount[]
}

function makeDeps(opts: MakeDepsOptions = {}): RefreshAllQuotaDeps {
  const qm = new QuotaManager({
    configPath: getAccountStoragePath(),
    storage: { version: 1 as const, accounts: [] },
  })

  const defaultAccounts: FallbackAccount[] = [
    {
      id: 'fb-1',
      type: 'oauth' as const,
      access: 'access-fb1',
      refresh: 'refresh-fb1',
      expires: Date.now() + 3600_000,
      enabled: true,
      accountId: 'chatgpt-fb1',
    },
    {
      id: 'fb-2',
      type: 'oauth' as const,
      access: 'access-fb2',
      refresh: 'refresh-fb2',
      expires: Date.now() + 3600_000,
      enabled: true,
      accountId: 'chatgpt-fb2',
    },
  ]

  const accounts = opts.accounts ?? defaultAccounts

  const storage = {
    version: 1 as const,
    accounts,
    mainAccountId: 'chatgpt-main',
  }

  const deps: RefreshAllQuotaDeps = {
    getAuth: mock(async () => ({
      type: 'oauth' as const,
      access: 'access-main',
      refresh: 'refresh-main',
      expires: Date.now() + 3600_000,
    })),
    codexRefreshFn: mock(async () => ({
      access: 'access-refreshed',
      refresh: 'refresh-new',
      expires: Date.now() + 7200_000,
    })),
    refreshMainWithLease: mock(async () => ({
      access: 'access-refreshed',
      refresh: 'refresh-new',
      expires: Date.now() + 7200_000,
    })),
    fallbackManager: {
      refreshAccount: mock(async (acct) => acct),
    } as unknown as RefreshAllQuotaDeps['fallbackManager'],
    quotaManager: qm,
    loadAccounts: mock(async () => storage),
    writeSidebarState: mock(async () => {}),
    client: {
      auth: {
        set: mock(async () => {}),
      },
    },
    fetchImpl: fetch,
    now: () => Date.now(),
    paths: {
      configPath: '/tmp/test-config.json',
      statePath: '/tmp/test-config.state.json',
    },
    storageMainAccountId: 'chatgpt-main',
    isOAuthAccountFn: ((a: unknown) =>
      (a as { type?: string })?.type ===
      'oauth') as RefreshAllQuotaDeps['isOAuthAccountFn'],
    whamFn: mock(async () => makeQuotaSnapshot(30)),
    readSidebarState: mock(async () => DEFAULT_SIDEBAR_STATE),
  }

  const { accounts: _a, ...rest } = opts
  Object.assign(deps, rest)

  return deps
}

describe('refreshAllQuota', () => {
  test('main refresh reads the current persisted account identity at call time', async () => {
    const deps = makeDeps()
    const whamFn = mock(async () => makeQuotaSnapshot(30))
    deps.whamFn = whamFn
    deps.loadAccounts = mock(async () => ({
      version: 1 as const,
      accounts: [],
      mainAccountId: 'chatgpt-fresh-main',
    }))

    await refreshAllQuota(deps, { accountKey: 'main' })

    expect(whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'chatgpt-fresh-main' }),
    )
  })

  test('accountKey main refreshes only main and clears only its healthy rate-limit mark', async () => {
    const deps = makeDeps()
    const setMain = mock(deps.quotaManager.setMain.bind(deps.quotaManager))
    const setFallback = mock(
      deps.quotaManager.setFallback.bind(deps.quotaManager),
    )
    deps.quotaManager.setMain = setMain
    deps.quotaManager.setFallback = setFallback
    const future = Date.now() + 60_000
    deps.quotaManager.markRateLimited('main', future)
    deps.quotaManager.markRateLimited('fb-1', future)

    const results = await refreshAllQuota(deps, { accountKey: 'main' })

    expect(results).toEqual([{ account: 'main', ok: true }])
    expect(deps.getAuth).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'access-main',
        accountId: 'chatgpt-main',
      }),
    )
    expect(deps.quotaManager.getMain()?.quota?.primary?.usedPercent).toBe(30)
    expect(setMain).toHaveBeenCalledTimes(1)
    expect(setFallback).not.toHaveBeenCalled()
    expect(deps.fallbackManager.refreshAccount).not.toHaveBeenCalled()
    expect(deps.quotaManager.getFallback('fb-1')).toBeNull()
    expect(deps.quotaManager.isRateLimited('main')).toBe(false)
    expect(deps.quotaManager.isRateLimited('fb-1')).toBe(true)
    expect(deps.writeSidebarState).toHaveBeenCalledTimes(1)
  })

  test('accountKey fallback-a refreshes only that OAuth fallback and clears only its healthy rate-limit mark', async () => {
    const deps = makeDeps({
      accounts: [
        {
          id: 'fallback-a',
          type: 'oauth' as const,
          access: 'access-fallback-a',
          refresh: 'refresh-fallback-a',
          expires: Date.now() + 3600_000,
          enabled: true,
          accountId: 'chatgpt-fallback-a',
        },
        {
          id: 'fallback-b',
          type: 'oauth' as const,
          access: 'access-fallback-b',
          refresh: 'refresh-fallback-b',
          expires: Date.now() + 3600_000,
          enabled: true,
          accountId: 'chatgpt-fallback-b',
        },
      ],
    })
    const setMain = mock(deps.quotaManager.setMain.bind(deps.quotaManager))
    const setFallback = mock(
      deps.quotaManager.setFallback.bind(deps.quotaManager),
    )
    deps.quotaManager.setMain = setMain
    deps.quotaManager.setFallback = setFallback
    const future = Date.now() + 60_000
    deps.quotaManager.markRateLimited('fallback-a', future)
    deps.quotaManager.markRateLimited('fallback-b', future)

    const results = await refreshAllQuota(deps, { accountKey: 'fallback-a' })

    expect(results).toEqual([{ account: 'fallback-a', ok: true }])
    expect(deps.getAuth).not.toHaveBeenCalled()
    expect(deps.client.auth.set).not.toHaveBeenCalled()
    expect(deps.fallbackManager.refreshAccount).toHaveBeenCalledTimes(1)
    expect(deps.fallbackManager.refreshAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fallback-a' }),
      expect.anything(),
    )
    expect(deps.whamFn).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'access-fallback-a',
        accountId: 'chatgpt-fallback-a',
      }),
    )
    expect(deps.quotaManager.getMain()).toBeNull()
    expect(setMain).not.toHaveBeenCalled()
    expect(setFallback).toHaveBeenCalledTimes(1)
    expect(
      deps.quotaManager.getFallback('fallback-a')?.quota?.primary?.usedPercent,
    ).toBe(30)
    expect(deps.quotaManager.getFallback('fallback-b')).toBeNull()
    expect(deps.quotaManager.isRateLimited('fallback-a')).toBe(false)
    expect(deps.quotaManager.isRateLimited('fallback-b')).toBe(true)
    expect(deps.writeSidebarState).toHaveBeenCalledTimes(1)
  })

  test.each([
    {
      label: 'unknown',
      accountKey: 'missing',
      selected: undefined,
    },
    {
      label: 'disabled',
      accountKey: 'selected-disabled',
      selected: {
        id: 'selected-disabled',
        type: 'oauth' as const,
        access: 'access-disabled',
        refresh: 'refresh-disabled',
        expires: Date.now() + 3600_000,
        enabled: false,
      },
    },
    {
      label: 'non-OAuth',
      accountKey: 'selected-api',
      selected: {
        id: 'selected-api',
        type: 'api' as const,
        apiKey: 'sk-selected',
        baseURL: 'https://example.test',
        enabled: true,
      },
    },
  ])(
    '$label fallback accountKey fails without refreshing another identity',
    async ({ accountKey, selected }) => {
      const other: FallbackAccount = {
        id: 'other',
        type: 'oauth' as const,
        access: 'access-other',
        refresh: 'refresh-other',
        expires: Date.now() + 3600_000,
        enabled: true,
      }
      const deps = makeDeps({
        accounts: selected ? [selected, other] : [other],
      })

      const results = await refreshAllQuota(deps, { accountKey })

      expect(results).toHaveLength(1)
      expect(results[0]?.account).toBe(accountKey)
      expect(results[0]?.ok).toBe(false)
      expect(deps.getAuth).not.toHaveBeenCalled()
      expect(deps.client.auth.set).not.toHaveBeenCalled()
      expect(deps.fallbackManager.refreshAccount).not.toHaveBeenCalled()
      expect(deps.whamFn).not.toHaveBeenCalled()
      expect(deps.quotaManager.getMain()).toBeNull()
      expect(deps.quotaManager.getFallback('other')).toBeNull()
      expect(deps.writeSidebarState).toHaveBeenCalledTimes(1)
    },
  )

  test('main + 2 fallbacks all succeed → setMain + setFallback called with snapshots', async () => {
    const deps = makeDeps()
    const results = await refreshAllQuota(deps)

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(results[1]).toEqual({ account: 'fb-1', ok: true })
    expect(results[2]).toEqual({ account: 'fb-2', ok: true })

    const mainEntry = deps.quotaManager.getMain()
    expect(mainEntry?.quota?.primary?.usedPercent).toBe(30)

    const fb1 = deps.quotaManager.getFallback('fb-1')
    expect(fb1?.quota?.primary?.usedPercent).toBe(30)
    const fb2 = deps.quotaManager.getFallback('fb-2')
    expect(fb2?.quota?.primary?.usedPercent).toBe(30)

    expect(deps.writeSidebarState).toHaveBeenCalled()
  })

  test('an armed refresh backoff skips the account and reports the real reason', async () => {
    // A non-transient refresh failure (401) arms a long backoff. Retrying
    // cannot succeed until the operator re-adds the account, and the surfaced
    // error must name the token refresh rather than the quota endpoint.
    const whamCalls: string[] = []
    const whamFn = mock(async (input: { accessToken: string }) => {
      whamCalls.push(input.accessToken)
      return makeQuotaSnapshot(10)
    })
    const refreshedIds: string[] = []
    const refreshAccount = mock(async (acct: { id: string }) => {
      refreshedIds.push(acct.id)
      return acct
    })

    // Seed the armed backoff on the account before the deps snapshot it.
    const accounts: FallbackAccount[] = [
      {
        id: 'fb-1',
        type: 'oauth',
        access: 'access-fb1',
        refresh: 'refresh-fb1',
        expires: Date.now() + 3600_000,
        enabled: true,
        accountId: 'chatgpt-fb1',
      },
      {
        id: 'fb-2',
        type: 'oauth',
        access: 'access-fb2',
        refresh: 'refresh-fb2',
        expires: Date.now() + 3600_000,
        enabled: true,
        accountId: 'chatgpt-fb2',
        lastRefreshError: {
          message: 'Token refresh failed: 401',
          checkedAt: Date.now(),
          nextRetryAt: Date.now() + 24 * 3600_000,
          // Bound to this refresh token on purpose: the backoff must not block
          // an account the operator has since re-added with a new token.
          tokenHash: hashRefreshToken('refresh-fb2'),
        },
      },
    ]
    const deps = makeDeps({ whamFn, accounts })
    deps.fallbackManager.refreshAccount =
      refreshAccount as unknown as typeof deps.fallbackManager.refreshAccount

    const results = await refreshAllQuota(deps)

    const fb2 = results.find((r) => r.account === 'fb-2')
    expect(fb2?.ok).toBe(false)
    expect(fb2?.error).toContain('401')
    // Neither refreshed nor probed: both would be wasted work against a token
    // the provider has already rejected.
    expect(refreshedIds).not.toContain('fb-2')
    expect(whamCalls).not.toContain('access-fb2')
    // Non-vacuous: the healthy sibling must still be polled, or an empty run
    // would satisfy the assertions above.
    expect(whamCalls).toContain('access-fb1')
  })

  test('a fallback wham 401 forces a refresh and retries once', async () => {
    // A 401 from the quota endpoint means the server has rejected the token.
    // Local expiry cannot know that, so without this the account keeps using
    // the dead token until it happens to age into the pre-expiry window.
    const whamCalls: string[] = []
    const whamFn = mock(async (input: { accessToken: string }) => {
      whamCalls.push(input.accessToken)
      if (input.accessToken === 'access-fb2') {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      }
      return makeQuotaSnapshot(10)
    })
    // Only a FORCED refresh rotates the token. The ordinary pre-expiry refresh
    // must leave it alone, or the 401 this test depends on never happens.
    const refreshAccount = mock(
      async (
        acct: { id: string },
        _storage: unknown,
        options?: { force?: boolean },
      ) =>
        acct.id === 'fb-2' && options?.force
          ? { ...acct, access: 'access-fb2-rotated' }
          : acct,
    )

    const deps = makeDeps({ whamFn })
    deps.fallbackManager.refreshAccount =
      refreshAccount as unknown as typeof deps.fallbackManager.refreshAccount
    const results = await refreshAllQuota(deps)

    // The rotated token is tried, so a server-side invalidation self-heals on
    // the first poll rather than after hours of local validity.
    expect(whamCalls).toEqual([
      'access-main',
      'access-fb1',
      'access-fb2',
      'access-fb2-rotated',
    ])
    expect(refreshAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fb-2' }),
      expect.anything(),
      { force: true },
    )
    expect(results[2]).toEqual({ account: 'fb-2', ok: true })
    expect(
      deps.quotaManager.getFallback('fb-2')?.quota?.primary?.usedPercent,
    ).toBe(10)
  })

  test('one fallback wham throws 401 → that account ok:false, others succeed', async () => {
    const whamCalls: string[] = []
    const whamFn = mock(async (input: { accessToken: string }) => {
      whamCalls.push(input.accessToken)
      if (input.accessToken === 'access-fb2') {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      }
      return makeQuotaSnapshot(10)
    })

    const deps = makeDeps({ whamFn })
    const results = await refreshAllQuota(deps)

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(results[1]).toEqual({ account: 'fb-1', ok: true })
    expect(results[2]).toEqual({
      account: 'fb-2',
      ok: false,
      error: 'wham usage check failed: 401',
    })

    expect(deps.quotaManager.getMain()?.quota?.primary?.usedPercent).toBe(10)
    expect(
      deps.quotaManager.getFallback('fb-1')?.quota?.primary?.usedPercent,
    ).toBe(10)
    expect(deps.quotaManager.getFallback('fb-2')).toBeNull()

    // Four calls, not three: the 401 forces a refresh and retries once. The
    // stub returns the same token, so the retry fails the same way and the
    // account still reports the 401 — which is the point of this test.
    expect(whamCalls).toEqual([
      'access-main',
      'access-fb1',
      'access-fb2',
      'access-fb2',
    ])
  })

  test('logs each account outcome without exposing credentials', async () => {
    const logger = {
      debug: mock(() => {}),
      warn: mock(() => {}),
    }
    const whamFn = mock(async (input: { accessToken: string }) => {
      if (input.accessToken === 'access-fb2') {
        throw new Error('upstream unavailable')
      }
      return makeQuotaSnapshot(10)
    })
    const deps = makeDeps({ whamFn, logger } as MakeDepsOptions)

    await refreshAllQuota(deps)

    expect(logger.debug).toHaveBeenCalledWith('quota refresh succeeded', {
      pid: process.pid,
      accountId: 'main',
      status: 'ok',
    })
    expect(logger.warn).toHaveBeenCalledWith('quota refresh failed', {
      pid: process.pid,
      accountId: 'fb-2',
      status: 'error',
      error: 'upstream unavailable',
    })
    const serialized = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.warn.mock.calls,
    ])
    expect(serialized).not.toContain('access-main')
    expect(serialized).not.toContain('access-fb2')
  })

  test('expired main token → refreshMainWithLease called, not the direct refresh', async () => {
    const deps = makeDeps({
      getAuth: mock(async () => ({
        type: 'oauth' as const,
        access: 'access-expired',
        refresh: 'refresh-main',
        expires: Date.now() - 1000,
      })),
    })

    const results = await refreshAllQuota(deps)

    // Main refresh routes through the cross-process lease; the direct
    // codexRefreshFn path (and its client.auth.set mirror, which the lease
    // performs internally) must not run here.
    expect(deps.refreshMainWithLease).toHaveBeenCalled()
    expect(deps.codexRefreshFn).not.toHaveBeenCalled()
    expect(deps.client.auth.set).not.toHaveBeenCalled()
    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(deps.quotaManager.getMain()?.quota?.primary?.usedPercent).toBe(30)
  })

  test('a tombstoned main uses the custody resolver without refreshing local auth', async () => {
    const resolveMainAccess = mock(
      async (): Promise<typeof CUSTODY_REFUSE> => CUSTODY_REFUSE,
    )
    const deps = makeDeps({
      getAuth: mock(async () => ({
        type: 'oauth' as const,
        access: '',
        refresh: 'claustrum-tombstone:v1:openai',
        expires: 0,
      })),
      resolveMainAccess,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'main' })

    expect(resolveMainAccess).toHaveBeenCalledWith(
      expect.objectContaining({ mainAccountId: 'chatgpt-main' }),
    )
    expect(deps.refreshMainWithLease).not.toHaveBeenCalled()
    expect(deps.whamFn).not.toHaveBeenCalled()
    expect(results).toEqual([
      { account: 'main', ok: false, error: 'custody refused' },
    ])
  })

  test('expired fallback token → refreshAccount invoked before wham', async () => {
    let refreshCalled = false
    const deps = makeDeps({
      fallbackManager: {
        refreshAccount: mock(async (acct: { id: string }) => {
          refreshCalled = true
          return {
            ...acct,
            access: 'access-fb1-refreshed',
            expires: Date.now() + 7200_000,
          }
        }),
      } as unknown as RefreshAllQuotaDeps['fallbackManager'],
    })

    await refreshAllQuota(deps)

    expect(refreshCalled).toBe(true)
    expect(
      deps.quotaManager.getFallback('fb-1')?.quota?.primary?.usedPercent,
    ).toBe(30)
  })

  test('disabled fallback is skipped', async () => {
    const deps = makeDeps({
      accounts: [
        {
          id: 'fb-1',
          type: 'oauth' as const,
          access: 'access-fb1',
          refresh: 'refresh-fb1',
          expires: Date.now() + 3600_000,
          enabled: false,
        },
        {
          id: 'fb-2',
          type: 'oauth' as const,
          access: 'access-fb2',
          refresh: 'refresh-fb2',
          expires: Date.now() + 3600_000,
          enabled: true,
        },
      ],
    })

    const results = await refreshAllQuota(deps)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(results[1]).toEqual({ account: 'fb-2', ok: true })

    expect(deps.quotaManager.getFallback('fb-1')).toBeNull()
  })

  test('API-key accounts are skipped (only OAuth)', async () => {
    const deps = makeDeps({
      accounts: [
        {
          id: 'api-1',
          type: 'api' as const,
          apiKey: 'sk-123',
          baseURL: 'https://example.test',
          enabled: true,
        },
        {
          id: 'fb-1',
          type: 'oauth' as const,
          access: 'access-fb1',
          refresh: 'refresh-fb1',
          expires: Date.now() + 3600_000,
          enabled: true,
        },
      ],
    })

    const results = await refreshAllQuota(deps)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(results[1]).toEqual({ account: 'fb-1', ok: true })
  })

  test('main auth is not oauth → main ok:false, fallbacks still processed', async () => {
    const deps = makeDeps({
      getAuth: mock(async () => ({
        type: 'api' as const,
      })),
    })

    const results = await refreshAllQuota(deps)

    expect(results[0]).toEqual({
      account: 'main',
      ok: false,
      error: 'auth type is not oauth',
    })
    expect(results[1]).toEqual({ account: 'fb-1', ok: true })
    expect(results[2]).toEqual({ account: 'fb-2', ok: true })
  })

  // -- respectBackoff --

  test('respectBackoff skips wham for main when quota API is backed off', async () => {
    const now = Date.now()
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: {
        version: 1 as const,
        accounts: [],
        quota: {
          mainLastQuotaApiError: {
            message: 'wham: 429 Too Many Requests',
            checkedAt: now,
            nextRetryAt: now + 60_000,
          },
        },
      },
      now: () => now,
    })
    expect(qm.isBackedOff()).toBe(true)

    const deps = makeDeps({
      quotaManager: qm,
      respectBackoff: true,
      accounts: [],
    })
    const results = await refreshAllQuota(deps)

    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(deps.whamFn).not.toHaveBeenCalled()
  })

  test('respectBackoff: false (default) still fetches main even when backed off', async () => {
    const now = Date.now()
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: {
        version: 1 as const,
        accounts: [],
        quota: {
          mainLastQuotaApiError: {
            message: 'wham: 429 Too Many Requests',
            checkedAt: now,
            nextRetryAt: now + 60_000,
          },
        },
      },
      now: () => now,
    })
    expect(qm.isBackedOff()).toBe(true)

    const deps = makeDeps({ quotaManager: qm })
    const results = await refreshAllQuota(deps)

    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(deps.whamFn).toHaveBeenCalled()
  })

  test('respectBackoff skips wham for fallback when quota API is backed off', async () => {
    const now = Date.now()

    // Set up a QuotaManager where a fallback is in backoff by triggering
    // a failing refreshFallback call that arms the error state.
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: {
        version: 1 as const,
        accounts: [
          {
            id: 'fb-1',
            type: 'oauth' as const,
            access: 'access-fb1',
            refresh: 'refresh-fb1',
            expires: now + 3600_000,
            enabled: true,
          },
        ],
      },
      fetchQuotaFn: async () => {
        throw Object.assign(new Error('wham usage check failed: 429'), {
          status: 429,
        })
      },
      now: () => now,
    })

    try {
      await qm.refreshFallback('fb-1', 'access-fb1')
    } catch {
      // expected — arms backoff
    }
    expect(qm.isFallbackBackedOff('fb-1', 'access-fb1')).toBe(true)

    const deps = makeDeps({
      quotaManager: qm,
      respectBackoff: true,
      accounts: [
        {
          id: 'fb-1',
          type: 'oauth' as const,
          access: 'access-fb1',
          refresh: 'refresh-fb1',
          expires: now + 3600_000,
          enabled: true,
        },
      ],
    })
    const results = await refreshAllQuota(deps)

    expect(results).toHaveLength(2) // main + fb-1
    expect(results[1]).toEqual({ account: 'fb-1', ok: true })
    expect(deps.whamFn).toHaveBeenCalledTimes(1) // only main, not fb-1
  })

  test('skipFresherThanMs skips quota fetched within the freshness window', async () => {
    const now = Date.now()
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      readSidebarState: mock(async () =>
        normalizeSidebarState(sidebarSnapshot(now - 10 * 60_000)),
      ),
    })
    const freshEntry = {
      quota: makeQuotaSnapshot(20),
      refreshAfter: now + 4 * 60_000,
      checkedAt: now - 60_000,
    }
    deps.quotaManager.setMain('access-main', freshEntry, 'chatgpt-main')
    deps.quotaManager.setFallback('fb-1', freshEntry, 'access-fb1')

    await refreshAllQuota(deps)

    expect(deps.whamFn).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-fb2' }),
    )
  })

  test('skipFresherThanMs fetches stale and missing quota snapshots', async () => {
    const now = Date.now()
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
    })
    deps.quotaManager.setMain(
      'access-main',
      {
        quota: makeQuotaSnapshot(20),
        refreshAfter: now - 5 * 60_000,
        checkedAt: now - 10 * 60_000,
      },
      'chatgpt-main',
    )

    await refreshAllQuota(deps)

    expect(deps.whamFn).toHaveBeenCalledTimes(3)
  })

  test('fresh machine-global sidebar quota skips polling with an empty in-memory cache', async () => {
    const now = Date.now()
    await withSidebarFile(
      JSON.stringify(sidebarSnapshot(now - 60_000)),
      async (path) => {
        const deps = makeDeps({
          now: () => now,
          skipFresherThanMs: 4 * 60_000,
          readSidebarState: () => getSidebarState(path),
        })

        await refreshAllQuota(deps)

        expect(deps.whamFn).not.toHaveBeenCalled()
        expect(deps.writeSidebarState).not.toHaveBeenCalled()
      },
    )
  })

  test('stale machine-global sidebar quota is polled with an empty in-memory cache', async () => {
    const now = Date.now()
    await withSidebarFile(
      JSON.stringify(sidebarSnapshot(now - 10 * 60_000)),
      async (path) => {
        const deps = makeDeps({
          now: () => now,
          skipFresherThanMs: 4 * 60_000,
          readSidebarState: () => getSidebarState(path),
        })

        await refreshAllQuota(deps)

        expect(deps.whamFn).toHaveBeenCalledTimes(3)
      },
    )
  })

  test('missing, corrupt, and malformed shared quota fail open to polling', async () => {
    const now = Date.now()
    const cases = [
      undefined,
      '{not-json',
      JSON.stringify(sidebarSnapshot('recent-but-not-numeric')),
    ]

    for (const contents of cases) {
      await withSidebarFile(contents, async (path) => {
        const deps = makeDeps({
          now: () => now,
          skipFresherThanMs: 4 * 60_000,
          readSidebarState: () => getSidebarState(path),
        })

        await refreshAllQuota(deps)

        expect(deps.whamFn).toHaveBeenCalledTimes(3)
      })
    }

    const nonFiniteDeps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      readSidebarState: mock(async () =>
        normalizeSidebarState(sidebarSnapshot(Number.NaN)),
      ),
    })
    await refreshAllQuota(nonFiniteDeps)
    expect(nonFiniteDeps.whamFn).toHaveBeenCalledTimes(3)
  })

  test('manual refresh ignores fresh machine-global sidebar quota', async () => {
    const now = Date.now()
    await withSidebarFile(
      JSON.stringify(sidebarSnapshot(now - 60_000)),
      async (path) => {
        const readSidebarState = mock(() => getSidebarState(path))
        const deps = makeDeps({
          now: () => now,
          readSidebarState,
        })

        await refreshAllQuota(deps)

        expect(readSidebarState).not.toHaveBeenCalled()
        expect(deps.whamFn).toHaveBeenCalledTimes(3)
      },
    )
  })

  // -- identity-bound freshness (account switch / re-login) --

  test('main re-login (mainAccountId change) fetches despite a fresh sidebar checkedAt', async () => {
    const now = Date.now()
    // The loader captured the OLD account id and the sidebar still carries that
    // account's fresh quota under the same id — so the captured id alone would
    // match the file and suppress the poll. Only a fresh storage load reveals the
    // re-login (mainAccountId now differs); the gate must use that live id.
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      accounts: [],
      storageMainAccountId: 'chatgpt-main-old',
      loadAccounts: mock(async () => ({
        version: 1 as const,
        accounts: [],
        mainAccountId: 'chatgpt-main-new',
      })),
      readSidebarState: mock(async () =>
        normalizeSidebarState({
          main: {
            mainAccountId: 'chatgpt-main-old',
            quota: {
              primary: {
                usedPercent: 5,
                remainingPercent: 95,
                checkedAt: now - 60_000,
              },
            },
          },
          fallbacks: [],
        }),
      ),
    })

    await refreshAllQuota(deps)

    expect(deps.whamFn).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'chatgpt-main-new' }),
    )
  })

  test('re-login polls even when the in-memory cache is fresh under the stale identity', async () => {
    const now = Date.now()
    // Both the in-memory cache and the sidebar hold the OLD account's fresh
    // quota, and the loader-captured id still matches them. Without the live
    // storage load, both freshness signals agree and the poll is wrongly
    // suppressed for the account that just logged in.
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      accounts: [],
      storageMainAccountId: 'chatgpt-main-old',
      loadAccounts: mock(async () => ({
        version: 1 as const,
        accounts: [],
        mainAccountId: 'chatgpt-main-new',
      })),
      readSidebarState: mock(async () =>
        normalizeSidebarState({
          main: {
            mainAccountId: 'chatgpt-main-old',
            quota: {
              primary: {
                usedPercent: 5,
                remainingPercent: 95,
                checkedAt: now - 60_000,
              },
            },
          },
          fallbacks: [],
        }),
      ),
    })
    deps.quotaManager.setMain(
      'access-main',
      {
        quota: makeQuotaSnapshot(5),
        refreshAfter: now + 4 * 60_000,
        checkedAt: now - 60_000,
      },
      'chatgpt-main-old',
    )

    await refreshAllQuota(deps)

    expect(deps.whamFn).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'chatgpt-main-new' }),
    )
  })

  test('fallback re-login (accountId change) fetches despite a fresh sidebar checkedAt', async () => {
    const now = Date.now()
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      accounts: [
        {
          id: 'fb-1',
          type: 'oauth' as const,
          access: 'access-fb1',
          refresh: 'refresh-fb1',
          expires: now + 3600_000,
          enabled: true,
          accountId: 'chatgpt-fb1-new',
        },
      ],
      readSidebarState: mock(async () =>
        normalizeSidebarState({
          main: {
            mainAccountId: 'chatgpt-main',
            quota: {
              primary: {
                usedPercent: 5,
                remainingPercent: 95,
                checkedAt: now - 60_000,
              },
            },
          },
          fallbacks: [
            {
              id: 'fb-1',
              accountId: 'chatgpt-fb1-old',
              quota: {
                primary: {
                  usedPercent: 5,
                  remainingPercent: 95,
                  checkedAt: now - 60_000,
                },
              },
            },
          ],
        }),
      ),
    })

    await refreshAllQuota(deps)

    // main matches identity + fresh → skipped; fb-1 identity changed → fetched.
    expect(deps.whamFn).toHaveBeenCalledTimes(1)
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-fb1' }),
    )
  })

  // -- secondary-window freshness --

  test('fresh secondary window alone skips polling when the primary window is absent (main)', async () => {
    const now = Date.now()
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      accounts: [],
      readSidebarState: mock(async () =>
        normalizeSidebarState({
          main: {
            mainAccountId: 'chatgpt-main',
            quota: {
              secondary: {
                usedPercent: 40,
                remainingPercent: 60,
                checkedAt: now - 60_000,
              },
            },
          },
          fallbacks: [],
        }),
      ),
    })

    await refreshAllQuota(deps)

    expect(deps.whamFn).not.toHaveBeenCalled()
  })

  test('fresh secondary window alone skips polling when the primary window is absent (fallback)', async () => {
    const now = Date.now()
    const deps = makeDeps({
      now: () => now,
      skipFresherThanMs: 4 * 60_000,
      accounts: [
        {
          id: 'fb-1',
          type: 'oauth' as const,
          access: 'access-fb1',
          refresh: 'refresh-fb1',
          expires: now + 3600_000,
          enabled: true,
          accountId: 'chatgpt-fb1',
        },
      ],
      readSidebarState: mock(async () =>
        normalizeSidebarState({
          main: {
            mainAccountId: 'chatgpt-main',
            quota: {
              primary: {
                usedPercent: 5,
                remainingPercent: 95,
                checkedAt: now - 60_000,
              },
            },
          },
          fallbacks: [
            {
              id: 'fb-1',
              accountId: 'chatgpt-fb1',
              quota: {
                secondary: {
                  usedPercent: 40,
                  remainingPercent: 60,
                  checkedAt: now - 60_000,
                },
              },
            },
          ],
        }),
      ),
    })

    await refreshAllQuota(deps)

    expect(deps.whamFn).not.toHaveBeenCalled()
  })
})
