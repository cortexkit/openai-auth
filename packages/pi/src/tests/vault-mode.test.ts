// Vault mode on Pi: while Pi is connected to the Claustrum vault, only the
// vault's accounts serve. Pi's own login and every pool row (also one the
// vault does not hold) are neither sent with, refreshed, polled nor written;
// a request no vault account can serve is refused with a fixed message and
// nothing is sent. Disconnecting restores local routing.
//
// The last test runs Pi's real model runtime: Pi resolves a provider's stored
// login before it calls the provider's stream, refreshing and storing an
// expired one, so in vault mode the models are offered under a provider of
// their own whose key is a placeholder, and Pi's auth file is never touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  mutateAccounts,
  OpenAiVault,
  type RoutingMode,
  VAULT_MODE_REFUSALS,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  chatgptAccessToken,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import {
  createProviderSync,
  VAULT_PLACEHOLDER_KEY,
  VAULT_PROVIDER_ID,
} from '../index.ts'
import { clearPiStickyRouting } from '../routing.ts'
import { PiOpenAIRuntime } from '../runtime.ts'

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')
/** The token Pi hands over for its own `openai-codex` login. */
const NATIVE_ACCESS = chatgptAccessToken('chatgpt-native')

const MODEL: Model<Api> = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
}

const CONTEXT: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
}

function sseOk(): Response {
  const body = [
    'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","status":"in_progress","content":[]}}',
    'data: {"type":"response.output_text.delta","item_id":"m1","delta":"hi"}',
    'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi"}]}}',
    'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    '',
  ].join('\n\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function whamOk(): Response {
  const resetAt = Math.floor((Date.now() + 7_200_000) / 1000)
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 18_000,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 604_800,
        reset_at: resetAt + 86_400,
      },
    },
  })
}

let dir: string
let paths: AccountPaths
let stateDir: string
let daemon: MockDaemon | undefined
/** Bearer of every Codex request sent. */
let codexTokens: string[]
/** Bearer of every quota poll sent. */
let whamTokens: string[]
/** Every token refresh sent to OpenAI's token endpoint. */
let refreshes: number

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const token =
    new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '') ??
    ''
  if (url === CODEX_URL) {
    codexTokens.push(token)
    return sseOk()
  }
  if (url === WHAM_URL) {
    whamTokens.push(token)
    return whamOk()
  }
  if (url.startsWith(TOKEN_URL)) {
    refreshes++
    return new Response('{}', { status: 400 })
  }
  return new Response('unexpected', { status: 500 })
}) as typeof fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-openai-vault-mode-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
  stateDir = join(dir, 'vault')
  codexTokens = []
  whamTokens = []
  refreshes = 0
})

afterEach(async () => {
  clearPiStickyRouting('session-1')
  await daemon?.stop()
  daemon = undefined
  rmSync(dir, { recursive: true, force: true })
})

function vault(
  overrides: Partial<ConstructorParameters<typeof OpenAiVault>[0]> = {},
): OpenAiVault {
  return new OpenAiVault({
    host: 'pi',
    stateDir,
    connectionFile: () => daemon?.connectionFile ?? join(dir, 'none.json'),
    pollIntervalMs: 0,
    fetchImpl: () => fakeFetch,
    ...overrides,
  })
}

function runtimeWith(target: OpenAiVault): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    fetchImpl: fakeFetch,
    // Long enough for the first quota poll of Pi's login once local routing
    // is back, so a local request is not refused for want of a reading.
    firstReadingWaitMs: 2_000,
    vault: target,
  })
}

async function send(
  runtime: PiOpenAIRuntime,
  sessionId?: string,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  const stream = runtime.stream(MODEL, CONTEXT, {
    transport: 'sse',
    fetch: fakeFetch,
    apiKey: NATIVE_ACCESS,
    ...(sessionId ? { sessionId } : {}),
  })
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>)
    events.push(event)
  return events
}

function errorOf(events: AssistantMessageEvent[]): string | undefined {
  const last = events.at(-1)
  return last?.type === 'error' ? last.error.errorMessage : undefined
}

async function setMode(mode: RoutingMode): Promise<void> {
  await mutateAccounts((current) => {
    current.routing = { mode }
    return current
  }, paths)
}

function enroll() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath } = vaultPaths(stateDir, 'pi')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
}

/**
 * A pool row for an account the vault does not hold, its token run out. It
 * is written through a store of its own, which polls nothing, so the only
 * polls and refreshes counted are the runtime's.
 */
async function addExpiredLocalRow() {
  await openPoolStore({
    provider: 'openai',
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: quotaCodec,
  }).add({
    id: 'local',
    identity: 'chatgpt-local',
    credential: {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-local'),
      refresh: 'local-refresh',
      expires: Date.now() - 60_000,
    },
  })
}

function poolFiles(): string[] {
  return [paths.configPath, paths.statePath].map((path) =>
    existsSync(path) ? readFileSync(path, 'utf8') : '',
  )
}

