// WebSocket frame shaping on OpenCode 2 (`rewriteCodexFrame` in
// `v2/codex-wire.ts`). A frame is the plugin's to shape when its socket was
// opened with the pool placeholder credential; frames of API-key sessions are
// left alone. Every such `response.create` frame goes out as OpenCode 1's
// WebSocket request builder shapes it, with the frame turn in its turn
// metadata. Its `input` stays the host's, except that the mid-conversation
// effort rule may insert one `configuration_update` item before the turn's
// user message. Shaping a frame never changes the headers the socket was
// opened with.

import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { prepareCodexRequest } from '../codex-request'
import {
  CodexHttpState,
  frameInputKept,
  MidConversationEffort,
  rewriteCodexFrame,
} from '../v2/codex-wire'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const SESSION = { sessionID: 'ses_1', kind: 'primary' }
const THREAD = '00000000-0000-7000-8000-000000000001'
const INSTALLATION = 'installation-1'

const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
})
const assistant = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
})
const call = (id: string) => ({
  type: 'function_call',
  call_id: id,
  name: 'read',
  arguments: '{"path":"README.md"}',
})
const output = (id: string) => ({
  type: 'function_call_output',
  call_id: id,
  output: 'ok',
})
const update = (effort: string) => ({
  type: 'configuration_update',
  reasoning: { effort },
})

/**
 * A frame as OpenCode 2 builds it: its own field order, its session id as the
 * cache key, an output cap and a tool in the AI SDK's shape.
 */
