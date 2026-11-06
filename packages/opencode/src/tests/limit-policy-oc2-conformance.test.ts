import { describe, expect, test } from 'bun:test'
import {
  createSessionActivityStore,
  type LimitsCommand,
} from '@cortexkit/common-auth/limits'
import { installOpenCode2Auth } from '@cortexkit/common-auth/opencode2'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  LimitProvenanceStore,
} from '@cortexkit/openai-auth-core/internal'
import {
  type OpenCodeLimitSource,
  projectOpenCodeMarks,
} from '../core/limit-source'
import {
  createOpenAIAdapter,
  inspectCodexEvent,
  limitOfEvent,
  type PoolAccess,
} from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'

const NOW = 1_800_000_000_000

async function httpLimit(
  body: unknown,
  headers: Record<string, string> = {},
  options: {
    primaryReset?: number
    secondaryReset?: number
    retry?: boolean
    cache?: boolean
    markScope?: boolean
    checkedAt?: number
  } = {},
) {
  let now = NOW
  const row = {
    id: 'a',
    type: 'oauth',
    enabled: true,
    candidate: true,
    hasEntry: true,
    needsFirstReading: false,
    credentialEpoch: 1,
    identity: 'chatgpt-a',
    credential: { type: 'oauth', access: 'a-token', refresh: 'a-refresh' },
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          checkedAt: options.checkedAt ?? NOW,
          usedPercent: 10,
          resetsAt: new Date(
            options.primaryReset ?? NOW + 7_200_000,
          ).toISOString(),
          windowMinutes: 300,
        },
      ],
    },
  } as PoolRow
  if (options.secondaryReset !== undefined)
    (row.quota as { limits: unknown[] }).limits.push({
      scope: 'all',
      label: 'secondary',
      kind: 'reading',
      checkedAt: NOW,
      usedPercent: 10,
      resetsAt: new Date(options.secondaryReset).toISOString(),
      windowMinutes: 10080,
    })
  const rows =
    options.retry || options.markScope
      ? [
          row,
          {
            ...row,
            id: 'b',
            identity: 'chatgpt-b',
            quota: {
              limits: [
                {
                  scope: 'all',
                  label: 'primary',
                  kind: 'reading',
                  checkedAt: NOW,
                  usedPercent: 10,
                  resetsAt: new Date(NOW + 7_200_000).toISOString(),
                  windowMinutes: 300,
                },
              ],
            },
          } as PoolRow,
        ]
      : [row]
  const account = { namespace: 'conformance', accountId: 'a', incarnation: '1' }
  const accountKey = (id: string) => ({ ...account, accountId: id })
  const binding = { account, identity: 'chatgpt-a', credentialEpoch: '1' }
  const bindings = () =>
    rows.map((row) => ({
      account: accountKey(row.id),
      identity: row.identity,
      credentialEpoch: String(row.credentialEpoch),
    }))
  const commands: LimitsCommand[] = []
  const marks = new Map<string, number>()
  const registry = {}
  const provenance = new LimitProvenanceStore('conformance')
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
        entries: [{ until, evidenceAt: NOW }],
      })),
    }),
    observe: (binding: unknown) => ({ registry, binding, baseRevision: 0 }),
    enqueue: (
      command: LimitsCommand,
      annotation: Parameters<LimitProvenanceStore['record']>[0],
    ) => {
      commands.push(command)
      if (command.type === 'mark')
        marks.set(command.binding.account.accountId, command.until)
      provenance.record(annotation, NOW)
    },
    afterProbe() {},
    dropSignal() {
      throw new Error('owned feedback must retain its dispatch probe')
    },
  }
  const limits = {
    activity: createSessionActivityStore(),
    accountKey,
    bindings,
    ownershipBindings: bindings,
    owner: () => owner,
    marks: () =>
      projectOpenCodeMarks(
        owner.snapshot() as unknown as Parameters<
          typeof projectOpenCodeMarks
        >[0],
        bindings(),
        now,
      ),
    forRequest: async () => ({
      beforeDispatch: async () => ({ status: 'ready' }),
    }),
  } as unknown as OpenCodeLimitSource
  if (options.cache)
    limits.activity.recordAccepted({
      sessionId: 'ses_1',
      accountKey: account,
      currentAccountKey: account,
      lastAcceptedAt: NOW,
      ttlMs: 300_000,
    })
  const source = {
    current: async () => ({ active: true, rows }),
    peek: () => ({ active: true, rows }),
    prepareTokens: async () => {},
    usableToken: (row: PoolRow) => `${row.id}-token`,
    refreshBackoffFor: () => new Map(),
    requestReading() {},
    recordSnapshot() {},
  } as PoolAccess
  const openai = createOpenAIAdapter({
    source,
    limits,
    pins: new SessionPins(),
    storage: async () => ({
      version: 1,
      accounts: [],
      routing: { mode: 'main-first', maxSameAccountWait: 15 },
    }),
    now: () => now,
  })
  const host = fakeOpenCode2Host()
  const parse = openai.adapter.limitFromResponse!
  let signal: Awaited<ReturnType<typeof parse>>
  openai.adapter.limitFromResponse = async (input) => {
    signal = await parse(input)
    return signal
  }
  const installation = await installOpenCode2Auth(host.ctx, openai.adapter)
  openai.attach(installation)
  try {
    const draft = {
      ...scope(),
      request: new Request('http://codex.test/responses'),
    }
    await host.fire('http.request', draft)
    expect(draft.request.headers.get('authorization')).toBe('Bearer a-token')
    // The response supplies the exhausted sibling after A's admitted dispatch.
    if (options.secondaryReset !== undefined)
      (
        row.quota as { limits: { label: string; usedPercent: number }[] }
      ).limits.find((window) => window.label === 'secondary')!.usedPercent = 100
    const response = new Response(
      body === undefined ? '' : JSON.stringify(body),
      { status: 429, headers },
    )
    await host.fire('http.response', {
      ...scope(),
      request: draft.request,
      response,
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      type: 'mark',
      binding,
      window: 'account',
      cause: 'rate-limit',
    })
    const retry = {
      sessionID: 'ses_1',
      model: { providerID: 'openai', id: 'gpt-5.5' },
      attempt: 1,
      error: { type: 'api', message: 'usage limit', status: 429 },
      decision: { retry: true, delay: 1234 },
    }
    let nextBearer: string | null | undefined
    const markedBearers: Array<string | null> = []
    if (options.markScope) {
      for (const [model, at] of [
        ['gpt-5.5', NOW],
        ['gpt-5.6', NOW + 59_999],
        ['gpt-5.6', NOW + 60_000],
      ] as const) {
        now = at
        const next = {
          ...scope(`mark-${at}`),
          model: { ...scope().model, id: model },
          request: new Request('http://codex.test/responses'),
        }
        await host.fire('http.request', next)
        markedBearers.push(next.request.headers.get('authorization'))
      }
    }
    if (options.retry) {
      await host.fire('retry', retry)
      if (retry.decision.delay === 0) {
        const next = {
          ...scope(),
          request: new Request('http://codex.test/responses'),
        }
        await host.fire('http.request', next)
        nextBearer = next.request.headers.get('authorization')
      }
    }
    return {
      signal,
      command: commands[0],
      retry: retry.decision,
      nextBearer,
      markedBearers,
    }
  } finally {
    await installation.dispose()
  }
}

