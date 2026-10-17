// The WebSocket frame turn (`v2/frame-turn.ts`): which `response.create`
// frames start a new turn, that the frame turn is kept apart from the
// session's HTTP turn state, which title, compaction and generate requests
// keep sharing exactly as on OpenCode 1, and how the plugin feeds it from the
// host's WebSocket hooks and session deletions.

import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { prepareCodexRequest } from '../codex-request'
import { CodexSessionStore } from '../v2/codex-sessions'
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
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  type RequestKind,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

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

describe('WebSocket frame turn in the OpenCode 2 plugin', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  /**
   * The plugin on a fake host with one pool account. `store` backs the Codex
   * metadata with a session file, as production does; the frame turn state
   * then lives on that process-wide store.
   */
  async function start(options: { store?: boolean } = {}) {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    const host = fakeOpenCode2Host()
    const ids = runtime('turn')
    const store = options.store
      ? new CodexSessionStore(join(files.dir, 'sessions.json'))
      : undefined
    const codex = new CodexHttpState(ids.runtime, 'installation', store)
    const stop = await setupOpenAIAuth(host.ctx, {
      codex,
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
      await store?.settled()
    })
    const owned = `Bearer ${placeholderSecret('openai')}`
    await host.fire('experimental.ws.handshake', {
      ...scope(SESSION),
      url: 'wss://api.openai.com/v1/responses',
      headers: { authorization: owned } as Record<string, string>,
    })
    // The runtime's ids also mint the session's thread id, so a turn is
    // named by the order its id first appeared in: 1, 2, ...
    const seen: string[] = []
    /** Sends one frame on the owned socket and returns its turn's number. */
    const send = async (frame: Record<string, unknown>) => {
      ids.clock.now += 1_000
      await host.fire('experimental.ws.send', {
        ...scope(SESSION),
        frame: JSON.stringify(frame),
      })
      const id = codex.frameTurns.get(SESSION)?.turnID
      if (id === undefined) return undefined
      if (!seen.includes(id)) seen.push(id)
      return seen.indexOf(id) + 1
    }
    /** Delivers one server frame on the owned socket. */
    const receive = (type: string, fields: Record<string, unknown> = {}) =>
      host.fire('experimental.ws.receive', {
        ...scope(SESSION),
        frame: JSON.stringify({ type, response: { id: 'r' }, ...fields }),
      })
    /** Sends one owned HTTP request of `kind` for the session. */
    const http = (kind: RequestKind, input: unknown[]) =>
      host.fire('http.request', {
        ...scope(SESSION, kind),
        request: new Request('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            authorization: owned,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'gpt-6.1-sol', input }),
        }),
      })
    return { host, codex, send, receive, http }
  }

  it('takes the completion of a frame from experimental.ws.receive, so only an uncompleted full frame is resent in its turn', async () => {
    const plugin = await start()
    const frame = full([user('one')])
    expect(await plugin.send(frame)).toBe(1)
    // Frames other than response.completed leave the frame uncompleted: the
    // same full frame again is a resend and keeps the turn.
    await plugin.receive('response.created')
    await plugin.receive('response.output_item.done')
    // Only the frame's type counts, not text that happens to name it.
    await plugin.receive('response.output_text.delta', {
      delta: 'waiting for response.completed',
    })
    expect(plugin.codex.frameTurns.get(SESSION)?.completed).toBe(false)
    expect(await plugin.send(frame)).toBe(1)
    await plugin.receive('response.completed')
    expect(plugin.codex.frameTurns.get(SESSION)?.completed).toBe(true)
    expect(await plugin.send(frame)).toBe(2)
  })

  it('advances the turn for each chained user message, and never for a tool-output delta or a full frame ending on tool output', async () => {
    const plugin = await start()
    expect(await plugin.send(full([user('one')]))).toBe(1)
    await plugin.receive('response.completed')
    expect(await plugin.send(chained('r1', [call('c1'), output('c1')]))).toBe(1)
    await plugin.receive('response.completed')
    expect(await plugin.send(chained('r2', [user('again')]))).toBe(2)
    await plugin.receive('response.completed')
    expect(await plugin.send(chained('r3', [user('again')]))).toBe(3)
    await plugin.receive('response.completed')
    // A new socket replays the whole conversation, ending on tool output.
    expect(
      await plugin.send(
        full([
          user('one'),
          call('c1'),
          output('c1'),
          user('again'),
          user('again'),
          call('c2'),
          output('c2'),
        ]),
      ),
    ).toBe(3)
  })

  it('keeps the turn for an unchanged full-frame retry after an uncompleted send and advances it for one adding a second identical user message', async () => {
    const plugin = await start()
    const history = [user('one'), assistant('hi'), user('two')]
    expect(await plugin.send(full(history))).toBe(1)
    await plugin.receive('response.completed')
    expect(await plugin.send(chained('r1', [user('three')]))).toBe(2)
    // That send got no response.completed (a refusal, say); the host retries
    // with the whole conversation on another socket.
    const retry = full([...history, assistant('ok'), user('three')])
    expect(await plugin.send(retry)).toBe(2)
    expect(await plugin.send(retry)).toBe(2)
    // The user sent the same message again before anything completed.
    expect(
      await plugin.send(
        full([...history, assistant('ok'), user('three'), user('three')]),
      ),
    ).toBe(3)
  })

  for (const kind of ['compaction', 'generate'] as const) {
    it(`keeps the turn across an HTTP ${kind} request between a WebSocket turn and its tool step`, async () => {
      const plugin = await start()
      expect(await plugin.send(full([user('one')]))).toBe(1)
      await plugin.receive('response.completed')
      const httpTurn = plugin.codex.get(SESSION).turnID
      await plugin.http(
        kind,
        kind === 'generate'
          ? [
              user('one'),
              assistant('hi'),
              user(
                'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK',
              ),
            ]
          : [user('summarize this session')],
      )
      // The request went through the plugin's HTTP shaping, which moves the
      // HTTP turn for every request kind, as on OpenCode 1.
      expect(plugin.codex.get(SESSION).turnID).not.toBe(httpTurn)
      expect(await plugin.send(chained('r1', [call('c1'), output('c1')]))).toBe(
        1,
      )
      expect(plugin.codex.frameTurns.get(SESSION)?.turnStartedAt).toBe(2_000)
    })
  }

  it('keeps a fixed-size state with no message text after a multi-megabyte user message, and its resend rules still hold', async () => {
    const plugin = await start()
    const huge = user('x'.repeat(4 * 1024 * 1024))
    expect(await plugin.send(full([huge]))).toBe(1)
    const record = plugin.codex.frameTurns.get(SESSION)
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'completed',
      'fingerprint',
      'turnID',
      'turnStartedAt',
      'userCount',
    ])
    expect(record?.fingerprint).toMatch(/^[\da-f]{64}$/)
    expect(JSON.stringify(record).length).toBeLessThan(256)
    // Nothing of the frame is kept to compare against: the resend test and
    // the tool-delta rule work from the fixed-size record alone.
    expect(await plugin.send(full([huge]))).toBe(1)
    expect(await plugin.send(chained('r1', [output('c1')]))).toBe(1)
    expect(await plugin.send(chained('r2', [user('next')]))).toBe(2)
    expect(JSON.stringify(plugin.codex.frameTurns.get(SESSION)).length).toBe(
      JSON.stringify(record).length,
    )
  })

  for (const store of [false, true]) {
    it(`drops the session's turn state when the host deletes the session (session file: ${store})`, async () => {
      const plugin = await start({ store })
      expect(await plugin.send(full([user('one')]))).toBe(1)
      await plugin.host.publish('session.deleted', { sessionID: SESSION })
      expect(plugin.codex.frameTurns.get(SESSION)).toBeUndefined()
      // The next frame of a session with that id starts a new turn, even as
      // an unchanged full frame that would otherwise be a resend.
      expect(await plugin.send(full([user('one')]))).toBe(2)
    })
  }
})
