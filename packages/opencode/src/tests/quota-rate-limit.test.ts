import { describe, expect, it } from 'bun:test'
import type { AccountStorage } from '../core/accounts.ts'

describe('QuotaManager refresh scheduling', () => {
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    quota: {
      checkIntervalMinutes: 5,
      minimumRemaining: { primary: 15, secondary: 10 },
    },
  }

  it('defers a blocked single-primary snapshot until its future reset', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = Date.UTC(2026, 6, 16, 12, 0, 0)
    const resetAt = now + 60 * 60 * 1000
    const token = 'blocked-single-primary'
    const qm = new QuotaManager({
      storage,
      now: () => now,
      fetchQuotaFn: async () => ({
        primary: {
          usedPercent: 90,
          remainingPercent: 10,
          resetsAt: new Date(resetAt).toISOString(),
          checkedAt: now,
          windowMinutes: 10_080,
        },
      }),
    })

    await qm.refreshMain(token)

    expect(qm.getMain(token)?.refreshAfter).toBe(resetAt + 60_000)
  })

  it('polls a healthy single-primary snapshot at the normal interval', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = Date.UTC(2026, 6, 16, 13, 0, 0)
    const token = 'healthy-single-primary'
    const qm = new QuotaManager({
      storage,
      now: () => now,
      fetchQuotaFn: async () => ({
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: now,
          windowMinutes: 10_080,
        },
      }),
    })

    await qm.refreshMain(token)

    expect(qm.getMain(token)?.refreshAfter).toBe(now + 5 * 60_000)
  })
})

/**
 * Unit tests for QuotaManager's mid-stream rate-limit marks: an in-memory,
 * read-time-expiring flag set from a WS response.failed rate_limit_reached_type
 * signal (never a network call). See quota-rate-limit-reroute for the
 * fetch-override integration that consumes these marks.
 */
describe('QuotaManager mid-stream rate-limit marks', () => {
  it('markRateLimited makes isRateLimited true; it clears once now() passes resetAt', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    let now = 1_000_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    expect(qm.isRateLimited('main')).toBe(false)

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // Still within the window.
    now += 30_000
    expect(qm.isRateLimited('main')).toBe(true)

    // Past resetAt — the mark expires by read-time comparison alone, no timer.
    now += 40_000
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('marking one account does not mark another (per-account isolation)', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 2_000_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)
    expect(qm.isRateLimited('fb-1')).toBe(false)

    qm.markRateLimited('fb-1', now + 60_000)
    expect(qm.isRateLimited('fb-1')).toBe(true)
    // Marking fb-1 must not have touched main's mark or any other id.
    expect(qm.isRateLimited('main')).toBe(true)
    expect(qm.isRateLimited('fb-2')).toBe(false)
  })

  it('re-marking the same account keeps the LATER reset', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    let now = 3_000_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 120_000)
    // An earlier estimate must NOT shorten the existing, later mark.
    qm.markRateLimited('main', now + 30_000)
    now += 60_000
    expect(qm.isRateLimited('main')).toBe(true) // still within the original 120s mark

    // A genuinely later signal DOES extend the mark.
    qm.markRateLimited('main', now + 200_000)
    now += 150_000
    expect(qm.isRateLimited('main')).toBe(true)
  })

  it('re-marking the same account with an EQUAL reset is idempotent (not dropped)', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    let now = 3_500_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    // Same reset again — must not be treated as "not later" and dropped;
    // an equal-value re-mark still overwrites (idempotent), so the mark
    // holds exactly through the original window.
    qm.markRateLimited('main', now + 60_000)
    now += 59_000
    expect(qm.isRateLimited('main')).toBe(true)
    now += 2_000
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain clears a mark when the only present window is healthy (single-primary wire)', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 4_000_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // The current wire sends a single present primary window (secondary is
    // absent, not unhealthy) — a healthy primary alone is positive evidence,
    // since an absent window is not applicable, not uncertain.
    qm.setMain('token-a', {
      quota: {
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          windowMinutes: 10_080,
          checkedAt: now,
        },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    })
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain does not clear the mark when a present window is still exhausted', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 4_050_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // A present-and-still-exhausted window is not evidence of health, even
    // alongside a healthy sibling — every present window must be under 100%.
    qm.setMain('token-a', {
      quota: {
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        secondary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    })
    expect(qm.isRateLimited('main')).toBe(true)
  })

  it('setMain clears the mark when both present windows are healthy', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 4_080_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    qm.setMain('token-a', {
      quota: {
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        secondary: { usedPercent: 5, remainingPercent: 95, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    })
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain clears the mark on a genuine main-account SWITCH, even with a non-healthy snapshot', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 4_500_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    // A still-exhausted snapshot establishes the initial account identity
    // without itself clearing anything (quotaLooksHealthy is false).
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }
    qm.setMain('token-a', exhaustedEntry, 'acct-A')

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // A different accountId is a SWITCH — the old account's mark must not
    // carry over to the new account, even though this snapshot alone isn't
    // healthy evidence.
    qm.setMain('token-b', exhaustedEntry, 'acct-B')
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain does NOT clear the mark on a same-account token refresh', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 4_600_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    // Still-exhausted, so the clear-on-refresh assertion below isolates the
    // same-account-refresh behavior from quotaLooksHealthy's own clear.
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }
    qm.setMain('token-a', exhaustedEntry, 'acct-A')

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // Same accountId, new access token — a routine refresh, NOT a switch.
    // The mark must survive.
    qm.setMain('refreshed-token-a', exhaustedEntry, 'acct-A')
    expect(qm.isRateLimited('main')).toBe(true)
  })

  it('refreshMain clears a stale main mark once a healthy quota poll lands (bypasses setMain)', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const now = 4_700_000
    const qm = new QuotaManager({
      storage: null,
      now: () => now,
      fetchQuotaFn: async () => ({
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        secondary: { usedPercent: 5, remainingPercent: 95, checkedAt: now },
      }),
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // _fetchMain assigns this.main directly (not via setMain), so its own
    // healthy-clear must fire independently — otherwise a known-healthy
    // active poll leaves the mark stuck until its own unrelated expiry.
    await qm.refreshMain('token-a')
    expect(qm.isRateLimited('main')).toBe(false)
  })
})

