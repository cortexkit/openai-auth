import { describe, expect, spyOn, test } from 'bun:test'
import type { AccountKey, SessionActivity } from '@cortexkit/common-auth/limits'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  decideOpenAiLimit,
  type OpenAiLimitsOwner,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolAccountSource } from '../core/pool-account-source'
import {
  type PendingPoolHold,
  type PoolRequestContext,
  servePoolRequest,
} from '../core/pool-request'

const T0 = 1_800_000_000_000
const HOLD_BODY =
  '{"error":{"message":"OpenAI usage limit reached on this account. Waiting for it keeps the conversation\'s prompt cache. Retry in 1m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}'
const PROVIDER_BODY =
  '{ "error": { "type": "rate_limit_exceeded", "message": "original bytes" } }'

function quota(
  used = 10,
  reset = T0 + 60_000,
  checkedAt = T0,
  secondary?: number,
) {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent: used,
        resetsAt: new Date(reset).toISOString(),
        windowMinutes: 300,
      },
      ...(secondary === undefined
        ? []
        : [
            {
              scope: 'all',
              label: 'secondary',
              kind: 'reading',
              checkedAt,
              usedPercent: 100,
              resetsAt: new Date(secondary).toISOString(),
              windowMinutes: 10080,
            },
          ]),
    ],
  }
}
function row(id: string): PoolRow {
  return {
    id,
    enabled: true,
    candidate: true,
    type: 'oauth',
    identity: `chatgpt-${id}`,
    credentialEpoch: 1,
    credential: {
      type: 'oauth',
      access: `${id}-token`,
      refresh: `${id}-refresh`,
      expires: T0 + 86_400_000,
    },
    quota: quota(),
  } as PoolRow
}
function fixture(
  mode: 'main-first' | 'sticky-balanced' = 'main-first',
  count = 2,
) {
  let now = T0
  const rows = [row('main'), ...(count === 2 ? [row('b')] : [])]
  const keys = new Map(
    rows.map((value) => [
      value.id,
      {
        namespace: 'oc1-test',
        accountId: value.id,
        incarnation: '1',
      } as AccountKey,
    ]),
  )
  let activity: SessionActivity | undefined = {
    accountKey: keys.get('main')!,
    lastAcceptedAt: T0 - 1000,
    ttlMs: 300_000,
  }
  const pending = new Map<string, PendingPoolHold>()
  const marks = new Map<string, number>()
  const sent: string[] = []
  const decisions: Parameters<typeof decideOpenAiLimit>[0][] = []
  let pin = 'main'
  let reply = () =>
    new Response(
      JSON.stringify({
        error: { type: 'usage_limit_reached', resets_at: (T0 + 60_000) / 1000 },
      }),
      { status: 429 },
    )
  let record = () => {}
  const ctx: PoolRequestContext = {
    source: {
      current: async () => ({ rows }),
      peek: () => ({ rows }),
      prepareTokens: async () => {},
      usableToken: (value: PoolRow) => `${value.id}-token`,
      refreshBackoffFor: () => new Map(),
      requestReading: () => {},
    } as unknown as PoolAccountSource,
    rateLimitMarks: () => new Map(marks),
    storage: {
      version: 1,
      accounts: [],
      routing: { mode, maxSameAccountWait: 15 },
    },
    mode,
    sessionId: 'session',
    body: '{"model":"gpt-5.4","input":[]}',
    replayable: true,
    now: () => now,
    send: async (target, token) => {
      sent.push(`${target.id}:${token}`)
      return target.id === 'main' ? reply() : new Response('provider-b')
    },
    recordQuota: () => record(),
    placePin: (input) => {
      if (
        !input.excludeAccountIds.includes(pin) &&
        input.validPinnedAccountIds.includes(pin)
      )
        return { accountId: pin }
      const selected = input.select(new Map())
      if (selected && input.persist) pin = selected.accountId
      return selected
    },
    blocked: (block) => new Response(`legacy:${block.reason}`, { status: 429 }),
    resetCredits: () => undefined,
    isAbort: () => false,
    log: { debug() {} },
    limitPolicy: {
      pending,
      accountKey: (id) => keys.get(id),
      activity: () => activity,
      currentAccountKey: () => keys.get('main'),
      owner: () => undefined,
      decide: (facts, options) => {
        decisions.push(facts)
        return decideOpenAiLimit(facts, options)
      },
    },
  }
  return {
    ctx,
    rows,
    keys,
    pending,
    marks,
    sent,
    decisions,
    now: (value: number) => {
      now = value
    },
    activity: (value: SessionActivity | undefined) => {
      activity = value
    },
    reply: (value: () => Response) => {
      reply = value
    },
    record: (value: () => void) => {
      record = value
    },
    pin: () => pin,
    serve: () => servePoolRequest(ctx),
  }
}

