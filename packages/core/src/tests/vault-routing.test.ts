import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import * as routingClient from '@cortexkit/common-auth/routing-accessor'
import {
  chooseVaultRouting,
  reportVaultRouting,
  reportVaultRoutingLimit,
  startVaultRoutingWait,
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
    [
      'session',
      {
        provider: 'openai',
        modelId: 'gpt-6',
        hold_wait_max_s: 0,
        refusals: true,
        candidates: {
          view_digest: expect.any(String),
          accounts: [
            { account_id: 'account-a', credential_id: 'credential-a' },
            { account_id: 'account-b', credential_id: 'credential-b' },
          ],
        },
      },
      { deadlineMs: 1500 },
    ],
  ])
})

test.each([undefined, 'route-b'])(
  'fleet advice carries only an existing session warm credential (%s)',
  async (warmAccountId) => {
    const calls: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async (request: unknown) => {
        calls.push(request)
      },
    }))
    await chooseVaultRouting({ ...input(), warmAccountId })
    expect(calls).toEqual([
      {
        provider: 'openai',
        modelId: 'gpt-6',
        hold_wait_max_s: 0,
        refusals: true,
        candidates: expect.objectContaining({
          view_digest: expect.any(String),
        }),
        ...(warmAccountId ? { warm_credential: 'credential-b' } : {}),
      },
    ])
  },
)

test('wait reporting skips absent accessors and waits planned below two seconds', () => {
  Reflect.deleteProperty(globalThis, key)
  const uuid = spyOn(crypto, 'randomUUID')
  try {
    expect(
      startVaultRoutingWait({
        sessionId: 'session',
        reason: 'account_limit',
        now: 1000,
        nextMs: 4000,
      }),
    ).toBeUndefined()
    const calls: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      report: (payload: unknown) => calls.push(payload),
    }))
    expect(
      startVaultRoutingWait({
        sessionId: 'session',
        reason: 'account_limit',
        now: 1000,
        nextMs: 2999,
      }),
    ).toBeUndefined()
    expect(
      startVaultRoutingWait({
        sessionId: 'session',
        reason: 'quota_reading',
        now: 1000,
        boundMs: 1999,
      }),
    ).toBeUndefined()
    expect(
      startVaultRoutingWait({
        sessionId: 'session',
        reason: 'account_free',
        now: 1000,
        nextMs: 2999,
        boundMs: 5000,
      }),
    ).toBeUndefined()
    expect(calls).toEqual([])
    expect(uuid).not.toHaveBeenCalled()
  } finally {
    uuid.mockRestore()
  }
})

test.each([
  ['account_limit', 'Waiting for the account limit to reset'],
  ['account_free', 'Waiting for an account to come free'],
  ['quota_reading', 'Checking account quota'],
] as const)(
  'wait reports use fixed wire fields for %s without awaiting reports',
  (reason, message) => {
    const calls: unknown[] = []
    Reflect.set(globalThis, key, (sessionId: string) => ({
      report: (payload: unknown) => {
        calls.push([sessionId, payload])
        return new Promise(() => {})
      },
    }))
    const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(
      '12345678-1234-4234-8234-123456789abc',
    )
    try {
      const end = startVaultRoutingWait({
        sessionId: 'session',
        reason,
        now: 1000,
        ...(reason === 'quota_reading' ? { boundMs: 2000 } : { nextMs: 3000 }),
        attempt: 2,
      })
      expect(end).toBeFunction()
      end?.('resumed')
      const base = {
        kind: 'wait',
        wait_id: '12345678-1234-4234-8234-123456789abc',
        reason,
        ...(reason === 'quota_reading' ? {} : { next_ms: 3000 }),
        attempt: 2,
        message,
      }
      expect(calls).toEqual([
        ['session', { ...base, phase: 'start' }],
        ['session', { ...base, phase: 'end', outcome: 'resumed' }],
      ])
    } finally {
      uuid.mockRestore()
    }
  },
)

