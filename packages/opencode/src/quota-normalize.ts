import type { AccountQuotaWindow, OAuthQuotaSnapshot } from './core/accounts.ts'

// ---------------------------------------------------------------------------
// Shared helper: Codex reset_at is epoch SECONDS; tolerate ms and ISO too.
// Emit ISO 8601 so every consumer's `new Date(resetsAt)` parses correctly.
// ---------------------------------------------------------------------------

export function toResetIso(
  raw: string | number | undefined,
): string | undefined {
  if (raw == null || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isFinite(n)) {
    // < 1e11 → seconds (1e11s = year 5138); otherwise already ms
    const ms = n < 1e11 ? n * 1000 : n
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  // non-numeric: assume already an ISO/date string; validate
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function positiveFinite(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

// JSON-only (reset-credit count) — unlike positiveFinite, deliberately does
// NOT coerce strings/null: Number(null) and Number('') are both 0, which
// would turn an absent/null wham field into a fabricated real zero.
function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

// ---------------------------------------------------------------------------
// HTTP x-codex-* response headers
// ---------------------------------------------------------------------------

function windowFromHeader(
  h: Headers,
  prefix: string,
): AccountQuotaWindow | undefined {
  const used = h.get(prefix)
  if (used === null || used.trim() === '') return undefined
  const usedPercent = Number(used)
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
    return undefined
  const base = prefix.slice(0, -'-used-percent'.length)
  const windowMinutes = positiveFinite(h.get(`${base}-window-minutes`))
  const resetsAt = toResetIso(h.get(`${base}-reset-at`) ?? undefined)
  // Retired slots use an explicit zero-length marker. Missing optional
  // metadata alone cannot distinguish a retired slot from a live 0%-used window.
  if (
    usedPercent === 0 &&
    h.get(`${base}-window-minutes`) === '0' &&
    !resetsAt
  ) {
    return undefined
  }
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    checkedAt: Date.now(),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  }
}

const QUOTA_USED_PERCENT_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-secondary-used-percent',
] as const

function usedPercentHeaderState(h: Headers, name: string) {
  const raw = h.get(name)
  if (raw === null) return 'absent' as const
  if (raw.trim() === '') return 'invalid' as const
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? ('valid' as const)
    : ('invalid' as const)
}

export function normalizeQuotaHeaders(h: Headers): OAuthQuotaSnapshot {
  if (
    QUOTA_USED_PERCENT_HEADERS.some(
      (name) => usedPercentHeaderState(h, name) === 'invalid',
    )
  )
    return {}
  const snapshot: OAuthQuotaSnapshot = {}
  const primary = windowFromHeader(h, 'x-codex-primary-used-percent')
  if (primary) snapshot.primary = primary
  const secondary = windowFromHeader(h, 'x-codex-secondary-used-percent')
  if (secondary) snapshot.secondary = secondary
  return snapshot
}

/**
 * A complete frame has at least one syntactically valid used-percent header
 * and no malformed used-percent headers. Explicit retired-slot markers count
 * as valid even though normalization omits them from the snapshot.
 */
export function isCompleteQuotaHeaderFrame(h: Headers): boolean {
  const states = QUOTA_USED_PERCENT_HEADERS.map((name) =>
    usedPercentHeaderState(h, name),
  )
  return states.includes('valid') && !states.includes('invalid')
}

// ---------------------------------------------------------------------------
// WS codex.rate_limits frame
// ---------------------------------------------------------------------------

interface WsRateLimitWindow {
  used_percent: number
  window_minutes: number
  reset_at?: string | number
}

interface WsRateLimits {
  primary?: WsRateLimitWindow | null
  secondary?: WsRateLimitWindow | null
}

// The live codex.rate_limits frame also carries `additional_rate_limits`, but on
// the wire it is a map keyed by model name whose values are nested
// { primary, secondary } buckets (NOT a flat array of metered limits). Nothing
// downstream reads those per-model windows, and they do not fit AccountQuotaWindow,
// so we intentionally do not parse them — iterating the real object shape with
// for..of is also what crashed ("{} is not iterable").
interface WsRateLimitsFrame {
  type: string
  rate_limits: WsRateLimits
  plan_type?: string
}

function windowFromWs(
  w: WsRateLimitWindow | null | undefined,
): AccountQuotaWindow | undefined {
  if (!w) return undefined
  // A non-finite used_percent (NaN, Infinity) would produce a bogus
  // remainingPercent that silently bypasses quota-gate checks — return
  // undefined so the caller treats it as no window rather than a fake one.
  if (
    !Number.isFinite(w.used_percent) ||
    w.used_percent < 0 ||
    w.used_percent > 100
  )
    return undefined
  const windowMinutes = positiveFinite(w.window_minutes)
  const resetsAt = toResetIso(w.reset_at)
  // Defensive mirror of the header-path placeholder guard: a gone window
  // slot on this transport is normally an explicit null, but a zero-valued
  // object with no length and no reset carries the same "not really here"
  // shape and should not render as a present 0% window either.
  if (w.used_percent === 0 && windowMinutes === undefined && !resetsAt) {
    return undefined
  }
  return {
    usedPercent: w.used_percent,
    remainingPercent: 100 - w.used_percent,
    resetsAt,
    checkedAt: Date.now(),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  }
}

export function normalizeWsFrame(event: WsRateLimitsFrame): OAuthQuotaSnapshot {
  const snapshot: OAuthQuotaSnapshot = {}
  const primary = windowFromWs(event.rate_limits?.primary)
  if (primary) snapshot.primary = primary
  const secondary = windowFromWs(event.rate_limits?.secondary)
  if (secondary) snapshot.secondary = secondary
  return snapshot
}

// ---------------------------------------------------------------------------
// wham/usage JSON (seconds-based windows)
// ---------------------------------------------------------------------------

interface WhamRateLimitWindow {
  used_percent: number
  limit_window_seconds: number
  reset_at?: string | number
}

interface WhamRateLimits {
  primary_window?: WhamRateLimitWindow | null
  secondary_window?: WhamRateLimitWindow | null
}

// As with the WS frame, wham/usage may carry per-model windows alongside the
// primary/secondary pair. They are not consumed anywhere and their on-wire shape
// is not a flat metered-limit array, so we do not parse them.
interface WhamUsageResponse {
  plan_type?: string
  rate_limit: WhamRateLimits
  rate_limit_reset_credits?: {
    available_count?: number
  } | null
}

function windowFromWham(
  w: WhamRateLimitWindow | null | undefined,
): AccountQuotaWindow | undefined {
  if (!w) return undefined
  // A non-finite used_percent (NaN, Infinity) would produce a bogus
  // remainingPercent that silently bypasses quota-gate checks — return
  // undefined so the caller treats it as no window rather than a fake one.
  if (
    !Number.isFinite(w.used_percent) ||
    w.used_percent < 0 ||
    w.used_percent > 100
  )
    return undefined
  // wham's window length is in seconds; every other source is minutes.
  const windowSeconds = positiveFinite(w.limit_window_seconds)
  const resetsAt = toResetIso(w.reset_at)
  // Defensive mirror of the header-path placeholder guard — wham sends an
  // explicit null for a gone window, but a zero-valued object with no
  // length and no reset carries the same "not really here" shape.
  if (w.used_percent === 0 && windowSeconds === undefined && !resetsAt) {
    return undefined
  }
  return {
    usedPercent: w.used_percent,
    remainingPercent: 100 - w.used_percent,
    resetsAt,
    checkedAt: Date.now(),
    ...(windowSeconds !== undefined
      ? { windowMinutes: windowSeconds / 60 }
      : {}),
  }
}

export function normalizeWham(json: WhamUsageResponse): OAuthQuotaSnapshot {
  const snapshot: OAuthQuotaSnapshot = {}
  const primary = windowFromWham(json.rate_limit?.primary_window)
  if (primary) snapshot.primary = primary
  const secondary = windowFromWham(json.rate_limit?.secondary_window)
  if (secondary) snapshot.secondary = secondary
  const resetCreditsAvailable = nonNegativeFinite(
    json.rate_limit_reset_credits?.available_count,
  )
  if (resetCreditsAvailable !== undefined) {
    snapshot.resetCreditsAvailable = resetCreditsAvailable
  }
  return snapshot
}
