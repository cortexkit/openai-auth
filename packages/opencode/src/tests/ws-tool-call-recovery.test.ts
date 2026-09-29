import { describe, expect, test } from 'bun:test'
// The real Responses stream parser. The devDependency is pinned to the exact
// @ai-sdk/openai version OpenCode 1.18.30 ships (3.0.88): what these tests
// prove is how that parser reads our SSE, so the pin must track the host, not
// the newest release.
import { createOpenAI } from '@ai-sdk/openai'
import { APICallError } from 'ai'
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
    peerError(message: string) {
      emit('error', { message })
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

// A frame the transport forwards but leaves out of its classification (a
// `codex.` envelope type) and the parser yields nothing for. With raw chunks
// on, the parser still reports it as a `raw` part, so seeing it proves every
// frame written before it has been parsed.
const BARRIER_TYPE = 'codex.test_barrier'

/**
 * Streams `frames` through the WebSocket transport into the real AI SDK
 * parser, reads parts until the parser has consumed every one of them (as it
 * would have in the host before the failure), then applies `failure` and
 * drains the rest.
 */
async function run(options: {
  frames: Frame[]
  failure: (socket: ReturnType<typeof fakeSocket>) => void
  idleTimeout?: number
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
    idleTimeout: options.idleTimeout,
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
  socket.write({ type: BARRIER_TYPE })

  const provider = createOpenAI({
    apiKey: 'test',
    fetch: (async () => response) as unknown as typeof fetch,
  })
  const { stream } = await provider.responses('gpt-5.5').doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    includeRawChunks: true,
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
  const isBarrier = (part: Part) =>
    part.type === 'raw' &&
    (part.rawValue as Frame | undefined)?.type === BARRIER_TYPE
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error('stream ended before every frame was parsed')
    const part = next.value as Part
    if (isBarrier(part)) break
    if (part.type !== 'raw') parts.push(part)
  }
  options.failure(socket)
  let error: unknown
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value as Part
      if (part.type !== 'raw') parts.push(part)
    }
  } catch (caught) {
    error = caught
  }
  const ofType = (type: string) => parts.filter((part) => part.type === type)
  return { parts, error, calls, ofType }
}

const serviceRestart = (socket: ReturnType<typeof fakeSocket>) =>
  socket.peerClose(1012, 'service restart')
const socketError = (socket: ReturnType<typeof fakeSocket>) =>
  socket.peerError('connection reset')
// Nothing to do: the transport's idle timer fires on its own.
const idle = () => {}
const rateLimit = (socket: ReturnType<typeof fakeSocket>) =>
  socket.write(rateLimitFailed)
const wrappedError =
  (status: number, message: string) =>
  (socket: ReturnType<typeof fakeSocket>) =>
    socket.write({ type: 'error', status, error: { message } })

describe('websocket failure after function calls only (real AI SDK parser)', () => {
  test('a close while the only call is still streaming fails retryably and runs nothing', async () => {
    const { error, calls, ofType } = await run({
      frames: [created, callAdded(1), callDelta(1, '{"path":')],
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
      failure: rateLimit,
    })

    expect(error).toBeUndefined()
    expect(ofType('finish')[0]).toMatchObject({
      finishReason: { unified: 'other' },
    })
  })
})

const unfinishedCallFrames = () => [
  created,
  callAdded(1),
  callDelta(1, '{"path":'),
]
const finishedCallFrames = () => [
  created,
  callAdded(1),
  callDone(1, '{"path":"a"}'),
  callAdded(2),
  callDelta(2, '{'),
]

// The idle timeout is long enough for the reader to reach the barrier first,
// short enough to keep the suite fast.
const IDLE_MS = 100

describe('other transport failures after function calls only (real AI SDK parser)', () => {
  for (const [name, failure, idleTimeout] of [
    ['a socket error', socketError, undefined],
    ['an idle timeout', idle, IDLE_MS],
  ] as const) {
    test(`${name} while the only call is still streaming fails retryably`, async () => {
      const { error, calls, ofType } = await run({
        frames: unfinishedCallFrames(),
        failure,
        idleTimeout,
      })

      expect(ofType('tool-call')).toHaveLength(0)
      expect(error).toBeInstanceOf(ResponseStreamError)
      expect(error).toMatchObject({ isRetryable: true })
      expect(calls.completed).toBe(0)
    })

    test(`${name} after a finished call completes with that call`, async () => {
      const { error, calls, ofType } = await run({
        frames: finishedCallFrames(),
        failure,
        idleTimeout,
      })

      expect(error).toBeUndefined()
      expect(ofType('tool-call')).toHaveLength(1)
      expect(ofType('tool-call')[0]).toMatchObject({ toolCallId: 'call_1' })
      expect(ofType('finish')[0]).toMatchObject({
        finishReason: { unified: 'tool-calls' },
      })
      expect(calls.completed).toBe(0)
      expect(calls.invalid).toHaveLength(1)
    })
  }
})

describe('wrapped protocol error after output (real AI SDK parser)', () => {
  // The provider wording used here is what the host's retry patterns match
  // ("rate limit", "service unavailable", 429, 503). After anything durable
  // it must not reach the host, or the host would replay the step.
  test('after a finished call it completes with that call and no error', async () => {
    const { error, calls, ofType } = await run({
      frames: finishedCallFrames(),
      failure: wrappedError(429, 'Rate limit exceeded'),
    })

    expect(error).toBeUndefined()
    expect(ofType('error')).toHaveLength(0)
    expect(ofType('tool-call')).toHaveLength(1)
    expect(ofType('tool-call')[0]).toMatchObject({ toolCallId: 'call_1' })
    expect(ofType('finish')[0]).toMatchObject({
      finishReason: { unified: 'tool-calls' },
    })
    expect(calls.completed).toBe(0)
    // Reported as a non-completed terminal, which drops any continuation and
    // invalidates the connection.
    expect(calls.terminal).toEqual(['error'])
  })

  test('after streamed text it surfaces only the fixed terminal message', async () => {
    const { error } = await run({
      frames: [
        created,
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'partial answer',
        },
      ],
      failure: wrappedError(503, 'Service Unavailable'),
    })

    expect((error as Error).message).toBe(TERMINAL_AFTER_OUTPUT_MESSAGE)
    expect(APICallError.isInstance(error)).toBe(false)
  })

  test('after only an unfinished call it surfaces the provider error unchanged', async () => {
    const { error, ofType } = await run({
      frames: unfinishedCallFrames(),
      failure: wrappedError(503, 'Service Unavailable'),
    })

    expect(ofType('tool-call')).toHaveLength(0)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: 503,
      message: 'Service Unavailable',
    })
  })

  test('a rate limit after only an unfinished call marks the account and fails retryably', async () => {
    // Marking the account is what sends the retry to a different one; without
    // it the host would retry the exhausted account.
    const { error, calls, ofType } = await run({
      frames: unfinishedCallFrames(),
      failure: wrappedError(429, 'Rate limit exceeded'),
    })

    expect(ofType('tool-call')).toHaveLength(0)
    expect(calls.rateLimited).toHaveLength(1)
    expect(error).toBeInstanceOf(ResponseStreamError)
    expect(error).toMatchObject({ isRetryable: true })
  })
})
