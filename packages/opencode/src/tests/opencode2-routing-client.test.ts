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
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: () => {},
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
      reportUsage: () => {},
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
  test(`OpenCode 2 vault WebSocket ${scenario.name} reports exhaustion only for account limits`, async () => {
    const reports: Record<string, unknown>[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => ({ account_id: 'account-b' }),
      report: (payload: Record<string, unknown>) => {
        if (!payload.kind) reports.push(payload)
        return new Promise(() => {})
      },
    }))
    const env = fixture()
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
          : [],
      )
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
  },
  {
    name: 'unstructured usage-limit text',
    message: 'usage_limit_reached for primary',
    exhausted: false,
  },
]) {
  test(`OpenCode 2 vault host error ${scenario.name} reports at most once per attempt`, async () => {
    const reports: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      report: (payload: unknown) => {
        reports.push(payload)
      },
    }))
    const env = fixture()
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
      { type: 'api', message: scenario.message, status: 429 },
      attempt,
    )
    if (!('httpFirst' in scenario)) expect(reports).toEqual([])
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
        : [],
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

test('OpenCode 2 reports nothing for a usage-limit 429 without a recognized window', async () => {
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
    expect(reports).toEqual([])
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
