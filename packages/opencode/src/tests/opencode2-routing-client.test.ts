import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { createSessionActivityStore } from '@cortexkit/common-auth/limits'
import {
  type Attempt,
  installOpenCode2Auth,
  OpenCode2AuthError,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import * as routingClient from '@cortexkit/common-auth/routing-accessor'
import {
  VAULT_MODE_REFUSALS,
  VAULT_ROUTING_REFUSAL_MESSAGE,
} from '@cortexkit/openai-auth-core/internal'
import type { OpenCodeLimitSource } from '../core/limit-source'
import type { OpenAIAttemptData } from '../v2/adapter'
import { SessionAccounts } from '../v2/session-accounts'
import { installPoolHooks } from '../v2/setup'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'
import {
  fixture,
  routingKey as key,
  placementRequest,
  quotaMap,
  restoreRoutingAccessor,
} from './fixtures/opencode2-routing'

afterEach(restoreRoutingAccessor)

for (const mode of ['ordered', 'sticky-balanced'] as const) {
  for (const code of [
    'account_limit_exhausted',
    'account_selection_refused',
    'account_selection_final',
  ]) {
    test(`OpenCode 2 routing refusal ${code} stops ${mode} before dispatch`, async () => {
      const accountFor = mock(async () => ({
        refused: {
          code,
          message: 'private account-429 at capacity; retry in 500 seconds',
          routing_code: 'private-account-429',
          retry_after_secs: 500,
        },
      }))
      Reflect.set(globalThis, key, () => ({ accountFor }))
      const env = fixture(true, mode)
      const before = structuredClone(env.storage)
      const host = fakeOpenCode2Host()
      const installation = await installOpenCode2Auth(
        host.ctx,
        env.openai.adapter,
      )
      env.openai.attach(installation)
      const providerFetch = mock(async () => new Response('ok'))
      const draftScope = scope(env.request.sessionID, 'primary')
      const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
      try {
        const error = await host
          .fire('model.request', { ...draftScope, headers })
          .then(() =>
            host.fire('http.request', {
              ...draftScope,
              request: new Request('https://codex.test/responses', { headers }),
            }),
          )
          .then(providerFetch)
          .then(
            () => undefined,
            (error: unknown) => error,
          )
        expect(error).toBeInstanceOf(OpenCode2AuthError)
        expect((error as Error).message).toBe(
          'Thalamus routing declined this request, so it was not sent.',
        )
        expect(accountFor).toHaveBeenCalledTimes(1)
        expect(providerFetch).not.toHaveBeenCalled()
        expect(env.authorized).toEqual([])
        expect(env.source.recordSnapshot).not.toHaveBeenCalled()
        expect(env.storage).toEqual(before)
        expect(env.pins.placementSnapshot().size).toBe(0)
        expect(env.openai.activeAccount(env.request.sessionID)).toBeUndefined()
      } finally {
        await installation.dispose()
        env.openai.dispose()
      }
    })
  }

  test(`OpenCode 2 uses eligible fleet advice for a fresh ${mode} choice`, async () => {
    let asks = 0
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => {
        asks++
        return { account_id: 'account-b' }
      },
    }))
    const env = fixture(true, mode)
    expect(await env.openai.adapter.chooseAccount(env.request)).toBe('vault:b')
    expect(env.authorized).toEqual(['vault:b'])
    expect(asks).toBe(1)
    if (mode === 'sticky-balanced') {
      expect(await env.openai.adapter.chooseAccount(env.request)).toBe(
        'vault:b',
      )
      expect(asks).toBe(1)
    }
  })
}

const shortPlacementRefusal = {
  refused: {
    code: 'account_selection_refused',
    routing_code: 'account_selection_unavailable',
    retry_after_secs: 3,
  },
}
const placementRefusalError = {
  kind: 'no-account',
  message: 'Thalamus routing declined this request, so it was not sent.',
}

test.each([
  ['ordered', 'b'],
  ['sticky-balanced', 'c'],
] as const)(
  'turn placement: %s asks once on turn two and uses route %s',
  async (mode, next) => {
    const env = await placementRequest(
      [{ account_id: 'account-b' }, { account_id: `account-${next}` }],
      { mode },
    )
    const { sessionID } = env.request
    env.routes.push({
      ...env.routes[0]!,
      id: 'vault:c',
      identity: 'account-c',
      credentialId: 'credential-c',
    })
    try {
      env.openai.beginTurn(sessionID)
      expect(await env.send()).toBe('Bearer vault:b-token')
      expect(accountAsks(env)).toHaveLength(1)

      env.openai.beginTurn(sessionID)
      expect(await env.send('title')).toBe('Bearer vault:b-token')
      expect(accountAsks(env)).toHaveLength(1)
      expect(await env.send()).toBe(`Bearer vault:${next}-token`)
      expect(accountAsks(env)).toHaveLength(2)
      expect(accountAsks(env)[1]).toEqual({
        provider: 'openai',
        modelId: 'gpt-5.5',
        hold_wait_max_s: 0,
        refusals: true,
        waits_for_capacity: true,
        request_id: expect.any(String),
        warm_credential: 'credential-b',
        candidates: {
          view_digest: expect.any(String),
          accounts: ['a', 'b', 'c'].map((id) => ({
            account_id: `account-${id}`,
            credential_id: `credential-${id}`,
          })),
        },
      })
      expect(env.openai.activeAccount(sessionID)).toBe(`vault:${next}`)
      if (mode === 'sticky-balanced')
        expect(env.pins.get(sessionID)).toBe('vault:c')
      for (const kind of [
        'primary',
        'title',
        'compaction',
        'generate',
      ] as const) {
        expect(await env.send(kind)).toBe(`Bearer vault:${next}-token`)
      }
      expect(accountAsks(env)).toHaveLength(2)
    } finally {
      await env.dispose()
    }
  },
)

function accountAsks(env: Awaited<ReturnType<typeof placementRequest>>) {
  return env.accountFor.mock.calls.map(([ask]) => ask)
}

function placementId(ask: unknown): string | undefined {
  return (ask as { request_id?: string } | undefined)?.request_id
}

test('turn placement: refusal on turn two sends nothing and keeps the recorded account', async () => {
  const env = await placementRequest([
    { account_id: 'account-b' },
    { refused: { code: 'account_selection_final' } },
  ])
  const { sessionID } = env.request
  try {
    env.openai.beginTurn(sessionID)
    expect(await env.send()).toBe('Bearer vault:b-token')
    env.openai.beginTurn(sessionID)
    await expect(env.send()).rejects.toMatchObject(placementRefusalError)
    expect(env.accountFor).toHaveBeenCalledTimes(2)
    expect(env.providerFetch).toHaveBeenCalledTimes(1)
    expect(env.authorized).toEqual(['vault:b'])
    expect(env.openai.activeAccount(sessionID)).toBe('vault:b')
    expect(env.pins.get(sessionID)).toBe('vault:b')
  } finally {
    await env.dispose()
  }
})

test('turn placement: reloaded adapter asks on the next prompt despite the shared account record', async () => {
  const sessionAccounts = new SessionAccounts()
  const options = { sessionAccounts, mode: 'ordered' } as const
  const before = await placementRequest([{ account_id: 'account-b' }], options)
  try {
    before.openai.beginTurn(before.request.sessionID)
    expect(await before.send()).toBe('Bearer vault:b-token')
  } finally {
    await before.dispose()
  }
  const reloaded = await placementRequest([null], options)
  const { sessionID } = reloaded.request
  try {
    expect(reloaded.openai.activeAccount(sessionID)).toBe('vault:b')
    expect(await reloaded.send()).toBe('Bearer vault:b-token')
    expect(reloaded.accountFor).not.toHaveBeenCalled()
    reloaded.openai.beginTurn(sessionID)
    expect(await reloaded.send()).toBe('Bearer vault:b-token')
    expect(accountAsks(reloaded)).toEqual([
      expect.objectContaining({ warm_credential: 'credential-b' }),
    ])
  } finally {
    await reloaded.dispose()
  }
})

