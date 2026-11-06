import { describe, expect, test } from 'bun:test'
import {
  createRequestHistory,
  type LimitCandidate,
  type PolicyFacts,
  windowRouter,
} from '@cortexkit/common-auth/limits'
import type { OAuthQuotaSnapshot } from '../accounts'
import { openAiRateLimitCommand } from '../limit-mark'
import {
  classifyOpenAiLimitBody,
  confirmedQuotaWindows,
  decideOpenAiLimit,
  openAiConfirmedBlockers,
  openAiHoldFacts,
  openAiLimitAxes,
  openAiSignalWindows,
  QUOTA_STALENESS_MS,
} from '../limit-policy'
import { LimitProvenanceStore } from '../limit-provenance'
import { normalizeQuotaHeaders } from '../quota-normalize'

const now = 1_800_000_000_000
const a = { namespace: 'policy', accountId: 'a', incarnation: '1' }
const b = { ...a, accountId: 'b' }
const iso = (delay: number) => new Date(now + delay).toISOString()
function reading(primary = 60000, secondary?: number): OAuthQuotaSnapshot {
  return {
    primary: {
      checkedAt: now,
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: iso(primary),
    },
    ...(secondary === undefined
      ? {}
      : {
          secondary: {
            checkedAt: now,
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: iso(secondary),
          },
        }),
  }
}
function candidate(quota = reading()): LimitCandidate {
  return {
    account: a,
    admitted: true,
    ready: false,
    placementEligible: true,
    blockers: [],
    confirmedBlockers: confirmedQuotaWindows(quota, now),
  }
}
function facts(current = candidate()): PolicyFacts {
  return {
    phase: 'after-limit',
    host: 'opencode1',
    now,
    clockNow: now,
    sessionId: 'session',
    requestScope: { kind: 'pool' },
    history: createRequestHistory({
      requestId: 'request',
      originalUrl: 'https://provider.invalid/responses',
      clockNow: now,
    }),
    attempted: a,
    status: 429,
    affinity: 'broken',
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [
      current,
      {
        account: b,
        admitted: true,
        ready: true,
        placementEligible: true,
        blockers: [],
      },
    ],
    selection: { account: b, pin: 'pin' },
    hold: openAiHoldFacts({
      candidate: current,
      activity: { accountKey: a, lastAcceptedAt: now, ttlMs: 300000 },
      now,
    }),
  }
}

test('expanded axes leave windowRouter unchanged and preserve untimed unknown policy', () => {
  const axes = openAiLimitAxes([401])
  expect(axes.shortLimit).toEqual({
    holdBound: 'cache-ttl',
    preference: 'same-account-first',
    jitter: 'none',
  })
  expect(axes.terminalMetadata).toBe('setting-capped-fresh')
  expect(axes.advance.opencode1.statuses).toEqual([401])
  expect(axes.advance.pi.statuses).toEqual([401])
  expect(axes.unknown).toEqual(windowRouter.unknown)
  expect(axes.markers.pi.kind).toBe('off')
  expect(axes.readingClearsCoveredScopes).toBe('off')
  expect(windowRouter.shortLimit.holdBound).toBe('disabled')
  expect(windowRouter.terminalMetadata).toBe('baseline')
})

