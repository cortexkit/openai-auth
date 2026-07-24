import { createLogger } from '../logger'
import { getSidebarState, type SidebarState } from '../sidebar-state'
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
  refreshMainWithLease: () => Promise<{
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
  skipFresherThanMs?: number
  readSidebarState?: () => Promise<SidebarState>
}

export interface RefreshAllQuotaOptions {
  accountKey?: string
}

export interface RefreshAllQuotaResult {
  account: string
  ok: boolean
  error?: string
}

export async function refreshAllQuota(
  deps: RefreshAllQuotaDeps,
  options: RefreshAllQuotaOptions = {},
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

  const freshnessMs = deps.skipFresherThanMs
  let quotaUpdated = false
  let sharedSidebarState: SidebarState | undefined
  if (freshnessMs !== undefined) {
    try {
      sharedSidebarState = await (deps.readSidebarState ?? getSidebarState)()
    } catch {}
  }
  const sharedFallbacks = new Map(
    sharedSidebarState?.fallbacks.map((account) => [account.id, account]) ?? [],
  )
  const isFresh = (...checkedAts: unknown[]) =>
    freshnessMs !== undefined &&
    checkedAts.some(
      (checkedAt) =>
        typeof checkedAt === 'number' &&
        Number.isFinite(checkedAt) &&
        checkedAt <= deps.now() &&
        deps.now() - checkedAt < freshnessMs,
    )

  // Load the live storage once, up front, so the freshness gate judges identity
  // by the account logged in NOW rather than the id captured when the loader
  // initialized. A re-login within the same process changes mainAccountId on
  // disk; comparing against the stale captured id would let the previous
  // account's fresh quota suppress polling for the new one. A load failure fails
  // open to the captured id so the main refresh still runs.
  const storage = await deps
    .loadAccounts(deps.configPath)
    .catch(() => undefined)
  const liveMainAccountId = storage?.mainAccountId ?? deps.storageMainAccountId

  if (!options.accountKey || options.accountKey === 'main') {
    // --- MAIN ---
    try {
      let auth = await deps.getAuth()
      if (auth.type === 'oauth') {
        const sharedMainQuota =
          sharedSidebarState &&
          liveMainAccountId !== undefined &&
          sharedSidebarState.main.mainAccountId === liveMainAccountId
            ? sharedSidebarState.main.quota
            : undefined
        const freshMainQuota = isFresh(
          deps.quotaManager.peekMainForPolicy(liveMainAccountId)?.checkedAt,
          sharedMainQuota?.primary?.checkedAt,
          sharedMainQuota?.secondary?.checkedAt,
          sharedMainQuota?.checkedAt,
        )
        if (freshMainQuota) {
          recordOutcome({ account: 'main', ok: true })
        } else {
          if (!auth.access || (auth.expires ?? 0) < deps.now()) {
            const tokens = await deps.refreshMainWithLease()
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
                accountId: liveMainAccountId,
                accountKey: 'main',
              })
              deps.quotaManager.setMain(
                auth.access,
                {
                  quota: snap,
                  refreshAfter: deps.now() + 5 * 60 * 1000,
                  checkedAt: deps.now(),
                },
                liveMainAccountId,
                true,
              )
              quotaUpdated = true
              recordOutcome({ account: 'main', ok: true })
            }
          } else {
            recordOutcome({
              account: 'main',
              ok: false,
              error: 'no access token',
            })
          }
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
  }

  // --- FALLBACKS ---
  if (storage) {
    for (const acct of storage.accounts) {
      if (
        options.accountKey &&
        (options.accountKey === 'main' || acct.id !== options.accountKey)
      ) {
        continue
      }
      if (acct.enabled === false || !deps.isOAuthAccountFn(acct)) {
        if (options.accountKey) {
          recordOutcome({
            account: acct.id,
            ok: false,
            error: 'account is not an enabled OAuth fallback',
          })
        }
        continue
      }

      try {
        const sharedFb = sharedFallbacks.get(acct.id)
        const currentAccountId = (acct as OAuthAccount).accountId
        const sharedFbQuota =
          sharedFb &&
          currentAccountId !== undefined &&
          sharedFb.accountId === currentAccountId
            ? sharedFb.quota
            : undefined
        if (
          isFresh(
            deps.quotaManager.peekFallbackForPolicy(acct.id, currentAccountId)
              ?.checkedAt,
            sharedFbQuota?.primary?.checkedAt,
            sharedFbQuota?.secondary?.checkedAt,
            sharedFbQuota?.checkedAt,
          )
        ) {
          recordOutcome({ account: acct.id, ok: true })
          continue
        }

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
          refreshed.accountId,
        )
        quotaUpdated = true
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

  if (
    options.accountKey &&
    options.accountKey !== 'main' &&
    !results.some((result) => result.account === options.accountKey)
  ) {
    results.push({
      account: options.accountKey,
      ok: false,
      error: 'account not found',
    })
  }

  if (freshnessMs === undefined || quotaUpdated) {
    const freshStorage = await deps.loadAccounts(deps.configPath)
    await deps.writeSidebarState(deps.quotaManager, freshStorage)
  }

  return results
}
