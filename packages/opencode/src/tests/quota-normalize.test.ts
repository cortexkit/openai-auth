import { describe, expect, it } from 'bun:test'
import {
  normalizeQuotaHeaders,
  normalizeWham,
  normalizeWsFrame,
  toResetIso,
} from '../quota-normalize.ts'
import { formatResetIn } from '../tui.tsx'

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
    expect(normalizeQuotaHeaders(h).primary?.windowMinutes).toBe(300)
    expect(normalizeQuotaHeaders(h).secondary?.windowMinutes).toBe(10_080)
  })

  it('HTTP headers: missing optional fields → undefined in snapshot', () => {
    const h = new Headers({ 'x-codex-primary-used-percent': '50' })
    const s = normalizeQuotaHeaders(h)
    expect(s.primary?.usedPercent).toBe(50)
    expect(s.primary?.remainingPercent).toBe(50)
    expect(s.primary?.resetsAt).toBeUndefined()
    expect(s.secondary).toBeUndefined()
  })

  it('HTTP headers: blank used-percent is treated as absent, not zero', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '   ',
      'x-codex-primary-reset-at': '1781729038',
    })
    const s = normalizeQuotaHeaders(h)
    expect(s.primary).toBeUndefined()
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
    expect(s.primary?.windowMinutes).toBe(300)
    expect(s.secondary?.windowMinutes).toBe(10_080)
  })

  // Regression: the real codex.rate_limits frame carries additional_rate_limits
  // as an OBJECT keyed by model name (nested primary/secondary buckets), not the
  // flat array the original code assumed. for..of over it threw "{} is not
  // iterable" and tore down the WS frame loop. We ignore those per-model windows
  // (nothing consumes them) and must never crash on the real shape.
  it('WS frame: real object-shaped additional_rate_limits does not crash and is ignored', () => {
    const s = normalizeWsFrame({
      type: 'codex.rate_limits',
      plan_type: 'pro',
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: {
          used_percent: 17,
          window_minutes: 300,
          reset_after_seconds: 5725,
          reset_at: 1781625766,
        },
        secondary: {
          used_percent: 73,
          window_minutes: 10080,
          reset_after_seconds: 140256,
          reset_at: 1781760298,
        },
      },
      code_review_rate_limits: null,
      additional_rate_limits: {
        'GPT-5.3-Codex-Spark': {
          allowed: true,
          limit_reached: false,
          primary: {
            used_percent: 0,
            window_minutes: 300,
            reset_at: 1781638042,
          },
          secondary: {
            used_percent: 0,
            window_minutes: 10080,
            reset_at: 1782224842,
          },
        },
      },
      // The empty-object form that actually triggered the crash in the field.
    } as unknown as Parameters<typeof normalizeWsFrame>[0])
    expect(s.primary?.usedPercent).toBe(17)
    expect(s.primary?.remainingPercent).toBe(83)
    expect(s.secondary?.usedPercent).toBe(73)
    expect(Object.keys(s)).toEqual(['primary', 'secondary'])
  })

  it('WS frame: empty-object additional_rate_limits does not throw', () => {
    expect(() =>
      normalizeWsFrame({
        type: 'codex.rate_limits',
        rate_limits: {
          primary: { used_percent: 1, window_minutes: 300, reset_at: '1' },
        },
        additional_rate_limits: {},
      } as unknown as Parameters<typeof normalizeWsFrame>[0]),
    ).not.toThrow()
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
    expect(s.primary?.windowMinutes).toBe(300)
    expect(s.secondary?.windowMinutes).toBe(10_080)
  })

  it('wham carries a single 7-day primary window and reset credits', () => {
    const snapshot = normalizeWham({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 604_800,
          reset_at: 1_784_809_904,
        },
        secondary_window: null,
      },
      rate_limit_reset_credits: { available_count: 4 },
    } as Parameters<typeof normalizeWham>[0])

    expect(snapshot.primary?.windowMinutes).toBe(10_080)
    expect(snapshot.secondary).toBeUndefined()
    expect(snapshot.resetCreditsAvailable).toBe(4)
  })

  it('omits invalid window lengths and reset-credit counts', () => {
    const headers = normalizeQuotaHeaders(
      new Headers({
        'x-codex-primary-used-percent': '20',
        'x-codex-primary-window-minutes': '0',
      }),
    )
    expect(headers.primary?.windowMinutes).toBeUndefined()
    expect(headers.resetCreditsAvailable).toBeUndefined()

    const ws = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 20, window_minutes: Number.POSITIVE_INFINITY },
      },
    })
    expect(ws.primary?.windowMinutes).toBeUndefined()
    expect(ws.resetCreditsAvailable).toBeUndefined()

    const wham = normalizeWham({
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: -60 },
      },
      rate_limit_reset_credits: { available_count: Number.NaN },
    } as Parameters<typeof normalizeWham>[0])
    expect(wham.primary?.windowMinutes).toBeUndefined()
    expect(wham.resetCreditsAvailable).toBeUndefined()

    const zeroCredits = normalizeWham({
      rate_limit: {},
      rate_limit_reset_credits: { available_count: 0 },
    } as Parameters<typeof normalizeWham>[0])
    expect(zeroCredits.resetCreditsAvailable).toBe(0)
  })

  it('does not coerce a null or empty-string reset-credit count into a fabricated zero', () => {
    const nullCredits = normalizeWham({
      rate_limit: {},
      rate_limit_reset_credits: { available_count: null as unknown as number },
    } as Parameters<typeof normalizeWham>[0])
    expect(nullCredits.resetCreditsAvailable).toBeUndefined()

    const emptyStringCredits = normalizeWham({
      rate_limit: {},
      rate_limit_reset_credits: { available_count: '' as unknown as number },
    } as Parameters<typeof normalizeWham>[0])
    expect(emptyStringCredits.resetCreditsAvailable).toBeUndefined()

    const missingCredits = normalizeWham({
      rate_limit: {},
      rate_limit_reset_credits: null,
    })
    expect(missingCredits.resetCreditsAvailable).toBeUndefined()
  })

  it('header: a zero-placeholder secondary (gone window) normalizes as absent, not a 0% window', () => {
    // Full captured live header set for a single-primary account: the gone
    // secondary window is encoded as a zero used-percent sibling of the real
    // primary fields, not by omitting the header entirely.
    const h = new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'team',
      'x-codex-primary-used-percent': '0',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '604800',
      'x-codex-primary-reset-at': '1784810110',
      'x-codex-secondary-used-percent': '0',
      'x-codex-secondary-window-minutes': '0',
      'x-codex-secondary-reset-after-seconds': '0',
      'x-codex-secondary-reset-at': '',
    })
    const s = normalizeQuotaHeaders(h)
    expect(s.primary?.usedPercent).toBe(0)
    expect(s.primary?.windowMinutes).toBe(10_080)
    expect(s.secondary).toBeUndefined()
  })

  it('header: a 0%-used window without optional metadata stays present', () => {
    const h = new Headers({
      'x-codex-secondary-used-percent': '0',
    })
    const s = normalizeQuotaHeaders(h)
    expect(s.secondary?.usedPercent).toBe(0)
    expect(s.secondary?.windowMinutes).toBeUndefined()
    expect(s.secondary?.resetsAt).toBeUndefined()
  })

  it('header: a real 0%-used window with a positive length and a reset stays present', () => {
    const h = new Headers({
      'x-codex-secondary-used-percent': '0',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1784810110',
    })
    const s = normalizeQuotaHeaders(h)
    expect(s.secondary?.usedPercent).toBe(0)
    expect(s.secondary?.windowMinutes).toBe(10_080)
  })

  it('wham: object-shaped additional_rate_limits does not crash and is ignored', () => {
    const s = normalizeWham({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 18000,
          reset_at: '1',
        },
      },
      additional_rate_limits: {
        'GPT-5.3-Codex-Spark': {
          primary: { used_percent: 0, limit_window_seconds: 18000 },
        },
      },
    } as unknown as Parameters<typeof normalizeWham>[0])
    expect(s.primary?.usedPercent).toBe(1)
    expect(Object.keys(s)).toEqual(['primary'])
  })

  it('empty/missing rate_limits → empty snapshot', () => {
    expect(
      normalizeWsFrame({ type: 'codex.rate_limits', rate_limits: {} }),
    ).toEqual({})
    expect(normalizeWham({ rate_limit: {} })).toEqual({})
    expect(normalizeQuotaHeaders(new Headers({}))).toEqual({})
  })

  it('out-of-range used_percent values are treated as undefined/absent', () => {
    const h1 = new Headers({ 'x-codex-primary-used-percent': '-10' })
    expect(normalizeQuotaHeaders(h1).primary).toBeUndefined()
    const h2 = new Headers({ 'x-codex-primary-used-percent': '110' })
    expect(normalizeQuotaHeaders(h2).primary).toBeUndefined()
    const h3 = new Headers({ 'x-codex-primary-used-percent': 'NaN' })
    expect(normalizeQuotaHeaders(h3).primary).toBeUndefined()

    const ws1 = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: -5, window_minutes: 300 },
      },
    })
    expect(ws1.primary).toBeUndefined()
    const ws2 = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 105, window_minutes: 300 },
      },
    })
    expect(ws2.primary).toBeUndefined()

    const wham1 = normalizeWham({
      rate_limit: {
        primary_window: { used_percent: -1, limit_window_seconds: 18000 },
      },
    })
    expect(wham1.primary).toBeUndefined()
    const wham2 = normalizeWham({
      rate_limit: {
        primary_window: { used_percent: 101, limit_window_seconds: 18000 },
      },
    })
    expect(wham2.primary).toBeUndefined()
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
