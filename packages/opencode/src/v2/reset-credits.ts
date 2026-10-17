// The host dependencies the shared Reset credits section needs on OpenCode 2:
// which account a credit is spent on, the quota re-check after a spend, and
// the quota and rate-limit view the section judges eligibility and the
// result with. Everything here reads the account pool only.
//
// OpenCode 1's resolver falls back to its own login slot (`auth.json`, read
// through the host's `auth.get`) when the pool has no row for the account.
// OpenCode 2 never does: a pool miss is refused as an unknown account, and
// neither the resolver nor the quota re-check reads OpenCode 1's `auth.json`
// or OpenCode 2's own credential table.

import type { PoolRow } from '@cortexkit/common-auth/store'
import type {
  ResetCreditsDeps,
  ResetTargetIdentity,
} from '@cortexkit/openai-auth-core'
import {
  type AccountStorage,
  type OAuthQuotaSnapshot,
  type QuotaEntry,
  type RefreshAllQuotaResult,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolAccountSource } from '../core/pool-account-source'
import {
  observationFromSnapshot,
  windowsFromQuotaMap,
} from '../core/pool-quota'
import { poolResetTarget, ResetTargetResolutionError } from '../index'

/** The parts of the pool source the reset dependencies use. */
export type ResetPoolAccess = Pick<
  PoolAccountSource,
  'rowAccess' | 'pollRows' | 'peek' | 'rateLimitMarks'
>

/** One quota poll's request, as the pool source hands it to `pullQuota`. */
type PullRequest = Parameters<
  ConstructorParameters<typeof PoolAccountSource>[0]['pullQuota']
>[0]

/**
 * The applicable reset-credit count (`resetCreditsApplicable`) of each row's
 * latest usage poll. The pool's quota map keeps only the available count, so
 * this in-memory record holds the other one for the reset section's result
 * line. A count belongs to the credential it was polled with: once the row's
 * credential is replaced (another login) the recorded count no longer applies.
 */
export class ResetCreditCounts {
  private readonly counts = new Map<
    string,
    {
      credentialEpoch: number | undefined
      identity: string | undefined
      applicable: number | undefined
    }
  >()

  /** Records the count a poll of `request.id` returned; a poll without one clears it. */
  record(
    request: Pick<PullRequest, 'id' | 'credentialEpoch' | 'identity'>,
    snapshot: Pick<OAuthQuotaSnapshot, 'resetCreditsApplicable'>,
  ): void {
    const applicable = snapshot.resetCreditsApplicable
    this.counts.set(request.id, {
      credentialEpoch: request.credentialEpoch,
      identity: request.identity,
      applicable:
        typeof applicable === 'number' && Number.isFinite(applicable)
          ? applicable
          : undefined,
    })
  }

  /** The count recorded for the row's current credential, if its last poll carried one. */
  applicable(
    row: Pick<PoolRow, 'id' | 'credentialEpoch' | 'identity'>,
  ): number | undefined {
    const entry = this.counts.get(row.id)
    if (
      !entry ||
      entry.credentialEpoch !== row.credentialEpoch ||
      entry.identity !== row.identity
    )
      return undefined
    return entry.applicable
  }
}

/**
 * The pool source's quota poll: one `wham/usage` read with the row's bearer,
 * turned into the observation the pool merges into the row's quota map. The
 * reading's time is `now()`, and the applicable credit count goes to `counts`.
 */
export function createPoolQuotaPull(deps: {
  fetchImpl: typeof fetch
  now: () => number
  counts: ResetCreditCounts
  logger?: Parameters<typeof whamUsageFn>[0]['logger']
}) {
  return async (request: PullRequest) => {
    const credential = request.credential
    if (credential.type !== 'oauth' || !credential.access)
      throw new Error('the row holds no access token to poll with')
    const snapshot = await whamUsageFn({
      accessToken: credential.access,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      ...(request.identity ? { accountId: request.identity } : {}),
      accountKey: request.id,
      ...(deps.logger ? { logger: deps.logger } : {}),
    })
    deps.counts.record(request, snapshot)
    return observationFromSnapshot(snapshot, deps.now(), true)
  }
}

