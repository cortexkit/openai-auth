import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { createOpenAICacheKeepAdapter } from '../core/cachekeep'
import { flushForTest } from '../logger'
import { installPoolHooks } from '../v2/setup'
import { observeHttpCompletion, streamResponsesWebSocket } from '../ws'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'
import { fixture } from './fixtures/opencode2-routing'

const MESSAGE = 'Codex transformed input items'
const MODEL = 'gpt-6.2-sol'
const URL = 'https://chatgpt.com/backend-api/codex/responses'
const TRANSFORMATIONS = [
  {
    action: 'removed',
    type: 'reasoning',
    reason: 'prefix_mismatch',
    id: 'rs_1',
  },
  {
    action: 'removed',
    type: 'reasoning',
    reason: 'prefix_mismatch',
    id: 'rs_2',
  },
  { action: 'replaced', type: 'message', reason: 'different_encoding' },
  { action: 'a'.repeat(41), type: 'Message', reason: 'private content' },
]

function completion(changed: boolean): string {
  return JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp_test',
      model: MODEL,
      account_id: 'account_test',
      session_id: 'session_test',
      output: [{ type: 'message', content: 'private answer' }],
      usage: { input_tokens: 42, output_tokens: 100 },
      input_transformations: changed ? TRANSFORMATIONS : [],
    },
  })
}

function sse(frame: string): string {
  return `data: ${frame}\n\ndata: ${frame}\n\n`
}

function reply(text: string): Response {
  return new Response(text, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function opencode1WebSocket(frame: string): Promise<void> {
  class Socket extends EventTarget {
    send() {
      queueMicrotask(() => {
        for (let i = 0; i < 2; i++)
          this.dispatchEvent(new MessageEvent('message', { data: frame }))
      })
    }
  }
  const response = streamResponsesWebSocket({
    socket: new Socket() as unknown as WebSocket,
    body: { model: MODEL },
  })
  expect(await response.text()).toBe(`data: ${frame}\n\ndata: [DONE]\n\n`)
}

async function opencode2(
  frame: string,
  transport: 'http' | 'websocket',
): Promise<void> {
  const host = fakeOpenCode2Host()
  const { openai } = fixture(false)
  const installed = await installPoolHooks(host.ctx, openai.adapter, {
    warn() {},
  })
  openai.attach(installed)
  const hookScope = scope()
  const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
  try {
    if (transport === 'http') {
      const draft = await host.fire('http.request', {
        ...hookScope,
        request: new Request(URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: MODEL, input: [] }),
        }),
      })
      expect(draft.request.headers.get('authorization')).toBe(
        'Bearer local-token',
      )
      const received = await host.fire('http.response', {
        ...draft,
        response: reply(sse(frame)),
      })
      expect(await received.response.text()).toBe(sse(frame))
    } else {
      await host.fire('experimental.ws.handshake', {
        ...hookScope,
        url: URL.replace(/^https:/, 'wss:'),
        headers,
      })
      await host.fire('experimental.ws.send', {
        ...hookScope,
        frame: JSON.stringify({
          type: 'response.create',
          model: MODEL,
          input: [],
        }),
      })
      for (let i = 0; i < 2; i++) {
        const received = await host.fire('experimental.ws.receive', {
          ...hookScope,
          frame,
        })
        expect(received.frame).toBe(frame)
      }
    }
  } finally {
    openai.dispose()
    await installed.dispose()
  }
}

type Host = 'opencode1' | 'opencode2'

function keepWarm(frame: string, host: Host): void {
  const text = sse(frame)
  const adapter = createOpenAICacheKeepAdapter({
    ...(host === 'opencode2' ? { host } : {}),
    fetchImpl: fetch,
    codexResponsesUrl: URL,
    getMainToken: async () => 'unused',
    refreshFallback: async () => 'unused',
  })
  expect(
    adapter.readUsage?.({
      text,
      response: reply(text),
      target: {
        sessionKey: 'warm-test',
        accountId: 'main',
        bodyText: '{}',
        isSubagent: false,
        warmCount: 0,
        ttlMs: 300_000,
        meta: { replayHeaders: {} },
      },
    }),
  ).toMatchObject({ input_tokens: 42, output_tokens: 100 })
}

let logDir: string
let previousLogFile: string | undefined
let previousLogLevel: string | undefined

beforeEach(async () => {
  await flushForTest()
  logDir = await mkdtemp(join(tmpdir(), 'codex-transformations-'))
  previousLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
  previousLogLevel = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(logDir, 'plugin.log')
  process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'info'
})

afterEach(async () => {
  await flushForTest()
  if (previousLogFile === undefined)
    delete process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
  else process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = previousLogFile
  if (previousLogLevel === undefined)
    delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
  else process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = previousLogLevel
  await rm(logDir, { recursive: true, force: true })
})

async function transformationLines(): Promise<string[]> {
  await flushForTest()
  const file = Bun.file(join(logDir, 'plugin.log'))
  if (!(await file.exists())) return []
  return (await file.text())
    .split('\n')
    .filter((line) => line.includes(MESSAGE))
}

const observers = [
  {
    host: 'opencode1',
    transport: 'http',
    path: 'activity',
    async run(frame: string) {
      const text = sse(frame)
      const response = observeHttpCompletion(reply(text), () => {})
      expect(await response.text()).toBe(text)
    },
  },
  {
    host: 'opencode1',
    transport: 'websocket',
    path: 'frame',
    run: opencode1WebSocket,
  },
  {
    host: 'opencode2',
    transport: 'http',
    path: 'attempt',
    run: (frame: string) => opencode2(frame, 'http'),
  },
  {
    host: 'opencode2',
    transport: 'websocket',
    path: 'attempt',
    run: (frame: string) => opencode2(frame, 'websocket'),
  },
  ...(['opencode1', 'opencode2'] as const).map((host) => ({
    host,
    transport: 'http',
    path: 'keep-warm',
    run: (frame: string) => keepWarm(frame, host),
  })),
] as const

for (const { host, transport, path, run } of observers) {
  const name = `${host} ${transport} ${path}`

  test(`${name} logs one info line with only input transformation counts`, async () => {
    await run(completion(true))
    const lines = await transformationLines()
    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ''
    expect(line).toMatch(
      /^\[[^\]]+\] INFO \[transport\] Codex transformed input items /,
    )
    expect(
      JSON.parse(line.slice(line.indexOf(MESSAGE) + MESSAGE.length + 1)),
    ).toEqual({
      model: MODEL,
      count: 4,
      items: {
        'removed:reasoning': 2,
        'replaced:message': 1,
        'other:other': 1,
      },
      reasons: { prefix_mismatch: 2, different_encoding: 1, other: 1 },
      transport,
      host,
    })
  })

  test(`${name} stays quiet for empty input transformations`, async () => {
    await run(completion(false))
    expect(await transformationLines()).toEqual([])
  })
}