test.each([
  ['every local choice blocked', false],
  ['an alternative with free quota', true],
] as const)(
  'turn placement: unmeasured quota is offered and followed with %s',
  async (_case, hasReadyAccount) => {
    const env = await placementRequest([{ account_id: 'account-b' }, null])
    const { sessionID } = env.request
    env.routes[1]!.quota = { limits: [] }
    if (!hasReadyAccount) env.routes[0]!.quota = { limits: [] }
    env.routes.push({
      ...env.routes[0]!,
      id: 'vault:c',
      identity: 'account-c',
      credentialId: 'credential-c',
      quota: quotaMap(99),
    })
    env.storage.killswitch = {
      enabled: true,
      schema: 'floors-v1',
      defaults: { primary: 25, secondary: 0 },
    }
    if (hasReadyAccount) env.storage.quota = { failClosedOnUnknownQuota: true }
    try {
      env.openai.beginTurn(sessionID)
      expect(await env.send()).toBe('Bearer vault:b-token')
      expect(env.pins.snapshot().get(sessionID)).toEqual({
        accountId: 'vault:b',
        inputBytes: 1,
        wireIdentity: 'account-b',
      })
      expect(accountAsks(env)).toEqual([
        expect.objectContaining({
          candidates: {
            view_digest: expect.any(String),
            accounts: [
              { account_id: 'account-a', credential_id: 'credential-a' },
              { account_id: 'account-b', credential_id: 'credential-b' },
            ],
          },
        }),
      ])
      // The tool step must stay on routing's account, even without a reading yet.
      expect(await env.send()).toBe('Bearer vault:b-token')
      expect(env.accountFor).toHaveBeenCalledTimes(1)
      env.openai.beginTurn(sessionID)
      expect(await env.send()).toBe('Bearer vault:b-token')
      expect(accountAsks(env)[1]).toMatchObject({
        warm_credential: 'credential-b',
      })
      expect(env.authorized).toEqual(['vault:b', 'vault:b', 'vault:b'])
    } finally {
      await env.dispose()
    }
  },
)

test.each(['floor', 'declined', 'authorization'] as const)(
  'turn placement: a %s refusal on the routed account does not send on another account',
  async (refusal) => {
    const env = await placementRequest([{ account_id: 'account-b' }])
    try {
      expect(await env.send()).toBe('Bearer vault:b-token')
      if (refusal === 'floor') {
        env.storage.killswitch = {
          enabled: true,
          schema: 'floors-v1',
          defaults: { primary: 25 },
        }
        env.routes[1]!.quota = quotaMap(99)
      } else if (refusal === 'declined') env.routes.pop()
      else env.refused.add('vault:b')
      await expect(env.send()).rejects.toMatchObject({
        kind: 'no-account',
        message: VAULT_MODE_REFUSALS['vault-refused'],
      })
      expect(env.accountFor).toHaveBeenCalledTimes(1)
      expect(env.providerFetch).toHaveBeenCalledTimes(1)
      expect(env.authorized).toEqual(
        refusal === 'authorization' ? ['vault:b', 'vault:b'] : ['vault:b'],
      )
    } finally {
      await env.dispose()
    }
  },
)

test('without a routing accessor the unknown-quota block still stops before dispatch', async () => {
  const env = await placementRequest([])
  Reflect.deleteProperty(globalThis, key)
  for (const route of env.routes) route.quota = { limits: [] }
  try {
    env.openai.beginTurn(env.request.sessionID)
    await expect(env.send()).rejects.toMatchObject({
      kind: 'no-account',
      message: 'openai primary request refused (no-account)',
    })
    expect(env.accountFor).not.toHaveBeenCalled()
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
  } finally {
    await env.dispose()
  }
})

test.each(['primary', 'title', 'compaction', 'generate'] as const)(
  'short first placement refusal waits before routing a %s request to B',
  async (kind) => {
    const pick = Promise.withResolvers<{ account_id: string }>()
    const env = await placementRequest([shortPlacementRefusal, pick.promise])
    env.storage.killswitch = {
      enabled: true,
      schema: 'floors-v1',
      defaults: { primary: 25, secondary: 0 },
    }
    try {
      const sent = env.send(kind)
      const wait = await env.waitBeforeSend(sent)
      expect(wait.delay).toBe(3000)
      expect(env.accountFor).toHaveBeenCalledTimes(1)
      expect(env.providerFetch).not.toHaveBeenCalled()
      expect(env.authorized).toEqual([])
      env.routes[0]!.quota = quotaMap(99)
      wait.wake()
      await Promise.race([env.secondAsk, sent])
      expect(env.providerFetch).not.toHaveBeenCalled()
      expect(env.authorized).toEqual([])
      pick.resolve({ account_id: 'account-b' })
      expect(await sent).toBe('Bearer vault:b-token')
      expect(env.providerFetch).toHaveBeenCalledTimes(1)
      expect(env.authorized).toEqual(['vault:b'])
      expect(env.accountFor).toHaveBeenCalledTimes(2)
      const first = env.accountFor.mock.calls[0]?.[0] as {
        candidates: { accounts: unknown[] }
      }
      expect(first.candidates.accounts).toHaveLength(2)
      expect(first).not.toHaveProperty('mode')
      expect(placementId(env.accountFor.mock.calls[1]?.[0])).not.toBe(
        placementId(first),
      )
      expect(env.accountFor.mock.calls[1]?.[0]).toEqual({
        ...first,
        request_id: expect.any(String),
        candidates: {
          view_digest: expect.any(String),
          accounts: [
            { account_id: 'account-b', credential_id: 'credential-b' },
          ],
        },
      })
      expect(env.openai.activeAccount(env.request.sessionID)).toBe(
        kind === 'primary' ? 'vault:b' : undefined,
      )
    } finally {
      await env.dispose()
    }
  },
)

test('a second short first placement refusal stops without another wait', async () => {
  const env = await placementRequest([
    shortPlacementRefusal,
    shortPlacementRefusal,
  ])
  try {
    const sent = env.send()
    const wait = await env.waitBeforeSend(sent)
    wait.wake()
    await expect(sent).rejects.toMatchObject(placementRefusalError)
    expect(env.accountFor).toHaveBeenCalledTimes(2)
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
  } finally {
    await env.dispose()
  }
})

test('no answer after the five-second placement wait uses the local vault choice', async () => {
  const env = await placementRequest([
    { refused: { code: 'account_selection_refused', retry_after_secs: 5 } },
    undefined,
  ])
  env.routes.pop()
  try {
    const sent = env.send()
    const wait = await env.waitBeforeSend(sent)
    expect(wait.delay).toBe(5000)
    wait.wake()
    expect(await sent).toBe('Bearer vault:a-token')
    expect(env.accountFor).toHaveBeenCalledTimes(2)
  } finally {
    await env.dispose()
  }
})

test('losing all vault routes during a placement wait keeps the local no-account refusal', async () => {
  const env = await placementRequest([shortPlacementRefusal])
  try {
    const sent = env.send()
    const wait = await env.waitBeforeSend(sent)
    env.routes.length = 0
    wait.wake()
    await expect(sent).rejects.toMatchObject({
      kind: 'no-account',
      message: VAULT_MODE_REFUSALS['vault-unreachable'],
    })
    expect(env.accountFor).toHaveBeenCalledTimes(1)
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
  } finally {
    await env.dispose()
  }
})

test.each([
  ['six-second selection refusal', 'account_selection_refused', 6],
  ['zero-second selection refusal', 'account_selection_refused', 0],
  ['selection refusal without a delay', 'account_selection_refused', undefined],
  ['final selection refusal', 'account_selection_final', 3],
  ['account limit exhaustion', 'account_limit_exhausted', 3],
] as const)(
  'first placement stops immediately on %s',
  async (_name, code, seconds) => {
    const env = await placementRequest([
      { refused: { code, retry_after_secs: seconds } },
    ])
    try {
      await expect(Promise.race([env.wait, env.send()])).rejects.toMatchObject(
        placementRefusalError,
      )
      expect(env.accountFor).toHaveBeenCalledTimes(1)
      expect(env.providerFetch).not.toHaveBeenCalled()
      expect(env.authorized).toEqual([])
    } finally {
      await env.dispose()
    }
  },
)

test('aborting the HTTP request during the first placement wait stops before another ask', async () => {
  const env = await placementRequest([shortPlacementRefusal])
  try {
    const sent = env.send('title')
    await env.waitBeforeSend(sent)
    env.controller.abort(new Error('custom cancellation reason'))
    const error = await sent.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DOMException)
    expect(error).toHaveProperty('name', 'AbortError')
    expect(env.accountFor).toHaveBeenCalledTimes(1)
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
  } finally {
    await env.dispose()
  }
})

