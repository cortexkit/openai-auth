import { afterEach, expect, spyOn, test } from 'bun:test'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import * as routingClient from '@cortexkit/common-auth/routing-accessor'
import {
  chooseVaultRouting,
  observeVaultRoutingResponse,
  reportVaultRouting,
  vaultRoutingRequestFromBody,
} from '../vault-routing'

const key = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, key)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, key, original)
  else Reflect.deleteProperty(globalThis, key)
})

function input() {
  const now = Date.now()
  return {
    vaultMode: true,
    fresh: true,
    sessionId: 'session',
    request: { modelId: 'gpt-6', kind: 'primary' },
    routes: ['a', 'b'].map((id) => ({
      id: `route-${id}`,
      identity: `account-${id}`,
      credentialId: `credential-${id}`,
    })),
    routing: {
      rows: ['a', 'b'].map((id) => ({
        id: `route-${id}`,
        kind: 'oauth' as const,
        quota: {
          limits: [
            {
              scope: 'all',
              label: 'primary',
              kind: 'reading' as const,
              checkedAt: now,
              usedPercent: 10,
            },
          ],
        },
      })),
      now,
      killswitch: new Map<string, boolean>(),
      rateLimitMarks: new Map<string, number>(),
      refreshBackoff: new Map<string, number>(),
      requestPull: () => {},
    },
  }
}

test('fleet selection uses an eligible vault identity, not a plugin route id', async () => {
  const calls: unknown[] = []
  Reflect.set(globalThis, key, (session: string) => ({
    accountFor: async (...args: unknown[]) => {
      calls.push([session, ...args])
      return { account_id: 'account-b', credential_id: 'credential-b' }
    },
  }))
  expect(await chooseVaultRouting(input())).toBe('route-b')
  expect(calls).toEqual([
    ['session', { provider: 'openai', modelId: 'gpt-6' }, { deadlineMs: 500 }],
  ])
})

test.each([
  'absent',
  'none',
  'ineligible',
  'wrong-credential',
  'throw',
  'timeout',
])('%s routing advice leaves the caller its own choice', async (kind) => {
  Reflect.deleteProperty(globalThis, key)
  if (kind !== 'absent')
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => {
        if (kind === 'throw') throw new Error('unavailable')
        if (kind === 'timeout') return new Promise(() => {})
        if (kind === 'none') return undefined
        return kind === 'wrong-credential'
          ? { account_id: 'account-b', credential_id: 'credential-a' }
          : { account_id: 'outside-roster' }
      },
    }))
  const start = performance.now()
  expect(await chooseVaultRouting(input())).toBeUndefined()
  if (kind === 'timeout') {
    expect(performance.now() - start).toBeGreaterThanOrEqual(450)
    expect(performance.now() - start).toBeLessThan(1500)
  }
})

test.each(['killswitch', 'refused', 'not-in-request'])(
  '%s account cannot be admitted by fleet advice',
  async (kind) => {
    Reflect.set(globalThis, key, () => ({
      accountFor: async () => ({ account_id: 'account-b' }),
    }))
    const request = input()
    if (kind === 'killswitch') request.routing.killswitch.set('route-b', false)
    if (kind === 'refused') request.routes.pop()
    expect(
      await chooseVaultRouting({
        ...request,
        eligibleIds: kind === 'not-in-request' ? ['route-a'] : undefined,
      }),
    ).toBeUndefined()
  },
)

test.each(['local', 'warm', 'retry', 'title', 'compaction', 'keep-warm'])(
  '%s request never asks the fleet',
  async (kind) => {
    let calls = 0
    Reflect.set(globalThis, key, () => {
      calls++
      return { accountFor: async () => ({ account_id: 'account-b' }) }
    })
    const request = input()
    expect(
      await chooseVaultRouting({
        ...request,
        vaultMode: kind !== 'local',
        fresh: kind !== 'warm',
        request: {
          ...request.request,
          retry: kind === 'retry',
          kind: ['title', 'compaction', 'keep-warm'].includes(kind)
            ? kind
            : 'primary',
        },
      }),
    ).toBeUndefined()
    expect(calls).toBe(0)
  },
)