describe('evidence-table confirmation', () => {
  test.each(['100', '100.0', '99.999'])(
    'raw header %s is normalized without rounding before confirmation',
    (value) => {
      const reading = normalizeQuotaHeaders(
        new Headers({ 'x-codex-primary-used-percent': value }),
      )
      expect(confirmedQuotaWindows(reading, Date.now())).toHaveLength(
        value === '99.999' ? 0 : 1,
      )
    },
  )
  test.each([100, Number('100.0'), 99.999])(
    'raw percentage %s is not rounded',
    (usedPercent) => {
      const quota = reading()
      quota.primary!.usedPercent = usedPercent
      expect(confirmedQuotaWindows(quota, now)).toHaveLength(
        usedPercent >= 100 ? 1 : 0,
      )
    },
  )
  test('stale readings never confirm and a fresh sibling cannot hide an unknown blocker', () => {
    const quota = reading(60000, 120000)
    quota.primary!.checkedAt = now - QUOTA_STALENESS_MS - 1
    expect(
      confirmedQuotaWindows(quota, now).map((window) => window.window),
    ).toEqual(['secondary'])
    const named = openAiSignalWindows({ window: 'primary' }, now, quota, now)
    expect(named).toMatchObject([
      { confirmed: true, resetAt: undefined, provenance: 'unproven' },
    ])
    const signal = classifyOpenAiLimitBody({
      account: a,
      body: {
        type: 'response.failed',
        response: { failed: { rate_limit_reached_type: 'primary' } },
      },
      reading: quota,
      now,
    })
    expect(openAiConfirmedBlockers(signal, quota, now)).toHaveLength(2)
    const current = {
      ...candidate(quota),
      confirmedBlockers: openAiConfirmedBlockers(signal, quota, now),
    }
    expect(decideOpenAiLimit(facts(current), { mode: 'sticky' })?.action).toBe(
      'reroute',
    )
  })
  test.each([undefined, 429])(
    'failed-event code/type confirms usage without status %s or reset',
    (status) => {
      for (const field of ['code', 'type']) {
        for (const reason of ['usage_limit_reached', 'rate_limit_exceeded']) {
          const signal = classifyOpenAiLimitBody({
            account: a,
            status,
            body: {
              type: 'response.failed',
              response: {
                error: { [field]: reason, resets_at: (now + 60000) / 1000 },
              },
            },
            now,
          })
          expect(signal?.windows[0]).toMatchObject({
            window: reason === 'usage_limit_reached' ? 'usage' : reason,
            confirmed: reason === 'usage_limit_reached',
            resetAt: undefined,
          })
        }
      }
    },
  )
  test('cloned raw body uses positive absolute before relative reset, not Retry-After', () => {
    const signal = classifyOpenAiLimitBody({
      account: a,
      status: 429,
      headers: new Headers({ 'retry-after': '1.5' }),
      body: '{"error":{"type":"usage_limit_reached","resets_at":1800000060,"resets_in_seconds":90}}',
      now,
    })
    expect(signal?.windows[0]).toEqual({
      window: 'usage',
      confirmed: true,
      confirmedByReading: false,
      resetAt: now + 60000,
      observedAt: now,
      provenance: 'provider',
    })
    expect(signal?.retryAfterMs).toBe(1500)
  })
  test.each([
    'rate_limit_exceeded',
    'capacity',
    'generic',
    'usage_limit_reached',
  ])('HTTP code-only %s and generic hints never confirm', (code) => {
    const signal = classifyOpenAiLimitBody({
      account: a,
      status: 429,
      headers: new Headers({ 'retry-after': '60' }),
      body: { error: { code } },
      now,
    })
    expect(signal?.windows.every((window) => !window.confirmed)).toBe(true)
  })
  test('resetless usage confirms but cannot hold; unrelated/auth bodies have no signal', () => {
    const signal = classifyOpenAiLimitBody({
      account: a,
      body: { error: { type: 'usage_limit_reached' } },
      now,
    })
    expect(signal?.windows[0]).toMatchObject({
      confirmed: true,
      resetAt: undefined,
    })
    expect(
      classifyOpenAiLimitBody({
        account: a,
        status: 401,
        body: { error: { type: 'auth' } },
        now,
      }),
    ).toBeUndefined()
    expect(
      classifyOpenAiLimitBody({
        account: a,
        status: 500,
        body: 'invalid',
        now,
      }),
    ).toBeUndefined()
  })
})

test.each(['opencode1', 'pi'] as const)(
  '%s holds at the cache bound but not one millisecond beyond it',
  (host) => {
    for (const [reset, action] of [
      [300000, 'hold'],
      [300001, 'reroute'],
    ] as const) {
      const decision = decideOpenAiLimit(
        { ...facts(candidate(reading(reset))), host },
        { mode: 'sticky' },
      )
      expect(decision?.action).toBe(action)
      if (decision?.action === 'hold') {
        expect(decision.delayMs).toBe(300000)
        expect(decision.resetAt).toBeUndefined()
      }
    }
  },
)

test('all blocking windows must fit, including a fresh 100 percent secondary', () => {
  expect(
    decideOpenAiLimit(facts(candidate(reading(60000, 120000))), {
      mode: 'sticky',
    })?.action,
  ).toBe('hold')
  expect(
    decideOpenAiLimit(facts(candidate(reading(60000, 4 * 86400000))), {
      mode: 'sticky',
    })?.action,
  ).toBe('reroute')
  for (const reset of [0, -1, NaN]) {
    const current = candidate()
    const windows = current.confirmedBlockers!.map((window) => ({
      ...window,
      resetAt: now + reset,
    }))
    expect(
      decideOpenAiLimit(facts({ ...current, confirmedBlockers: windows }), {
        mode: 'sticky',
      })?.action,
    ).toBe('reroute')
  }
})

test('setting zero, missing or changed activity and known TTL zero cannot hold', () => {
  const current = candidate()
  for (const activity of [
    undefined,
    { accountKey: b, lastAcceptedAt: now, ttlMs: 300000 },
    {
      accountKey: { ...a, incarnation: '2' },
      lastAcceptedAt: now,
      ttlMs: 300000,
    },
    { accountKey: a, lastAcceptedAt: now, ttlMs: 0 },
  ])
    expect(
      openAiHoldFacts({ candidate: current, activity, now }),
    ).toBeUndefined()
  expect(
    openAiHoldFacts({
      candidate: current,
      activity: { accountKey: a, lastAcceptedAt: now, ttlMs: 300000 },
      maxSameAccountWait: 0,
      now,
    }),
  ).toBeUndefined()
})

