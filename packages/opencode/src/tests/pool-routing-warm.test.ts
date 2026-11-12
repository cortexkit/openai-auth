import { afterEach, expect, test } from 'bun:test'
import type { PoolRequestContext } from '../core/pool-request'
import { servePoolRequest } from '../core/pool-request'

const key = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, key)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, key, original)
  else Reflect.deleteProperty(globalThis, key)
})
const now = 1_900_000_000_000
function context(): PoolRequestContext {
  const routes = ['a', 'b'].map((id) => ({
    id: `vault:${id}`,
    identity: `account-${id}`,
    credentialId: `credential-${id}`,
    kind: 'oauth' as const,
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          usedPercent: 10,
          checkedAt: now,
        },
      ],
    },
  }))
  return {
    source: new Proxy({} as PoolRequestContext['source'], {
      get(_target, property) {
        if (property === 'refreshBackoffFor') return () => new Map()
        throw new Error('vault requests must not read local pool')
      },
    }),
    vault: {
      routes: () => routes,
      awaitRoster: async () => {},
      noRouteCause: () => 'vault-empty',
      send: async (id, dispatch) =>
        dispatch('token', {
          accountIdentitySource: 'asserted',
          credentialId: routes.find((route) => route.id === id)!.credentialId,
        }),
      requestReading: () => {},
    },
    storage: null,
    mode: 'ordered',
    sessionId: 'warm-session',
    routingRequest: { modelId: 'gpt-6', kind: 'primary' },
    body: '{}',
    replayable: true,
    now: () => now,
    rateLimitMarks: () => new Map(),
    send: async () => new Response('ok'),
    recordQuota: () => {},
    placePin: () => undefined,
    blocked: () => new Response(null, { status: 429 }),
    resetCredits: () => undefined,
    isAbort: () => false,
    log: { debug() {} },
  }
}

test.each([undefined, 'vault:b'])(
  'OpenCode 1 ordered routing hints only the current session account (%s)',
  async (currentId) => {
    const calls: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async (request: unknown) => {
        calls.push(request)
      },
    }))
    const ctx = context()
    ctx.limitPolicy = {
      pending: new Map(),
      accountKey: () => undefined,
      activity: () => undefined,
      currentAccountKey: () =>
        currentId
          ? { namespace: 'vault', accountId: currentId, incarnation: '1' }
          : undefined,
      owner: () => undefined,
    }
    await servePoolRequest(ctx)
    expect(calls).toEqual([
      {
        provider: 'openai',
        modelId: 'gpt-6',
        hold_wait_max_s: 0,
        refusals: true,
        ...(currentId ? { warm_credential: 'credential-b' } : {}),
      },
    ])
  },
)

test('OpenCode 1 first quota wait never reports a plugin wait', async () => {
  const reports: Array<{ kind?: string }> = []
  Reflect.set(globalThis, key, () => ({
    report: (payload: { kind?: string }) => reports.push(payload),
  }))
  const ctx = context()
  const routes = ctx
    .vault!.routes()
    .map((route) => ({ ...route, quota: undefined }))
  ctx.vault!.routes = () => routes
  ctx.vault!.requestReading = async () => {}
  await servePoolRequest(ctx)
  expect(reports.filter((report) => report.kind === 'wait')).toEqual([])
})
