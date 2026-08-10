import {
  type AccountQuota,
  getPresentQuotaWindows,
  type QuotaWindow,
  type QuotaWindowKey,
} from '../sidebar-state'

export const QUOTA_STALENESS_MS = 15 * 60_000
export const MIN_RESET_HOURS = 1 / 60
export const MIN_WEIGHT = 1e-6

// Both primary and secondary windows are consulted, then the snapshot-level
// timestamp, then the cache entry's timestamp. An account whose only fresh
// window is the secondary must not be judged on the older primary stamp — the
// admission path in particular relies on this to avoid staling out a snapshot
// the wire just refreshed against a tighter window.
export function snapshotCheckedAt(
  quota: AccountQuota | null | undefined,
  entryCheckedAt?: number,
): number | undefined {
  for (const checkedAt of [
    quota?.primary?.checkedAt,
    quota?.secondary?.checkedAt,
    quota?.checkedAt,
    entryCheckedAt,
  ]) {
    if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
      return checkedAt
    }
  }
  return undefined
}

export type StickyBreakDecision =
  | { action: 'retain'; reason: 'unknown' | 'stale' | 'healthy' | 'transient' }
  | {
      action: 'migrate'
      reason: 'exhausted' | 'permanent' | 'killswitch'
      windowKey?: QuotaWindowKey
      resetsAt?: string
    }

export function decideStickyBreak(input: {
  quota: AccountQuota | null | undefined
  quotaCheckedAt?: number
  status?: number
  now: number
  killswitchPasses?: boolean
}): StickyBreakDecision {
  if (input.status === 401 || input.status === 403) {
    return { action: 'migrate', reason: 'permanent' }
  }
  if (!input.quota) return { action: 'retain', reason: 'unknown' }

  const checkedAt = snapshotCheckedAt(input.quota, input.quotaCheckedAt)
  if (
    checkedAt === undefined ||
    !Number.isFinite(checkedAt) ||
    input.now - checkedAt > QUOTA_STALENESS_MS
  ) {
    return { action: 'retain', reason: 'stale' }
  }

  // Placed AFTER the stale check so a stale snapshot never judges the account
  // on a snap the killswitch would consider below floor. The caller is expected
  // to pre-resolve the killswitch result using the non-invalidating policy peek
  // so a routine token refresh does not flip a killed account to "unknown".
  if (input.killswitchPasses === false) {
    return { action: 'migrate', reason: 'killswitch' }
  }

  const windows = getPresentQuotaWindows(input.quota).sort((left, right) => {
    const leftWindowMs = left.windowMs
    const rightWindowMs = right.windowMs
    const leftKnown =
      typeof leftWindowMs === 'number' && Number.isFinite(leftWindowMs)
    const rightKnown =
      typeof rightWindowMs === 'number' && Number.isFinite(rightWindowMs)
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
    if (leftKnown && rightKnown) return rightWindowMs - leftWindowMs
    return 0
  })
  for (const { key, window } of windows) {
    if (
      Number.isFinite(window.remainingPercent) &&
      window.remainingPercent <= 0
    ) {
      return {
        action: 'migrate',
        reason: 'exhausted',
        windowKey: key,
        ...(typeof window.resetsAt === 'string'
          ? { resetsAt: window.resetsAt }
          : {}),
      }
    }
  }

  if (
    input.status === undefined ||
    input.status === 0 ||
    !Number.isFinite(input.status) ||
    (input.status >= 500 && input.status <= 599) ||
    input.status === 429
  ) {
    return { action: 'retain', reason: 'transient' }
  }
  return { action: 'retain', reason: 'healthy' }
}

export function sustainableWindowWeight(
  window: Pick<QuotaWindow, 'remainingPercent' | 'resetsAt'>,
  reservePercent: number,
  now: number,
): number {
  const spendable = Math.max(0, window.remainingPercent - reservePercent)
  if (spendable <= 0) return 0
  if (!window.resetsAt) return spendable
  const resetMs = Date.parse(window.resetsAt)
  // A lapsed reset can't yield a meaningful spend rate: the elapsed-hours divisor
  // would clamp to MIN_RESET_HOURS and inflate the weight ~60x, favoring an account
  // whose window has already rolled over on stale information. Fall back to the
  // un-rate-adjusted spendable capacity instead.
  if (!Number.isFinite(resetMs) || resetMs <= now) return spendable
  const hours = Math.max((resetMs - now) / 3_600_000, MIN_RESET_HOURS)
  return spendable / hours
}