describe('Pi in vault mode', () => {
  test("neither Pi's login nor a pool row the vault does not hold is sent with, refreshed or polled, and the pool files stay byte-identical", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await addExpiredLocalRow()
      // Fallback-first puts the pool row ahead of Pi's login and the vault.
      await setMode('fallback-first')
      const before = poolFiles()
      enroll()
      await target.refresh()
      await target.pollStale(0)
      whamTokens = []
      // Everything a session does: start (the pool's first read), requests
      // with and without a session, the menu taking Pi's login, and a quota
      // check.
      await runtime.start()
      for (const session of ['session-1', undefined, 'session-1']) {
        const events = await send(runtime, session)
        expect(events[0]?.type).toBe('start')
      }
      const support = runtime.commandSupport()
      support.observeLogin(NATIVE_ACCESS)
      await support.refreshAllQuota()
      await runtime.pool.settled()

      expect(codexTokens).toEqual([VAULT_ACCESS, VAULT_ACCESS, VAULT_ACCESS])
      expect(whamTokens.every((token) => token === VAULT_ACCESS)).toBe(true)
      expect(refreshes).toBe(0)
      expect(poolFiles()).toEqual(before)
    } finally {
      target.close()
    }
  })

  test('a vault that serves no account refuses the request locally: nothing is sent, refreshed or polled', async () => {
    daemon = await startMockDaemon({ directory: dir, credentials: {} })
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await addExpiredLocalRow()
      enroll()
      await target.refresh()

      const events = await send(runtime)

      expect(errorOf(events)).toBe(VAULT_MODE_REFUSALS['vault-empty'])
      expect(codexTokens).toEqual([])
      expect(whamTokens).toEqual([])
      expect(refreshes).toBe(0)
    } finally {
      target.close()
    }
  })

  test('a vault that cannot be reached refuses the request locally after a bounded wait: nothing is sent, refreshed or polled', async () => {
    const target = vault({ connectScoped: () => new Promise(() => {}) })
    const runtime = runtimeWith(target)
    try {
      await addExpiredLocalRow()
      enroll()
      // The first account list never arrives.
      target.start()
      const started = Date.now()

      const events = await send(runtime)

      expect(errorOf(events)).toBe(VAULT_MODE_REFUSALS['vault-unreachable'])
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(codexTokens).toEqual([])
      expect(whamTokens).toEqual([])
      expect(refreshes).toBe(0)
    } finally {
      target.close()
    }
  }, 10_000)

  test("disconnecting restores local routing: Pi's login serves again", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await target.refresh()
      await target.pollStale(0)
      await send(runtime)
      expect(codexTokens).toEqual([VAULT_ACCESS])

      await target.disconnect()
      await send(runtime)

      expect(codexTokens).toEqual([VAULT_ACCESS, NATIVE_ACCESS])
    } finally {
      target.close()
    }
  })
})

describe("Pi's real model runtime in vault mode", () => {
  test("a request with an expired native login leaves Pi's auth file byte-identical and serves from the vault", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    // Pi's own `openai-codex` login, run out: resolving it would refresh it
    // with OpenAI and store the result in this file.
    const authPath = join(dir, 'auth.json')
    writeFileSync(
      authPath,
      JSON.stringify(
        {
          'openai-codex': {
            type: 'oauth',
            access: NATIVE_ACCESS,
            refresh: 'native-refresh',
            expires: Date.now() - 60_000,
            accountId: 'chatgpt-native',
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    const authBefore = readFileSync(authPath, 'utf8')
    const piFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    const target = vault()
    try {
      const models = await ModelRuntime.create({
        authPath,
        modelsPath: join(dir, 'models.json'),
      })
      const runtime = runtimeWith(target)
      await target.refresh()
      await target.pollStale(0)
      createProviderSync(
        {
          registerProvider: (name: string, config: unknown) =>
            models.registerProvider(name, config as never),
          unregisterProvider: (name: string) => models.unregisterProvider(name),
        } as never,
        runtime,
      )()

      const available = (await models.getAvailable()).filter((model) =>
        model.provider.startsWith('openai-codex'),
      )
      // Only the vault provider's models are offered; `openai-codex` keeps
      // none, so nothing resolves Pi's stored login.
      expect(
        available.every((model) => model.provider === VAULT_PROVIDER_ID),
      ).toBe(true)
      const model = available.find((entry) => entry.id === 'gpt-5.4')
      if (!model) throw new Error('the vault provider offers no gpt-5.4')

      const result = await models
        .streamSimple(model, CONTEXT, {
          sessionId: 'session-1',
          transport: 'sse',
          fetch: fakeFetch,
        } as never)
        .result()

      expect(result.stopReason).not.toBe('error')
      expect(codexTokens).toEqual([VAULT_ACCESS])
      expect(codexTokens).not.toContain(VAULT_PLACEHOLDER_KEY)
      expect(refreshes).toBe(0)
      expect(readFileSync(authPath, 'utf8')).toBe(authBefore)
    } finally {
      globalThis.fetch = piFetch
      target.close()
    }
  })
})
