import { createLogger } from '../logger'
import { errorMessage } from '../util/error'
import type {
  FallbackAccountManager,
  isOAuthAccount,
  loadAccounts,
  OAuthAccount,
} from './accounts'
import type { whamUsageFn } from './provider'
import type { QuotaManager } from './quota-manager'

const log = createLogger('quota')
type QuotaLogger = Pick<typeof log, 'debug' | 'warn'>

export interface RefreshAllQuotaDeps {
  getAuth: () => Promise<{
    type: string
    access?: string
    refresh?: string
    expires?: number
  }>
  codexRefreshFn: (input: {
    refreshToken: string
    fetchImpl: typeof fetch
    now: () => number
  }) => Promise<{
    access: string
    refresh: string
    expires: number
  }>
  fallbackManager: FallbackAccountManager
  quotaManager: QuotaManager
  loadAccounts: typeof loadAccounts
  writeSidebarState: (
    qm: QuotaManager,
    store: Awaited<ReturnType<typeof loadAccounts>>,
  ) => Promise<void>
  client: {
    auth: {
      set: (input: {
        path: { id: string }
        body: {
          type: string
          access?: string
          refresh: string
          expires?: number
        }
      }) => Promise<unknown>
    }
  }
  fetchImpl: typeof fetch
  now: () => number
  configPath: string
  storageMainAccountId: string | undefined
  isOAuthAccountFn: typeof isOAuthAccount
  whamFn?: typeof whamUsageFn
  respectBackoff?: boolean
  logger?: QuotaLogger
}

export interface RefreshAllQuotaResult {
  account: string
  ok: boolean
  error?: string
}

export async function refreshAllQuota(
  deps: RefreshAllQuotaDeps,
): Promise<RefreshAllQuotaResult[]> {
  const whamFn = deps.whamFn
  if (!whamFn) throw new Error('whamFn is required for refreshAllQuota')

  const results: RefreshAllQuotaResult[] = []
  const logger = deps.logger ?? log
  const recordOutcome = (result: RefreshAllQuotaResult) => {
    results.push(result)
    const payload = {
      pid: process.pid,
      accountId: result.account,
      status: result.ok ? 'ok' : 'error',
      ...(result.error ? { error: result.error } : {}),
    }
    if (result.ok) logger.debug('quota refresh succeeded', payload)
    else logger.warn('quota refresh failed', payload)
  }

  // --- MAIN ---
  try {
    let auth = await deps.getAuth()
    if (auth.type === 'oauth') {
      if (!auth.access || (auth.expires ?? 0) < deps.now()) {
        const tokens = await deps.codexRefreshFn({
          refreshToken: auth.refresh ?? '',
          fetchImpl: deps.fetchImpl,
          now: deps.now,
        })
        await deps.client.auth.set({
          path: { id: 'openai' },
          body: {
            type: 'oauth',
            access: tokens.access,
            refresh: tokens.refresh,
            expires: tokens.expires,
          },
        })
        auth = { ...auth, access: tokens.access, expires: tokens.expires }
      }

      if (auth.access) {
        if (deps.respectBackoff && deps.quotaManager.isBackedOff()) {
          recordOutcome({ account: 'main', ok: true })
        } else {
          const snap = await whamFn({
            accessToken: auth.access,
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            accountId: deps.storageMainAccountId,
            accountKey: 'main',
          })
          deps.quotaManager.setMain(
            auth.access,
            {
              quota: snap,
              refreshAfter: deps.now() + 5 * 60 * 1000,
              checkedAt: deps.now(),
            },
            undefined,
            true,
          )
          recordOutcome({ account: 'main', ok: true })
        }
      } else {
        recordOutcome({
          account: 'main',
          ok: false,
          error: 'no access token',
        })
      }
    } else {
      recordOutcome({
        account: 'main',
        ok: false,
        error: 'auth type is not oauth',
      })
    }
  } catch (e) {
    recordOutcome({
      account: 'main',
      ok: false,
      error: errorMessage(e),
    })
  }

  // --- FALLBACKS ---
  const storage = await deps.loadAccounts(deps.configPath)
  if (storage) {
    for (const acct of storage.accounts) {
      if (acct.enabled === false || !deps.isOAuthAccountFn(acct)) continue

      try {
        if (
          deps.respectBackoff &&
          deps.quotaManager.isFallbackBackedOff(
            acct.id,
            (acct as OAuthAccount).access,
          )
        ) {
          recordOutcome({ account: acct.id, ok: true })
          continue
        }

        let refreshed: OAuthAccount
        try {
          refreshed = await deps.fallbackManager.refreshAccount(acct, storage)
        } catch {
          refreshed = acct
        }

        if (!refreshed.access) {
          recordOutcome({
            account: acct.id,
            ok: false,
            error: 'no access token',
          })
          continue
        }

        const snap = await whamFn({
          accessToken: refreshed.access,
          fetchImpl: deps.fetchImpl,
          now: deps.now,
          accountId: refreshed.accountId,
          accountKey: acct.id,
        })
        deps.quotaManager.setFallback(
          acct.id,
          {
            quota: snap,
            refreshAfter: deps.now() + 5 * 60 * 1000,
            checkedAt: deps.now(),
          },
          refreshed.access,
          true,
        )
        recordOutcome({ account: acct.id, ok: true })
      } catch (e) {
        recordOutcome({
          account: acct.id,
          ok: false,
          error: errorMessage(e),
        })
      }
    }
  }

  // Refresh sidebar after all fetches
  const freshStorage = await deps.loadAccounts(deps.configPath)
  await deps.writeSidebarState(deps.quotaManager, freshStorage)

  return results
}
