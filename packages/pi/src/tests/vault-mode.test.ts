// While Pi is connected to the Claustrum vault, only vault credentials may
// authenticate requests. Pi's own login is stashed, and the local account pool
// (additional OAuth logins) is not refreshed, quota-polled, or written. If no
// vault account can authorize a request, it is refused without sending it.
// Disconnect restores Pi's original login and local-account routing.
//
// Pi resolves auth before calling a provider's stream. The real model-runtime
// tests therefore swap the stored login before reloading Pi's auth snapshot.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPiSlot } from '@cortexkit/common-auth/pi-slot'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  mutateAccounts,
  OpenAiVault,
  type RoutingMode,
  VAULT_MODE_REFUSALS,
  vaultPaths,
  vaultStateDir,
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
import { createPiMenu } from '../commands.ts'
import { registerPiProvider } from '../index.ts'
import { clearPiStickyRouting } from '../routing.ts'
import { PiOpenAIRuntime } from '../runtime.ts'
import {
  openVaultSlot,
  VAULT_PLACEHOLDER_KEY,
  VAULT_SLOT_CONFLICT,
  VAULT_SLOT_REFUSAL,
} from '../vault-slot.ts'

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
  stateDir = vaultStateDir(paths.statePath)
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
    slot: openPiSlot({
      authPath: join(dir, 'auth.json'),
      stashPath: join(stateDir, 'pi-openai-codex-login.json'),
      provider: 'openai-codex',
      placeholderKey: VAULT_PLACEHOLDER_KEY,
    }),
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
    apiKey: runtime.vaultMode() ? VAULT_PLACEHOLDER_KEY : NATIVE_ACCESS,
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

function writeNativeLogin(): string {
  const entryJson = `{
    "type": "oauth", "access": ${JSON.stringify(NATIVE_ACCESS)},
    "refresh": "native-refresh", "expires": 1,
    "accountId": "chatgpt-native", "extra": { "preserve": true }
  }`
  writeFileSync(
    join(dir, 'auth.json'),
    `{\n  "unrelated": { "type": "api_key", "key": "other" },\n  "openai-codex": ${entryJson}\n}\n`,
    { mode: 0o600 },
  )
  return entryJson
}

describe("Pi's real model runtime in vault mode", () => {
  test('an expired Pi login is stashed before reload and requests use openai-codex without refresh', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    // Pi's own `openai-codex` login, run out: resolving it would refresh it
    // with OpenAI and store the result in this file.
    const authPath = join(dir, 'auth.json')
    const entryJson = writeNativeLogin()
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
      registerPiProvider(
        {
          registerProvider: (name: string, config: unknown) =>
            models.registerProvider(name, config as never),
        } as never,
        runtime,
      )
      let reloads = 0
      await runtime.syncVaultSlot(async () => {
        reloads++
        await models.refresh()
      })
      expect(reloads).toBe(1)
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'],
      ).toEqual({
        type: 'api_key',
        key: VAULT_PLACEHOLDER_KEY,
      })
      const stashPath = join(stateDir, 'pi-openai-codex-login.json')
      const stash = JSON.parse(readFileSync(stashPath, 'utf8'))
      expect(stash.entryJson).toBe(entryJson)
      expect(stash.entry).toEqual(JSON.parse(authBefore)['openai-codex'])
      expect(statSync(stashPath).mode & 0o777).toBe(0o600)
      expect(statSync(stateDir).mode & 0o777).toBe(0o700)

      const available = (await models.getAvailable()).filter((model) =>
        model.provider.startsWith('openai-codex'),
      )
      expect(available.length).toBeGreaterThan(0)
      expect(
        available.every((model) => model.provider === 'openai-codex'),
      ).toBe(true)
      const model = available.find((entry) => entry.id === 'gpt-5.4')
      if (!model) throw new Error('openai-codex offers no gpt-5.4')

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
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
    } finally {
      globalThis.fetch = piFetch
      target.close()
    }
  })
})

