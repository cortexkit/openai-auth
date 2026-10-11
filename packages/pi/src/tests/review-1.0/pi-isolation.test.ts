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
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  OpenAiVault,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { chatgptAccessToken } from '../../../../core/src/tests/fixtures/mock-claustrum.ts'
import { PiPoolSource } from '../../pool-source.ts'
import { PiOpenAIRuntime } from '../../runtime.ts'
import { openVaultSlot } from '../../vault-slot.ts'

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

test('Pi vault synchronization keeps native auth.json byte-identical while enrolled', async () => {
  const authPath = join(getAgentDir(), 'auth.json')
  const original =
    '{\n "openai-codex": {"type":"oauth","access":"review-native-access","refresh":"review-native-refresh","expires":1},\n "other": {"type":"api_key","key":"review-other-key"}\n}\n'
  writeFileSync(authPath, original, { mode: 0o600 })
  mkdirSync(dirname(vault.paths.tokenPath), { recursive: true, mode: 0o700 })
  writeFileSync(
    vault.paths.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  expect(await vault.authority()).toBe('vault')
  const runtime = new PiOpenAIRuntime({
    paths: () => ({
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'pool-state.json'),
    }),
    vault,
    slot: openVaultSlot(join(dir, 'pool-state.json')),
    createStream: createAssistantMessageEventStream,
    streamSimple: () => {
      throw new Error('no model call expected')
    },
  })
  await runtime.syncVaultSlot()
  expect(readFileSync(authPath, 'utf8')).toBe(original)
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