function hostFrame(
  input: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'response.create',
    model: 'gpt-5.5',
    max_output_tokens: 32_000,
    instructions: 'be brief',
    input,
    tools: [
      {
        type: 'function',
        name: 'read',
        description: 'Reads a file',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ],
    reasoning: { effort: 'medium', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'ses_1',
    ...extra,
  }
}

/** Turn ids `turn-1`, `turn-2`, ... and a clock the test moves. */
function runtime() {
  let ids = 0
  const clock = { now: 1_000 }
  return {
    clock,
    runtime: { now: () => clock.now, uuid: () => `turn-${++ids}` },
  }
}

/** Codex state whose session already has its thread, so ids only name turns. */
function codexState(rt = runtime().runtime) {
  const state = new CodexHttpState(rt, INSTALLATION)
  state.sessions.set(SESSION.sessionID, {
    threadID: THREAD,
    turnID: 'http-turn',
    windowID: `${THREAD}:0`,
  })
  return new MidConversationEffort(state)
}

/**
 * OpenCode 1's WebSocket request builder for the same host body: the body
 * without its output cap, through `prepareCodexRequest` with
 * `websocket: true`, for the given turn and send time.
 */
function opencode1Frame(
  frame: Record<string, unknown>,
  turn: { turnID: string; turnStartedAt: number },
  sentAt: number,
) {
  const { max_output_tokens: _cap, ...body } = frame
  const prepared = prepareCodexRequest({
    init: { body: JSON.stringify(body) },
    headers: new Headers(),
    metadata: { threadID: THREAD, windowID: `${THREAD}:0`, ...turn },
    installationID: INSTALLATION,
    runtime: { now: () => sentAt, uuid: () => 'unused' },
    websocket: true,
    responsesLite: false,
    rewriteLite: () => {},
  })
  return String(prepared.init?.body)
}

const turnMetadata = (text: string) =>
  JSON.parse(JSON.parse(text).client_metadata['x-codex-turn-metadata']) as {
    turn_id: string
    turn_started_at_unix_ms: number
  }

describe('WebSocket frame shaping', () => {
  it("shapes every frame of a tool step, compaction, refusal and failover byte for byte as OpenCode 1's WebSocket builder does", () => {
    const { clock, runtime: rt } = runtime()
    const effort = codexState(rt)
    const compacted = [user('summary'), assistant('ok'), user('three')]
    // Frame, whether it completes, and the turn it belongs to.
    const steps: Array<[Record<string, unknown>, boolean, number]> = [
      [hostFrame([user('one')]), true, 1],
      [
        hostFrame([call('c1'), output('c1')], { previous_response_id: 'r1' }),
        true,
        1,
      ],
      [hostFrame([user('two')], { previous_response_id: 'r2' }), true, 2],
      [hostFrame(compacted), true, 3],
      [hostFrame([user('four')], { previous_response_id: 'r4' }), false, 4],
      [hostFrame([...compacted, assistant('done'), user('four')]), true, 4],
      [hostFrame([user('five')], { previous_response_id: 'r6' }), true, 5],
    ]
    const starts = new Map<number, number>()
    for (const [frame, completes, turn] of steps) {
      clock.now += 1_000
      if (!starts.has(turn)) starts.set(turn, clock.now)
      const sent = rewriteCodexFrame(JSON.stringify(frame), SESSION, effort)
      expect(sent).toBe(
        opencode1Frame(
          frame,
          {
            turnID: `turn-${turn}`,
            turnStartedAt: starts.get(turn) ?? 0,
          },
          clock.now,
        ),
      )
      if (completes) effort.http.frameTurns.completed(SESSION.sessionID)
    }
    // Shaping never wrote the session's HTTP turn state.
    expect(effort.http.get(SESSION.sessionID)).toEqual({
      threadID: THREAD,
      turnID: 'http-turn',
      windowID: `${THREAD}:0`,
    })
  })

  it('keeps turn_started_at_unix_ms at the first frame of its turn across a tool continuation and a failover resend while the send time moves', () => {
    const { clock, runtime: rt } = runtime()
    const effort = codexState(rt)
    const send = (frame: Record<string, unknown>, at: number) => {
      clock.now = at
      const sent = rewriteCodexFrame(JSON.stringify(frame), SESSION, effort)
      return {
        started: turnMetadata(sent ?? 'null').turn_started_at_unix_ms,
        sentAt: JSON.parse(sent ?? 'null').client_metadata[
          'x-codex-ws-stream-request-start-ms'
        ],
        turn: turnMetadata(sent ?? 'null').turn_id,
      }
    }
    const history = [user('one'), assistant('hi'), user('two')]
    const first = send(hostFrame(history), 10_000)
    effort.http.frameTurns.completed(SESSION.sessionID)
    const tool = send(
      hostFrame([call('c1'), output('c1')], { previous_response_id: 'r1' }),
      12_500,
    )
    // That send got no response.completed; the host resends in full.
    const resend = send(
      hostFrame([...history, call('c1'), output('c1')]),
      19_000,
    )
    expect([first, tool, resend]).toEqual([
      { started: 10_000, sentAt: '10000', turn: 'turn-1' },
      { started: 10_000, sentAt: '12500', turn: 'turn-1' },
      { started: 10_000, sentAt: '19000', turn: 'turn-1' },
    ])
  })

  it("sends the host's parsed input, with a backslash-u escape, a non-ASCII string and a float", () => {
    const effort = codexState()
    // Written by hand, as the host's serializer may escape: an escaped é and
    // emoji, raw CJK text, and floats in a tool's arguments and an item field.
    const input = String.raw`[{"type":"message","role":"user","content":[{"type":"input_text","text":"caf\u00e9 \ud83d\ude00 日本語"}]},{"type":"function_call","call_id":"c1","name":"read","arguments":"{\"ratio\":0.1}","score":2.50},{"type":"function_call_output","call_id":"c1","output":"1e-7 Ω"}]`
    const host = `{"type":"response.create","model":"gpt-5.5","input":${input},"max_output_tokens":1000}`
    const sent = rewriteCodexFrame(host, SESSION, effort) ?? 'null'
    expect(JSON.stringify(JSON.parse(sent).input)).toBe(
      JSON.stringify(JSON.parse(host).input),
    )
    expect(JSON.parse(sent).input[1].score).toBe(2.5)
  })

  it('inserts exactly one configuration_update before the user message on a 2.0.21-shaped gpt-6.1-sol frame whose effort changed', () => {
    const effort = codexState()
    const opening = hostFrame([user('one')], {
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'low' },
    })
    rewriteCodexFrame(JSON.stringify(opening), SESSION, effort)
    effort.http.frameTurns.completed(SESSION.sessionID)
    // 2.0.21 sends the turn whose effort changed in full, with the new effort
    // on the request and no update item.
    const history = [user('one'), assistant('hi'), user('two')]
    const changed = hostFrame(history, {
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'high' },
    })
    const sent = JSON.parse(
      rewriteCodexFrame(JSON.stringify(changed), SESSION, effort) ?? 'null',
    )
    expect(sent.input).toEqual([
      user('one'),
      assistant('hi'),
      update('high'),
      user('two'),
    ])
    expect(sent.reasoning).toEqual({ effort: 'low' })
  })

  it('leaves input unchanged on a 2.0.22-shaped gpt-6.1-sol frame, whose host already carries the effort change', () => {
    const effort = codexState()
    const opening = hostFrame([user('one')], {
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'low' },
    })
    rewriteCodexFrame(JSON.stringify(opening), SESSION, effort)
    effort.http.frameTurns.completed(SESSION.sessionID)
    // 2.0.22 keeps the request-level effort pinned and sends the update item
    // itself, right before the turn's user message, on a chained frame.
    const chained = hostFrame([update('high'), user('two')], {
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'low' },
      previous_response_id: 'r1',
    })
    const sent = JSON.parse(
      rewriteCodexFrame(JSON.stringify(chained), SESSION, effort) ?? 'null',
    )
    expect(JSON.stringify(sent.input)).toBe(JSON.stringify(chained.input))
    expect(sent.reasoning).toEqual({ effort: 'low' })
  })

  it("sends the host's input when a shaping step changes it beyond the effort rule", () => {
    // An effort rule that drops and reorders items stands for any shaping
    // step that would edit input.
    class Rewriting extends MidConversationEffort {
      override apply(body: Record<string, unknown>): boolean {
        body.input = (body.input as unknown[]).slice(1).reverse()
        body.reasoning = { effort: 'low' }
        return true
      }
    }
    const effort = new Rewriting(codexState().http)
    const host = hostFrame([user('one'), assistant('hi'), user('two')])
    const sent = JSON.parse(
      rewriteCodexFrame(JSON.stringify(host), SESSION, effort) ?? 'null',
    )
    expect(sent.input).toEqual(host.input)
    // The rest of the shaping still applies.
    expect(sent.prompt_cache_key).toBe(THREAD)
    expect(Object.keys(sent).indexOf('input')).toBe(
      Object.keys(sent).indexOf('instructions') + 1,
    )
  })
})