test('OpenCode 1 routing metadata excludes hidden agents and unclassified calls', () => {
  const body = JSON.stringify({ model: 'gpt-6', input: [] })
  expect(vaultRoutingRequestFromBody(body, 'build')?.kind).toBe('primary')
  for (const agent of ['title', 'compaction', 'summary', undefined])
    expect(vaultRoutingRequestFromBody(body, agent)?.kind).toBe('auxiliary')
  expect(vaultRoutingRequestFromBody('{}', 'build')).toBeUndefined()
  expect(vaultRoutingRequestFromBody('invalid', 'build')).toBeUndefined()
})

test('served reports filter headers and never wait for the engine', () => {
  const calls: unknown[] = []
  Reflect.set(globalThis, key, (sessionId: string) => ({
    report: (report: unknown) => {
      calls.push([sessionId, report])
      return new Promise(() => {})
    },
  }))
  const receipt: QuotaReceipt = {
    credentialId: 'credential-b',
    accountIdentity: 'account-b',
    accountIdentitySource: 'asserted',
  }
  expect(
    reportVaultRouting('session', receipt, {
      status: 200,
      headers: new Headers({
        'x-codex-primary-used-percent': '42',
        'retry-after': '10',
        authorization: 'Bearer secret',
        'set-cookie': 'secret',
        'x-codex-email': 'private@example.com',
      }),
    }),
  ).toBeUndefined()
  expect(calls).toEqual([
    [
      'session',
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'served',
        headers: { 'x-codex-primary-used-percent': '42', 'retry-after': '10' },
      },
    ],
  ])
})

test('routing report throws and rejections never escape', async () => {
  const receipt: QuotaReceipt = {
    credentialId: 'credential-b',
    accountIdentity: 'account-b',
    accountIdentitySource: 'asserted',
  }
  for (const reject of [true, false]) {
    Reflect.set(globalThis, key, () => ({
      report: () => {
        if (reject) return Promise.reject(new Error('report refused'))
        throw new Error('report unavailable')
      },
    }))
    expect(() =>
      reportVaultRouting('session', receipt, {
        status: 200,
        headers: new Headers(),
      }),
    ).not.toThrow()
    await Promise.resolve()
  }
})

const receipt: QuotaReceipt = {
  credentialId: 'credential-b',
  accountIdentity: 'account-b',
  accountIdentitySource: 'asserted',
}

function captureReports() {
  const reports: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    report: (payload: unknown) => {
      reports.push(payload)
      return new Promise(() => {})
    },
  }))
  return reports
}

test.each(['usage_limit_reached', 'insufficient_quota', 'quota_exceeded'])(
  '%s 429 reports exhaustion with the explicit reset, not served',
  (code) => {
    const reports = captureReports()
    reportVaultRouting('session', receipt, {
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      limit: { window: code, resetAt: 1_900_000_000_000 },
    })
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'exhausted',
        window: code,
        resets_at: 1_900_000_000_000,
      },
    ])
  },
)

test.each([
  { slot: 'primary', minutes: 300, window: '5h' },
  { slot: 'secondary', minutes: 10080, window: '7d' },
  { slot: 'primary', minutes: 240, window: 'primary' },
])(
  'named $slot with $minutes minutes reports $window and Retry-After',
  ({ slot, minutes, window }) => {
    const reports = captureReports()
    reportVaultRouting('session', receipt, {
      status: 429,
      headers: new Headers({
        [`x-codex-${slot}-window-minutes`]: String(minutes),
        'retry-after': '20',
      }),
      limit: { window: 'usage_limit_reached' },
      body: {
        error: { type: 'usage_limit_reached', rate_limit_reached_type: slot },
      },
      now: 1_800_000_000_000,
    })
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'exhausted',
        window,
        resets_at: 1_800_000_020_000,
      },
    ])
  },
)

