import { describe, expect, test } from 'bun:test'
import { DUMP_SESSION_HEADER } from '../dump'
import { applyTurnId, createWebSocketFetch } from '../ws-pool'

function entry() {
  return {
    lastUsedAt: 0,
    busy: false,
    fallback: false,
    streamFailures: 0,
  } as Parameters<typeof applyTurnId>[0]
}

function body(input: unknown[]) {
  return {
    type: 'response.create',
    input,
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'sid',
        thread_id: 'sid',
        thread_source: 'user',
        turn_id: 'PER_REQUEST_SHOULD_BE_OVERRIDDEN',
        sandbox: 'seccomp',
        turn_started_at_unix_ms: 1,
        request_kind: 'turn',
        window_id: 'sid:0',
      }),
    },
  }
}

function meta(result: Record<string, unknown>) {
  const cm = result.client_metadata as Record<string, string>
  return JSON.parse(cm['x-codex-turn-metadata']!) as Record<string, unknown>
}

function turnID(result: Record<string, unknown>) {
  return meta(result).turn_id as string
}

describe('applyTurnId', () => {
  test('keeps one turn_id across a tool-loop and ignores the per-request base id', () => {
    const e = entry()
    const userTurn = turnID(
      applyTurnId(e, body([{ type: 'message', role: 'user', content: [] }])),
    )
    const cont1 = turnID(
      applyTurnId(
        e,
        body([{ type: 'function_call_output', call_id: 'a', output: 'x' }]),
      ),
    )
    const cont2 = turnID(
      applyTurnId(
        e,
        body([{ type: 'function_call_output', call_id: 'b', output: 'y' }]),
      ),
    )

    expect(userTurn).not.toBe('PER_REQUEST_SHOULD_BE_OVERRIDDEN')
    expect(cont1).toBe(userTurn)
    expect(cont2).toBe(userTurn)
  })

  test('rotates turn_id when a new (non-output) message starts a turn', () => {
    const e = entry()
    const first = turnID(
      applyTurnId(e, body([{ type: 'message', role: 'user', content: [] }])),
    )
    turnID(
      applyTurnId(
        e,
        body([{ type: 'function_call_output', call_id: 'a', output: 'x' }]),
      ),
    )
    const second = turnID(
      applyTurnId(e, body([{ type: 'message', role: 'user', content: [] }])),
    )

    expect(second).not.toBe(first)
  })

  test('turn_started_at is stable across the tool-loop', () => {
    const e = entry()
    const startedAt = (result: Record<string, unknown>) =>
      meta(result).turn_started_at_unix_ms
    const t0 = startedAt(
      applyTurnId(e, body([{ type: 'message', role: 'user', content: [] }])),
    )
    const t1 = startedAt(
      applyTurnId(
        e,
        body([{ type: 'function_call_output', call_id: 'a', output: 'x' }]),
      ),
    )
    expect(t1).toBe(t0)
  })
})