test.each(['resumed', 'cancelled', 'abandoned'] as const)(
  'short placement-refusal retry pairs the wait when %s',
  async (outcome) => {
    const at = 1_900_000_000_000
    const report = mock((_report: Record<string, unknown>) => {})
    const env = await placementRequest(
      [shortPlacementRefusal, { account_id: 'account-b' }],
      { report, now: () => at },
    )
    try {
      const sent = env.send()
      const { wake } = await env.waitBeforeSend(sent)
      const start = {
        kind: 'wait',
        phase: 'start',
        reason: 'account_free',
        next_ms: at + 3000,
        wait_id: expect.any(String),
        attempt: 1,
        message: 'Waiting for an account to come free',
      }
      expect(report.mock.calls.map(([value]) => value)).toEqual([start])
      if (outcome === 'resumed') {
        wake()
        expect(await sent).toBe('Bearer vault:b-token')
      } else {
        if (outcome === 'cancelled') env.controller.abort()
        else env.openai.beginTurn(env.request.sessionID)
        await expect(sent).rejects.toMatchObject(
          outcome === 'cancelled'
            ? { name: 'AbortError' }
            : placementRefusalError,
        )
        wake()
        expect(env.accountFor).toHaveBeenCalledTimes(1)
        expect(env.providerFetch).not.toHaveBeenCalled()
      }
      expect(report.mock.calls.map(([value]) => value)).toEqual([
        start,
        { ...report.mock.calls[0]![0], phase: 'end', outcome },
      ])
    } finally {
      await env.dispose()
    }
  },
)

test.each(['resumed', 'cancelled', 'abandoned'] as const)(
  'routing same-account hold pairs the wait when %s',
  async (outcome) => {
    let now = 1_900_000_000_000
    const at = now
    const reports: Record<string, unknown>[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => ({ account_id: 'account-b' }),
      report: (report: Record<string, unknown>) => {
        if (report.kind === 'wait') reports.push(report)
      },
    }))
    const env = fixture(true, 'ordered', () => now)
    const host = fakeOpenCode2Host()
    const installation = await installPoolHooks(host.ctx, env.openai.adapter, {
      warn() {},
    })
    env.openai.attach(installation)
    const { sessionID } = env.request
    const requestScope = scope(sessionID)
    const send = () =>
      host.fire('http.request', {
        ...requestScope,
        request: new Request('https://codex.test/responses', {
          headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
        }),
      })
    try {
      const { request } = await send()
      const response = await host.fire('http.response', {
        ...requestScope,
        request,
        response: new Response('{}', {
          status: 403,
          headers: { 'retry-after-ms': '3000' },
        }),
      })
      await response.response.text()
      const retry = await host.fire('retry', {
        ...requestScope,
        attempt: 1,
        decision: { retry: false },
        error: { type: 'api', status: 403, message: '{}' },
      })
      const decision: { retry: boolean; delay?: number } = retry.decision
      expect(decision).toEqual({ retry: true, delay: 3000 })
      expect(reports).toEqual([
        {
          kind: 'wait',
          phase: 'start',
          reason: 'account_limit',
          next_ms: at + 3000,
          wait_id: expect.any(String),
          attempt: 1,
          message: 'Waiting for the account limit to reset',
        },
      ])
      if (outcome === 'resumed') {
        now += 3000
        expect((await send()).request.headers.get('authorization')).toBe(
          'Bearer vault:b-token',
        )
        expect(env.authorized).toEqual(['vault:b', 'vault:b'])
      } else {
        if (outcome === 'cancelled')
          await host.publish('session.status', {
            sessionID,
            status: { type: 'idle' },
          })
        else env.openai.beginTurn(sessionID)
        expect(env.authorized).toEqual(['vault:b'])
      }
      expect(reports).toEqual([
        reports[0]!,
        { ...reports[0], phase: 'end', outcome },
      ])
      env.openai.beginTurn(sessionID)
      expect(reports).toHaveLength(2)
    } finally {
      await installation.dispose()
      env.openai.dispose()
    }
  },
)

test('capacity placement re-asks with the same id, reports account_free, and uses a fresh id next turn', async () => {
  const start = Date.now()
  let now = start
  const report = mock((_payload: Record<string, unknown>) => {})
  const env = await placementRequest(
    [
      { refused: { code: 'concurrency_full', resets_at_ms: start + 6000 } },
      { account_id: 'account-b' },
      { account_id: 'account-a' },
    ],
    { now: () => now, report },
  )
  try {
    const sent = env.send()
    const wait = await env.waitBeforeSend(sent)
    expect(wait.delay).toBe(6000)
    expect(env.accountFor).toHaveBeenCalledTimes(1)
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
    const firstId = placementId(accountAsks(env)[0])
    expect(typeof firstId).toBe('string')
    expect(accountAsks(env)[0]).toHaveProperty('waits_for_capacity', true)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'wait',
        phase: 'start',
        reason: 'account_free',
        next_ms: start + 6000,
        wait_id: expect.any(String),
      }),
    )
    now += wait.delay
    wait.wake()
    expect(await sent).toBe('Bearer vault:b-token')
    const waits = report.mock.calls
      .map(([payload]) => payload)
      .filter((value) => value.kind === 'wait')
    expect(waits).toHaveLength(2)
    expect(waits[1]).toEqual({ ...waits[0], phase: 'end', outcome: 'resumed' })
    expect(accountAsks(env)[1]).toEqual(accountAsks(env)[0])
    env.openai.beginTurn(env.request.sessionID)
    expect(await env.send()).toBe('Bearer vault:a-token')
    const nextId = placementId(accountAsks(env)[2])
    expect(typeof nextId).toBe('string')
    expect(nextId).not.toBe(firstId)
  } finally {
    await env.dispose()
  }
})

test('capacity placement stops and reports cancellation on HTTP abort', async () => {
  const now = Date.now()
  const report = mock((_payload: Record<string, unknown>) => {})
  const env = await placementRequest(
    [{ refused: { code: 'concurrency_full', resets_at_ms: now + 6000 } }],
    { now: () => now, report },
  )
  try {
    const sent = env.send()
    await env.waitBeforeSend(sent)
    env.controller.abort()
    await expect(sent).rejects.toHaveProperty('name', 'AbortError')
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'wait',
        phase: 'end',
        reason: 'account_free',
        outcome: 'cancelled',
      }),
    )
    expect(env.accountFor).toHaveBeenCalledTimes(1)
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
  } finally {
    await env.dispose()
  }
})

function capacityClock(start: number) {
  let now = start
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending = new Map<
    ReturnType<typeof setTimeout>,
    { at: number; run: () => void }
  >()
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((
    run: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === undefined || delay < 60_000)
      return realSetTimeout(run, delay, ...args)
    const timer = realSetTimeout(() => {}, delay)
    realClearTimeout(timer)
    pending.set(timer, { at: now + delay, run })
    return timer
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(
    (timer) => {
      const handle = timer as ReturnType<typeof setTimeout> | undefined
      if (handle !== undefined) pending.delete(handle)
      realClearTimeout(handle)
    },
  )
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
      for (const [timer, { at, run }] of pending) {
        if (at > now) continue
        pending.delete(timer)
        run()
      }
    },
    restore() {
      set.mockRestore()
      clear.mockRestore()
    },
  }
}

test.each(['first ask', 'announced sleep', 'HTTP request signal'] as const)(
  'capacity placement at the ten-minute deadline: %s',
  async (scenario) => {
    // These times are independent of the adapter's deadline constant.
    const start = Date.now()
    const clock = capacityClock(start)
    const http = scenario === 'HTTP request signal'
    const firstAsk = scenario === 'first ask'
    const entered = Promise.withResolvers<void>()
    const late = Promise.withResolvers<{ account_id: string }>()
    const account = { account_id: 'account-b' }
    const accountFor = mock(async () => {
      if (accountFor.mock.calls.length > 1) return account
      if (firstAsk) {
        entered.resolve()
        return late.promise
      }
      return {
        refused: { code: 'concurrency_full', resets_at_ms: start + 1_200_000 },
      }
    })
    const report = mock((payload: Record<string, unknown>) => {
      if (payload.kind === 'wait' && payload.phase === 'start')
        entered.resolve()
    })
    Reflect.set(globalThis, key, () => ({ accountFor, report }))
    const env = fixture(true, 'sticky-balanced', clock.now)
    const host = fakeOpenCode2Host()
    const controller = new AbortController()
    const providerSend = mock(() => {})
    const installation = await installPoolHooks(host.ctx, env.openai.adapter, {
      warn() {},
      info() {},
    })
    env.openai.attach(installation)
    try {
      const requestScope = scope(env.request.sessionID)
      const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
      const hook = http
        ? host.fire('http.request', {
            ...requestScope,
            request: new Request('https://codex.test/responses', {
              headers,
              signal: controller.signal,
            }),
          })
        : host.fire('experimental.ws.handshake', {
            ...requestScope,
            url: 'wss://chatgpt.com/backend-api/codex/responses',
            headers,
          })
      const outcome = hook.then(providerSend, (error: unknown) => error)
      const observe = () =>
        Promise.race([
          outcome,
          new Promise((resolve) => setImmediate(() => resolve('pending'))),
        ])
      expect(await Promise.race([entered.promise, outcome])).toBeUndefined()
      clock.advance(599_999)
      expect(await observe()).toBe('pending')
      clock.advance(1)
      if (http) {
        expect(await observe()).toBe('pending')
        controller.abort()
        expect(await observe()).toHaveProperty('name', 'AbortError')
      } else {
        const error = await observe()
        expect(error).toBeInstanceOf(OpenCode2AuthError)
        expect(error).toMatchObject({
          kind: 'no-account',
          message: VAULT_ROUTING_REFUSAL_MESSAGE,
        })
      }

      late.resolve(account)
      clock.advance(600_000)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(accountFor).toHaveBeenCalledTimes(1)
      expect(providerSend).not.toHaveBeenCalled()
      expect(env.authorized).toEqual([])
      expect(env.openai.activeAccount(env.request.sessionID)).toBeUndefined()
      const waits = report.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload.kind === 'wait')
      if (firstAsk) expect(waits).toEqual([])
      else {
        const started = waits[0]!
        expect(started).toMatchObject({
          phase: 'start',
          reason: 'account_free',
        })
        expect(waits).toEqual([
          started,
          {
            ...started,
            phase: 'end',
            outcome: http ? 'cancelled' : 'abandoned',
          },
        ])
      }
    } finally {
      controller.abort()
      await installation.dispose()
      env.openai.dispose()
      clock.restore()
    }
  },
)

