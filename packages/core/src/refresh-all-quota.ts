import type {
  AccountPaths,
  FallbackAccountManager,
  isOAuthAccount,
  loadAccounts,
  OAuthAccount,
} from './accounts'
import { formatRefreshBackoffMessage, refreshBackoffActive } from './backoff.ts'
import { createLogger } from './logger'
import type { whamUsageFn } from './provider'
import type { QuotaManager } from './quota-manager'
import { errorMessage } from './util/error'

const log = createLogger('quota')

/**
 * True when a thrown provider error carries HTTP 401.
 *
 * Reads `.status` rather than matching the message, so it cannot be fooled by
 * an unrelated error whose text happens to contain the number.
 */
function isUnauthorized(error: unknown) {
  return (error as { status?: unknown } | null)?.status === 401
}
type QuotaLogger = Pick<typeof log, 'debug' | 'warn'>

/** One account's cached quota reading as the shared sidebar snapshot records it. */
export interface SidebarQuotaReading {
  checkedAt?: number
  primary?: { checkedAt?: number }
  secondary?: { checkedAt?: number }
}

/**
 * The part of a host's cross-process quota snapshot this poll reads.
 *
 * Declared structurally rather than imported, because the file that snapshot
 * lives in is a host concern: each host decides where it writes and what else
 * it keeps in there. All this poll needs is which reading belongs to which
 * account and when it was taken.
 */
export interface SidebarQuotaSnapshot {
  main: { mainAccountId?: string; quota?: SidebarQuotaReading | null }
  fallbacks: ReadonlyArray<{
    id: string
    accountId?: string
    quota?: SidebarQuotaReading | null
  }>
}

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
  paths: AccountPaths
  storageMainAccountId: string | undefined
  isOAuthAccountFn: typeof isOAuthAccount
  whamFn?: typeof whamUsageFn
  respectBackoff?: boolean
  logger?: QuotaLogger
  skipFresherThanMs?: number
  /**
   * Reads the host's shared quota snapshot. Required: the freshness gate below
   * exists to stop several processes polling the provider for the same account,
   * and a host that forgot to wire this in would silently lose that.
   */
  readSidebarState: () => Promise<SidebarQuotaSnapshot>
}

export interface RefreshAllQuotaOptions {
  accountKey?: string
}

export interface RefreshAllQuotaOptions {
  accountKey?: string
}

export interface RefreshAllQuotaResult {
  account: string
  ok: boolean
  error?: string
  /**
   * The account cannot recover on its own: the provider has rejected its
   * credentials, so no amount of retrying will help until the operator re-adds
   * it.
   *
   * Carried as a flag rather than left for the caller to infer from `error`,
   * because sniffing an error string for a user-facing decision breaks the
   * moment the wording changes.
   */
  permanent?: boolean
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
  let sharedSidebarState: SidebarQuotaSnapshot | undefined
  if (freshnessMs !== undefined) {
    try {
      sharedSidebarState = await deps.readSidebarState()
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
  const storage = await deps.loadAccounts(deps.paths).catch(() => undefined)
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

        // A recent NON-TRANSIENT refresh failure (a 401 means the provider has
        // invalidated this token) arms a long backoff. The request path already
        // honours it; this poll did not, so an account the plugin had already
        // diagnosed as dead kept being retried — hundreds of times in the
        // report behind this. Retrying cannot succeed until the operator
        // re-adds the account, so skip it and surface the RECORDED reason.
        // That also fixes the misdirection: the symptom used to be
        // `wham usage check failed: 401`, which blames the quota endpoint for a
        // token-refresh failure.
        const armedRefreshError = (acct as OAuthAccount).lastRefreshError
        if (
          refreshBackoffActive(
            armedRefreshError,
            (acct as OAuthAccount).refresh,
            deps.now(),
          )
        ) {
          recordOutcome({
            account: acct.id,
            ok: false,
            error: formatRefreshBackoffMessage(
              armedRefreshError as NonNullable<typeof armedRefreshError>,
              deps.now(),
            ),
            permanent: true,
          })
          continue
        }

        let refreshed: OAuthAccount
        try {
          refreshed = await deps.fallbackManager.refreshAccount(acct, storage)
        } catch (refreshError) {
          // Continue with the existing token — a transient refresh blip should
          // not stop a quota poll that the current token may still satisfy —
          // but never silently. Swallowing this made a server-invalidated
          // account look like a quota-endpoint problem for days: the only
          // symptom was `wham usage check failed: 401`, which names the wrong
          // component, and nothing recorded that the refresh itself had failed.
          log.warn('fallback token refresh failed during quota poll', {
            pid: process.pid,
            accountId: acct.id,
            error: errorMessage(refreshError),
          })
          refreshed = acct
        }

        // Expiry, not presence. An expired token is still a non-empty string,
        // so a presence check sends a token that cannot work and surfaces the
        // rejection as a quota-endpoint failure. The main-account path above
        // already tests expiry.
        if (!refreshed.access || (refreshed.expires ?? 0) < deps.now()) {
          recordOutcome({
            account: acct.id,
            ok: false,
            error: 'no usable access token',
          })
          continue
        }

        let snap: Awaited<ReturnType<typeof whamFn>>
        try {
          snap = await whamFn({
            accessToken: refreshed.access,
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            accountId: refreshed.accountId,
            accountKey: acct.id,
          })
        } catch (quotaError) {
          // A 401 here says the server has rejected this token, which local
          // expiry cannot know: the refresh gate above consults expiry only, so
          // a token the provider invalidated early stays in use until it
          // happens to age into the pre-expiry window. That gap was measured in
          // days. Treat the rejection as the refresh trigger it is, once.
          if (!isUnauthorized(quotaError)) throw quotaError
          log.warn('quota endpoint rejected the token; forcing a refresh', {
            pid: process.pid,
            accountId: acct.id,
          })
          refreshed = await deps.fallbackManager.refreshAccount(acct, storage, {
            force: true,
          })
          if (!refreshed.access) {
            recordOutcome({
              account: acct.id,
              ok: false,
              error: 'no usable access token after forced refresh',
            })
            continue
          }
          snap = await whamFn({
            accessToken: refreshed.access,
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            accountId: refreshed.accountId,
            accountKey: acct.id,
          })
        }
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
    const freshStorage = await deps.loadAccounts(deps.paths)
    await deps.writeSidebarState(deps.quotaManager, freshStorage)
  }

  return results
}
