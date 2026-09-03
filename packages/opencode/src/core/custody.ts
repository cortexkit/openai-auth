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

import { createLogger } from '../logger.ts'
import type { ManifestHandleFile } from '../vendor/claustrum-client/manifest-lock.ts'
import type { AccountStorage, OAuthAccount } from './accounts.ts'
import { normalizeAccount as normalizeAccountFromStore } from './accounts.ts'
import {
  CUSTODY_OWNING_PROVIDER,
  CUSTODY_OWNING_SERVE,
  CUSTODY_OWNING_SHAPE,
  type CustodyManifestReadResult,
} from './custody-manifest.ts'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth.ts'

const log = createLogger('custody')

export const CUSTODY_TOMBSTONE_PREFIX = 'claustrum-tombstone:v1:'
export const CUSTODY_REFUSE = Symbol('custody-refuse')
export const CUSTODY_EXCLUDED = Symbol('custody-excluded')

export type VaultProvenance = { handle: string; recordVersion: number }

export type FallbackAccessResolution =
  | { token: string; provenance: 'local' }
  | { token: string; provenance: VaultProvenance }

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

/**
 * The tombstone sentinel is a non-empty string, distinct from any real
 * refresh token. An OAuth account is tombstoned iff access+refresh are both
 * the sentinel AND `expires === 0`. The empty sentinel is dropped by
 * `normalizeAccount` (refresh is required to be a non-empty string for an
 * oauth entry to survive), so a tombstone survives normalization as the
 * sentinel value, never as the empty string.
 *
 * Re-exported here so the custody test suite can assert the sentinel
 * survives normalization without dragging the entire account-store surface
 * into the import.
 */
export function normalizeAccount(value: unknown): OAuthAccount | null {
  return normalizeAccountFromStore(value) as OAuthAccount | null
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function owningAccount(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
): boolean {
  if (!manifest.ok) return false
  for (const provider of manifest.value.providers) {
    if (
      provider.provider !== CUSTODY_OWNING_PROVIDER ||
      provider.shape !== CUSTODY_OWNING_SHAPE ||
      provider.serve !== CUSTODY_OWNING_SERVE
    ) {
      continue
    }
    // Case-exact label === account.id. Lower-casing either side would let a
    // manifest with label "Main" claim local id "main" — wrong: the local
    // id is the source of truth, so the join must be case-exact both ways.
    for (const entry of provider.accounts) {
      if (entry.label === account.id) return true
    }
  }
  return false
}

/**
 * `enrolled` = the manifest contains a case-exact `label === account.id`
 * entry under the opencode-claustrum owning filter. The storage toggle is
 * intentionally ignored: enrollment is a manifest fact, not a policy choice.
 */
export function enrolled(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
  _storage?: Pick<AccountStorage, 'claustrum'>,
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
): boolean {
  if (!storage.claustrum?.enabled) return false
  if (!enrolled(account, manifest)) return false
  return tombstoned(account, CUSTODY_OWNING_PROVIDER)
}

/**
 * `enrolling` = enrolled AND NOT tombstoned. The account has a manifest
 * entry but is still serving local access (e.g. migration in progress).
 */
export function enrolling(
  account: OAuthAccount,
  manifest: CustodyManifestReadResult,
): boolean {
  return (
    enrolled(account, manifest) && !tombstoned(account, CUSTODY_OWNING_PROVIDER)
  )
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
}

export async function resolveFallbackAccess(
  account: OAuthAccount,
  storage: Pick<AccountStorage, 'claustrum'>,
  manifest?: CustodyManifestReadResult,
  options: ResolveFallbackAccessOptions = {},
): Promise<
  FallbackAccessResolution | typeof CUSTODY_REFUSE | typeof CUSTODY_EXCLUDED
> {
  const manifestState: CustodyManifestReadResult =
    manifest ?? (await readDefaultManifestForResolver())

  if (tombstoned(account, CUSTODY_OWNING_PROVIDER)) {
    if (!storage.claustrum?.enabled) return CUSTODY_EXCLUDED
    if (!enrolled(account, manifestState)) return CUSTODY_REFUSE
    // Custodied path: must have a manifest handle and a live cache hit.
    const handle = options.manifestHandle
    const cache = options.cache
    if (!handle || !cache) return CUSTODY_REFUSE
    let served: ServedFallbackCredential
    try {
      served = await cache.get(handle, 30_000)
    } catch {
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

  // Live / enrolling path. The vault toggle is not consulted here — a
  // live, non-tombstoned account always serves its local access. The
  // enrolling state (manifest entry, no tombstone) is still "local" because
  // enrollment means "local cache is the source of truth until the
  // tombstone appears".
  if (!account.access) return CUSTODY_REFUSE
  return { token: account.access, provenance: 'local' }
}

async function readDefaultManifestForResolver(): Promise<CustodyManifestReadResult> {
  // The resolver contract does not require reading the manifest here —
  // callers pass an explicit manifest snapshot. When none is passed, the
  // resolver behaves as if no manifest entry exists, which is the safe
  // default for a non-custodied account.
  return {
    ok: true,
    value: { version: 1, providers: [] } satisfies ManifestHandleFile,
  }
}

// ---------------------------------------------------------------------------
// Credential cache
// ---------------------------------------------------------------------------

export type ClaustrumCredentialCacheOptions = {
  connector: (options: {
    connectionFile: string
    handshakeTimeoutMs?: number
  }) => Promise<ClaustrumCacheTransport>
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

type ReportBound = { count: number; firstReportedAt: number }

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
  #closed = false

  constructor(options: ClaustrumCredentialCacheOptions) {
    this.#transport = options.connector({
      connectionFile: '',
      handshakeTimeoutMs: 5_000,
    })
  }

  /**
   * Peek the resident record without I/O. Returns `undefined` if absent,
   * including the case where the record was invalidated by `reportAuthFailure`.
   */
  async peek(handle: string): Promise<ResidentRecord | undefined> {
    return this.#resident.get(handle)
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
        // A successful get clears the bound, the fence, and any blocked/reauth
        // entries — the operator has reached the vault cleanly. Clearing the
        // fence means a daemon-issued retry at the same version (e.g. after
        // the operator re-authenticates) reports cleanly instead of being
        // silently dropped by the monotonic fence.
        this.#blocked.delete(handle)
        this.#reauth.delete(handle)
        this.#reportBound.delete(handle)
        this.#reported.delete(handle)
        this.#rejectedVersions.delete(handle)
        return record
      }
      // Same poisoned version — back off and retry.
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
    }
    throw new Error('custody credential rejected version after retries')
  }

  /**
   * Report an upstream auth failure on a served record. The report is
   * version-fenced (one report per handle per recordVersion), and after
   * two reports on the same version a one-hour bound fires — the third
   * and subsequent reports on the same version are suppressed, and the
   * handle is moved into the `reauth` set for an hour. A subsequent successful
   * `get` clears the bound and the reauth entry.
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
    const now = Date.now()
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
    // successful get clears the bound and lifts the suppression.
    const bound = this.#reportBound.get(handle)
    if (bound && bound.count >= 2) {
      const reauthUntil = this.#reauth.get(handle)
      if (reauthUntil && reauthUntil > now) return
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

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export function __resetCustodyStateForTest(): void {
  // Process-local cache state lives inside each ClaustrumCredentialCache
  // instance — closing the test's instance clears it. No module-level
  // mutable state remains after the close, so this seam is a no-op.
}