test('capacity placement does not use a credential that changed while waiting', async () => {
  const now = Date.now()
  const env = await placementRequest(
    [
      { refused: { code: 'concurrency_full', resets_at_ms: now + 6000 } },
      { account_id: 'account-b' },
    ],
    { now: () => now },
  )
  try {
    const sent = env.send()
    const wait = await env.waitBeforeSend(sent)
    env.routes[1]!.credentialId = 'replacement'
    wait.wake()
    await expect(sent).rejects.toMatchObject({
      kind: 'no-account',
      message: VAULT_MODE_REFUSALS['vault-refused'],
    })
    expect(env.authorized).toEqual([])
    expect(env.providerFetch).not.toHaveBeenCalled()
  } finally {
    await env.dispose()
  }
})

test('OpenCode 2 follows its recorded ordered account without asking again', async () => {
  const calls: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    accountFor: async (request: unknown) => {
      calls.push(request)
      return { account_id: 'account-b', credential_id: 'credential-b' }
    },
  }))
  const env = fixture()
  expect(await env.openai.adapter.chooseAccount(env.request)).toBe('vault:b')
  expect(await env.openai.adapter.chooseAccount(env.request)).toBe('vault:b')
  expect(calls).toEqual([
    {
      provider: 'openai',
      modelId: 'gpt-6',
      hold_wait_max_s: 0,
      refusals: true,
      waits_for_capacity: true,
      request_id: expect.any(String),
      candidates: {
        view_digest: expect.any(String),
        accounts: [
          { account_id: 'account-a', credential_id: 'credential-a' },
          { account_id: 'account-b', credential_id: 'credential-b' },
        ],
      },
    },
  ])
})

test('OpenCode 2 cold sticky choice does not hint a provisional pin', async () => {
  const calls: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    accountFor: async (request: unknown) => {
      calls.push(request)
    },
  }))
  const env = fixture(true, 'sticky-balanced')
  await env.openai.adapter.chooseAccount(env.request)
  expect(calls).toEqual([
    {
      provider: 'openai',
      modelId: 'gpt-6',
      hold_wait_max_s: 0,
      refusals: true,
      waits_for_capacity: true,
      request_id: expect.any(String),
      candidates: expect.objectContaining({ view_digest: expect.any(String) }),
    },
  ])
})

test.each([
  'ineligible',
  'no-answer',
  'timeout',
  'throw',
  'killswitch',
  'retry',
  'local',
])('OpenCode 2 %s keeps its own choice without re-asking', async (kind) => {
  let asks = 0
  Reflect.set(globalThis, key, () => ({
    accountFor: async () => {
      asks++
      if (kind === 'throw') throw new Error('offline')
      if (kind === 'timeout') return new Promise(() => {})
      if (kind === 'no-answer') return undefined
      return {
        account_id: kind === 'ineligible' ? 'outside-roster' : 'account-b',
      }
    },
  }))
  const env = fixture(kind !== 'local')
  if (kind === 'killswitch') {
    env.routes[1]!.quota = quotaMap(99)
    env.storage.killswitch = {
      enabled: true,
      schema: 'floors-v1',
      defaults: { primary: 25, secondary: 0 },
    }
  }
  const request = {
    ...env.request,
    phase: kind === 'retry' ? ('retry' as const) : ('request' as const),
  }
  expect(await env.openai.adapter.chooseAccount(request)).toBe(
    kind === 'local' ? 'main' : 'vault:a',
  )
  expect(asks).toBe(['retry', 'local'].includes(kind) ? 0 : 1)
})

test.each(['ordered', 'sticky-balanced'] as const)(
  'OpenCode 2 %s refuses when the vault cannot authorize routing’s pick',
  async (mode) => {
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => ({ account_id: 'account-b' }),
    }))
    const env = fixture(true, mode)
    env.refused.add('vault:b')
    await expect(env.openai.adapter.chooseAccount(env.request)).rejects.toThrow(
      'vault',
    )
    expect(env.authorized).toEqual(['vault:b'])
    expect(env.openai.activeAccount(env.request.sessionID)).toBeUndefined()
  },
)

test.each(['compaction', 'generate', 'title'] as const)(
  'OpenCode 2 first %s asks without recording or pinning',
  async (kind) => {
    const accountFor = mock(async () => ({ account_id: 'account-b' }))
    Reflect.set(globalThis, key, () => ({ accountFor }))
    const env = fixture(true, 'sticky-balanced')
    expect(
      await env.openai.adapter.chooseAccount({ ...env.request, kind }),
    ).toBe('vault:b')
    expect(accountFor).toHaveBeenCalledTimes(1)
    expect(env.openai.activeAccount(env.request.sessionID)).toBeUndefined()
    expect(env.pins.placementSnapshot().size).toBe(0)
  },
)

test('OpenCode 2 skips inactive routing observation and checks the bridge again for later responses', async () => {
  Reflect.deleteProperty(globalThis, key)
  const reports: unknown[] = []
  const enable = () =>
    Reflect.set(globalThis, key, () => ({
      report: (payload: unknown) => {
        reports.push(payload)
      },
    }))
  const env = fixture()
  let attempt: Attempt<OpenAIAttemptData> | undefined
  const readHeaders = env.openai.adapter.quotaFromHeaders!
  env.openai.adapter.quotaFromHeaders = (headers, status, handle) => {
    attempt = handle
    return readHeaders(headers, status, handle)
  }
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, env.openai.adapter)
  const report = spyOn(routingClient, 'reportRouting')
  const receive = async () => {
    const requestScope = scope('fleet-session')
    const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
    await host.fire('model.request', { ...requestScope, headers })
    const draft = {
      ...requestScope,
      request: new Request('https://codex.test/v1/responses', {
        method: 'POST',
        body: '{}',
        headers,
      }),
    }
    await host.fire('http.request', draft)
    const received = {
      ...requestScope,
      request: draft.request,
      response: new Response('{}'),
    }
    await host.fire('http.response', received)
    return received.response
  }
  try {
    const absent = await receive()
    expect(attempt).toBeDefined()
    for (const active of [false, true]) {
      if (active) enable()
      else Reflect.deleteProperty(globalThis, key)
      const parse = spyOn(JSON, 'parse')
      try {
        env.openai.adapter.inspectEvent!({
          transport: 'http',
          data: '{"type":"response.output_text.delta","delta":"hello"}',
          attempt: attempt!,
        })
        // Only the existing provider event parser runs, not another routing parser.
        expect(parse).toHaveBeenCalledTimes(1)
      } finally {
        parse.mockRestore()
      }
    }
    await absent.text()
    expect(report).not.toHaveBeenCalled()
    const unloaded = await receive()
    Reflect.deleteProperty(globalThis, key)
    await unloaded.text()
    expect(report).not.toHaveBeenCalled()
    enable()
    const active = await receive()
    await active.text()
    expect(report).toHaveBeenCalledTimes(1)
    expect(reports).toEqual([
      {
        account_id: 'account-a',
        credential_id: 'credential-a',
        outcome: 'served',
        headers: {},
      },
    ])
  } finally {
    report.mockRestore()
    await installation.dispose()
  }
})

