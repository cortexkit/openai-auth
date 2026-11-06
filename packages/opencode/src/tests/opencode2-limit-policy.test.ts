import { describe, expect, test } from 'bun:test'
import { createSessionActivityStore } from '@cortexkit/common-auth/limits'
import {
  type ChooseAccountInput,
  installOpenCode2Auth,
  OpenCode2AuthError,
} from '@cortexkit/common-auth/opencode2'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  LimitProvenanceStore,
} from '@cortexkit/openai-auth-core/internal'
import type { OpenCodeLimitSource } from '../core/limit-source'
import {
  createOpenAIAdapter,
  type OpenAILimitSignal,
  type PoolAccess,
  type VaultAccess,
} from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'

const T0 = 1_900_000_000_000

function quotaMap(usedPercent: number, checkedAt = T0) {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent,
        resetsAt: new Date(T0 + 120_000).toISOString(),
        windowMinutes: 300,
      },
    ],
  }
}

function fixture(
  ids = ['a', 'b'],
  setting: 0 | 15 | 'max' = 15,
  vault?: VaultAccess,
) {
  let now = T0
  const rows = ids.map((id) => ({
    id,
    type: 'oauth',
    enabled: true,
    candidate: true,
    hasEntry: true,
    needsFirstReading: false,
    credentialEpoch: 1,
    incarnation: 'one',
    identity: `chatgpt-${id}`,
    credential: {
      type: 'oauth',
      access: `${id}-token`,
      refresh: `${id}-refresh`,
    },
    quota: quotaMap(10, now),
  })) as PoolRow[]
  const accountKey = (id: string) => ({
    namespace: 'test',
    accountId: id,
    incarnation: `${rows.find((row) => row.id === id)?.credentialEpoch}`,
  })
  const activity = createSessionActivityStore()
  const provenance = new LimitProvenanceStore('test')
  const marks = new Map<string, number>()
  const registry = {}
  const bindings = () =>
    rows.map((row) => ({
      account: accountKey(row.id),
      identity: row.identity,
      credentialEpoch: row.credentialEpoch,
    }))
  const owner = {
    registry,
    provenance,
    snapshot: () => ({
      marks: [...marks].map(([id, until]) => ({
        key: {
          account: accountKey(id),
          scope: { kind: 'pool' },
          window: 'account',
        },
        entries: [{ until, evidenceAt: T0 }],
      })),
    }),
    observe: (binding: unknown) => ({ registry, binding, baseRevision: 0 }),
    dropSignal() {},
    afterProbe() {},
    enqueue: (
      command: {
        binding: { account: ReturnType<typeof accountKey> }
        until: number
      },
      annotation: Parameters<typeof provenance.record>[0],
    ) => {
      marks.set(command.binding.account.accountId, command.until)
      provenance.record(annotation, now)
    },
  }
  const limits = {
    activity,
    accountKey,
    bindings,
    ownershipBindings: bindings,
    owner: () => owner,
    marks: () => new Map([...marks].filter(([, until]) => until > now)),
    forRequest: async () => ({
      beforeDispatch: async () => ({ status: 'ready' }),
    }),
    forget: (session: string) => activity.forgetSession(session),
  } as unknown as OpenCodeLimitSource
  const storage = {
    version: 1,
    accounts: [],
    routing: { mode: 'main-first', maxSameAccountWait: setting },
  } as AccountStorage
  const source = {
    current: async () => ({ active: true, rows }),
    peek: () => ({ active: true, rows }),
    prepareTokens: async () => {},
    usableToken: (row: PoolRow) =>
      row.credential?.type === 'oauth' ? row.credential.access : undefined,
    refreshBackoffFor: () => new Map(),
    requestReading() {},
    recordSnapshot() {},
  } as PoolAccess
  const openai = createOpenAIAdapter({
    vault,
    source,
    limits,
    pins: new SessionPins(),
    storage: async () => storage,
    now: () => now,
  })
  const input = (
    extra: Partial<ChooseAccountInput> = {},
  ): ChooseAccountInput => ({
    providerID: 'openai',
    modelID: 'gpt-5.5',
    sessionID: 'ses_1',
    agent: 'build',
    kind: 'primary',
    phase: 'retry',
    previousAccountId: 'a',
    hostAttempt: 1,
    ...extra,
  })
  const signal = (delay?: number): OpenAILimitSignal => ({
    reason: 'usage',
    observedAt: T0,
    windows: [
      {
        window: 'usage',
        confirmed: true,
        confirmedByReading: false,
        observedAt: T0,
        provenance: 'provider',
        ...(delay === undefined ? {} : { resetAt: T0 + delay }),
      },
    ],
  })
  const retry = (delay?: number, extra: Partial<ChooseAccountInput> = {}) =>
    openai.adapter.chooseAccount(
      input({
        rerouteFrom: { accountId: 'a', limit: signal(delay) },
        ...extra,
      }),
    )
  const cache = (ttlMs = 300_000) =>
    activity.recordAccepted({
      sessionId: 'ses_1',
      accountKey: accountKey('a'),
      currentAccountKey: accountKey('a'),
      lastAcceptedAt: T0,
      ttlMs,
    })
  const mark = (id: string, delay: number, proven = true) => {
    marks.set(id, T0 + delay)
    if (proven)
      provenance.record(
        {
          accountKey: accountKey(id),
          expiry: T0 + delay,
          branch: 'provider',
          observedAt: T0,
          evidenceAt: T0,
        },
        now,
      )
  }
  return {
    openai,
    input,
    retry,
    signal,
    marks,
    mark,
    rows,
    storage,
    limits,
    cache,
    accountKey,
    tick: (ms: number) => {
      now = T0 + ms
    },
  }
}

