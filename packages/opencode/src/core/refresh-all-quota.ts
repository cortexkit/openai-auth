import { createLogger } from '../logger'
import { getSidebarState, type SidebarState } from '../sidebar-state'
import { errorMessage } from '../util/error'
import type {
  AccountStorage,
  FallbackAccountManager,
  isOAuthAccount,
  loadAccounts,
  OAuthAccount,
} from './accounts'
import { formatRefreshBackoffMessage, refreshBackoffActive } from './backoff.ts'
import {
  CUSTODY_EXCLUDED,
  CUSTODY_REFUSE,
  type FallbackAccessResolution,
} from './custody.ts'
import type { whamUsageFn } from './provider'
import type { QuotaManager } from './quota-manager'

const log = createLogger('quota')

export const CUSTODY_DEPS_INCOMPLETE = 'custody-deps-incomplete'

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
  /**
   * Custody deps. Absent → pre-custody behaviour (the existing local-refresh
   * block runs as before, no tombstone handling). When present, every
   * refresh-inert account is short-circuited into the resolver arm and the
   * local-refresh block is skipped entirely.
   */
  isFallbackRefreshInert?: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<boolean> | boolean
  resolveFallbackAccess?: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<
    FallbackAccessResolution | typeof CUSTODY_REFUSE | typeof CUSTODY_EXCLUDED
  >
  reportCustodyAuthFailure?: (params: {
    handle: string
    providerStatus: number
    recordVersion: number
  }) => Promise<void>
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
  // Partial-custody-deps log dedupe: at most one warn per poll per missing
  // dep, regardless of how many refresh-inert accounts we observe. A full
  // polling cycle could otherwise log per-account.
  const custodyPartialDepsLogged = new Set<'resolver' | 'reporter'>()
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

        // Refresh-inert arm: a manifest entry OR a tombstone sentinel makes
        // local refresh inert regardless of `claustrum.enabled` (spec §3).
        // The local-refresh block below is therefore unreachable for a
        // refresh-inert account — the resolver decides what goes on the wire.
        // Only `isFallbackRefreshInert` is required to enter; a partial
        // wiring (resolver or reporter missing) fails closed instead of
        // falling through into local refresh, because resuming a local
        // refresher against a vault-held family is the split-custody
        // incident the refresh gate exists to prevent.
        if (
          deps.isFallbackRefreshInert &&
          (await deps.isFallbackRefreshInert(acct as OAuthAccount, storage))
        ) {
          if (!deps.resolveFallbackAccess) {
            if (!custodyPartialDepsLogged.has('resolver')) {
              logger.warn('custody deps incomplete: resolver absent', {
                pid: process.pid,
                accountId: acct.id,
              })
              custodyPartialDepsLogged.add('resolver')
            }
            recordOutcome({
              account: acct.id,
              ok: false,
              error: CUSTODY_DEPS_INCOMPLETE,
            })
            continue
          }
          let access: Awaited<
            ReturnType<NonNullable<typeof deps.resolveFallbackAccess>>
          >
          try {
            access = await deps.resolveFallbackAccess(
              acct as OAuthAccount,
              storage,
            )
          } catch (resolveError) {
            recordOutcome({
              account: acct.id,
              ok: false,
              error: errorMessage(resolveError),
            })
            continue
          }
          if (access === CUSTODY_REFUSE || access === CUSTODY_EXCLUDED) {
            recordOutcome({
              account: acct.id,
              ok: false,
              error: 'custody: no vault credential',
            })
            continue
          }
          // Vault-provenance probe requires a reporter — a quota 401 on a
          // vault-served credential MUST reach the vault (spec §6.4), so
          // probing without one would be the silent-401 failure of issue
          // #118 recreated under custody. Refuse the probe up front.
          // Local-provenance probes need no reporter: a local 401 is not
          // credential evidence (the vault is not on the wire).
          if (access.provenance !== 'local' && !deps.reportCustodyAuthFailure) {
            if (!custodyPartialDepsLogged.has('reporter')) {
              logger.warn(
                'custody deps incomplete: reporter absent; vault probe refused',
                { pid: process.pid, accountId: acct.id },
              )
              custodyPartialDepsLogged.add('reporter')
            }
            recordOutcome({
              account: acct.id,
              ok: false,
              error: CUSTODY_DEPS_INCOMPLETE,
            })
            continue
          }
          try {
            const snap = await whamFn({
              accessToken: access.token,
              fetchImpl: deps.fetchImpl,
              now: deps.now,
              accountId: (acct as OAuthAccount).accountId,
              accountKey: acct.id,
            })
            deps.quotaManager.setFallback(
              acct.id,
              {
                quota: snap,
                refreshAfter: deps.now() + 5 * 60_000,
                checkedAt: deps.now(),
              },
              access.token,
              true,
              (acct as OAuthAccount).accountId,
            )
            quotaUpdated = true
            recordOutcome({ account: acct.id, ok: true })
          } catch (quotaError) {
            if (!isUnauthorized(quotaError)) throw quotaError
            // Quota-endpoint 401. The vault-served provenance is the only
            // signal that this token came from the vault — a local-provenance
            // 401 (an enrolled, non-tombstoned account) is not reported and,
            // because the local-refresh block is skipped, does not trigger a
            // forced refresh either. A 429 is never a report.
            if (access.provenance !== 'local') {
              try {
                await (
                  deps.reportCustodyAuthFailure as NonNullable<
                    typeof deps.reportCustodyAuthFailure
                  >
                )({
                  handle: access.provenance.handle,
                  providerStatus: 401,
                  recordVersion: access.provenance.recordVersion,
                })
              } catch (reportError) {
                logger.warn('custody auth-failure report failed', {
                  accountId: acct.id,
                  error: errorMessage(reportError),
                })
              }
            }
            recordOutcome({
              account: acct.id,
              ok: false,
              error: errorMessage(quotaError),
            })
          }
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
    const freshStorage = await deps.loadAccounts(deps.configPath)
    await deps.writeSidebarState(deps.quotaManager, freshStorage)
  }

  return results
}