test('OpenCode 2 reports a completed vault WebSocket response without waiting', async () => {
  const reports: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    accountFor: async () => ({ account_id: 'account-b' }),
    report: (payload: unknown) => {
      reports.push(payload)
      return new Promise(() => {})
    },
  }))
  const env = fixture()
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, env.openai.adapter)
  try {
    const requestScope = scope('fleet-session')
    await host.fire('experimental.ws.handshake', {
      ...requestScope,
      url: 'wss://chatgpt.com/backend-api/codex/responses',
      headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
    })
    await host.fire('experimental.ws.send', {
      ...requestScope,
      frame: JSON.stringify({
        type: 'response.create',
        model: 'gpt-6',
        input: [],
      }),
    })
    await host.fire('experimental.ws.receive', {
      ...requestScope,
      frame: JSON.stringify({
        type: 'response.completed',
        response: { id: 'done' },
      }),
    })
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'served',
        headers: {},
      },
      {
        kind: 'billing',
        cache: { implicit: true, warming: { on: false } },
        attempt_id: expect.any(String),
        request_kind: 'primary',
        credential_id: 'credential-b',
        account_id: 'account-b',
        provider: 'openai',
        model: 'gpt-6',
        // The fixture's account-b has free plan quota, so the call is included.
        charge_basis: 'subscription_included',
        outcome: 'completed',
        attempt: 1,
        provider_response_id: 'done',
      },
    ])
  } finally {
    await installation.dispose()
  }
})

for (const scenario of [
  {
    name: 'failed primary window',
    frame: {
      type: 'response.failed',
      response: { failed: { rate_limit_reached_type: 'primary' } },
    },
    exhausted: true,
    reset: false,
  },
  {
    name: 'failed primary window with provider reset',
    frame: {
      type: 'response.failed',
      response: {
        failed: {
          rate_limit_reached_type: 'primary',
          resets_at: 1_900_000_000,
        },
      },
    },
    exhausted: true,
    reset: true,
  },
  {
    name: 'usage-limit error',
    frame: {
      type: 'error',
      error: {
        type: 'usage_limit_reached',
        rate_limit_reached_type: 'primary',
        resets_at: 1_900_000_000,
      },
    },
    exhausted: true,
    reset: true,
  },
  {
    name: 'short rate limit',
    frame: {
      type: 'error',
      status: 429,
      error: { type: 'rate_limit_exceeded', window: '5h' },
    },
    exhausted: false,
    backoff: 'rate_limit_exceeded',
  },
  {
    name: 'forbidden',
    frame: { type: 'error', status: 403, error: { code: 'forbidden' } },
    exhausted: false,
    backoff: 'forbidden',
  },
  {
    name: 'failed response without a limit',
    frame: {
      type: 'response.failed',
      response: { error: { code: 'server_error' } },
    },
    exhausted: false,
  },
]) {
  test(`OpenCode 2 vault WebSocket ${scenario.name} reports only the classified outcome`, async () => {
    const reports: Record<string, unknown>[] = []
    const at = 1_900_000_000_000
    const accountFor = mock(async () => ({ account_id: 'account-b' }))
    Reflect.set(globalThis, key, () => ({
      accountFor,
      report: (payload: Record<string, unknown>) => {
        if (!payload.kind || payload.kind === 'transient_backoff')
          reports.push(payload)
        return new Promise(() => {})
      },
    }))
    const env = fixture(true, 'ordered', () => at)
    Object.assign(env.routes[1]!.quota.limits[0]!, {
      resetsAt: new Date(1_900_000_000_000).toISOString(),
    })
    const host = fakeOpenCode2Host()
    const installation = await installOpenCode2Auth(
      host.ctx,
      env.openai.adapter,
    )
    try {
      const requestScope = scope('fleet-session')
      await host.fire('experimental.ws.handshake', {
        ...requestScope,
        url: 'wss://chatgpt.com/backend-api/codex/responses',
        headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
      })
      await host.fire('experimental.ws.send', {
        ...requestScope,
        frame: JSON.stringify({
          type: 'response.create',
          model: 'gpt-6',
          input: [],
        }),
      })
      expect(reports).toEqual([])
      await host.fire('experimental.ws.receive', {
        ...requestScope,
        frame: JSON.stringify(scenario.frame),
      })
      expect(reports).toEqual(
        scenario.exhausted
          ? [
              {
                account_id: 'account-b',
                credential_id: 'credential-b',
                outcome: 'exhausted',
                window: '5h',
                ...('reset' in scenario && scenario.reset
                  ? { resets_at: 1_900_000_000_000 }
                  : {}),
              },
            ]
          : 'backoff' in scenario
            ? [
                {
                  account_id: 'account-b',
                  credential_id: 'credential-b',
                  kind: 'transient_backoff',
                  retry_at_ms: at + 5000,
                  provider_code: scenario.backoff,
                },
              ]
            : [],
      )
      if ('backoff' in scenario) {
        const retry = await host.fire('retry', {
          ...requestScope,
          attempt: 2,
          decision: { retry: true, delay: 0 },
          error: {
            type: 'api',
            message: JSON.stringify(scenario.frame),
            status: scenario.frame.status,
          },
        })
        expect(retry.decision).toEqual({ retry: true, delay: 5000 })
        expect(accountFor).toHaveBeenCalledTimes(1)
      }
    } finally {
      await installation.dispose()
    }
  })
}

test('OpenCode 2 vault HTTP usage-limit 429 reports exactly once and preserves the refusal bytes', async () => {
  const reports: Record<string, unknown>[] = []
  Reflect.set(globalThis, key, () => ({
    report: (payload: Record<string, unknown>) => {
      if (!payload.kind) reports.push(payload)
    },
  }))
  const env = fixture()
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, env.openai.adapter)
  const body =
    '{ "error": { "type": "usage_limit_reached", "rate_limit_reached_type": "primary", "resets_at": 1900000000 } }'
  try {
    const requestScope = scope('fleet-session')
    const draft = await host.fire('http.request', {
      ...requestScope,
      request: new Request('https://codex.test/v1/responses', {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
      }),
    })
    const received = await host.fire('http.response', {
      ...requestScope,
      request: draft.request,
      response: new Response(body, {
        status: 429,
        headers: {
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': '1950000000',
          'retry-after': '20',
        },
      }),
    })
    expect(await received.response.text()).toBe(body)
    expect(reports).toEqual([
      {
        account_id: 'account-a',
        credential_id: 'credential-a',
        outcome: 'exhausted',
        window: '5h',
        resets_at: 1_900_000_000_000,
      },
    ])
  } finally {
    await installation.dispose()
  }
})

for (const scenario of [
  {
    name: 'classified usage limit',
    message: JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        window: '5h',
        resets_at: 1_900_000_000,
      },
    }),
    exhausted: true,
  },
  {
    name: 'usage limit already handled by HTTP',
    message: JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        window: '5h',
        resets_at: 1_900_000_000,
      },
    }),
    exhausted: true,
    httpFirst: true,
  },
  {
    name: 'short rate limit',
    message: JSON.stringify({
      error: { type: 'rate_limit_exceeded', window: '5h' },
    }),
    exhausted: false,
    providerCode: 'rate_limit_exceeded',
  },
  {
    name: 'unstructured usage-limit text',
    message: 'usage_limit_reached for primary',
    exhausted: false,
    providerCode: 'http_429',
  },
  {
    name: '403 without a structured error',
    message: 'Forbidden',
    exhausted: false,
    status: 403,
    providerCode: 'http_403',
  },
  {
    name: '429 with a failed envelope that names no window',
    message: JSON.stringify({ type: 'response.failed', response: {} }),
    exhausted: false,
    providerCode: 'http_429',
  },
]) {
  test(`OpenCode 2 vault host error ${scenario.name} reports at most once per attempt`, async () => {
    const reports: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      report: (payload: unknown) => {
        reports.push(payload)
      },
    }))
    const at = 1_900_000_000_000
    const env = fixture(true, 'ordered', () => at)
    const attempt: Attempt<OpenAIAttemptData> = {
      providerID: 'openai',
      modelID: 'gpt-6',
      sessionID: 'fleet-session',
      agent: 'build',
      kind: 'primary',
      attemptId: 'host-error',
      accountId: 'vault:a',
      transport: 'http',
      data: {
        kind: 'vault',
        routeId: 'vault:a',
        receipt: {
          credentialId: 'credential-a',
          credentialType: 'oauth',
          accountIdentity: 'account-a',
          accountIdentitySource: 'asserted',
          accessToken: 'vault:a-token',
          recordVersion: 1,
          expiresAtMs: null,
        },
      },
    }
    if ('httpFirst' in scenario) {
      const limit = await env.openai.adapter.limitFromResponse!({
        status: 429,
        headers: new Headers(),
        body: async () => scenario.message,
        attempt,
      })
      await env.openai.adapter.onAttemptEnd!(attempt, {
        status: 429,
        outputStarted: false,
        limit,
      })
      expect(reports).toHaveLength(1)
    }
    const limit = await env.openai.adapter.limitFromError!(
      {
        type: 'api',
        message: scenario.message,
        status: 'status' in scenario ? scenario.status : 429,
      },
      attempt,
    )
    expect(reports).toHaveLength(1)
    const outcome = { outputStarted: false, limit }
    await env.openai.adapter.onAttemptEnd!(attempt, outcome)
    await env.openai.adapter.onAttemptEnd!(attempt, outcome)
    expect(reports).toEqual(
      scenario.exhausted
        ? [
            {
              account_id: 'account-a',
              credential_id: 'credential-a',
              outcome: 'exhausted',
              window: '5h',
              resets_at: 1_900_000_000_000,
            },
          ]
        : [
            {
              account_id: 'account-a',
              credential_id: 'credential-a',
              kind: 'transient_backoff',
              retry_at_ms: at + 5000,
              provider_code:
                'providerCode' in scenario ? scenario.providerCode : undefined,
            },
          ],
    )
  })
}

