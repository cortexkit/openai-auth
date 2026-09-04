/**
 * Custody policy core — vault-aware OAuth fallback resolution.
 *
 * Three layers, in order of trust:
 *
 * 1. **Tombstone sentinel** — when an account's access+refresh both equal
 *    `claustrum-tombstone:v1:<provider>` and `expires === 0`, the account is
 *    tombstoned. Predicates alone observe this; the storage toggle is irrelevant.
 * 2. **Manifest enrollment** — case-exact `manifest.label === account.id` under
 *    the opencode-claustrum owning filter. Other tenants are ignored.
 * 3. **Storage toggle** — `storage.claustrum?.enabled === true` arms the
 *    custody path. Without it the predicates evaluate as if custody were off:
 *    enrolling accounts still serve local access, tombstoned ones report
 *    `excluded`.
 *
 * `resolveFallbackAccess` is async from day one so an inline completion
 * seam can be slotted in without touching call sites.
 *
 * Handle values and credential payloads NEVER appear in logs, thrown-error
 * messages/causes, or any surface that could be dumped or sidetabled.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { createLogger } from '../logger.ts'
import {
  type AccountStorage,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  fallbackRefreshLockName,
  type OAuthAccount,
} from './accounts.ts'
import {
  CUSTODY_OWNING_PROVIDER,
  type CustodyManifestReadResult,
  custodyManifestHandles,
} from './custody-manifest.ts'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth.ts'
import type { acquireRefreshFileLock } from './refresh-file-lock.ts'

const log = createLogger('custody')

export const CUSTODY_TOMBSTONE_PREFIX = 'claustrum-tombstone:v1:'
export const CUSTODY_REFUSE = Symbol('custody-refuse')
export const CUSTODY_EXCLUDED = Symbol('custody-excluded')

export type VaultProvenance = { handle: string; recordVersion: number }

export type FallbackAccessResolution =
  | { token: string; provenance: 'local' }
  | { token: string; provenance: VaultProvenance }

export function stampVaultProvenance(
  response: Response,
  provenance: VaultProvenance | 'local' | undefined,
  responseProvenance: WeakMap<Response, VaultProvenance>,
): Response {
  if (provenance && provenance !== 'local') {
    responseProvenance.set(response, provenance)
  }
  return response
}

export function custodyTombstoneKey(provider: string): string {
  return `${CUSTODY_TOMBSTONE_PREFIX}${provider}`
}

// ---------------------------------------------------------------------------
// Served credential (normalized)
// ---------------------------------------------------------------------------

export type ServedFallbackCredential = {
  payload: { access: string }
  recordVersion: number
  expiresAtMs: number
  servedAccountId?: string
}

// ---------------------------------------------------------------------------
// Tombstone sentinel — survives `normalizeAccount`
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function owningAccount(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
): boolean {
  // Case-exact label === account.id. Lower-casing either side would let a
  // manifest with label "Main" claim local id "main" — wrong: the local
  // id is the source of truth, so the join must be case-exact both ways.
  return custodyManifestHandles(manifest).has(account.id)
}

/**
 * `enrolled` = the manifest contains a case-exact `label === account.id`
 * entry under the opencode-claustrum owning filter. The storage toggle is
 * intentionally ignored: enrollment is a manifest fact, not a policy choice.
 */
export function enrolled(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
): boolean {
  return owningAccount(account, manifest)
}

/**
 * `tombstoned` = oauth access AND refresh both equal the per-provider
 * sentinel AND `expires === 0`. The provider name lives in the argument so
 * this predicate composes across providers — the opencode consumer passes
 * `'openai'`.
 */
export function tombstoned(account: OAuthAccount, provider: string): boolean {
  if (account.type !== 'oauth') return false
  const sentinel = custodyTombstoneKey(provider)
  return (
    account.access === sentinel &&
    account.refresh === sentinel &&
    account.expires === 0
  )
}

/**
 * `custodied` = storage.claustrum?.enabled AND enrolled AND tombstoned.
 * The storage toggle is the only knob that arms the vault path; without it
 * a tombstoned account is `excluded`, not `custodied`.
 */
export function custodied(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
  storage: Pick<AccountStorage, 'claustrum'>,
  provider: string = CUSTODY_OWNING_PROVIDER,
): boolean {
  if (!storage.claustrum?.enabled) return false
  if (!enrolled(account, manifest)) return false
  return tombstoned(account, provider)
}

