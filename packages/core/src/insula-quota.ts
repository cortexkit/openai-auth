import type {
  InsulaQuotaContext,
  InsulaUsageEntry,
  InsulaUsageWindow,
} from '@cortexkit/common-auth/claustrum'
import type {
  AccountQuotaWindow,
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

/** Convert Codex quota while preserving when insula fetched it, not when the cache was read. */
export function normalizeInsulaCodexQuota(
  entry: InsulaUsageEntry,
  context: InsulaQuotaContext,
): (OAuthQuotaSnapshot & { primary: AccountQuotaWindow }) | undefined {
  const primary = windowReading(entry.usage?.primary, context.fetchedAt)
  if (!primary || !Number.isFinite(context.fetchedAt)) return undefined
  const secondary = windowReading(entry.usage?.secondary, context.fetchedAt)
  const pool = Array.isArray(entry.spend)
    ? entry.spend.find(
        (value) => isRecord(value) && value.id === 'individual_limit',
      )
    : undefined
  const spendControl = isRecord(pool) ? spendReading(pool) : undefined
  const available = isRecord(entry.savedResets)
    ? entry.savedResets.availableCount
    : undefined
  return {
    primary,
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
