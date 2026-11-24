import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type OpenAICodexResponsesOptions,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { chatgptAccessToken } from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { installRawCodexWebSocket } from '../index.ts'
import { RawWebSocket } from '../raw-ws-node.ts'
import { PiOpenAIRuntime } from '../runtime.ts'

const model: Model<'openai-codex-responses'> = {
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
const apiKey = chatgptAccessToken('payload-test-account')
const systemPrompt = '  Answer tersely.\nPreserve punctuation: café.\n'
const sessionId = 'pi-codex-payload-session'
const systemId = 'msg_9e4fd0b8-1a27-5801-9e64-f9a84d591bcc'
const wireNow = 1_800_000_000_000
const installationID = '00000000-0000-4000-8000-000000000100'
const firstTurnID = '00000000-0000-7000-8000-000000000001'
const firstUser = {
  role: 'user',
  content: 'Name a colour.',
  timestamp: 1,
} as const
const context: Context = { systemPrompt, messages: [firstUser] }
const effortModel = { ...model, id: 'gpt-6.2-sol' }
const secondUser = {
  role: 'user',
  content: 'Name another.',
  timestamp: 2,
} as const
const thirdUser = {
  role: 'user',
  content: 'Name one more.',
  timestamp: 3,
} as const
const userItem = (text: string) => ({
  role: 'user',
  content: [{ type: 'input_text', text }],
})
const effortUpdate = (effort: string) => ({
  type: 'configuration_update',
  reasoning: { effort },
})

function developerMessage(text: string, id?: string) {
  return {
    type: 'message',
    ...(id && { id }),
    role: 'developer',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['model.base_instructions'],
    },
  }
}

function responseEvents(turn: number, functionCall = false) {
  if (functionCall) {
    const item = {
      type: 'function_call',
      id: `fc_${turn}`,
      call_id: `call_${turn}`,
      name: 'read',
    }
    return [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          ...item,
          status: 'completed',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: `resp_${turn}`,
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]
  }
  const item = { type: 'message', id: `msg_${turn}`, role: 'assistant' }
  return [
    {
      type: 'response.output_item.added',
      item: { ...item, status: 'in_progress', content: [] },
    },
    { type: 'response.output_text.delta', item_id: item.id, delta: 'Blue.' },
    {
      type: 'response.output_item.done',
      item: {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text: 'Blue.' }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: `resp_${turn}`,
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
}

function mockFetch(
  send: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return Object.assign(send, {
    preconnect() {
      throw new Error('Unexpected preconnect')
    },
  })
}

let dir: string
let runtime: PiOpenAIRuntime
let sdkHttpEncodings: (string | null)[]
let wireHttpEncodings: (string | null)[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-codex-payload-'))
  sdkHttpEncodings = []
  wireHttpEncodings = []
  runtime = makeRuntime(dir)
})

function makeRuntime(directory: string) {
  let nextTurn = 0
  return new PiOpenAIRuntime({
    streamSimple(model, context, options) {
      const fetch = options?.fetch
      return streamSimple(model, context, {
        ...options,
        fetch: mockFetch(async (input, init) => {
          sdkHttpEncodings.push(
            new Headers(init?.headers).get('content-encoding'),
          )
          if (!fetch) throw new Error('Missing transport wrapper')
          return fetch(input, init)
        }),
      })
    },
    createStream: createAssistantMessageEventStream,
    installWebSocket: installRawCodexWebSocket,
    now: () => wireNow,
    installationID,
    turnUuid: () =>
      `00000000-0000-7000-8000-${String(++nextTurn).padStart(12, '0')}`,
    paths: () => ({
      configPath: join(directory, 'openai-auth.json'),
      statePath: join(directory, 'openai-auth-state.json'),
    }),
    fetchImpl: mockFetch(async () =>
      Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18_000,
            reset_at: wireNow / 1000 + 7200,
          },
        },
      }),
    ),
  })
}

afterEach(async () => {
  await Promise.all([runtime.pool.dispose(), runtime.vault.dispose()])
  rmSync(dir, { recursive: true, force: true })
})

async function httpRequest(
  options?: Pick<
    SimpleStreamOptions,
    'cacheRetention' | 'onPayload' | 'reasoning' | 'sessionId' | 'toolChoice'
  > &
    Pick<OpenAICodexResponsesOptions, 'textVerbosity'>,
  requestModel = model,
  requestContext = context,
) {
  const requests: { json: string; headers: Headers }[] = []
  const result = await runtime
    .stream(requestModel, requestContext, {
      apiKey,
      transport: 'sse',
      ...options,
      fetch: mockFetch(async (_input, init) => {
        const payload = new Response(init?.body)
        const headers = new Headers(init?.headers)
        const encoded = headers.get('content-encoding')
        wireHttpEncodings.push(encoded)
        const json =
          encoded === 'zstd'
            ? new TextDecoder().decode(
                Bun.zstdDecompressSync(await payload.arrayBuffer()),
              )
            : await payload.text()
        requests.push({ json, headers })
        return sseResponse(1)
      }),
    })
    .result()
  expect(result.errorMessage).toBeUndefined()
  expect(result.stopReason).toBe('stop')
  expect(requests).toHaveLength(1)
  const [request] = requests
  if (!request) throw new Error('No captured HTTP request')
  return request
}

async function httpBody(...args: Parameters<typeof httpRequest>) {
  return JSON.parse((await httpRequest(...args)).json) as Record<
    string,
    unknown
  >
}