for (const mode of ['main-first', 'sticky-balanced'] as const) {
  describe(`OC1 shared limit policy ${mode}`, () => {
    test('confirmed fitting HTTP reset returns pinned hold bytes and never waits or sends B', async () => {
      const f = fixture(mode)
      const result = await f.serve()
      expect(result.response.status).toBe(429)
      expect(result.response.headers.get('retry-after')).toBe('60')
      expect(await result.response.text()).toBe(HOLD_BODY)
      expect(f.sent).toEqual(['main:main-token'])
      expect(f.pending.get('session')).toMatchObject({
        model: 'gpt-5.4',
        target: T0 + 60_000,
        decidedAt: T0,
      })
      expect(f.decisions).toHaveLength(1)
      expect(f.pin()).toBe('main')
    })
    test('before-target reissue keeps target and returns rounded remaining delay without decision', async () => {
      const f = fixture(mode)
      await f.serve()
      const pending = f.pending.get('session')
      f.now(T0 + 10_001)
      const result = await f.serve()
      expect(result.response.headers.get('retry-after')).toBe('50')
      expect(f.pending.get('session')).toBe(pending)
      expect(f.decisions).toHaveLength(1)
      expect(f.sent).toHaveLength(1)
    })
    test('after-target wake lifts checkpoint exhaustion and sends A rather than ready B', async () => {
      const f = fixture(mode)
      f.record(() => f.marks.set('main', T0 + 60_000))
      await f.serve()
      f.rows[0]!.quota = quota(100, T0 + 60_000, T0 - 900_001)
      f.now(T0 + 60_000)
      f.reply(() => new Response('provider-a-sentinel'))
      const result = await f.serve()
      expect(await result.response.text()).toBe('provider-a-sentinel')
      expect(f.sent).toEqual(['main:main-token', 'main:main-token'])
      expect(f.pending.size).toBe(0)
      expect(f.decisions[1]?.wake?.checkpoint.blockers).toEqual([
        { window: 'usage', resetAt: T0 + 60_000 },
      ])
    })
    test('a login changed during the response cannot attach hold evidence to its replacement', async () => {
      const f = fixture(mode)
      f.record(() =>
        f.keys.set('main', { ...f.keys.get('main')!, incarnation: '2' }),
      )
      await f.serve()
      expect(f.pending.size).toBe(0)
      expect(f.decisions[0]?.hold).toBeUndefined()
      expect(f.decisions[0]?.attempted?.incarnation).toBe('1')
    })
    for (const status of [401, 403]) {
      test(`auth ${status} without a limit body never holds on a fresh exhausted reading`, async () => {
        const f = fixture(mode)
        f.reply(() => new Response('authentication refused', { status }))
        f.record(() => {
          f.rows[0]!.quota = quota(100)
        })
        expect(await (await f.serve()).response.text()).toBe('provider-b')
        expect(f.pending.size).toBe(0)
        expect(f.decisions[0]?.hold).toBeUndefined()
      })
      test(`auth ${status} beats fitting cache, exhausted reading and usage-limit body`, async () => {
        const f = fixture(mode)
        f.reply(
          () =>
            new Response(
              JSON.stringify({
                error: {
                  type: 'usage_limit_reached',
                  resets_at: (T0 + 60_000) / 1000,
                },
              }),
              { status },
            ),
        )
        f.record(() => {
          f.rows[0]!.quota = quota(100)
        })
        const result = await f.serve()
        expect(await result.response.text()).toBe('provider-b')
        expect(f.sent).toEqual(['main:main-token', 'b:b-token'])
        expect(f.pending.size).toBe(0)
        expect(f.decisions[0]?.hold).toBeUndefined()
      })
    }
    test('a concurrent longer hard mark vetoes hold without shortening or unadmitting A', async () => {
      const f = fixture(mode)
      f.record(() => {
        f.marks.set('main', T0 + 4 * 86_400_000)
      })
      const result = await f.serve()
      expect(await result.response.text()).toBe('provider-b')
      expect(f.pending.size).toBe(0)
      expect(f.marks.get('main')).toBe(T0 + 4 * 86_400_000)
      expect(f.decisions[0]?.candidates[0]?.admitted).toBe(true)
      expect(f.decisions[0]?.hold).toBeUndefined()
    })
    test('killswitch rejection on response prevents hold and migrates', async () => {
      const f = fixture(mode)
      f.ctx.storage!.killswitch = { enabled: true }
      f.record(() => {
        f.rows[0]!.quota = quota(100)
      })
      expect(await (await f.serve()).response.text()).toBe('provider-b')
      expect(f.pending.size).toBe(0)
      expect(f.decisions[0]?.hold).toBeUndefined()
    })
    for (const invalidation of [
      'setting-zero',
      'killswitch',
      'model',
      'incarnation',
      'authoritative-account',
      'credential',
      'withdrawn-row',
      'forget',
      'expired-cache',
      'shortened-bound',
    ] as const) {
      test(`early reissue drops ${invalidation} hold and selects normally without a new hold`, async () => {
        const f = fixture(mode)
        await f.serve()
        f.now(T0 + 10_000)
        f.rows[0]!.quota = quota(100)
        if (invalidation === 'setting-zero')
          f.ctx.storage!.routing!.maxSameAccountWait = 0
        if (invalidation === 'killswitch')
          f.ctx.storage!.killswitch = { enabled: true }
        if (invalidation === 'model') f.ctx.body = '{"model":"gpt-5.6"}'
        if (invalidation === 'incarnation')
          f.keys.set('main', { ...f.keys.get('main')!, incarnation: '2' })
        if (invalidation === 'authoritative-account')
          f.ctx.limitPolicy!.currentAccountKey = () => f.keys.get('b')
        if (invalidation === 'credential')
          f.ctx.source.usableToken = (row) =>
            row.id === 'main' ? undefined : 'b-token'
        if (invalidation === 'withdrawn-row') f.rows.shift()
        if (invalidation === 'forget') f.activity(undefined)
        if (invalidation === 'expired-cache')
          f.activity({
            accountKey: f.keys.get('main')!,
            lastAcceptedAt: T0 - 300_000,
            ttlMs: 300_000,
          })
        if (invalidation === 'shortened-bound')
          f.activity({
            accountKey: f.keys.get('main')!,
            lastAcceptedAt: T0,
            ttlMs: 20_000,
          })
        expect(await (await f.serve()).response.text()).toBe('provider-b')
        expect(f.pending.size).toBe(0)
        expect(f.sent).toEqual(['main:main-token', 'b:b-token'])
      })
    }
    for (const blocker of ['secondary', 'extended', 'missing-reset'] as const) {
      test(`wake rejects ${blocker} current blocker instead of lifting it`, async () => {
        const f = fixture(mode)
        await f.serve()
        f.now(T0 + 60_000)
        f.rows[0]!.quota =
          blocker === 'secondary'
            ? quota(100, T0 + 60_000, T0, T0 + 300_000)
            : quota(100, T0 + 300_000)
        if (blocker === 'missing-reset')
          delete (f.rows[0]!.quota as { limits: { resetsAt?: string }[] })
            .limits[0]!.resetsAt
        expect(await (await f.serve()).response.text()).toBe('provider-b')
        expect(f.pending.size).toBe(0)
      })
    }
  })
}

