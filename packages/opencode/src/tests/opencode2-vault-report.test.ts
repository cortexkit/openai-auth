// Which 401s the OpenCode 2 adapter reports to the vault. Only a send the vault
// authorized is reported, once, against the record version in that send's
// receipt; a 401 on a local pool account is the pool's own business. The vault
// rotates a refreshable credential on every report it applies. The shared vault
// consumer also refuses a report for a send it never authorized, so this check
// is the first of two layers and avoids reading the vault's roster for a local 401.
//
// The vault here is a stand-in that records every call the adapter makes to
// it; the adapter runs behind the real installer on a fake OpenCode 2 host.

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaustrumConsumer,
  type ClaustrumScopedAttempt,
} from '@cortexkit/common-auth/claustrum'
import { createSessionActivityStore } from '@cortexkit/common-auth/limits'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import type { OpenCodeLimitSource } from '../core/limit-source'
import type { PoolView } from '../core/pool-account-source'
import { createOpenAIAdapter, type PoolAccess } from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { installPoolHooks } from '../v2/setup'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'
import {
  restoreRoutingAccessor,
  routingKey,
} from './fixtures/opencode2-routing'

const PLACEHOLDER = placeholderSecret('openai')
const HOUR = 3600_000
const VAULT_ROUTE = 'oauth:openai:vault'

function healthyQuota(): QuotaMap {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt: Date.now(),
        usedPercent: 10,
        resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
  }
}

const mainRow: PoolRow = {
  id: 'main',
  type: 'oauth',
  enabled: true,
  candidate: true,
  hasEntry: true,
  needsFirstReading: false,
  credentialEpoch: 1,
  identity: 'chatgpt-main',
  credential: {
    type: 'oauth',
    access: 'main-token',
    refresh: 'main-refresh',
    expires: Date.now() + 24 * HOUR,
  },
  quota: healthyQuota(),
}

