// Vault mode on OpenCode's request path: while this host is enrolled with the
// Claustrum vault, the vault's accounts are the only candidates. No pool row
// routes, not even one signing in as an account the vault does not hold; the
// pool source refreshes, polls and offers a bearer for none of them; and the
// sidebar file lists the vault accounts in place of the local ones.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import {
  type AccountPaths,
  type AccountStorage,
  placeStickyPin,
} from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source'
import {
  type NoCredentialCause,
  type PoolRequestContext,
  type PoolVaultRoutes,
  servePoolRequest,
} from '../core/pool-request'
import { buildVaultSidebarMachineState } from '../core/pool-sidebar'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarState,
  hashSidebarSessionId,
  resolveActiveAccount,
  resolveSessionSidebarRouting,
  type SidebarState,
  setSidebarMachineState,
  setSidebarState,
} from '../sidebar-state'
import { renderedQuotas } from '../tui.tsx'
import { loadHostPolicy } from './fixtures/opencode1-error-policy'
import { HOUR, quotaMap, seedPool } from './fixtures/pool-install'

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-vault-mode-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function files(): string[] {
  return [paths.configPath, paths.statePath].map((path) =>
    readFileSync(path, 'utf8'),
  )
}

describe('the request path in vault mode', () => {
  /**
   * A request over healthy pool rows the vault does not hold. The source is
   * given no vault-mode switch, so only the request path's own rule keeps
   * the rows out.
   */
  async function serve(
    vault: PoolVaultRoutes,
    storage: AccountStorage | null = null,
    mode: PoolRequestContext['mode'] = 'fallback-first',
    status = 200,
    overrides: Partial<PoolRequestContext> = {},
  ) {
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'spare', quota: quotaMap(5) },
    ])
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async () => {
        throw new Error('no refresh expected')
      },
      pullQuota: async () => undefined,
    })
    await source.load()
    const sent: string[] = []
    const causes: Array<NoCredentialCause | undefined> = []
    const ctx: PoolRequestContext = {
      source,
      rateLimitMarks: () => new Map(),
      vault,
      storage,
      mode,
      sessionId: undefined,
      body: '{}',
      replayable: true,
      now: Date.now,
      send: async (target, token) => {
        sent.push(`${target.id}:${token}`)
        return new Response('ok', { status })
      },
      recordQuota: () => {},
      placePin: () => undefined,
      blocked: (_block, _quotas, cause) => {
        causes.push(cause)
        return new Response('refused', { status: 401 })
      },
      resetCredits: () => undefined,
      isAbort: () => false,
      log: { debug: () => {} },
      ...overrides,
    }
    try {
      const result = await servePoolRequest(ctx)
      return { result, sent, causes }
    } finally {
      source.dispose()
      await source.settled()
    }
  }

  function vaultWith(
    routes: ReturnType<PoolVaultRoutes['routes']>,
    cause: 'vault-unreachable' | 'vault-empty' = 'vault-empty',
  ): PoolVaultRoutes {
    return {
      routes: () => routes,
      awaitRoster: async () => {},
      noRouteCause: () => cause,
      send: async (id, dispatch) =>
        dispatch(`vault-token-${id}`, {
          credentialId: routes.find((row) => row.id === id)?.credentialId ?? id,
          accountIdentity: routes.find((row) => row.id === id)?.identity,
          accountIdentitySource: 'asserted',
        }),
      requestReading: () => {},
    }
  }

  for (const mode of ['ordered', 'sticky-balanced'] as const) {
    for (const code of [
      'account_limit_exhausted',
      'account_selection_refused',
      'account_selection_final',
    ]) {
      it(`OpenCode 1 routing refusal ${code} stops ${mode} before sending or marking an account`, async () => {
        const key = Symbol.for('cortexkit.routing')
        const previous = Reflect.get(globalThis, key)
        const accountFor = mock(async () => ({
          refused: {
            code,
            message: 'private account-429 at capacity; retry in 500 seconds',
            routing_code: 'private-account-429',
            retry_after_secs: 500,
          },
        }))
        Reflect.set(globalThis, key, () => ({ accountFor }))
        const providerFetch = mock(async () => new Response('ok'))
        const recordQuota = mock(() => {})
        const pins = new Map()
        const marks = new Map<string, number>()
        const vault = vaultWith(
          ['a', 'b'].map((id) => ({
            id: `vault:${id}`,
            identity: `account-${id}`,
            credentialId: `credential-${id}`,
            kind: 'oauth' as const,
            quota: quotaMap(10),
          })),
        )
        const authorize = mock(vault.send)
        vault.send = authorize
        try {
          const error = await serve(vault, null, mode, 200, {
            sessionId: 'refused-session',
            routingRequest: { modelId: 'gpt-6', kind: 'primary' },
            send: providerFetch,
            recordQuota,
            rateLimitMarks: () => marks,
            placePin: (input) =>
              placeStickyPin(pins, input, (id, pin) => pins.set(id, pin)),
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(error).toBeInstanceOf(Error)
          const message = (error as Error).message
          expect(message).toBe(
            'Thalamus routing declined this request, so it was not sent.',
          )
          expect(
            loadHostPolicy().retryable(
              { name: 'UnknownError', data: { type: 'api_error', message } },
              'openai',
            ),
          ).toBeUndefined()
          expect(accountFor).toHaveBeenCalledTimes(1)
          expect(authorize).not.toHaveBeenCalled()
          expect(providerFetch).not.toHaveBeenCalled()
          expect(recordQuota).not.toHaveBeenCalled()
          expect(marks.size).toBe(0)
          expect(pins.size).toBe(0)
        } finally {
          if (previous === undefined) Reflect.deleteProperty(globalThis, key)
          else Reflect.set(globalThis, key, previous)
        }
      })
    }
  }

  it('an eligible fleet answer places a cold vault session on the named account', async () => {
    const key = Symbol.for('cortexkit.routing')
    const previous = Reflect.get(globalThis, key)
    const asks: unknown[] = []
    const reports: unknown[] = []
    Reflect.set(globalThis, key, () => ({
      accountFor: async (...args: unknown[]) => {
        asks.push(args)
        return { account_id: 'account-b' }
      },
      report: (report: unknown) => {
        reports.push(report)
        return new Promise(() => {})
      },
    }))
    const pins = new Map()
    try {
      const routes = ['a', 'b'].map((id) => ({
        id: `vault:${id}`,
        identity: `account-${id}`,
        credentialId: `credential-${id}`,
        kind: 'oauth' as const,
        quota: quotaMap(10),
      }))
      const result = await serve(
        vaultWith(routes),
        null,
        'sticky-balanced',
        200,
        {
          sessionId: 'cold-session',
          routingRequest: { modelId: 'gpt-6', kind: 'primary' },
          placePin: (input) =>
            placeStickyPin(pins, input, (id, pin) => pins.set(id, pin)),
        },
      )
      expect(result.result.servedId).toBe('vault:b')
      expect(pins.get('cold-session')?.accountId).toBe('vault:b')
      expect(asks).toHaveLength(1)
      await result.result.response.text()
      expect(reports).toEqual([
        {
          account_id: 'account-b',
          credential_id: 'credential-b',
          outcome: 'served',
          headers: {},
        },
      ])
      const warm = await serve(
        vaultWith(routes),
        null,
        'sticky-balanced',
        200,
        {
          sessionId: 'cold-session',
          routingRequest: { modelId: 'gpt-6', kind: 'primary' },
          placePin: (input) =>
            placeStickyPin(pins, input, (id, pin) => pins.set(id, pin)),
        },
      )
      expect(warm.result.servedId).toBe('vault:b')
      expect(asks).toHaveLength(1)
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key)
      else Reflect.set(globalThis, key, previous)
    }
  })

  it('OpenCode 1 a cold title asks but does not place a sticky pin', async () => {
    const key = Symbol.for('cortexkit.routing')
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    const accountFor = mock(async () => ({ account_id: 'account-b' }))
    Reflect.set(globalThis, key, () => ({ accountFor }))
    const pins = new Map()
    const routes = ['a', 'b'].map((id) => ({
      id: `vault:${id}`,
      identity: `account-${id}`,
      credentialId: `credential-${id}`,
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }))
    try {
      const { result } = await serve(
        vaultWith(routes),
        null,
        'sticky-balanced',
        200,
        {
          sessionId: 'title-session',
          routingRequest: { modelId: 'gpt-6', kind: 'title' },
          placePin: (input) =>
            placeStickyPin(pins, input, (id, pin) => pins.set(id, pin)),
        },
      )
      expect(result.servedId).toBe('vault:b')
      expect(accountFor).toHaveBeenCalledTimes(1)
      expect(pins.size).toBe(0)
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  it('OpenCode 1 routing does not replay a single-send request', async () => {
    const key = Symbol.for('cortexkit.routing')
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    const accountFor = mock(async () => ({ account_id: 'account-a' }))
    Reflect.set(globalThis, key, () => ({ accountFor }))
    const routes = ['a', 'b'].map((id) => ({
      id: `vault:${id}`,
      identity: `account-${id}`,
      credentialId: `credential-${id}`,
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }))
    const body = JSON.stringify({
      error: { code: 'usage_limit_reached', window: '5h' },
    })
    const send = mock(async () => new Response(body, { status: 429 }))
    try {
      const { result } = await serve(vaultWith(routes), null, 'ordered', 429, {
        sessionId: 'no-replay-session',
        routingRequest: { modelId: 'gpt-6', kind: 'primary' },
        replayable: false,
        send,
      })
      expect(result.response.status).toBe(429)
      expect(await result.response.text()).toBe(body)
      expect(send).toHaveBeenCalledTimes(1)
      expect(accountFor).toHaveBeenCalledTimes(1)
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  for (const kind of [
    'ineligible',
    'no-answer',
    'throw',
    'timeout',
    'retry',
    'title',
    'compaction',
    'keep-warm',
    'local',
  ] as const) {
    it(`OpenCode 1 ordered placement with ${kind} routing input`, async () => {
      const key = Symbol.for('cortexkit.routing')
      const previous = Reflect.get(globalThis, key)
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
      try {
        const routes = ['a', 'b'].map((id) => ({
          id: `vault:${id}`,
          identity: `account-${id}`,
          credentialId: `credential-${id}`,
          kind: 'oauth' as const,
          quota: quotaMap(10),
        }))
        const neverAsk = ['retry', 'local'].includes(kind)
        const { result } = await serve(
          vaultWith(routes),
          null,
          'ordered',
          200,
          {
            ...(kind === 'local' ? { vault: undefined } : {}),
            sessionId: 'ordered-session',
            routingRequest: {
              modelId: 'gpt-6',
              kind: ['title', 'compaction', 'keep-warm'].includes(kind)
                ? kind
                : 'primary',
              retry: kind === 'retry',
            },
          },
        )
        expect(result.servedId).toBe(
          kind === 'local'
            ? 'main'
            : ['title', 'compaction', 'keep-warm'].includes(kind)
              ? 'vault:b'
              : 'vault:a',
        )
        expect(asks).toBe(neverAsk ? 0 : 1)
      } finally {
        if (previous === undefined) Reflect.deleteProperty(globalThis, key)
        else Reflect.set(globalThis, key, previous)
      }
    })
  }

  it.each([
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
    {
      name: 'exhausted: route',
      status: 429,
      headers: undefined,
      code: 'usage_limit_reached',
      next: 'vault:c',
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
    'OpenCode 1 ordered $name reports before moving or retrying',
    async (scenario) => {
      const key = Symbol.for('cortexkit.routing')
      const previous = Reflect.get(globalThis, key)
      const at = Date.now()
      let now = at
      const events: unknown[] = []
      let sent = 0
      const hold = 'hold' in scenario ? scenario.hold : undefined
      const stop = hold?.stop === true || scenario.next === null
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
              },
            }
          if (scenario.next === 'vault:b') return { account_id: 'account-b' }
          if (scenario.next === 'vault:c') return { account_id: 'account-c' }
          return undefined
        },
        report: (report: unknown) => {
          events.push(['report', report])
          return new Promise(() => {})
        },
      }))
      const routes = ['a', 'b', 'c'].map((id) => ({
        id: `vault:${id}`,
        identity: `account-${id}`,
        credentialId: `credential-${id}`,
        kind: 'oauth' as const,
        quota: quotaMap(10),
      }))
      const exhausted = scenario.code === 'usage_limit_reached'
      const vault = vaultWith(routes)
      const accountKey = {
        namespace: 'vault',
        accountId: 'vault:b',
        incarnation: '1',
      }
      const overrides: Partial<PoolRequestContext> = {
        sessionId: 'retry-session',
        routingRequest: { modelId: 'gpt-6', kind: 'primary' },
        vaultRetries: new Map(),
        ...(hold
          ? {
              limitPolicy: {
                pending: new Map(),
                accountKey: (id) =>
                  id === accountKey.accountId ? accountKey : undefined,
                activity: () => ({
                  accountKey,
                  lastAcceptedAt: at,
                  ttlMs: hold.cap * 1000,
                }),
                currentAccountKey: () => (sent > 0 ? accountKey : undefined),
                owner: () => undefined,
              },
            }
          : {}),
        now: () => now,
        send: async ({ id }) => {
          const first = sent++ === 0
          events.push(['send', id])
          if (!first) return new Response('ok')
          return Response.json(
            scenario.code
              ? {
                  error: {
                    code: scenario.code,
                    ...(exhausted
                      ? { window: '5h', resets_in_seconds: 30 }
                      : {}),
                  },
                }
              : {},
            { status: scenario.status, headers: scenario.headers },
          )
        },
      }
      try {
        const run = () =>
          serve(vault, null, 'ordered', scenario.status, overrides)
        if (stop) {
          await expect(run()).rejects.toThrow(
            'Thalamus routing declined this request, so it was not sent.',
          )
        } else {
          const { result } = await run()
          if (!exhausted || scenario.next === 'vault:b') {
            expect(result.response.status).toBe(429)
            expect(result.response.headers.get('retry-after')).toBe(
              String(Math.max(1, Math.ceil((scenario.delay ?? 0) / 1000))),
            )
            now += scenario.delay ?? 1000
            expect((await run()).result.servedId).toBe('vault:b')
          } else expect(result.servedId).toBe(scenario.next!)
        }
        expect(events).toEqual([
          ['ask', expect.not.objectContaining({ mode: 'continue' })],
          ['send', 'vault:b'],
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
          ...(stop ? [] : [['send', scenario.next ?? 'vault:b']]),
        ])
      } finally {
        if (previous === undefined) Reflect.deleteProperty(globalThis, key)
        else Reflect.set(globalThis, key, previous)
      }
    },
  )

  const healthyRoutes = (): Array<
    ReturnType<PoolVaultRoutes['routes']>[number]
  > =>
    ['a', 'b'].map((id) => ({
      id: `vault:${id}`,
      identity: `account-${id}`,
      credentialId: `credential-${id}`,
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }))

  function withRouting(handle: object): () => void {
    const key = Symbol.for('cortexkit.routing')
    const before = Object.getOwnPropertyDescriptor(globalThis, key)
    Reflect.set(globalThis, key, () => handle)
    return () => {
      if (before) Object.defineProperty(globalThis, key, before)
      else Reflect.deleteProperty(globalThis, key)
    }
  }

  it('OC1 an exhausted wake offers live alternatives and excludes exhausted last-path rows', async () => {
    const asks: Array<{ mode?: string; candidates: { accounts: unknown[] } }> =
      []
    const restore = withRouting({
      accountFor: async (ask: (typeof asks)[number]) => {
        asks.push(ask)
        return {
          account_id: ask.mode === 'continue' ? 'account-b' : 'account-a',
        }
      },
    })
    const routes = healthyRoutes()
    routes.push({
      ...routes[1]!,
      id: 'vault:c',
      identity: 'account-c',
      credentialId: 'credential-c',
      quota: quotaMap(100),
    })
    let now = Date.now()
    const sent: string[] = []
    const ctx: Partial<PoolRequestContext> = {
      now: () => now,
      sessionId: 'wake',
      body: '{"model":"gpt-6","input":"turn"}',
      routingRequest: { modelId: 'gpt-6', kind: 'primary' },
      vaultRetries: new Map(),
      send: async ({ id }) => {
        sent.push(id)
        if (sent.length === 1)
          return new Response('rate limited', { status: 429 })
        if (sent.length === 2)
          return Response.json(
            { error: { code: 'usage_limit_reached', window: '5h' } },
            { status: 429 },
          )
        return new Response('ok')
      },
    }
    try {
      const vault = vaultWith(routes)
      expect(
        (await serve(vault, null, 'ordered', 200, ctx)).result.response.status,
      ).toBe(429)
      now += 5000
      expect(
        (await serve(vault, null, 'ordered', 200, ctx)).result.servedId,
      ).toBe('vault:b')
      expect(sent).toEqual(['vault:a', 'vault:a', 'vault:b'])
      expect(asks[1]?.candidates.accounts).toEqual([
        { account_id: 'account-b', credential_id: 'credential-b' },
        { account_id: 'account-a', credential_id: 'credential-a' },
      ])
    } finally {
      restore()
    }
  })

  it.each(
    (['ordered', 'sticky-balanced'] as const).flatMap((mode) =>
      (['place', 'continue'] as const).map((phase) => ({ mode, phase })),
    ),
  )(
    'OC1 $mode stops if a $phase pick cannot be authorized',
    async ({ mode, phase }) => {
      const restore = withRouting({
        accountFor: async (ask: { mode?: string }) => ({
          account_id:
            phase === 'continue' && ask.mode !== 'continue'
              ? 'account-a'
              : 'account-b',
        }),
      })
      const vault = vaultWith(healthyRoutes())
      const attempted: string[] = []
      const authorize = vault.send
      vault.send = async (id, dispatch) => {
        attempted.push(id)
        return id !== 'vault:b' ? authorize(id, dispatch) : undefined
      }
      const pins = new Map()
      const sent: string[] = []
      try {
        const { result, causes } = await serve(vault, null, mode, 200, {
          sessionId: 'final-pick',
          routingRequest: { modelId: 'gpt-6', kind: 'primary' },
          placePin: (input) =>
            placeStickyPin(pins, input, (id, pin) => pins.set(id, pin)),
          send: async ({ id }) => {
            sent.push(id)
            return Response.json(
              { error: { code: 'usage_limit_reached', window: '5h' } },
              { status: 429 },
            )
          },
        })
        expect(result.response.status).toBe(401)
        expect(causes).toEqual(['vault-refused'])
        expect(attempted).toEqual(
          phase === 'continue' ? ['vault:a', 'vault:b'] : ['vault:b'],
        )
        expect(sent).toEqual(phase === 'continue' ? ['vault:a'] : [])
      } finally {
        restore()
      }
    },
  )

  it('OC1 a sticky placement does not replace an explicit routing pick with a credits account', async () => {
    const restore = withRouting({
      accountFor: async () => ({ account_id: 'account-a' }),
    })
    const routes = healthyRoutes()
    routes[0]!.quota = quotaMap(100)
    routes[1]!.quota = {
      ...quotaMap(100),
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: 50,
        checkedAt: Date.now(),
      },
    }
    const pins = new Map()
    try {
      const { result, sent } = await serve(
        vaultWith(routes),
        null,
        'sticky-balanced',
        200,
        {
          sessionId: 'credits-detour',
          routingRequest: { modelId: 'gpt-6', kind: 'primary' },
          placePin: (input) =>
            placeStickyPin(pins, input, (id, pin) => pins.set(id, pin)),
        },
      )
      expect(result.servedId).toBe('vault:a')
      expect(sent).toEqual(['vault:a:vault-token-vault:a'])
    } finally {
      restore()
    }
  })

  it.each([
    'another input',
    'another model',
    'expired',
    'different receipt',
  ] as const)(
    'OC1 pending retry is bound to the request and login: %s',
    async (scenario) => {
      let pick = 'account-a'
      const restore = withRouting({
        accountFor: async () => ({ account_id: pick }),
      })
      const routes = healthyRoutes()
      const vault = vaultWith(routes)
      let now = Date.now()
      const hold = new Map()
      const attempt: Partial<PoolRequestContext> = {
        sessionId: 'retry-identity',
        now: () => now,
        vaultRetries: hold,
        body: '{"model":"gpt-6","input":"original"}',
        routingRequest: { modelId: 'gpt-6', kind: 'primary' },
        send: async () =>
          new Response(null, { status: 429, headers: { 'retry-after': '5' } }),
      }
      try {
        expect(
          (await serve(vault, null, 'ordered', 429, attempt)).result.response
            .status,
        ).toBe(429)
        expect(hold.size).toBe(1)
        const send = mock(async () => new Response('ok'))
        if (scenario === 'expired') {
          now += 65_000
          pick = 'account-b'
        }
        if (scenario === 'different receipt') {
          now += 5000
          const originalSend = vault.send
          vault.send = (id, dispatch) =>
            originalSend(id, (token, receipt) =>
              dispatch(token, { ...receipt, accountIdentity: 'new-login' }),
            )
        }
        const { result, causes } = await serve(vault, null, 'ordered', 200, {
          ...attempt,
          send,
          ...(scenario === 'another input'
            ? { body: '{"model":"gpt-6","input":"new turn"}' }
            : {}),
          ...(scenario === 'another model'
            ? {
                body: '{"model":"gpt-7","input":"original"}',
                routingRequest: { modelId: 'gpt-7', kind: 'primary' },
              }
            : {}),
        })
        if (scenario === 'different receipt') {
          expect(causes).toEqual(['vault-refused'])
          expect(send).not.toHaveBeenCalled()
        } else {
          expect(await result.response.text()).toBe('ok')
          expect(send).toHaveBeenCalledTimes(1)
          if (scenario !== 'expired') {
            expect(hold.size).toBe(1)
            expect(
              (await serve(vault, null, 'ordered', 200, { ...attempt, send }))
                .result.response.status,
            ).toBe(429)
            expect(send).toHaveBeenCalledTimes(1)
          } else {
            expect(result.servedId).toBe('vault:b')
            expect(hold.size).toBe(0)
          }
        }
      } finally {
        restore()
      }
    },
  )

  for (const scenario of [
    {
      name: '2xx',
      status: 200,
      body: '{}',
      reports: 'served',
      type: 'application/json',
    },
    {
      name: 'usage-limit 429',
      status: 429,
      body: JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          rate_limit_reached_type: 'primary',
          resets_at: 1_900_000_000,
        },
      }),
      reports: 'exhausted',
      type: 'application/json',
    },
    {
      name: '500',
      status: 500,
      body: '{}',
      reports: undefined,
      type: 'application/json',
    },
    {
      name: '401',
      status: 401,
      body: '{}',
      reports: undefined,
      type: 'application/json',
    },
    {
      name: 'stream error',
      status: 200,
      body: 'data: {"type":"error","error":{"message":"failed"}}\n\n',
      reports: undefined,
      type: 'text/event-stream',
    },
  ]) {
    it(`OpenCode 1 ${scenario.name} reports only the classified outcome`, async () => {
      const key = Symbol.for('cortexkit.routing')
      const previous = Object.getOwnPropertyDescriptor(globalThis, key)
      const reports: unknown[] = []
      Reflect.set(globalThis, key, () => ({
        report: (payload: unknown) => {
          reports.push(payload)
        },
      }))
      try {
        const route = {
          id: 'vault:a',
          identity: 'account-a',
          credentialId: 'credential-a',
          kind: 'oauth' as const,
          quota: quotaMap(10),
        }
        const { result } = await serve(
          vaultWith([route]),
          null,
          'ordered',
          scenario.status,
          {
            sessionId: 'report-session',
            send: async () =>
              new Response(scenario.body, {
                status: scenario.status,
                headers: {
                  'content-type': scenario.type,
                  'x-codex-primary-used-percent': '42',
                  'x-codex-primary-window-minutes': '300',
                  authorization: 'private',
                },
              }),
          },
        )
        expect(await result.response.text()).toBe(scenario.body)
        // The refusal observer reads a detached copy without delaying the request.
        await new Promise((resolve) => setTimeout(resolve, 0))
        const identity = {
          account_id: 'account-a',
          credential_id: 'credential-a',
        }
        expect(reports).toEqual(
          scenario.reports === 'served'
            ? [
                {
                  ...identity,
                  outcome: 'served',
                  headers: {
                    'x-codex-primary-used-percent': '42',
                    'x-codex-primary-window-minutes': '300',
                  },
                },
              ]
            : scenario.reports === 'exhausted'
              ? [
                  {
                    ...identity,
                    outcome: 'exhausted',
                    window: '5h',
                    resets_at: 1_900_000_000_000,
                  },
                ]
              : [],
        )
      } finally {
        if (previous) Object.defineProperty(globalThis, key, previous)
        else Reflect.deleteProperty(globalThis, key)
      }
    })
  }

  it('main-first places the default vault account first and fallback-first places it last', async () => {
    const main = {
      id: 'vault:chatgpt:openai~default',
      credentialId: 'chatgpt:openai',
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }
    const alias = {
      id: 'vault:chatgpt:openai:work~alias',
      credentialId: 'chatgpt:openai:work',
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }
    const first = await serve(vaultWith([alias, main]), null, 'main-first')
    expect(first.result.servedId).toBe(main.id)
    expect(first.sent).toEqual([`${main.id}:vault-token-${main.id}`])
    const last = await serve(
      vaultWith([main, alias]),
      null,
      'fallback-first',
      429,
    )
    expect(last.sent).toEqual([
      `${alias.id}:vault-token-${alias.id}`,
      `${main.id}:vault-token-${main.id}`,
    ])
    expect(last.result.servedId).toBe(main.id)
  })

  it('alias-only vault placements keep Ordered order and never serve the local main', async () => {
    const routes = [
      'vault:chatgpt:openai:work',
      'vault:chatgpt:openai:home',
    ].map((id) => ({ id, kind: 'oauth' as const, quota: quotaMap(10) }))
    for (const mode of ['ordered', 'main-first', 'fallback-first'] as const) {
      const { sent } = await serve(vaultWith(routes), null, mode, 429)
      expect(sent).toEqual(routes.map(({ id }) => `${id}:vault-token-${id}`))
    }
  })

  it('an unshadowed local row never routes in vault mode: only vault accounts are candidates', async () => {
    const { result, sent } = await serve(
      vaultWith([{ id: 'vault:work', kind: 'oauth', quota: quotaMap(50) }]),
    )
    expect(result.servedId).toBe('vault:work')
    expect(sent).toEqual(['vault:work:vault-token-vault:work'])
  })

  for (const cause of ['vault-unreachable', 'vault-empty'] as const) {
    it(`a vault with no account to serve (${cause}) refuses the request with nothing sent`, async () => {
      const { result, sent, causes } = await serve(vaultWith([], cause))
      expect(result.response.status).toBe(401)
      expect(sent).toEqual([])
      expect(causes).toEqual([cause])
    })
  }
  it('vault quota admission is not misreported as an empty roster', async () => {
    const { sent, causes } = await serve(
      vaultWith([{ id: 'vault:work', kind: 'oauth', quota: quotaMap(90) }]),
      {
        version: 1,
        accounts: [],
        killswitch: {
          enabled: true,
          schema: 'floors-v1',
          defaults: { primary: 25, secondary: 0 },
        },
      },
    )
    expect(sent).toEqual([])
    expect(causes).toEqual([undefined])
  })
})

