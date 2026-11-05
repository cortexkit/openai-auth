import { describe, expect, test } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  type ChooseAccountInput,
  installOpenCode2Auth,
  OpenCode2AuthError,
  type SameAccountRetryInput,
} from '@cortexkit/common-auth/opencode2'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import {
  createOpenAIAdapter,
  type PoolAccess,
  type VaultAccess,
} from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, quotaMap, scope } from './fixtures/opencode2-host'

async function fixture(ids = ['a', 'b'], vault?: VaultAccess) {
  const rows = ids.map((id) => ({
    id,
    type: 'oauth',
    enabled: true,
    candidate: true,
    hasEntry: true,
    needsFirstReading: false,
    credentialEpoch: 1,
    identity: `chatgpt-${id}`,
    credential: { type: 'oauth', access: `${id}-token` },
    quota: quotaMap(id === 'a' ? 10 : 50),
  })) as PoolRow[]
  let usable = true
  const marks = new Map<string, number>()
  const view = { active: true, rows }
  const reads = { current: 0, peek: 0, token: 0 }
  const source = {
    current: async () => {
      reads.current++
      return view
    },
    peek: () => {
      reads.peek++
      return view
    },
    prepareTokens: async () => {},
    usableToken: (row: PoolRow) => {
      reads.token++
      return usable
        ? row.credential?.type === 'oauth'
          ? row.credential.access
          : undefined
        : undefined
    },
    rateLimitMarks: () => marks,
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: (id: string, until: number) => marks.set(id, until),
  } as unknown as PoolAccess
  const pins = new SessionPins()
  const routes: Array<[string, string]> = []
  const storage = {
    version: 1,
    accounts: [],
    routing: { mode: 'sticky-balanced' },
  } as AccountStorage
  const openai = createOpenAIAdapter({
    onRoute: (sessionId, accountId) => routes.push([sessionId, accountId]),
    source,
    pins,
    vault,
    storage: async () => storage,
  })
  const choices: ChooseAccountInput[] = []
  const choiceStarts: Array<ReturnType<SessionPins['placementSnapshot']>> = []
  const drops: string[] = []
  const sameAccount: SameAccountRetryInput[] = []
  const retryReasons: string[] = []
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, {
    ...openai.adapter,
    chooseAccount: (input) => {
      choices.push(input)
      choiceStarts.push(pins.placementSnapshot())
      return openai.adapter.chooseAccount(input)
    },
    dropChoice: async (input) => {
      drops.push(input.accountId)
      await openai.adapter.dropChoice?.(input)
    },
    retrySameAccount: (input) => {
      sameAccount.push(input)
      return openai.adapter.retrySameAccount?.(input)
    },
  })
  openai.attach(installation)
  installation.on('retry', (event) => {
    retryReasons.push(event.reason)
  })
  const request = async (sessionID = 'ses_1', modelID = 'gpt-5.5') => {
    const model = {
      ...scope(sessionID),
      model: { providerID: 'openai', id: modelID },
      headers: {} as Record<string, string>,
    }
    await host.fire('model.request', model)
    const draft = {
      ...scope(sessionID),
      model: model.model,
      request: new Request('http://codex.test/responses', {
        headers: model.headers,
      }),
    }
    await host.fire('http.request', draft)
    return draft
  }
  const refuse = async (draft: Awaited<ReturnType<typeof request>>) => {
    await host.fire('http.response', {
      ...scope(),
      request: draft.request,
      response: Response.json(
        { error: { type: 'usage_limit_reached' } },
        { status: 429 },
      ),
    })
    const retry = {
      sessionID: 'ses_1',
      model: { providerID: 'openai', id: 'gpt-5.5' },
      attempt: 1,
      error: { type: 'api', message: 'usage limit', status: 429 },
      decision: { retry: true, delay: 1234 },
    }
    await host.fire('retry', retry)
    return retry.decision
  }
  const interrupt = async (draft: Awaited<ReturnType<typeof request>>) => {
    let fail: (error: Error) => void = () => {}
    const response = {
      ...scope(),
      request: draft.request,
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
              ),
            )
            fail = (error) => controller.error(error)
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    }
    await host.fire('http.response', response)
    const reader = response.response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'hello',
    )
    fail(new TypeError('connection reset'))
    await expect(reader.read()).rejects.toThrow('connection reset')
  }
  const continueStep = async () => {
    const retry = {
      sessionID: 'ses_1',
      model: { providerID: 'openai', id: 'gpt-5.5' },
      attempt: 1,
      error: { type: 'provider.transport', message: 'body read failed' },
      decision: { retry: true, delay: 1234 } as
        | { retry: true; delay: number }
        | { retry: false },
    }
    await host.fire('retry', retry)
    return retry.decision
  }
  return {
    rows,
    reads,
    view,
    storage,
    pins,
    openai,
    choices,
    choiceStarts,
    marks,
    drops,
    routes,
    request,
    refuse,
    interrupt,
    continueStep,
    sameAccount,
    retryReasons,
    installation,
    setUsable(value: boolean) {
      usable = value
    },
  }
}

