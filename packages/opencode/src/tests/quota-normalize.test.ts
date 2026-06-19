import { describe, expect, it } from 'bun:test'
import type { AccountQuotaWindow } from '../core/accounts.ts'
import {
  normalizeQuotaHeaders,
  normalizeWham,
  normalizeWsFrame,
  toResetIso,
} from '../quota-normalize.ts'
import { formatResetIn } from '../tui.tsx'

// U-7: QuotaWindowName will be widened to string in Phase 4 — cast for
// additional_rate_limits entries until then.
function win(
  snap: Record<string, unknown>,
  key: string,
): AccountQuotaWindow | undefined {
  return snap[key] as AccountQuotaWindow | undefined
}

describe('quota normalize → QuotaSnapshot', () => {
  it('HTTP x-codex-* headers (minutes)', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '10',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1781729038',
      'x-codex-secondary-used-percent': '91',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1781766665',
    })
    const s = normalizeQuotaHeaders(h)
    expect(s.primary?.usedPercent).toBe(10)
    expect(s.primary?.remainingPercent).toBe(90)
    expect(s.primary?.resetsAt).toBe(new Date(1781729038 * 1000).toISOString())
    expect(s.primary?.checkedAt).toBeGreaterThan(0)
    expect(s.secondary?.usedPercent).toBe(91)
    expect(s.secondary?.remainingPercent).toBe(9)
    expect(s.secondary?.resetsAt).toBe(
      new Date(1781766665 * 1000).toISOString(),
    )
  })

  it('HTTP headers: missing optional fields → undefined in snapshot', () => {
    const h = new Headers({ 'x-codex-primary-used-percent': '50' })
    const s = normalizeQuotaHeaders(h)
    expect(s.primary?.usedPercent).toBe(50)
    expect(s.primary?.remainingPercent).toBe(50)
    expect(s.primary?.resetsAt).toBeUndefined()
    expect(s.secondary).toBeUndefined()
  })

  it('WS codex.rate_limits frame (minutes)', () => {
    const s = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 25, window_minutes: 300, reset_at: '1' },
        secondary: { used_percent: 5, window_minutes: 10080, reset_at: '2' },
      },
      plan_type: 'plus',
    })
    expect(s.primary?.usedPercent).toBe(25)
    expect(s.primary?.remainingPercent).toBe(75)
    expect(s.secondary?.usedPercent).toBe(5)
    expect(s.secondary?.remainingPercent).toBe(95)
    expect(s.primary?.checkedAt).toBeGreaterThan(0)
  })

  it('U-4: scans additional_rate_limits[] families (WS frame)', () => {
    const s = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 1, window_minutes: 300, reset_at: '1' },
      },
      additional_rate_limits: [
        {
          metered_limit_name: 'metered_x',
          used_percent: 12,
          window_minutes: 60,
          reset_at: '9',
        },
      ],
    })
    expect(win(s, 'metered_x')?.usedPercent).toBe(12)
    expect(win(s, 'metered_x')?.remainingPercent).toBe(88)
  })

  it('wham/usage JSON (seconds)', () => {
    const s = normalizeWham({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18000,
          reset_at: '1',
        },
        secondary_window: {
          used_percent: 91,
          limit_window_seconds: 604800,
          reset_at: '2',
        },
      },
    })
    expect(s.primary?.usedPercent).toBe(10)
    expect(s.primary?.remainingPercent).toBe(90)
    expect(s.secondary?.usedPercent).toBe(91)
    expect(s.secondary?.remainingPercent).toBe(9)
    expect(s.primary?.checkedAt).toBeGreaterThan(0)
  })

  it('U-4: scans additional_rate_limits[] families (wham)', () => {
    const s = normalizeWham({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 18000,
          reset_at: '1',
        },
      },
      additional_rate_limits: [
        {
          metered_limit_name: 'metered_y',
          used_percent: 77,
          limit_window_seconds: 3600,
          reset_at: '5',
        },
      ],
    })
    expect(win(s, 'metered_y')?.usedPercent).toBe(77)
    expect(win(s, 'metered_y')?.remainingPercent).toBe(23)
  })

  it('empty/missing rate_limits → empty snapshot', () => {
    expect(
      normalizeWsFrame({ type: 'codex.rate_limits', rate_limits: {} }),
    ).toEqual({})
    expect(normalizeWham({ rate_limit: {} })).toEqual({})
    expect(normalizeQuotaHeaders(new Headers({}))).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// BUG 4 regression: resetsAt must be ISO so new Date() parses correctly.
// The old String(epoch) → "1781782060" → new Date("1781782060") → NaN → "NaNd".
// ---------------------------------------------------------------------------

describe('toResetIso', () => {
  it('epoch seconds → ISO', () => {
    const result = toResetIso(1781729038)
    expect(result).toBe(new Date(1781729038 * 1000).toISOString())
  })

  it('epoch seconds as string → ISO', () => {
    const result = toResetIso('1781729038')
    expect(result).toBe(new Date(1781729038 * 1000).toISOString())
  })

  it('ms timestamp → ISO', () => {
    const result = toResetIso(1781729038000)
    expect(result).toBe(new Date(1781729038000).toISOString())
  })

  it('already ISO string → ISO (passthrough normalise)', () => {
    const iso = new Date(1781729038 * 1000).toISOString()
    const result = toResetIso(iso)
    expect(result).toBe(iso)
  })

  it('undefined / null / empty → undefined', () => {
    expect(toResetIso(undefined)).toBeUndefined()
    expect(toResetIso(null as unknown as string)).toBeUndefined()
    expect(toResetIso('')).toBeUndefined()
  })

  it('garbage string → undefined', () => {
    expect(toResetIso('not-a-date')).toBeUndefined()
  })
})

describe('formatResetIn (NaN regression)', () => {
  it('returns a non-NaN string for an ISO resetsAt', () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const result = formatResetIn(future)
    expect(result).not.toBe('')
    expect(result).not.toContain('NaN')
  })

  it('returns empty string for undefined', () => {
    expect(formatResetIn(undefined)).toBe('')
  })

  it('returns empty string for garbage input (NaN guard)', () => {
    // This would have returned "NaNd" before the NaN guard
    expect(formatResetIn('1781729038')).toBe('')
  })
})