function sseResponse(turn: number) {
  return new Response(
    responseEvents(turn)
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const fixtureUserAgent =
  'codex_exec/0.166.0 (<platform>) unknown (codex_exec; 0.166.0)'

function normalizeUserAgent(
  headers: Headers,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(headers),
    'user-agent': headers
      .get('user-agent')
      ?.replace(/^(\S+ \()[^)]+\)/, '$1<platform>)'),
  }
}

function expectedTurn(turn_id: string) {
  return {
    session_id: 'pi-codex-payload-session',
    thread_id: 'pi-codex-payload-session',
    thread_source: 'user',
    turn_id,
    sandbox: 'seccomp',
    turn_started_at_unix_ms: 1_800_000_000_000,
    request_kind: 'turn',
    window_id: 'pi-codex-payload-session:0',
  }
}

const clientAndAccountHeaders = {
  authorization: `Bearer ${apiKey}`,
  'chatgpt-account-id': 'payload-test-account',
  originator: 'codex_exec',
  version: '0.166.0',
  'user-agent': fixtureUserAgent,
  'x-codex-beta-features': 'terminal_resize_reflow',
}
const primaryIdentityHeaders = {
  'session-id': 'pi-codex-payload-session',
  'thread-id': 'pi-codex-payload-session',
  'x-client-request-id': 'pi-codex-payload-session',
  'x-codex-window-id': 'pi-codex-payload-session:0',
}
const expectedReadTool = {
  type: 'function',
  name: 'read',
  description: 'Read a file',
  strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

test('Pi HTTP sends the OC1 body bytes and application headers with omitted and explicit fields', async () => {
  for (const explicit of [false, true]) {
    const { json, headers } = await httpRequest(
      {
        sessionId,
        ...(explicit && {
          toolChoice: 'auto' as const,
          textVerbosity: 'medium' as const,
          onPayload(raw: unknown) {
            const body = raw as { tools: Record<string, unknown>[] }
            const tool = body.tools[0]
            if (!tool) throw new Error('Missing test tool')
            tool.strict = true
          },
        }),
      },
      model,
      {
        ...context,
        tools: [
          {
            ...readTool,
            parameters: { ...readTool.parameters, $schema: 'dialect' },
          },
        ],
      },
    )
    expect(json).toBe(
      JSON.stringify({
        model: 'gpt-5.4',
        input: [
          developerMessage(
            '  Answer tersely.\nPreserve punctuation: café.\n',
            'msg_9e4fd0b8-1a27-5801-9e64-f9a84d591bcc',
          ),
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Name a colour.' }],
          },
        ],
        tools: [{ ...expectedReadTool, strict: explicit }],
        ...(explicit && { tool_choice: 'auto' }),
        parallel_tool_calls: true,
        reasoning: { effort: 'none' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'pi-codex-payload-session',
        ...(explicit && { text: { verbosity: 'medium' } }),
        client_metadata: {
          'x-codex-installation-id': '00000000-0000-4000-8000-000000000100',
          'x-codex-window-id': 'pi-codex-payload-session:0',
        },
      }),
    )
    expect(normalizeUserAgent(headers)).toEqual({
      ...clientAndAccountHeaders,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...primaryIdentityHeaders,
      'x-codex-turn-metadata': JSON.stringify(
        expectedTurn(
          explicit ? '00000000-0000-7000-8000-000000000002' : firstTurnID,
        ),
      ),
    })
  }
})

test('Pi shapes a helper without sending any primary cache identity', async () => {
  const { json, headers } = await httpRequest(
    {
      sessionId,
      cacheRetention: 'none',
      onPayload(raw) {
        const body = raw as Record<string, unknown>
        body.text = { verbosity: 'low' }
        body.tool_choice = 'required'
        body.prompt_cache_key = 'do-not-use-for-helper'
      },
    },
    model,
    { ...context, tools: [readTool] },
  )
  expect(json).toBe(
    JSON.stringify({
      model: 'gpt-5.4',
      input: [developerMessage(systemPrompt), userItem('Name a colour.')],
      tools: [expectedReadTool],
      tool_choice: 'required',
      parallel_tool_calls: true,
      reasoning: { effort: 'none' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'low' },
    }),
  )
  expect(normalizeUserAgent(headers)).toEqual({
    ...clientAndAccountHeaders,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  })
})

test('Pi sends uncompressed JSON after pi-ai zstd-encodes the HTTP request', async () => {
  const sent = await httpBody({ sessionId })
  expect(sdkHttpEncodings).toEqual(['zstd'])
  expect(wireHttpEncodings).toEqual([null])
  expect(sent.input).toEqual([
    developerMessage(systemPrompt, systemId),
    userItem(firstUser.content),
  ])
})

test('Pi restores GPT-6.2 replayed call status without instructions and keeps GPT-6.1 input bytes', async () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6.2-sol']) {
    const requestContext: Context = {
      messages: [
        firstUser,
        {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: id,
          content: [
            {
              type: 'toolCall',
              id: 'call_1|fc_1',
              name: 'read',
              arguments: { path: 'README.md' },
            },
          ],
          stopReason: 'toolUse',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { ...model.cost, total: 0 },
          },
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call_1|fc_1',
          toolName: 'read',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 3,
        },
      ],
    }
    const replayed = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"README.md"}',
    }
    let sdkInput: readonly unknown[] = []
    let sdkInputBytes = ''
    const sent = await httpBody(
      {
        onPayload(raw) {
          const { instructions: _instructions, ...body } = raw as {
            instructions?: string
            input: unknown[]
          }
          sdkInput = body.input
          expect(sdkInput[1]).toEqual(replayed)
          body.input = [
            ...sdkInput,
            { ...replayed, id: 'fc_explicit', status: 'incomplete' },
          ]
          sdkInputBytes = JSON.stringify(body.input)
          return body
        },
      },
      { ...model, id },
      requestContext,
    )
    if (id === 'gpt-6.1-sol')
      expect(JSON.stringify(sent.input)).toBe(sdkInputBytes)
    else {
      expect(JSON.stringify(sent.input)).toBe(
        JSON.stringify([
          sdkInput[0],
          { ...replayed, status: 'completed' },
          sdkInput[2],
          { ...replayed, id: 'fc_explicit', status: 'incomplete' },
        ]),
      )
      expect(sdkInput[1]).toEqual(replayed)
    }
  }
})