describe('the pool source in vault mode', () => {
  it('refreshes, polls and offers a bearer for no row, and leaves the files byte-identical; leaving vault mode restores all three', async () => {
    // Both rows' tokens are due for a refresh, neither has been polled, and
    // the vault holds neither account.
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'main', expires: Date.now() + 60_000 },
      { id: 'spare', expires: Date.now() + 60_000 },
    ])
    const before = files()
    const refreshed: string[] = []
    const polled: string[] = []
    let vaultMode = true
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async (credential) => {
        refreshed.push(credential.refresh)
        return {
          access: `${credential.refresh}-rotated`,
          refresh: `${credential.refresh}-next`,
          expires: Date.now() + HOUR,
        }
      },
      pullQuota: async (request) => {
        polled.push(request.id)
        return undefined
      },
      vaultIdentities: () => new Set(),
      vaultMode: () => vaultMode,
    })
    try {
      // The first load, the background refresh and poll, a quota check, a
      // request's token step, and the bearer lookups of keep-warm and reset
      // credits.
      const view = await source.load()
      await source.poolStore().pullsSettled()
      await source.refreshDueTokens(null)
      await source.pollRows(null)
      await source.prepareTokens(view.rows, null, { waitForAll: true })
      source.requestReading('spare', true)
      await source.poolStore().pullsSettled()
      for (const row of view.rows) {
        expect(source.usableToken(row)).toBeUndefined()
        expect(await source.accessFor(row.id, null)).toBeUndefined()
      }
      await source.settled()

      expect(refreshed).toEqual([])
      expect(polled).toEqual([])
      expect(files()).toEqual(before)

      // Disconnect: the same source refreshes and polls again, no migration.
      vaultMode = false
      await source.refreshDueTokens(null)
      await source.pollRows(null)
      await source.settled()
      expect(refreshed).toEqual(
        expect.arrayContaining(['main-refresh', 'spare-refresh']),
      )
      expect(polled).toEqual(expect.arrayContaining(['main', 'spare']))
    } finally {
      source.dispose()
      await source.settled()
    }
  })
})

