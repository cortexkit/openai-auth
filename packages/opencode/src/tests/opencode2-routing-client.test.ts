import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  type Attempt,
  type ChooseAccountInput,
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import * as routingClient from '@cortexkit/common-auth/routing-accessor'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import {
  createOpenAIAdapter,
  type OpenAIAttemptData,
  type PoolAccess,
} from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'

const key = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, key)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, key, original)
  else Reflect.deleteProperty(globalThis, key)
})

function quotaMap(usedPercent: number): QuotaMap {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        usedPercent,
        checkedAt: Date.now(),
        windowMinutes: 300,
      },
    ],
  }
}

function fixture(
  vaultMode = true,
  mode: 'ordered' | 'sticky-balanced' = 'ordered',
) {
  const rows: PoolRow[] = [
    {
      id: 'main',
      type: 'oauth',
      enabled: true,
      candidate: true,
      hasEntry: true,
      needsFirstReading: false,
      identity: 'local-account',
      credentialEpoch: 1,
      credential: {
        type: 'oauth',
        access: 'local-token',
        refresh: 'local-refresh',
        expires: Date.now() + 3600_000,
      },
      quota: quotaMap(10),
    },
  ]
  const source: PoolAccess = {
    current: async () => ({ active: true, rows }),
    peek: () => ({ active: true, rows }),
    prepareTokens: async () => {},
    usableToken: () => 'local-token',
    rateLimitMarks: () => new Map(),
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: () => {},
  }
  const routes = ['a', 'b'].map((id) => ({
    id: `vault:${id}`,
    identity: `account-${id}`,
    credentialId: `credential-${id}`,
    kind: 'oauth' as const,
    quota: quotaMap(10),
  }))
  const refused = new Set<string>()
  const authorized: string[] = []
  const pins = new SessionPins()
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    routing: { mode },
  }
  const openai = createOpenAIAdapter({
    source,
    storage: async () => storage,
    pins,
    vault: {
      routes: () => routes,
      identities: () => new Set(routes.map((route) => route.identity)),
      enrolled: () => vaultMode,
      authority: async () => (vaultMode ? 'vault' : 'local'),
      snapshot: () => undefined,
      authorize: async (id) => {
        authorized.push(id)
        if (refused.has(id)) return undefined
        const route = routes.find((route) => route.id === id)!
        return {
          credentialId: route.credentialId,
          credentialType: 'oauth',
          accountIdentity: route.identity,
          accountIdentitySource: 'asserted',
          accessToken: `${id}-token`,
          recordVersion: 1,
          expiresAtMs: null,
        } satisfies ClaustrumScopedAttempt
      },
      reportFailure: async () => {},
      recordSnapshot: async () => {},
      requestReading: () => {},
      grantReach: () => undefined,
      name: 'openai-auth-opencode',
    },
  })
  const request: ChooseAccountInput = {
    providerID: 'openai',
    modelID: 'gpt-6',
    sessionID: 'fleet-session',
    agent: 'build',
    kind: 'primary',
    phase: 'request',
  }
  return { openai, pins, storage, routes, refused, authorized, request }
}

for (const mode of ['ordered', 'sticky-balanced'] as const) {
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

test.each([
  'ineligible',
  'no-answer',
  'timeout',
  'throw',
  'killswitch',
  'refused',
  'retry',
  'title',
  'compaction',
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
  if (kind === 'refused') env.refused.add('vault:b')
  const request = {
    ...env.request,
    phase: kind === 'retry' ? ('retry' as const) : ('request' as const),
    kind:
      kind === 'title' || kind === 'compaction' ? kind : ('primary' as const),
  }
  expect(await env.openai.adapter.chooseAccount(request)).toBe(
    kind === 'local' ? 'main' : 'vault:a',
  )
  expect(asks).toBe(
    ['retry', 'title', 'compaction', 'local'].includes(kind) ? 0 : 1,
  )
  if (kind === 'refused') expect(env.authorized).toEqual(['vault:b', 'vault:a'])
})

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
    ])
  } finally {
    await installation.dispose()
  }
})

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

test('OpenCode 2 reports a usage-limit 429 as exhausted, never served', async () => {
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
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'exhausted',
        window: 'usage_limit_reached',
        resets_at: 1_900_000_000_000,
      },
    ])
  } finally {
    await installation.dispose()
  }
})

for (const scenario of [
  {
    name: 'short 429',
    status: 429,
    body: JSON.stringify({ error: { type: 'rate_limit_exceeded' } }),
    type: 'application/json',
  },
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