test('OpenCode 2 reports a served vault response without waiting, with only rate headers', async () => {
  const reports: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    accountFor: async () => ({ account_id: 'account-b' }),
    report: (payload: unknown) => {
      reports.push(payload)
      return new Promise(() => {})
    },
  }))
  const env = fixture()
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, env.openai.adapter)
  try {
    const requestScope = scope('fleet-session')
    const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
    await host.fire('model.request', { ...requestScope, headers })
    const draft = {
      ...requestScope,
      request: new Request('https://codex.test/v1/responses', {
        method: 'POST',
        body: '{}',
        headers,
      }),
    }
    await host.fire('http.request', draft)
    expect(draft.request.headers.get('authorization')).toBe(
      'Bearer vault:b-token',
    )
    const received = {
      ...requestScope,
      request: draft.request,
      response: new Response('{}', {
        headers: {
          'x-codex-primary-used-percent': '42',
          'set-cookie': 'secret',
        },
      }),
    }
    await host.fire('http.response', received)
    expect(reports).toEqual([])
    await received.response.text()
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'served',
        headers: { 'x-codex-primary-used-percent': '42' },
      },
    ])
  } finally {
    await installation.dispose()
  }
})

test('OpenCode 2 reports only backoff for a usage-limit 429 without a recognized window', async () => {
  const reports: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    accountFor: async () => ({ account_id: 'account-b' }),
    report: (payload: unknown) => {
      reports.push(payload)
    },
  }))
  const env = fixture()
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, env.openai.adapter)
  try {
    const requestScope = scope('fleet-session')
    const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
    await host.fire('model.request', { ...requestScope, headers })
    const draft = {
      ...requestScope,
      request: new Request('https://codex.test/v1/responses', {
        method: 'POST',
        body: '{}',
        headers,
      }),
    }
    await host.fire('http.request', draft)
    await host.fire('http.response', {
      ...requestScope,
      request: draft.request,
      response: Response.json(
        { error: { type: 'usage_limit_reached', resets_at: 1_900_000_000 } },
        { status: 429 },
      ),
    })
    expect(
      reports.filter(
        (report) => (report as { kind?: string }).kind !== 'billing',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'transient_backoff',
        account_id: 'account-b',
      }),
    ])
  } finally {
    await installation.dispose()
  }
})

for (const scenario of [
  { name: '500', status: 500, body: '{}', type: 'application/json' },
  { name: '401', status: 401, body: '{}', type: 'application/json' },
  {
    name: 'stream error after 2xx headers',
    status: 200,
    body: 'data: {"type":"error","error":{"message":"failed"}}\n\n',
    type: 'text/event-stream',
  },
]) {
  test(`OpenCode 2 ${scenario.name} reports no routing outcome`, async () => {
    const reports: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => ({ account_id: 'account-b' }),
      report: (payload: unknown) => {
        reports.push(payload)
      },
    }))
    const env = fixture()
    const host = fakeOpenCode2Host()
    const installation = await installOpenCode2Auth(
      host.ctx,
      env.openai.adapter,
    )
    try {
      const requestScope = scope('fleet-session')
      const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
      await host.fire('model.request', { ...requestScope, headers })
      const draft = {
        ...requestScope,
        request: new Request('https://codex.test/v1/responses', {
          method: 'POST',
          body: '{}',
          headers,
        }),
      }
      await host.fire('http.request', draft)
      const received = {
        ...requestScope,
        request: draft.request,
        response: new Response(scenario.body, {
          status: scenario.status,
          headers: { 'content-type': scenario.type, 'retry-after': '10' },
        }),
      }
      await host.fire('http.response', received)
      await received.response.text()
      expect(reports).toEqual([])
    } finally {
      await installation.dispose()
    }
  })
}