test('fifteen minutes caps a 30-minute cache while max and host caps remain independent', () => {
  const current = candidate(reading(1200000))
  const activity = { accountKey: a, lastAcceptedAt: now, ttlMs: 1800000 }
  const hold = (maxSameAccountWait: unknown, maxDelayMs?: number) =>
    openAiHoldFacts({
      candidate: current,
      activity,
      maxSameAccountWait,
      maxDelayMs,
      now,
    })
  expect(
    decideOpenAiLimit({ ...facts(current), hold: hold(15) }, { mode: 'sticky' })
      ?.action,
  ).toBe('reroute')
  const max = decideOpenAiLimit(
    { ...facts(current), hold: hold('max') },
    { mode: 'sticky' },
  )
  expect(max?.action).toBe('hold')
  if (max?.action === 'hold') expect(max.delayMs).toBe(1200000)
  expect(
    decideOpenAiLimit(
      { ...facts(current), hold: hold('max', 1199999) },
      { mode: 'sticky' },
    )?.action,
  ).toBe('reroute')
  expect(
    decideOpenAiLimit(
      { ...facts(current), hold: hold('max', 1200000) },
      { mode: 'sticky' },
    )?.action,
  ).toBe('hold')
})

test('concurrent later hard mark suppresses hold without changing admission or mark', () => {
  const current = {
    ...candidate(),
    blockers: [
      {
        kind: 'hard' as const,
        until: now + 4 * 86400000,
        cause: 'rate-limit' as const,
      },
    ],
  }
  const input = {
    ...facts(current),
    hold: { cacheExpiresAt: now + 300000, maxWaitMs: 900000 },
  }
  expect(decideOpenAiLimit(input, { mode: 'sticky' })?.action).toBe('reroute')
  expect(current.admitted).toBe(true)
  expect(current.blockers[0]?.until).toBe(now + 345600000)
  for (const until of [now + 59999, now + 60000])
    expect(
      decideOpenAiLimit(
        facts({ ...candidate(), blockers: [{ kind: 'hard', until }] }),
        { mode: 'sticky' },
      )?.action,
    ).toBe('hold')
})

test('provenance keeps the weaker equal-expiry branch and the captured evidence identity', () => {
  const store = new LimitProvenanceStore(a.namespace)
  const entry = {
    accountKey: a,
    expiry: now + 60000,
    evidenceAt: now,
    observedAt: now,
  }
  store.record({ ...entry, branch: 'reading' }, now)
  store.record({ ...entry, branch: 'provider' }, now)
  expect(store.read(a, now + 60000, now, now)?.branch).toBe('reading')
  store.record({ ...entry, branch: 'unproven', evidenceAt: now + 1 }, now)
  expect(store.read(a, now + 60000, now + 1, now)?.branch).toBe('unproven')
  expect(store.read(a, now + 60000, now, now)).toBeUndefined()
  expect(
    store.read({ ...a, incarnation: '2' }, now + 60000, now + 1, now),
  ).toBeUndefined()
  store.retire(a)
  expect(store.read(a, now + 60000, now + 1, now)).toBeUndefined()
})

test('provenance evicts expired first, then the lowest observedAt, at 256 per namespace', () => {
  const store = new LimitProvenanceStore(a.namespace)
  for (let index = 0; index < 256; index++)
    store.record(
      {
        accountKey: { ...a, accountId: String(index) },
        expiry: now + (index === 255 ? 1 : 60000),
        branch: 'provider',
        observedAt: now - index,
        evidenceAt: now,
      },
      now,
    )
  store.record(
    {
      accountKey: b,
      expiry: now + 60000,
      branch: 'provider',
      observedAt: now,
      evidenceAt: now,
    },
    now + 1,
  )
  expect(
    store.read({ ...a, accountId: '254' }, now + 60000, now, now + 1)?.branch,
  ).toBe('provider')
  store.record(
    {
      accountKey: a,
      expiry: now + 60000,
      branch: 'provider',
      observedAt: now,
      evidenceAt: now,
    },
    now + 1,
  )
  expect(
    store.read({ ...a, accountId: '254' }, now + 60000, now, now + 1),
  ).toBeUndefined()
  expect(
    store.read({ ...a, namespace: 'foreign' }, now + 60000, now, now),
  ).toBeUndefined()
  expect(store.read(a, now + 60000, now, now + 60000)).toBeUndefined()
  store.record(
    {
      accountKey: a,
      expiry: Infinity,
      branch: 'provider',
      observedAt: NaN,
      evidenceAt: now,
    },
    now,
  )
  expect(store.read(a, Infinity, now, now)).toBeUndefined()
})