describe('the sidebar file in vault mode', () => {
  const quota = quotaMap(30) as QuotaMap
  function row(
    id: string,
    extra: Partial<VaultRosterRow> = {},
  ): VaultRosterRow {
    return {
      routeId: `vault:${id}`,
      credentialId: `oauth:openai:${id}`,
      credentialType: 'oauth',
      accountIdentity: `chatgpt-${id}`,
      state: 'active',
      label: `${id} login`,
      enabled: true,
      addedAt: 1,
      quota,
      ...extra,
    }
  }

  it('predicts the default vault placement for new sessions and preserves route ids through the state file', async () => {
    const file = join(dir, 'sidebar.json')
    const rows = [
      row('work'),
      row('default', { credentialId: 'chatgpt:openai' }),
      row('home'),
    ]
    for (const mode of [
      'main-first',
      'fallback-first',
      'ordered',
      'sticky-balanced',
    ] as const) {
      await setSidebarMachineState(
        buildVaultSidebarMachineState(
          rows,
          new Set(rows.map((entry) => entry.routeId)),
          { routing: { mode } },
          Date.now(),
        ),
        file,
      )
      const state = await getSidebarState(file)
      const expected = mode === 'main-first' ? 'vault:default' : 'vault:work'
      expect(resolveSessionSidebarRouting(state, 'new-session').activeId).toBe(
        expected,
      )
      expect(resolveSessionSidebarRouting(state).activeId).toBe(expected)
      expect(resolveActiveAccount(state).id).toBe(expected)
      expect(
        resolveSessionSidebarRouting({ ...state, activeId: 'vault:home' })
          .activeId,
      ).toBe('vault:home')
      expect(state.vaultAccounts?.map((entry) => entry.id)).toEqual(
        rows.map((entry) => entry.routeId),
      )
    }
    for (const mode of ['main-first', 'fallback-first'] as const) {
      const aliases = [row('work'), row('home')]
      const state = {
        ...DEFAULT_SIDEBAR_STATE,
        ...buildVaultSidebarMachineState(
          aliases,
          new Set(aliases.map((entry) => entry.routeId)),
          { routing: { mode } },
          Date.now(),
        ),
      }
      expect(resolveSessionSidebarRouting(state, 'new-session').activeId).toBe(
        'vault:work',
      )
      expect(resolveActiveAccount(state).id).toBe('vault:work')
    }
  })

  it('lists the vault accounts by email, else vault label, with no local account in the fields an older reader shows', async () => {
    const file = join(dir, 'sidebar.json')
    // What the file held before vault mode: local accounts.
    await setSidebarState(
      {
        ...DEFAULT_SIDEBAR_STATE,
        main: { quota: null, killed: false, mainAccountId: 'chatgpt-main' },
        fallbacks: [
          {
            id: 'spare',
            label: 'spare',
            quota: null,
            killed: false,
            enabled: true,
          },
        ],
        route: 'sticky-balanced',
        stickyAssignments: {
          [hashSidebarSessionId('pinned')]: {
            accountId: 'vault:work',
            assignedAt: Date.now(),
            lastSeenAt: Date.now(),
            inputBytes: 1,
          },
        },
      },
      file,
    )

    await setSidebarMachineState(
      buildVaultSidebarMachineState(
        [
          row('work', { email: 'work@example.com' }),
          row('home'),
          row('cold', { state: 'needs_reauth' }),
        ],
        new Set(['vault:work', 'vault:home']),
        { routing: { mode: 'sticky-balanced' } },
        Date.now(),
      ),
      file,
    )
    const state = await getSidebarState(file)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >

    expect(
      state.vaultAccounts?.map((account) => [
        account.id,
        account.label,
        account.enabled,
      ]),
    ).toEqual([
      ['vault:work', 'work@example.com', true],
      ['vault:home', 'home login', true],
      ['vault:cold', 'cold login', true],
    ])
    expect(state.vaultAccounts?.[0]?.quota).not.toBeNull()
    expect(state.fallbacks).toEqual([])
    expect(state.main.quota).toBeNull()
    expect(raw.fallbacks).toEqual([])
    expect(JSON.stringify(raw)).not.toContain('chatgpt-main')
    expect(JSON.stringify(raw)).not.toContain('"spare"')
    // A session pinned to a vault account keeps its pin and shows it active.
    expect(state.stickyAssignments?.[hashSidebarSessionId('pinned')]).toEqual(
      expect.objectContaining({ accountId: 'vault:work' }),
    )
    expect(resolveSessionSidebarRouting(state, 'pinned').activeId).toBe(
      'vault:work',
    )
  })
})

