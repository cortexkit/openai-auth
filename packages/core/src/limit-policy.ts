import {
  type AccountKey,
  decideAfterLimit,
  type HoldFacts,
  type LimitAxes,
  type LimitCandidate,
  type LimitDecision,
  type LimitSignal,
  type LimitWindow,
  type PolicyFacts,
  type SessionActivity,
  sameAccount,
  sameAccountHoldFacts,
  windowRouter,
} from '@cortexkit/common-auth/limits'
import { getFallbackStatuses, type OAuthQuotaSnapshot } from './accounts'
import { isRecord } from './util/record'

export const QUOTA_STALENESS_MS = 15 * 60_000

/** Expand the preset without changing the shared baseline used by other adopters. */
export function openAiLimitAxes(fallbackOn?: readonly number[]): LimitAxes {
  return {
    ...windowRouter,
    shortLimit: {
      ...windowRouter.shortLimit,
      holdBound: 'cache-ttl',
      preference: 'same-account-first',
      jitter: 'none',
    },
    advance: {
      ...windowRouter.advance,
      opencode1: {
        ...windowRouter.advance.opencode1,
        statuses: fallbackOn?.length ? [...fallbackOn] : [401, 403, 429],
      },
      pi: {
        ...windowRouter.advance.pi,
        statuses: fallbackOn?.length ? [...fallbackOn] : [401, 403, 429],
      },
    },
    terminalMetadata: 'setting-capped-fresh',
  }
}

export function freshQuotaEvidence(checkedAt: number, now: number): boolean {
  return (
    Number.isFinite(checkedAt) &&
    checkedAt <= now &&
    now - checkedAt <= QUOTA_STALENESS_MS
  )
}

export function quotaResetAt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const reset = Date.parse(value)
  return Number.isFinite(reset) ? reset : undefined
}

export function confirmedQuotaWindows(
  reading: OAuthQuotaSnapshot | undefined,
  now: number,
): LimitWindow[] {
  return (['primary', 'secondary'] as const).flatMap((name) => {
    const window = reading?.[name]
    if (
      !window ||
      !freshQuotaEvidence(window.checkedAt, now) ||
      !Number.isFinite(window.usedPercent) ||
      !(window.usedPercent >= 100)
    )
      return []
    return [
      {
        window: name,
        confirmed: true,
        confirmedByReading: true,
        resetAt: quotaResetAt(window.resetsAt),
        observedAt: window.checkedAt,
        provenance: 'reading',
      },
    ]
  })
}

export interface ParsedOpenAiLimit {
  window: string
  resetAt?: number
}

/** Only named failed frames and usage_limit_reached prove exhaustion. */
export function openAiSignalWindows(
  parsed: ParsedOpenAiLimit,
  observedAt: number,
  reading: OAuthQuotaSnapshot | undefined,
  now: number,
): LimitWindow[] {
  const named = parsed.window === 'primary' || parsed.window === 'secondary'
  const window = named
    ? reading?.[parsed.window as 'primary' | 'secondary']
    : undefined
  const fresh = window && freshQuotaEvidence(window.checkedAt, now)
  const usage = parsed.window === 'usage_limit_reached'
  const providerReset =
    usage &&
    parsed.resetAt !== undefined &&
    Number.isFinite(parsed.resetAt) &&
    parsed.resetAt > 0
  return [
    {
      window: named ? parsed.window : usage ? 'usage' : parsed.window,
      confirmed: named || usage,
      confirmedByReading: false,
      resetAt: named
        ? fresh
          ? quotaResetAt(window.resetsAt)
          : undefined
        : providerReset
          ? parsed.resetAt
          : undefined,
      observedAt: named && fresh ? window.checkedAt : observedAt,
      provenance:
        named && fresh ? 'reading' : providerReset ? 'provider' : 'unproven',
    },
  ]
}

