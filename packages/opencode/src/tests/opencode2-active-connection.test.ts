import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import {
  OpenCode2AuthError,
  placeholderCredential,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { Credential } from '@opencode/plugin'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const poolCredential = () =>
  placeholderCredential({
    integrationID: 'openai',
    methodID: 'chatgpt-browser',
    now: Date.now(),
  })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(credential: Credential.Value, rows = [{ id: 'main' }]) {
  const files = poolFiles()
  seedPool(files, 'main-first', rows)
  const host = fakeOpenCode2Host({ activeCredential: credential })
  const dispose = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    heartbeat: false,
    fence: async () => ({ open: true }),
    slot: {
      all: async () => ({}),
      get: async () => undefined,
      set: async () => {},
    },
    fetch: Object.assign(
      async () => {
        throw new Error('offline')
      },
      { preconnect: () => {} },
    ) as typeof fetch,
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await dispose?.()
  }
  cleanups.push(async () => {
    await stop()
    rmSync(files.dir, { recursive: true, force: true })
  })
  return { host, files, stop }
}

type Host = ReturnType<typeof fakeOpenCode2Host>
const quotaResponse = () =>
  new Response('', {
    headers: {
      'x-codex-primary-used-percent': '73',
      'x-codex-primary-window-minutes': '300',
    },
  })

async function http(host: Host, token: string) {
  const draft = {
    ...scope(),
    request: new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-user-header': 'keep' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        store: true,
        input: [],
        max_output_tokens: 123,
      }),
    }),
  }
  const original = draft.request
  await host.fire('http.request', draft)
  return { request: draft.request, original }
}

async function expectUntouched(host: Host, token: string) {
  const model = {
    ...scope(),
    headers: { authorization: `Bearer ${token}`, 'x-user-header': 'keep' },
  }
  const modelBefore = structuredClone(model)
  await host.fire('model.request', model)
  expect(model).toEqual(modelBefore)
  const { request, original } = await http(host, token)
  expect(request).toBe(original)
  expect(request.headers.get('authorization')).toBe(
    token ? `Bearer ${token}` : 'Bearer',
  )
  expect(await request.clone().text()).toBe(await original.clone().text())
  const response = quotaResponse()
  const reply = { ...scope(), request, response }
  await host.fire('http.response', reply)
  expect(reply.response).toBe(response)
  const handshake = {
    ...scope(),
    url: 'wss://api.openai.com/v1/responses',
    headers: { authorization: `Bearer ${token}` },
  }
  const handshakeBefore = structuredClone(handshake)
  await host.fire('experimental.ws.handshake', handshake)
  expect(handshake).toEqual(handshakeBefore)
  const frame = {
    ...scope(),
    frame: JSON.stringify({
      type: 'response.create',
      response: { input: [], store: true, max_output_tokens: 123 },
    }),
  }
  const frameBefore = frame.frame
  await host.fire('experimental.ws.send', frame)
  expect(frame.frame).toBe(frameBefore)
  await host.fire('experimental.ws.receive', {
    ...scope(),
    frame: JSON.stringify({
      type: 'codex.rate_limits',
      rate_limits: { primary: { used_percent: 88, window_minutes: 300 } },
    }),
  })
  const retry = {
    ...scope(),
    attempt: 1,
    error: { type: 'api', status: 429, message: 'usage_limit_reached' },
    decision: { retry: false },
  }
  await host.fire('retry', retry)
  expect(retry.decision).toEqual({ retry: false })
  for (const name of ['context', 'compaction']) {
    const context = { ...scope(), options: { maxTokens: 123 } }
    await host.fire(name, context)
    expect(context.options).toEqual({ maxTokens: 123 })
  }
}