describe('Pi vault slot lifecycle', () => {
  test('the vault slot uses Pi auth.json independently of pool file overrides', async () => {
    const previousAgentDir = process.env.PI_AGENT_DIR
    const previousPoolFile = process.env.PI_OPENAI_AUTH_FILE
    try {
      const agentDir = join(dir, 'agent')
      process.env.PI_AGENT_DIR = agentDir
      process.env.PI_OPENAI_AUTH_FILE = join(dir, 'different-pool.json')
      mkdirSync(agentDir, { mode: 0o700 })
      const authPath = join(agentDir, 'auth.json')
      const before =
        '{"openai-codex":{"type":"oauth","access":"native","refresh":"refresh","expires":1}}'
      writeFileSync(authPath, before, { mode: 0o600 })
      const slot = openVaultSlot(paths.statePath)
      await slot.enterVault()
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        true,
      )
      expect(existsSync(process.env.PI_OPENAI_AUTH_FILE)).toBe(false)
      await slot.exitVault()
      expect(readFileSync(authPath, 'utf8')).toBe(before)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR
      else process.env.PI_AGENT_DIR = previousAgentDir
      if (previousPoolFile === undefined) delete process.env.PI_OPENAI_AUTH_FILE
      else process.env.PI_OPENAI_AUTH_FILE = previousPoolFile
    }
  })

  test('disconnect restores the original Pi entry byte-identical before removing enrollment', async () => {
    writeNativeLogin()
    const authPath = join(dir, 'auth.json')
    const before = readFileSync(authPath)
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    let reloads = 0
    const refresh = async () => {
      reloads++
    }
    try {
      await runtime.syncVaultSlot(refresh)
      const command = createPiMenu(runtime.commandSupport(), {
        afterApply: () => runtime.syncVaultSlot(refresh),
      })
      // Pi's original auth entry must already be restored when deletion of
      // this host's vault enrollment token begins.
      const disconnect = target.disconnect.bind(target)
      target.disconnect = async () => {
        expect(readFileSync(authPath)).toEqual(before)
        expect(existsSync(vaultPaths(stateDir, 'pi').tokenPath)).toBe(true)
        await disconnect()
      }
      const result = await command.apply(
        {
          command: 'openai',
          sectionId: 'vault',
          actionId: 'disconnect',
          confirmed: true,
        },
        { notify() {} },
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(authPath)).toEqual(before)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        false,
      )
      expect(existsSync(vaultPaths(stateDir, 'pi').tokenPath)).toBe(false)
      expect(reloads).toBe(2)
    } finally {
      target.close()
    }
  })

  test('a foreign Pi login makes disconnect report a conflict and overwrite neither login', async () => {
    writeNativeLogin()
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime.syncVaultSlot()
      const authPath = join(dir, 'auth.json')
      const stashPath = join(stateDir, 'pi-openai-codex-login.json')
      const stashBefore = readFileSync(stashPath)
      const foreign =
        '{ "openai-codex": {"type":"oauth","access":"foreign-access","refresh":"foreign-refresh","expires":1} }\n'
      writeFileSync(authPath, foreign)
      const command = createPiMenu(runtime.commandSupport())
      const result = await command.apply(
        {
          command: 'openai',
          sectionId: 'vault',
          actionId: 'disconnect',
          confirmed: true,
        },
        { notify() {} },
      )
      expect(result.ok).toBe(true)
      expect(result.text).toContain(VAULT_SLOT_CONFLICT)
      expect(readFileSync(authPath, 'utf8')).toBe(foreign)
      expect(readFileSync(stashPath)).toEqual(stashBefore)
      expect(existsSync(vaultPaths(stateDir, 'pi').tokenPath)).toBe(false)
      expect(runtime.vaultMode()).toBe(false)
    } finally {
      target.close()
    }
  })

  test('a non-placeholder resolved credential refuses locally even with a healthy vault', async () => {
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
      const pollsBefore = [...whamTokens]
      for (const apiKey of [NATIVE_ACCESS, undefined]) {
        const events: AssistantMessageEvent[] = []
        for await (const event of runtime.stream(MODEL, CONTEXT, {
          transport: 'sse',
          fetch: fakeFetch,
          apiKey,
        }))
          events.push(event)
        expect(errorOf(events)).toBe(VAULT_SLOT_REFUSAL)
      }
      expect(codexTokens).toEqual([])
      expect(whamTokens).toEqual(pollsBefore)
      expect(refreshes).toBe(0)
    } finally {
      target.close()
    }
  })

  test('only openai-codex is registered in local and vault mode', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    const registrations: string[] = []
    const registrar = {
      registerProvider: (id: string) => {
        registrations.push(id)
      },
    }
    try {
      registerPiProvider(registrar as never, runtime)
      enroll()
      await runtime.syncVaultSlot()
      registerPiProvider(registrar as never, runtime)
      expect(registrations).toEqual(['openai-codex', 'openai-codex'])
    } finally {
      target.close()
    }
  })

  test('approval after startup swaps the login and awaits Pi reload before returning', async () => {
    writeNativeLogin()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime.syncVaultSlot()
      enroll()
      let release!: () => void
      let entered!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const reloading = new Promise<void>((resolve) => {
        entered = resolve
      })
      let finished = false
      const pending = runtime
        .syncVaultSlot(async () => {
          expect(
            JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))[
              'openai-codex'
            ].key,
          ).toBe(VAULT_PLACEHOLDER_KEY)
          entered()
          await released
        })
        .then(() => {
          finished = true
        })
      await reloading
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        expect(finished).toBe(false)
      } finally {
        release()
        await pending
      }
      expect(finished).toBe(true)
    } finally {
      target.close()
    }
  })
})