describe('OC1 ordered status boundary', () => {
  test("a different request kind cannot consume another kind's pending hold", async () => {
    const f = fixture()
    f.ctx.requestKind = 'responses:conversation'
    await f.serve()
    const key = JSON.stringify(['session', 'responses:conversation'])
    const original = f.pending.get(key)
    f.now(T0 + 10_000)
    f.ctx.requestKind = 'responses:auxiliary'
    await f.serve()
    expect(f.pending.get(key)).toBe(original)
    expect(f.pending.size).toBe(2)
    expect(f.decisions).toHaveLength(2)
    expect(f.sent).toEqual(['main:main-token', 'main:main-token'])
  })
  test('in-list confirmed no-next response calls the reducer without selection and holds', async () => {
    const f = fixture('main-first', 1)
    const result = await f.serve()
    expect(await result.response.text()).toBe(HOLD_BODY)
    expect(f.decisions).toHaveLength(1)
    expect(f.decisions[0]?.selection).toBeUndefined()
  })
  test('in-list unconfirmed no-next response calls the reducer and preserves every provider byte', async () => {
    const f = fixture('main-first', 1)
    f.reply(
      () =>
        new Response(PROVIDER_BODY, {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '1.5',
            'x-provider': 'original',
          },
        }),
    )
    const result = await f.serve()
    expect(await result.response.text()).toBe(PROVIDER_BODY)
    expect(result.response.status).toBe(429)
    expect([...result.response.headers]).toEqual([
      ['content-type', 'application/json'],
      ['retry-after', '1.5'],
      ['x-provider', 'original'],
    ])
    expect(f.decisions).toHaveLength(1)
    expect(f.decisions[0]?.selection).toBeUndefined()
    expect(f.pending.size).toBe(0)
  })
  for (const setting of [0, 15, 'max'] as const) {
    test(`out-of-list parsed 429 passes byte-exact with no decision at ${setting}`, async () => {
      const f = fixture()
      f.ctx.storage!.fallbackOn = [401]
      f.ctx.storage!.routing!.maxSameAccountWait = setting
      const body =
        '{ "error": {"type":"usage_limit_reached","resets_at":1800000060} }'
      f.reply(
        () =>
          new Response(body, { status: 429, headers: { 'x-original': 'yes' } }),
      )
      const result = await f.serve()
      expect(await result.response.text()).toBe(body)
      expect(result.response.headers.get('x-original')).toBe('yes')
      expect(f.sent).toEqual(['main:main-token'])
      expect(f.decisions).toHaveLength(0)
      expect(f.pending.size).toBe(0)
    })
  }
  test('an indeterminate fallback send keeps the prior provider response and never retries another account', async () => {
    const f = fixture()
    f.activity(undefined)
    f.ctx.send = async (target) => {
      f.sent.push(target.id)
      if (target.id === 'b') throw new Error('possibly sent')
      return new Response(PROVIDER_BODY, { status: 429 })
    }
    expect(await (await f.serve()).response.text()).toBe(PROVIDER_BODY)
    expect(f.sent).toEqual(['main', 'b'])
  })
  test('unreplayable requests never hold or send a fallback', async () => {
    const f = fixture()
    f.ctx.replayable = false
    expect((await f.serve()).response.status).toBe(429)
    expect(f.sent).toEqual(['main:main-token'])
    expect(f.pending.size).toBe(0)
    expect(f.decisions).toHaveLength(0)
  })
})

