import { describe, expect, test } from 'bun:test'
import {
  type ChooseAccountInput,
  installOpenCode2Auth,
  OpenCode2AuthError,
} from '@cortexkit/common-auth/opencode2'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import { createOpenAIAdapter, type PoolAccess } from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, quotaMap, scope } from './fixtures/opencode2-host'

async function fixture(ids = ['a', 'b']) {
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
  const source = {
    current: async () => view,
    peek: () => view,
    prepareTokens: async () => {},
    usableToken: (row: PoolRow) => (usable ? `${row.id}-token` : undefined),
    rateLimitMarks: () => marks,
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: (id: string, until: number) => marks.set(id, until),
  } as unknown as PoolAccess
  const pins = new SessionPins()
  const routes: Array<[string, string]> = []
  const openai = createOpenAIAdapter({
    onRoute: (sessionId, accountId) => routes.push([sessionId, accountId]),
    source,
    pins,
    storage: async () =>
      ({
        version: 1,
        accounts: [],
        routing: { mode: 'sticky-balanced' },
      }) as AccountStorage,
  })
  const choices: ChooseAccountInput[] = []
  const drops: string[] = []
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, {
    ...openai.adapter,
    chooseAccount: (input) => {
      choices.push(input)
      return openai.adapter.chooseAccount(input)
    },
    dropChoice: async (input) => {
      drops.push(input.accountId)
      await openai.adapter.dropChoice?.(input)
    },
  })
  openai.attach(installation)
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
  return {
    pins,
    openai,
    choices,
    drops,
    routes,
    request,
    refuse,
    installation,
    setUsable(value: boolean) {
      usable = value
    },
  }
}

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
      // The changed model releases the kept placement even when its fresh
      // account choice cannot find a usable token.
      f.setUsable(false)
      await expect(f.request('ses_1', 'gpt-5.4')).rejects.toBeInstanceOf(
        OpenCode2AuthError,
      )
      expect(f.drops).toEqual(['b'])
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
