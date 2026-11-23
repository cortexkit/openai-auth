import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { chatgptAccessToken } from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { createPiOpenAIRuntime, registerPiProvider } from '../index.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

const agentDir = isolatePiAgentDir()
const access = chatgptAccessToken('native-after-output')
const afterOutput =
  'The response ended early after part of it had already been shown. It was not sent again, because repeating it would duplicate that output and re-run any tools it had started.'
const partialText = 'Already shown'
const textStart =
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m","role":"assistant","status":"in_progress","content":[]}}'
const output = [
  textStart,
  `data: {"type":"response.output_text.delta","output_index":0,"item_id":"m","delta":"${partialText}"}`,
]
const failure =
  'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"503 for account Secret Name 17"}}}'
const completion =
  'data: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}'

function sse(frames: string[]): Response {
  return new Response([...frames, ''].join('\n\n'), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function withPiSession(
  firstReply: string[],
  run: (session: AgentSession, sends: string[]) => Promise<void>,
) {
  const dir = agentDir()
  const runtime = createPiOpenAIRuntime({
    configPath: join(dir, 'pool.json'),
    statePath: join(dir, 'pool-state.json'),
  })
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access,
        refresh: 'unused-refresh',
        expires: Date.now() + 3_600_000,
      },
    }),
    { mode: 0o600 },
  )
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-6.1-sol',
    transport: 'sse',
    retry: {
      enabled: true,
      baseDelayMs: 1,
      maxRetries: 1,
      provider: { maxRetries: 0 },
    },
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [(pi) => registerPiProvider(pi, runtime)],
  })
  const sends: string[] = []
  const fetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/wham/usage'))
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18_000,
              reset_at: Math.floor(Date.now() / 1_000) + 7_200,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604_800,
              reset_at: Math.floor(Date.now() / 1_000) + 86_400,
            },
          },
        })
      if (!url.endsWith('/codex/responses'))
        throw new Error(`Unexpected test request: ${url}`)
      sends.push(new Headers(init?.headers).get('authorization') ?? '')
      return sse(sends.length === 1 ? firstReply : [completion])
    },
    fetch,
  )
  let session: AgentSession | undefined
  try {
    runtime.main.observeToken(access)
    await runtime.main.pending()
    await resourceLoader.reload()
    const created = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      noTools: 'all',
    })
    session = created.session
    expect(created.extensionsResult.errors).toEqual([])
    await session.bindExtensions({})
    expect(session.model?.id).toBe('gpt-6.1-sol')
    await run(session, sends)
  } finally {
    session?.dispose()
    await Promise.all([runtime.pool.dispose(), runtime.vault.dispose()])
    globalThis.fetch = fetch
  }
}

test('Pi agent does not resend a retryable failure after a text delta', async () => {
  await withPiSession([...output, failure], async (session, sends) => {
    const deltas: string[] = []
    session.subscribe((event) => {
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      )
        deltas.push(event.assistantMessageEvent.delta)
    })
    await session.prompt('Hello')
    expect(deltas).toEqual([partialText])
    expect(sends).toEqual([`Bearer ${access}`])
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: afterOutput,
    })
  })
})

test('Pi agent still retries a provider error before any output', async () => {
  await withPiSession([textStart, failure], async (session, sends) => {
    const retries: string[] = []
    session.subscribe((event) => {
      if (event.type === 'auto_retry_start') retries.push(event.errorMessage)
    })
    await session.prompt('Hello')
    expect(retries).toEqual(['503 for account Secret Name 17'])
    expect(sends).toEqual([`Bearer ${access}`, `Bearer ${access}`])
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
    })
  })
})

test('Pi uncached stream replaces the provider error after a text delta', async () => {
  await withPiSession([...output, failure], async (session, sends) => {
    if (!session.model) throw new Error('Expected a Codex model')
    const stream = session.modelRuntime.streamSimple(
      session.model,
      { messages: [{ role: 'user', content: 'Summarize', timestamp: 0 }] },
      {
        cacheRetention: 'none',
        sessionId: session.sessionId,
        transport: 'sse',
      },
    )
    const seen: string[] = []
    for await (const event of stream) {
      if (event.type === 'text_delta') seen.push(event.delta)
      if (event.type === 'error') seen.push(event.error.errorMessage ?? '')
    }
    expect(seen).toEqual([partialText, afterOutput])
    expect(sends).toEqual([`Bearer ${access}`])
  })
})