describe('OC1 sticky failure preservation', () => {
  test('unconfirmed 429 preserves pin and original bytes without a normalized retry duration', async () => {
    const f = fixture('sticky-balanced')
    f.reply(() => new Response(PROVIDER_BODY, { status: 429 }))
    const result = await f.serve()
    expect(await result.response.text()).toBe(PROVIDER_BODY)
    expect(result.response.headers.has('retry-after')).toBe(false)
    expect(f.pin()).toBe('main')
    expect(f.sent).toEqual(['main:main-token'])
    expect(f.pending.size).toBe(0)
  })
  test('confirmed 429 holds despite fallbackOn excluding 429', async () => {
    const f = fixture('sticky-balanced')
    f.ctx.storage!.fallbackOn = [401]
    expect(await (await f.serve()).response.text()).toBe(HOLD_BODY)
  })
  test('confirmed resetless 429 migrates without guessing a reset or creating a hold', async () => {
    const f = fixture('sticky-balanced')
    f.ctx.storage!.fallbackOn = [401]
    f.reply(() =>
      Response.json(
        { error: { type: 'usage_limit_reached' } },
        { status: 429 },
      ),
    )
    expect(await (await f.serve()).response.text()).toBe('provider-b')
    expect(f.pending.size).toBe(0)
    expect(f.pin()).toBe('b')
  })
})