/**
 * `enrolling` = enrolled AND NOT tombstoned. The account has a manifest
 * entry but is still serving local access (e.g. migration in progress).
 */
export function enrolling(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
  provider: string = CUSTODY_OWNING_PROVIDER,
): boolean {
  return enrolled(account, manifest) && !tombstoned(account, provider)
}

/**
 * `refreshInert` = enrolled OR tombstoned. Used by the refresh gate to
 * decide whether a refresh attempt would actually fetch a new token vs
 * fall back to the local/vault read.
 */
export function refreshInert(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
  provider: string,
): boolean {
  return enrolled(account, manifest) || tombstoned(account, provider)
}

/**
 * `excluded` = tombstoned AND NOT custodied. The account is dead in the
 * vault's view but the operator has not turned on the storage toggle —
 * refuse to serve any token for it.
 */
export function excluded(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
  storage: Pick<AccountStorage, 'claustrum'>,
  provider: string,
): boolean {
  return tombstoned(account, provider) && !custodied(account, manifest, storage)
}

// ---------------------------------------------------------------------------
// Identity verifier
// ---------------------------------------------------------------------------

export type ServedIdentityCheck =
  | { reason: 'ok' }
  | { reason: 'nullClaim' }
  | {
      reason: 'identityMismatch'
      detail: 'claimDiffersFromLocal' | 'labelDisagreesWithClaim'
    }

/**
 * Parse the served access token, compare its `chatgpt_account_id` claim
 * against the local account's `accountId`, and (when present) check the
 * served-account-id label field agrees. The vendored `ServedCredential` has
 * no served id today, so the labelDisagreesWithClaim branch is conditional —
 * the test asserting it is `test.skip` until the wire contract adds the
 * field.
 */