test('Codex HTTP sends system instructions as the leading developer message', async () => {
  const body = await httpBody({ sessionId })
  expect(body.prompt_cache_key).toBe(sessionId)
  expect(body).not.toHaveProperty('instructions')
  expect(body.input).toEqual([
    developerMessage(systemPrompt, systemId),
    {
      role: 'user',
      content: [{ type: 'input_text', text: firstUser.content }],
    },
  ])
})

test('Pi pins gpt-6.2-sol HTTP effort and replays each update at its original user message', async () => {
  const helper = (reasoning: 'high' | 'medium') =>
    httpBody({ sessionId, reasoning, cacheRetention: 'none' }, effortModel)
  await helper('high')
  const opening = await httpBody({ sessionId, reasoning: 'low' }, effortModel)
  const summary = await helper('medium')
  const changed = await httpBody(
    { sessionId, reasoning: 'high' },
    effortModel,
    {
      systemPrompt,
      messages: [firstUser, secondUser],
    },
  )
  const next = await httpBody({ sessionId, reasoning: 'low' }, effortModel, {
    systemPrompt,
    messages: [firstUser, secondUser, thirdUser],
  })
  expect([opening, changed, next].map((body) => body.reasoning)).toEqual([
    { effort: 'low', summary: 'auto' },
    { effort: 'low', summary: 'auto' },
    { effort: 'low', summary: 'auto' },
  ])
  const openingInput = opening.input as unknown[]
  const changedInput = changed.input as unknown[]
  const nextInput = next.input as unknown[]
  expect(JSON.stringify(changedInput.slice(0, -2))).toBe(
    JSON.stringify(openingInput),
  )
  expect(changedInput.slice(-2)).toEqual([
    effortUpdate('high'),
    userItem(secondUser.content),
  ])
  expect(JSON.stringify(nextInput.slice(0, -2))).toBe(
    JSON.stringify(changedInput),
  )
  expect(nextInput.slice(-2)).toEqual([
    effortUpdate('low'),
    userItem(thirdUser.content),
  ])
  expect(summary).not.toHaveProperty('prompt_cache_key')
  expect(summary.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
  expect(summary.input).toEqual([
    developerMessage(systemPrompt),
    userItem(firstUser.content),
  ])
})

test('Codex HTTP omits the base instructions id without a Pi session id', async () => {
  const body = await httpBody()
  expect(body).not.toHaveProperty('prompt_cache_key')
  expect(body).not.toHaveProperty('instructions')
  expect(body.input).toEqual([
    developerMessage(systemPrompt),
    {
      role: 'user',
      content: [{ type: 'input_text', text: firstUser.content }],
    },
  ])
})

test('Codex transforms an awaited onPayload replacement after leading additional tools', async () => {
  const additionalTools = {
    type: 'additional_tools',
    role: 'developer',
    tools: [],
  }
  const body = await httpBody({
    sessionId,
    async onPayload(raw, receivedModel) {
      await Promise.resolve()
      expect(receivedModel.id).toBe(model.id)
      const original = raw as { instructions: string; input: unknown[] }
      expect(original.instructions).toBe(systemPrompt)
      return {
        ...original,
        instructions: 'Replacement prompt.',
        input: [additionalTools, ...original.input],
        metadata: { caller: 'replacement' },
      }
    },
  })
  expect(body).not.toHaveProperty('instructions')
  expect(body.metadata).toEqual({ caller: 'replacement' })
  expect(body.input).toEqual([
    additionalTools,
    developerMessage(
      'Replacement prompt.',
      'msg_863029c1-4b0c-5d97-a1b6-4156e117721d',
    ),
    {
      role: 'user',
      content: [{ type: 'input_text', text: firstUser.content }],
    },
  ])
})

test('Codex transforms in-place onPayload edits without mutating the SDK body', async () => {
  let sdkBody: Record<string, unknown> | undefined
  const body = await httpBody({
    sessionId,
    async onPayload(raw) {
      await Promise.resolve()
      sdkBody = raw as Record<string, unknown>
      expect(sdkBody.instructions).toBe(systemPrompt)
      sdkBody.instructions = 'Edited prompt.'
      sdkBody.metadata = { caller: 'in-place' }
    },
  })
  expect(body).not.toHaveProperty('instructions')
  expect(body.metadata).toEqual({ caller: 'in-place' })
  expect(body.input).toEqual([
    developerMessage(
      'Edited prompt.',
      'msg_b2c7bd31-aeb8-5ffc-93d2-37be42031b32',
    ),
    {
      role: 'user',
      content: [{ type: 'input_text', text: firstUser.content }],
    },
  ])
  expect(sdkBody?.instructions).toBe('Edited prompt.')
  expect(sdkBody?.input).toHaveLength(1)
})

function spyOnRawCodexFrames() {
  const frames: string[] = []
  const rawSend = RawWebSocket.prototype.send
  const seam = spyOn(RawWebSocket.prototype, 'send').mockImplementation(
    function (this: RawWebSocket, data: string) {
      expect(globalThis.WebSocket.name).toBe('PiRawCodexWebSocket')
      expect(this).toBeInstanceOf(globalThis.WebSocket)
      frames.push(data)
      rawSend.call(this, data)
    },
  )
  return { frames, restore: () => seam.mockRestore() }
}

async function captureWebSocketFrames(
  run: (url: string) => Promise<void>,
  events: (turn: number) => unknown[] | undefined = responseEvents,
) {
  const frames: Record<string, unknown>[] = []
  const wireFrames: string[] = []
  const upgrades: Headers[] = []
  let connections = 0
  const seam = spyOnRawCodexFrames()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const headers = new Headers(request.headers)
      if (server.upgrade(request)) {
        upgrades.push(headers)
        return
      }
      return new Response(null, { status: 400 })
    },
    websocket: {
      open() {
        connections++
      },
      message(socket, frame) {
        wireFrames.push(frame.toString())
        frames.push(JSON.parse(frame.toString()))
        const reply = events(frames.length)
        for (const event of reply ?? []) socket.send(JSON.stringify(event))
      },
    },
  })
  try {
    await run(server.url.href)
    expect(wireFrames).toEqual(seam.frames)
    return { frames, connections, upgrades }
  } finally {
    seam.restore()
    await server.stop(true)
  }
}