describe('OpenCode 2 interrupted-read continuation', () => {
  for (const mode of ['main-first', 'fallback-first', 'ordered'] as const) {
    test(`ordered-mode continuation rechecks admission without reselecting: ${mode}`, async () => {
      const f = await fixture()
      try {
        f.storage.routing = { mode }
        await f.interrupt(await f.request())
        expect(await f.continueStep()).toEqual({ retry: true, delay: 1234 })
        expect(
          (await f.request()).request.headers.get('chatgpt-account-id'),
        ).toBe('chatgpt-a')
        expect(f.choices).toHaveLength(1)
      } finally {
        await f.installation.dispose()
      }
    })
  }

  test('after output a witnessed HTTP body read failure continues on the same account', async () => {
    const f = await fixture()
    try {
      const first = await f.request()
      await f.interrupt(first)
      const before = f.pins.snapshot()
      expect(await f.continueStep()).toEqual({ retry: true, delay: 1234 })
      expect(f.sameAccount).toHaveLength(1)
      expect(f.sameAccount[0]).toMatchObject({
        accountId: 'a',
        modelID: 'gpt-5.5',
        continuation: 'interrupted-read',
      })
      expect(f.sameAccount[0]).not.toHaveProperty('limit')
      expect(f.retryReasons).toEqual(['continue-same-account'])
      const next = await f.request()
      expect(next.request.headers.get('authorization')).toBe('Bearer a-token')
      expect(next.request.headers.get('chatgpt-account-id')).toBe('chatgpt-a')
      expect(f.choices).toHaveLength(1)
      expect(f.pins.snapshot()).toEqual(before)
      expect(f.pins.placementSnapshot()).toEqual(before)
      expect(f.drops).toEqual([])
      await f.interrupt(next)
      expect(await f.continueStep()).toEqual({ retry: false })
      expect(f.sameAccount).toHaveLength(1)
    } finally {
      await f.installation.dispose()
    }
  })

  for (const change of [
    'disabled',
    'removed',
    'identity',
    'quota',
    'killswitch',
    'credits',
    'token',
    'inactive',
  ]) {
    test(`declines continuation when the live pool account changes: ${change}`, async () => {
      const f = await fixture()
      try {
        await f.interrupt(await f.request())
        const before = f.pins.snapshot()
        if (change === 'disabled') f.rows[0]!.enabled = false
        if (change === 'removed') f.rows.splice(0, 1)
        if (change === 'identity')
          f.rows[0]!.identity = 'another-chatgpt-account'
        if (change === 'quota')
          f.storage.quota = { minimumRemaining: { primary: 95 } }
        if (change === 'killswitch')
          f.storage.killswitch = {
            enabled: true,
            schema: 'floors-v1',
            defaults: { primary: 95, secondary: 0 },
          }
        if (change === 'credits')
          f.rows[0]!.quota = {
            ...quotaMap(100),
            credits: {
              checkedAt: Date.now(),
              hasCredits: true,
              unlimited: false,
              balance: 100,
              overageLimitReached: true,
            },
          }
        if (change === 'token') f.setUsable(false)
        if (change === 'inactive') f.view.active = false
        expect(await f.continueStep()).toEqual({ retry: false })
        expect(f.sameAccount).toHaveLength(1)
        expect(f.retryReasons).toEqual(['output-started'])
        expect(f.choices).toHaveLength(1)
        expect(f.pins.snapshot()).toEqual(before)
      } finally {
        await f.installation.dispose()
      }
    })
  }

  test('without continuation the same-account callback declines even after an interrupted read', async () => {
    const f = await fixture()
    try {
      await f.interrupt(await f.request())
      expect(f.openai.adapter.retrySameAccount).toBeFunction()
      expect(
        await f.openai.adapter.retrySameAccount!({
          ...scope(),
          providerID: 'openai',
          modelID: 'gpt-5.5',
          accountId: 'a',
          error: { type: 'provider.transport', message: 'body read failed' },
          attempt: 1,
        }),
      ).toBeUndefined()
    } finally {
      await f.installation.dispose()
    }
  })

  test('a refreshed local token for the same ChatGPT identity may continue', async () => {
    const f = await fixture()
    try {
      await f.interrupt(await f.request())
      f.rows[0]!.credential = {
        type: 'oauth',
        access: 'refreshed-a-token',
        refresh: 'refresh-a',
      }
      f.rows[0]!.credentialEpoch = 2
      expect(await f.continueStep()).toEqual({ retry: true, delay: 1234 })
      expect((await f.request()).request.headers.get('authorization')).toBe(
        'Bearer refreshed-a-token',
      )
      expect(f.choices).toHaveLength(1)
      expect(f.reads.current).toBe(2)
    } finally {
      await f.installation.dispose()
    }
  })
})