/** Classify cloned provider data before Pi exposes any response events to the user. */
export function classifyOpenAiLimitBody(input: {
  account: AccountKey
  status?: number
  headers?: Headers
  body: unknown
  now: number
  reading?: OAuthQuotaSnapshot
}): LimitSignal | undefined {
  let body = input.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = undefined
    }
  }
  const root = isRecord(body) ? body : {}
  const failed =
    root.type === 'response.failed' && isRecord(root.response)
      ? root.response
      : undefined
  const detail = isRecord(failed?.error)
    ? failed.error
    : isRecord(root.error)
      ? root.error
      : root
  const label = isRecord(failed?.failed)
    ? failed.failed.rate_limit_reached_type
    : undefined
  const type = typeof detail.type === 'string' ? detail.type : undefined
  const code = typeof detail.code === 'string' ? detail.code : undefined
  const reason =
    typeof label === 'string' ? label : failed ? (code ?? type) : (type ?? code)
  const status =
    input.status ??
    (typeof root.status === 'number'
      ? root.status
      : typeof root.status_code === 'number'
        ? root.status_code
        : undefined)
  if (reason !== 'usage_limit_reached' && !failed && status !== 429)
    return undefined
  if (failed && !reason) return undefined
  if (
    failed &&
    reason !== 'primary' &&
    reason !== 'secondary' &&
    reason !== 'usage_limit_reached' &&
    reason !== 'rate_limit_exceeded'
  )
    return undefined
  const absolute = detail.resets_at
  const relative = detail.resets_in_seconds
  const resetAt =
    typeof absolute === 'number' && Number.isFinite(absolute) && absolute > 0
      ? absolute * 1000
      : typeof relative === 'number' &&
          Number.isFinite(relative) &&
          relative > 0
        ? input.now + relative * 1000
        : undefined
  const confirms = failed || type === 'usage_limit_reached'
  const windows = confirms
    ? openAiSignalWindows(
        {
          window: reason ?? 'rate_limit',
          resetAt: failed ? undefined : resetAt,
        },
        input.now,
        input.reading,
        input.now,
      )
    : [
        {
          window: reason ?? 'rate_limit',
          confirmed: false,
          confirmedByReading: false,
          observedAt: input.now,
          provenance: 'unproven',
        },
      ]
  const hint = input.headers?.get('retry-after')
  const seconds = hint?.trim() ? Number(hint) : NaN
  return {
    account: input.account,
    kind: windows.some((window) => window.confirmed)
      ? 'quota-exhausted'
      : 'rate-limit',
    reason: reason ?? 'rate_limit',
    status,
    scope: { kind: 'pool' },
    windows,
    observedAt: input.now,
    ...(Number.isFinite(seconds) && seconds >= 0
      ? { retryAfterMs: seconds * 1000, retryAfterSource: 'retry-after' }
      : {}),
  }
}

/** Merge current response evidence with every fresh exhausted sibling window. */
export function openAiConfirmedBlockers(
  signal: LimitSignal | undefined,
  reading: OAuthQuotaSnapshot | undefined,
  now: number,
): LimitWindow[] {
  const windows = new Map(
    confirmedQuotaWindows(reading, now).map((window) => [
      window.window,
      window,
    ]),
  )
  for (const window of signal?.windows ?? []) {
    if (!window.confirmed) continue
    const previous = windows.get(window.window)
    if (
      !previous ||
      (window.resetAt ?? Infinity) >= (previous.resetAt ?? Infinity)
    )
      windows.set(window.window, window)
  }
  return [...windows.values()]
}

/** A stronger concurrent hard mark must not be shortened or treated as proof. */
function holdSuppressed(
  candidate: LimitCandidate,
  status: number | undefined,
  now: number,
): boolean {
  if (status === 401 || status === 403 || !candidate.admitted) return true
  const confirmed =
    candidate.confirmedBlockers?.filter((window) => window.confirmed) ?? []
  const target = Math.max(...confirmed.map((window) => window.resetAt ?? NaN))
  return (
    !Number.isFinite(target) ||
    candidate.blockers.some(
      (blocker) =>
        blocker.kind === 'hard' &&
        (blocker.until ?? 0) > now &&
        (blocker.until ?? 0) > target,
    )
  )
}

export function openAiHoldFacts(input: {
  candidate: LimitCandidate
  status?: number
  activity?: SessionActivity
  maxSameAccountWait?: unknown
  now: number
  maxDelayMs?: number
}): HoldFacts | undefined {
  if (holdSuppressed(input.candidate, input.status, input.now)) return undefined
  const hold = sameAccountHoldFacts({
    activity: input.activity,
    accountKey: input.candidate.account,
    maxSameAccountWait: input.maxSameAccountWait,
  })
  return hold
    ? {
        ...hold,
        ...(input.maxDelayMs === undefined
          ? {}
          : { maxDelayMs: input.maxDelayMs }),
      }
    : undefined
}

/** Out-of-list ordered statuses pass through before the reducer sees the attempt. */
export function shouldDecideOpenAiLimit(input: {
  host: PolicyFacts['host']
  mode: 'ordered' | 'sticky'
  status?: number
  fallbackOn?: number[]
}): boolean {
  return !(
    input.host !== 'opencode2' &&
    input.mode === 'ordered' &&
    input.status !== undefined &&
    !getFallbackStatuses({
      version: 1,
      accounts: [],
      fallbackOn: input.fallbackOn,
    }).includes(input.status)
  )
}

export function decideOpenAiLimit(
  facts: PolicyFacts,
  options: {
    mode: 'ordered' | 'sticky'
    fallbackOn?: number[]
    decide?: typeof decideAfterLimit
  },
): LimitDecision | undefined {
  if (
    facts.phase === 'after-limit' &&
    !shouldDecideOpenAiLimit({
      ...options,
      host: facts.host,
      status: facts.status,
    })
  )
    return undefined
  const attempted = facts.candidates.find(
    (candidate) =>
      facts.attempted && sameAccount(candidate.account, facts.attempted),
  )
  // The caller's computed hold is retained only after the permanent-auth/hard-mark gates.
  const suppressed =
    !attempted || holdSuppressed(attempted, facts.status, facts.now)
  return (options.decide ?? decideAfterLimit)(
    { ...facts, hold: suppressed ? undefined : facts.hold },
    openAiLimitAxes(options.fallbackOn),
  )
}
