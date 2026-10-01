// The Claustrum vault end to end on Pi: the real claustrum client over a
// socket to the mock daemon, Pi's `/openai` Vault section, and Pi requests
// routed to a vault account.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaustrumEnrollmentToken } from '@cortexkit/common-auth/claustrum'
import {
  type AccountPaths,
  mutateAccounts,
  OpenAiVault,
  type RoutingMode,
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
import {
  chatgptAccessToken,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { createPiMenu } from '../commands.ts'
import { clearPiStickyRouting } from '../routing.ts'
import { PiOpenAIRuntime } from '../runtime.ts'

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')

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
let daemon: MockDaemon
let codexTokens: string[]
let codexStatus: (token: string) => number

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const token =
    new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '') ??
    ''
  if (url === CODEX_URL) {
    codexTokens.push(token)
    const status = codexStatus(token)
    return status === 200 ? sseOk() : new Response('{}', { status })
  }
  if (url === WHAM_URL) return whamOk()
  return new Response('unexpected', { status: 500 })
}) as typeof fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-openai-vault-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
  stateDir = join(dir, 'vault')
  codexTokens = []
  codexStatus = () => 200
})

afterEach(async () => {
  clearPiStickyRouting('session-1')
  await daemon?.stop()
  rmSync(dir, { recursive: true, force: true })
})

function vault(): OpenAiVault {
  return new OpenAiVault({
    host: 'pi',
    stateDir,
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    fetchImpl: () => fakeFetch,
  })
}

function runtimeWith(target: OpenAiVault): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    fetchImpl: fakeFetch,
    firstReadingWaitMs: 0,
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
    ...(sessionId ? { sessionId } : {}),
  })
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>)
    events.push(event)
  return events
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

describe('Pi and the Claustrum vault', () => {
  test("Connect in the Vault section enrolls Pi under its own name and stores Pi's token owner-only", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:work': vaultLogin('chatgpt-work') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    const notices: string[] = []
    const menu = createPiMenu(runtime.commandSupport(), {
      vaultWait: {
        pollIntervalMs: 1,
        sleep: async () => daemon.approve('request-1'),
      },
    })

    const started = await menu.apply(
      { command: 'openai', sectionId: 'vault', actionId: 'connect' },
      { notify: (message) => notices.push(message) },
    )

    expect(started.ok).toBe(true)
    expect(started.text).toContain(
      'ck auth enroll approve --request-id request-1',
    )
    for (let i = 0; i < 200 && notices.length === 0; i++) await Bun.sleep(10)
    expect(notices.at(-1)).toContain('Connected: the vault approved openai-auth-pi')
    expect(daemon.proposals.map((proposal) => proposal.name)).toEqual([
      'openai-auth-pi',
    ])
    const { tokenPath } = vaultPaths(stateDir, 'pi')
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect((await readClaustrumEnrollmentToken(tokenPath)).token).toBe(
      'ab'.repeat(32),
    )
    expect(() => statSync(vaultPaths(stateDir, 'opencode').tokenPath)).toThrow()
    target.close()
  })

  for (const mode of [
    'main-first',
    'fallback-first',
    'sticky-balanced',
  ] as const) {
    test(`a Pi request in ${mode} is sent with the token the vault serves`, async () => {
      daemon = await startMockDaemon({
        directory: dir,
        credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      })
      enroll()
      const target = vault()
      const runtime = runtimeWith(target)
      await target.refresh()
      await target.pollStale(0)
      await setMode(mode)

      const events = await send(runtime, 'session-1')

      expect(events[0]?.type).toBe('start')
      expect(codexTokens).toEqual([VAULT_ACCESS])
      expect(daemon.gets.map((get) => get.credential_id)).toContain(
        'oauth:openai:vault',
      )
      target.close()
    })
  }

  test('a 401 on a vault account is reported to the vault with the version it was served', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        'oauth:openai:vault': vaultLogin('chatgpt-vault', {
          record_version: 4,
        }),
      },
    })
    enroll()
    codexStatus = (token) => (token === VAULT_ACCESS ? 401 : 200)
    const target = vault()
    const runtime = runtimeWith(target)
    await target.refresh()
    await target.pollStale(0)

    await send(runtime)

    expect(codexTokens).toEqual([VAULT_ACCESS])
    expect(daemon.reports).toEqual([
      {
        credential_id: 'oauth:openai:vault',
        enrollment_token: '01'.repeat(32),
        provider_status: 401,
        record_version: 4,
        reporter_source: 'direct',
      },
    ])
    target.close()
  })
})
