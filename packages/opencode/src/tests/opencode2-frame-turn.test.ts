// The WebSocket frame turn (`v2/frame-turn.ts`): which `response.create`
// frames start a new turn, and that the frame turn is kept apart from the
// session's HTTP turn state, which title, compaction and generate requests
// keep sharing exactly as on OpenCode 1.

import { describe, expect, it } from 'bun:test'
import { prepareCodexRequest } from '../codex-request'
import {
  CodexHttpState,
  MidConversationEffort,
  rewriteCodexHttpRequest,
} from '../v2/codex-wire'
import {
  FrameTurnState,
  frameRequestMetadata,
  userMessageFingerprint,
} from '../v2/frame-turn'

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
  arguments: '{}',
})
const output = (id: string) => ({
  type: 'function_call_output',
  call_id: id,
  output: 'ok',
})

/** A frame with the whole conversation, as on a new socket or a changed request. */
const full = (input: unknown[]) => ({
  type: 'response.create',
  model: 'gpt-6.1-sol',
  input,
})
/** A frame with only the items appended since `previous`. */
const chained = (previous: string, input: unknown[]) => ({
  ...full(input),
  previous_response_id: previous,
})

/** Turn ids `turn-1`, `turn-2`, ...; the clock is set by the test. */
function runtime(prefix = 'turn') {
  let ids = 0
  const clock = { now: 1_000 }
  return {
    clock,
    runtime: { now: () => clock.now, uuid: () => `${prefix}-${++ids}` },
  }
}

const SESSION = 'ses_1'

