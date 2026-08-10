import { describe, expect, test } from 'bun:test'
import {
  decideStickyBreak,
  MIN_RESET_HOURS,
  QUOTA_STALENESS_MS,
  type StickySelectionCandidate,
  selectStickyCandidate,
  snapshotCheckedAt,
  sustainableWindowWeight,
} from '../core/sticky-routing.ts'
import type { AccountQuota } from '../sidebar-state.ts'

const now = Date.UTC(2026, 7, 10, 12, 0, 0)

function quota(
  remainingPercent: number,
  checkedAt = now,
  resetsAt?: string,
): AccountQuota {
  return {
    primary: {
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      checkedAt,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  }
}

function candidate(
  accountId: string,
  accountQuota: AccountQuota | null | undefined,
  configuredOrder: number,
  overrides: Partial<StickySelectionCandidate> = {},
): StickySelectionCandidate {
  return {
    accountId,
    quota: accountQuota,
    reservePercent: { primary: 0, secondary: 0 },
    configuredOrder,
    ...overrides,
  }
}

function select(
  candidates: StickySelectionCandidate[],
  pendingBytes: ReadonlyMap<string, number> = new Map(),
  requestBytes = 1,
) {
  const result = selectStickyCandidate({
    candidates,
    pendingBytes,
    requestBytes,
    now,
  })
  if (!result) throw new Error('test helper: no candidate selected')
  return result
}

describe('sustainableWindowWeight', () => {
  test('keeps spendable capacity when the reset is unknown', () => {
    expect(sustainableWindowWeight({ remainingPercent: 40 }, 10, now)).toBe(30)
  })

  test('uses the minimum reset duration for near resets', () => {
    const remaining = 40
    const windowResettingIn30Seconds = {
      remainingPercent: remaining,
      resetsAt: new Date(now + 30_000).toISOString(),
    }

    expect(
      sustainableWindowWeight(windowResettingIn30Seconds, 0, now),
    ).toBeCloseTo(remaining / MIN_RESET_HOURS)
  })

  test('keeps spendable capacity when the reset timestamp is past', () => {
    expect(
      sustainableWindowWeight(
        { remainingPercent: 40, resetsAt: new Date(now - 1).toISOString() },
        10,
        now,
      ),
    ).toBe(30)
  })

  test('keeps spendable capacity when the reset timestamp is invalid', () => {
    expect(
      sustainableWindowWeight(
        { remainingPercent: 40, resetsAt: 'not-a-date' },
        10,
        now,
      ),
    ).toBe(30)
  })

  test('returns zero at the reserve threshold', () => {
    expect(sustainableWindowWeight({ remainingPercent: 10 }, 10, now)).toBe(0)
  })
})

describe('snapshotCheckedAt', () => {
  test('prefers primary, then secondary, then snapshot, then cache entry timestamp', () => {
    expect(
      snapshotCheckedAt(
        {
          checkedAt: 20,
          primary: { usedPercent: 10, remainingPercent: 90, checkedAt: 30 },
        },
        10,
      ),
    ).toBe(30)
    expect(snapshotCheckedAt({ checkedAt: 20 }, 10)).toBe(20)
    expect(snapshotCheckedAt({}, 10)).toBe(10)
  })

  test('uses the secondary window when primary is missing', () => {
    expect(
      snapshotCheckedAt({
        checkedAt: 10,
        secondary: { usedPercent: 5, remainingPercent: 95, checkedAt: 40 },
      }),
    ).toBe(40)
  })
})

describe('decideStickyBreak', () => {
  test.each([
    {
      name: 'migrates permanent authorization failures before quota ignorance',
      input: { quota: null, status: 401, now },
      want: { action: 'migrate', reason: 'permanent' },
    },
    {
      name: 'migrates forbidden responses permanently',
      input: { quota: quota(50), status: 403, now },
      want: { action: 'migrate', reason: 'permanent' },
    },
    {
      name: 'retains an account with no quota snapshot',
      input: { quota: undefined, status: 400, now },
      want: { action: 'retain', reason: 'unknown' },
    },
    {
      name: 'retains an account with a stale snapshot',
      input: {
        quota: quota(0, now - QUOTA_STALENESS_MS - 1),
        status: 400,
        now,
      },
      want: { action: 'retain', reason: 'stale' },
    },
    {
      name: 'retains an account with a malformed snapshot timestamp',
      input: { quota: { checkedAt: Number.NaN }, status: 400, now },
      want: { action: 'retain', reason: 'stale' },
    },
    {
      name: 'migrates an exhausted fresh window with diagnostic reset metadata',
      input: {
        quota: quota(0, now, '2026-08-10T13:00:00.000Z'),
        status: 400,
        now,
      },
      want: {
        action: 'migrate',
        reason: 'exhausted',
        windowKey: 'primary',
        resetsAt: '2026-08-10T13:00:00.000Z',
      },
    },
    {
      name: 'treats a rate limit with healthy quota as transient',
      input: { quota: quota(50), status: 429, now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'treats a rate limit with no present fresh quota windows as transient',
      input: { quota: { checkedAt: now }, status: 429, now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'treats server failures as transient',
      input: { quota: quota(50), status: 500, now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'treats indeterminate transport failures as transient',
      input: { quota: quota(50), now },
      want: { action: 'retain', reason: 'transient' },
    },
    {
      name: 'retains a healthy account for non-routing client failures',
      input: { quota: quota(50), status: 400, now },
      want: { action: 'retain', reason: 'healthy' },
    },
    {
      name: 'does not migrate malformed exhausted-looking percentages',
      input: { quota: quota(Number.NaN), status: 400, now },
      want: { action: 'retain', reason: 'healthy' },
    },
    {
      name: 'does not migrate non-finite exhausted-looking percentages',
      input: { quota: quota(Number.NEGATIVE_INFINITY), status: 400, now },
      want: { action: 'retain', reason: 'healthy' },
    },
  ])('$name', ({ input, want }) => {
    expect(decideStickyBreak(input)).toEqual(want)
  })

  test('skips healthy windows when a longer window is exhausted', () => {
    const accountQuota = quota(50)
    accountQuota.primary = {
      usedPercent: 50,
      remainingPercent: 50,
      checkedAt: now,
      windowMinutes: 300,
    }
    accountQuota.secondary = {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now,
      windowMinutes: 10_080,
      resetsAt: '2026-08-17T12:00:00.000Z',
    }

    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      windowKey: 'secondary',
      resetsAt: '2026-08-17T12:00:00.000Z',
    })
  })

  test('reports the longest exhausted window when every window is exhausted', () => {
    const accountQuota = quota(0, now, '2026-08-10T13:00:00.000Z')
    accountQuota.primary = {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now,
      windowMinutes: 300,
      resetsAt: '2026-08-10T13:00:00.000Z',
    }
    accountQuota.secondary = {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now,
      windowMinutes: 10_080,
      resetsAt: '2026-08-17T12:00:00.000Z',
    }

    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      windowKey: 'secondary',
      resetsAt: '2026-08-17T12:00:00.000Z',
    })
  })

  test('omits non-string reset metadata from exhausted decisions', () => {
    const accountQuota = quota(0)
    accountQuota.primary = {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now,
      resetsAt: 1 as never,
    }

    expect(
      decideStickyBreak({ quota: accountQuota, status: 400, now }),
    ).toEqual({
      action: 'migrate',
      reason: 'exhausted',
      windowKey: 'primary',
    })
  })

  test('never returns a hold action', () => {
    const decisions = [
      decideStickyBreak({ quota: null, now }),
      decideStickyBreak({ quota: quota(0), status: 400, now }),
      decideStickyBreak({ quota: quota(50), status: 429, now }),
      decideStickyBreak({ quota: quota(50), status: 400, now }),
    ]

    for (const decision of decisions) {
      expect(decision.action).not.toBe('hold')
    }
  })

  test('migrates a fresh below-floor account when killswitchPasses is false', () => {
    expect(
      decideStickyBreak({
        quota: quota(45),
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'migrate', reason: 'killswitch' })
  })

  test('keeps a stale snapshot when killswitchPasses is false (stale wins)', () => {
    expect(
      decideStickyBreak({
        quota: quota(45, now - QUOTA_STALENESS_MS - 1),
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'retain', reason: 'stale' })
  })

  test('keeps a no-quota account when killswitchPasses is false (unknown wins)', () => {
    expect(
      decideStickyBreak({
        quota: undefined,
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'retain', reason: 'unknown' })
  })

  test('migrates before exhaustion when the killswitch and exhaustion both apply', () => {
    // Below floor AND at 0% — killswitch is the more specific policy reason.
    expect(
      decideStickyBreak({
        quota: quota(0),
        status: 400,
        now,
        killswitchPasses: false,
      }),
    ).toEqual({ action: 'migrate', reason: 'killswitch' })
  })

  test('killswitchPasses true is a no-op on the healthy path', () => {
    expect(
      decideStickyBreak({
        quota: quota(50),
        status: 400,
        now,
        killswitchPasses: true,
      }),
    ).toEqual({ action: 'retain', reason: 'healthy' })
  })

  test('killswitchPasses undefined is a no-op (killswitch disabled / not opted in)', () => {
    expect(
      decideStickyBreak({
        quota: quota(45),
        status: 400,
        now,
      }),
    ).toEqual({ action: 'retain', reason: 'healthy' })
  })
})

describe('selectStickyCandidate', () => {
  test('excludes candidates with missing quota', () => {
    expect(
      select([candidate('unknown', null, 0), candidate('known', quota(1), 1)])
        .accountId,
    ).toBe('known')
  })

  test('excludes candidates with stale quota snapshots', () => {
    expect(
      select([
        candidate('stale', quota(100, now - QUOTA_STALENESS_MS - 1), 0),
        candidate('fresh', quota(1), 1),
      ]).accountId,
    ).toBe('fresh')
  })

  test('uses the tightest present quota window as the account weight', () => {
    const tight = quota(80)
    tight.secondary = { usedPercent: 90, remainingPercent: 10, checkedAt: now }
    const roomy = quota(20)
    roomy.secondary = { usedPercent: 80, remainingPercent: 20, checkedAt: now }

    expect(
      select([candidate('tight', tight, 0), candidate('roomy', roomy, 1)])
        .accountId,
    ).toBe('roomy')
  })

  test('selects the lower projected pressure', () => {
    expect(
      select(
        [
          candidate('less-pressure', quota(50), 0),
          candidate('more-pressure', quota(50), 1),
        ],
        new Map([
          ['less-pressure', 0],
          ['more-pressure', 100],
        ]),
        100,
      ).accountId,
    ).toBe('less-pressure')
  })

  test('changes the next pick when pending bytes change', () => {
    const candidates = [
      candidate('a', quota(50), 0),
      candidate('b', quota(50), 1),
    ]

    expect(select(candidates, new Map([['a', 100]])).accountId).toBe('b')
    expect(select(candidates, new Map([['b', 100]])).accountId).toBe('a')
  })

  test('resolves equal scores by configured order then account id', () => {
    expect(
      select([candidate('z', quota(50), 1), candidate('a', quota(50), 0)])
        .accountId,
    ).toBe('a')
    expect(
      select([candidate('z', quota(50), 0), candidate('a', quota(50), 0)])
        .accountId,
    ).toBe('a')
  })

  test('never selects zero capacity over positive capacity', () => {
    expect(
      select([
        candidate('empty', quota(0), 0),
        candidate('usable', quota(1), 1),
      ]).accountId,
    ).toBe('usable')
  })

  test('falls back to configured order when every snapshot is stale', () => {
    const selection = select([
      candidate('first', quota(50, now - QUOTA_STALENESS_MS - 1), 0),
      candidate('second', quota(50, now - QUOTA_STALENESS_MS - 1), 1),
    ])

    expect(selection).toEqual({
      accountId: 'first',
      quotaCheckedAt: now - QUOTA_STALENESS_MS - 1,
      source: 'mode-fallback',
    })
  })

  test('notifies the caller when no weighted candidate survives', () => {
    let emptySetCalls = 0

    selectStickyCandidate({
      candidates: [
        candidate('stale', quota(50, now - QUOTA_STALENESS_MS - 1), 0),
      ],
      pendingBytes: new Map(),
      requestBytes: 1,
      now,
      onEmptyWeightedSet: () => {
        emptySetCalls += 1
      },
    })

    expect(emptySetCalls).toBe(1)
  })

  test('prefers a positive optional reset-credit count in empty-set fallback', () => {
    expect(
      select([
        candidate('no-credit', null, 0, { resetCreditsApplicable: 0 }),
        candidate('credit', null, 1, { resetCreditsApplicable: 1 }),
      ]).accountId,
    ).toBe('credit')
  })

  test('rejects an empty input candidate list', () => {
    expect(() => select([])).toThrow(
      'Cannot select a sticky candidate: input.candidates is empty',
    )
  })

  test('excludes a killswitch-killed candidate from weighted placement', () => {
    expect(
      select([
        candidate('killed', quota(20), 0, { killswitchPasses: false }),
        candidate('healthy', quota(50), 1),
      ]).accountId,
    ).toBe('healthy')
  })

  test('excludes a killswitch-killed candidate from mode-fallback fail-open', () => {
    // All quotas stale → mode-fallback. Without the filter, 'killed' would win
    // on configuredOrder (0). With the filter, 'killed' is excluded and the
    // remaining candidate is selected.
    expect(
      select([
        candidate('killed', quota(50, now - QUOTA_STALENESS_MS - 1), 0, {
          killswitchPasses: false,
        }),
        candidate('healthy', quota(50, now - QUOTA_STALENESS_MS - 1), 1),
      ]).accountId,
    ).toBe('healthy')
  })

  test('killswitchPasses true is a no-op on placement', () => {
    const candidates = [
      candidate('explicit', quota(50), 0, { killswitchPasses: true }),
      candidate('implicit', quota(50), 1),
    ]
    expect(select(candidates).accountId).toBe('explicit')
  })

  test('killswitchPasses undefined is a no-op on placement (killswitch disabled)', () => {
    // The dominant path with killswitch disabled must be byte-identical.
    const candidates = [
      candidate('a', quota(50), 0),
      candidate('b', quota(50), 1),
    ]
    expect(select(candidates).accountId).toBe('a')
    expect(select(candidates).accountId).toBe('a')
  })
})