async function vaultFixture() {
  const routes = [
    {
      id: 'vault:a',
      credentialId: 'credential-a',
      kind: 'oauth' as const,
      identity: 'chatgpt-vault-a',
      quota: quotaMap(10),
    },
  ]
  const state = {
    enabled: true,
    refused: false,
    credentialId: 'credential-a',
    identity: 'chatgpt-vault-a',
    version: 1,
  }
  const vault = {
    authority: async () => 'vault',
    routes: () => (state.enabled ? routes : []),
    identities: () => new Set([state.identity]),
    authorize: async (): Promise<ClaustrumScopedAttempt | undefined> =>
      state.refused
        ? undefined
        : {
            credentialId: state.credentialId,
            accountIdentity: state.identity,
            accountIdentitySource: 'asserted',
            accessToken: `vault-token-${state.version}`,
            recordVersion: state.version,
            credentialType: 'oauth',
            expiresAtMs: null,
          },
    reportFailure: async () => {},
    reportUsage: () => {},
    recordSnapshot: async () => {},
    requestReading: () => {},
  } as unknown as VaultAccess
  return { ...(await fixture(['a', 'b'], vault)), state, vaultRoutes: routes }
}

describe('OpenCode 2 vault interrupted-read continuation', () => {
  test('continues with a newer receipt for the same vault identity without reading the local pool', async () => {
    const f = await vaultFixture()
    try {
      const first = await f.request()
      expect(first.request.headers.get('authorization')).toBe(
        'Bearer vault-token-1',
      )
      await f.interrupt(first)
      f.state.version++
      expect(await f.continueStep()).toEqual({ retry: true, delay: 1234 })
      const next = await f.request()
      expect(next.request.headers.get('authorization')).toBe(
        'Bearer vault-token-2',
      )
      expect(next.request.headers.get('chatgpt-account-id')).toBe(
        'chatgpt-vault-a',
      )
      expect(f.sameAccount[0]!.accountId).toBe('vault:a')
      expect(f.choices).toHaveLength(1)
      expect(f.reads).toEqual({ current: 0, peek: 0, token: 0 })
    } finally {
      await f.installation.dispose()
    }
  })

  for (const change of [
    'disabled',
    'removed',
    'identity',
    'route-identity',
    'credential',
    'quota',
    'killswitch',
    'refused',
  ]) {
    test(`declines continuation instead of falling back to the pool when the vault account changes: ${change}`, async () => {
      const f = await vaultFixture()
      try {
        await f.interrupt(await f.request())
        if (change === 'disabled') f.state.enabled = false
        if (change === 'removed') f.vaultRoutes.splice(0, 1)
        if (change === 'identity') f.state.identity = 'another-vault-identity'
        if (change === 'route-identity')
          f.vaultRoutes[0]!.identity = 'another-route-identity'
        if (change === 'credential')
          f.state.credentialId = 'another-vault-credential'
        if (change === 'quota')
          f.storage.quota = { minimumRemaining: { primary: 95 } }
        if (change === 'killswitch')
          f.storage.killswitch = {
            enabled: true,
            schema: 'floors-v1',
            defaults: { primary: 95, secondary: 0 },
          }
        if (change === 'refused') f.state.refused = true
        expect(await f.continueStep()).toEqual({ retry: false })
        expect(f.retryReasons).toEqual(['output-started'])
        expect(f.choices).toHaveLength(1)
        expect(f.reads).toEqual({ current: 0, peek: 0, token: 0 })
      } finally {
        await f.installation.dispose()
      }
    })
  }
})