test.each([
  {
    name: '429 with Retry-After',
    status: 429,
    headers: new Headers({ 'retry-after': '7' }),
    code: 'turn_rate_limit_exceeded',
    delay: 7000,
  },
  {
    name: '429 without a retry time',
    status: 429,
    headers: undefined,
    code: undefined,
    delay: 5000,
  },
  {
    name: '403',
    status: 403,
    headers: new Headers({ 'retry-after-ms': '2400' }),
    code: undefined,
    delay: 2400,
  },
  ...[429, 403].map((status) => ({
    name: `host-only ${status}`,
    status,
    headers: undefined,
    code: undefined,
    delay: 5000,
    hostOnly: true,
    next: 'vault:b',
  })),
  {
    name: 'exhausted: route',
    status: 429,
    headers: undefined,
    code: 'usage_limit_reached',
    next: 'vault:c',
  },
  {
    name: 'exhausted: continue pick cannot be authorized',
    status: 429,
    headers: undefined,
    code: 'usage_limit_reached',
    next: 'vault:c',
    refuseAuthorization: true,
  },
  {
    name: 'exhausted: refusal',
    status: 429,
    headers: undefined,
    code: 'usage_limit_reached',
    next: null,
  },
  {
    name: 'exhausted: no answer',
    status: 429,
    headers: undefined,
    code: 'usage_limit_reached',
    next: 'vault:a',
  },
  {
    name: 'exhausted: same account',
    status: 429,
    headers: undefined,
    code: 'usage_limit_reached',
    next: 'vault:b',
  },
  ...[
    { name: 'within cap', cap: 3, holdMs: 2000, stop: false },
    { name: 'over cap', cap: 3, holdMs: 4000, stop: true },
    { name: 'zero cap', cap: 0, holdMs: 2000, stop: true },
  ].map((hold) => ({
    name: `exhausted: routing hold ${hold.name}`,
    status: 429,
    headers: undefined,
    code: 'usage_limit_reached',
    next: 'vault:b',
    delay: hold.holdMs,
    hold,
  })),
])(
  'OpenCode 2 routed HTTP $name uses the retry hook before another send',
  async (scenario) => {
    const at = 1_900_000_000_000
    const events: unknown[] = []
    const hold = 'hold' in scenario ? scenario.hold : undefined
    const cannotAuthorize = 'refuseAuthorization' in scenario
    const stop =
      hold?.stop === true || scenario.next === null || cannotAuthorize
    Reflect.set(globalThis, key, () => ({
      accountFor: async (request: Record<string, unknown>) => {
        events.push(['ask', request])
        if (request.mode !== 'continue') return { account_id: 'account-b' }
        if (hold)
          return {
            account_id: 'account-b',
            hold: { retry_after_ms: hold.holdMs },
          }
        if (scenario.next === null)
          return {
            refused: {
              code: 'account_selection_refused',
              reason: 'candidates_disjoint',
              retry_after_secs: 3,
            },
          }
        if (scenario.next === 'vault:b') return { account_id: 'account-b' }
        if (scenario.next === 'vault:c') return { account_id: 'account-c' }
        return undefined
      },
      report: (report: Record<string, unknown>) => {
        if (
          report.kind === 'transient_backoff' ||
          report.outcome === 'exhausted'
        )
          events.push(['report', report])
        return new Promise(() => {})
      },
    }))
    const warn = mock((_message: string) => {})
    const accountKey = {
      namespace: 'vault',
      accountId: 'vault:b',
      incarnation: '1',
    }
    const activity = createSessionActivityStore()
    const limits = {
      activity,
      bindings: () => [],
      accountKey: (id: string) =>
        id === accountKey.accountId ? accountKey : undefined,
      marks: () => new Map(),
      owner: () => undefined,
      forRequest: async () => undefined,
    } as unknown as OpenCodeLimitSource
    const env = fixture(true, 'ordered', () => at, {
      limits: hold ? limits : undefined,
      log: { debug: () => {}, warn },
    })
    env.routes.push({
      ...env.routes[0]!,
      id: 'vault:c',
      identity: 'account-c',
      credentialId: 'credential-c',
    })
    if (cannotAuthorize) env.refused.add('vault:c')
    const host = fakeOpenCode2Host()
    const installation = await installOpenCode2Auth(
      host.ctx,
      env.openai.adapter,
    )
    env.openai.attach(installation)
    const requestScope = scope('fleet-session')
    const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
    const send = async () => {
      await host.fire('model.request', {
        ...requestScope,
        headers: { ...headers },
      })
      const draft = await host.fire('http.request', {
        ...requestScope,
        request: new Request('https://codex.test/v1/responses', {
          method: 'POST',
          body: '{}',
          headers,
        }),
      })
      events.push(['send', draft.request.headers.get('authorization')])
      return draft.request
    }
    try {
      const request = await send()
      if (hold)
        activity.recordAccepted({
          sessionId: requestScope.sessionID,
          accountKey,
          currentAccountKey: accountKey,
          lastAcceptedAt: at,
          ttlMs: hold.cap * 1000,
        })
      const exhausted = scenario.code === 'usage_limit_reached'
      const payload = scenario.code
        ? {
            error: {
              code: scenario.code,
              ...(exhausted ? { window: '5h', resets_in_seconds: 30 } : {}),
            },
          }
        : {}
      if (!('hostOnly' in scenario))
        await host.fire('http.response', {
          ...requestScope,
          request,
          response: Response.json(payload, {
            status: scenario.status,
            headers: scenario.headers,
          }),
        })
      const retry = await host.fire('retry', {
        ...requestScope,
        attempt: 2,
        decision: { retry: true, delay: 12345 },
        error: {
          type: 'api',
          message: JSON.stringify(payload),
          status: scenario.status,
        },
      })
      if (retry.decision.retry) await send()
      expect(retry.decision.retry).toBe(!stop)
      if (cannotAuthorize) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('vault'))
        expect(env.authorized).toEqual(['vault:b', 'vault:c'])
      } else if (stop)
        expect(warn).toHaveBeenCalledWith(
          'Thalamus routing declined this request, so it was not sent.',
        )
      else expect(retry.decision.delay).toBe(scenario.delay ?? 0)
      expect(events).toEqual([
        ['ask', expect.not.objectContaining({ mode: 'continue' })],
        ['send', 'Bearer vault:b-token'],
        ...(exhausted
          ? [
              [
                'report',
                {
                  account_id: 'account-b',
                  credential_id: 'credential-b',
                  outcome: 'exhausted',
                  window: '5h',
                  resets_at: at + 30_000,
                },
              ],
              [
                'ask',
                expect.objectContaining({
                  mode: 'continue',
                  request_id: expect.any(String),
                  ...(hold ? { hold_wait_max_s: hold.cap } : {}),
                  exhausted: expect.objectContaining({
                    account: 'account-b',
                    credential_id: 'credential-b',
                    limit_window: 'five_hour',
                    observed_at_ms: at,
                    resets_at_ms: at + 30_000,
                  }),
                  candidates: expect.objectContaining({
                    accounts: expect.arrayContaining([
                      {
                        account_id: 'account-b',
                        credential_id: 'credential-b',
                      },
                    ]),
                  }),
                }),
              ],
            ]
          : [
              [
                'report',
                {
                  account_id: 'account-b',
                  credential_id: 'credential-b',
                  kind: 'transient_backoff',
                  retry_at_ms: at + scenario.delay!,
                  provider_code: scenario.code ?? `http_${scenario.status}`,
                },
              ],
            ]),
        ...(stop
          ? []
          : [['send', `Bearer ${scenario.next ?? 'vault:b'}-token`]]),
      ])
    } finally {
      await installation.dispose()
      env.openai.dispose()
    }
  },
)

test.each([
  {
    transport: 'ws',
    frame: { type: 'error', error: { type: 'rate_limit_exceeded' } },
    code: 'rate_limit_exceeded',
  },
  {
    transport: 'ws',
    frame: {
      type: 'response.failed',
      response: { failed: { rate_limit_reached_type: 'secondary' } },
    },
    code: 'http_429',
  },
  {
    transport: 'ws',
    frame: {
      type: 'response.failed',
      response: { error: { code: 'rate_limit_exceeded' } },
    },
    code: 'rate_limit_exceeded',
  },
  {
    transport: 'sse',
    frame: { type: 'error', error: { code: 'rate_limit_exceeded' } },
    code: 'rate_limit_exceeded',
  },
  {
    transport: 'sse',
    frame: {
      type: 'response.failed',
      response: { failed: { rate_limit_reached_type: 'secondary' } },
    },
    code: 'http_429',
  },
  {
    transport: 'sse',
    frame: {
      type: 'response.failed',
      response: { error: { code: 'usage_limit_reached', window: '7d' } },
    },
    code: undefined,
  },
])(
  'OC2 $transport classifies statusless $frame.type limits with code $code',
  async ({ transport, frame, code }) => {
    const at = 1_900_000_000_000
    const asks: unknown[] = []
    const reports: Array<Record<string, unknown>> = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async (ask: { mode?: string }) => {
        asks.push(ask.mode)
        return {
          account_id: ask.mode === 'continue' ? 'account-a' : 'account-b',
        }
      },
      report: (report: Record<string, unknown>) => {
        if (
          report.kind === 'transient_backoff' ||
          report.outcome === 'exhausted'
        )
          reports.push(report)
      },
    }))
    const env = fixture(true, 'ordered', () => at)
    const host = fakeOpenCode2Host()
    const installation = await installOpenCode2Auth(
      host.ctx,
      env.openai.adapter,
    )
    const requestScope = scope('statusless-frame')
    const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
    const sendHttp = () =>
      host.fire('http.request', {
        ...requestScope,
        request: new Request('https://codex.test/v1/responses', {
          method: 'POST',
          body: '{}',
          headers,
        }),
      })
    try {
      if (transport === 'ws') {
        await host.fire('experimental.ws.handshake', {
          ...requestScope,
          url: 'wss://codex.test/v1/responses',
          headers: { ...headers },
        })
        await host.fire('experimental.ws.send', {
          ...requestScope,
          frame: '{"type":"response.create","input":[]}',
        })
        await host.fire('experimental.ws.receive', {
          ...requestScope,
          frame: JSON.stringify(frame),
        })
      } else {
        const draft = await sendHttp()
        const got = await host.fire('http.response', {
          ...requestScope,
          request: draft.request,
          response: new Response(billingSse(frame), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        })
        await got.response.text()
      }
      const retry = await host.fire('retry', {
        ...requestScope,
        attempt: 2,
        decision: { retry: false },
        error: { type: 'api', message: JSON.stringify(frame) },
      })
      expect(retry.decision).toEqual(
        expect.objectContaining({ retry: true, delay: code ? 5000 : 0 }),
      )
      await host.fire('model.request', {
        ...requestScope,
        headers: { ...headers },
      })
      expect((await sendHttp()).request.headers.get('authorization')).toBe(
        `Bearer vault:${code ? 'b' : 'a'}-token`,
      )
      expect(asks).toEqual(code ? [undefined] : [undefined, 'continue'])
      expect(reports).toEqual([
        code
          ? expect.objectContaining({
              kind: 'transient_backoff',
              account_id: 'account-b',
              provider_code: code,
              retry_at_ms: at + 5000,
            })
          : expect.objectContaining({
              outcome: 'exhausted',
              account_id: 'account-b',
              window: '7d',
            }),
      ])
    } finally {
      await installation.dispose()
      env.openai.dispose()
    }
  },
)

test('OC2 keeps an eligible recorded account when switching to sticky-balanced before a pin exists', async () => {
  const accountFor = mock(async () => ({ account_id: 'account-b' }))
  Reflect.set(globalThis, key, () => ({ accountFor }))
  const env = fixture()
  expect(await env.openai.adapter.chooseAccount(env.request)).toBe('vault:b')
  expect(env.pins.get(env.request.sessionID)).toBeUndefined()
  env.storage.routing = { mode: 'sticky-balanced' }
  expect(await env.openai.adapter.chooseAccount(env.request)).toBe('vault:b')
  expect(env.pins.get(env.request.sessionID)).toBe('vault:b')
  expect(accountFor).toHaveBeenCalledTimes(1)
})