describe('OpenCode 2 shared limit policy', () => {
  for (const setting of [0, 15, 'max'] as const) {
    test(`single-account confirmed OA-51 preserves host delay at ${setting}`, async () => {
      const f = fixture(['a'], setting)
      const host = fakeOpenCode2Host()
      const installation = await installOpenCode2Auth(
        host.ctx,
        f.openai.adapter,
      )
      f.openai.attach(installation)
      try {
        const draft = {
          ...scope(),
          request: new Request('http://codex.test/responses'),
        }
        await host.fire('http.request', draft)
        await host.fire('http.response', {
          ...scope(),
          request: draft.request,
          response: Response.json(
            { error: { type: 'usage_limit_reached' } },
            { status: 429 },
          ),
        })
        const retry = {
          sessionID: 'ses_1',
          model: scope().model,
          attempt: 1,
          error: { type: 'api', message: 'usage limit', status: 429 },
          decision: { retry: true, delay: 1234 },
        }
        await host.fire('retry', retry)
        expect(retry.decision).toEqual({ retry: true, delay: 1234 })
        expect(f.marks.get('a')).toBe(T0 + 60_000)
      } finally {
        await installation.dispose()
      }
    })
    test(`unknown terminal reset uses explicit disposition at ${setting}`, async () => {
      const f = fixture(['a', 'b'], setting)
      f.mark('b', 60_000, false)
      expect(await f.retry(undefined)).toEqual(
        setting === 0
          ? { hostRetry: 'veto' }
          : { waitThenReselect: { delayMs: 300_000 } },
      )
      expect(await f.retry(undefined, { hostAttempt: 10 })).toEqual({
        hostRetry: setting === 0 ? 'veto' : 'leave',
      })
    })
    test(`request terminal has only the safe json-412 message at ${setting}`, async () => {
      const f = fixture(['a', 'b'], setting)
      f.storage.killswitch = { enabled: true }
      for (const row of f.rows) row.quota = quotaMap(100, T0)
      try {
        await f.openai.adapter.chooseAccount(f.input({ phase: 'request' }))
        throw new Error('expected no-account')
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCode2AuthError)
        expect(error).toMatchObject({
          kind: 'no-account',
          message:
            'Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`). Resets in 2m.',
        })
        expect(String(error)).not.toContain('Retry in')
        expect(error).not.toHaveProperty('retryAfterMs')
      }
    })
  }

  test('case 16 scans B without holding A for its reset', async () => {
    const f = fixture()
    f.mark('b', 60_000)
    expect(await f.retry(120_000)).toEqual({
      waitThenReselect: { delayMs: 60_000 },
    })
    f.mark('b', 180_000)
    expect(await f.retry(120_000)).toEqual({
      hold: {
        delayMs: 120_000,
        target: T0 + 120_000,
        kind: 'terminal',
        checkpoint: {
          accountKey: f.accountKey('a'),
          decidedAt: T0,
          blockers: [{ window: 'usage', resetAt: T0 + 120_000 }],
        },
      },
    })
  })

  test('unmarked exhausted B remains a last-path reroute, not terminal', async () => {
    const f = fixture()
    f.rows[1]!.quota = quotaMap(100, T0)
    expect(await f.retry(120_000)).toBe('b')
  })

  test('terminal max leaves host decision above installer ceiling or without retry budget', async () => {
    const f = fixture(['a', 'b'], 'max')
    f.cache(7_200_000)
    f.mark('b', 8_000_000)
    expect(await f.retry(3_621_001)).toEqual({ hostRetry: 'leave' })
    expect(await f.retry(60_000, { hostAttempt: 10 })).toEqual({
      hostRetry: 'leave',
    })
  })

  test('cache bound equality holds; one millisecond past, new hard mark and zero setting reroute', async () => {
    const f = fixture()
    f.cache(60_000)
    expect(await f.retry(60_000)).toMatchObject({
      hold: { delayMs: 60_000, kind: 'hold' },
    })
    expect(await f.retry(60_001)).toBe('b')
    f.mark('a', 240_000)
    expect(await f.retry(60_000)).toBe('b')
    expect(f.marks.get('a')).toBe(T0 + 240_000)
    f.marks.clear()
    f.storage.routing!.maxSameAccountWait = 0
    expect(await f.retry(60_000)).toBe('b')
  })

  test('terminal wake does not need cache but cannot lift a new blocker', async () => {
    const f = fixture()
    f.mark('b', 180_000)
    const choice = await f.retry(60_000)
    expect(choice).toMatchObject({
      hold: { kind: 'terminal', delayMs: 60_000 },
    })
    if (!choice || typeof choice === 'string' || !('hold' in choice))
      throw new Error('expected terminal hold')
    f.tick(60_000)
    expect(
      await f.openai.adapter.chooseAccount(
        f.input({
          phase: 'request',
          wake: { ...choice.hold, target: choice.hold.target! },
        }),
      ),
    ).toBe('a')
    f.rows[0]!.quota = {
      limits: [
        ...quotaMap(10).limits,
        {
          ...quotaMap(100).limits[0]!,
          label: 'secondary',
          resetsAt: new Date(T0 + 240_000).toISOString(),
        },
      ],
    }
    f.marks.delete('b')
    expect(
      await f.openai.adapter.chooseAccount(
        f.input({
          phase: 'request',
          wake: { ...choice.hold, target: choice.hold.target! },
        }),
      ),
    ).toBe('b')
  })

  test('request wake reauthorizes vault custody and never uses a withdrawn receipt', async () => {
    let withdrawn = false
    const authorizations: string[] = []
    const vault = {
      authority: async () => 'vault',
      routes: () =>
        ['a', 'b'].map((id) => ({
          id,
          kind: 'oauth',
          identity: `chatgpt-${id}`,
          quota: quotaMap(10),
        })),
      identities: () => new Set(),
      authorize: async (id: string) => {
        authorizations.push(id)
        return withdrawn && id === 'a'
          ? undefined
          : {
              credentialId: id,
              accessToken: `fresh-${id}`,
              accountIdentity: `chatgpt-${id}`,
            }
      },
    } as unknown as VaultAccess
    const f = fixture(['a', 'b'], 15, vault)
    f.cache()
    const choice = await f.retry(60_000)
    expect(choice).toMatchObject({ hold: { kind: 'hold', delayMs: 60_000 } })
    expect(authorizations).toEqual([])
    if (!choice || typeof choice === 'string' || !('hold' in choice))
      throw new Error('expected hold')
    withdrawn = true
    f.tick(60_000)
    const accountId = await f.openai.adapter.chooseAccount(
      f.input({
        phase: 'request',
        wake: { ...choice.hold, target: choice.hold.target! },
      }),
    )
    expect(accountId).toBe('b')
    expect(authorizations).toEqual(['a', 'b'])
  })

  for (const change of [
    'none',
    'forgotten',
    'expired-cache',
    'setting-zero',
    'replacement',
    'credential',
    'killswitch',
    'retry-budget',
    'extended-reset',
  ] as const) {
    test(`cache wake revalidates ${change} before lifting the checkpoint`, async () => {
      const f = fixture()
      f.cache()
      const signal = f.signal(60_000)
      const named = {
        ...signal,
        windows: signal.windows.map((window) => ({
          ...window,
          window: 'primary',
        })),
      }
      const choice = await f.retry(60_000, {
        rerouteFrom: { accountId: 'a', limit: named },
      })
      if (!choice || typeof choice === 'string' || !('hold' in choice))
        throw new Error('expected hold')
      f.tick(60_000)
      f.rows[0]!.quota = {
        limits: [
          {
            ...quotaMap(100).limits[0]!,
            resetsAt: new Date(T0 + 60_000).toISOString(),
          },
        ],
      }
      if (change === 'forgotten') f.limits.forget('ses_1')
      if (change === 'expired-cache') f.tick(300_001)
      if (change === 'setting-zero') f.storage.routing!.maxSameAccountWait = 0
      if (change === 'replacement') f.rows[0]!.credentialEpoch = 2
      if (change === 'credential') f.rows[0]!.credential = undefined
      if (change === 'killswitch') {
        f.storage.killswitch = { enabled: true }
        f.rows[0]!.quota = quotaMap(99)
      }
      if (change === 'extended-reset') f.rows[0]!.quota = quotaMap(100)
      expect(
        await f.openai.adapter.chooseAccount(
          f.input({
            phase: 'request',
            hostAttempt: change === 'retry-budget' ? 10 : 1,
            wake: { ...choice.hold, target: choice.hold.target! },
          }),
        ),
      ).toBe(change === 'none' ? 'a' : 'b')
    })
  }

  test('cache hold is full delay and request wake revalidates cache, identity and blockers', async () => {
    const f = fixture()
    f.cache()
    const choice = await f.retry(60_000)
    expect(choice).toMatchObject({
      hold: { delayMs: 60_000, target: T0 + 60_000, kind: 'hold' },
    })
    if (!choice || typeof choice === 'string' || !('hold' in choice))
      throw new Error('expected hold')
    const wake = choice.hold
    f.tick(60_000)
    expect(
      await f.openai.adapter.chooseAccount(
        f.input({ phase: 'request', wake: { ...wake, target: wake.target! } }),
      ),
    ).toBe('a')
    f.rows[0]!.credentialEpoch = 2
    f.mark('a', 180_000)
    expect(
      await f.openai.adapter.chooseAccount(
        f.input({ phase: 'request', wake: { ...wake, target: wake.target! } }),
      ),
    ).toBe('b')
    f.rows[0]!.credentialEpoch = 1
    f.limits.forget('ses_1')
    expect(
      await f.openai.adapter.chooseAccount(
        f.input({ phase: 'request', wake: { ...wake, target: wake.target! } }),
      ),
    ).toBe('b')
  })

  test('one cache hold consumes one host retry and cannot chain', async () => {
    const f = fixture()
    f.cache()
    const host = fakeOpenCode2Host()
    const choices: ChooseAccountInput[] = []
    const installation = await installOpenCode2Auth(host.ctx, {
      ...f.openai.adapter,
      chooseAccount: (input) => {
        choices.push(input)
        return f.openai.adapter.chooseAccount(input)
      },
    })
    f.openai.attach(installation)
    try {
      const draft = {
        ...scope(),
        request: new Request('http://codex.test/responses'),
      }
      await host.fire('http.request', draft)
      await host.fire('http.response', {
        ...scope(),
        request: draft.request,
        response: Response.json(
          { error: { type: 'usage_limit_reached', resets_in_seconds: 60 } },
          { status: 429 },
        ),
      })
      const retry = {
        sessionID: 'ses_1',
        model: scope().model,
        attempt: 1,
        error: { type: 'api', message: 'usage limit', status: 429 },
        decision: { retry: true, delay: 1234 },
      }
      await host.fire('retry', retry)
      expect(retry.decision).toEqual({ retry: true, delay: 60_000 })
      f.tick(60_000)
      await host.fire('http.request', {
        ...scope(),
        request: new Request('http://codex.test/responses'),
      })
      expect(choices.map((choice) => choice.phase)).toEqual([
        'request',
        'retry',
        'request',
      ])
      expect(choices.at(-1)).toMatchObject({
        hostAttempt: 1,
        wake: { target: T0 + 60_000, kind: 'hold' },
      })
      expect(choices.filter((choice) => choice.phase === 'retry')).toHaveLength(
        1,
      )
    } finally {
      await installation.dispose()
    }
  })
})