describe('OpenCode 2 kept retry choice', () => {
  test('reroute chooses once per attempt and consumes the chosen account', async () => {
    const f = await fixture()
    try {
      const first = await f.request()
      expect(first.request.headers.get('authorization')).toBe('Bearer a-token')
      expect(await f.refuse(first)).toEqual({ retry: true, delay: 0 })
      expect(f.choices.map((input) => input.phase)).toEqual([
        'request',
        'retry',
      ])
      expect(f.choices.at(-1)).toMatchObject({
        previousAccountId: 'a',
        rerouteFrom: { accountId: 'a' },
      })
      expect((await f.request()).request.headers.get('authorization')).toBe(
        'Bearer b-token',
      )
      expect(f.choices).toHaveLength(2)
      expect(f.drops).toEqual([])
    } finally {
      await f.installation.dispose()
    }
  })

  test('last account keeps the host wait and is not chosen twice', async () => {
    const f = await fixture(['a'])
    try {
      expect(await f.refuse(await f.request())).toEqual({
        retry: true,
        delay: 1234,
      })
      expect(f.choices.map((input) => input.phase)).toEqual([
        'request',
        'retry',
      ])
      expect((await f.request()).request.headers.get('authorization')).toBe(
        'Bearer a-token',
      )
      expect(f.choices).toHaveLength(2)
      expect(f.drops).toEqual([])
      const mark = f.marks.get('a')
      expect(mark).toBeGreaterThan(Date.now())
      // A new session is still sent on the only account: a mark steers
      // requests to other accounts but never leaves one with none to try.
      // The mark itself stays for the requests after it.
      expect(
        (await f.request('new-session')).request.headers.get('authorization'),
      ).toBe('Bearer a-token')
      expect(f.marks.get('a')).toBe(mark)
    } finally {
      await f.installation.dispose()
    }
  })

  test('undefined after token refusals leaves pins pending bytes and active accounts untouched', async () => {
    const f = await fixture()
    try {
      await f.request('other')
      const before = f.pins.snapshot()
      f.setUsable(false)
      await expect(f.request()).rejects.toBeInstanceOf(OpenCode2AuthError)
      expect(f.pins.snapshot()).toEqual(before)
      expect(f.pins.placementSnapshot()).toEqual(before)
      expect(f.openai.activeAccount('ses_1')).toBeUndefined()
      f.setUsable(true)
      await f.request()
      expect(f.choices.map((input) => input.phase)).toEqual([
        'request',
        'request',
        'request',
      ])
    } finally {
      await f.installation.dispose()
    }
  })

  test('dropChoice discards a model-change placement without touching another session', async () => {
    const f = await fixture()
    try {
      const first = await f.request()
      await f.request('other')
      const before = f.pins.snapshot()
      expect(await f.refuse(first)).toEqual({ retry: true, delay: 0 })
      expect(f.openai.activeAccount('ses_1')).toBe('a')
      expect(f.pins.placementSnapshot().get('ses_1')?.accountId).toBe('b')
      // The changed model releases the kept placement even when its fresh
      // account choice cannot find a usable token.
      f.setUsable(false)
      await expect(f.request('ses_1', 'gpt-5.4')).rejects.toBeInstanceOf(
        OpenCode2AuthError,
      )
      expect(f.drops).toEqual(['b'])
      expect(f.choiceStarts[3]).toEqual(before)
      expect(f.pins.placementSnapshot()).toEqual(before)
      expect(f.pins.snapshot().get('other')).toEqual(before.get('other'))
      expect(f.choices.map((input) => input.phase)).toEqual([
        'request',
        'request',
        'retry',
        'request',
      ])
      expect(f.pins.snapshot()).toEqual(before)
      // The next real request commits its placement once. A discarded callback
      // must not replay when the same account's headers are used again.
      f.setUsable(true)
      const next = await f.request('ses_1', 'gpt-5.4')
      expect(next.request.headers.get('authorization')).toBe('Bearer b-token')
      expect(f.routes).toEqual([
        ['ses_1', 'a'],
        ['other', 'b'],
        ['ses_1', 'b'],
      ])
      expect(f.pins.snapshot().get('other')).toEqual(before.get('other'))
      expect(f.openai.activeAccount('ses_1')).toBe('b')
    } finally {
      await f.installation.dispose()
    }
  })
})