const billingTerminal = (type = 'response.completed') => ({
  type,
  response: {
    id: 'resp-billed',
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 4 },
    },
  },
})
const billingSse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

async function billingFixture(
  vaultMode = true,
  accessor = true,
  mode: 'ordered' | 'sticky-balanced' = 'ordered',
) {
  const reports: Record<string, unknown>[] = []
  if (accessor)
    Reflect.set(globalThis, key, () => ({
      report: (payload: Record<string, unknown>) => {
        if (payload.kind === 'billing') reports.push(payload)
        return new Promise(() => {})
      },
    }))
  else Reflect.deleteProperty(globalThis, key)
  const env = fixture(vaultMode, mode)
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, env.openai.adapter)
  const send = async (
    response: Response,
    kind: 'primary' | 'title' = 'primary',
  ) => {
    const request = await host.fire('http.request', {
      ...scope('fleet-session', kind),
      request: new Request('https://codex.test/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
        body: JSON.stringify({ model: 'gpt-6', input: [] }),
      }),
    })
    const received = await host.fire('http.response', {
      ...scope('fleet-session', kind),
      request: request.request,
      response,
    })
    return received.response
  }
  return { ...env, host, installation, reports, send }
}

test.each(['response.completed', 'response.incomplete'])(
  'billing HTTP %s reports exact vault usage once after body end',
  async (type) => {
    const env = await billingFixture()
    const clone = spyOn(Request.prototype, 'clone')
    try {
      const response = await env.send(
        new Response(billingSse(billingTerminal(type))),
      )
      expect(clone).toHaveBeenCalledTimes(1)
      expect(env.reports).toEqual([])
      await response.text()
      expect(env.reports).toEqual([
        {
          kind: 'billing',
          cache: { implicit: true, warming: { on: false } },
          attempt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          request_kind: 'primary',
          credential_id: 'credential-a',
          account_id: 'account-a',
          provider: 'openai',
          model: 'gpt-6',
          charge_basis: 'subscription_included',
          outcome: 'completed',
          status: 200,
          attempt: 1,
          provider_response_id: 'resp-billed',
          usage: {
            input: 20,
            output: 12,
            cache_read: 40,
            cache_write: 60,
            reasoning: 4,
            reasoning_included_in_output: true,
          },
        },
      ])
    } finally {
      clone.mockRestore()
      await env.installation.dispose()
    }
  },
)

test.each([
  ['response.completed', 'cancelled', 'completed'],
  ['response.incomplete', 'cancelled', 'completed'],
  ['response.failed', 'cancelled', 'failed'],
  ['error', 'cancelled', 'failed'],
  ['response.output_text.delta', 'cancelled', 'cut'],
  ['response.completed', 'failed', 'cut'],
] as const)(
  'billing HTTP %s then %s reports %s',
  async (type, end, outcome) => {
    const env = await billingFixture()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    try {
      const response = await env.send(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value
            },
          }),
        ),
      )
      controller.enqueue(
        new TextEncoder().encode(billingSse(billingTerminal(type))),
      )
      const reader = response.body!.getReader()
      await reader.read()
      expect(env.reports).toEqual([])
      if (end === 'cancelled') await reader.cancel()
      else {
        controller.error(new Error('transport read failed'))
        await expect(reader.read()).rejects.toThrow('transport read failed')
      }
      expect(env.reports).toHaveLength(1)
      expect(env.reports[0]).toMatchObject({ outcome, status: 200 })
      if (outcome === 'completed')
        expect(env.reports[0]).toMatchObject({
          provider_response_id: 'resp-billed',
          usage: { input: 20, output: 12, cache_read: 40, cache_write: 60 },
        })
    } finally {
      await env.installation.dispose()
    }
  },
)

test('billing HTTP 429 fails without usage', async () => {
  const env = await billingFixture()
  try {
    const response = await env.send(
      new Response('{"error":{"code":"usage_limit_reached"}}', { status: 429 }),
    )
    await response.text()
    expect(env.reports).toEqual([
      {
        kind: 'billing',
        cache: { implicit: true, warming: { on: false } },
        attempt_id: expect.any(String),
        request_kind: 'primary',
        credential_id: 'credential-a',
        account_id: 'account-a',
        provider: 'openai',
        model: 'gpt-6',
        charge_basis: 'subscription_included',
        outcome: 'failed',
        status: 429,
        attempt: 1,
      },
    ])
  } finally {
    await env.installation.dispose()
  }
})

for (const mode of ['ordered', 'sticky-balanced'] as const) {
  test.each(['free', 'credits', 'last-path'] as const)(
    `billing HTTP ${mode} charge basis reflects %s admission`,
    async (tier) => {
      const env = await billingFixture(true, true, mode)
      for (const route of env.routes) {
        route.quota = quotaMap(tier === 'free' ? 10 : 100)
        const limit = route.quota.limits[0]
        if (limit?.kind === 'reading')
          limit.resetsAt = new Date(Date.now() + 3600_000).toISOString()
        if (tier === 'credits')
          route.quota.credits = {
            hasCredits: true,
            unlimited: false,
            balance: 50,
            checkedAt: Date.now(),
          }
      }
      try {
        const response = await env.send(
          new Response(billingSse(billingTerminal())),
        )
        await response.text()
        expect(env.reports).toHaveLength(1)
        if (tier === 'free')
          expect(env.reports[0]).toHaveProperty(
            'charge_basis',
            'subscription_included',
          )
        else expect(env.reports[0]).not.toHaveProperty('charge_basis')
      } finally {
        await env.installation.dispose()
      }
    },
  )
}

test('billing HTTP cut then same-account continuation increments attempt and resets on a user turn', async () => {
  const env = await billingFixture()
  const continuation = spyOn(env.openai.adapter, 'retrySameAccount')
  let controller!: ReadableStreamDefaultController<Uint8Array>
  try {
    const response = await env.send(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value
          },
        }),
      ),
    )
    controller.enqueue(
      new TextEncoder().encode(
        billingSse({ type: 'response.output_text.delta', delta: 'hello' }),
      ),
    )
    const reader = response.body!.getReader()
    await reader.read()
    controller.error(new Error('socket interrupted'))
    await expect(reader.read()).rejects.toThrow('socket interrupted')
    await env.host.fire('retry', {
      ...scope('fleet-session'),
      attempt: 1,
      error: { type: 'provider.transport', message: 'interrupted' },
      decision: { retry: true, delay: 0 },
    })
    expect(continuation).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: 'interrupted-read',
        accountId: 'vault:a',
      }),
    )
    const continued = await env.send(
      new Response(billingSse(billingTerminal())),
    )
    await continued.text()
    expect(
      env.reports.map((value) => [
        value.outcome,
        value.attempt,
        value.credential_id,
      ]),
    ).toEqual([
      ['cut', 1, 'credential-a'],
      ['completed', 2, 'credential-a'],
    ])
    expect(env.reports[0]!.attempt_id).not.toBe(env.reports[1]!.attempt_id)
    expect(env.reports[0]).not.toHaveProperty('usage')
    expect(env.reports[0]).toHaveProperty(
      'charge_basis',
      'subscription_included',
    )
    expect(env.reports[1]).not.toHaveProperty('charge_basis')
    env.openai.beginTurn('fleet-session')
    await (await env.send(new Response(billingSse(billingTerminal())))).text()
    expect(env.reports[2]!.attempt).toBe(1)
  } finally {
    continuation.mockRestore()
    await env.installation.dispose()
  }
})

test('billing HTTP title preserves kind and omits unmeasured counts and zero cache writes', async () => {
  const env = await billingFixture()
  try {
    await (
      await env.send(
        new Response(
          billingSse({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 5,
                input_tokens_details: {
                  cached_tokens: 9,
                  cache_write_tokens: 0,
                },
              },
            },
          }),
        ),
        'title',
      )
    ).text()
    expect(env.reports[0]).toMatchObject({
      request_kind: 'title',
      usage: { input: 0, cache_read: 9, reasoning_included_in_output: true },
    })
    expect(env.reports[0]!.usage).toEqual({
      input: 0,
      cache_read: 9,
      reasoning_included_in_output: true,
    })
    expect(env.reports[0]).not.toHaveProperty('provider_response_id')
  } finally {
    await env.installation.dispose()
  }
})

test.each([
  [false, true],
  [true, false],
])(
  'billing gate vault=%s accessor=%s reports nothing',
  async (vaultMode, accessor) => {
    const env = await billingFixture(vaultMode, accessor)
    try {
      const response = await env.send(
        new Response(billingSse(billingTerminal())),
      )
      await response.text()
      expect(env.reports).toEqual([])
    } finally {
      await env.installation.dispose()
    }
  },
)
