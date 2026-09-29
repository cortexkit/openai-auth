import { describe, expect, test } from 'bun:test'
// The real Responses stream parser. The devDependency is pinned to the exact
// @ai-sdk/openai version OpenCode 1.18.30 ships (3.0.88): what these tests
// prove is how that parser reads our SSE, so the pin must track the host, not
// the newest release.
import { createOpenAI } from '@ai-sdk/openai'
import { ResponseStreamError } from '../response-stream-error'
import { streamResponsesWebSocket, TERMINAL_AFTER_OUTPUT_MESSAGE } from '../ws'

type Part = { type: string } & Record<string, unknown>
type Frame = Record<string, unknown>

// A socket the test drives by hand. `write` delivers one frame to the
// transport's message handler; `close` delivers a close event, as the Codex
// backend does with 1012 when it restarts.
function fakeSocket() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const emit = (type: string, event: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
  }
  return {
    url: 'wss://chatgpt.com/backend-api/codex/responses',
    readyState: 1,
    addEventListener(type: string, fn: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
    send(_data: string) {},
    close() {},
    write(frame: Frame) {
      emit('message', { data: JSON.stringify(frame) })
    },
    peerClose(code: number, reason: string) {
      emit('close', { code, reason })
    },
  }
}

const created: Frame = {
  type: 'response.created',
  response: { id: 'resp_1', created_at: 1, model: 'gpt-5.5' },
}

function callAdded(n: number): Frame {
  return {
    type: 'response.output_item.added',
    output_index: n,
    item: {
      type: 'function_call',
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: 'read',
      arguments: '',
    },
  }
}

function callDelta(n: number, delta: string): Frame {
  return {
    type: 'response.function_call_arguments.delta',
    item_id: `fc_${n}`,
    output_index: n,
    delta,
  }
}

function callArgsDone(n: number, args: string): Frame {
  return {
    type: 'response.function_call_arguments.done',
    item_id: `fc_${n}`,
    output_index: n,
    arguments: args,
  }
}

function callDone(n: number, args: string): Frame {
  return {
    type: 'response.output_item.done',
    output_index: n,
    item: {
      type: 'function_call',
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: 'read',
      arguments: args,
      status: 'completed',
    },
  }
}

const rateLimitFailed: Frame = {
  type: 'response.failed',
  response: { id: 'resp_1', failed: { rate_limit_reached_type: 'primary' } },
}

/**
 * Streams `frames` through the WebSocket transport into the real AI SDK
 * parser, reads parts until `readyWhen` has been seen (so the parser has
 * consumed every frame before the failure, as it would have in the host),
 * then applies `failure` and drains the rest.
 */
async function run(options: {
  frames: Frame[]
  readyWhen: (part: Part) => boolean
  failure: (socket: ReturnType<typeof fakeSocket>) => void
}) {
  const socket = fakeSocket()
  const calls = {
    completed: 0,
    terminal: [] as string[],
    invalid: [] as ResponseStreamError[],
    rateLimited: [] as string[],
  }
  const response = streamResponsesWebSocket({
    socket: socket as unknown as WebSocket,
    body: { model: 'gpt-5.5', input: [] },
    onComplete: () => {
      calls.completed++
    },
    onTerminal: (event) => {
      calls.terminal.push(String(event.type))
    },
    onConnectionInvalid: (error) => {
      calls.invalid.push(error)
    },
    onRateLimitReached: (window) => {
      calls.rateLimited.push(window)
    },
  })
  for (const frame of options.frames) socket.write(frame)

  const provider = createOpenAI({
    apiKey: 'test',
    fetch: (async () => response) as unknown as typeof fetch,
  })
  const { stream } = await provider.responses('gpt-5.5').doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [
      {
        type: 'function',
        name: 'read',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ],
  })
  const reader = stream.getReader()
  const parts: Part[] = []
  while (!parts.some(options.readyWhen)) {
    const next = await reader.read()
    if (next.done) throw new Error('stream ended before the expected part')
    parts.push(next.value as Part)
  }
  options.failure(socket)
  let error: unknown
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value as Part)
    }
  } catch (caught) {
    error = caught
  }
  const ofType = (type: string) => parts.filter((part) => part.type === type)
  return { parts, error, calls, ofType }
}

const serviceRestart = (socket: ReturnType<typeof fakeSocket>) =>
  socket.peerClose(1012, 'service restart')
const rateLimit = (socket: ReturnType<typeof fakeSocket>) =>
  socket.write(rateLimitFailed)
const isDeltaFor = (callId: string) => (part: Part) =>
  part.type === 'tool-input-delta' && part.id === callId

