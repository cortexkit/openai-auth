import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { chatgptAccessToken } from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { installRawCodexWebSocket } from '../index.ts'
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

function responseEvents(turn: number) {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-codex-payload-'))
  runtime = new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    installWebSocket: installRawCodexWebSocket,
    paths: () => ({
      configPath: join(dir, 'openai-auth.json'),
      statePath: join(dir, 'openai-auth-state.json'),
    }),
    fetchImpl: mockFetch(async () =>
      Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18_000,
            reset_at: Math.floor(Date.now() / 1000) + 7200,
          },
        },
      }),
    ),
  })
})

afterEach(async () => {
  await Promise.all([runtime.pool.dispose(), runtime.vault.dispose()])
  rmSync(dir, { recursive: true, force: true })
})

async function httpBody(
  options?: Pick<
    SimpleStreamOptions,
    'cacheRetention' | 'onPayload' | 'reasoning' | 'sessionId'
  >,
  requestModel = model,
  requestContext = context,
) {
  const bodies: Record<string, unknown>[] = []
  const result = await runtime
    .stream(requestModel, requestContext, {
      apiKey,
      transport: 'sse',
      ...options,
      fetch: mockFetch(async (_input, init) => {
        const payload = new Response(init?.body)
        const encoded = new Headers(init?.headers).get('content-encoding')
        const json =
          encoded === 'zstd'
            ? new TextDecoder().decode(
                Bun.zstdDecompressSync(await payload.arrayBuffer()),
              )
            : await payload.text()
        bodies.push(JSON.parse(json))
        return new Response(
          responseEvents(1)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      }),
    })
    .result()
  expect(result.errorMessage).toBeUndefined()
  expect(result.stopReason).toBe('stop')
  expect(bodies).toHaveLength(1)
  const [body] = bodies
  if (!body) throw new Error('No captured HTTP body')
  return body
}

test('Pi restores GPT-6.2 replayed call status without instructions and keeps GPT-6.1 bytes', async () => {
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
    let sdkBytes = ''
    const sent = await httpBody(
      {
        onPayload(raw) {
          const { instructions: _instructions, ...body } = raw as {
            instructions?: string
            input: unknown[]
          }
          sdkInput = body.input
          expect(sdkInput[1]).toEqual(replayed)
          sdkBytes = JSON.stringify(body)
          return body
        },
      },
      { ...model, id },
      requestContext,
    )
    if (id === 'gpt-6.1-sol') expect(JSON.stringify(sent)).toBe(sdkBytes)
    else {
      expect(JSON.stringify(sent.input)).toBe(
        JSON.stringify([
          sdkInput[0],
          { ...replayed, status: 'completed' },
          sdkInput[2],
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

async function captureWebSocketFrames(run: (url: string) => Promise<void>) {
  const frames: Record<string, unknown>[] = []
  let connections = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      open() {
        connections++
      },
      message(socket, frame) {
        frames.push(JSON.parse(frame.toString()))
        for (const event of responseEvents(frames.length))
          socket.send(JSON.stringify(event))
      },
    },
  })
  try {
    await run(server.url.href)
    return { frames, connections }
  } finally {
    await server.stop(true)
  }
}

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