describe('frameInputKept', () => {
  const host = [user('one'), assistant('hi'), user('two')]
  it("accepts the host's input, and one configuration_update right before a user message", () => {
    expect(frameInputKept(host, structuredClone(host))).toBe(true)
    expect(frameInputKept(undefined, undefined)).toBe(true)
    expect(
      frameInputKept(host, [
        user('one'),
        assistant('hi'),
        update('x'),
        user('two'),
      ]),
    ).toBe(true)
    expect(frameInputKept(host, [update('x'), ...host])).toBe(true)
  })

  it('refuses a dropped, reordered or edited item, an update not before a user message, and any other inserted item', () => {
    expect(frameInputKept(host, host.slice(1))).toBe(false)
    expect(frameInputKept(host, [...host].reverse())).toBe(false)
    expect(
      frameInputKept(host, [user('one'), assistant('hi'), user('changed')]),
    ).toBe(false)
    expect(frameInputKept(host, [...host, update('x')])).toBe(false)
    expect(
      frameInputKept(host, [
        user('one'),
        update('x'),
        assistant('hi'),
        user('two'),
      ]),
    ).toBe(false)
    expect(
      frameInputKept(host, [
        user('one'),
        assistant('hi'),
        user('extra'),
        user('two'),
      ]),
    ).toBe(false)
    expect(frameInputKept(host, [update('x'), update('y'), ...host])).toBe(
      false,
    )
    expect(frameInputKept(host, undefined)).toBe(false)
  })
})

describe('WebSocket frame shaping in the OpenCode 2 plugin', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function start() {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    const host = fakeOpenCode2Host()
    const stop = await setupOpenAIAuth(host.ctx, {
      codex: new CodexHttpState(runtime().runtime, INSTALLATION),
      paths: files.paths,
      sidebarStateFile: join(files.dir, 'sidebar.json'),
      slot: opencode1HostSlot(join(files.dir, 'auth.json')),
      fence: async () => ({ open: true }),
      heartbeat: false,
      fetch: (async () => {
        throw new Error('offline in tests')
      }) as unknown as typeof fetch,
    })
    cleanups.push(async () => {
      await stop?.()
    })
    return host
  }

  const handshake = (authorization: string) => ({
    ...scope(SESSION.sessionID),
    url: 'wss://api.openai.com/v1/responses',
    headers: { authorization } as Record<string, string>,
  })

  it('shapes owned frames and leaves the handshake headers as they were', async () => {
    const host = await start()
    const first = handshake(`Bearer ${placeholderSecret('openai')}`)
    await host.fire('experimental.ws.handshake', first)
    const opened = JSON.stringify(first.headers)
    const sends = [
      hostFrame([user('one')]),
      hostFrame([call('c1'), output('c1')], { previous_response_id: 'r1' }),
    ]
    for (const frame of sends) {
      const draft = {
        ...scope(SESSION.sessionID),
        frame: JSON.stringify(frame),
      }
      await host.fire('experimental.ws.send', draft)
      const sent = JSON.parse(draft.frame)
      expect(sent.client_metadata['x-codex-installation-id']).toBe(INSTALLATION)
      expect(sent.max_output_tokens).toBeUndefined()
      expect(JSON.stringify(sent.input)).toBe(JSON.stringify(frame.input))
    }
    // Shaping frames changed nothing on the open socket's handshake, and the
    // next handshake asks for the same socket.
    expect(JSON.stringify(first.headers)).toBe(opened)
    const second = handshake(`Bearer ${placeholderSecret('openai')}`)
    await host.fire('experimental.ws.handshake', second)
    expect(JSON.stringify(second.headers)).toBe(opened)
    expect(first.headers['x-codex-turn-metadata']).toBeUndefined()
  })

  it("leaves an API-key session's frames untouched", async () => {
    const host = await start()
    await host.fire(
      'experimental.ws.handshake',
      handshake('Bearer sk-user-key'),
    )
    const frame = JSON.stringify(hostFrame([user('one')]))
    const draft = { ...scope(SESSION.sessionID), frame }
    await host.fire('experimental.ws.send', draft)
    expect(draft.frame).toBe(frame)
  })
})