test('cached window minutes can name exhaustion, but only an explicit reset header supplies its reset', () => {
  const reports = captureReports()
  reportVaultRouting('session', receipt, {
    status: 429,
    headers: new Headers({ 'x-codex-primary-reset-at': '1900000000' }),
    limit: { window: 'usage_limit_reached' },
    body: { error: { rate_limit_reached_type: 'primary' } },
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          usedPercent: 100,
          windowMinutes: 10080,
          checkedAt: Date.now(),
          resetsAt: '2099-01-01T00:00:00Z',
        },
      ],
    },
  })
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'credential-b',
      outcome: 'exhausted',
      window: '7d',
      resets_at: 1_900_000_000_000,
    },
  ])
})

test('a quota code retains a scoped window and accepts an HTTP-date Retry-After', () => {
  const reports = captureReports()
  reportVaultRouting('session', receipt, {
    status: 429,
    headers: new Headers({ 'retry-after': 'Fri, 01 Jan 2027 00:00:00 GMT' }),
    limit: { window: 'api_error' },
    body: {
      error: {
        type: 'api_error',
        code: 'insufficient_quota',
        window: 'model-budget',
      },
    },
  })
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'credential-b',
      outcome: 'exhausted',
      window: 'model-budget',
      resets_at: 1_798_761_600_000,
    },
  ])
})

test.each([
  { status: 429, limit: { window: 'rate_limit_exceeded' } },
  { status: 429, limit: { window: 'turn_rate_limit_exceeded' } },
  { status: 429, limit: { window: 'rate_limit' } },
  { status: 401, limit: { window: 'usage_limit_reached' } },
  { status: 500, limit: { window: 'usage_limit_reached' } },
  { status: 200, failed: true },
])(
  '$status with $limit does not report a served or exhausted outcome',
  (response) => {
    const reports = captureReports()
    reportVaultRouting('session', receipt, {
      ...response,
      headers: new Headers({
        'x-codex-primary-used-percent': '100',
        'retry-after': '10',
      }),
    })
    expect(reports).toEqual([])
  },
)

test('successful response observation reports only after consumption, without waiting for routing', async () => {
  const reports = captureReports()
  const response = observeVaultRoutingResponse(
    'session',
    receipt,
    new Response('body'),
    { parseLimit: () => undefined },
  )
  expect(reports).toEqual([])
  expect(await response.text()).toBe('body')
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'credential-b',
      outcome: 'served',
      headers: {},
    },
  ])
})

test.each([{ status: 200 }, { status: 429 }])(
  'without an accessor, status $status returns the same Response without reaching reportRouting',
  ({ status }) => {
    Reflect.deleteProperty(globalThis, key)
    const report = spyOn(routingClient, 'reportRouting')
    const response = new Response('data: {"type":"response.completed"}\n\n', {
      status,
      headers: { 'content-type': 'text/event-stream' },
    })
    const clone = spyOn(response, 'clone')
    Object.defineProperties(response, {
      url: { value: 'https://codex.test/redirected' },
      redirected: { value: true },
    })
    try {
      const observed = observeVaultRoutingResponse(
        'session',
        receipt,
        response,
        { parseLimit: () => undefined },
      )
      expect(observed).toBe(response)
      expect(observed.url).toBe('https://codex.test/redirected')
      expect(observed.redirected).toBe(true)
      reportVaultRouting('session', receipt, {
        status: 200,
        headers: new Headers(),
      })
      expect(report).not.toHaveBeenCalled()
      expect(clone).not.toHaveBeenCalled()
    } finally {
      report.mockRestore()
      clone.mockRestore()
    }
  },
)

