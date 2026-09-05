import {
  projectCustodyForSidebar,
  type SidebarAccountCustody,
} from '../sidebar-state.ts'
import {
  ClaustrumClient,
  detectClaustrumConnection,
  getDefaultClaustrumConnectionPath,
} from '../vendor/claustrum-client/index.ts'
import { fallbackRefreshLockName } from './account-paths.ts'
import {
  type AccountStorage,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  isOAuthAccount,
  type loadAccounts,
  type mutateAccounts,
  type OAuthAccount,
  type withAccountStoreTransaction,
} from './accounts.ts'
import {
  ClaustrumCredentialCache,
  type CompleteEnrollmentDeps,
  type CompleteEnrollmentOutcome,
  completeFallbackEnrollment,
  custodied,
  custodyTombstoneKey,
  enrolling,
  enrollPendingReason,
  refreshInert,
  tombstoned,
} from './custody.ts'
import {
  CUSTODY_OWNING_PROVIDER,
  custodyManifestHandles,
  defaultCustodyManifestPath,
  type readCustodyManifest,
} from './custody-manifest.ts'
import {
  evaluateCustodyStartup,
  type VaultCustodyState,
} from './custody-state.ts'
import {
  type CustodyHostAuth,
  custodySlotFingerprint,
  MAIN_REFRESH_LOCK_NAME,
  writeMainCustodyTombstone,
} from './custody-transition.ts'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth.ts'
import type { acquireRefreshFileLock } from './refresh-file-lock.ts'

// ---------------------------------------------------------------------------
// Custody runtime — owns the vendored client, the credential cache, the boot /
// tick loop, and the live custody projection handed to the sidebar writer.
//
// Construction is dependency-injected so the loader and the runtime tests
// share one entry point. Production passes the real vendored client detector /
// connector; tests pass a fake. The runtime never reaches outside the injected
// surface, so a unit test can drive every observable without going through the
// loader.
// ---------------------------------------------------------------------------

type RuntimeLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  debug: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
}

export type CustodyRuntimeOptions = {
  /** Storage snapshot at loader time — used for the boot sweep pass. */
  storage: AccountStorage | null
  configPath: string
  manifestPath?: string
  /** Test seam: the vendored detector. Production passes the real function. */
  detectClaustrumConnection?: typeof detectClaustrumConnection
  /** Test seam: transport factory passed to `ClaustrumCredentialCache`. */
  cacheConnector?: (options: {
    connectionFile: string
    handshakeTimeoutMs?: number
  }) => Promise<ClaustrumCacheTransportLike>
  loadAccounts: typeof loadAccounts
  mutateAccounts: typeof mutateAccounts
  withAccountStoreTransaction: typeof withAccountStoreTransaction
  readCustodyManifest: typeof readCustodyManifest
  acquireRefreshFileLock: typeof acquireRefreshFileLock
  auth?: CustodyHostAuth
  resolveFallbackVaultState?: (input: {
    accountId: string
    handle: string
  }) => Promise<VaultCustodyState>
  now?: () => number
  setIntervalFn?: (
    callback: () => void,
    intervalMs: number,
  ) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
  logger: RuntimeLogger
}

