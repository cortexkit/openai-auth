import type {
  InsulaQuotaContext,
  InsulaUsageEntry,
  InsulaUsageWindow,
} from '@cortexkit/common-auth/claustrum'
import type {
  AccountQuotaWindow,
  OAuthCredits,
  OAuthQuotaSnapshot,
  OAuthSpendControlReading,
} from './accounts'
import { isRecord } from './util/record'

function windowReading(
  window: InsulaUsageWindow | undefined,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  if (!window) return undefined
  // Insula can publish zero usage while holding a banked quota-reset credit.
  // The account is still exhausted until that credit is actually redeemed.
  const usedPercent = window.rawUsedPercent ?? window.usedPercent
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
    return undefined
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    checkedAt,
    ...(typeof window.resetsAt === 'string' && { resetsAt: window.resetsAt }),
    ...(typeof window.windowMinutes === 'number' &&
      Number.isFinite(window.windowMinutes) &&
      window.windowMinutes > 0 && { windowMinutes: window.windowMinutes }),
  }
}

function amount(value: unknown): number | undefined {
  if (
    !isRecord(value) ||
    typeof value.minor !== 'number' ||
    !Number.isSafeInteger(value.minor) ||
    typeof value.exponent !== 'number' ||
    !Number.isInteger(value.exponent)
  )
    return undefined
  const result = value.minor / 10 ** value.exponent
  return Number.isFinite(result) ? result : undefined
}

function spendReading(
  pool: Record<string, unknown>,
): OAuthSpendControlReading | undefined {
  const limit = amount(pool.total)
  const remaining = amount(pool.remaining)
  if (
    limit === undefined ||
    remaining === undefined ||
    limit < 0 ||
    remaining < 0
  )
    return undefined
  const used = limit - remaining
  const reached = pool.spendable === false
  const usedPercent = limit > 0 ? (used / limit) * 100 : reached ? 100 : 0
  return {
    limit,
    used,
    remaining,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    reached,
    ...(typeof pool.resetsAt === 'string' && { resetsAt: pool.resetsAt }),
    ...(isRecord(pool.total) &&
      typeof pool.total.unit === 'string' && { unit: pool.total.unit }),
  }
}

function creditsReading(
  pool: unknown,
  checkedAt: number,
): OAuthCredits | undefined {
  if (!isRecord(pool)) return undefined
  const balance = amount(pool.remaining)
  return {
    hasCredits: true,
    // Older Insula builds omit unlimited. An absent ceiling alone never
    // proves an unlimited entitlement; use only the explicit provider verdict.
    unlimited: typeof pool.unlimited === 'boolean' ? pool.unlimited : false,
    ...(balance !== undefined && balance >= 0 && { balance }),
    ...(pool.spendable === false && { overageLimitReached: true }),
    checkedAt,
  }
}

/** A legacy balance-less Insula pool cannot contradict an explicit unlimited reading. */
export function preserveInsulaUnlimited<
  T extends OAuthQuotaSnapshot & { insulaCreditsUnlimitedUnstated?: true },
>(snapshot: T, quota: unknown): T {
  if (
    snapshot.insulaCreditsUnlimitedUnstated &&
    snapshot.credits &&
    snapshot.credits.balance === undefined &&
    isRecord(quota) &&
    isRecord(quota.credits) &&
    quota.credits.unlimited === true
  )
    return { ...snapshot, credits: { ...snapshot.credits, unlimited: true } }
  return snapshot
}

/** Convert Codex quota while preserving when insula fetched it, not when the cache was read. */
export function normalizeInsulaCodexQuota(
  entry: InsulaUsageEntry,
  context: InsulaQuotaContext,
):
  | (OAuthQuotaSnapshot & {
      primary: AccountQuotaWindow
      /** Normalization metadata only; never written into a quota observation. */
      insulaCreditsUnlimitedUnstated?: true
    })
  | undefined {
  const primary = windowReading(entry.usage?.primary, context.fetchedAt)
  if (!primary || !Number.isFinite(context.fetchedAt)) return undefined
  const secondary = windowReading(entry.usage?.secondary, context.fetchedAt)
  const pool = Array.isArray(entry.spend)
    ? entry.spend.find(
        (value) => isRecord(value) && value.id === 'individual_limit',
      )
    : undefined
  const spendControl = isRecord(pool) ? spendReading(pool) : undefined
  const creditsPool = Array.isArray(entry.spend)
    ? entry.spend.find((value) => isRecord(value) && value.id === 'credits')
    : undefined
  const credits = creditsReading(creditsPool, context.fetchedAt)
  const available = isRecord(entry.savedResets)
    ? entry.savedResets.availableCount
    : undefined
  return {
    primary,
    ...(credits && { credits }),
    ...(credits &&
      isRecord(creditsPool) &&
      typeof creditsPool.unlimited !== 'boolean' && {
        insulaCreditsUnlimitedUnstated: true as const,
      }),
    ...(secondary && { secondary }),
    ...(typeof available === 'number' &&
      Number.isFinite(available) &&
      available >= 0 && {
        resetCreditsAvailable: available,
      }),
    ...(spendControl && { spendControl }),
    ...(!pool && { spendControlCleared: true }),
  }
}