function applicationUpgradeHeaders(upgrade: Headers) {
  const application = new Headers(upgrade)
  for (const name of [
    'connection',
    'host',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
  ])
    application.delete(name)
  return normalizeUserAgent(application)
}

function frameMetadata(frame: Record<string, unknown> | undefined) {
  return frame?.client_metadata as Record<string, string> | undefined
}

test('Pi sends helper WebSocket frames without cache or turn metadata', async () => {
  const { frames, upgrades } = await captureWebSocketFrames(async (baseUrl) => {
    const result = await runtime
      .stream(
        { ...model, baseUrl },
        { ...context, tools: [readTool] },
        {
          ...cachedWebSocketOptions(),
          cacheRetention: 'none',
        },
      )
      .result()
    expect(result.responseId).toBe('resp_1')
  })
  expect(upgrades.map(applicationUpgradeHeaders)).toEqual([
    {
      ...clientAndAccountHeaders,
      'openai-beta': 'responses_websockets=2026-02-06',
    },
  ])
  expect(frames).toHaveLength(1)
  expect(frames[0]).not.toHaveProperty('prompt_cache_key')
  expect(frames[0]).not.toHaveProperty('client_metadata')
  expect(frames[0]).not.toHaveProperty('instructions')
  expect(frames[0]?.input).toEqual([
    developerMessage(systemPrompt),
    userItem('Name a colour.'),
  ])
  expect(frames[0]?.tools).toEqual([expectedReadTool])
})

test('Pi keeps the turn when a chained WebSocket send falls back to full HTTP', async () => {
  const fallbackSession = 'pi-codex-fallback-wire'
  const http: { headers: Headers; body: Record<string, unknown> }[] = []
  const { frames, connections } = await captureWebSocketFrames(
    async (baseUrl) => {
      const socketModel = { ...model, baseUrl }
      const options: SimpleStreamOptions = {
        apiKey,
        transport: 'auto',
        sessionId: fallbackSession,
        // The server withholds all events for the delta, so pi-ai uses SSE.
        timeoutMs: 500,
        fetch: mockFetch(async (_input, init) => {
          http.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(await new Response(init?.body).text()),
          })
          return sseResponse(2)
        }),
      }
      const first = await runtime.stream(socketModel, context, options).result()
      expect(first.responseId).toBe('resp_1')
      const second = await runtime
        .stream(
          socketModel,
          {
            systemPrompt,
            messages: [firstUser, first, secondUser],
          },
          options,
        )
        .result()
      expect(second.responseId).toBe('resp_2')
    },
    (turn) => (turn === 1 ? responseEvents(1) : undefined),
  )

  expect(connections).toBe(1)
  expect(frames).toHaveLength(2)
  const delta = frames[1]
  expect(delta?.previous_response_id).toBe('resp_1')
  expect(delta?.input).toEqual([userItem('Name another.')])
  expect(http).toHaveLength(1)
  const fallback = http[0]
  expect(fallback?.body).not.toHaveProperty('previous_response_id')
  expect(fallback?.body.prompt_cache_key).toBe(fallbackSession)
  const fullInput = fallback?.body.input as Record<string, unknown>[]
  expect(fullInput.map((item) => item.role)).toEqual([
    'developer',
    'user',
    'assistant',
    'user',
  ])
  expect(fullInput.at(-1)).toEqual(userItem('Name another.'))
  const turn = frameMetadata(delta)?.['x-codex-turn-metadata']
  expect(JSON.parse(turn ?? 'null')?.turn_id).toBe(
    '00000000-0000-7000-8000-000000000002',
  )
  expect(fallback?.headers.get('x-codex-turn-metadata')).toBe(turn)
})