describe('OC2 limit-policy conformance', () => {
  test('OA-17 account mark survives model switch and expires exactly at equality', async () => {
    const f = await httpLimit(
      { error: { type: 'usage_limit_reached', resets_at: 1_800_000_060 } },
      {},
      { markScope: true },
    )
    expect(f.markedBearers).toEqual([
      'Bearer b-token',
      'Bearer b-token',
      'Bearer a-token',
    ])
  })

  test('OA-10 explicit future reset beats cached primary without a hold cap', async () => {
    const { command } = await httpLimit({
      error: { type: 'usage_limit_reached', resets_at: 1_800_086_400 },
    })
    expect(command).toMatchObject({ until: 1_800_086_400_000 })
  })

  test('OA-6/11 exact named cached reset resolves zero header even with stale healthy reading', async () => {
    const { signal, command } = await httpLimit(
      { error: { type: 'primary' } },
      { 'retry-after': '0' },
      { checkedAt: NOW - 900_001 },
    )
    expect(signal?.retryAfterMs).toBe(0)
    expect(command).toMatchObject({ until: 1_800_007_200_000 })
  })

  for (const error of [
    { type: 'capacity' },
    { code: 'turn_rate_limit_exceeded' },
    { message: 'slow down' },
  ]) {
    test(`OA-9 unnamed ${JSON.stringify(error)} does not borrow primary`, async () => {
      const { command } = await httpLimit({ error })
      expect(command).toMatchObject({ until: 1_800_000_060_000 })
    })
  }

  test('OA-43 default floor equality passes and a whole-account override replaces defaults', async () => {
    let remaining = { primary: 5, secondary: 10 }
    const rows = () =>
      ['a', 'b'].map((id) => ({
        id,
        type: 'oauth',
        enabled: true,
        candidate: true,
        hasEntry: true,
        needsFirstReading: false,
        credentialEpoch: 1,
        identity: `chatgpt-${id}`,
        credential: {
          type: 'oauth',
          access: `${id}-token`,
          refresh: `${id}-refresh`,
        },
        quota: {
          limits: ['primary', 'secondary'].map((label) => ({
            scope: 'all',
            label,
            kind: 'reading',
            checkedAt: NOW,
            usedPercent:
              id === 'a'
                ? 100 - remaining[label as keyof typeof remaining]
                : 10,
            resetsAt: new Date(NOW + 7_200_000).toISOString(),
            windowMinutes: label === 'primary' ? 300 : 10080,
          })),
        },
      })) as PoolRow[]
    const storage: AccountStorage = {
      version: 1,
      accounts: [],
      routing: { mode: 'main-first' },
      killswitch: { enabled: true },
    }
    const source = {
      current: async () => ({ active: true, rows: rows() }),
      peek: () => ({ active: true, rows: rows() }),
      prepareTokens: async () => {},
      usableToken: (row: PoolRow) => `${row.id}-token`,
      refreshBackoffFor: () => new Map(),
      requestReading() {},
      recordSnapshot() {},
    } as PoolAccess
    const adapter = createOpenAIAdapter({
      source,
      pins: new SessionPins(),
      storage: async () => storage,
      now: () => NOW,
    }).adapter
    const choose = () =>
      adapter.chooseAccount({
        providerID: 'openai',
        modelID: 'gpt-5.5',
        sessionID: 'floor',
        agent: 'build',
        kind: 'primary',
        phase: 'request',
      })
    expect(await choose()).toBe('a')
    remaining = { primary: 4.999, secondary: 10 }
    expect(await choose()).toBe('b')
    remaining = { primary: 5, secondary: 9.999 }
    expect(await choose()).toBe('b')
    storage.killswitch = {
      enabled: true,
      schema: 'floors-v1',
      defaults: { primary: 5, secondary: 10 },
      accounts: { a: { primary: 1 } },
    }
    remaining = { primary: 1, secondary: 1 }
    expect(await choose()).toBe('a')
  })

  for (const header of ['0', '-1', 'invalid', 'NaN', 'Infinity']) {
    test(`OA-12 equal primary reset with invalid or nonfuture explicit ${header} never borrows secondary`, async () => {
      const { command } = await httpLimit(
        { error: { type: 'primary' } },
        { 'retry-after': header },
        { primaryReset: NOW, secondaryReset: NOW + 7_200_000 },
      )
      expect(command).toMatchObject({ until: 1_800_000_060_000 })
    })
  }

  test('OA-49 original confirmed HTTP refusal without cache queues B at zero delay', async () => {
    const f = await httpLimit(
      { error: { type: 'usage_limit_reached', resets_at: 1_800_000_060 } },
      {},
      { retry: true },
    )
    expect(f.retry).toEqual({ retry: true, delay: 0 })
    expect(f.nextBearer).toBe('Bearer b-token')
  })

  test('OA-49 fitting-cache companion targets A for the maximum fitting blocker', async () => {
    const f = await httpLimit(
      { error: { type: 'usage_limit_reached', resets_at: 1_800_000_060 } },
      {},
      { retry: true, cache: true, secondaryReset: NOW + 120_000 },
    )
    expect(f.retry).toMatchObject({ retry: true, delay: 120_000 })
    expect(f.nextBearer).toBeUndefined()
  })

  test('OA-49 four-day blocker companion vetoes the same-account cache hold', async () => {
    const f = await httpLimit(
      { error: { type: 'usage_limit_reached', resets_at: 1_800_000_060 } },
      {},
      { retry: true, cache: true, secondaryReset: NOW + 345_600_000 },
    )
    expect(f.retry).toEqual({ retry: true, delay: 0 })
    expect(f.nextBearer).toBe('Bearer b-token')
  })

  test('OA-1 HTTP absolute reset beats both relative reset and Retry-After', async () => {
    const { signal, command } = await httpLimit(
      {
        error: {
          type: 'usage_limit_reached',
          resets_at: 1_800_000_090,
          resets_in_seconds: 600,
        },
      },
      { 'retry-after': '1200' },
    )
    expect(signal).toMatchObject({
      reason: 'usage_limit_reached',
      resetAt: 1_800_000_090_000,
      retryAfterMs: 90_000,
    })
    expect(command).toMatchObject({ until: 1_800_000_090_000 })
  })

  test('OA-2 HTTP relative reset uses the parser sample', async () => {
    const { signal, command } = await httpLimit({
      error: { type: 'usage_limit_reached', resets_in_seconds: 600 },
    })
    expect(signal?.retryAfterMs).toBe(600_000)
    expect(command).toMatchObject({ until: 1_800_000_600_000 })
  })

  test('OA-3 past positive body reset suppresses a future header but defaults the mark', async () => {
    const { signal, command } = await httpLimit(
      { error: { type: 'usage_limit_reached', resets_at: 1_799_999_999 } },
      { 'retry-after': '600' },
    )
    expect(signal?.retryAfterMs).toBe(0)
    expect(command).toMatchObject({ until: 1_800_000_060_000 })
  })

  test('OA-4 empty HTTP 429 does not borrow healthy primary reset', async () => {
    const { signal, command } = await httpLimit(undefined)
    expect(signal?.reason).toBe('rate_limit')
    expect(command).toMatchObject({ until: 1_800_000_060_000 })
  })

  test('OA-5 fractional numeric Retry-After is exactly 1500 milliseconds', async () => {
    const { signal, command } = await httpLimit(undefined, {
      'retry-after': '1.5',
    })
    expect(signal?.retryAfterMs).toBe(1500)
    expect(command).toMatchObject({ until: 1_800_000_001_500 })
  })

  test('OA-6 zero Retry-After is accepted but does not create a nonfuture mark', async () => {
    const { signal, command } = await httpLimit(undefined, {
      'retry-after': '0',
    })
    expect(signal?.retryAfterMs).toBe(0)
    expect(command).toMatchObject({ until: 1_800_000_060_000 })
  })

  for (const value of ['Fri, 15 Jan 2027 08:00:00 GMT', 'invalid', '-1']) {
    test(`OA-7 numeric-only Retry-After rejects ${value}`, async () => {
      const { signal, command } = await httpLimit(undefined, {
        'retry-after': value,
      })
      expect(signal?.retryAfterMs).toBeUndefined()
      expect(command).toMatchObject({ until: 1_800_000_060_000 })
    })
  }

  test('OA-8 retry-after-ms alone is ignored', async () => {
    const { signal, command } = await httpLimit(undefined, {
      'retry-after-ms': '1500',
    })
    expect(signal?.retryAfterMs).toBeUndefined()
    expect(command).toMatchObject({ until: 1_800_000_060_000 })
  })

  for (const field of ['code', 'type']) {
    for (const status of [undefined, 429]) {
      for (const reason of ['usage_limit_reached', 'rate_limit_exceeded']) {
        test(`OA-55 failed-event ${field}=${reason}, status=${status}`, () => {
          const event = {
            type: 'response.failed',
            ...(status === undefined ? {} : { status }),
            response: { error: { [field]: reason } },
          }
          const limit = limitOfEvent(event, NOW)
          expect(limit?.reason).toBe(reason)
          expect(limit?.resetAt).toBeUndefined()
          expect(limit?.retryAfterMs).toBeUndefined()
          expect(limit?.windows).toEqual([
            {
              window: reason === 'usage_limit_reached' ? 'usage' : reason,
              confirmed: reason === 'usage_limit_reached',
              confirmedByReading: false,
              resetAt: undefined,
              observedAt: NOW,
              provenance: 'unproven',
            },
          ])
          expect(inspectCodexEvent(JSON.stringify(event), NOW)).toEqual({
            limit,
          })
        })
      }
    }
  }

  test('OA-55 failed-event allow-list and code precedence reject unrelated errors', () => {
    for (const error of [
      { code: 'server_error' },
      { type: 'turn_rate_limit_exceeded' },
      { code: 'server_error', type: 'usage_limit_reached' },
    ]) {
      expect(
        limitOfEvent(
          { type: 'response.failed', status: 429, response: { error } },
          NOW,
        ),
      ).toBeUndefined()
    }
  })

  test('OA-50/55 lifecycle and quota are not output; function-call envelopes are output', () => {
    for (const type of [
      'response.created',
      'response.in_progress',
      'codex.notice',
      'error',
    ]) {
      expect(inspectCodexEvent(JSON.stringify({ type }), NOW)).toBeUndefined()
    }
    const quota = inspectCodexEvent(
      JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: { primary: { used_percent: 100 } },
      }),
      NOW,
    )
    expect(quota?.quota?.complete).toBe(true)
    expect(quota?.limit).toBeUndefined()
    expect(quota?.outputStarted).toBeUndefined()
    for (const event of [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', status: 'in_progress' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', status: 'completed' },
      },
      { type: 'response.output_text.delta', delta: 'visible' },
    ]) {
      expect(inspectCodexEvent(JSON.stringify(event), NOW)).toEqual({
        outputStarted: true,
      })
    }
  })
})