describe('createWebSocketFetch', () => {
  test('preserves reasoning summaries on websocket requests and forwards reasoning deltas', async () => {
    const sent: Array<Record<string, unknown>> = []
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          sent.push(JSON.parse(data) as Record<string, unknown>)
          message(
            JSON.stringify({
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs_1',
              delta: 'thinking',
            }),
          )
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_1' },
            }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })

        const response = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            reasoning: { effort: 'medium', summary: 'auto' },
            input: [],
          }),
        )

        expect(sent[0]?.reasoning).toEqual({
          effort: 'medium',
          summary: 'auto',
        })
        expect(await response.text()).toContain(
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"thinking"}',
        )
        websocketFetch.close()
      },
    )
  })

  test('falls back to HTTP immediately when the websocket lane hits the connection limit', async () => {
    let httpRequests = 0
    let sockets = 0
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
          sockets++
          message(
            JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                code: 'websocket_connection_limit_reached',
                message: 'Responses websocket connection limit reached',
              },
            }),
          )
        },
      }),
      async () => {
        const httpFetch: typeof globalThis.fetch = Object.assign(
          async () => {
            httpRequests++
            return new Response('http')
          },
          { preconnect: () => {} },
        )
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
          httpFetch,
        })

        const first = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({ input: [] }),
        )
        const second = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({ input: [] }),
        )

        expect(await first.text()).toBe('http')
        expect(await second.text()).toBe('http')
        expect(httpRequests).toBe(2)
        expect(sockets).toBe(1)
        websocketFetch.close()
      },
    )
  })

  test('keeps the full first request after prewarm so historical tool outputs keep their tool calls', async () => {
    const sent: Array<Record<string, unknown>> = []
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          const parsed = JSON.parse(data) as Record<string, unknown>
          sent.push(parsed)
          message(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: parsed.generate === false ? 'resp_prewarm' : 'resp_main',
              },
            }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })

        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read',
                arguments: '{"filePath":"README.md"}',
              },
              {
                type: 'function_call_output',
                call_id: 'call_1',
                output: 'contents',
              },
            ],
          }),
        )

        expect(sent).toHaveLength(2)
        expect(sent[0]).toMatchObject({
          generate: false,
          input: [],
        })
        expect(sent[1]).toMatchObject({
          previous_response_id: 'resp_prewarm',
          input: [
            { type: 'message', role: 'user' },
            { type: 'function_call', call_id: 'call_1' },
            { type: 'function_call_output', call_id: 'call_1' },
          ],
        })
        websocketFetch.close()
      },
    )
  })

  test('prewarms again for a fresh user turn instead of continuing from the prior turn response', async () => {
    const sent: Array<Record<string, unknown>> = []
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          const parsed = JSON.parse(data) as Record<string, unknown>
          sent.push(parsed)
          const id =
            parsed.generate === false
              ? `resp_prewarm_${sent.length}`
              : `resp_main_${sent.length}`
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id },
            }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })

        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
            ],
          }),
        )
        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
              { type: 'function_call', call_id: 'call_1', name: 'bash' },
              { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
            ],
          }),
        )
        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
              { type: 'function_call', call_id: 'call_1', name: 'bash' },
              { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
              {
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
              { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
            ],
          }),
        )

        expect(sent).toHaveLength(5)
        expect(sent[0]).toMatchObject({ generate: false, input: [] })
        expect(sent[1]?.previous_response_id).toBe('resp_prewarm_1')
        expect(sent[2]).toMatchObject({
          previous_response_id: 'resp_main_2',
          input: [{ type: 'function_call_output', call_id: 'call_1' }],
        })
        expect(sent[3]).toMatchObject({ generate: false, input: [] })
        expect(sent[4]?.previous_response_id).toBe('resp_prewarm_4')
        expect(sent[4]?.input).toHaveLength(5)
        websocketFetch.close()
      },
    )
  })

  test('removes websocket pool entries by original OpenCode session id', async () => {
    let sockets = 0
    const sent: Array<Record<string, unknown>> = []
    await withFakeWebSocket(
      ({ message }) => {
        sockets++
        return {
          send(data) {
            const parsed = JSON.parse(data) as Record<string, unknown>
            sent.push(parsed)
            message(
              JSON.stringify({
                type: 'response.completed',
                response: {
                  id:
                    parsed.generate === false
                      ? `resp_prewarm_${sockets}`
                      : `resp_main_${sockets}`,
                },
              }),
            )
          },
        }
      },
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })
        const request = streamRequest({
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
          ],
        })
        request.headers = {
          'session-id': 'codex-thread-id',
          [DUMP_SESSION_HEADER]: 'ses_original',
        }

        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          request,
        )
        websocketFetch.remove('ses_original')
        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          request,
        )

        expect(sockets).toBe(2)
        expect(sent.filter((body) => body.generate === false)).toHaveLength(2)
        websocketFetch.close()
      },
    )
  })

  test('idle-prunes websocket fallback entries so a later turn can retry websocket', async () => {
    let sockets = 0
    let httpRequests = 0
    await withFakeWebSocket(
      ({ message }) => {
        sockets++
        const socketNumber = sockets
        return {
          send() {
            if (socketNumber === 1) {
              message(
                JSON.stringify({
                  type: 'error',
                  status: 400,
                  error: {
                    code: 'websocket_connection_limit_reached',
                    message: 'Responses websocket connection limit reached',
                  },
                }),
              )
              return
            }
            message(
              JSON.stringify({
                type: 'response.completed',
                response: { id: `resp_${socketNumber}` },
              }),
            )
          },
        }
      },
      async () => {
        const httpFetch: typeof globalThis.fetch = Object.assign(
          async () => {
            httpRequests++
            return new Response('http')
          },
          { preconnect: () => {} },
        )
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
          httpFetch,
          idleTimeout: 1,
        })

        const first = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({ input: [] }),
        )
        expect(await first.text()).toBe('http')
        await new Promise((resolve) => setTimeout(resolve, 20))
        const second = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({ input: [] }),
        )

        expect(await second.text()).toContain('[DONE]')
        expect(httpRequests).toBe(1)
        expect(sockets).toBe(2)
        websocketFetch.close()
      },
    )
  })

  test('returns response headers without waiting for first websocket event', async () => {
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
          // Delay the first provider event. The fetch wrapper must still
          // resolve response headers before this arrives.
          setTimeout(() => {
            message(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_delayed' },
              }),
            )
          }, 20)
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
          firstEventGraceMs: 0,
        })
        const started = Date.now()

        const response = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({ input: [] }),
        )

        expect(Date.now() - started).toBeLessThan(100)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('[DONE]')
        websocketFetch.close()
      },
    )
  })
})