describe('OC1 all-blockers hold bounds', () => {
  test('a reduced setting that still covers the remaining target preserves the original hold', async () => {
    const f = fixture()
    f.ctx.storage!.routing!.maxSameAccountWait = 'max'
    f.activity({
      accountKey: f.keys.get('main')!,
      lastAcceptedAt: T0,
      ttlMs: 1800_000,
    })
    f.reply(() =>
      Response.json(
        {
          error: {
            type: 'usage_limit_reached',
            resets_at: (T0 + 1200_000) / 1000,
          },
        },
        { status: 429 },
      ),
    )
    expect((await f.serve()).response.headers.get('retry-after')).toBe('1200')
    f.now(T0 + 600_000)
    f.ctx.storage!.routing!.maxSameAccountWait = 15
    expect((await f.serve()).response.headers.get('retry-after')).toBe('600')
    expect(f.pending.get('session')?.target).toBe(T0 + 1200_000)
    expect(f.decisions).toHaveLength(1)
    expect(f.sent).toEqual(['main:main-token'])
  })
  for (const value of ['100', '100.0', '99.999']) {
    test(`raw ${value} response reading is classified before detached quota publication`, async () => {
      const clock = spyOn(Date, 'now').mockReturnValue(T0)
      try {
        const f = fixture()
        f.reply(
          () =>
            new Response(PROVIDER_BODY, {
              status: 429,
              headers: {
                'x-codex-primary-used-percent': value,
                'x-codex-primary-reset-at': String((T0 + 60_000) / 1000),
                'x-codex-primary-window-minutes': '300',
              },
            }),
        )
        const result = await f.serve()
        expect(f.pending.size).toBe(value === '99.999' ? 0 : 1)
        expect(await result.response.text()).toBe(
          value === '99.999' ? 'provider-b' : HOLD_BODY,
        )
      } finally {
        clock.mockRestore()
      }
    })
  }
  test('a spent credit budget prevents holding even when the primary reset fits', async () => {
    const f = fixture()
    f.record(() => {
      f.rows[0]!.quota = {
        ...quota(100),
        budget: {
          kind: 'reading',
          checkedAt: T0,
          reached: true,
          remainingPercent: 0,
          resetsAt: new Date(T0 + 86_400_000).toISOString(),
        },
      }
    })
    await f.serve()
    expect(f.pending.size).toBe(0)
    expect(f.sent).toEqual(['main:main-token', 'b:b-token'])
  })
  for (const [name, secondary, hold] of [
    ['exact cache bound', T0 + 299_000, true],
    ['one millisecond over cache bound', T0 + 299_001, false],
    ['four day secondary', T0 + 4 * 86_400_000, false],
  ] as const) {
    test(name, async () => {
      const f = fixture()
      f.record(() => {
        f.rows[0]!.quota = quota(100, T0 + 60_000, T0, secondary)
      })
      const result = await f.serve()
      expect(f.pending.size).toBe(hold ? 1 : 0)
      expect(f.sent).toEqual(
        hold ? ['main:main-token'] : ['main:main-token', 'b:b-token'],
      )
      if (hold) expect(result.response.headers.get('retry-after')).toBe('299')
    })
  }
  for (const evidence of [
    'stale',
    'past',
    'missing',
    'different-activity',
    'zero-ttl',
    'zero-setting',
  ] as const) {
    test(`${evidence} cannot hold`, async () => {
      const f = fixture()
      if (evidence === 'stale') {
        f.reply(() => new Response(PROVIDER_BODY, { status: 429 }))
        f.record(() => {
          f.rows[0]!.quota = quota(100, T0 + 60_000, T0 - 900_001)
        })
      }
      if (evidence === 'past' || evidence === 'missing')
        f.reply(() =>
          Response.json(
            {
              error: {
                type: 'usage_limit_reached',
                ...(evidence === 'past' ? { resets_at: (T0 - 1) / 1000 } : {}),
              },
            },
            { status: 429 },
          ),
        )
      if (evidence === 'different-activity')
        f.activity({
          accountKey: f.keys.get('b')!,
          lastAcceptedAt: T0,
          ttlMs: 300_000,
        })
      if (evidence === 'zero-ttl')
        f.activity({
          accountKey: f.keys.get('main')!,
          lastAcceptedAt: T0,
          ttlMs: 0,
        })
      if (evidence === 'zero-setting')
        f.ctx.storage!.routing!.maxSameAccountWait = 0
      await f.serve()
      expect(f.pending.size).toBe(0)
      expect(f.sent).toEqual(['main:main-token', 'b:b-token'])
    })
  }
})

