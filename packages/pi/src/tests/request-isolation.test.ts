import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import type { OpenPoolStoreOptions } from '@cortexkit/common-auth/store'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  OpenAiVault,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import { observationFromSnapshot } from '@cortexkit/openai-auth-core/pool-quota'
import {
  type Api,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { chatgptAccessToken } from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { PiPoolSource } from '../pool-source.ts'
import { errorEvent, PiOpenAIRuntime } from '../runtime.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()

let dir: string
let vault: OpenAiVault
let oldAgentDir: string | undefined
const model: Model<Api> = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-pi-'))
  oldAgentDir = process.env.PI_AGENT_DIR
  process.env.PI_AGENT_DIR = join(dir, 'agent')
  mkdirSync(getAgentDir(), { recursive: true })
  vault = new OpenAiVault({
    host: 'pi',
    stateDir: vaultStateDir(join(dir, 'pool-state.json')),
    connectionFile: () => join(dir, 'no-daemon.json'),
    pollIntervalMs: 0,
  })
})
afterEach(() => {
  vault.close()
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR
  else process.env.PI_AGENT_DIR = oldAgentDir
  rmSync(dir, { recursive: true, force: true })
})

test('Pi queued local quota observation does not write after enrollment', async () => {
  const paths = {
    configPath: join(dir, 'pool.json'),
    statePath: join(dir, 'pool-state.json'),
  }
  const store = openPoolStore({
    provider: 'openai',
    ...paths,
    quota: quotaCodec,
  })
  await store.add({
    id: 'work',
    credential: {
      type: 'oauth',
      access: 'review-pool-token',
      refresh: 'review-pool-refresh',
      expires: Date.now() + 86400_000,
    },
  })
  expect(await vault.authority()).toBe('local')
  const source = new PiPoolSource({
    paths: () => paths,
    vaultMode: () => vault.enrolled(),
    refreshProvider: async () => {
      throw new Error('no refresh expected')
    },
    pullQuota: async () => {
      throw new Error('no quota poll expected')
    },
  })
  await source.load()
  await source.poolStore().pullsSettled()
  const before = readFileSync(paths.configPath, 'utf8')
  source.recordSnapshot(
    'work',
    {
      primary: {
        usedPercent: 63,
        remainingPercent: 37,
        windowMinutes: 300,
        checkedAt: Date.now(),
        resetsAt: new Date(Date.now() + 7200_000).toISOString(),
      },
    },
    'review-pool-token',
    true,
  )
  mkdirSync(dirname(vault.paths.tokenPath), { recursive: true, mode: 0o700 })
  writeFileSync(
    vault.paths.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  expect(await vault.authority()).toBe('vault')
  await source.settled()
  source.dispose()
  expect(readFileSync(paths.configPath, 'utf8')).toBe(before)
})

test('Pi request error does not expose the bearer echoed by the transport', async () => {
  const token = chatgptAccessToken('review-native-secret')
  let modelSends = 0
  const fakeFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/wham/usage'))
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 7200,
            },
          },
        })
      modelSends++
      return Response.json(
        { error: { message: `Invalid API key: ${token}` } },
        { status: 401 },
      )
    },
    { preconnect() {} },
  ) as typeof fetch
  const runtime = new PiOpenAIRuntime({
    vault,
    paths: () => ({
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'pool-state.json'),
    }),
    createStream: createAssistantMessageEventStream,
    fetchImpl: fakeFetch,
    streamSimple,
  })
  const events = []
  for await (const event of runtime.stream(
    model,
    { messages: [] },
    { apiKey: token, fetch: fakeFetch, transport: 'sse' },
  ))
    events.push(event)
  expect(modelSends).toBe(1)
  expect(events.some((event) => event.type === 'error')).toBe(true)
  expect(JSON.stringify(events)).not.toContain(token)
})

