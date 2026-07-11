/**
 * Unified quota cache and API gateway.
 *
 * Single source of truth for main + fallback quota state. All consumers
 * share one QuotaManager instance so they see the same in-memory cache.
 * Handles deduplication, rate-limiting (429 backoff), and staleness.
 *
 * Adapted from anthropic-auth — provider-specific quota fetch injected via
 * fetchQuotaFn instead of hard-importing fetchOAuthQuotaSnapshot.
 */

import { createHash } from 'node:crypto'

import type {
  AccountOperationError,
  AccountQuotaWindow,
  AccountStorage,
  OAuthAccount,
  OAuthQuotaSnapshot,
} from './accounts.ts'
import { buildQuotaOperationError, quotaBackoffActive } from './backoff.ts'
import { PRIMARY, type ProviderQuotaFn, SECONDARY } from './provider.ts'
import { acquireRefreshFileLock } from './refresh-file-lock'

export type { ProviderQuotaFn }

// Capture real setTimeout before tests can mock globalThis.setTimeout
const nativeSetTimeout = globalThis.setTimeout

// ---------------------------------------------------------------------------
// Helpers (local — not in accounts.ts yet; to be extracted later)
// ---------------------------------------------------------------------------

const DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES = 5

function getQuotaCheckIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.quota?.checkIntervalMinutes ?? DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

function quotaEnabled(storage: AccountStorage | null) {
  return storage?.quota?.enabled !== false
}

export function quotaWindowResetIsPast(
  window: AccountQuotaWindow | undefined,
  now: number,
): boolean {
  if (!window?.resetsAt) return false
  const resetTime = Date.parse(window.resetsAt)
  return Number.isFinite(resetTime) && resetTime <= now
}

/**
 * Resolve when a mid-stream-exhausted account's window actually resets, from
 * its own last-known cached quota snapshot (a response.failed frame carries no
 * reset time itself). The frame always names the exhausted window (primary or
 * secondary), so use only THAT window's cached reset; if it's unknown, fall
 * back to a conservative bounded default rather than borrowing the OTHER
 * window's reset — an unrelated window can reset far in the future and would
 * blackhole the account long past its actual rate-limit. The default is
 * self-correcting: if the account is still exhausted, the next response.failed
 * frame re-marks it. Pure — single source of truth shared by the fetch-override
 * reroute and its unit tests.
 */
export function resolveMidStreamRateLimitResetAt(
  quota: OAuthQuotaSnapshot | undefined,
  window: string,
  now: number,
  defaultMs: number,
): number {
  const named =
    window === PRIMARY
      ? quota?.primary
      : window === SECONDARY
        ? quota?.secondary
        : undefined
  const namedReset = named?.resetsAt ? Date.parse(named.resetsAt) : NaN
  if (Number.isFinite(namedReset) && namedReset > now) return namedReset

  return now + defaultMs
}

function normalizeThresholds(storage: AccountStorage | null) {
  const configured = storage?.quota?.minimumRemaining || {}
  return {
    primary: configured.primary ?? configured['5h'] ?? 15,
    secondary: configured.secondary ?? configured['1w'] ?? 10,
  }
}

function getQuotaNextRefreshAt(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return now + getQuotaCheckIntervalMs(storage)

  const thresholds = normalizeThresholds(storage)
  const blockedResetTimes: number[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const window = quota?.[key]
    if (!window) return now + getQuotaCheckIntervalMs(storage)
    if (window.remainingPercent >= thresholds[key]) continue
    const resetTime = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isFinite(resetTime) || resetTime <= now) {
      return now + getQuotaCheckIntervalMs(storage)
    }
    blockedResetTimes.push(resetTime)
  }

  if (!blockedResetTimes.length) return now + getQuotaCheckIntervalMs(storage)
  return Math.min(...blockedResetTimes) + 60_000
}

function getPersistedMainQuota(storage: AccountStorage | null): {
  quota: OAuthQuotaSnapshot
  checkedAt: number
  tokenFingerprint?: string
} | null {
  if (!storage?.quota?.mainQuota || !storage.quota.mainQuotaCheckedAt)
    return null
  return {
    quota: storage.quota.mainQuota,
    checkedAt: storage.quota.mainQuotaCheckedAt,
    tokenFingerprint: storage.quota.mainQuotaToken,
  }
}

