// Host-neutral state operations for the two pool readers. Hosts retain their
// own snapshots, refresh scheduling, store writes and vault authority checks.

import { statSync } from 'node:fs'
import {
  mergeQuotaObservation,
  type QuotaObservation,
} from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  buildRefreshOperationError,
  hashRefreshToken,
  isTransientRefreshError,
} from './backoff'

const LOCAL_REFRESH_RETRY_MS = 30_000
const PENDING_OBSERVATIONS_PER_ROW = 8
const PENDING_OBSERVATION_MAX_AGE_MS = 30 * 60_000

export type PoolRefreshBackoff = {
  nextRetryAt: number
  tokenHash: string
  retryCount: number
}

export type PoolPendingObservation = {
  credentialEpoch: number | undefined
  identity: string | undefined
  observation: QuotaObservation
}

/** Partitions account state by wire identity, falling back to the row id. */
export function poolAccountKey(row: Pick<PoolRow, 'id' | 'identity'>): string {
  return row.identity ? `identity:${row.identity}` : `row:${row.id}`
}

export function poolFileKey(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return '-'
  }
}

export function poolOAuthAccess(
  row: PoolRow,
):
  | { access: string; expires: number | undefined; refresh: string }
  | undefined {
  const credential = row.credential
  if (credential?.type !== 'oauth') return undefined
  return {
    access: credential.access ?? '',
    expires: credential.expires,
    refresh: credential.refresh,
  }
}

export function mergePoolObservation(
  stored: unknown,
  observation: QuotaObservation,
): unknown {
  try {
    return mergeQuotaObservation(stored, observation)
  } catch {
    return stored
  }
}

/** Keeps observations visible while their asynchronous store writes catch up. */
export function rememberPoolObservation(
  pending: Map<string, PoolPendingObservation[]>,
  row: PoolRow,
  observation: QuotaObservation,
): void {
  const key = poolAccountKey(row)
  pending.set(
    key,
    [
      ...(pending.get(key) ?? []),
      {
        credentialEpoch: row.credentialEpoch,
        identity: row.identity,
        observation,
      },
    ].slice(-PENDING_OBSERVATIONS_PER_ROW),
  )
}

/** Never carries a pending reading onto a replaced credential or identity. */
export function applyPendingPoolObservations(
  row: PoolRow,
  pending: ReadonlyMap<string, readonly PoolPendingObservation[]>,
  now: number,
): PoolRow {
  let next = row
  for (const entry of pending.get(poolAccountKey(row)) ?? []) {
    if (
      !(now - entry.observation.checkedAt <= PENDING_OBSERVATION_MAX_AGE_MS) ||
      entry.credentialEpoch !== row.credentialEpoch ||
      entry.identity !== row.identity
    )
      continue
    next = {
      ...next,
      quota: mergePoolObservation(next.quota, entry.observation),
    }
  }
  return next
}

/**
 * Provider/network failures use the OAuth backoff policy. Local lock failures
 * retry soon: a day-long provider backoff would strand a healthy account.
 */
export function nextPoolRefreshBackoff(
  refreshToken: string,
  error: unknown,
  now: number,
  previous: PoolRefreshBackoff | undefined,
): PoolRefreshBackoff {
  const tokenHash = hashRefreshToken(refreshToken)
  const fromProvider =
    typeof (error as { status?: unknown } | null)?.status === 'number' ||
    isTransientRefreshError(error)
  if (fromProvider) {
    const built = buildRefreshOperationError({
      error,
      now,
      refreshToken,
      ...(previous
        ? {
            previous: {
              message: '',
              checkedAt: now,
              nextRetryAt: previous.nextRetryAt,
              retryCount: previous.retryCount,
              tokenHash: previous.tokenHash,
            },
          }
        : {}),
    })
    return {
      nextRetryAt: built.nextRetryAt,
      tokenHash,
      retryCount: built.retryCount,
    }
  }
  return {
    nextRetryAt: now + LOCAL_REFRESH_RETRY_MS,
    tokenHash,
    retryCount: previous?.tokenHash === tokenHash ? previous.retryCount : 0,
  }
}

/** Retry times for rows without a usable token; token usability stays host-specific. */
export function poolRefreshBackoffFor(
  rows: readonly PoolRow[],
  backoff: ReadonlyMap<string, PoolRefreshBackoff>,
  now: number,
  usableToken: (row: PoolRow, now: number) => string | undefined,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) {
    if (usableToken(row, now)) continue
    const own = backoff.get(row.id)
    out.set(
      row.id,
      own && own.nextRetryAt > now
        ? own.nextRetryAt
        : now + LOCAL_REFRESH_RETRY_MS,
    )
  }
  return out
}