test('response observation checks bridge presence afresh for late loading and unloading', async () => {
  Reflect.deleteProperty(globalThis, key)
  const first = new Response('first')
  expect(
    observeVaultRoutingResponse('session', receipt, first, {
      parseLimit: () => undefined,
    }),
  ).toBe(first)
  const reports = captureReports()
  const second = new Response('second')
  Object.defineProperties(second, {
    url: { value: 'https://codex.test/redirected' },
    redirected: { value: true },
  })
  const observed = observeVaultRoutingResponse('session', receipt, second, {
    parseLimit: () => undefined,
  })
  expect(observed.url).toBe(second.url)
  expect(observed.redirected).toBe(second.redirected)
  expect(await observed.text()).toBe('second')
  expect(reports).toHaveLength(1)
  Reflect.deleteProperty(globalThis, key)
  const third = new Response('third')
  expect(
    observeVaultRoutingResponse('session', receipt, third, {
      parseLimit: () => undefined,
    }),
  ).toBe(third)
})

test('active routing observation does not JSON-parse ordinary SSE data lines', async () => {
  const reports = captureReports()
  const body =
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.output_text.delta","delta":"error"}\n\ndata: {"type":"response.completed"}\n\n'
  const parse = spyOn(JSON, 'parse')
  try {
    const response = observeVaultRoutingResponse(
      'session',
      receipt,
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      { parseLimit: () => undefined },
    )
    expect(await response.text()).toBe(body)
    expect(parse).not.toHaveBeenCalled()
    expect(reports).toHaveLength(1)
  } finally {
    parse.mockRestore()
  }
})

test.each([
  'data: {"type":"response.failed"}\n\n',
  'data: {"type" : "error","error":{"message":"failed"}}\n\n',
  'event: error\ndata: {"message":"failed"}\n\n',
  'data: {"type":"response.completed","response":{"status":"failed"}}\n\n',
])('prefiltered failure remains unserved: %s', async (body) => {
  const reports = captureReports()
  const response = observeVaultRoutingResponse(
    'session',
    receipt,
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    { parseLimit: () => undefined },
  )
  expect(await response.text()).toBe(body)
  expect(reports).toEqual([])
})

test('an SSE error is preserved byte-for-byte and never reported as served', async () => {
  const reports = captureReports()
  const body =
    'data: {"type":"response.created"}\n\ndata: {"type":"error","error":{"message":"failed"}}\n\n'
  const response = observeVaultRoutingResponse(
    'session',
    receipt,
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    { parseLimit: () => undefined },
  )
  expect(await response.text()).toBe(body)
  expect(reports).toEqual([])
})

test('a broken response body never reports served', async () => {
  const reports = captureReports()
  const response = observeVaultRoutingResponse(
    'session',
    receipt,
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('stream failed'))
        },
      }),
    ),
    { parseLimit: () => undefined },
  )
  await expect(response.text()).rejects.toThrow('stream failed')
  expect(reports).toEqual([])
})

test('exhaustion without an explicit reset never borrows the cached reset', () => {
  const reports = captureReports()
  reportVaultRouting('session', receipt, {
    status: 429,
    headers: new Headers(),
    limit: { window: 'usage_limit_reached' },
    body: { error: { rate_limit_reached_type: 'primary' } },
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          usedPercent: 100,
          windowMinutes: 300,
          checkedAt: Date.now(),
          resetsAt: '2099-01-01T00:00:00Z',
        },
      ],
    },
  })
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'credential-b',
      outcome: 'exhausted',
      window: '5h',
    },
  ])
})

test('cancelling an observed body cancels its source and reports nothing', async () => {
  const reports = captureReports()
  let cancelled = false
  let onSourceCancel!: () => void
  const sourceCancelled = new Promise<void>((resolve) => {
    onSourceCancel = resolve
  })
  const response = observeVaultRoutingResponse(
    'session',
    receipt,
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
          onSourceCancel()
        },
      }),
    ),
    { parseLimit: () => undefined },
  )
  await response.body?.cancel()
  await sourceCancelled
  expect(cancelled).toBe(true)
  expect(reports).toEqual([])
})