for (const contentType of [undefined, 'text/plain']) {
  test(`Pi runtime parses and scrubs SSE errors with ${contentType ?? 'missing'} content-type`, async () => {
    const token = chatgptAccessToken('stream-secret')
    const jwt = chatgptAccessToken('unrelated-secret')
    const message = `Stream refused key ${token}; ${jwt}`
    let sends = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        sends++
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'error', message })}\n\n`,
        )
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < bytes.length; index += 7)
                controller.enqueue(bytes.slice(index, index + 7))
              controller.close()
            },
          }),
          { headers: contentType ? { 'content-type': contentType } : {} },
        )
      },
    })
    const fakeFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('/wham/usage'))
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18000,
                reset_at: Math.floor(Date.now() / 1000) + 7200,
              },
            },
          })
        const response = await fetch(input, init)
        expect(response.headers.get('content-type')).toBe(contentType ?? null)
        return response
      },
      { preconnect() {} },
    ) as typeof fetch
    const localModel = { ...model, baseUrl: server.url.toString() }
    let beforeParsing: string | undefined
    const options = {
      apiKey: token,
      fetch: fakeFetch,
      transport: 'sse' as const,
    }
    try {
      const rawEvents = []
      for await (const event of streamSimple(
        localModel,
        { messages: [] },
        options,
      ))
        rawEvents.push(event)
      expect(JSON.stringify(rawEvents)).toContain(message)
      beforeParsing = undefined
      const runtime = new PiOpenAIRuntime({
        vault,
        paths: () => ({
          configPath: join(dir, 'pool.json'),
          statePath: join(dir, 'pool-state.json'),
        }),
        createStream: createAssistantMessageEventStream,
        fetchImpl: fakeFetch,
        streamSimple: (model, context, supplied) => {
          const send = supplied?.fetch ?? fakeFetch
          return streamSimple(model, context, {
            ...supplied,
            fetch: Object.assign(
              async (input: RequestInfo | URL, init?: RequestInit) => {
                const response = await send(input, init)
                beforeParsing = await response.clone().text()
                return response
              },
              send,
            ),
          })
        },
      })
      const events = []
      for await (const event of runtime.stream(
        localModel,
        { messages: [] },
        options,
      ))
        events.push(event)
      expect(sends).toBe(2)
      expect(beforeParsing).toBeDefined()
      expect(beforeParsing).not.toContain(token)
      expect(beforeParsing).not.toContain(jwt)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(JSON.stringify(events)).toContain(
        'Stream refused key [credential]; [credential]',
      )
      expect(JSON.stringify(events)).not.toContain(token)
      expect(JSON.stringify(events)).not.toContain(jwt)
    } finally {
      await server.stop(true)
    }
  })
}

for (const operation of [
  'initialize',
  'recordIdentity',
  'recordQuota',
  'refresh',
  'pull',
] as const) {
  test(`Pi deferred ${operation} refuses persistence when enrollment lands at commit`, async () => {
    const paths = {
      configPath: join(dir, 'deferred.json'),
      statePath: join(dir, 'deferred-state.json'),
    }
    const store = openPoolStore({
      provider: 'openai',
      ...paths,
      quota: quotaCodec,
    })
    if (operation === 'initialize')
      writeFileSync(paths.configPath, '{"version":1,"accounts":[]}')
    else
      await store.add({
        id: 'work',
        credential: {
          type: 'oauth',
          access: 'access',
          refresh: 'refresh',
          expires: Date.now() + 86400_000,
        },
      })
    expect(await vault.authority()).toBe('local')
    let armed = false
    let commits = 0
    const onStep: OpenPoolStoreOptions['onStep'] = (step) => {
      if (!armed || !step.startsWith('before-')) return
      commits++
      mkdirSync(dirname(vault.paths.tokenPath), {
        recursive: true,
        mode: 0o700,
      })
      writeFileSync(
        vault.paths.tokenPath,
        JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
        { mode: 0o600 },
      )
    }
    const source = new PiPoolSource({
      paths: () => paths,
      vaultMode: () => vault.enrolled(),
      store: { onStep },
      refreshProvider: async () => ({
        access: 'rotated',
        refresh: 'rotated-refresh',
        expires: Date.now() + 86400_000,
      }),
      pullQuota: async () =>
        armed
          ? {
              snapshot: {
                primary: {
                  usedPercent: 63,
                  remainingPercent: 37,
                  windowMinutes: 300,
                  checkedAt: Date.now(),
                },
              },
              observation: observationFromSnapshot(
                {
                  primary: {
                    usedPercent: 63,
                    windowMinutes: 300,
                    checkedAt: Date.now(),
                  },
                },
                Date.now(),
                true,
              ) ?? { complete: true, checkedAt: Date.now(), limits: [] },
            }
          : (() => {
              throw new Error('no initial poll')
            })(),
    })
    const bytes = () =>
      [paths.configPath, paths.statePath].map((path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      })
    if (operation !== 'initialize') {
      await source.load()
      await source.settled()
    }
    const before = bytes()
    armed = true
    if (operation === 'initialize') await source.load()
    else if (operation === 'refresh')
      await source.refreshDueTokens(source.peek().rows, {
        version: 1,
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 2000 },
      })
    else if (operation === 'pull') source.poolStore().requestReading('work')
    else {
      const loaded = await source.poolStore().read()
      if (loaded.status !== 'ready') throw new Error('pool not ready')
      const epoch = loaded.rows[0]?.credentialEpoch
      if (epoch === undefined) throw new Error('missing epoch')
      if (operation === 'recordIdentity')
        await source
          .poolStore()
          .recordIdentity('work', 'identity', { credentialEpoch: epoch })
          .catch(() => {})
      else
        await source
          .poolStore()
          .recordQuota(
            'work',
            { credentialEpoch: epoch },
            observationFromSnapshot(
              {
                primary: {
                  usedPercent: 63,
                  windowMinutes: 300,
                  checkedAt: Date.now(),
                },
              },
              Date.now(),
              true,
            ),
          )
          .catch(() => {})
    }
    await source.settled()
    source.dispose()
    expect(commits).toBe(1)
    expect(bytes()).toEqual(before)
  })
}

for (const stage of ['synchronous', 'late-event'] as const) {
  test(`Pi ${stage} error masks every occurrence of an opaque attempt credential`, async () => {
    const token = 'opaque-request-secret'
    let sends = 0
    const runtime = new PiOpenAIRuntime({
      vault,
      paths: () => ({
        configPath: join(dir, 'opaque.json'),
        statePath: join(dir, 'opaque-state.json'),
      }),
      createStream: createAssistantMessageEventStream,
      fetchImpl: Object.assign(
        async () =>
          Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18000,
                reset_at: Math.floor(Date.now() / 1000) + 7200,
              },
            },
          }),
        { preconnect() {} },
      ) as typeof fetch,
      streamSimple: () => {
        sends++
        const message = `Invalid API key: ${token} twice ${token}; Bearer other-key`
        if (stage === 'synchronous') throw new Error(message)
        const stream = createAssistantMessageEventStream()
        const blank = errorEvent(model, '')
        if (blank.type !== 'error') throw new Error('expected error event')
        stream.push({ type: 'start', partial: blank.error })
        stream.push(errorEvent(model, message))
        stream.end()
        return stream
      },
    })
    const events = []
    for await (const event of runtime.stream(
      model,
      { messages: [] },
      { apiKey: token },
    ))
      events.push(event)
    expect(sends).toBe(1)
    const output = JSON.stringify(events)
    expect(output).toContain('Invalid API key: [credential] twice [credential]')
    expect(output).not.toContain(token)
    expect(output).not.toContain('other-key')
  })
}

test('Pi fetch rejection is scrubbed without a start event', async () => {
  const token = chatgptAccessToken('fetch-failure')
  const fakeFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).includes('/wham/usage'))
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 7200,
            },
          },
        })
      throw new Error(`Transport refused ${token}`)
    },
    { preconnect() {} },
  ) as typeof fetch
  const runtime = new PiOpenAIRuntime({
    vault,
    paths: () => ({
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'pool-state.json'),
    }),
    createStream: createAssistantMessageEventStream,
    fetchImpl: fakeFetch,
    streamSimple,
  })
  const events = []
  for await (const event of runtime.stream(
    model,
    { messages: [] },
    { apiKey: token, fetch: fakeFetch, transport: 'sse' },
  ))
    events.push(event)
  expect(events.some((event) => event.type === 'start')).toBe(false)
  expect(events.some((event) => event.type === 'error')).toBe(true)
  expect(JSON.stringify(events)).not.toContain(token)
  expect(JSON.stringify(events)).toContain('Transport refused [credential]')
})

test('Pi late transport errors scrub the shared partial retained by start events', async () => {
  const token = 'opaque-shared-partial-secret'
  const runtime = new PiOpenAIRuntime({
    vault,
    paths: () => ({
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'pool-state.json'),
    }),
    createStream: createAssistantMessageEventStream,
    fetchImpl: Object.assign(
      async () =>
        Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 7200,
            },
          },
        }),
      { preconnect() {} },
    ) as typeof fetch,
    streamSimple: () => {
      const stream = createAssistantMessageEventStream()
      const failed = errorEvent(model, '')
      if (failed.type !== 'error') throw new Error('Expected assistant error')
      stream.push({ type: 'start', partial: failed.error })
      queueMicrotask(() => {
        failed.error.errorMessage = `Late transport ${token}`
        stream.push(failed)
        stream.end()
      })
      return stream
    },
  })
  const events = []
  for await (const event of runtime.stream(
    model,
    { messages: [] },
    { apiKey: token },
  ))
    events.push(event)
  expect(events.some((event) => event.type === 'start')).toBe(true)
  expect(events.some((event) => event.type === 'error')).toBe(true)
  expect(JSON.stringify(events)).not.toContain(token)
  expect(JSON.stringify(events)).toContain('Late transport [credential]')
})

test('Pi fetch throws are owned before pi-ai reads diagnostic getters', async () => {
  const token = chatgptAccessToken('fetch-proxy')
  let traps = 0
  let sends = 0
  const diagnostic = new Proxy(new Error(`Refused ${token}`), {
    getPrototypeOf() {
      traps++
      return Error.prototype
    },
    get(target, key) {
      traps++
      return Reflect.get(target, key)
    },
  })
  const fakeFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).includes('/wham/usage'))
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 7200,
            },
          },
        })
      sends++
      throw diagnostic
    },
    { preconnect() {} },
  ) as typeof fetch
  const runtime = new PiOpenAIRuntime({
    vault,
    paths: () => ({
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'pool-state.json'),
    }),
    createStream: createAssistantMessageEventStream,
    fetchImpl: fakeFetch,
    streamSimple,
  })
  const events = []
  for await (const event of runtime.stream(
    model,
    { messages: [] },
    { apiKey: token, fetch: fakeFetch, transport: 'sse' },
  ))
    events.push(event)
  expect(sends).toBeGreaterThan(0)
  expect(events.some((event) => event.type === 'error')).toBe(true)
  expect(traps).toBe(0)
  expect(JSON.stringify(events)).not.toContain(token)
})