test.each([
  { setting: 0, expected: 0 },
  { setting: 15, expected: 900 },
  { setting: 'max', expected: 1799 },
])(
  'fleet advice receives the activity account cap for $setting',
  async ({ setting, expected }) => {
    const calls: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async (...args: unknown[]) => {
        calls.push(args)
        return {
          account_id: 'account-b',
          credential_id: 'credential-b',
          retry_after_ms: 999999999,
        }
      },
    }))
    const request = input()
    const accountKey = {
      namespace: 'vault',
      accountId: 'route-a',
      incarnation: '1',
    }
    expect(
      await chooseVaultRouting({
        ...request,
        eligibleIds: ['route-b'],
        wait: {
          activity: {
            accountKey,
            lastAcceptedAt: request.routing.now - 1,
            ttlMs: 1800000,
          },
          accountKey,
          maxSameAccountWait: setting,
        },
      }),
    ).toBe('route-b')
    expect(calls).toEqual([
      [
        {
          provider: 'openai',
          modelId: 'gpt-6',
          hold_wait_max_s: expected,
          candidates: expect.objectContaining({
            view_digest: expect.any(String),
          }),
          refusals: true,
        },
        { deadlineMs: 1500 },
      ],
    ])
  },
)

test('a continue hold beyond the remaining cache lifetime is refused', async () => {
  const request = input()
  const accountKey = {
    namespace: 'vault',
    accountId: 'route-a',
    incarnation: '1',
  }
  Reflect.set(globalThis, key, () => ({
    accountFor: async () => ({
      account_id: 'account-a',
      credential_id: 'credential-a',
      hold: { retry_after_ms: 300_000 },
    }),
  }))
  expect(
    await chooseVaultRouting({
      ...request,
      fresh: false,
      eligibleIds: ['route-b'],
      continuation: {
        previousId: 'route-a',
        exhausted: {
          accountId: 'account-a',
          credentialId: 'credential-a',
          limitWindow: 'seven_day',
          observedAtMs: request.routing.now,
        },
      },
      wait: {
        activity: {
          accountKey,
          lastAcceptedAt: request.routing.now - 1,
          ttlMs: 60_001,
        },
        accountKey,
        maxSameAccountWait: 'max',
      },
    }),
  ).toEqual({ refused: { code: 'account_selection_refused' } })
})

test('a cancelled continuation discards a late routing choice', async () => {
  const request = input()
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const late = Promise.withResolvers<{ account_id: string }>()
  const accountFor = mock(async () => {
    entered.resolve()
    return late.promise
  })
  Reflect.set(globalThis, key, () => ({ accountFor }))
  const outcome = chooseVaultRouting({
    ...request,
    fresh: false,
    signal: controller.signal,
    continuation: {
      previousId: 'route-a',
      exhausted: {
        accountId: 'account-a',
        credentialId: 'credential-a',
        limitWindow: 'five_hour',
        observedAtMs: request.routing.now,
      },
    },
  })
  await entered.promise
  controller.abort()
  late.resolve({ account_id: 'account-b' })
  await expect(outcome).rejects.toBe(controller.signal.reason)
  expect(accountFor).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'continue' }),
    { deadlineMs: 1500, signal: controller.signal },
  )
})

test('a continue asks with the held route but does not offer confirmed exhausted alternatives', async () => {
  const request = input()
  request.routing.rows[1]!.quota.limits[0]!.usedPercent = 100
  Object.assign(request.routing.rows[1]!.quota.limits[0]!, {
    resetsAt: new Date(request.routing.now + 60000).toISOString(),
  })
  const accountFor = mock(async (_ask: unknown) => ({
    account_id: 'account-b',
  }))
  Reflect.set(globalThis, key, () => ({ accountFor }))
  expect(
    await chooseVaultRouting({
      ...request,
      eligibleIds: ['route-b'],
      continuation: {
        previousId: 'route-a',
        exhausted: {
          accountId: 'account-a',
          credentialId: 'credential-a',
          limitWindow: 'five_hour',
          observedAtMs: request.routing.now,
        },
      },
    }),
  ).toBeUndefined()
  expect(accountFor).toHaveBeenCalledWith(
    expect.objectContaining({
      candidates: expect.objectContaining({
        accounts: [{ account_id: 'account-a', credential_id: 'credential-a' }],
      }),
    }),
    expect.anything(),
  )
})