export type ClaustrumCacheTransportLike = {
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

export type CustodyRuntime = {
  /** Run the initial completion sweep. Resolves BEFORE the background refresh is armed. */
  boot(): Promise<void>
  /** Clear the timer and close the cache + transport. Idempotent. */
  dispose(): void
  /** Force one tick pass (used by the timer and tests). */
  runTick(): Promise<void>
  /** Sync projection read for the sidebar writer. */
  getCustodyProjection(
    account: OAuthAccount,
    now: number,
  ): SidebarAccountCustody | undefined
  /** Whether the custody runtime is enabled for this process. */
  isEnabled(): boolean
  /** Cache handle (undefined when custody is disabled). */
  getCache(): ClaustrumCredentialCache | undefined
  /** Transport handle (undefined when custody is disabled). */
  getTransport(): ClaustrumCacheTransportLike | undefined
  /** True if the detection step produced an `available` connection file. */
  wasDetected(): boolean
}

const CUSTODY_TICK_INTERVAL_MS = 5 * 60_000
const CUSTODY_TICK_JITTER_MS = 30_000
const CUSTODY_HANDSHAKE_TIMEOUT_MS = 5_000
// Aggregate-bound warm: the loader races its await against this cap and
// proceeds; the warm itself keeps populating the cache detached.
const CUSTODY_WARM_AWAIT_MS = 100

export function __createCustodyRuntimeForTest(
  options: CustodyRuntimeOptions,
): CustodyRuntime {
  const log = options.logger
  const now = options.now ?? Date.now
  const manifestPath = options.manifestPath ?? defaultCustodyManifestPath()
  const cacheConnector = options.cacheConnector ?? defaultCacheConnector(log)
  const detect = options.detectClaustrumConnection ?? detectClaustrumConnection

  let cache: ClaustrumCredentialCache | undefined
  let transport: ClaustrumCacheTransportLike | undefined
  let detection: Awaited<ReturnType<typeof detect>> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  // Live custody projection per account id. Updated after every sweep pass
  // (boot or tick). A test that probes projection before the first sweep sees
  // no entry — the sidebar omits `custody` for that account.
  const projectionByAccountId = new Map<string, SidebarAccountCustody>()
  const orphanLogKeys = new Set<string>()
  let latestManifest:
    | Awaited<ReturnType<typeof options.readCustodyManifest>>
    | undefined

  const isEnabled = () => detection?.status === 'available'

  const runtime: CustodyRuntime = {
    isEnabled,
    wasDetected: () => detection?.status === 'available',
    getCache: () => cache,
    getTransport: () => transport,
    getCustodyProjection: (account, currentNow) => {
      const cached = projectionByAccountId.get(account.id)
      if (cached) return cached
      // Refresh-inert accounts without a stored projection are projected from
      // the live predicates. The toggle is irrelevant here (refreshInert binds
      // on manifest entry OR tombstone), but the projection still reports the
      // ownership shape.
      return projectFromPredicates(
        account,
        options.storage,
        currentNow,
        cache,
        latestManifest,
      )
    },
    async boot() {
      if (closed) return
      try {
        detection = await detect()
      } catch (error) {
        log.warn('custody detection failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (detection.status !== 'available') {
        if (detection.status === 'malformed') {
          log.warn('custody connection malformed; disabled for this process', {
            reason: detection.reason,
          })
        } else {
          log.info('custody not configured; no client/timer created', {})
        }
        return
      }
      const bootManifest = await options.readCustodyManifest(manifestPath)
      latestManifest = bootManifest
      await runDiscoveryPass(bootManifest)
      if (options.storage?.claustrum?.mode !== 'claustrum') {
        log.info(
          'custody connection available but mode is local; manifest read for the refresh gate, no client/timer',
          {},
        )
        return
      }
      try {
        cache = new ClaustrumCredentialCache({
          connector: cacheConnector,
          now,
        })
        // Eagerly resolve the transport so the first warm is a cache.get, not a
        // handshake. A failure here lands in the catch below; the runtime
        // stays disabled for this process until the next tick reconnects.
        const client = await cacheConnector({
          connectionFile: resolveConnectionPath(detection),
          handshakeTimeoutMs: CUSTODY_HANDSHAKE_TIMEOUT_MS,
        })
        transport = client
      } catch (error) {
        log.warn('custody connect failed; disabled until tick reconnect', {
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      await runFingerprintResumePass()
      await runFallbackInstallPass(bootManifest)
      const currentStorage = await options.loadAccounts(options.configPath)
      const enabledHandles = enabledManifestHandles(
        bootManifest,
        currentStorage,
      )
      const sweepPromises: Promise<void>[] = []
      for (const account of oauthAccounts(currentStorage)) {
        if (
          currentStorage?.claustrum?.transition?.fingerprints.fallbacks[
            account.id
          ]
        )
          continue
        if (
          !enrolling(account, bootManifest, CUSTODY_OWNING_PROVIDER) &&
          !(tombstoned(account, CUSTODY_OWNING_PROVIDER) && !account.accountId)
        )
          continue
        const handle = enabledHandles.get(account.id)
        if (!handle) continue
        const sweepDeps = buildSweepDeps(cache)
        sweepPromises.push(
          completeFallbackEnrollment(account, sweepDeps)
            .then((outcome) =>
              applyOutcomeToProjection(account, outcome, bootManifest),
            )
            .catch((error) =>
              log.warn('custody boot sweep failed', {
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        )
      }
      // The sweep must finish before the loader can arm background refresh;
      // otherwise both paths can contend for an enrolling account's lock.
      await Promise.all(sweepPromises)
      // A cap miss leaves the warm in flight detached; the next tick picks up
      // any cache entry that completes after the bound.
      await raceAggregateWarm(
        enabledHandles,
        cache,
        currentStorage,
        CUSTODY_WARM_AWAIT_MS,
      )
      scheduleNextTick()
    },
    async runTick() {
      if (closed || !cache) return
      if (options.storage?.claustrum?.mode !== 'claustrum') return
      // Re-read manifest (hot-reload on mtime) so an operator edit lands at
      // the next tick without a restart.
      const manifest = await options.readCustodyManifest(manifestPath)
      latestManifest = manifest
      const currentStorage = await runDiscoveryPass(manifest)
      await runFingerprintResumePass()
      await runFallbackInstallPass(manifest)
      const enabledHandles = enabledManifestHandles(manifest, currentStorage)
      // Step 1: completion sweep — every enrolling account under its refresh
      // lock, identity-verified, tombstoned on success. The sweep is the only
      // place a get happens for an enrolling account.
      await runCompletionSweep(manifest, enabledHandles)
      // Step 2: warm / outcome pass — one get per enabled custodied account.
      await runWarmPass(manifest, enabledHandles)
    },
    dispose() {
      if (closed) return
      closed = true
      if (timer) {
        const clear = options.clearIntervalFn ?? clearInterval
        clear(timer)
        timer = undefined
      }
      try {
        cache?.close()
      } catch {}
      try {
        transport?.close()
      } catch {}
      cache = undefined
      transport = undefined
    },
  }

  async function runDiscoveryPass(
    manifest: Awaited<ReturnType<typeof options.readCustodyManifest>>,
  ): Promise<AccountStorage | null> {
    let storage = await options.loadAccounts(options.configPath)
    if (!storage || !manifest.ok) return storage
    for (const [accountId, expectedHandle] of custodyManifestHandles(
      manifest,
    )) {
      if (!storage) break
      if (accountId === 'main') continue
      if (storage.accounts.some((account) => account.id === accountId)) continue
      const cause = storage.claustrum?.rowHistory?.includes(accountId)
        ? 'row removed'
        : 'awaiting discovery'
      const logKey = `${accountId}:${cause}`
      if (!orphanLogKeys.has(logKey)) {
        orphanLogKeys.add(logKey)
        log.info(`orphan-binding: ${cause}`, { accountId })
      }
      if (storage.claustrum?.mode !== 'claustrum') continue
      const lock = await options.acquireRefreshFileLock({
        name: fallbackRefreshLockName(accountId),
        ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
        path: options.configPath,
        renew: true,
      })
      if (!lock) continue
      try {
        const recheckManifest = await options.readCustodyManifest(manifestPath)
        const recheckStorage = await options.loadAccounts(options.configPath)
        if (
          recheckStorage?.claustrum?.mode !== 'claustrum' ||
          !recheckManifest.ok ||
          custodyManifestHandles(recheckManifest).get(accountId) !==
            expectedHandle ||
          recheckStorage.accounts.some((account) => account.id === accountId)
        ) {
          continue
        }
        const sentinel = custodyTombstoneKey(CUSTODY_OWNING_PROVIDER)
        await options.mutateAccounts((current) => {
          if (
            current.claustrum?.mode !== 'claustrum' ||
            current.accounts.some((account) => account.id === accountId)
          ) {
            return current
          }
          return {
            ...current,
            claustrum: {
              ...current.claustrum,
              mode: 'claustrum',
              rowHistory: [
                ...new Set([
                  ...(current.claustrum?.rowHistory ?? []),
                  accountId,
                ]),
              ],
            },
            accounts: [
              ...current.accounts,
              {
                id: accountId,
                type: 'oauth',
                access: '',
                refresh: sentinel,
                expires: 0,
                enabled: true,
              },
            ],
          }
        }, options.configPath)
      } finally {
        await lock.release().catch(() => {})
      }
      storage = await options.loadAccounts(options.configPath)
    }
    return storage
  }

  async function runCompletionSweep(
    manifest: ReturnType<typeof options.readCustodyManifest> extends Promise<
      infer R
    >
      ? R
      : never,
    enabledHandles: Map<string, string>,
  ): Promise<void> {
    if (!cache) return
    const storage = await options.loadAccounts(options.configPath)
    const sweepDeps = buildSweepDeps(cache)
    for (const account of oauthAccounts(storage)) {
      if (storage?.claustrum?.transition?.fingerprints.fallbacks[account.id])
        continue
      if (
        !enrolling(account, manifest, CUSTODY_OWNING_PROVIDER) &&
        !(tombstoned(account, CUSTODY_OWNING_PROVIDER) && !account.accountId)
      )
        continue
      if (!enabledHandles.has(account.id)) continue
      const outcome = await completeFallbackEnrollment(account, sweepDeps)
      applyOutcomeToProjection(account, outcome, manifest)
    }
  }

  async function runFingerprintResumePass(): Promise<void> {
    const initial = await options.loadAccounts(options.configPath)
    const transition = initial?.claustrum?.transition
    if (initial?.claustrum?.mode !== 'claustrum' || !transition) return
    let incomplete = false

    for (const [accountId, expected] of Object.entries(
      transition.fingerprints.fallbacks,
    )) {
      const lock = await options.acquireRefreshFileLock({
        name: fallbackRefreshLockName(accountId),
        ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
        path: options.configPath,
        renew: true,
      })
      if (!lock) {
        incomplete = true
        continue
      }
      try {
        const completed = await options.withAccountStoreTransaction(
          async (transaction) => {
            const current = await transaction.read()
            const account = current.accounts.find(
              (candidate) => candidate.id === accountId,
            )
            if (account?.type === 'oauth' && tombstoned(account, 'openai')) {
              return true
            }
            if (
              !account ||
              !isOAuthAccount(account) ||
              !account.access ||
              custodySlotFingerprint(account.access, account.refresh) !==
                expected
            ) {
              projectionByAccountId.set(accountId, {
                state: 'inert',
                reason: 'new-local-family-under-claustrum',
              })
              return false
            }
            const sentinel = custodyTombstoneKey(CUSTODY_OWNING_PROVIDER)
            const next = structuredClone(current)
            const target = next.accounts.find(
              (candidate) => candidate.id === accountId,
            )
            if (!target || !isOAuthAccount(target)) return false
            target.access = ''
            target.refresh = sentinel
            target.expires = 0
            await transaction.write(next)
            const written = (await transaction.read()).accounts.find(
              (candidate) => candidate.id === accountId,
            )
            return !!(
              written?.type === 'oauth' && tombstoned(written, 'openai')
            )
          },
          options.configPath,
        )
        if (!completed) incomplete = true
      } catch {
        incomplete = true
      } finally {
        await lock.release().catch(() => {})
      }
    }

    if (transition.fingerprints.main) {
      if (!options.auth) {
        incomplete = true
      } else {
        const lock = await options.acquireRefreshFileLock({
          name: MAIN_REFRESH_LOCK_NAME,
          ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
          path: options.configPath,
          renew: true,
        })
        if (!lock) {
          incomplete = true
        } else {
          try {
            const outcome = await writeMainCustodyTombstone(
              transition.fingerprints.main,
              {
                auth: options.auth,
                warn: (message) => log.warn(message, {}),
              },
            )
            if (outcome !== 'tombstoned') incomplete = true
          } finally {
            await lock.release().catch(() => {})
          }
        }
      }
    }

    if (incomplete) return
    await options.withAccountStoreTransaction(async (transaction) => {
      const current = await transaction.read()
      if (
        current.claustrum?.mode !== 'claustrum' ||
        current.claustrum.transition?.manifestRevision !==
          transition.manifestRevision ||
        current.claustrum.transition?.storeGeneration !==
          transition.storeGeneration
      ) {
        return
      }
      await transaction.writeMode('claustrum')
    }, options.configPath)
  }

  async function runFallbackInstallPass(
    manifest: Awaited<ReturnType<typeof options.readCustodyManifest>>,
  ): Promise<void> {
    if (!cache || !manifest.ok) return
    const storage = await options.loadAccounts(options.configPath)
    if (storage?.claustrum?.mode !== 'claustrum') return
    const handles = custodyManifestHandles(manifest)
    for (const account of storage.accounts) {
      if (account.type !== 'oauth' || account.corrupt !== true) continue
      const handle = handles.get(account.id)
      const vault = handle
        ? await resolveFallbackVaultState(account.id, account.accountId, handle)
        : 'no_handle'
      const verdict = evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: handle ? 'present' : 'absent',
        local: 'gone',
        vault: () => vault,
        verifiedInProcessLogin: false,
      })
      if (
        !('installTombstone' in verdict) ||
        !verdict.installTombstone ||
        !handle
      )
        continue
      await installFallbackTombstone(account.id, handle)
    }
  }

  async function resolveFallbackVaultState(
    accountId: string,
    expectedAccountId: string | undefined,
    handle: string,
  ): Promise<VaultCustodyState> {
    if (options.resolveFallbackVaultState) {
      return options.resolveFallbackVaultState({ accountId, handle })
    }
    if (!cache) return 'cold'
    if (cache.isReauth(handle, now())) return 'needs_reauth'
    try {
      const served = await cache.get(handle, custodyMinTtlMs(options.storage), {
        force: true,
      })
      const claims = parseJwtClaims(served.payload.access)
      const servedAccountId = claims
        ? extractAccountIdFromClaims(claims)
        : undefined
      return expectedAccountId && servedAccountId !== expectedAccountId
        ? 'identity_mismatch'
        : servedAccountId
          ? 'serves'
          : 'identity_mismatch'
    } catch {
      return cache.isReauth(handle, now()) ? 'needs_reauth' : 'cold'
    }
  }

  async function installFallbackTombstone(
    accountId: string,
    expectedHandle: string,
  ): Promise<void> {
    const lock = await options.acquireRefreshFileLock({
      name: fallbackRefreshLockName(accountId),
      ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
      path: options.configPath,
      renew: true,
    })
    if (!lock) return
    try {
      const manifest = await options.readCustodyManifest(manifestPath)
      const storage = await options.loadAccounts(options.configPath)
      const target = storage?.accounts.find(
        (account) => account.id === accountId,
      )
      if (
        storage?.claustrum?.mode !== 'claustrum' ||
        !manifest.ok ||
        custodyManifestHandles(manifest).get(accountId) !== expectedHandle ||
        target?.type !== 'oauth' ||
        target.corrupt !== true
      ) {
        return
      }
      const sentinel = custodyTombstoneKey(CUSTODY_OWNING_PROVIDER)
      await options.mutateAccounts((current) => {
        const live = current.accounts.find(
          (account) => account.id === accountId,
        )
        if (live?.type !== 'oauth' || live.corrupt !== true) return current
        const { corrupt: _corrupt, ...metadata } = live
        void _corrupt
        return {
          ...current,
          accounts: current.accounts.map((account) =>
            account.id === accountId
              ? {
                  ...metadata,
                  type: 'oauth',
                  access: '',
                  refresh: sentinel,
                  expires: 0,
                }
              : account,
          ),
        }
      }, options.configPath)
    } finally {
      await lock.release().catch(() => {})
    }
  }

  async function runWarmPass(
    manifest: ReturnType<typeof options.readCustodyManifest> extends Promise<
      infer R
    >
      ? R
      : never,
    enabledHandles: Map<string, string>,
  ): Promise<void> {
    if (!cache) return
    for (const [accountId, handle] of enabledHandles) {
      if (cache.isReauth(handle, now())) continue
      const storage = await options.loadAccounts(options.configPath)
      const account = storage?.accounts.find((a) => a.id === accountId)
      if (!account || !isOAuthAccount(account)) continue
      // The completion sweep above handled `enrolling` accounts. The warm
      // pass targets `custodied` ones only — `enrolling` is not the warm's
      // job, and overwriting the latch with a successful get would render the
      // sidebar as `vault` for an account the operator has not completed.
      if (
        !custodied(account, manifest, options.storage ?? ({} as AccountStorage))
      )
        continue
      try {
        const record = await cache.get(handle)
        // Surface the served recordVersion to the projection so the sidebar
        // carries it through `getCustodyProjection`. A failed `get` leaves
        // the existing projection untouched.
        projectionByAccountId.set(accountId, {
          state: 'vault',
          recordVersion: record.recordVersion,
        })
      } catch {
        // Per-tick error handling is the cache's job (retry / reauth / gone
        // / reduce_and_retry). Nothing to do at this layer.
      }
    }
  }

  function scheduleNextTick(): void {
    if (closed) return
    const setI = options.setIntervalFn ?? setInterval
    const jitter = Math.floor((Math.random() * 2 - 1) * CUSTODY_TICK_JITTER_MS)
    const intervalMs = CUSTODY_TICK_INTERVAL_MS + jitter
    const handle = setI(() => {
      if (closed) return
      void runtime.runTick().catch((error) =>
        log.warn('custody tick failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }, intervalMs)
    timer = handle as ReturnType<typeof setInterval>
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  function buildSweepDeps(
    cacheInstance: ClaustrumCredentialCache,
  ): CompleteEnrollmentDeps {
    return {
      loadAccounts: options.loadAccounts,
      readCustodyManifest: options.readCustodyManifest,
      acquireRefreshFileLock: options.acquireRefreshFileLock,
      configPath: options.configPath,
      manifestPath,
      cache: cacheInstance,
      minTtlMs: custodyMinTtlMs(options.storage),
      mutateAccounts: options.mutateAccounts,
      provider: CUSTODY_OWNING_PROVIDER,
      now,
    }
  }

  function applyOutcomeToProjection(
    account: OAuthAccount,
    outcome: CompleteEnrollmentOutcome,
    manifest: ReturnType<typeof options.readCustodyManifest> extends Promise<
      infer R
    >
      ? R
      : never,
  ): void {
    if (outcome.kind === 'succeeded') {
      projectionByAccountId.set(account.id, {
        state: 'vault',
        recordVersion: outcome.recordVersion,
      })
      return
    }
    if (outcome.kind === 'failed') {
      const map: Record<
        typeof outcome.reason,
        'gone' | 'unavailable' | 'identityMismatch' | 'nullClaim'
      > = {
        gone: 'gone',
        identityMismatch: 'identityMismatch',
        nullClaim: 'nullClaim',
        unavailable: 'unavailable',
      }
      const reason = map[outcome.reason]
      projectionByAccountId.set(account.id, {
        state: 'inert',
        reason:
          reason === 'unavailable'
            ? 'takeover-incomplete/vault-unavailable'
            : 'identity-mismatch',
      })
      // Per-process, per-(account,reason) dedupe at one hour (spec §7.3).
      // First failure emits a warn; subsequent failures within the hour are
      // silent. The next failure past the hour emits again. Never logs the
      // handle or any credential material.
      logSweepFailureOnce(log, account.id, reason, outcome.recordVersion, now())
      return
    }
    // A completed tombstone write changes the row's startup coordinate.
    if (outcome.reason === 'notEnrolling') {
      // A successful tombstone wrote disk; re-read state.
      const refreshNow = now()
      const projection = projectFromPredicates(
        account,
        options.storage,
        refreshNow,
        cache,
        manifest,
      )
      if (projection) projectionByAccountId.set(account.id, projection)
    }
  }

  return runtime
}

const SWEEP_FAILURE_LOG_DEDUPE_WINDOW_MS = 60 * 60_000
// Per-process dedupe map for sweep-failure log lines. Keyed by
// `${accountId}:${reason}`; an entry is created on first failure and
// refreshed when the hour window elapses.
const sweepFailureLogDedupe = new Map<string, number>()

function logSweepFailureOnce(
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void },
  accountId: string,
  reason: 'gone' | 'nullClaim' | 'identityMismatch' | 'unavailable',
  recordVersion: number | undefined,
  nowMs: number,
): void {
  const key = `${accountId}:${reason}`
  const last = sweepFailureLogDedupe.get(key)
  if (last !== undefined && nowMs - last < SWEEP_FAILURE_LOG_DEDUPE_WINDOW_MS) {
    return
  }
  sweepFailureLogDedupe.set(key, nowMs)
  logger.warn('custody enroll-completion sweep failed', {
    accountId,
    reason,
    ...(typeof recordVersion === 'number' ? { recordVersion } : {}),
  })
}

// Test-only dedupe reset; not part of the production surface.
export function __resetSweepFailureLogDedupeForTest(): void {
  sweepFailureLogDedupe.clear()
}

export function custodyMinTtlMs(storage: AccountStorage | null): number {
  const minutes = storage?.refresh?.refreshBeforeExpiryMinutes ?? 240
  // refreshBeforeExpiryMinutes + 30 min — keeps the cache ahead of the
  // refresh gate's pre-expiry window without over-fetching.
  return (minutes + 30) * 60_000
}

function enabledManifestHandles(
  manifest: ReturnType<typeof readCustodyManifest> extends Promise<infer R>
    ? R
    : never,
  storage: AccountStorage | null,
): Map<string, string> {
  const result = new Map<string, string>()
  for (const [label, handle] of custodyManifestHandles(manifest)) {
    const account = storage?.accounts.find((a) => a.id === label)
    if (account?.type !== 'oauth') continue
    // enabled here = `refreshInert` (toggle-independent). The resolver and
    // quota path consult this same predicate; the tick's reach matches.
    if (!refreshInert(account, manifest, CUSTODY_OWNING_PROVIDER)) continue
    result.set(label, handle)
  }
  return result
}

function projectFromPredicates(
  account: OAuthAccount,
  storage: AccountStorage | null,
  currentNow: number,
  cacheInstance: ClaustrumCredentialCache | undefined,
  manifest: Awaited<ReturnType<typeof readCustodyManifest>> | undefined,
): SidebarAccountCustody | undefined {
  const safeStorage = storage ?? ({} as AccountStorage)
  const handle = manifest
    ? custodyManifestHandles(manifest).get(account.id)
    : undefined
  if (
    !enrollPendingReason(account.id) &&
    !tombstoned(account, CUSTODY_OWNING_PROVIDER) &&
    !handle
  ) {
    return undefined
  }
  return projectCustodyForSidebar({
    tombstoned: tombstoned(account, CUSTODY_OWNING_PROVIDER),
    storageEnabled: safeStorage.claustrum?.enabled === true,
    enrolled: handle !== undefined,
    handle,
    enrollPendingReason: enrollPendingReason(account.id),
    cache: cacheInstance,
    now: currentNow,
  })
}

async function raceAggregateWarm(
  handles: Map<string, string>,
  cacheInstance: ClaustrumCredentialCache,
  storage: AccountStorage | null,
  capMs: number,
  extraPromises: Promise<void>[] = [],
): Promise<void> {
  void storage
  if (handles.size === 0 && extraPromises.length === 0) return
  const promises: Promise<void>[] = [...extraPromises]
  for (const [, handle] of handles) {
    promises.push(
      cacheInstance
        .get(handle)
        .then(() => undefined)
        .catch(() => {
          // Slow warm does not delay the loader beyond the bound. The promise
          // stays in flight detached; the next tick picks up the populated cache.
        }),
    )
  }
  await Promise.race([
    Promise.all(promises),
    new Promise<void>((resolve) => setTimeout(resolve, capMs)),
  ])
}

function oauthAccounts(storage: AccountStorage | null): OAuthAccount[] {
  if (!storage) return []
  return storage.accounts.filter(isOAuthAccount)
}

function defaultCacheConnector(log: RuntimeLogger) {
  return async (options: {
    connectionFile: string
    handshakeTimeoutMs?: number
  }): Promise<ClaustrumCacheTransportLike> => {
    const client = await ClaustrumClient.connect({
      connectionFile: options.connectionFile,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    })
    return clientToTransport(client, log)
  }
}

function clientToTransport(
  client: ClaustrumClient,
  _log: RuntimeLogger,
): ClaustrumCacheTransportLike {
  return {
    getCredential: (handle, minTtlMs) => client.getCredential(handle, minTtlMs),
    statusCredential: (handle) => client.statusCredential(handle),
    reportAuthFailure: (params) =>
      client.reportAuthFailure({
        handle: params.handle,
        providerStatus: params.providerStatus,
        recordVersion: params.recordVersion,
        reporterSource: params.reporterSource,
      }),
    close: () => client.close(),
  }
}

function resolveConnectionPath(
  detection: Awaited<ReturnType<typeof detectClaustrumConnection>>,
): string {
  if (detection.status !== 'available') return detection.path ?? ''
  // The detection step resolves the path internally; reach for the default
  // helper to hand the same path back to the cache. `available` does not
  // carry the resolved path on its surface (only `absent` / `malformed` do).
  return getDefaultClaustrumConnectionPath()
}