test('Pi does not complete a newer turn when a superseded attempt succeeds late', async () => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const releaseOlder = Promise.withResolvers<void>()
  const rejectNewer = Promise.withResolvers<void>()
  const sentTurns: unknown[] = []
  const options: SimpleStreamOptions = {
    apiKey,
    sessionId: 'pi-codex-overlapping-attempts',
    transport: 'sse',
    maxRetries: 0,
    fetch: mockFetch(async (_input, init) => {
      const i = sentTurns.length
      const turn = new Headers(init?.headers).get('x-codex-turn-metadata')
      sentTurns.push(JSON.parse(turn ?? 'null')?.turn_id)
      entered[i]?.resolve()
      if (i === 0) await releaseOlder.promise
      if (i === 1) {
        await rejectNewer.promise
        return new Response('{"error":{"message":"Rejected fixture send"}}', {
          status: 400,
        })
      }
      return sseResponse(i + 1)
    }),
  }
  const nextContext = { systemPrompt, messages: [firstUser, secondUser] }
  try {
    const older = runtime.stream(model, context, options)
    await entered[0]?.promise
    const newer = runtime.stream(model, nextContext, options)
    await entered[1]?.promise
    releaseOlder.resolve()
    expect((await older.result()).responseId).toBe('resp_1')
    rejectNewer.resolve()
    expect((await newer.result()).stopReason).toBe('error')
    expect(
      (await runtime.stream(model, nextContext, options).result()).responseId,
    ).toBe('resp_3')
    const secondTurnID = '00000000-0000-7000-8000-000000000002'
    expect(sentTurns).toEqual([firstTurnID, secondTurnID, secondTurnID])
  } finally {
    releaseOlder.resolve()
    rejectNewer.resolve()
  }
})

test('Codex cached WebSocket sends the developer message once and only new input on turn two', async () => {
  const { frames, connections } = await captureWebSocketFrames(
    async (baseUrl) => {
      const socketModel = { ...model, baseUrl }
      const options: SimpleStreamOptions = {
        apiKey,
        transport: 'websocket-cached',
        sessionId,
        fetch: mockFetch(async () => {
          throw new Error('Expected to send over the WebSocket')
        }),
      }
      const first = await runtime.stream(socketModel, context, options).result()
      expect(first.errorMessage).toBeUndefined()
      expect(first.responseId).toBe('resp_1')
      const second = await runtime
        .stream(
          socketModel,
          {
            systemPrompt,
            messages: [firstUser, first, secondUser],
          },
          options,
        )
        .result()
      expect(second.errorMessage).toBeUndefined()
      expect(second.responseId).toBe('resp_2')
    },
  )

  expect(connections).toBe(1)
  expect(frames).toHaveLength(2)
  const [full, delta] = frames
  expect(full?.type).toBe('response.create')
  expect(full?.prompt_cache_key).toBe(sessionId)
  expect(full).not.toHaveProperty('instructions')
  expect(full).not.toHaveProperty('previous_response_id')
  expect(full?.input).toEqual([
    developerMessage(systemPrompt, systemId),
    {
      role: 'user',
      content: [{ type: 'input_text', text: firstUser.content }],
    },
  ])
  expect(delta?.type).toBe('response.create')
  expect(delta?.prompt_cache_key).toBe(sessionId)
  expect(delta).not.toHaveProperty('instructions')
  expect(delta?.previous_response_id).toBe('resp_1')
  expect(delta?.input).toEqual([
    {
      role: 'user',
      content: [{ type: 'input_text', text: secondUser.content }],
    },
  ])
})

test('Pi keeps gpt-6.2-sol WebSocket turns chained after injecting an effort update', async () => {
  const payloads: unknown[][] = []
  const { frames, connections } = await captureWebSocketFrames(
    async (baseUrl) => {
      const socketModel = { ...effortModel, baseUrl }
      const options: SimpleStreamOptions = {
        apiKey,
        transport: 'websocket-cached',
        sessionId,
        fetch: mockFetch(async () => {
          throw new Error('Expected to send over the WebSocket')
        }),
        onPayload(raw) {
          payloads.push((raw as { input: unknown[] }).input)
        },
      }
      const messages = [firstUser, secondUser, thirdUser]
      const history: Context['messages'] = []
      for (const [i, message] of messages.entries()) {
        history.push(message)
        const result = await runtime
          .stream(
            socketModel,
            { systemPrompt, messages: [...history] },
            {
              ...options,
              reasoning: i === 0 ? 'low' : 'high',
            },
          )
          .result()
        expect(result.errorMessage).toBeUndefined()
        expect(result.responseId).toBe(`resp_${i + 1}`)
        history.push(result)
      }
    },
  )

  expect(connections).toBe(1)
  expect(frames.map((frame) => frame.previous_response_id)).toEqual([
    undefined,
    'resp_1',
    'resp_2',
  ])
  expect(frames.map((frame) => frame.reasoning)).toEqual(
    Array(3).fill({ effort: 'low', summary: 'auto' }),
  )
  expect(frames.map((frame) => frame.input)).toEqual([
    [developerMessage(systemPrompt, systemId), userItem(firstUser.content)],
    [effortUpdate('high'), userItem(secondUser.content)],
    [userItem(thirdUser.content)],
  ])
  expect(payloads.map((input) => input.length)).toEqual([1, 3, 5])
})

function cachedWebSocketOptions(): SimpleStreamOptions {
  return {
    apiKey,
    transport: 'websocket-cached',
    sessionId,
    fetch: mockFetch(async () => {
      throw new Error('Expected to send over the WebSocket')
    }),
  }
}

const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