test.each([
  'account_limit_exhausted',
  'account_selection_refused',
  'account_selection_final',
])('routing refusal %s is returned instead of a route', async (code) => {
  Reflect.set(globalThis, key, () => ({
    accountFor: async () => ({
      refused: {
        code,
        routing_code: 'quota',
        retry_after_secs: 60,
        resets_at_ms: 2_000_000_000_000,
      },
    }),
  }))
  expect(await chooseVaultRouting(input())).toEqual({
    refused: {
      code,
      routingCode: 'quota',
      retryAfterSecs: 60,
      resetsAtMs: 2_000_000_000_000,
    },
  })
})

test.each([
  'absent',
  'none',
  'ineligible',
  'wrong-credential',
  'throw',
  'reject',
  'unreadable',
  'unknown-code',
  'timeout',
])('%s routing advice leaves the caller its own choice', async (kind) => {
  Reflect.deleteProperty(globalThis, key)
  if (kind !== 'absent')
    Reflect.set(globalThis, key, () => ({
      accountFor: () => {
        if (kind === 'throw') throw new Error('unavailable')
        if (kind === 'reject') return Promise.reject(new Error('unavailable'))
        if (kind === 'timeout') return new Promise(() => {})
        if (kind === 'none') return Promise.resolve(undefined)
        if (kind === 'unreadable')
          return Promise.resolve({
            get refused() {
              throw new Error('unreadable')
            },
          })
        if (kind === 'unknown-code')
          return Promise.resolve({ refused: { code: 'unknown' } })
        return Promise.resolve(
          kind === 'wrong-credential'
            ? { account_id: 'account-b', credential_id: 'credential-a' }
            : { account_id: 'outside-roster' },
        )
      },
    }))
  const start = performance.now()
  expect(await chooseVaultRouting(input())).toBeUndefined()
  if (kind === 'timeout') {
    expect(performance.now() - start).toBeGreaterThanOrEqual(1450)
    expect(performance.now() - start).toBeLessThan(2500)
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

test.each(['local', 'warm', 'retry', 'no-session', 'no-candidates', 'blocked'])(
  '%s request never asks the fleet',
  async (kind) => {
    let calls = 0
    Reflect.set(globalThis, key, () => {
      calls++
      return {
        accountFor: async () => ({
          refused: { code: 'account_selection_final' },
        }),
      }
    })
    const request = input()
    expect(
      await chooseVaultRouting({
        ...request,
        vaultMode: kind !== 'local',
        fresh: kind !== 'warm',
        sessionId: kind === 'no-session' ? undefined : request.sessionId,
        routes: kind === 'no-candidates' ? [] : request.routes,
        routing:
          kind === 'blocked'
            ? { ...request.routing, rows: [] }
            : request.routing,
        request: {
          ...request.request,
          retry: kind === 'retry',
        },
      }),
    ).toBeUndefined()
    expect(calls).toBe(0)
  },
)

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

test('classified exhaustion resolves slot minutes and keeps parsed-reset precedence', () => {
  const reports = captureReports()
  reportVaultRoutingLimit(
    'session',
    receipt,
    { window: 'primary', resetAt: 1_900_000_000_000 },
    {
      quota: {
        limits: [
          {
            scope: 'all',
            label: 'primary',
            kind: 'reading',
            usedPercent: 100,
            windowMinutes: 300,
            checkedAt: Date.now(),
          },
        ],
      },
      headers: new Headers({
        'x-codex-primary-reset-at': '1950000000',
        'retry-after': '20',
      }),
    },
  )
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'credential-b',
      outcome: 'exhausted',
      window: '5h',
      resets_at: 1_900_000_000_000,
    },
  ])
})