describe('OpenCode 2 active connection gate', () => {
  it('leaves an active API key untouched and records no pool feedback', async () => {
    const { host, files, stop } = await start({
      type: 'key',
      key: 'sk-user-key',
    })
    const rows = structuredClone(files.readConfig().commonAuthPool.rows)
    const state = files.readState()
    expect(
      (await http(host, 'sk-user-key')).request.headers.get('authorization'),
    ).toBe('Bearer sk-user-key')
    await expectUntouched(host, 'sk-user-key')
    await stop()
    expect(files.readConfig().commonAuthPool.rows).toEqual(rows)
    expect(files.readState()).toEqual(state)
  })

  it('serves the ready pool only for its active placeholder', async () => {
    const { host, files, stop } = await start(poolCredential())
    const { request } = await http(host, PLACEHOLDER)
    expect(request.headers.get('authorization')).toBe('Bearer main-token')
    expect(request.headers.get('chatgpt-account-id')).toBe('chatgpt-main')
    await host.fire('http.response', {
      ...scope(),
      request,
      response: quotaResponse(),
    })
    await stop()
    expect(
      files.readConfig().commonAuthPool.rows.main?.quota?.limits?.[0]
        ?.usedPercent,
    ).toBe(73)
  })

  it('refuses an active placeholder with an empty pool before dispatch', async () => {
    const { host } = await start(poolCredential(), [])
    let networkCalls = 0
    const model = { ...scope(), headers: {} }
    await host.fire('model.request', model)
    expect(model.headers).toEqual({})
    for (const name of ['http.request', 'experimental.ws.handshake']) {
      const draft = {
        ...scope(),
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
        url: 'wss://api.openai.com/v1/responses',
        request: new Request('https://api.openai.com/v1/responses', {
          headers: { authorization: `Bearer ${PLACEHOLDER}` },
        }),
      }
      const error = await host.fire(name, draft).then(
        () => {
          networkCalls++
          return undefined
        },
        (reason: unknown) => reason,
      )
      expect(error).toBeInstanceOf(OpenCode2AuthError)
      expect((error as OpenCode2AuthError).kind).toBe('no-account')
    }
    expect(networkCalls).toBe(0)
  })

  it('switches from the placeholder to an API key and back on the next request', async () => {
    const { host, files, stop } = await start(poolCredential())
    expect(
      (await http(host, PLACEHOLDER)).request.headers.get('authorization'),
    ).toBe('Bearer main-token')
    await host.fire('experimental.ws.handshake', {
      ...scope(),
      url: 'wss://api.openai.com/v1/responses',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    })
    host.setActiveCredential({ type: 'key', key: 'sk-next-key' })
    expect(
      (await http(host, 'sk-next-key')).request.headers.get('authorization'),
    ).toBe('Bearer sk-next-key')
    await expectUntouched(host, 'sk-next-key')
    host.setActiveCredential(poolCredential())
    expect(
      (await http(host, PLACEHOLDER)).request.headers.get('authorization'),
    ).toBe('Bearer main-token')
    await stop()
    expect(
      files.readConfig().commonAuthPool.rows.main?.quota?.limits?.[0]
        ?.usedPercent,
    ).toBe(10)
  })

  it('does not activate the pool for another integration placeholder or no connection', async () => {
    const { host } = await start(
      placeholderCredential({
        integrationID: 'anthropic',
        methodID: 'pool',
        now: Date.now(),
      }),
    )
    await expectUntouched(host, placeholderSecret('anthropic'))
    host.setActiveCredential(undefined)
    await expectUntouched(host, 'sk-env-key')
  })

  it('copies a real host login without activating the pool', async () => {
    const credential: Credential.OAuth = {
      ...poolCredential(),
      type: 'oauth',
      access: 'host-token',
      refresh: 'host-refresh',
      expires: Date.now() + 86400000,
      metadata: { accountID: 'host-account' },
    }
    const { host, files, stop } = await start(credential)
    await expectUntouched(host, 'host-token')
    await stop()
    expect(host.getActiveCredential()).toEqual(credential)
    expect(
      Object.values(files.readState().accounts).some(
        (row) => row.refresh === 'host-refresh',
      ),
    ).toBe(true)
  })

  it('uses the prepared request credential rather than the current active connection', async () => {
    const { host } = await start({ type: 'key', key: 'sk-new-connection' })
    expect(
      (await http(host, PLACEHOLDER)).request.headers.get('authorization'),
    ).toBe('Bearer main-token')
    host.setActiveCredential(poolCredential())
    await expectUntouched(host, 'sk-prepared-before-switch')
  })

  it('requires an exact placeholder bearer rather than a prefix or near miss', async () => {
    const { host } = await start(poolCredential())
    for (const token of [
      `${PLACEHOLDER}-suffix`,
      `prefix-${PLACEHOLDER}`,
      '',
      'common-auth-placeholder:v1:openai',
    ]) {
      await expectUntouched(host, token)
    }
  })
})