describe('OC1 pre-send terminal wire', () => {
  test('fresh provider mark uses the pinned 90-second retry and rounded reset text', async () => {
    const f = fixture('main-first', 1)
    f.marks.set('main', T0 + 90_000)
    const account = f.keys.get('main')!
    f.ctx.limitPolicy!.owner = () =>
      ({
        snapshot: () => ({
          marks: [
            {
              key: { account, window: 'account', scope: { kind: 'pool' } },
              entries: [{ until: T0 + 90_000, evidenceAt: T0 }],
            },
          ],
        }),
        provenance: { read: () => ({ branch: 'provider', observedAt: T0 }) },
      }) as unknown as OpenAiLimitsOwner
    const response = (await f.serve()).response
    expect(response.headers.get('retry-after')).toBe('90')
    expect(await response.text()).toBe(
      '{"error":{"message":"OpenAI rate limit reached — retrying on another account. Retry in 2m. Resets in 2m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
    expect(f.sent).toHaveLength(0)
  })
  for (const stale of [false, true]) {
    test(`max without activity uses five-minute hint and ${stale ? 'omits stale' : 'retains fresh'} reset text`, async () => {
      const f = fixture('main-first', 1)
      f.ctx.storage!.routing!.maxSameAccountWait = 'max'
      f.ctx.storage!.killswitch = { enabled: true }
      f.rows[0]!.quota = quota(
        100,
        T0 + 3 * 3600_000,
        stale ? T0 - 900_001 : T0,
      )
      f.activity(undefined)
      const response = (await f.serve()).response
      expect(response.headers.get('retry-after')).toBe('300')
      expect(await response.text()).toBe(
        stale
          ? '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 5m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}'
          : '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 5m. Resets in 3h 0m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
      )
      expect(f.sent).toHaveLength(0)
    })
  }
  for (const setting of [0, 15, 'max'] as const) {
    test(`unproven live mark uses pinned OA-36 wire at ${setting}`, async () => {
      const f = fixture('main-first', 1)
      f.ctx.storage!.routing!.maxSameAccountWait = setting
      f.marks.set('main', T0 + 90_000)
      const account = f.keys.get('main')!
      f.ctx.limitPolicy!.owner = () =>
        ({
          snapshot: () => ({
            marks: [
              {
                key: { account, window: 'account', scope: { kind: 'pool' } },
                entries: [{ until: T0 + 90_000, evidenceAt: T0 }],
              },
            ],
          }),
        }) as unknown as OpenAiLimitsOwner
      const response = (await f.serve()).response
      expect(response.status).toBe(setting === 0 ? 412 : 429)
      expect(response.headers.get('retry-after')).toBe(
        setting === 0 ? null : '300',
      )
      expect(await response.text()).toBe(
        setting === 0
          ? '{"error":{"code":412,"status":"FAILED_PRECONDITION","message":"Every OpenAI account is paused by OpenAI for now."}}'
          : '{"error":{"message":"OpenAI rate limit reached — retrying on another account. Retry in 5m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
      )
      expect(f.sent).toHaveLength(0)
      expect(f.pending.size).toBe(0)
    })
    test(`fresh killswitch scan uses max within A and min across accounts at ${setting}`, async () => {
      const f = fixture()
      f.ctx.storage!.routing!.maxSameAccountWait = setting
      f.ctx.storage!.killswitch = { enabled: true }
      f.rows[0]!.quota = quota(100, T0 + 2 * 3600_000, T0, T0 + 4 * 86_400_000)
      f.rows[1]!.quota = quota(100, T0 + 3 * 3600_000)
      f.activity({
        accountKey: f.keys.get('main')!,
        lastAcceptedAt: T0,
        ttlMs: 1800_000,
      })
      const response = (await f.serve()).response
      const message =
        setting === 0
          ? 'Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`). Resets in 3h 0m.'
          : setting === 15
            ? 'Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 15m. Resets in 3h 0m.'
            : 'Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 30m. Resets in 3h 0m.'
      expect(await response.text()).toBe(
        setting === 0
          ? JSON.stringify({
              error: { code: 412, status: 'FAILED_PRECONDITION', message },
            })
          : JSON.stringify({
              error: {
                message,
                type: 'rate_limit_exceeded',
                code: 'rate_limit_exceeded',
              },
            }),
      )
      expect(response.headers.get('retry-after')).toBe(
        setting === 0 ? null : setting === 15 ? '900' : '1800',
      )
      expect(f.sent).toHaveLength(0)
    })
  }
  test('unknown quota remains outside terminal refusal formatting', async () => {
    const f = fixture('main-first', 1)
    f.rows[0]!.quota = undefined
    expect(await (await f.serve()).response.text()).toBe('legacy:quota-unknown')
    expect(f.decisions).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })
})