test.each([undefined, 1_900_000_000])(
  'classified named-frame reset %s never borrows quota bookkeeping',
  (reset) => {
    const reports = captureReports()
    reportVaultRoutingLimit(
      'session',
      receipt,
      { window: 'primary' },
      {
        body: {
          type: 'response.failed',
          response: {
            failed: {
              rate_limit_reached_type: 'primary',
              ...(reset !== undefined ? { resets_at: reset } : {}),
            },
          },
        },
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
      },
    )
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'exhausted',
        window: '5h',
        ...(reset !== undefined ? { resets_at: 1_900_000_000_000 } : {}),
      },
    ])
  },
)

test.each([
  'rate_limit',
  'rate_limit_exceeded',
  'turn_rate_limit_exceeded',
  'message text',
])(
  'classified-limit reporting rejects %s even when the body names a quota window',
  (window) => {
    const reports = captureReports()
    reportVaultRoutingLimit(
      'session',
      receipt,
      { window },
      {
        body: { error: { window: '5h' } },
      },
    )
    expect(reports).toEqual([])
  },
)

test('without routing, classified-limit reporting does not inspect the signal or quota', () => {
  Reflect.deleteProperty(globalThis, key)
  const unexpected = () => {
    throw new Error('routing-only data inspected')
  }
  expect(() =>
    reportVaultRoutingLimit(
      'session',
      receipt,
      {
        get window(): string {
          return unexpected()
        },
      },
      {
        get body() {
          return unexpected()
        },
        get quota() {
          return unexpected()
        },
        get headers(): Headers {
          return unexpected()
        },
      },
    ),
  ).not.toThrow()
})

test.each(['usage_limit_reached', 'insufficient_quota', 'quota_exceeded'])(
  '%s 429 without a recognized window reports nothing, even with an explicit reset',
  (code) => {
    const reports = captureReports()
    const report = spyOn(routingClient, 'reportRouting')
    try {
      reportVaultRouting('session', receipt, {
        status: 429,
        headers: new Headers({ 'retry-after': '5' }),
        limit: { window: code, resetAt: 1_900_000_000_000 },
      })
      expect(reports).toEqual([])
      expect(report).not.toHaveBeenCalled()
    } finally {
      report.mockRestore()
    }
  },
)

test.each([
  { slot: 'primary', minutes: 300, window: '5h' },
  { slot: 'secondary', minutes: 10080, window: '7d' },
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

test.each([undefined, 240])(
  'a named primary window with %s minutes reports nothing',
  (minutes) => {
    const reports = captureReports()
    reportVaultRouting('session', receipt, {
      status: 429,
      headers: new Headers({
        ...(minutes !== undefined
          ? { 'x-codex-primary-window-minutes': String(minutes) }
          : {}),
        'retry-after': '20',
      }),
      limit: { window: 'usage_limit_reached' },
      body: { error: { rate_limit_reached_type: 'primary' } },
    })
    expect(reports).toEqual([])
  },
)

test.each(['5h', '7d'])(
  'a usage-limit 429 naming %s reports account-wide exhaustion with the explicit reset',
  (window) => {
    const reports = captureReports()
    reportVaultRouting('session', receipt, {
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      limit: { window: 'usage_limit_reached', resetAt: 1_900_000_000_000 },
      body: { error: { window, pool: 'model-budget' } },
    })
    expect(reports).toEqual([
      {
        account_id: 'account-b',
        credential_id: 'credential-b',
        outcome: 'exhausted',
        window,
        resets_at: 1_900_000_000_000,
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

test('a quota code with a model-scoped window reports nothing', () => {
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
  expect(reports).toEqual([])
})

test('a quota code with a 7d window accepts an HTTP-date Retry-After', () => {
  const reports = captureReports()
  reportVaultRouting('session', receipt, {
    status: 429,
    headers: new Headers({ 'retry-after': 'Fri, 01 Jan 2027 00:00:00 GMT' }),
    limit: { window: 'api_error' },
    body: { error: { code: 'insufficient_quota', window: '7d' } },
  })
  expect(reports).toEqual([
    {
      account_id: 'account-b',
      credential_id: 'credential-b',
      outcome: 'exhausted',
      window: '7d',
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