test('Pi chains GPT-6.2 after a completed call and restores statuses on full WebSocket sends', async () => {
  const toolOutput = (id: string): Context['messages'][number] => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text: 'Read result.' }],
    isError: false,
    timestamp: 3,
  })
  const { frames, connections, upgrades } = await captureWebSocketFrames(
    async (baseUrl) => {
      const socketModel = { ...effortModel, baseUrl }
      const seed: Context['messages'][number] = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: socketModel.id,
        content: [
          {
            type: 'toolCall',
            id: 'call_seed|fc_seed',
            name: 'read',
            arguments: { path: 'seed' },
          },
          {
            type: 'toolCall',
            id: 'call_explicit|fc_explicit',
            name: 'read',
            arguments: { path: 'explicit' },
          },
        ],
        stopReason: 'toolUse',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { ...model.cost, total: 0 },
        },
        timestamp: 2,
      }
      const history: Context['messages'] = [
        firstUser,
        seed,
        toolOutput('call_seed|fc_seed'),
        toolOutput('call_explicit|fc_explicit'),
      ]
      const options: SimpleStreamOptions = {
        ...cachedWebSocketOptions(),
        onPayload(raw) {
          const body = raw as { input: Record<string, unknown>[] }
          const explicit = body.input.find((item) => item.id === 'fc_explicit')
          if (!explicit) throw new Error('Missing explicit-status fixture')
          explicit.status = 'incomplete'
        },
      }
      const send = () =>
        runtime
          .stream(
            socketModel,
            {
              systemPrompt,
              messages: [...history],
              tools: [readTool],
            },
            options,
          )
          .result()

      const first = await send()
      expect(first.stopReason).toBe('toolUse')
      expect(first.content).toEqual([
        {
          type: 'toolCall',
          id: 'call_1|fc_1',
          name: 'read',
          arguments: { path: 'README.md' },
        },
      ])
      history.push(first, toolOutput('call_1|fc_1'))
      const second = await send()
      expect(second.responseId).toBe('resp_2')
      history.push(second, thirdUser)
      const third = await send()
      expect(third.responseId).toBe('resp_3')
      closeOpenAICodexWebSocketSessions(sessionId)
      const resend = await send()
      expect(resend.responseId).toBe('resp_4')
    },
    (turn) => responseEvents(turn, turn === 1),
  )
  expect(connections).toBe(2)
  expect(frames.map((frame) => frame.previous_response_id)).toEqual([
    undefined,
    'resp_1',
    'resp_2',
    undefined,
  ])
  const upgrade = {
    ...clientAndAccountHeaders,
    'openai-beta': 'responses_websockets=2026-02-06',
    ...primaryIdentityHeaders,
  }
  expect(upgrades.map(applicationUpgradeHeaders)).toEqual([upgrade, upgrade])
  expect(frames.slice(0, 3).map(frameMetadata)).toEqual(
    [firstTurnID, firstTurnID, '00000000-0000-7000-8000-000000000002'].map(
      (id) => ({
        'x-codex-installation-id': '00000000-0000-4000-8000-000000000100',
        'x-codex-window-id': 'pi-codex-payload-session:0',
        'x-codex-turn-metadata': JSON.stringify(expectedTurn(id)),
        'x-codex-ws-stream-request-start-ms': '1800000000000',
      }),
    ),
  )
  for (const frame of frames) expect(frame).not.toHaveProperty('instructions')
  const [full, toolDelta, userDelta, resend] = frames.map(
    (frame) => frame.input as Record<string, unknown>[],
  )
  expect(toolDelta).toEqual([
    { type: 'function_call_output', call_id: 'call_1', output: 'Read result.' },
  ])
  expect(userDelta).toEqual([userItem(thirdUser.content)])
  for (const input of [full!, resend!]) {
    expect(input[0]).toEqual(developerMessage(systemPrompt, systemId))
    expect(input.filter((item) => item.role === 'developer')).toEqual([
      developerMessage(systemPrompt, systemId),
    ])
  }
  const callStatuses = (input: Record<string, unknown>[]) =>
    input
      .filter((item) => item.type === 'function_call')
      .map(({ id, status }) => [id, status])
  expect(callStatuses(full!)).toEqual([
    ['fc_seed', 'completed'],
    ['fc_explicit', 'incomplete'],
  ])
  expect(callStatuses(resend!)).toEqual([
    ['fc_seed', 'completed'],
    ['fc_explicit', 'incomplete'],
    ['fc_1', 'completed'],
  ])
})

test.each(['prefix', 'tools', 'instructions'] as const)(
  'Pi sends the full WebSocket request if %s changed',
  async (change) => {
    const { frames, connections } = await captureWebSocketFrames(
      async (baseUrl) => {
        const socketModel = { ...model, baseUrl }
        const options = cachedWebSocketOptions()
        const first = await runtime
          .stream(socketModel, context, options)
          .result()
        expect(first.responseId).toBe('resp_1')
        const next = await runtime
          .stream(
            socketModel,
            {
              systemPrompt:
                change === 'instructions'
                  ? 'A replacement prompt.'
                  : systemPrompt,
              messages: [
                change === 'prefix'
                  ? { ...firstUser, content: 'Edited user message' }
                  : firstUser,
                first,
                secondUser,
              ],
              ...(change === 'tools' ? { tools: [readTool] } : {}),
            },
            options,
          )
          .result()
        expect(next.responseId).toBe('resp_2')
      },
    )
    expect(connections).toBe(1)
    expect(frames).toHaveLength(2)
    expect(frames[1]).not.toHaveProperty('previous_response_id')
    expect(frames[1]).not.toHaveProperty('instructions')
    expect(frames[1]?.input).toMatchObject([
      {
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text:
              change === 'instructions'
                ? 'A replacement prompt.'
                : systemPrompt,
          },
        ],
      },
      userItem(change === 'prefix' ? 'Edited user message' : firstUser.content),
      { role: 'assistant' },
      userItem(secondUser.content),
    ])
    if (change === 'tools')
      expect(frames[1]?.tools).toMatchObject([{ name: 'read' }])
  },
)

