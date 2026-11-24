import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { createOpenAICacheKeepAdapter } from '../core/cachekeep'
import { flushForTest } from '../logger'
import { FrameMirror } from '../v2/frame-mirror'
import { installPoolHooks } from '../v2/setup'
import { observeHttpCompletion, streamResponsesWebSocket } from '../ws'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'
import { fixture } from './fixtures/opencode2-routing'
import { restoreEnv } from './setup-env'

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
    body: { model: MODEL, previous_response_id: 'resp_previous' },
  })
  expect(await response.text()).toBe(`data: ${frame}\n\ndata: [DONE]\n\n`)
}

async function opencode2(
  frame: string,
  transport: 'http' | 'websocket',
  chained = false,
): Promise<void> {
  const host = fakeOpenCode2Host()
  const { openai } = fixture(false)
  const installed = await installPoolHooks(host.ctx, openai.adapter, {
    warn() {},
  })
  openai.attach(installed)
  const hookScope = scope()
  const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
  const body = {
    model: MODEL,
    input: [],
    ...(chained ? { previous_response_id: 'resp_previous' } : {}),
  }
  try {
    if (transport === 'http') {
      const draft = await host.fire('http.request', {
        ...hookScope,
        request: new Request(URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
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
          ...body,
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

function keepWarm(frame: string, host: Host, chained = false): void {
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
        bodyText: chained ? '{"previous_response_id":"resp_previous"}' : '{}',
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
  restoreEnv('OPENCODE_OPENAI_AUTH_LOG_FILE', previousLogFile)
  restoreEnv('OPENCODE_OPENAI_AUTH_LOG_LEVEL', previousLogLevel)
  await rm(logDir, { recursive: true, force: true })
})

async function logLines(message = MESSAGE): Promise<string[]> {
  await flushForTest()
  const file = Bun.file(join(logDir, 'plugin.log'))
  if (!(await file.exists())) return []
  return (await file.text())
    .split('\n')
    .filter((line) => line.includes(message))
}

const observers = [
  {
    host: 'opencode1',
    transport: 'http',
    path: 'activity',
    context: {},
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
    context: { warm: false, chained: true },
    run: opencode1WebSocket,
  },
  {
    host: 'opencode2',
    transport: 'http',
    path: 'attempt',
    context: { warm: false, chained: false },
    run: (frame: string) => opencode2(frame, 'http'),
  },
  {
    host: 'opencode2',
    transport: 'websocket',
    path: 'full attempt',
    context: { warm: false, chained: false },
    run: (frame: string) => opencode2(frame, 'websocket'),
  },
  {
    host: 'opencode2',
    transport: 'websocket',
    path: 'chained attempt',
    context: { warm: false, chained: true },
    run: (frame: string) => opencode2(frame, 'websocket', true),
  },
  ...(['opencode1', 'opencode2'] as const).map((host) => ({
    host,
    transport: 'http',
    path: 'keep-warm',
    context: { warm: true, chained: false },
    run: (frame: string) => keepWarm(frame, host),
  })),
  {
    host: 'opencode2',
    transport: 'http',
    path: 'keep-warm with previous response',
    context: { warm: true, chained: true },
    run: (frame: string) => keepWarm(frame, 'opencode2', true),
  },
] as const

for (const { host, transport, path, context, run } of observers) {
  const name = `${host} ${transport} ${path}`

  test(`${name} logs one info line with transformation counts and known request context`, async () => {
    await run(completion(true))
    const lines = await logLines()
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
      ...context,
    })
  })

  test(`${name} stays quiet for empty input transformations`, async () => {
    await run(completion(false))
    expect(await logLines()).toEqual([])
  })
}

test('the frame mirror logs each invalidation reason once per session without ids', async () => {
  const mirror = new FrameMirror(true)
  const session = 'private-session'
  const send = (fields: Record<string, unknown> = {}) =>
    mirror.send(
      session,
      JSON.stringify({ type: 'response.create', input: [], ...fields }),
    )
  const receive = (event: Record<string, unknown>) =>
    mirror.receive(session, JSON.stringify(event))
  const complete = (id: string, fields: Record<string, unknown> = {}) =>
    receive({ type: 'response.completed', response: { id, ...fields } })
  for (let index = 0; index < 2; index++) {
    send()
    complete(`private-transformed-${index}`, {
      input_transformations: TRANSFORMATIONS,
    })
    send()
    receive({
      type: 'response.output_item.done',
      item: { type: 'message' },
      output_index: 1,
    })
    complete(`private-incomplete-${index}`)
    send({ instructions: 'system' })
    const id = `private-completed-${index}`
    complete(id)
    send({ previous_response_id: id, instructions: 'changed' })
  }
  const message = 'OpenCode 2 keep-warm snapshot invalidated'
  const lines = await logLines(message)
  expect(lines.map((line) => line.replace(/^\[[^\]]+\] /, ''))).toEqual(
    ['provider-transformed', 'output-incomplete', 'fields-changed'].map(
      (reason) => `INFO [cachekeep] ${message} ${JSON.stringify({ reason })}`,
    ),
  )
})

test('the frame mirror logs differing reasoning copies once per session at debug without ids', async () => {
  process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
  const mirror = new FrameMirror(true)
  const session = 'private-session'
  const item = {
    type: 'reasoning',
    id: 'private-reasoning',
    encrypted_content: 'secret',
  }
  for (let index = 0; index < 2; index++) {
    mirror.send(session, '{"type":"response.create","input":[]}')
    mirror.receive(
      session,
      JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item,
      }),
    )
    mirror.receive(
      session,
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: `private-completed-${index}`,
          output: [{ ...item, encrypted_content: 'other-secret' }],
        },
      }),
    )
  }
  const message = 'Codex reasoning differs between done and completed'
  const lines = await logLines(message)
  expect(lines.map((line) => line.replace(/^\[[^\]]+\] /, ''))).toEqual([
    `DEBUG [cachekeep] ${message} {"reason":"reasoning-reencrypted"}`,
  ])
})