const poolSource: PoolAccess = (() => {
  const view: PoolView = { active: true, rows: [mainRow] }
  return {
    current: async () => view,
    peek: () => view,
    prepareTokens: async () => {},
    usableToken: () => 'main-token',
    rateLimitMarks: () => new Map<string, number>(),
    refreshBackoffFor: () => new Map<string, number>(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: () => {},
  }
})()

/** The receipt the vault serves for one send, at record version 7. */
function receipt(): ClaustrumScopedAttempt {
  return {
    credentialId: VAULT_ROUTE,
    credentialType: 'oauth',
    accountIdentity: 'chatgpt-vault',
    accountIdentitySource: 'asserted',
    accessToken: 'vault-token',
    recordVersion: 7,
    expiresAtMs: null,
  }
}

async function send(
  host: ReturnType<typeof fakeOpenCode2Host>,
  status: number,
) {
  const draftScope = scope('ses_1', 'primary')
  const headers: Record<string, string> = {
    authorization: `Bearer ${PLACEHOLDER}`,
  }
  await host.fire('model.request', { ...draftScope, headers })
  const draft = {
    ...draftScope,
    request: new Request('https://codex.test/v1/responses', {
      method: 'POST',
      headers,
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  await host.fire('http.response', {
    ...draftScope,
    request: draft.request,
    response: new Response('{}', { status }),
  })
  return draft.request.headers
}

describe('vault failure reports on OpenCode 2', () => {
  it('a 401 on a local pool account reports nothing to the vault; a 401 on a vault account reports once, with the served record version', async () => {
    const reports: Array<{
      receipt: ClaustrumScopedAttempt | undefined
      status: number
    }> = []
    // Before this host connects to the vault, main-first serves the pool row
    // `main`. Once connected (vault mode), only the vault account serves.
    let mode: 'main-first' | 'fallback-first' = 'main-first'
    let enrolled = false
    const openai = createOpenAIAdapter({
      source: poolSource,
      storage: async (): Promise<AccountStorage> => ({
        version: 1,
        accounts: [],
        routing: { mode },
      }),
      pins: new SessionPins(),
      vault: {
        routes: () => [
          {
            id: VAULT_ROUTE,
            kind: 'oauth',
            identity: 'chatgpt-vault',
            quota: healthyQuota(),
          },
        ],
        identities: () => new Set<string>(['chatgpt-vault']),
        enrolled: () => enrolled,
        authority: async () => (enrolled ? 'vault' : 'local'),
        snapshot: () => undefined,
        authorize: async () => receipt(),
        reportFailure: async (served, status) => {
          reports.push({ receipt: served, status })
        },
        recordSnapshot: async () => {},
        reportUsage: () => {},
        requestReading: () => {},
        grantReach: () => undefined,
        name: 'openai-auth-opencode',
      },
    })
    const host = fakeOpenCode2Host()
    await installOpenCode2Auth(host.ctx, openai.adapter)

    // The installer ends an error response's attempt as the response hook
    // runs, and the adapter decides whether to report before its first
    // await, so any report call has been made once the hook returns.
    const pool = await send(host, 401)
    expect(pool.get('authorization')).toBe('Bearer main-token')
    expect(reports).toEqual([])

    mode = 'fallback-first'
    enrolled = true
    const vault = await send(host, 401)
    expect(vault.get('authorization')).toBe('Bearer vault-token')
    expect(reports).toEqual([
      {
        receipt: expect.objectContaining({
          credentialId: VAULT_ROUTE,
          recordVersion: 7,
        }),
        status: 401,
      },
    ])
  })
})

async function recoveryFixture() {
  const requestScope = scope('session-401')
  const report = mock((_payload: unknown) => {})
  Reflect.set(globalThis, routingKey, () => ({ report }))
  let current: ClaustrumScopedAttempt | undefined = receipt()
  const authorize = mock(async () => current)
  const reportFailure = mock(
    async (_receipt: ClaustrumScopedAttempt, _status: number) => {},
  )
  const enqueue = mock(() => {})
  const dropSignal = mock(() => {})
  const debug = mock(() => {})
  const binding = {
    account: { namespace: 'vault', accountId: VAULT_ROUTE, incarnation: '1' },
  }
  const registry = {}
  const limits = {
    activity: createSessionActivityStore(),
    forRequest: async () => undefined,
    bindings: () => [binding],
    accountKey: (id: string) =>
      id === VAULT_ROUTE ? binding.account : undefined,
    marks: () => new Map(),
    owner: () => ({
      registry,
      enqueue,
      dropSignal,
      observe: () => ({ binding, registry, baseRevision: 1 }),
      afterProbe() {},
    }),
  } as unknown as OpenCodeLimitSource
  const openai = createOpenAIAdapter({
    source: poolSource,
    storage: async () => ({
      version: 1,
      accounts: [],
      routing: { mode: 'fallback-first' },
    }),
    pins: new SessionPins(),
    limits,
    log: { debug, warn() {} },
    vault: {
      routes: () => [
        {
          id: VAULT_ROUTE,
          credentialId: VAULT_ROUTE,
          kind: 'oauth',
          identity: 'chatgpt-vault',
          quota: healthyQuota(),
        },
      ],
      identities: () => new Set(['chatgpt-vault']),
      enrolled: () => true,
      authority: async () => 'vault',
      snapshot: () => undefined,
      authorize,
      reportFailure,
      recordSnapshot: async () => {},
      reportUsage() {},
      requestReading() {},
      grantReach: () => undefined,
      name: 'openai-auth-opencode',
    },
  })
  const host = fakeOpenCode2Host()
  const installation = await installPoolHooks(host.ctx, openai.adapter, {
    warn() {},
  })
  openai.attach(installation)
  const dispatched: Request[] = []
  return {
    authorize,
    reportFailure,
    report,
    enqueue,
    dropSignal,
    debug,
    dispatched,
    setReceipt(next: ClaustrumScopedAttempt | undefined) {
      current = next
    },
    async send(label: string) {
      const draft = await host.fire('http.request', {
        ...requestScope,
        request: new Request('https://codex.test/responses', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-5.5',
            input: [{ role: 'user', content: label }],
          }),
          headers: { authorization: `Bearer ${PLACEHOLDER}` },
        }),
      })
      dispatched.push(draft.request)
      return draft.request
    },
    async answer(request: Request) {
      const { response } = await host.fire('http.response', {
        ...requestScope,
        request,
        // A misleading body must not promote a credential refusal to a quota mark.
        response: Response.json(
          {
            error: { type: 'usage_limit_reached', message: 'private details' },
          },
          { status: 401 },
        ),
      })
      return response
    },
    async retry(attempt: number, retry = false) {
      const result = await host.fire('retry', {
        ...requestScope,
        attempt,
        decision: retry ? { retry: true, delay: 1 } : { retry: false },
        error: { type: 'api', status: 401, message: 'HTTP 401' },
      })
      return result.decision
    },
    async dispose() {
      await installation.dispose()
      openai.dispose()
      restoreRoutingAccessor()
    },
  }
}

it('retries the attributable vault HTTP 401 once with a rotated receipt, even with another send in flight', async () => {
  const env = await recoveryFixture()
  try {
    const first = await env.send('first')
    env.setReceipt({
      ...receipt(),
      recordVersion: 8,
      accessToken: 'overlapping-token',
    })
    const overlap = await env.send('overlap')
    expect(overlap.headers.get('authorization')).toBe(
      'Bearer overlapping-token',
    )
    // Version 8 is a rotation for the failed request, not for the newer in-flight send.
    expect((await env.answer(first)).status).toBe(401)
    expect(await env.retry(1)).toEqual({ retry: true, delay: 0 })
    expect(env.authorize).toHaveBeenCalledTimes(3)
    expect(env.reportFailure).not.toHaveBeenCalled()

    const replay = await env.send('first')
    expect(replay.headers.get('authorization')).toBe('Bearer overlapping-token')
    expect(replay.headers.get('chatgpt-account-id')).toBe('chatgpt-vault')
    expect(await replay.text()).toBe(await first.text())
    expect(env.authorize).toHaveBeenCalledTimes(3)

    env.setReceipt({
      ...receipt(),
      recordVersion: 9,
      accessToken: 'third-token',
    })
    const terminal = await env.answer(replay)
    expect(terminal.status).toBe(401)
    expect(await terminal.json()).toEqual({
      error: {
        message: 'request refused: no account with a usable credential',
      },
    })
    expect(await env.retry(2, true)).toEqual({ retry: false })
    expect(env.authorize).toHaveBeenCalledTimes(3)
    expect(env.dispatched).toEqual([first, overlap, replay])
    expect(env.reportFailure.mock.calls).toEqual([
      [expect.objectContaining({ recordVersion: 8 }), 401],
    ])
    expect(env.enqueue).not.toHaveBeenCalled()
    expect(env.dropSignal).not.toHaveBeenCalled()
    expect(env.debug).not.toHaveBeenCalledWith(
      'pool row refused the request',
      expect.anything(),
    )
    const reports = env.report.mock.calls.map(([value]) => value)
    expect(reports).toEqual([
      expect.objectContaining({
        kind: 'billing',
        status: 401,
        outcome: 'failed',
      }),
      expect.objectContaining({
        kind: 'billing',
        status: 401,
        outcome: 'failed',
      }),
    ])
  } finally {
    await env.dispose()
  }
})

it.each([
  ['unchanged receipt', receipt()],
  ['failed re-authorization', undefined],
  [
    'different login',
    { ...receipt(), recordVersion: 8, credentialId: 'different-login' },
  ],
] as const)(
  'vault HTTP 401 with %s is terminal and reports the sent receipt once',
  async (_label, next) => {
    const env = await recoveryFixture()
    try {
      const request = await env.send('no replay')
      env.setReceipt(next)
      const terminal = await env.answer(request)
      expect(terminal.status).toBe(401)
      expect(await env.retry(1, true)).toEqual({ retry: false })
      expect(env.authorize).toHaveBeenCalledTimes(2)
      expect(env.dispatched).toEqual([request])
      expect(env.reportFailure.mock.calls).toEqual([
        [expect.objectContaining({ recordVersion: 7 }), 401],
      ])
    } finally {
      await env.dispose()
    }
  },
)

describe('OpenCode 2 reply usage', () => {
  async function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'opencode2-usage-'))
    const target = new OpenAiVault({ host: 'opencode', stateDir: directory })
    let enrolled = false
    let selected = 'a'
    const openai = createOpenAIAdapter({
      source: poolSource,
      storage: async () => ({
        version: 1,
        accounts: [],
        routing: { mode: 'fallback-first' },
      }),
      pins: new SessionPins(),
      vault: {
        routes: () =>
          enrolled
            ? [
                {
                  id: selected,
                  kind: 'oauth',
                  identity: `account-${selected}`,
                  quota: healthyQuota(),
                },
              ]
            : [],
        identities: () => new Set(enrolled ? [`account-${selected}`] : []),
        enrolled: () => enrolled,
        authority: async () => (enrolled ? 'vault' : 'local'),
        snapshot: () => undefined,
        authorize: async (id) => ({
          ...receipt(),
          credentialId: `credential-${id}`,
          accountIdentity: `account-${id}`,
        }),
        reportFailure: async () => {},
        recordSnapshot: async () => {},
        reportUsage: target.reportUsage.bind(target),
        requestReading: () => {},
        grantReach: () => undefined,
        name: target.name,
      },
    })
    const host = fakeOpenCode2Host()
    const installation = await installOpenCode2Auth(host.ctx, openai.adapter)
    openai.attach(installation)
    return {
      host,
      select(id: string) {
        enrolled = true
        selected = id
      },
      close() {
        target.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  }

  async function draft(
    host: ReturnType<typeof fakeOpenCode2Host>,
    session: string,
  ) {
    const requestScope = scope(session, 'primary')
    const headers = { authorization: `Bearer ${PLACEHOLDER}` }
    await host.fire('model.request', { ...requestScope, headers })
    const input = {
      ...requestScope,
      request: new Request('https://codex.test/responses', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    }
    await host.fire('http.request', input)
    return input
  }

  it('HTTP reply usage is allowlisted and remains on its served attempt across concurrent accounts; local replies do not report', async () => {
    const fixture = await setup()
    const report = spyOn(
      ClaustrumConsumer.prototype,
      'reportUsage',
    ).mockImplementation(() => {})
    const reply = () =>
      new Response('{}', {
        headers: {
          'x-codex-primary-used-percent': '42',
          authorization: 'secret',
          'set-cookie': 'secret',
        },
      })
    try {
      const local = await draft(fixture.host, 'local')
      await fixture.host.fire('http.response', { ...local, response: reply() })
      expect(local.request.headers.get('authorization')).toBe(
        'Bearer main-token',
      )
      expect(report).not.toHaveBeenCalled()
      fixture.select('a')
      const first = await draft(fixture.host, 'first')
      fixture.select('b')
      const second = await draft(fixture.host, 'second')
      await fixture.host.fire('http.response', { ...second, response: reply() })
      await fixture.host.fire('http.response', { ...first, response: reply() })
      expect(report.mock.calls.map(([input]) => input)).toEqual(
        ['b', 'a'].map((id) => ({
          routeId: id,
          credentialId: `credential-${id}`,
          reading: {
            provider: 'codex',
            observedAtMs: expect.any(Number),
            account: `account-${id}`,
            headers: { 'x-codex-primary-used-percent': '42' },
          },
        })),
      )
    } finally {
      report.mockRestore()
      fixture.close()
    }
  })

  it('WebSocket reply usage forwards the original frame with its served receipt and isolates a throwing reporter', async () => {
    const fixture = await setup()
    const report = spyOn(
      ClaustrumConsumer.prototype,
      'reportUsage',
    ).mockImplementation(() => {
      throw new Error('reporter failed')
    })
    const frame = {
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 64, window_minutes: 300 },
        secondary: null,
      },
      additional_rate_limits: [],
    }
    const handshake = async (session: string) => {
      const input = {
        ...scope(session),
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
      }
      await fixture.host.fire('model.request', input)
      await fixture.host.fire('experimental.ws.handshake', {
        ...input,
        url: 'ws://codex.test/responses',
      })
    }
    const receive = (session: string) =>
      fixture.host.fire('experimental.ws.receive', {
        ...scope(session),
        frame: JSON.stringify(frame),
      })
    try {
      await handshake('local-ws')
      await receive('local-ws')
      expect(report).not.toHaveBeenCalled()
      fixture.select('a')
      await handshake('first-ws')
      fixture.select('b')
      await handshake('second-ws')
      expect((await receive('second-ws')).frame).toBe(JSON.stringify(frame))
      expect((await receive('first-ws')).frame).toBe(JSON.stringify(frame))
      expect(report.mock.calls.map(([input]) => input)).toEqual(
        ['b', 'a'].map((id) => ({
          routeId: id,
          credentialId: `credential-${id}`,
          reading: {
            provider: 'codex',
            observedAtMs: expect.any(Number),
            account: `account-${id}`,
            frame,
          },
        })),
      )
    } finally {
      report.mockRestore()
      fixture.close()
    }
  })
})