test.each([
  [
    'Pi stays on WebSocket when the bearer rotates for the same account and session',
    'idle',
  ],
  [
    'Pi opens a separate WebSocket after bearer rotation while the cached socket is busy',
    'busy',
  ],
  [
    'Pi replaces the old WebSocket if it goes idle while the new payload is prepared',
    'payload',
  ],
] as const)('%s', async (_title, rotation) => {
  const seam = spyOnRawCodexFrames()
  const oldSocketClosed = Promise.withResolvers<void>()
  const releaseOpening = Promise.withResolvers<() => void>()
  let oldWasClosed = false
  const upgrades: (string | null)[] = []
  const wire: { socket: number; data: string }[] = []
  const server = Bun.serve<number>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const authorization = request.headers.get('authorization')
      if (server.upgrade(request, { data: upgrades.length })) {
        upgrades.push(authorization)
        return
      }
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(socket, frame) {
        wire.push({ socket: socket.data, data: frame.toString() })
        const events = responseEvents(wire.length)
        const send = (events: unknown[]) => {
          for (const event of events) socket.send(JSON.stringify(event))
        }
        if (wire.length === 1 && rotation !== 'idle') {
          send(events.slice(0, 2))
          releaseOpening.resolve(() => send(events.slice(2)))
        } else send(events)
      },
      close(socket) {
        if (socket.data === 0) {
          oldWasClosed = true
          oldSocketClosed.resolve()
        }
      },
    },
  })
  try {
    const socketModel = { ...model, baseUrl: server.url.href }
    const rotated = chatgptAccessToken('payload-test-account', 'refreshed')
    const socketSessionId = `${sessionId}-rotated-${rotation}`
    const options = {
      ...cachedWebSocketOptions(),
      sessionId: socketSessionId,
      maxRetries: 0,
      fetch: mockFetch(async () => {
        throw new Error('Unexpected HTTP fallback after bearer rotation')
      }),
    }
    const start = (
      messages: Context['messages'],
      token: string,
      onPayload?: SimpleStreamOptions['onPayload'],
    ) =>
      runtime.stream(
        socketModel,
        { systemPrompt, messages },
        { ...options, apiKey: token, onPayload },
      )

    const opening = start([firstUser], apiKey)
    let secondMessages: Context['messages']
    if (rotation === 'idle') {
      const first = await opening.result()
      expect(first.responseId).toBe('resp_1')
      secondMessages = [firstUser, first, secondUser]
    } else {
      for await (const event of opening) {
        if (event.type === 'error' || event.type === 'done')
          throw new Error('Opening turn did not stay active')
        if (event.type === 'text_delta') break
      }
      secondMessages = [firstUser, secondUser]
    }
    const finishOpening = async () => {
      ;(await releaseOpening.promise)()
      expect((await opening.result()).responseId).toBe('resp_1')
    }
    const second = await start(
      secondMessages,
      rotated,
      rotation === 'payload' ? finishOpening : undefined,
    ).result()
    expect(second.errorMessage).toBeUndefined()
    expect(second.responseId).toBe('resp_2')
    if (rotation === 'busy') {
      expect(oldWasClosed).toBe(false)
      await finishOpening()
    } else await oldSocketClosed.promise
    const third = await start(
      [...secondMessages, second, thirdUser],
      rotated,
    ).result()
    expect(third.responseId).toBe('resp_3')
    await oldSocketClosed.promise

    expect(upgrades).toEqual([
      `Bearer ${apiKey}`,
      `Bearer ${rotated}`,
      ...(rotation === 'busy' ? [`Bearer ${rotated}`] : []),
    ])
    expect(wire.map(({ socket }) => socket)).toEqual([
      0,
      1,
      rotation === 'busy' ? 2 : 1,
    ])
    expect(wire.map(({ data }) => data)).toEqual(seam.frames)
    const frames = wire.map(({ data }) => JSON.parse(data))
    expect(frames.map((frame) => frame.previous_response_id)).toEqual([
      undefined,
      undefined,
      rotation === 'busy' ? undefined : 'resp_2',
    ])
    expect(frames[1].input[0]).toMatchObject({ role: 'developer' })
  } finally {
    seam.restore()
    closeOpenAICodexWebSocketSessions(`${sessionId}-rotated-${rotation}`)
    await server.stop(true)
  }
})

function rateLimitsFrame(usedPercent: number) {
  return {
    type: 'codex.rate_limits',
    rate_limits: {
      primary: { used_percent: usedPercent, window_minutes: 300 },
    },
  }
}