test('one whole-account command matches resolver precedence without hold caps or false proof', () => {
  const base = {
    binding: { account: a, credentialEpoch: '1' },
    baseRevision: 2,
    producerId: 'producer',
    operationId: 'operation',
    reading: reading(7200000, 10800000),
    now,
    observedAt: now - 1,
    evidenceAt: now - 2,
  }
  for (const [window, explicit, source, expected, branch] of [
    [
      'usage_limit_reached',
      now + 7200000,
      'provider',
      now + 7200000,
      'provider',
    ],
    ['rate_limit', now + 1500, 'retry-after', now + 1500, 'unproven'],
    ['rate_limit', now, 'retry-after', now + 60000, 'unproven'],
    ['rate_limit', undefined, 'retry-after', now + 60000, 'unproven'],
    ['primary', undefined, 'provider', now + 7200000, 'reading'],
    ['secondary', undefined, 'provider', now + 10800000, 'reading'],
    ['primary', NaN, 'provider', now + 7200000, 'reading'],
    ['primary', now - 1, 'provider', now + 7200000, 'reading'],
    ['primary', now, 'provider', now + 7200000, 'reading'],
    ['capacity', undefined, 'provider', now + 60000, 'unproven'],
  ] as const) {
    const result = openAiRateLimitCommand({
      ...base,
      parsed: { window, resetAt: explicit },
      resetSource: source,
    })
    expect(result.command).toEqual({
      type: 'mark',
      binding: base.binding,
      baseRevision: 2,
      producerId: 'producer',
      operationId: 'operation',
      scope: { kind: 'pool' },
      window: 'account',
      cause: 'rate-limit',
      until: expected,
      evidenceAt: now - 2,
      mergeLaw: 'max-until',
    })
    expect(result.provenance.branch).toBe(branch)
    expect(result.provenance.observedAt).toBe(
      branch === 'reading' ? now : now - 1,
    )
  }
  const stale = reading(7200000)
  stale.primary!.checkedAt = now - QUOTA_STALENESS_MS - 1
  const result = openAiRateLimitCommand({
    ...base,
    reading: stale,
    parsed: { window: 'primary' },
  })
  expect(result.provenance.expiry).toBe(now + 7200000)
  expect(result.provenance.branch).toBe('unproven')
})

test.each(['opencode1', 'pi'] as const)(
  '%s permanent auth wins over parsed usage and fresh stored exhaustion',
  (host) => {
    for (const mode of ['ordered', 'sticky'] as const)
      for (const status of [401, 403]) {
        const signal = classifyOpenAiLimitBody({
          account: a,
          status,
          body: {
            error: { type: 'usage_limit_reached', resets_at: 1800000060 },
          },
          now,
        })
        const current = candidate()
        expect(
          openAiHoldFacts({
            candidate: current,
            activity: { accountKey: a, lastAcceptedAt: now, ttlMs: 300000 },
            status,
            now,
          }),
        ).toBeUndefined()
        const input = {
          ...facts(current),
          host,
          status,
          signal,
          hold: { cacheExpiresAt: now + 300000, maxWaitMs: 900000 },
        }
        expect(decideOpenAiLimit(input, { mode })?.action).toBe('reroute')
      }
  },
)

test('killswitch non-admission never holds even with fitting reset and cache', () => {
  const current = { ...candidate(), admitted: false }
  expect(facts(current).hold).toBeUndefined()
  expect(decideOpenAiLimit(facts(current), { mode: 'sticky' })?.action).toBe(
    'reroute',
  )
})

test('ordered fallback gate runs before reduction only for out-of-list statuses', () => {
  let calls = 0
  const decide = () => {
    calls++
    return {
      action: 'pass' as const,
      reason: 'test',
      retryable: false,
      hostRetry: 'leave' as const,
      history: createRequestHistory({
        requestId: 'request',
        originalUrl: 'https://provider.invalid/responses',
        clockNow: now,
      }),
    }
  }
  expect(
    decideOpenAiLimit(facts(), { mode: 'ordered', fallbackOn: [401], decide }),
  ).toBeUndefined()
  expect(calls).toBe(0)
  expect(
    decideOpenAiLimit(facts(), { mode: 'sticky', fallbackOn: [401], decide })
      ?.action,
  ).toBe('pass')
  expect(calls).toBe(1)
  const input = { ...facts(), candidates: [candidate()], selection: undefined }
  expect(decideOpenAiLimit(input, { mode: 'ordered' })?.action).toBe('hold')
  expect(decideOpenAiLimit(input, { mode: 'ordered', decide })?.action).toBe(
    'pass',
  )
  expect(calls).toBe(2)
})