describe('websocket failure after function calls only (real AI SDK parser)', () => {
  test('a close while the only call is still streaming fails retryably and runs nothing', async () => {
    const { error, calls, ofType } = await run({
      frames: [created, callAdded(1), callDelta(1, '{"path":')],
      readyWhen: isDeltaFor('call_1'),
      failure: serviceRestart,
    })

    expect(ofType('tool-input-start')).toHaveLength(1)
    expect(ofType('tool-call')).toHaveLength(0)
    expect(ofType('finish')).toHaveLength(0)
    expect(error).toBeInstanceOf(ResponseStreamError)
    expect(error).toMatchObject({ isRetryable: true })
    expect((error as Error).message).not.toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
    expect(calls.completed).toBe(0)
    expect(calls.invalid).toHaveLength(1)
  })

  test('arguments done without the call finishing still counts as unfinished', async () => {
    const { error, ofType } = await run({
      frames: [
        created,
        callAdded(1),
        callDelta(1, '{"path":"a"}'),
        callArgsDone(1, '{"path":"a"}'),
      ],
      readyWhen: isDeltaFor('call_1'),
      failure: serviceRestart,
    })

    expect(ofType('tool-call')).toHaveLength(0)
    expect(error).toBeInstanceOf(ResponseStreamError)
    expect(error).toMatchObject({ isRetryable: true })
  })

  test('a close after one call finished completes with that call and no error', async () => {
    const { error, calls, ofType } = await run({
      frames: [
        created,
        callAdded(1),
        callDelta(1, '{"path":"a"}'),
        callArgsDone(1, '{"path":"a"}'),
        callDone(1, '{"path":"a"}'),
        callAdded(2),
        callDelta(2, '{"pa'),
      ],
      readyWhen: isDeltaFor('call_2'),
      failure: serviceRestart,
    })

    expect(error).toBeUndefined()
    expect(ofType('error')).toHaveLength(0)
    const toolCalls = ofType('tool-call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'read',
      input: '{"path":"a"}',
    })
    const finish = ofType('finish')
    expect(finish).toHaveLength(1)
    expect(finish[0]).toMatchObject({ finishReason: { unified: 'tool-calls' } })
    // The server never completed this response, so nothing may chain to it.
    expect(calls.completed).toBe(0)
    // The dead socket is still reported, which drops any stored continuation.
    expect(calls.invalid).toHaveLength(1)
  })

  test('a close after a message item opened ends the turn without retry', async () => {
    const { error, ofType } = await run({
      frames: [
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_1' },
        },
      ],
      readyWhen: (part) => part.type === 'text-start',
      failure: serviceRestart,
    })

    expect(ofType('finish')).toHaveLength(0)
    expect((error as Error).message).toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
    expect(error).not.toBeInstanceOf(ResponseStreamError)
  })

  test('a close after a finished call and a reasoning item ends the turn without retry', async () => {
    const { error } = await run({
      frames: [
        created,
        callAdded(1),
        callDone(1, '{}'),
        {
          type: 'response.output_item.added',
          output_index: 2,
          item: { type: 'reasoning', id: 'rs_1' },
        },
      ],
      readyWhen: (part) => part.type === 'reasoning-start',
      failure: serviceRestart,
    })

    expect((error as Error).message).toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
  })

  test('an unrecognised frame after an unfinished call ends the turn without retry', async () => {
    // The parser ignores frame types it does not know, so the reader saw
    // nothing from it; the transport still refuses to guess.
    const { error } = await run({
      frames: [
        created,
        callAdded(1),
        callDelta(1, '{'),
        { type: 'response.some_future_frame', output_index: 1 },
      ],
      readyWhen: isDeltaFor('call_1'),
      failure: serviceRestart,
    })

    expect((error as Error).message).toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
  })

  test('arguments for an item never opened as a function call end the turn without retry', async () => {
    const { error } = await run({
      frames: [
        created,
        callAdded(1),
        callDelta(1, '{'),
        { ...callDelta(9, '{'), item_id: 'fc_unknown' },
      ],
      readyWhen: isDeltaFor('call_1'),
      failure: serviceRestart,
    })

    expect((error as Error).message).toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
  })

  test('a call done frame the parser cannot turn into a tool call ends the turn without retry', async () => {
    // Without status "completed" the AI SDK schema drops the done frame, so no
    // tool-call is emitted and a synthetic completion would finish nothing.
    const done = callDone(1, '{}')
    const { error, ofType } = await run({
      frames: [
        created,
        callAdded(1),
        callDelta(1, '{}'),
        { ...done, item: { ...(done.item as Frame), status: 'incomplete' } },
      ],
      readyWhen: isDeltaFor('call_1'),
      failure: serviceRestart,
    })

    expect(ofType('tool-call')).toHaveLength(0)
    expect((error as Error).message).toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
  })
})

describe('mid-stream rate limit after function calls only (real AI SDK parser)', () => {
  test('with only an unfinished call it fails retryably so the turn reroutes', async () => {
    const { error, calls, ofType } = await run({
      frames: [created, callAdded(1), callDelta(1, '{"path":')],
      readyWhen: isDeltaFor('call_1'),
      failure: rateLimit,
    })

    expect(ofType('tool-call')).toHaveLength(0)
    expect(error).toBeInstanceOf(ResponseStreamError)
    expect(error).toMatchObject({ isRetryable: true })
    expect(calls.rateLimited).toEqual(['primary'])
    expect(calls.completed).toBe(0)
  })

  test('after a finished call it completes with that call and no error', async () => {
    const { error, calls, ofType } = await run({
      frames: [
        created,
        callAdded(1),
        callDone(1, '{"path":"a"}'),
        callAdded(2),
        callDelta(2, '{'),
      ],
      readyWhen: isDeltaFor('call_2'),
      failure: rateLimit,
    })

    expect(error).toBeUndefined()
    expect(ofType('error')).toHaveLength(0)
    expect(ofType('tool-call')).toHaveLength(1)
    expect(ofType('tool-call')[0]).toMatchObject({ toolCallId: 'call_1' })
    expect(ofType('finish')[0]).toMatchObject({
      finishReason: { unified: 'tool-calls' },
    })
    expect(calls.rateLimited).toEqual(['primary'])
    expect(calls.completed).toBe(0)
    // Reported as a failed terminal, which drops any stored continuation.
    expect(calls.terminal).toEqual(['response.failed'])
  })

  test('after a message item it ends without a retry and without a tool-calls finish', async () => {
    const { error, ofType } = await run({
      frames: [
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_1' },
        },
      ],
      readyWhen: (part) => part.type === 'text-start',
      failure: rateLimit,
    })

    expect(error).toBeUndefined()
    expect(ofType('finish')[0]).toMatchObject({
      finishReason: { unified: 'other' },
    })
  })
})