describe('resolveMidStreamRateLimitResetAt', () => {
  const now = 5_000_000
  const defaultMs = 60_000

  it('prefers the named window when present and future', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now + 300_000).toISOString(),
        checkedAt: now,
      },
      secondary: {
        usedPercent: 50,
        remainingPercent: 50,
        resetsAt: new Date(now + 30_000).toISOString(),
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + 300_000)
  })

  it('prefers an explicit provider reset over cached quota reset math', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const providerResetAt = now + 900_000
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now + 300_000).toISOString(),
        checkedAt: now,
      },
    }
    const resolveWithExplicitReset = resolveMidStreamRateLimitResetAt as (
      snapshot: typeof quota,
      window: string,
      now: number,
      defaultMs: number,
      explicitResetAt?: number,
    ) => number

    expect(
      resolveWithExplicitReset(
        quota,
        'usage_limit_reached',
        now,
        defaultMs,
        providerResetAt,
      ),
    ).toBe(providerResetAt)
  })

  it('uses the bounded default (NOT the other window) when the named window is absent', async () => {
    // The frame named `primary`, but only `secondary` has a cached reset. We
    // must NOT borrow secondary's reset — an unrelated window can reset far in
    // the future and would blackhole the account long past its real rate-limit.
    // Fall back to the bounded, self-correcting default instead.
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const quota = {
      secondary: {
        usedPercent: 50,
        remainingPercent: 50,
        resetsAt: new Date(now + 3_600_000).toISOString(),
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
  })

  it('falls back to the default when every window is past or absent', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now - 10_000).toISOString(),
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
    expect(
      resolveMidStreamRateLimitResetAt(undefined, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
  })

  it('falls back to the default when resetsAt is unparseable', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: 'not-a-date',
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
  })

  it('uses primary from a single-primary snapshot', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const primaryReset = new Date(now + 300_000).toISOString()
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: now,
        resetsAt: primaryReset,
        windowMinutes: 10_080,
      },
    }

    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(Date.parse(primaryReset))
  })

  it('does not borrow primary for a secondary-named frame', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '../core/quota-manager.ts'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: now,
        resetsAt: new Date(now + 300_000).toISOString(),
        windowMinutes: 10_080,
      },
    }

    expect(
      resolveMidStreamRateLimitResetAt(quota, 'secondary', now, defaultMs),
    ).toBe(now + defaultMs)
  })
})
