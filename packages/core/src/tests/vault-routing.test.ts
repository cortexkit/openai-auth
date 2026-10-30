import { afterEach, expect, test } from 'bun:test'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import {
  chooseVaultRouting,
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
    reportVaultRouting(
      'session',
      receipt,
      new Headers({
        'x-codex-primary-used-percent': '42',
        'retry-after': '10',
        authorization: 'Bearer secret',
        'set-cookie': 'secret',
        'x-codex-email': 'private@example.com',
      }),
    ),
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
      reportVaultRouting('session', receipt, new Headers()),
    ).not.toThrow()
    await Promise.resolve()
  }
})
