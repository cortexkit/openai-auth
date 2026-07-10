import { describe, expect, test } from 'bun:test'
import { APICallError } from 'ai'
import { DUMP_SESSION_HEADER } from '../dump'
import { connectResponsesWebSocket } from '../ws'
import {
  applyTurnId,
  CODEX_BODY_KEY_ORDER,
  createWebSocketFetch,
  orderCodexBody,
} from '../ws-pool'

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

  test('does not rotate turn_id when a continuation keeps an inline (unfinalized) function_call', () => {
    // The continuation guard may keep an aborted/unfinalized function_call inline
    // alongside its output. That item is non-_output but is NOT a new user turn —
    // applyTurnId must keep the active turn_id (rotating it would bust the cache).
    const e = entry()
    const userTurn = turnID(
      applyTurnId(e, body([{ type: 'message', role: 'user', content: [] }])),
    )
    const cont = turnID(
      applyTurnId(
        e,
        body([
          { type: 'function_call', call_id: 'aborted', name: 'aft_zoom' },
          { type: 'function_call_output', call_id: 'aborted', output: 'x' },
        ]),
      ),
    )
    expect(cont).toBe(userTurn)
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

describe('orderCodexBody', () => {
  test('orders known response body keys and leaves unknown keys trailing', () => {
    const input = {
      stream: true,
      extra_key: 'kept-last',
      client_metadata: {},
      model: 'gpt-5.5',
      input: [],
      prompt_cache_key: 'session-1',
    }

    const ordered = orderCodexBody(input)
    expect(Object.keys(ordered)).toEqual([
      ...CODEX_BODY_KEY_ORDER.filter((key) => key in input),
      'extra_key',
    ])
  })
})

describe('createWebSocketFetch', () => {
  test('attributes quota by the internal account key and threads the served ChatGPT id', async () => {
    const quotaCalls: Array<{
      accessToken: string
      accountId?: string
      servedChatgptAccountId?: string
    }> = []
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
          message(
            JSON.stringify({
              type: 'codex.rate_limits',
              rate_limits: {
                primary: { used_percent: 10, window_minutes: 300 },
              },
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
          onQuota: (_s, accessToken, accountId, servedChatgptAccountId) => {
            quotaCalls.push({
              accessToken,
              accountId,
              servedChatgptAccountId,
            })
          },
        })

        const response = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          {
            method: 'POST',
            headers: {
              'session-id': 'sess-q',
              authorization: 'Bearer tok-main',
              // Wire account id is the ChatGPT stable id — must NOT be used as the
              // quota key. The internal QUOTA_ACCOUNT_HEADER is 'main' here.
              'chatgpt-account-id': 'chatgpt-stable-xyz',
              'x-openai-auth-quota-account': 'main',
            },
            body: JSON.stringify({ stream: true, input: [] }),
          },
        )
        await response.text()

        expect(quotaCalls).toHaveLength(1)
        expect(quotaCalls[0]?.accountId).toBe('main')
        expect(quotaCalls[0]?.accessToken).toBe('tok-main')
        expect(quotaCalls[0]?.servedChatgptAccountId).toBe('chatgpt-stable-xyz')
        websocketFetch.close()
      },
    )
  })

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

  test('sanitizes websocket-shaped requests before HTTP fallback', async () => {
    let fallbackInit: RequestInit | undefined
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
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
        },
      }),
      async () => {
        const httpFetch: typeof globalThis.fetch = Object.assign(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
            fallbackInit = init
            return new Response('http')
          },
          { preconnect: () => {} },
        )
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
          httpFetch,
          firstEventGraceMs: 1,
        })

        const response = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [],
            client_metadata: {
              keep: 'stable',
              'x-codex-installation-id': 'install-1',
              'x-codex-window-id': 'window-1',
              'x-codex-turn-metadata': '{"turn_id":"ws-only"}',
              'x-codex-ws-stream-request-start-ms': '12345',
            },
          }),
        )

        expect(await response.text()).toBe('http')
        if (!fallbackInit) throw new Error('missing fallback init')
        const headers = new Headers(fallbackInit.headers)
        expect(headers.get('accept')).toBe('text/event-stream')
        expect(headers.get('content-type')).toBe('application/json')
        const fallbackBody = JSON.parse(String(fallbackInit.body)) as Record<
          string,
          unknown
        >
        expect(fallbackBody.client_metadata).toEqual({
          keep: 'stable',
          'x-codex-installation-id': 'install-1',
          'x-codex-window-id': 'window-1',
        })
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
          const isPrewarm = parsed.generate === false
          const id = isPrewarm
            ? `resp_prewarm_${sent.length}`
            : `resp_main_${sent.length}`
          // A real main response finalizes the tool call it makes (emits its
          // output_item.done). That's what makes call_1 safe to trim from the
          // next continuation.
          if (!isPrewarm) {
            message(
              JSON.stringify({
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  call_id: 'call_1',
                  name: 'bash',
                },
              }),
            )
          }
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

  test('preserves turn_id across a reconnect in the same tool loop', async () => {
    const sent: Array<Record<string, unknown>> = []
    let sockets = 0
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
                      ? `resp_prewarm_${sent.length}`
                      : `resp_main_${sent.length}`,
                },
              }),
            )
          },
        }
      },
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
          maxConnectionAge: 0,
        })
        const url = 'https://example.test/backend-api/codex/responses'
        const user = {
          role: 'user',
          content: [{ type: 'input_text', text: 'go' }],
        }
        const call = { type: 'function_call', call_id: 'call_1', name: 'read' }
        const output = {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'ok',
        }

        await websocketFetch(
          url,
          streamRequest({
            input: [user],
            client_metadata: body([]).client_metadata,
          }),
        )
        await websocketFetch(
          url,
          streamRequest({
            input: [user, call, output],
            client_metadata: body([]).client_metadata,
          }),
        )

        const mainRequests = sent.filter(
          (request) => request.generate !== false,
        )
        expect(sockets).toBe(2)
        expect(mainRequests).toHaveLength(2)
        const firstMain = mainRequests[0]
        const secondMain = mainRequests[1]
        if (!firstMain || !secondMain) throw new Error('missing main requests')
        expect(secondMain.input).toEqual([
          { ...user, type: 'message' },
          call,
          output,
        ])
        expect(turnID(secondMain)).toBe(turnID(firstMain))
        websocketFetch.close()
      },
    )
  })

  test('keeps an unfinalized (aborted) function_call inline while trimming the finalized one in the same continuation', async () => {
    // Reproduces the real 400 "No tool call found for function call output":
    // a turn's response finalizes call_final but aborts mid-emission of call_aborted.
    // Both come back next turn as function_call+output pairs. The finalized one is
    // safe to trim (it's in previous_response_id's response); the aborted one is NOT
    // there, so trimming its function_call orphans its output -> 400. The aborted
    // function_call must be kept inline; the finalized one must still be trimmed.
    const sent: Array<Record<string, unknown>> = []
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          const parsed = JSON.parse(data) as Record<string, unknown>
          sent.push(parsed)
          const isPrewarm = parsed.generate === false
          const id = isPrewarm
            ? `resp_prewarm_${sent.length}`
            : `resp_main_${sent.length}`
          if (!isPrewarm) {
            // The main response finalizes ONLY call_final. call_aborted is
            // emitted by the model but interrupted before its output_item.done,
            // so it never enters the finalized set.
            message(
              JSON.stringify({
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  call_id: 'call_final',
                  name: 'read',
                },
              }),
            )
          }
          message(
            JSON.stringify({ type: 'response.completed', response: { id } }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })

        // Turn 1: fresh user turn -> prewarm + main. Main finalizes call_final only.
        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
            ],
          }),
        )

        // Turn 2: tool continuation. OpenCode replays BOTH calls as
        // function_call+output pairs (the aborted one too).
        await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
              { type: 'function_call', call_id: 'call_final', name: 'read' },
              {
                type: 'function_call_output',
                call_id: 'call_final',
                output: 'ok',
              },
              {
                type: 'function_call',
                call_id: 'call_aborted',
                name: 'aft_zoom',
              },
              {
                type: 'function_call_output',
                call_id: 'call_aborted',
                output: '[aborted]',
              },
            ],
          }),
        )

        const continuation = sent[2]
        expect(continuation?.previous_response_id).toBe('resp_main_2')
        // Finalized call: function_call trimmed, output kept.
        // Aborted call: BOTH function_call and output kept (inline match).
        expect(continuation?.input).toEqual([
          { type: 'function_call_output', call_id: 'call_final', output: 'ok' },
          { type: 'function_call', call_id: 'call_aborted', name: 'aft_zoom' },
          {
            type: 'function_call_output',
            call_id: 'call_aborted',
            output: '[aborted]',
          },
        ])
        websocketFetch.close()
      },
    )
  })

  test('still trims a call finalized several responses back when its body item is delayed (cumulative chain set)', async () => {
    // Models staggered parallel tool calls. R1 finalizes call_A AND call_B, but
    // call_A's tool runs slow: its function_call/output do not appear in the body
    // until turn 3 — AFTER the immediately-chained response (R2). The finalized set
    // must be CUMULATIVE across the whole previous_response_id chain, not just the
    // latest response, so call_A (finalized back in R1) is still trimmed. A
    // latest-response-only set would only know call_C and would wrongly re-send
    // call_A's function_call inline — a duplicate the chained context already has.
    const sent: Array<Record<string, unknown>> = []
    let main = 0
    const finalizedByResponse: Record<number, string[]> = {
      1: ['call_A', 'call_B'],
      2: ['call_C'],
    }
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          const parsed = JSON.parse(data) as Record<string, unknown>
          sent.push(parsed)
          if (parsed.generate === false) {
            message(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_prewarm' },
              }),
            )
            return
          }
          main += 1
          for (const callId of finalizedByResponse[main] ?? []) {
            message(
              JSON.stringify({
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: callId, name: 'read' },
              }),
            )
          }
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_main_${main}` },
            }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })
        const url = 'https://example.test/backend-api/codex/responses'
        const user = {
          role: 'user',
          content: [{ type: 'input_text', text: 'go' }],
        }
        const fc = (id: string) => ({
          type: 'function_call',
          call_id: id,
          name: 'read',
        })
        const out = (id: string) => ({
          type: 'function_call_output',
          call_id: id,
          output: id,
        })

        // Turn 1: [user] -> prewarm + R1 (finalizes call_A and call_B).
        await websocketFetch(url, streamRequest({ input: [user] }))
        // Turn 2: only call_B's result is ready (call_A still running). R2 makes call_C.
        await websocketFetch(
          url,
          streamRequest({ input: [user, fc('call_B'), out('call_B')] }),
        )
        // Turn 3: call_A finally lands (finalized way back in R1) alongside call_C's result.
        await websocketFetch(
          url,
          streamRequest({
            input: [
              user,
              fc('call_B'),
              out('call_B'),
              fc('call_A'),
              out('call_A'),
              fc('call_C'),
              out('call_C'),
            ],
          }),
        )

        // Turn-3 suffix = [fc_A, out_A, fc_C, out_C]. call_A (R1) and call_C (R2)
        // are both in the cumulative chain set -> both function_calls trimmed,
        // both outputs kept. No duplicate fc_A re-sent.
        const last = sent[sent.length - 1]
        expect(last?.input).toEqual([out('call_A'), out('call_C')])
        websocketFetch.close()
      },
    )
  })

  test('resets the finalized set after an unchained full replay so a later continuation does not trim a call the chain target lacks', async () => {
    // Guards the round-2 hole: the cumulative finalized set must NOT be inherited
    // across a request that was sent WITHOUT previous_response_id. Sequence:
    //  - R1 finalizes call_B.
    //  - A turn appends only a droppable item (an assistant message), so the
    //    continuation suffix filters to empty -> withContinuation sends the full
    //    body UNCHAINED (no previous_response_id). Its response (R2) does NOT
    //    contain call_B.
    //  - A later turn sends call_B's function_call+output. If the finalized set had
    //    been inherited across the unchained break, call_B would be trimmed and
    //    chained to R2 (which lacks it) -> orphan -> 400. It must be kept inline.
    const sent: Array<Record<string, unknown>> = []
    let main = 0
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          const parsed = JSON.parse(data) as Record<string, unknown>
          sent.push(parsed)
          if (parsed.generate === false) {
            message(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_prewarm' },
              }),
            )
            return
          }
          main += 1
          // Only R1 finalizes call_B. R2 (the unchained full replay) finalizes nothing.
          if (main === 1) {
            message(
              JSON.stringify({
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  call_id: 'call_B',
                  name: 'read',
                },
              }),
            )
          }
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_main_${main}` },
            }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })
        const url = 'https://example.test/backend-api/codex/responses'
        const user = {
          role: 'user',
          content: [{ type: 'input_text', text: 'go' }],
        }
        const assistant = {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'thinking' }],
        }
        const fcB = { type: 'function_call', call_id: 'call_B', name: 'read' }
        const outB = {
          type: 'function_call_output',
          call_id: 'call_B',
          output: 'b',
        }

        // Turn 1: [user] -> prewarm + R1 (finalizes call_B).
        await websocketFetch(url, streamRequest({ input: [user] }))
        // Turn 2: appends only an assistant message -> suffix filters to empty ->
        // sent as an UNCHAINED full replay (no previous_response_id). R2 response.
        await websocketFetch(url, streamRequest({ input: [user, assistant] }))
        const r2 = sent[sent.length - 1]
        expect(r2?.previous_response_id).toBeUndefined()
        // Turn 3: call_B's invocation+output land. Must be kept inline (chained to
        // R2, which does not contain call_B).
        await websocketFetch(
          url,
          streamRequest({ input: [user, assistant, fcB, outB] }),
        )
        const r3 = sent[sent.length - 1]
        expect(r3?.previous_response_id).toBe('resp_main_2')
        expect(r3?.input).toEqual([fcB, outB])
        websocketFetch.close()
      },
    )
  })

  test('treats custom_tool_call symmetrically: trims finalized, keeps unfinalized inline', async () => {
    const sent: Array<Record<string, unknown>> = []
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          const parsed = JSON.parse(data) as Record<string, unknown>
          sent.push(parsed)
          const isPrewarm = parsed.generate === false
          if (!isPrewarm) {
            message(
              JSON.stringify({
                type: 'response.output_item.done',
                item: { type: 'custom_tool_call', call_id: 'ct_final' },
              }),
            )
          }
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: isPrewarm ? 'resp_prewarm' : 'resp_main' },
            }),
          )
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
        })
        const url = 'https://example.test/backend-api/codex/responses'
        const user = {
          role: 'user',
          content: [{ type: 'input_text', text: 'go' }],
        }
        await websocketFetch(url, streamRequest({ input: [user] }))
        await websocketFetch(
          url,
          streamRequest({
            input: [
              user,
              { type: 'custom_tool_call', call_id: 'ct_final' },
              {
                type: 'custom_tool_call_output',
                call_id: 'ct_final',
                output: 'ok',
              },
              { type: 'custom_tool_call', call_id: 'ct_aborted' },
              {
                type: 'custom_tool_call_output',
                call_id: 'ct_aborted',
                output: '[aborted]',
              },
            ],
          }),
        )
        const last = sent[sent.length - 1]
        expect(last?.input).toEqual([
          {
            type: 'custom_tool_call_output',
            call_id: 'ct_final',
            output: 'ok',
          },
          { type: 'custom_tool_call', call_id: 'ct_aborted' },
          {
            type: 'custom_tool_call_output',
            call_id: 'ct_aborted',
            output: '[aborted]',
          },
        ])
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

  test('surfaces websocket stream failures as retryable AI SDK API errors', async () => {
    await withFakeWebSocket(
      ({ close }) => ({
        send() {
          close(1006, 'connection dropped')
        },
      }),
      async () => {
        const websocketFetch = createWebSocketFetch({
          url: 'https://example.test/backend-api/codex/responses',
          firstEventGraceMs: 0,
        })

        const response = await websocketFetch(
          'https://example.test/backend-api/codex/responses',
          streamRequest({ input: [] }),
        )
        const error = await response.text().then(
          () => undefined,
          (caught) => caught,
        )

        expect(APICallError.isInstance(error)).toBe(true)
        expect(error).toMatchObject({
          isRetryable: true,
          name: 'ProviderResponseStreamError',
        })
        websocketFetch.close()
      },
    )
  })

  test('preserves provider header timeout abort reason so OpenCode can retry it', async () => {
    class HeaderTimeoutError extends Error {
      override readonly name = 'ProviderHeaderTimeoutError'
      readonly ms = 10_000
    }

    await withFakeWebSocket(
      () => ({ autoOpen: false }),
      async () => {
        const controller = new AbortController()
        const reason = new HeaderTimeoutError(
          'Provider response headers timed out after 10000ms',
        )
        const connection = connectResponsesWebSocket({
          url: 'wss://example.test/backend-api/codex/responses',
          headers: {},
          signal: controller.signal,
        })

        controller.abort(reason)
        let caught: unknown
        try {
          await connection
        } catch (error) {
          caught = error
        }
        expect(caught).toBe(reason)
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
  autoOpen?: boolean
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
      if (this.behavior.autoOpen !== false) {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN
          this.emit('open', {})
        })
      }
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
