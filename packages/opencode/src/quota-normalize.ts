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
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: toResetIso(
      h.get(`${prefix.slice(0, -'-used-percent'.length)}-reset-at`) ??
        undefined,
    ),
    checkedAt: Date.now(),
  }
}

export function normalizeQuotaHeaders(h: Headers): OAuthQuotaSnapshot {
  const snapshot: OAuthQuotaSnapshot = {}
  const primary = windowFromHeader(h, 'x-codex-primary-used-percent')
  if (primary) snapshot.primary = primary
  const secondary = windowFromHeader(h, 'x-codex-secondary-used-percent')
  if (secondary) snapshot.secondary = secondary
  return snapshot
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
  primary?: WsRateLimitWindow
  secondary?: WsRateLimitWindow
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
  w: WsRateLimitWindow | undefined,
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
  return {
    usedPercent: w.used_percent,
    remainingPercent: 100 - w.used_percent,
    resetsAt: toResetIso(w.reset_at),
    checkedAt: Date.now(),
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
  primary_window?: WhamRateLimitWindow
  secondary_window?: WhamRateLimitWindow
}

// As with the WS frame, wham/usage may carry per-model windows alongside the
// primary/secondary pair. They are not consumed anywhere and their on-wire shape
// is not a flat metered-limit array, so we do not parse them.
interface WhamUsageResponse {
  plan_type?: string
  rate_limit: WhamRateLimits
}

function windowFromWham(
  w: WhamRateLimitWindow | undefined,
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
  return {
    usedPercent: w.used_percent,
    remainingPercent: 100 - w.used_percent,
    resetsAt: toResetIso(w.reset_at),
    checkedAt: Date.now(),
  }
}

export function normalizeWham(json: WhamUsageResponse): OAuthQuotaSnapshot {
  const snapshot: OAuthQuotaSnapshot = {}
  const primary = windowFromWham(json.rate_limit?.primary_window)
  if (primary) snapshot.primary = primary
  const secondary = windowFromWham(json.rate_limit?.secondary_window)
  if (secondary) snapshot.secondary = secondary
  return snapshot
}