export function verifyServedFallbackIdentity(
  served: ServedFallbackCredential,
  account: OAuthAccount,
): ServedIdentityCheck {
  const claims = parseJwtClaims(served.payload.access)
  if (!claims) return { reason: 'nullClaim' }
  const claimId = extractAccountIdFromClaims(claims)
  if (!claimId) return { reason: 'nullClaim' }
  if (account.accountId && claimId !== account.accountId) {
    return { reason: 'identityMismatch', detail: 'claimDiffersFromLocal' }
  }
  if (served.servedAccountId && served.servedAccountId !== claimId) {
    return { reason: 'identityMismatch', detail: 'labelDisagreesWithClaim' }
  }
  return { reason: 'ok' }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type ResolveFallbackAccessOptions = {
  cache?: ClaustrumCredentialCache
  manifestHandle?: string
  completeEnrollmentDeps?: CompleteEnrollmentDeps
  refreshBeforeExpiryMs?: number
  now?: () => number
  requestPath?: boolean
}

export async function resolveFallbackAccess(
  account: OAuthAccount,
  storage: Pick<AccountStorage, 'claustrum'>,
  manifest?: CustodyManifestReadResult,
  options: ResolveFallbackAccessOptions = {},
): Promise<
  FallbackAccessResolution | typeof CUSTODY_REFUSE | typeof CUSTODY_EXCLUDED
> {
  const manifestState: CustodyManifestReadResult = manifest ?? {
    ok: true,
    value: { version: 1, providers: [] },
  }

  if (tombstoned(account, CUSTODY_OWNING_PROVIDER)) {
    if (!storage.claustrum?.enabled) return CUSTODY_EXCLUDED
    if (!enrolled(account, manifestState)) return CUSTODY_REFUSE
    // Custodied path: must have a manifest handle and a live cache hit.
    const handle = options.manifestHandle
    const cache = options.cache
    if (!handle || !cache) return CUSTODY_REFUSE
    const now = (options.now ?? Date.now)()
    // Reauth and blocked are vault verdicts about the credential; serving a
    // peeked record would ignore them.
    if (cache.isBlocked(handle) || cache.isReauth(handle, now)) {
      return CUSTODY_REFUSE
    }
    let served = await cache.peek(handle)
    if (!served && !options.requestPath) {
      try {
        served = await cache.get(handle, 30_000)
      } catch {
        return CUSTODY_REFUSE
      }
    }
    if (!served || served.expiresAtMs <= now) {
      return CUSTODY_REFUSE
    }
    const check = verifyServedFallbackIdentity(served, account)
    if (check.reason !== 'ok') {
      log.warn('custody identity check refused', { reason: check.reason })
      return CUSTODY_REFUSE
    }
    return {
      token: served.payload.access,
      provenance: { handle, recordVersion: served.recordVersion },
    }
  }

  if (enrolling(account, manifestState, CUSTODY_OWNING_PROVIDER)) {
    const now = (options.now ?? Date.now)()
    const refreshBeforeExpiryMs = options.refreshBeforeExpiryMs ?? 0
    if (
      account.access &&
      account.expires &&
      account.expires - now > refreshBeforeExpiryMs
    ) {
      return { token: account.access, provenance: 'local' }
    }
    if (storage.claustrum?.manifestWrite !== true) {
      latchEnrollPending(account.id, 'completionDisarmed')
      return CUSTODY_REFUSE
    }
    if (!options.completeEnrollmentDeps) return CUSTODY_REFUSE
    const outcome = await completeFallbackEnrollment(
      account,
      options.completeEnrollmentDeps,
    )
    if (outcome.kind !== 'succeeded') return CUSTODY_REFUSE
    const completedStorage = await options.completeEnrollmentDeps.loadAccounts(
      options.completeEnrollmentDeps.configPath,
    )
    const completedAccount = completedStorage?.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (!completedStorage || completedAccount?.type !== 'oauth') {
      return CUSTODY_REFUSE
    }
    const completedManifest =
      await options.completeEnrollmentDeps.readCustodyManifest(
        options.completeEnrollmentDeps.manifestPath,
      )
    return resolveFallbackAccess(
      completedAccount,
      completedStorage,
      completedManifest,
      {
        ...options,
      },
    )
  }

  if (!account.access) return CUSTODY_REFUSE
  return { token: account.access, provenance: 'local' }
}

// ---------------------------------------------------------------------------
// Credential cache
// ---------------------------------------------------------------------------

export type ClaustrumCredentialCacheOptions = {
  connector: (options: {
    connectionFile: string
    handshakeTimeoutMs?: number
  }) => Promise<ClaustrumCacheTransport>
  now?: () => number
}

export type ClaustrumCacheTransport = {
  getCredential(
    handle: string,
    minTtlMs?: number,
  ): Promise<{
    material: string
    recordVersion: number
    expiresAtMs: number | null
  }>
  statusCredential(handle: string): Promise<{
    ready: boolean
    lastErrorCode: string | null
    leaseHeld: boolean
    recordVersion: number
  }>
  reportAuthFailure(params: {
    handle: string
    providerStatus: number
    recordVersion: number
    reporterSource: 'direct' | 'relay_status_field' | 'relay_message_parse'
  }): Promise<void>
  close(): void
}

type ResidentRecord = {
  payload: { access: string }
  recordVersion: number
  expiresAtMs: number
}

type InflightSlot = {
  force: boolean
  promise: Promise<ResidentRecord>
}

type ReportBound = {
  count: number
  firstReportedAt: number
  reauthUntil?: number
}

const REAUTH_HOUR_MS = 60 * 60 * 1000

export class ClaustrumCredentialCache {
  readonly #transport: Promise<ClaustrumCacheTransport>
  readonly #resident = new Map<string, ResidentRecord>()
  readonly #inflight = new Map<string, InflightSlot>()
  readonly #reported = new Map<string, number>() // handle -> last reported version
  readonly #rejectedVersions = new Map<string, Set<number>>() // handle -> versions the daemon rejected
  readonly #blocked = new Set<string>()
  readonly #reauth = new Map<string, number>() // handle -> reauthUntilMs
  readonly #reportBound = new Map<string, ReportBound>() // handle -> bound
  readonly #now: () => number
  #closed = false

  constructor(options: ClaustrumCredentialCacheOptions) {
    this.#transport = options.connector({
      connectionFile: '',
      handshakeTimeoutMs: 5_000,
    })
    this.#now = options.now ?? Date.now
  }

  /**
   * Peek the resident record without I/O. Returns `undefined` if absent,
   * including the case where the record was invalidated by `reportAuthFailure`.
   */
  async peek(handle: string): Promise<ResidentRecord | undefined> {
    return this.#resident.get(handle)
  }

  /**
   * Public read-only view of a peek result. Exposes only the version and
   * expiry — never the credential material — so a projection layer can
   * surface a vault `recordVersion` without ever seeing a token.
   */
  async peekMetadata(
    handle: string,
  ): Promise<{ recordVersion: number; expiresAtMs: number } | undefined> {
    const record = this.#resident.get(handle)
    if (!record) return undefined
    return {
      recordVersion: record.recordVersion,
      expiresAtMs: record.expiresAtMs,
    }
  }

  /**
   * True iff a recent auth failure on this handle has been reported to the
   * daemon. The blocked set is informational; the resolver still attempts a
   * fetch on `get`, which clears the flag on success.
   */
  isBlocked(handle: string): boolean {
    return this.#blocked.has(handle)
  }

  /**
   * True iff the bound-and-reauth fence has fired for this handle and the
   * reauth window has not yet elapsed. Callers that project "needs reauth"
   * UI should gate on this. The fence clears after a proven 2xx vault request
   * or when the reauth window expires.
   */
  isReauth(handle: string, now: number = this.#now()): boolean {
    const until = this.#reauth.get(handle)
    if (until === undefined) return false
    return until > now
  }

  markVaultSuccess(handle: string): void {
    this.#reauth.delete(handle)
    this.#reportBound.delete(handle)
    this.#reported.delete(handle)
  }

  /**
   * Get the live resident record. If a live record exists and the caller
   * did not pass `force:true`, it returns immediately (no daemon I/O).
   * Otherwise it issues a single-flight `getCredential` call.
   *
   * `force:true` ALWAYS issues a new daemon call (it bypasses both the
   * resident record and any pending in-flight that originated from a
   * non-force caller). Two concurrent force:true calls share the same
   * new in-flight promise, so the second and subsequent force:true verifies
   * collapse onto the first one. A non-force caller issued while a
   * force:true fetch is pending still joins that force-fetch in-flight —
   * the cache never races two parallel daemon calls for the same handle.
   */
  async get(
    handle: string,
    minTtlMs?: number,
    options: { force?: boolean } = {},
  ): Promise<ResidentRecord> {
    if (this.#closed) throw new Error('Claustrum cache is closed')
    if (!options.force) {
      const existing = this.#resident.get(handle)
      if (existing) return existing
    }
    // Track whether THIS caller created the in-flight. If two concurrent
    // force:true callers race the map insert, only one wins; the loser
    // joins the winner's promise. The loser must NOT issue a second fetch,
    // or the bounded single-flight guarantee collapses to N.
    const force = !!options.force
    const existingInflight = this.#inflight.get(handle)
    if (existingInflight && existingInflight.force === force) {
      return existingInflight.promise
    }
    const promise = this.#fetch(handle, minTtlMs)
    const slot: InflightSlot = {
      force,
      promise: promise.finally(() => {
        this.#inflight.delete(handle)
      }),
    }
    this.#inflight.set(handle, slot)
    return slot.promise
  }

  async #fetch(handle: string, minTtlMs?: number): Promise<ResidentRecord> {
    const client = await this.#transport
    // Retry the daemon call while it keeps returning a rejected version.
    // A bounded retry count guards against a wedged daemon returning the
    // poisoned version forever — after the bound the cache surfaces the
    // poison so the caller can fail closed instead of spinning.
    const maxAttempts = 8
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await client.getCredential(handle, minTtlMs)
      const expiresAtMs = response.expiresAtMs ?? Number.MAX_SAFE_INTEGER
      const rejected = this.#rejectedVersions.get(handle)
      if (!rejected?.has(response.recordVersion)) {
        const record: ResidentRecord = {
          payload: { access: response.material },
          recordVersion: response.recordVersion,
          expiresAtMs,
        }
        this.#resident.set(handle, record)
        // A served version is not evidence it works; only a 2xx request resets
        // the bound. A fresh record can still immediately fail upstream.
        this.#blocked.delete(handle)
        this.#rejectedVersions.delete(handle)
        return record
      }
      // Same poisoned version — back off and retry.
      await sleep(5 * (attempt + 1))
    }
    throw new Error('custody credential rejected version after retries')
  }

  /**
   * Report an upstream auth failure on a served record. The report is
   * version-fenced (one report per handle per recordVersion), and after
   * two reports on the same version a one-hour bound fires — the third
   * and subsequent reports on the same version are suppressed, and the
   * handle is moved into the `reauth` set for an hour. A proven 2xx vault
   * request or expiry of that window clears the bound and reauth entry.
   *
   * The reported version is invalidated from the resident record in
   * `finally`, so a follow-up `get` cannot accidentally serve the same
   * version the daemon already rejected.
   */
  async reportAuthFailure(params: {
    handle: string
    providerStatus: number
    recordVersion: number
  }): Promise<void> {
    if (this.#closed) return
    const { handle, recordVersion, providerStatus } = params
    const now = this.#now()
    // Version fence (monotonic per handle): once a version has been reported
    // for this handle, subsequent reports for the same version are dropped
    // without round-tripping to the daemon. A cleared resident (after a
    // successful get re-fetching a higher version) lets a report at a
    // higher version bypass the fence again.
    const lastReported = this.#reported.get(handle)
    if (lastReported !== undefined && lastReported >= recordVersion) {
      return
    }
    // Two-cycle bound: after 2 distinct versions have been reported for this
    // handle, the next report (any version) is suppressed for one hour. A
    // a proven 2xx vault request or expiry lifts the suppression.
    let bound = this.#reportBound.get(handle)
    if (bound && bound.count >= 2) {
      if (bound.reauthUntil !== undefined && now >= bound.reauthUntil) {
        this.#reportBound.delete(handle)
        this.#reauth.delete(handle)
        this.#reported.delete(handle)
        bound = undefined
      } else {
        return
      }
    }
    const client = await this.#transport
    try {
      await client.reportAuthFailure({
        handle,
        providerStatus,
        recordVersion,
        reporterSource: 'direct',
      })
      this.#reported.set(handle, recordVersion)
      this.#blocked.add(handle)
      const prior = this.#reportBound.get(handle)
      this.#reportBound.set(handle, {
        count: (prior?.count ?? 0) + 1,
        firstReportedAt: prior?.firstReportedAt ?? now,
        reauthUntil:
          (prior?.count ?? 0) + 1 >= 2 ? now + REAUTH_HOUR_MS : undefined,
      })
      if ((prior?.count ?? 0) + 1 >= 2) {
        this.#reauth.set(handle, now + REAUTH_HOUR_MS)
        log.warn('custody report bound reached; entering reauth', {
          reauthMs: REAUTH_HOUR_MS,
        })
      }
    } finally {
      // Invalidate exactly the reported version so a follow-up get does
      // not serve the version the daemon rejected. The fetch path will
      // repopulate the resident record with whatever the daemon returns
      // next, which is the contract the test pins.
      const resident = this.#resident.get(handle)
      if (resident && resident.recordVersion === recordVersion) {
        this.#resident.delete(handle)
      }
      let rejected = this.#rejectedVersions.get(handle)
      if (!rejected) {
        rejected = new Set()
        this.#rejectedVersions.set(handle, rejected)
      }
      rejected.add(recordVersion)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#resident.clear()
    this.#inflight.clear()
    this.#reported.clear()
    this.#rejectedVersions.clear()
    this.#blocked.clear()
    this.#reauth.clear()
    this.#reportBound.clear()
    void this.#transport.then((client) => client.close()).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Enroll-pending store (process-local; sweep is the writer)
// ---------------------------------------------------------------------------

export type EnrollPendingReason =
  | 'unavailable'
  | 'gone'
  | 'identityMismatch'
  | 'nullClaim'
  | 'completionDisarmed'

const enrollPending = new Map<string, EnrollPendingReason>()

/**
 * Latch the first failure reason for an account. Subsequent marks do NOT
 * overwrite — the operator should see the original cause until the sweep
 * either clears the entry (on a successful completion) or restarts the
 * process (the store is module-local and dies on restart).
 */
export function markEnrollPending(
  accountId: string,
  reason: EnrollPendingReason,
): void {
  if (enrollPending.has(accountId)) return
  enrollPending.set(accountId, reason)
}

export function clearEnrollPending(accountId: string): void {
  enrollPending.delete(accountId)
}

export function enrollPendingReason(
  accountId: string,
): EnrollPendingReason | undefined {
  return enrollPending.get(accountId)
}

/**
 * Wipe the store. Test-only; production code must use mark/clear. The double
 * underscore marks it as not part of the public surface — a future sweep
 * writer is the only legitimate caller in production.
 */
export function __resetEnrollPendingForTest(): void {
  enrollPending.clear()
}

// ---------------------------------------------------------------------------
// Refresh error (defence in depth)
// ---------------------------------------------------------------------------

/**
 * Defence-in-depth error class. The predicates above are the policy source
 * of truth; this error is the wired-in escape hatch for a caller that wants
 * to short-circuit on a tombstone (status 503). Construction is intentionally
 * cheap; no payload leakage through `message`/`cause`.
 */
export class CustodyTombstoneRefreshError extends Error {
  readonly code = 'CUSTODY_TOMBSTONED'
  readonly status = 503
  readonly isRefreshError = true
  constructor(provider: string) {
    // No handle, no payload — the sentinel value itself carries the
    // provider identifier; surfacing that here keeps the message stable
    // for caller pattern-matching without leaking per-account fields.
    super(`custody tombstoned: ${custodyTombstoneKey(provider)}`)
    this.name = 'CustodyTombstoneRefreshError'
  }
}

export function assertNotCustodyTombstone(
  account: OAuthAccount,
  provider: string,
): void {
  if (tombstoned(account, provider)) {
    throw new CustodyTombstoneRefreshError(provider)
  }
}

// ---------------------------------------------------------------------------
// Enroll-completion sweep (§7.3)
// ---------------------------------------------------------------------------

export type CompleteEnrollmentDeps = {
  loadAccounts: (path: string) => Promise<AccountStorage | null>
  readCustodyManifest: (path?: string) => Promise<CustodyManifestReadResult>
  acquireRefreshFileLock: typeof acquireRefreshFileLock
  configPath: string
  manifestPath?: string
  cache: ClaustrumCredentialCache
  /** Minimum TTL (ms) handed to the vault for the verify-get. */
  minTtlMs: number
  /**
   * Read-modify-write the account store. The sweep calls this once on a
   * successful verify, setting `access` + `refresh` to the tombstone sentinel
   * and `expires = 0` — that single write is the only durable effect.
   */
  mutateAccounts: (
    mutate: (current: AccountStorage) => AccountStorage | undefined,
    path?: string,
  ) => Promise<unknown>
  /** Provider name; defaults to the owning provider (openai). */
  provider?: string
  /** Caller-supplied clock so tests can drive the boot/hour log dedupe. */
  now?: () => number
}

/**
 * Outcome of a single sweep pass. Surfaced only for tests and the boot/tick
 * orchestration; the production caller (`runEnrollCompletionSweep`) folds the
 * reason into the process-local enroll-pending store and the sidebar projection.
 */
export type CompleteEnrollmentOutcome =
  | { kind: 'skipped'; reason: 'notEnrolling' }
  | { kind: 'skipped'; reason: 'lockBusy' }
  | { kind: 'succeeded'; recordVersion: number }
  | {
      kind: 'failed'
      reason: 'gone' | 'nullClaim' | 'identityMismatch' | 'unavailable'
      recordVersion?: number
    }

/**
 * Per-account completion step (spec §7.3). Re-reads enrollment state from disk,
 * takes the account's refresh lock without joining a wait, force-fetches one
 * vault credential, verifies the served claim matches the local account id,
 * and tombstonese on success. The first failure latches via the enroll-pending
 * store; later failures do not overwrite. The sweep never writes or removes a
 * manifest entry — that is an operator act.
 *
 * Idempotent: a second sweep on an already-tombstoned account no-ops at the
 * `notEnrolling` guard. A concurrent enroll in another process lands the same
 * sentinel under its own save-lock; the tombstone is the join point.
 */
export async function completeFallbackEnrollment(
  account: OAuthAccount,
  deps: CompleteEnrollmentDeps,
): Promise<CompleteEnrollmentOutcome> {
  const provider = deps.provider ?? CUSTODY_OWNING_PROVIDER
  const manifest = await deps.readCustodyManifest(deps.manifestPath)
  const storage = await deps.loadAccounts(deps.configPath)
  if (!storage) return { kind: 'skipped', reason: 'notEnrolling' }
  const liveAccount = storage.accounts.find(
    (candidate) => candidate.id === account.id,
  )
  if (liveAccount?.type !== 'oauth') {
    return { kind: 'skipped', reason: 'notEnrolling' }
  }
  if (!enrolling(liveAccount, manifest, provider)) {
    return { kind: 'skipped', reason: 'notEnrolling' }
  }
  const manifestHandle = custodyManifestHandles(manifest).get(liveAccount.id)
  if (!manifestHandle) return { kind: 'skipped', reason: 'notEnrolling' }

  const lockName = fallbackRefreshLockName(liveAccount.id)
  // Skip this pass if another holder is mid-flight; never join-wait. The
  // refresh choke point already serialises refreshers and the next tick will
  // pick up any residue.
  const lock = await deps.acquireRefreshFileLock({
    name: lockName,
    ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
    path: deps.configPath,
  })
  if (!lock) return { kind: 'skipped', reason: 'lockBusy' }
  try {
    // Re-check under the lock: a concurrent tombstone write that completed
    // between the outer read and the lock acquisition must turn this pass
    // into a no-op. The manifest is read again to honour a hot-reloaded entry
    // removal too — but the loader does not own the entry-removal path; the
    // outer guard is the contract.
    const recheckManifest = await deps.readCustodyManifest(deps.manifestPath)
    const recheckStorage = await deps.loadAccounts(deps.configPath)
    const recheckAccount = recheckStorage?.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (
      !recheckStorage ||
      !recheckAccount ||
      recheckAccount.type !== 'oauth' ||
      !enrolling(recheckAccount, recheckManifest, provider)
    ) {
      return { kind: 'skipped', reason: 'notEnrolling' }
    }
    let served: Awaited<ReturnType<ClaustrumCredentialCache['get']>>
    try {
      served = await deps.cache.get(manifestHandle, deps.minTtlMs, {
        force: true,
      })
    } catch (error) {
      const reason = classifyGetError(error)
      latchEnrollPending(liveAccount.id, reason)
      return { kind: 'failed', reason }
    }
    const identity = verifyServedFallbackIdentity(
      {
        payload: { access: served.payload.access },
        recordVersion: served.recordVersion,
        expiresAtMs: served.expiresAtMs,
      },
      recheckAccount,
    )
    if (identity.reason !== 'ok') {
      const reason: CompleteEnrollmentOutcome & { kind: 'failed' } =
        identity.reason === 'nullClaim'
          ? {
              kind: 'failed',
              reason: 'nullClaim',
              recordVersion: served.recordVersion,
            }
          : {
              kind: 'failed',
              reason: 'identityMismatch',
              recordVersion: served.recordVersion,
            }
      latchEnrollPending(liveAccount.id, reason.reason)
      return reason
    }
    // Success: tombstone both oauth fields in one mutate. The sentinel is the
    // gate that flips `enrolling` to `custodied`; the manifest entry stays
    // untouched (operator-owned).
    const sentinel = custodyTombstoneKey(provider)
    await deps.mutateAccounts((current) => {
      const target = current.accounts.find((a) => a.id === account.id)
      if (target?.type !== 'oauth') return current
      const next: OAuthAccount = {
        ...target,
        access: sentinel,
        refresh: sentinel,
        expires: 0,
      }
      return {
        ...current,
        accounts: current.accounts.map((a) => (a.id === account.id ? next : a)),
      }
    }, deps.configPath)
    clearEnrollPending(liveAccount.id)
    return { kind: 'succeeded', recordVersion: served.recordVersion }
  } finally {
    await lock.release().catch(() => {})
  }
}

function classifyGetError(error: unknown): 'gone' | 'unavailable' {
  // `ClaustrumCredentialError.action === 'gone'` is the vault's verdict for
  // not_found / permanent; everything else folds into `unavailable` so the
  // boot/hour log surfaces the difference only when the vault says so.
  if (
    error &&
    typeof error === 'object' &&
    'action' in error &&
    (error as { action?: unknown }).action === 'gone'
  ) {
    return 'gone'
  }
  return 'unavailable'
}

function latchEnrollPending(
  accountId: string,
  reason: EnrollPendingReason,
): void {
  // First failure latches — later failures must not overwrite the original
  // cause. The boot/hour log in the loader keys on whether the store
  // already had a reason for this account.
  markEnrollPending(accountId, reason)
}