function getQuotaRefreshEveryNRequests(storage: AccountStorage | null): number {
  const n = storage?.quota?.refreshEveryNRequests
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Stable, non-reversible fingerprint of an access token. Used to detect a
 * main-account switch so a different account's persisted/cached quota is never
 * reused. Not a secret — a truncated SHA-256, safe to persist alongside quota.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export type QuotaEntry = {
  quota: OAuthQuotaSnapshot
  refreshAfter: number // Unix ms — earliest next refresh
  checkedAt: number // when snapshot was fetched
}

export type QuotaManagerOptions = {
  storage: AccountStorage | null
  fetchImpl?: typeof fetch
  now?: () => number
  /** Injected quota-fetch function — replaces the hard-imported Anthropic fetchOAuthQuotaSnapshot */
  fetchQuotaFn?: ProviderQuotaFn
  onMainQuotaFetched?: (
    quota: OAuthQuotaSnapshot,
    checkedAt: number,
    fingerprint: string,
    fetchStartedAt: number,
  ) => void
  onApiError?: (error: AccountOperationError) => void
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class QuotaManager {
  // --- State ---
  private main: QuotaEntry | null = null
  private mainTokenFp: string | null = null
  // Stable ChatGPT account identity of the account that produced `main` (when
  // known). Lets the killswitch read survive a token REFRESH (same account, new
  // access token) while still detecting an account SWITCH — unlike mainTokenFp,
  // which changes on every refresh and would drop the cache.
  private mainQuotaAccountId: string | null = null
  private fallbacks = new Map<string, QuotaEntry>()
  // Fingerprint of the access token that produced each fallback cache entry, so
  // a re-login (credential change) for the same account id invalidates the
  // stale entry instead of being treated as fresh.
  private fallbackTokenFps = new Map<string, string>()

  // --- Inflight deduplication ---
  private inflightMain: Promise<OAuthQuotaSnapshot> | null = null
  // Fingerprint of the token that started the current inflightMain fetch.
  // A concurrent call with a different token must NOT join the in-flight
  // promise — it would receive quota for the wrong account.
  private inflightMainFp: string | null = null
  private inflightFallbacks = new Map<string, Promise<OAuthQuotaSnapshot>>()

  // --- Rate-limiting (scoped per route so a fallback 429 never backs off the
  // main account or vice versa) ---
  private mainLastApiError: AccountOperationError | undefined = undefined
  private fallbackApiErrors = new Map<string, AccountOperationError>()
  private fallbackErrorTokenFps = new Map<string, string>()

  // --- Mid-stream rate-limit marks (from a WS response.failed
  // rate_limit_reached_type signal — never a quota-API call). Keyed by the
  // internal storage id ('main' or a fallback id). Expires purely by
  // read-time comparison in isRateLimited(); no timer is armed. ---
  private rateLimitedUntilMap = new Map<string, number>()

  // --- Serial API gate (prevents concurrent quota API calls) ---
  private apiGate: Promise<unknown> = Promise.resolve()
  private lastApiCallAt = 0

  // --- Config ---
  private storage: AccountStorage | null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly fetchQuotaFn: ProviderQuotaFn | undefined
  private readonly onMainQuotaFetched: QuotaManagerOptions['onMainQuotaFetched']
  private readonly onApiError: QuotaManagerOptions['onApiError']

  constructor(opts: QuotaManagerOptions) {
    this.storage = opts.storage
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
    this.fetchQuotaFn = opts.fetchQuotaFn
    this.onMainQuotaFetched = opts.onMainQuotaFetched
    this.onApiError = opts.onApiError

    // Seed main quota from persisted storage, bound to the token fingerprint
    // that produced it. refreshMain() drops this seed if the live token's
    // fingerprint differs (main-account switch), preventing stale wrong-account
    // quota from being served during backoff.
    this.seedMainFromStorage(opts.storage)
    this.seedMainBackoffFromStorage(opts.storage)
  }

  // =========================================================================
  // Get (synchronous, from cache)
  // =========================================================================

  /**
   * Cached main quota entry. Pass the live access token to enforce token
   * binding: if the cached entry was produced by a different token (main
   * account switched), it is dropped and null is returned so the caller
   * refetches for the current account. Called without a token (e.g. for
   * display) it returns whatever is cached.
   */
  getMain(accessToken?: string): QuotaEntry | null {
    if (
      accessToken &&
      this.main &&
      this.mainTokenFp &&
      this.mainTokenFp !== tokenFingerprint(accessToken)
    ) {
      this.main = null
      this.mainTokenFp = null
    }
    return this.main
  }

  /**
   * Cached fallback quota entry. Pass the live access token to enforce token
   * binding: if the entry was produced by a different token (account re-login),
   * it is dropped and null is returned so the caller refetches.
   */
  getFallback(accountId: string, accessToken?: string): QuotaEntry | null {
    const entry = this.fallbacks.get(accountId) ?? null
    if (!accessToken || !entry) return entry

    const fp = this.fallbackTokenFps.get(accountId)
    if (fp !== tokenFingerprint(accessToken)) {
      this.fallbacks.delete(accountId)
      this.fallbackTokenFps.delete(accountId)
      return null
    }
    return entry
  }

  getAllFallbacks(): Map<string, QuotaEntry> {
    return this.fallbacks
  }

  // =========================================================================
  // Set (manual inject — push from HTTP headers / WS frame, or seeding from
  // persisted account.quota on boot)
  // =========================================================================

  setMain(accessToken: string, entry: QuotaEntry, accountId?: string): void {
    // Conditional-push guard: never overwrite a valid cached snapshot with
    // an empty one (no window data).
    if (!hasAnyQuotaWindow(entry.quota)) return
    this.mainTokenFp = tokenFingerprint(accessToken)
    // A genuine account SWITCH (same identity condition as peekMainForPolicy)
    // invalidates the OLD account's mid-stream mark — otherwise the new
    // account inherits a 429 reroute until the old account's reset time. A
    // token refresh (same accountId, new token) must NOT hit this: it fires
    // on every refresh and would erase a still-live mark for the same account.
    if (
      accountId &&
      this.mainQuotaAccountId &&
      this.mainQuotaAccountId !== accountId
    ) {
      this.clearRateLimited('main')
    }
    if (accountId) this.mainQuotaAccountId = accountId
    this.main = entry
    if (quotaLooksHealthy(entry.quota)) this.clearRateLimited('main')
  }

  /**
   * Non-invalidating read of the cached main quota for POLICY decisions
   * (killswitch). Unlike getMain(token), a token mismatch does NOT drop the
   * cache — an access-token refresh is a same-account event and must not turn a
   * known-exhausted account into "unknown" (which would fail open and spend).
   *
   * Pass the live ChatGPT accountId to still drop on a genuine account SWITCH:
   * if the cached entry's account identity is known and differs, return null so
   * the killswitch treats it as unknown rather than judging account A by account
   * B's quota. When identity is unknown on either side, the cached snapshot is
   * returned (best-effort) — the same fail-open-on-unknown stance as elsewhere.
   */
  peekMainForPolicy(accountId?: string): QuotaEntry | null {
    if (
      accountId &&
      this.mainQuotaAccountId &&
      this.mainQuotaAccountId !== accountId
    ) {
      return null
    }
    return this.main
  }

  /**
   * Non-invalidating read of a cached fallback quota for POLICY decisions
   * (killswitch). Keyed by the stable internal account id, so a token refresh
   * for the same account does not drop it (getFallback(id, token) would).
   */
  peekFallbackForPolicy(accountId: string): QuotaEntry | null {
    return this.fallbacks.get(accountId) ?? null
  }

  setFallback(
    accountId: string,
    entry: QuotaEntry,
    accessToken?: string,
  ): void {
    // Conditional-push guard: never overwrite a valid cached snapshot with
    // an empty one (no window data).
    if (!hasAnyQuotaWindow(entry.quota)) return
    this.fallbacks.set(accountId, entry)
    if (accessToken) {
      this.fallbackTokenFps.set(accountId, tokenFingerprint(accessToken))
    } else {
      this.fallbackTokenFps.delete(accountId)
    }
    if (quotaLooksHealthy(entry.quota)) this.clearRateLimited(accountId)
  }

  // =========================================================================
  // Mid-stream rate-limit marks
  //
  // Sourced from a WS response.failed rate_limit_reached_type frame — the
  // frame itself is the authority, so marking never triggers a network call.
  // Expiry is read-time only (isRateLimited compares against injected now());
  // no timer is armed, so a mark simply stops applying once its reset passes.
  // =========================================================================

  /**
   * Mark accountId ('main' or a fallback id) rate-limited until resetAtMs.
   * Keeps the LATER reset: skips only when an existing mark is strictly
   * later than resetAtMs, so an equal-reset re-mark still applies (idempotent)
   * instead of being silently dropped by a stale `>=` comparison.
   */
  markRateLimited(accountId: string, resetAtMs: number): void {
    const existing = this.rateLimitedUntilMap.get(accountId)
    if (existing !== undefined && existing > resetAtMs) return
    this.rateLimitedUntilMap.set(accountId, resetAtMs)
  }

  /** True iff accountId has a mark whose reset has not yet passed. */
  isRateLimited(accountId: string): boolean {
    const until = this.rateLimitedUntilMap.get(accountId)
    return until !== undefined && this.now() < until
  }

  /**
   * Raw stored reset for accountId's mark, or undefined if none. Unlike
   * isRateLimited, this does NOT apply read-time expiry — callers on the
   * block path already know the mark is live (isRateLimited just returned
   * true) and want its exact reset estimate for a Retry-After computation.
   */
  rateLimitedUntil(accountId: string): number | undefined {
    return this.rateLimitedUntilMap.get(accountId)
  }

  /** Explicit early clear — read-time expiry in isRateLimited is primary. */
  clearRateLimited(accountId: string): void {
    this.rateLimitedUntilMap.delete(accountId)
  }

  // =========================================================================
  // Refresh (async, deduplicated, rate-limited)
  // =========================================================================

  async refreshMain(accessToken: string): Promise<OAuthQuotaSnapshot> {
    // If the main account/token changed, invalidate the cache (including a
    // persisted seed) BEFORE the backoff short-circuit so a different account's
    // stale quota is never returned while the quota API is backed off.
    const fp = tokenFingerprint(accessToken)
    if (this.mainTokenFp && this.mainTokenFp !== fp) {
      this.main = null
      this.mainTokenFp = null
    }

    // Deduplicate — return in-flight promise only when it was started with the
    // same token fingerprint. A different token means a different account; do
    // not let it join a fetch started for the old account.
    if (this.inflightMain && this.inflightMainFp === fp)
      return this.inflightMain

    // Rate-limit — if API recently 429'd, return stale or throw
    if (this.isBackedOff()) {
      if (this.main) return this.main.quota
      throw new Error('Quota API rate-limited — try again later')
    }

    this.inflightMainFp = fp
    this.inflightMain = this._fetchMain(accessToken)
    return this.inflightMain
  }

  async refreshFallback(
    accountId: string,
    accessToken: string,
  ): Promise<OAuthQuotaSnapshot> {
    // Deduplicate per account+token so a same-label re-login never joins a
    // quota probe that was started with the previous credentials.
    const inflightKey = QuotaManager.fallbackInflightKey(accountId, accessToken)
    const inflight = this.inflightFallbacks.get(inflightKey)
    if (inflight) return inflight

    // Rate-limit — scoped to THIS fallback account only
    if (this.isFallbackBackedOff(accountId, accessToken)) {
      const cached = this.getFallback(accountId, accessToken)
      if (cached) return cached.quota
      throw new Error('Quota API rate-limited — try again later')
    }

    const promise = this._fetchFallback(accountId, accessToken)
    this.inflightFallbacks.set(inflightKey, promise)
    return promise
  }

  async refreshAllFallbacks(accounts: OAuthAccount[]): Promise<void> {
    const now = this.now()

    for (const account of accounts) {
      if (account.enabled === false) continue
      if (!account.access) continue

      const cached = this.getFallback(account.id, account.access)
      if (cached && now < cached.refreshAfter) continue

      try {
        await this.refreshFallback(account.id, account.access)
      } catch {
        // Best-effort — keep stale cache entry if fetch fails
      }
    }
  }

  /**
   * Fire-and-forget refresh. Does not await, swallows errors.
   */
  refreshMainInBackground(accessToken: string): void {
    const fp = tokenFingerprint(accessToken)
    if (this.inflightMain && this.inflightMainFp === fp) return
    if (this.isBackedOff()) return
    void this.refreshMain(accessToken).catch(() => {})
  }

  // =========================================================================
  // Staleness queries
  // =========================================================================

  isMainStale(): boolean {
    if (!this.main) return true
    return this.now() >= this.main.refreshAfter
  }

  isFallbackStale(accountId: string, accessToken?: string): boolean {
    // Token-aware: a credential change invalidates the entry (treated as stale).
    const entry = this.getFallback(accountId, accessToken)
    if (!entry) return true
    return this.now() >= entry.refreshAfter
  }

  shouldRefreshOnRequestCount(requestCount: number): boolean {
    const everyN = getQuotaRefreshEveryNRequests(this.storage)
    if (everyN <= 0) return false
    return requestCount > 0 && requestCount % everyN === 0
  }

  /**
   * Combined check: should a refresh happen right now?
   * True if main is stale by time OR triggered by request count.
   */
  needsRefresh(requestCount: number): boolean {
    return this.isMainStale() || this.shouldRefreshOnRequestCount(requestCount)
  }

  // =========================================================================
  // Config
  // =========================================================================

  updateStorage(storage: AccountStorage | null): void {
    this.storage = storage
    this.seedMainFromStorage(storage)
    this.seedMainBackoffFromStorage(storage)
  }

  /**
   * Seed/update the main quota cache from persisted state. This is deliberately
   * callable after every disk load so another plugin process's fresh quota write
   * can stop this process from showing "checking…" or making a redundant quota
   * API call.
   */
  seedMainFromStorage(
    storage: AccountStorage | null,
    accessToken?: string,
  ): void {
    const persisted = getPersistedMainQuota(storage)
    if (!persisted) return

    const accessTokenFp = accessToken ? tokenFingerprint(accessToken) : null
    if (
      accessTokenFp &&
      persisted.tokenFingerprint &&
      persisted.tokenFingerprint !== accessTokenFp
    ) {
      return
    }

    const entry: QuotaEntry = {
      quota: persisted.quota,
      refreshAfter: getQuotaNextRefreshAt(
        persisted.quota,
        storage,
        persisted.checkedAt,
      ),
      checkedAt: persisted.checkedAt,
    }
    if (
      this.main &&
      this.main.checkedAt >= entry.checkedAt &&
      (!accessTokenFp ||
        !this.mainTokenFp ||
        this.mainTokenFp === accessTokenFp)
    ) {
      return
    }

    this.main = entry
    this.mainTokenFp = persisted.tokenFingerprint ?? null
    if (storage?.mainAccountId) {
      // Mirrors setMain's switch-clear: a fresh disk load asserting a
      // different stable account identity is the same "switch" event, even
      // though in practice no mark can exist yet at process boot (the only
      // caller today). Kept for consistency should a future caller re-seed
      // mid-process with a live mark present.
      if (
        this.mainQuotaAccountId &&
        this.mainQuotaAccountId !== storage.mainAccountId
      ) {
        this.clearRateLimited('main')
      }
      this.mainQuotaAccountId = storage.mainAccountId
    }
  }

  private seedMainBackoffFromStorage(storage: AccountStorage | null): void {
    const persistedError = storage?.quota?.mainLastQuotaApiError
    this.mainLastApiError =
      persistedError && quotaBackoffActive(persistedError, this.now())
        ? persistedError
        : undefined
  }

  /**
   * Seed fallback cache entries from persisted account.quota data.
   * Updates older in-memory entries so a fresh quota write from another plugin
   * process prevents redundant checks and stale sidebar writes.
   */
  seedFallbacksFromAccounts(accounts: OAuthAccount[]): void {
    const checkInterval = getQuotaCheckIntervalMs(this.storage)
    for (const account of accounts) {
      if (account.enabled === false) continue
      if (!account.quota) continue
      const checkedAt = Math.max(
        account.quota.primary?.checkedAt ?? 0,
        account.quota.secondary?.checkedAt ?? 0,
      )
      if (checkedAt <= 0) continue
      const existing = this.getFallback(account.id, account.access)
      if (existing && existing.checkedAt >= checkedAt) continue
      this.setFallback(
        account.id,
        {
          quota: account.quota,
          refreshAfter: checkedAt + checkInterval,
          checkedAt,
        },
        account.access,
      )
    }
  }

  /**
   * Whether the MAIN quota API is currently in backoff. Scoped to the main
   * account — a fallback account's 429 never reports here.
   */
  isBackedOff(): boolean {
    return quotaBackoffActive(this.mainLastApiError, this.now())
  }

  /**
   * Whether a specific fallback account's quota API is in backoff.
   */
  isFallbackBackedOff(accountId: string, accessToken?: string): boolean {
    if (accessToken) {
      const errorFp = this.fallbackErrorTokenFps.get(accountId)
      if (errorFp !== tokenFingerprint(accessToken)) return false
    }
    return quotaBackoffActive(this.fallbackApiErrors.get(accountId), this.now())
  }

  getLastApiError(): AccountOperationError | undefined {
    return this.mainLastApiError
  }

  // =========================================================================
  // Private
  // =========================================================================

  /** Minimum gap between consecutive quota API calls (ms). */
  private static readonly API_CALL_GAP_MS = 1_000

  private static fallbackInflightKey(
    accountId: string,
    accessToken: string,
  ): string {
    return JSON.stringify([accountId, tokenFingerprint(accessToken)])
  }

  private static quotaLockName(accountId: string): string {
    const safeId = accountId.replace(/[^a-zA-Z0-9._-]+/g, '-')
    return `opencode-fallback-quota-refresh-${safeId || 'account'}`
  }

  /**
   * Serialize API calls through a shared gate so only one
   * quota API request runs at a time, with a minimum gap
   * between calls. Prevents concurrent and rapid-fire calls
   * from triggering rate limits.
   */
  private _enqueueApiFetch<T>(fn: () => Promise<T>): Promise<T> {
    const gatedFn = async (): Promise<T> => {
      // Wait until minimum gap since last API call
      const elapsed = this.now() - this.lastApiCallAt
      if (elapsed < QuotaManager.API_CALL_GAP_MS) {
        await new Promise<void>((r) => {
          const id = nativeSetTimeout(r, QuotaManager.API_CALL_GAP_MS - elapsed)
          if (typeof id === 'object' && 'unref' in id) id.unref()
        })
      }
      this.lastApiCallAt = this.now()
      return fn()
    }
    const queued = this.apiGate.then(gatedFn, gatedFn)
    this.apiGate = queued.catch(() => {})
    return queued
  }

  private async _fetchMain(accessToken: string): Promise<OAuthQuotaSnapshot> {
    // Capture the fingerprint this fetch was started with. The finally block
    // uses it to guard the inflight-slot clear: only the fetch that currently
    // owns the slot (same fp) may null it out. If a second call with a
    // DIFFERENT token started a fresh fetch (overwriting inflightMain/Fp),
    // the first call's finally must NOT null the second's tracking while it
    // is still in flight — that would cause later same-token callers to miss
    // dedup and start redundant fetches.
    const thisFetchFp = tokenFingerprint(accessToken)
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — may have been set by
        // a preceding queued call while we waited
        if (this.isBackedOff()) {
          if (this.main) return this.main.quota
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: 'opencode-main-quota-refresh',
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.main
          if (cached && this.now() < cached.refreshAfter) return cached.quota
          throw new Error('Quota refresh is already in progress')
        }
        try {
          const fetchStartedAt = this.now()
          const quota = await this._fetchQuota(accessToken)
          const now = this.now()
          this.mainTokenFp = tokenFingerprint(accessToken)
          this.main = {
            quota,
            refreshAfter: getQuotaNextRefreshAt(quota, this.storage, now),
            checkedAt: now,
          }
          // This assignment bypasses setMain (no accountId is threaded through
          // this path), so its healthy-clear must be mirrored here — otherwise
          // a known-healthy active poll leaves a stale mid-stream mark forcing
          // fallback until the mark's own (unrelated) reset estimate.
          if (quotaLooksHealthy(quota)) this.clearRateLimited('main')
          this.mainLastApiError = undefined
          this.onMainQuotaFetched?.(
            quota,
            now,
            this.mainTokenFp,
            fetchStartedAt,
          )
          return quota
        } catch (error) {
          this._handleMainFetchError(error)
          throw error
        } finally {
          await fileLock.release()
        }
      } finally {
        // Only clear the inflight slot if this fetch still owns it (same fp).
        // A concurrent call with a different token may have already overwritten
        // inflightMain/Fp with its own fetch — clearing it here would break
        // dedup for that second fetch's callers.
        if (this.inflightMainFp === thisFetchFp) {
          this.inflightMain = null
          this.inflightMainFp = null
        }
      }
    })
  }

  private async _fetchFallback(
    accountId: string,
    accessToken: string,
  ): Promise<OAuthQuotaSnapshot> {
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — scoped to this fallback account
        if (this.isFallbackBackedOff(accountId, accessToken)) {
          const cached = this.getFallback(accountId, accessToken)
          if (cached) return cached.quota
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: QuotaManager.quotaLockName(accountId),
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.getFallback(accountId, accessToken)
          if (cached && this.now() < cached.refreshAfter) return cached.quota
          throw new Error('Quota refresh is already in progress')
        }
        try {
          const quota = await this._fetchQuota(accessToken)
          const now = this.now()
          this.setFallback(
            accountId,
            {
              quota,
              refreshAfter: now + getQuotaCheckIntervalMs(this.storage),
              checkedAt: now,
            },
            accessToken,
          )
          this.fallbackApiErrors.delete(accountId)
          this.fallbackErrorTokenFps.delete(accountId)
          return quota
        } finally {
          await fileLock.release()
        }
      } catch (error) {
        this._handleFallbackFetchError(accountId, accessToken, error)
        throw error
      } finally {
        this.inflightFallbacks.delete(
          QuotaManager.fallbackInflightKey(accountId, accessToken),
        )
      }
    })
  }

  /** Route through injected fetchQuotaFn, or throw if unset. */
  private async _fetchQuota(accessToken: string): Promise<OAuthQuotaSnapshot> {
    if (!this.fetchQuotaFn) {
      throw new Error(
        'Quota fetch not available — no fetchQuotaFn injected (push-only mode)',
      )
    }
    return this.fetchQuotaFn({
      accessToken,
      fetchImpl: this.fetchImpl,
      now: this.now,
    })
  }

  // A 401 is an auth/token problem, not a rate limit. The caller refreshes the
  // token and retries; backing off the quota API here would block that retry,
  // so surface 401s without recording backoff state.
  // pull-mode only (§17) — duck-types status===401
  private static isAuthError(error: unknown): boolean {
    return (error as { status?: number } | null | undefined)?.status === 401
  }

  /** Main quota failure: arms main-only backoff and persists via onApiError. */
  private _handleMainFetchError(error: unknown): void {
    if (QuotaManager.isAuthError(error)) return
    this.mainLastApiError = buildQuotaOperationError({
      error,
      now: this.now(),
      previous: this.mainLastApiError,
    })
    this.onApiError?.(this.mainLastApiError)
  }

  /**
   * Fallback quota failure: arms backoff for THIS account only. Never touches
   * main backoff state and never calls onApiError (which persists the main
   * quota error) — the per-account error is recorded by the caller via the
   * account's lastQuotaRefreshError.
   */
  private _handleFallbackFetchError(
    accountId: string,
    accessToken: string,
    error: unknown,
  ): void {
    if (QuotaManager.isAuthError(error)) return
    const tokenFp = tokenFingerprint(accessToken)
    const previous =
      this.fallbackErrorTokenFps.get(accountId) === tokenFp
        ? this.fallbackApiErrors.get(accountId)
        : undefined
    this.fallbackApiErrors.set(
      accountId,
      buildQuotaOperationError({
        error,
        now: this.now(),
        previous,
      }),
    )
    this.fallbackErrorTokenFps.set(accountId, tokenFp)
  }
}

// ---------------------------------------------------------------------------
// Conditional-push guard
// ---------------------------------------------------------------------------

function hasAnyQuotaWindow(quota: OAuthQuotaSnapshot): boolean {
  for (const _key of Object.keys(quota)) return true
  return false
}

// ---------------------------------------------------------------------------
// Mid-stream rate-limit mark: early-clear guard
// ---------------------------------------------------------------------------

/**
 * True when a freshly pushed snapshot shows BOTH windows present and under
 * 100% used — positive full evidence the account is no longer exhausted, so
 * a stale mid-stream rate-limit mark can be cleared before its read-time
 * expiry. A mark is per-account, not per-window, so a partial snapshot (only
 * one window present — e.g. a malformed refreshAllQuota result) is not
 * evidence: the OTHER window could be the one that's actually exhausted.
 * Clears only on a snapshot where both windows are present and under 100%.
 */
function quotaLooksHealthy(quota: OAuthQuotaSnapshot): boolean {
  const { primary, secondary } = quota
  if (!primary || !secondary) return false
  return primary.usedPercent < 100 && secondary.usedPercent < 100
}