function streamRequest(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'session-id': 'session-1' },
    body: JSON.stringify({ stream: true, ...body }),
  }
}

type FakeWebSocketContext = {
  message(data: string): void
  close(code?: number, reason?: string): void
}

type FakeWebSocketBehavior = {
  send?: (data: string) => void
  close?: () => void
}

async function withFakeWebSocket(
  behavior: (context: FakeWebSocketContext) => FakeWebSocketBehavior,
  run: () => Promise<void>,
) {
  const original = globalThis.WebSocket

  class FakeWebSocket {
    static OPEN = 1
    static CLOSED = 3

    url: string
    readyState = 0
    private readonly listeners = new Map<
      string,
      Set<{ fn: (event: unknown) => void; once: boolean }>
    >()
    private readonly behavior: FakeWebSocketBehavior

    constructor(url: string) {
      this.url = url
      this.behavior = behavior({
        message: (data) => this.emit('message', { data }),
        close: (code = 1000, reason = '') => {
          this.readyState = FakeWebSocket.CLOSED
          this.emit('close', { code, reason })
        },
      })
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open', {})
      })
    }

    addEventListener(
      type: string,
      fn: (event: unknown) => void,
      options?: { once?: boolean },
    ) {
      const listeners = this.listeners.get(type) ?? new Set()
      listeners.add({ fn, once: options?.once === true })
      this.listeners.set(type, listeners)
    }

    removeEventListener(type: string, fn: (event: unknown) => void) {
      const listeners = this.listeners.get(type)
      if (!listeners) return
      for (const listener of listeners) {
        if (listener.fn === fn) listeners.delete(listener)
      }
    }

    send(data: string) {
      this.behavior.send?.(data)
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.behavior.close?.()
    }

    private emit(type: string, event: unknown) {
      const listeners = this.listeners.get(type)
      if (!listeners) return
      for (const listener of [...listeners]) {
        listener.fn(event)
        if (listener.once) listeners.delete(listener)
      }
    }
  }

  ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket
  try {
    await run()
  } finally {
    ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      original
  }
}