export interface StickySelectionCandidate {
  accountId: string
  quota: AccountQuota | null | undefined
  quotaCheckedAt?: number
  reservePercent: Record<QuotaWindowKey, number>
  configuredOrder: number
  resetCreditsApplicable?: number
  // Opt-in killswitch gate. When `false`, the candidate is excluded from both
  // weighted placement AND the mode-fallback fail-open branch. Undefined or
  // `true` is a no-op — the dominant path with killswitch disabled is
  // byte-identical to the pre-killswitch behaviour.
  killswitchPasses?: boolean
}

export interface StickySelectionInput {
  candidates: readonly StickySelectionCandidate[]
  pendingBytes: ReadonlyMap<string, number>
  requestBytes: number
  now: number
  onEmptyWeightedSet?: () => void
}

type WeightedCandidate = {
  candidate: StickySelectionCandidate
  quotaCheckedAt: number
  weight: number
}

function compareAccountIds(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function candidateWeight(
  candidate: StickySelectionCandidate,
  now: number,
): WeightedCandidate | undefined {
  if (!candidate.quota) return undefined
  const quotaCheckedAt = snapshotCheckedAt(
    candidate.quota,
    candidate.quotaCheckedAt,
  )
  if (
    quotaCheckedAt === undefined ||
    now - quotaCheckedAt > QUOTA_STALENESS_MS
  ) {
    return undefined
  }
  const weights = getPresentQuotaWindows(candidate.quota).map(
    ({ key, window }) => {
      // Missing reserve data must leave the window usable rather than silently excluding its account.
      return sustainableWindowWeight(
        window,
        candidate.reservePercent[key] ?? 0,
        now,
      )
    },
  )
  const weight = weights.length > 0 ? Math.min(...weights) : 0
  return weight > 0 ? { candidate, quotaCheckedAt, weight } : undefined
}

export function selectStickyCandidate(input: StickySelectionInput):
  | {
      accountId: string
      quotaCheckedAt?: number
      source: 'weighted' | 'mode-fallback'
    }
  | undefined {
  // Killswitch filter: a candidate whose stored killswitch result is `false`
  // is excluded from BOTH weighted placement and the mode-fallback fail-open
  // branch. The branch must never become a way to spend on a killed account.
  // Undefined / `true` is a no-op so the killswitch-disabled path is
  // byte-identical to the pre-killswitch behaviour.
  const eligibleCandidates = input.candidates.filter(
    (candidate) => candidate.killswitchPasses !== false,
  )

  // Empty input is a programmer error — preserve the existing throw.
  // Every candidate killed by the killswitch filter is a routable state: the
  // caller is expected to hand the same `killswitchBlockedResponse` the
  // ordered modes produce rather than letting the resolver fall through.
  if (input.candidates.length === 0) {
    throw new Error(
      'Cannot select a sticky candidate: input.candidates is empty',
    )
  }
  if (eligibleCandidates.length === 0) {
    return undefined
  }

  const weighted = eligibleCandidates
    .map((candidate) => candidateWeight(candidate, input.now))
    .filter(
      (candidate): candidate is WeightedCandidate => candidate !== undefined,
    )

  if (weighted.length > 0) {
    weighted.sort((left, right) => {
      // MIN_WEIGHT only guards this division after the weight > 0 eligibility filter; it is not a tuning parameter.
      const leftScore =
        ((input.pendingBytes.get(left.candidate.accountId) ?? 0) +
          input.requestBytes) /
        Math.max(left.weight, MIN_WEIGHT)
      const rightScore =
        ((input.pendingBytes.get(right.candidate.accountId) ?? 0) +
          input.requestBytes) /
        Math.max(right.weight, MIN_WEIGHT)
      return (
        leftScore - rightScore ||
        left.candidate.configuredOrder - right.candidate.configuredOrder ||
        compareAccountIds(left.candidate.accountId, right.candidate.accountId)
      )
    })
    const selected = weighted[0]
    if (selected) {
      return {
        accountId: selected.candidate.accountId,
        quotaCheckedAt: selected.quotaCheckedAt,
        source: 'weighted',
      }
    }
  }

  input.onEmptyWeightedSet?.()
  const fallback = [...eligibleCandidates].sort((left, right) => {
    const leftHasCredits = (left.resetCreditsApplicable ?? 0) > 0 ? 1 : 0
    const rightHasCredits = (right.resetCreditsApplicable ?? 0) > 0 ? 1 : 0
    return (
      rightHasCredits - leftHasCredits ||
      left.configuredOrder - right.configuredOrder ||
      compareAccountIds(left.accountId, right.accountId)
    )
  })[0]
  if (!fallback) {
    throw new Error(
      'Cannot select a sticky candidate: input.candidates is empty',
    )
  }
  return {
    accountId: fallback.accountId,
    quotaCheckedAt: snapshotCheckedAt(fallback.quota, fallback.quotaCheckedAt),
    source: 'mode-fallback',
  }
}