export interface PoolResetDepsOptions {
  source: ResetPoolAccess
  /** The account settings, read fresh for each call (refresh window, backoff). */
  storage: () => Promise<AccountStorage | null>
  counts: ResetCreditCounts
  now: () => number
  /** The enrollment read; no local account is polled while it is not `local`. */
  authority?: () => Promise<'vault' | 'local' | 'unreadable'>
}

export type PoolResetDeps = Pick<
  ResetCreditsDeps,
  'resolveResetTarget' | 'refreshResetTargetQuota' | 'quotaManager'
>

/**
 * The Reset credits section's account, quota re-check and quota view over the
 * account pool.
 */
export function createPoolResetDeps(
  options: PoolResetDepsOptions,
): PoolResetDeps {
  const { source, counts, now } = options

  const resolveResetTarget = async (
    accountKey: string,
  ): Promise<ResetTargetIdentity> => {
    // `rowAccess` refreshes a due or expired token through the pool and
    // re-reads the row before taking its bearer, so a row whose token ran out
    // but can be refreshed resolves with the fresh one.
    const access = await source.rowAccess(accountKey, await options.storage())
    // Undefined: the install has not moved into the pool. No row: the pool
    // has no account with this key. Either way nothing else is consulted.
    if (!access?.row)
      throw new ResetTargetResolutionError(
        'unknown_account',
        `${accountKey === 'main' ? 'Main' : 'Fallback'} account ${accountKey} was not found.`,
      )
    // Disabled, non-OAuth and tokenless rows are refused with the same codes
    // and messages as OpenCode 1's resolver gives for pool rows (the shared
    // `poolResetTarget`); the ChatGPT identity is the row's, else the token's.
    return poolResetTarget(accountKey, access)
  }

  const refreshResetTargetQuota = async (
    accountKey: string,
  ): Promise<RefreshAllQuotaResult> => {
    if (options.authority && (await options.authority()) !== 'local')
      return {
        account: accountKey,
        ok: false,
        error:
          'local accounts are not polled while this host is connected to the vault',
      }
    const [result] = await source.pollRows(await options.storage(), {
      ids: [accountKey],
    })
    if (!result)
      return {
        account: accountKey,
        ok: false,
        error: 'targeted quota refresh returned no result',
      }
    return {
      account: result.id,
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }

  const rowFor = (accountKey: string) =>
    source.peek().rows.find((row) => row.id === accountKey)

  /**
   * The row's saved quota in the shape the shared reset section reads: the
   * primary and secondary windows from the row's quota map, plus the
   * applicable credit count of its last poll when that poll carried one.
   */
  const entryFor = (accountKey: string): QuotaEntry | null => {
    const row = rowFor(accountKey)
    if (!row) return null
    const windows = windowsFromQuotaMap(row.quota) ?? {}
    const applicable = counts.applicable(row)
    const checkedAt = Math.max(
      0,
      ...[windows.primary?.checkedAt, windows.secondary?.checkedAt].filter(
        (value): value is number => typeof value === 'number',
      ),
    )
    return {
      quota: {
        ...windows,
        ...(applicable !== undefined
          ? { resetCreditsApplicable: applicable }
          : {}),
      },
      checkedAt,
      // The section never schedules a poll from this entry; it re-checks on
      // demand through `refreshResetTargetQuota`.
      refreshAfter: checkedAt,
      ...(row.identity !== undefined ? { accountId: row.identity } : {}),
    }
  }

  const quotaManager: ResetCreditsDeps['quotaManager'] = {
    // True while the request path's rate-limit mark on the row's account
    // runs past now. Only pool marks: vault mode refuses reset actions before
    // any of this is read.
    isRateLimited: (accountKey) => {
      const row = rowFor(accountKey)
      if (!row) return false
      const until = source.rateLimitMarks([row]).get(row.id)
      return until !== undefined && until > now()
    },
    getMain: () => entryFor('main'),
    getFallback: (accountKey) => entryFor(accountKey),
  }

  return { resolveResetTarget, refreshResetTargetQuota, quotaManager }
}