describe('WebSocket frame turn rule', () => {
  it('gives turns 1,1,2,3,4,4,5 across a tool step, compaction, a refused turn and a failover resend, keeping each turn start', () => {
    const { clock, runtime: rt } = runtime()
    const turns = new FrameTurnState(rt)
    const sent: Array<{ turnID: string; turnStartedAt: number }> = []
    const send = (frame: Record<string, unknown>, completes: boolean) => {
      clock.now += 1_000
      sent.push(turns.advance(SESSION, frame))
      if (completes) turns.completed(SESSION)
    }
    // Account A: a turn with a tool call, its tool output, a second turn.
    send(full([user('one')]), true)
    send(chained('r1', [output('c1')]), true)
    send(chained('r2', [user('two')]), true)
    // HTTP compaction ran; the host sends the compacted conversation in full.
    const compacted = [user('summarize'), assistant('summary'), user('three')]
    send(full(compacted), true)
    // Turn 4 is refused (usage limit): no response.completed.
    send(chained('r4', [user('four')]), false)
    // Failover to account B: a new socket, so the host resends in full.
    send(full([...compacted, assistant('three done'), user('four')]), true)
    send(chained('r6', [user('five')]), true)
    const index = new Map<string, number>()
    for (const turn of sent)
      if (!index.has(turn.turnID)) index.set(turn.turnID, index.size + 1)
    expect(sent.map((turn) => index.get(turn.turnID))).toEqual([
      1, 1, 2, 3, 4, 4, 5,
    ])
    // A turn keeps its first frame's start while the clock moves on.
    expect(sent.map((turn) => turn.turnStartedAt)).toEqual([
      2_000, 2_000, 4_000, 5_000, 6_000, 6_000, 8_000,
    ])
  })

  it('starts a turn for each of two consecutive identical user messages', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const first = turns.advance(SESSION, full([user('again')]))
    turns.completed(SESSION)
    const second = turns.advance(SESSION, chained('r1', [user('again')]))
    turns.completed(SESSION)
    const third = turns.advance(SESSION, chained('r2', [user('again')]))
    expect(new Set([first.turnID, second.turnID, third.turnID]).size).toBe(3)
  })

  it('keeps the turn for a tool-output delta, completed or not', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const first = turns.advance(SESSION, full([user('one')]))
    turns.completed(SESSION)
    expect(turns.advance(SESSION, chained('r1', [output('c1')]))).toEqual(first)
    expect(
      turns.advance(SESSION, chained('r2', [call('c2'), output('c2')])),
    ).toEqual(first)
  })

  it('keeps the turn for an unchanged full-frame retry after an uncompleted send', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const conversation = [user('one'), assistant('a'), user('two')]
    const sent = turns.advance(SESSION, full(conversation))
    expect(turns.advance(SESSION, full(conversation))).toEqual(sent)
  })

  it('starts a turn for a full frame after an uncompleted send that adds a second identical user message', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const sent = turns.advance(SESSION, full([user('same')]))
    const next = turns.advance(
      SESSION,
      full([user('same'), assistant('a'), user('same')]),
    )
    expect(next.turnID).not.toBe(sent.turnID)
  })

  it('starts a turn for the same full frame once the previous one completed', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const sent = turns.advance(SESSION, full([user('one')]))
    turns.completed(SESSION)
    expect(turns.advance(SESSION, full([user('one')])).turnID).not.toBe(
      sent.turnID,
    )
  })

  it('starts a turn for a full frame whose last user message differs after an uncompleted send', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const sent = turns.advance(SESSION, full([user('one')]))
    expect(turns.advance(SESSION, full([user('edited')])).turnID).not.toBe(
      sent.turnID,
    )
  })

  it('keeps the turn for a full frame on a new socket that ends on tool output', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const first = turns.advance(SESSION, full([user('one')]))
    turns.completed(SESSION)
    expect(
      turns.advance(SESSION, full([user('one'), call('c1'), output('c1')])),
    ).toEqual(first)
    turns.completed(SESSION)
    // A user message followed by model output does not open a turn either.
    expect(
      turns.advance(
        SESSION,
        full([user('one'), call('c1'), output('c1'), assistant('done')]),
      ),
    ).toEqual(first)
  })

  it('starts a turn on the first frame of a new or forgotten session, whatever it holds', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const first = turns.advance(
      SESSION,
      full([user('one'), call('c'), output('c')]),
    )
    expect(first.turnID).toBe('turn-1')
    turns.forget(SESSION)
    expect(turns.get(SESSION)).toBeUndefined()
    expect(turns.advance(SESSION, chained('r1', [output('c')])).turnID).toBe(
      'turn-2',
    )
  })

  it('never treats a full frame as a resend once the user count is unknown', () => {
    const turns = new FrameTurnState(runtime().runtime)
    // A chained frame with nothing recorded leaves the count unknown, and a
    // later chained frame keeps it unknown.
    turns.advance(SESSION, chained('r1', [user('one')]))
    turns.advance(SESSION, chained('r2', [output('c')]))
    expect(turns.get(SESSION)?.userCount).toBeUndefined()
    const before = turns.get(SESSION)!.turnID
    expect(turns.advance(SESSION, full([user('one')])).turnID).not.toBe(before)
  })

  it('adds the user messages of a delta to the recorded count and fingerprints its last one', () => {
    const turns = new FrameTurnState(runtime().runtime)
    turns.advance(SESSION, full([user('one'), assistant('a'), user('two')]))
    expect(turns.get(SESSION)?.userCount).toBe(2)
    turns.advance(SESSION, chained('r1', [output('c')]))
    expect(turns.get(SESSION)).toMatchObject({
      userCount: 2,
      fingerprint: userMessageFingerprint(user('two')),
    })
    turns.advance(SESSION, chained('r2', [user('three'), user('four')]))
    expect(turns.get(SESSION)).toMatchObject({
      userCount: 4,
      fingerprint: userMessageFingerprint(user('four')),
    })
  })

  it('keeps a fixed-size state with no message text for a multi-megabyte user message', () => {
    const turns = new FrameTurnState(runtime().runtime)
    const big = 'x'.repeat(4 * 1024 * 1024)
    const sent = turns.advance(
      SESSION,
      full([user('one'), assistant('a'), user(big)]),
    )
    const record = turns.get(SESSION)!
    const kept = JSON.stringify(record)
    expect(kept).not.toContain('xxxx')
    expect(kept.length).toBeLessThan(256)
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // The resend rule still holds: an unchanged retry keeps the turn.
    expect(
      turns.advance(SESSION, full([user('one'), assistant('a'), user(big)])),
    ).toEqual(sent)
    turns.completed(SESSION)
    // And the identical-message rule: the same message again is a new turn.
    const again = turns.advance(SESSION, chained('r1', [user(big)]))
    expect(again.turnID).not.toBe(sent.turnID)
    expect(JSON.stringify(turns.get(SESSION)).length).toBe(kept.length)
  })

  it('keeps at most maxSessions sessions and evicts the least recently used', () => {
    const turns = new FrameTurnState(runtime().runtime, 2)
    turns.advance('a', full([user('a')]))
    turns.advance('b', full([user('b')]))
    turns.completed('a')
    turns.advance('c', full([user('c')]))
    expect(turns.get('a')).toBeDefined()
    expect(turns.get('b')).toBeUndefined()
    expect(turns.get('c')).toBeDefined()
  })
})