describe('the TUI sidebar in vault mode', () => {
  it('renders the serving vault accounts, not main or a local fallback, and marks the session active one', () => {
    const quota = { primary: { usedPercent: 40, remainingPercent: 60 } }
    const state = {
      ...DEFAULT_SIDEBAR_STATE,
      main: {
        quota: { primary: { usedPercent: 1, remainingPercent: 99 } },
        killed: false,
      },
      fallbacks: [],
      vaultAccounts: [
        {
          id: 'vault:work',
          label: 'work@example.com',
          quota,
          killed: false,
          enabled: true,
        },
        {
          id: 'vault:cold',
          label: 'cold login',
          quota: null,
          killed: false,
          enabled: false,
        },
      ],
      route: 'main-first',
      activeRouting: {
        session: {
          activeId: 'vault:work',
          route: 'main-first',
          updatedAt: Date.now(),
        },
      },
    } as SidebarState

    // Every vault account is rendered; main's leftover quota is not.
    expect(renderedQuotas(state)).toEqual([quota, null])
    const routing = resolveSessionSidebarRouting(state, 'session')
    expect(routing.activeId).toBe('vault:work')
    expect(
      resolveActiveAccount({ ...state, activeId: routing.activeId }),
    ).toEqual({
      id: 'vault:work',
      name: 'work@example.com',
      quota,
      killed: false,
    })
  })
})
