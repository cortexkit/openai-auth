import { describe, expect, mock, test } from 'bun:test'
import type {
  AccountQuotaWindow,
  FallbackAccount,
  OAuthQuotaSnapshot,
} from '../core/accounts'
import { QuotaManager } from '../core/quota-manager'
import {
  type RefreshAllQuotaDeps,
  refreshAllQuota,
} from '../core/refresh-all-quota'

function makeQuotaSnapshot(usedPercent: number): OAuthQuotaSnapshot {
  const window: AccountQuotaWindow = {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    checkedAt: Date.now(),
  }
  return { primary: window }
}

interface MakeDepsOptions extends Partial<RefreshAllQuotaDeps> {
  accounts?: FallbackAccount[]
}

function makeDeps(opts: MakeDepsOptions = {}): RefreshAllQuotaDeps {
  const qm = new QuotaManager({
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
    configPath: '/tmp/test-config.json',
    storageMainAccountId: 'chatgpt-main',
    isOAuthAccountFn: ((a: unknown) =>
      (a as { type?: string })?.type ===
      'oauth') as RefreshAllQuotaDeps['isOAuthAccountFn'],
    whamFn: mock(async () => makeQuotaSnapshot(30)),
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

    expect(whamCalls).toEqual(['access-main', 'access-fb1', 'access-fb2'])
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

  test('expired main token → codexRefreshFn called before wham', async () => {
    const deps = makeDeps({
      getAuth: mock(async () => ({
        type: 'oauth' as const,
        access: 'access-expired',
        refresh: 'refresh-main',
        expires: Date.now() - 1000,
      })),
    })

    const results = await refreshAllQuota(deps)

    expect(deps.codexRefreshFn).toHaveBeenCalled()
    expect(deps.client.auth.set).toHaveBeenCalled()
    expect(results[0]).toEqual({ account: 'main', ok: true })
    expect(deps.quotaManager.getMain()?.quota?.primary?.usedPercent).toBe(30)
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
})