test('Pi binds overlapping Codex sockets by attempt, URL and bearer and leaves foreign sockets untouched', async () => {
  const other = makeRuntime(join(dir, 'other'))
  const original = globalThis.WebSocket
  const seam = spyOnRawCodexFrames()
  const firstObserver = spyOn(runtime, 'observeWebSocketMessage')
  const otherObserver = spyOn(other, 'observeWebSocketMessage')
  const seen: {
    label: string
    path: string
    authorization: string | null
    data: string
  }[] = []
  const quota = {
    priming: 11,
    first: 21,
    other: 37,
    'foreign-bearer': 82,
    'foreign-path': 93,
  }
  type Label = keyof typeof quota
  const server = Bun.serve<{
    label: Label
    path: string
    authorization: string | null
  }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const label = request.headers.get('x-fixture-socket') as Label
      const path = new URL(request.url).pathname
      const authorization = request.headers.get('authorization')
      if (server.upgrade(request, { data: { label, path, authorization } }))
        return
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(socket, frame) {
        const { label } = socket.data
        seen.push({ ...socket.data, data: frame.toString() })
        socket.send(JSON.stringify(rateLimitsFrame(quota[label])))
        if (label === 'first' || label === 'other' || label === 'priming') {
          const turn = label === 'first' ? 1 : label === 'other' ? 2 : 0
          for (const event of responseEvents(turn))
            socket.send(JSON.stringify(event))
        }
      },
    },
  })
  const codexPath = '/codex/responses'
  const socketModel = { ...model, baseUrl: server.url.href }
  const otherToken = chatgptAccessToken('other-payload-test-account')
  const foreignBody = JSON.stringify({
    type: 'response.create',
    model: 'gpt-6.2',
    instructions: 'Foreign bytes',
    input: [],
  })
  const foreignSockets: { native: boolean; url: string; response: string }[] =
    []
  const awaitingOther = Promise.withResolvers<void>()
  const foreignDone = Promise.withResolvers<void>()
  async function sendForeign(label: Label, path: string, token: string) {
    const url = new URL(path, server.url)
    url.protocol = 'ws:'
    const socket = Reflect.construct(globalThis.WebSocket, [
      url,
      {
        headers: {
          'x-fixture-socket': label,
          authorization: `Bearer ${token}`,
        },
      },
    ]) as WebSocket
    try {
      const response = await new Promise<string>((resolve, reject) => {
        socket.addEventListener('open', () => socket.send(foreignBody))
        socket.addEventListener('message', (event) => resolve(event.data))
        socket.addEventListener('error', () =>
          reject(new Error('Foreign socket failed')),
        )
      })
      foreignSockets.push({
        native: socket instanceof original,
        url: socket.url,
        response,
      })
    } finally {
      socket.close()
    }
  }
  try {
    const options = cachedWebSocketOptions()
    // An unrelated SDK call can cache Bun's constructor while no shim is installed.
    const priming = await streamSimple(socketModel, context, {
      ...options,
      cacheRetention: 'none',
      headers: { 'x-fixture-socket': 'priming' },
    }).result()
    expect(priming.responseId).toBe('resp_0')
    expect(seam.frames).toEqual([])
    const first = runtime.stream(socketModel, context, {
      ...options,
      headers: { 'x-fixture-socket': 'first' },
      async onPayload() {
        await awaitingOther.promise
        try {
          await sendForeign('foreign-bearer', codexPath, 'foreign-token')
          await sendForeign('foreign-path', '/sentinel', apiKey)
        } finally {
          foreignDone.resolve()
        }
      },
    })
    const second = other.stream(socketModel, context, {
      ...options,
      sessionId: `${sessionId}-other`,
      apiKey: otherToken,
      headers: { 'x-fixture-socket': 'other' },
      async onPayload() {
        awaitingOther.resolve()
        await foreignDone.promise
      },
    })
    expect(
      (await Promise.all([first.result(), second.result()])).map(
        (result) => result.responseId,
      ),
    ).toEqual(['resp_1', 'resp_2'])

    const owned = seen.filter(
      ({ label }) => label === 'first' || label === 'other',
    )
    expect(owned.map(({ data }) => data).sort()).toEqual(
      [...seam.frames].sort(),
    )
    expect(
      owned
        .map(({ label, path, authorization, data }) => [
          label,
          path,
          authorization,
          JSON.parse(data).prompt_cache_key,
        ])
        .sort(),
    ).toEqual([
      ['first', codexPath, `Bearer ${apiKey}`, sessionId],
      ['other', codexPath, `Bearer ${otherToken}`, `${sessionId}-other`],
    ])
    const observedLimits = (observer: typeof firstObserver) =>
      observer.mock.calls
        .map(([{ token }, data]) => [token, JSON.parse(data)] as const)
        .filter(([, frame]) => frame.type === 'codex.rate_limits')
    expect(observedLimits(firstObserver)).toEqual([
      [apiKey, rateLimitsFrame(21)],
    ])
    expect(observedLimits(otherObserver)).toEqual([
      [otherToken, rateLimitsFrame(37)],
    ])
    expect(seen.filter(({ label }) => label.startsWith('foreign-'))).toEqual([
      {
        label: 'foreign-bearer',
        path: codexPath,
        authorization: 'Bearer foreign-token',
        data: foreignBody,
      },
      {
        label: 'foreign-path',
        path: '/sentinel',
        authorization: `Bearer ${apiKey}`,
        data: foreignBody,
      },
    ])
    const wsOrigin = server.url.origin.replace(/^http:/, 'ws:')
    expect(foreignSockets).toEqual([
      {
        native: true,
        url: `${wsOrigin}${codexPath}`,
        response: JSON.stringify(rateLimitsFrame(82)),
      },
      {
        native: true,
        url: `${wsOrigin}/sentinel`,
        response: JSON.stringify(rateLimitsFrame(93)),
      },
    ])
  } finally {
    firstObserver.mockRestore()
    otherObserver.mockRestore()
    seam.restore()
    closeOpenAICodexWebSocketSessions(sessionId)
    closeOpenAICodexWebSocketSessions(`${sessionId}-other`)
    await Promise.all([
      server.stop(true),
      other.pool.dispose(),
      other.vault.dispose(),
    ])
  }
})