describe('WebSocket frame turn and HTTP turn state are separate', () => {
  const http = (kind: string, input: unknown[]) =>
    new Request('https://codex.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input }),
    })

  /** Shapes a frame with OpenCode 1's WebSocket builder and returns its turn metadata. */
  function shapeFrame(
    state: CodexHttpState,
    turns: FrameTurnState,
    frame: Record<string, unknown>,
  ) {
    const turn = turns.advance(SESSION, frame)
    const prepared = prepareCodexRequest({
      init: { body: JSON.stringify(frame) },
      headers: new Headers(),
      metadata: frameRequestMetadata(state.get(SESSION), turn),
      installationID: state.installationID,
      runtime: state.runtime,
      websocket: true,
      responsesLite: false,
      rewriteLite: () => {},
    })
    const body = JSON.parse(String(prepared.init?.body))
    return JSON.parse(body.client_metadata['x-codex-turn-metadata']) as {
      thread_id: string
      turn_id: string
      turn_started_at_unix_ms: number
    }
  }

  /** The HTTP turn state fields only HTTP requests may write. */
  const httpTurn = (state: CodexHttpState) => {
    const { turnID, turnStartedAt, input, canonicalInput } = state.get(SESSION)
    return structuredClone({ turnID, turnStartedAt, input, canonicalInput })
  }

  it('an HTTP title and an HTTP compaction between frames leave the frame turn untouched', async () => {
    const httpClock = runtime('http')
    const frameClock = runtime('frame')
    const state = new CodexHttpState(httpClock.runtime, 'installation')
    const effort = new MidConversationEffort(state)
    const turns = new FrameTurnState(frameClock.runtime)
    const step = async (kind: string, input: unknown[]) => {
      httpClock.clock.now += 1_000
      await rewriteCodexHttpRequest(
        http(kind, input),
        { sessionID: SESSION, kind },
        effort,
        false,
      )
    }
    const frame = (body: Record<string, unknown>) => {
      frameClock.clock.now += 1_000
      const before = httpTurn(state)
      const metadata = shapeFrame(state, turns, body)
      // Shaping a frame never writes the HTTP turn state.
      expect(httpTurn(state)).toEqual(before)
      return metadata
    }

    const first = frame(full([user('one')]))
    turns.completed(SESSION)
    const beforeTitle = httpTurn(state)
    await step('title', [user('name this session')])
    // The title request moved the HTTP turn, as it does on OpenCode 1.
    expect(httpTurn(state).turnID).not.toBe(beforeTitle.turnID)
    const tool = frame(chained('r1', [call('c1'), output('c1')]))
    turns.completed(SESSION)
    const beforeCompaction = httpTurn(state)
    await step('compaction', [user('summarize this session')])
    expect(httpTurn(state).turnID).not.toBe(beforeCompaction.turnID)
    const next = frame(chained('r2', [output('c2')]))

    expect([first, tool, next].map((metadata) => metadata.turn_id)).toEqual([
      'frame-1',
      'frame-1',
      'frame-1',
    ])
    expect(
      [first, tool, next].map((metadata) => metadata.turn_started_at_unix_ms),
    ).toEqual([2_000, 2_000, 2_000])
    // The frame still carries the session's thread, shared with HTTP.
    expect(next.thread_id).toBe(state.get(SESSION).threadID)
  })
})
