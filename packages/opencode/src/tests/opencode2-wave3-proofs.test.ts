// Real-host proofs of three OpenCode 2 capabilities the plugin's WebSocket
// and keep-warm work depends on. Test names carry the proof labels of the
// OpenCode 2 parity plan:
// - P1: a plugin rewrite of outbound WebSocket frames reaches the wire byte
//   for byte and the server's conversation stays the one the host meant;
// - P6: a captured HTTP request can be replayed out of band without the host
//   noticing, and a WebSocket session's full conversation can be rebuilt from
//   its frames (plus OpenCode 2's own `warming` setting, observed);
// - P5: what the plugin knows about a WebSocket request's size before the
//   handshake that picks its account.
// It also checks, on the same host, the capability built on P1: the plugin
// shapes every owned WebSocket frame as OpenCode 1 does, keeping the host's
// input.
// Runs only with OPENAI_AUTH_OPENCODE2_PROOFS=1, after `bun run build`, against
// the pinned host fixture (install it as `opencode2-e2e.test.ts` describes).
// Each test prints its evidence as `PROOF-EVIDENCE <name> <json>` lines.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCodexRequest } from '../codex-request'
import { hostBinary } from './fixtures/opencode-host'
import { installPackedPlugin } from './fixtures/opencode2-pack'
import type { ProofRecord } from './fixtures/opencode2-proof-codex'
import {
  type ProofHost,
  rotateToken,
  startProofHost,
  type TraceEvent,
} from './fixtures/opencode2-proof-host'

const ENABLED = process.env.OPENAI_AUTH_OPENCODE2_PROOFS === '1'

let scratch = ''
let cli = ''
let consumer = ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (item: Record<string, unknown>) =>
  typeof item.content === 'string'
    ? item.content
    : Array.isArray(item.content)
      ? item.content
          .map((part) =>
            isRecord(part) && typeof part.text === 'string' ? part.text : '',
          )
          .join('')
      : ''

/**
 * The conversation as the model reads it, in the same notation the probe uses
 * for the host's own messages (`hostView` in the probe): user and assistant
 * text, tool calls by call id and name, tool results by call id.
 */
export function providerView(conversation: unknown[] | undefined): string[] {
  return (conversation ?? []).flatMap((item) => {
    if (!isRecord(item)) return []
    if (item.type === 'function_call')
      return [`call:${item.call_id}:${item.name}`]
    if (item.type === 'function_call_output') return [`result:${item.call_id}`]
    if (item.type === 'compaction' || item.type === 'compaction_summary')
      return ['compaction']
    if (item.role === 'user' || item.role === 'assistant')
      return [`${item.role}:${textOf(item)}`]
    return []
  })
}

const markerOf = (record: ProofRecord) =>
  /"x-proof-marker":"([^"]+)"/.exec(record.raw ?? '')?.[1]

/** Prints one evidence line the report quotes, and returns its value. */
function evidence<T>(name: string, value: T): T {
  console.error(`PROOF-EVIDENCE ${name} ${JSON.stringify(value)}`)
  return value
}

/** The hook sequence with one short label per event. */
const sequence = (trace: TraceEvent[], sessionID?: string) =>
  trace
    .filter(
      (event) =>
        !sessionID ||
        event.sessionID === sessionID ||
        event.hook === 'setup' ||
        event.hook === 'dispose',
    )
    .filter(
      (event) =>
        event.hook !== 'ws.receive' ||
        event.type === 'response.completed' ||
        event.type === 'error',
    )
    .map((event) =>
      [
        event.hook,
        event.kind,
        event.hook === 'ws.send'
          ? `prev=${event.previous ? 'y' : 'n'},items=${event.inputItems},turn=${event.turn ?? '-'}`
          : event.hook === 'ws.receive'
            ? event.type
            : event.hook === 'retry'
              ? JSON.stringify(event.decision)
              : event.hook === 'http.response'
                ? event.status
                : '',
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(':'),
    )

async function compact(host: ProofHost, sessionID: string) {
  const started = await host.api(
    'POST',
    `/api/session/${sessionID}/compact`,
    {},
  )
  const waited = await host.api(
    'POST',
    `/api/experimental/session/${sessionID}/wait`,
  )
  return { started: started.status, waited: waited.status, json: started.json }
}

async function messageCount(host: ProofHost, sessionID: string) {
  const listed = await host.api('GET', `/api/session/${sessionID}/message`)
  const json = listed.json
  const items = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.data)
      ? json.data
      : isRecord(json) && Array.isArray(json.items)
        ? json.items
        : undefined
  return {
    status: listed.status,
    count: items?.length,
    types: items?.map((item) =>
      isRecord(item) ? `${item.type ?? ''}:${item.role ?? ''}` : '?',
    ),
  }
}

describe.skipIf(!ENABLED)('OpenCode 2 wave 3 proofs (real host)', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'oai-oc2-proofs-'))
    cli = hostBinary(2)
    const version = spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout
    if (!version.includes('2.0.22'))
      throw new Error(`expected @opencode/cli 2.0.22, found ${version}`)
    consumer = installPackedPlugin(join(scratch, 'pack')).consumer
  }, 300_000)

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  test('P1: a plugin frame rewrite reaches the wire verbatim and the conversation stays coherent', async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'websocket',
      accounts: ['A', 'B'],
      used: { A: 5, B: 40 },
      rewrite: true,
      // Keep nothing of the history verbatim, so a compaction really
      // replaces the context the next turn is built from.
      compaction: { auto: false, keep: { tokens: 1 } },
    })
    try {
      const steps: Record<string, unknown> = {}
      const t1 = await host.turn('Turn 1: USE-TOOL read the readme.')
      const sessionID = t1.sessionID ?? ''
      steps.t1 = t1.exit
      steps.t2 = (
        await host.turn('Turn 2: say hello.', { continue: true })
      ).exit
      steps.compact = await compact(host, sessionID)
      steps.afterCompaction = await messageCount(host, sessionID)
      steps.t3 = (
        await host.turn('Turn 3: after compaction.', { continue: true })
      ).exit
      host.mock.reject('A')
      steps.t4 = (
        await host.turn('Turn 4: the account fails over.', { continue: true })
      ).exit
      steps.t5 = (
        await host.turn('Turn 5: after the failover.', { continue: true })
      ).exit
      const trace = host.trace()
      const records = host.records()
      evidence('p1.steps', steps)
      evidence('p1.sequence', sequence(trace, sessionID))
      const sends = trace.filter((event) => event.hook === 'ws.send')
      const frames = records.filter((record) => record.action === 'frame')
      const byMarker = new Map(
        frames.map((record) => [markerOf(record), record]),
      )
      const rows = sends.map((send) => {
        const record = byMarker.get(send.marker as string)
        const context = trace
          .filter(
            (event) =>
              event.hook === 'context' &&
              event.sessionID === send.sessionID &&
              event.seq < send.seq,
          )
          .at(-1)
        const host = (context?.view as string[] | undefined) ?? []
        const provider = providerView(record?.conversation)
        return {
          marker: send.marker,
          turn: send.turn,
          kind: send.kind,
          exact: record?.raw === send.replacement,
          connection: record?.connection,
          identity: record?.identity,
          previous: record?.previous ?? null,
          outcome: record?.outcome,
          inputItems: send.inputItems,
          inputTypes: send.inputTypes,
          cacheKey: send.cacheKey,
          views: JSON.stringify(host) === JSON.stringify(provider),
          host,
          provider,
        }
      })
      evidence('p1.frames', rows)
      const handshakes = records.filter(
        (record) => record.action === 'handshake',
      )
      evidence(
        'p1.handshakes',
        handshakes.map((record) => ({
          connection: record.connection,
          identity: record.identity,
          headers: record.headers,
        })),
      )
      evidence(
        'p1.handshakeHooks',
        trace
          .filter((event) => event.hook === 'ws.handshake')
          .map((event) => JSON.stringify(event.headers)),
      )
      evidence(
        'p1.http',
        records
          .filter((record) => record.transport === 'http')
          .map((record) => ({
            identity: record.identity,
            outcome: record.outcome,
            bytes: record.raw?.length,
            input: providerView(record.conversation).map((entry) =>
              entry.slice(0, 120),
            ),
          })),
      )
      evidence(
        'p1.unmarked',
        frames.filter((record) => !markerOf(record)).length,
      )

      // Every turn ran, and the compaction completed.
      expect(steps).toMatchObject({ t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 })
      expect(steps.compact).toMatchObject({ started: 200, waited: 204 })
      // The recorder saw exactly the bytes the plugin put in each frame, and
      // no frame went out without the plugin's rewrite.
      expect(rows.length).toBe(7)
      expect(rows.map((row) => row.exact)).toEqual(Array(7).fill(true))
      expect(frames.filter((record) => !markerOf(record))).toEqual([])
      // tool call, its output, second turn, the full resend after the
      // compaction, the refused send on A, its full resend on B, next turn.
      expect(rows.map((row) => row.outcome)).toEqual([
        'tool-call',
        'text',
        'text',
        'text',
        'usage-limit',
        'text',
        'text',
      ])
      expect(sends.map((send) => Boolean(send.previous))).toEqual([
        false,
        true,
        true,
        false,
        true,
        false,
        true,
      ])
      // Each chained frame named the response before it on its socket.
      const answered = rows.map((row) => byMarker.get(row.marker as string))
      expect(answered[1]?.previous).toBe(answered[0]?.responseID)
      expect(answered[2]?.previous).toBe(answered[1]?.responseID)
      expect(answered[6]?.previous).toBe(answered[5]?.responseID)
      expect(
        records.filter(
          (record) => record.outcome === 'previous_response_not_found',
        ),
      ).toEqual([])
      // The turn number the probe put on each frame moves only with a new
      // user message: not on the tool output, not on the failover resend.
      expect(rows.map((row) => row.turn)).toEqual([1, 1, 2, 3, 4, 4, 5])
      // One socket per account; the handshake hook ran for every model call
      // with one unchanged header set per account.
      expect(
        handshakes.map((record) => [record.connection, record.identity]),
      ).toEqual([
        [1, 'A'],
        [2, 'B'],
      ])
      expect(rows.map((row) => `${row.connection}${row.identity}`)).toEqual([
        '1A',
        '1A',
        '1A',
        '1A',
        '1A',
        '2B',
        '2B',
      ])
      const hookHeaders = trace
        .filter((event) => event.hook === 'ws.handshake')
        .map((event) => JSON.stringify(event.headers))
      expect(hookHeaders.length).toBe(7)
      expect(new Set(hookHeaders).size).toBe(2)
      // What the host meant to send is what the server holds, frame by frame.
      for (const row of rows)
        if (row.outcome !== 'usage-limit')
          expect(row.provider).toEqual(row.host)
      expect(rows[3]?.provider[0]).toStartWith('user:<conversation-checkpoint>')
      // Title and compaction went over HTTP, not on the session socket.
      expect(
        trace
          .filter((event) => event.hook === 'http.request')
          .map((event) => event.kind),
      ).toEqual(['title', 'compaction'])
      expect(new Set(sends.map((send) => send.kind))).toEqual(
        new Set(['primary']),
      )
    } finally {
      await host.stop()
    }
  }, 300_000)

  test("WebSocket frame shaping: seven frames across a tool step, compaction, refusal and failover carry OpenCode 1's shape, the frame turns and the host's input", async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'websocket',
      accounts: ['A', 'B'],
      used: { A: 5, B: 40 },
      hostFrames: true,
      compaction: { auto: false, keep: { tokens: 1 } },
    })
    try {
      const steps: Record<string, unknown> = {}
      const t1 = await host.turn('Turn 1: USE-TOOL read the readme.')
      const sessionID = t1.sessionID ?? ''
      steps.t1 = t1.exit
      steps.t2 = (
        await host.turn('Turn 2: say hello.', { continue: true })
      ).exit
      steps.compact = await compact(host, sessionID)
      steps.t3 = (
        await host.turn('Turn 3: after compaction.', { continue: true })
      ).exit
      host.mock.reject('A')
      steps.t4 = (
        await host.turn('Turn 4: the account fails over.', { continue: true })
      ).exit
      steps.t5 = (
        await host.turn('Turn 5: after the failover.', { continue: true })
      ).exit
      const trace = host.trace()
      const records = host.records()
      const before = trace.filter((event) => event.hook === 'ws.send.host')
      const after = trace.filter((event) => event.hook === 'ws.send')
      const wire = records.filter((record) => record.action === 'frame')
      const rows = after.map((send, index) => {
        const hostText = before[index]?.frame as string
        const sentText = send.sent as string
        const sent = JSON.parse(sentText)
        const metadata = JSON.parse(
          sent.client_metadata['x-codex-turn-metadata'],
        )
        const context = trace
          .filter(
            (event) =>
              event.hook === 'context' &&
              event.sessionID === send.sessionID &&
              event.seq < send.seq,
          )
          .at(-1)
        return {
          hostText,
          sentText,
          sent,
          // The window in which the plugin had the frame: from the hook run
          // before the plugin's to the one after it.
          window: [before[index]?.at as number, send.at],
          startMs: sent.client_metadata['x-codex-ws-stream-request-start-ms'],
          turnID: metadata.turn_id as string,
          turnStartedAt: metadata.turn_started_at_unix_ms as number,
          record: wire[index],
          host: (context?.view as string[] | undefined) ?? [],
          provider: providerView(wire[index]?.conversation),
        }
      })
      evidence('s10a.steps', steps)
      evidence(
        's10a.frames',
        rows.map((row) => ({
          window: row.window,
          startMs: row.startMs,
          turnID: row.turnID,
          turnStartedAt: row.turnStartedAt,
          connection: row.record?.connection,
          identity: row.record?.identity,
          previous: row.record?.previous ?? null,
          outcome: row.record?.outcome,
          keys: Object.keys(row.sent),
        })),
      )

      expect(steps).toMatchObject({ t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 })
      expect(steps.compact).toMatchObject({ started: 200, waited: 204 })
      expect(before.length).toBe(7)
      expect(rows.length).toBe(7)
      expect(wire.length).toBe(7)
      // What the plugin left in each frame is what reached the server.
      for (const row of rows) expect(row.record?.raw).toBe(row.sentText)
      expect(rows.map((row) => row.record?.outcome)).toEqual([
        'tool-call',
        'text',
        'text',
        'text',
        'usage-limit',
        'text',
        'text',
      ])
      expect(rows.map((row) => Boolean(row.sent.previous_response_id))).toEqual(
        [false, true, true, false, true, false, true],
      )
      for (const row of rows) {
        // The host's input, as the host meant it.
        expect(JSON.stringify(row.sent.input)).toBe(
          JSON.stringify(JSON.parse(row.hostText).input),
        )
        // OpenCode 1's WebSocket builder output for the same host body,
        // turn and send time, byte for byte: key order and every field.
        const { max_output_tokens: _cap, ...body } = JSON.parse(row.hostText)
        const opencode1 = prepareCodexRequest({
          init: { body: JSON.stringify(body) },
          headers: new Headers(),
          metadata: {
            threadID: row.sent.prompt_cache_key,
            windowID: row.sent.client_metadata['x-codex-window-id'],
            turnID: row.turnID,
            turnStartedAt: row.turnStartedAt,
          },
          installationID: row.sent.client_metadata['x-codex-installation-id'],
          runtime: { now: () => Number(row.startMs), uuid: () => 'unused' },
          websocket: true,
          responsesLite: false,
          rewriteLite: () => {},
        })
        expect(row.sentText).toBe(String(opencode1.init?.body))
        expect(row.sent.prompt_cache_key).not.toBe(sessionID)
        // The send time is a whole millisecond inside the frame's own window.
        expect(row.startMs).toMatch(/^\d+$/)
        expect(Number(row.startMs)).toBeGreaterThanOrEqual(row.window[0] ?? 0)
        expect(Number(row.startMs)).toBeLessThanOrEqual(row.window[1] ?? 0)
      }
      // Turn ids move only with a new user message: not on the tool output,
      // not on the failover resend; compaction and title leave them alone.
      const order: string[] = []
      for (const row of rows)
        if (!order.includes(row.turnID)) order.push(row.turnID)
      expect(rows.map((row) => order.indexOf(row.turnID) + 1)).toEqual([
        1, 1, 2, 3, 4, 4, 5,
      ])
      // Each turn starts inside its first frame's window and keeps that start.
      for (const row of rows) {
        const first = rows.find((other) => other.turnID === row.turnID)
        expect(Number.isInteger(row.turnStartedAt)).toBe(true)
        expect(row.turnStartedAt).toBe(first?.turnStartedAt ?? -1)
        expect(row.turnStartedAt).toBeGreaterThanOrEqual(first?.window[0] ?? 0)
        expect(row.turnStartedAt).toBeLessThanOrEqual(first?.window[1] ?? 0)
      }
      // Each chained frame named the response before it on its socket, and
      // the server never lost the chain.
      for (const index of [1, 2, 4, 6]) {
        expect(rows[index - 1]?.record?.responseID).toStartWith('resp_')
        expect(rows[index]?.sent.previous_response_id).toBe(
          rows[index - 1]?.record?.responseID,
        )
      }
      expect(
        records.filter(
          (record) => record.outcome === 'previous_response_not_found',
        ),
      ).toEqual([])
      // One socket per account, opened with one unchanged header set each.
      expect(
        records
          .filter((record) => record.action === 'handshake')
          .map((record) => [record.connection, record.identity]),
      ).toEqual([
        [1, 'A'],
        [2, 'B'],
      ])
      expect(
        rows.map((row) => `${row.record?.connection}${row.record?.identity}`),
      ).toEqual(['1A', '1A', '1A', '1A', '1A', '2B', '2B'])
      const hookHeaders = trace
        .filter((event) => event.hook === 'ws.handshake')
        .map((event) => JSON.stringify(event.headers))
      expect(new Set(hookHeaders).size).toBe(2)
      for (const headers of hookHeaders)
        expect(headers).not.toContain('x-codex-turn-metadata')
      // What the host meant to send is what the server holds, frame by frame.
      for (const row of rows)
        if (row.record?.outcome !== 'usage-limit')
          expect(row.provider).toEqual(row.host)
      // Title and compaction went over HTTP with HTTP shaping only.
      expect(
        trace
          .filter((event) => event.hook === 'http.request')
          .map((event) => event.kind),
      ).toEqual(['title', 'compaction'])
      expect(new Set(after.map((send) => send.kind))).toEqual(
        new Set(['primary']),
      )
    } finally {
      await host.stop()
    }
  }, 300_000)

  test('P1: an API-key session is not rewritten by the plugin', async () => {
    const key = 'sk-proof-user-key'
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'websocket',
      accounts: ['A'],
      apiKey: key,
      hostFrames: true,
    })
    try {
      const t1 = await host.turn('Turn 1: say hello.')
      const t2 = await host.turn('Turn 2: again.', { continue: true })
      const trace = host.trace()
      const records = host.records()
      evidence('p1b.result', {
        exits: [t1.exit, t2.exit],
        session: t1.sessionID,
        sends: trace
          .filter((event) => event.hook === 'ws.send')
          .map((event) => ({ cacheKey: event.cacheKey, keys: event.keys })),
        wire: records.map((record) => ({
          action: record.action,
          identity: record.identity,
          auth: record.headers.authorization,
          account: record.headers['chatgpt-account-id'] ?? null,
          originator: record.headers.originator ?? null,
        })),
      })
      expect([t1.exit, t2.exit]).toEqual([0, 0])
      // The host's own cache key (its session id) stays on every frame: the
      // plugin, which would set its thread id, left the frames alone.
      const sends = trace.filter((event) => event.hook === 'ws.send')
      expect(sends.length).toBe(2)
      for (const send of sends) expect(send.cacheKey).toBe(t1.sessionID)
      // Each frame left the plugin byte for byte as the host built it.
      const built = trace.filter((event) => event.hook === 'ws.send.host')
      expect(built.length).toBe(2)
      expect(sends.map((send) => send.sent)).toEqual(
        built.map((event) => event.frame),
      )
      // The key went out as the bearer, with no pool account or Codex identity.
      for (const event of trace.filter(
        (entry) => entry.hook === 'ws.handshake',
      ))
        expect((event.headers as Record<string, string>).authorization).toBe(
          '<redacted:Bearer sk-pro>',
        )
      for (const record of records) {
        expect(record.identity).toBe('none')
        expect(record.headers['chatgpt-account-id']).toBeUndefined()
        expect(record.headers.originator).toBeUndefined()
      }
    } finally {
      await host.stop()
    }
  }, 300_000)

  test('P6: an out-of-band HTTP replay stays invisible to the host', async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'http',
      accounts: ['A', 'B'],
      used: { A: 5, B: 40 },
      pool: true,
      aliases: { 'tok-A-rotated': { account: 'A', label: 'rotated' } },
    })
    try {
      const out: Record<string, unknown> = {}
      const t1 = await host.turn('Turn 1: say hello.')
      const sessionID = t1.sessionID ?? ''
      out.t1 = t1.exit
      out.messagesBefore = await messageCount(host, sessionID)
      const before = host.trace().length
      const recordsBefore = host.records().length
      out.replay1 = (
        await host.control(`/replay-http?session=${sessionID}`)
      ).json
      await Bun.sleep(1500)
      const afterReplay = host.trace().slice(before)
      out.hooksDuringReplay = afterReplay.map((event) => event.hook)
      out.messagesAfter = await messageCount(host, sessionID)
      const replayRecord = host.records().slice(recordsBefore)
      out.replayWire = replayRecord.map((record) => ({
        identity: record.identity,
        auth: record.headers.authorization,
        outcome: record.outcome,
      }))
      const original = host
        .records()
        .filter(
          (record) =>
            record.transport === 'http' && record.outcome !== undefined,
        )
      const primaryBodies = original.map((record) =>
        JSON.parse(record.raw ?? '{}'),
      )
      out.bodies = primaryBodies.map((body) => ({
        store: body.store,
        cacheKey: body.prompt_cache_key,
        tools: Array.isArray(body.tools) ? body.tools.length : null,
        instructions:
          typeof body.instructions === 'string'
            ? body.instructions.length
            : null,
        capped: 'max_output_tokens' in body,
        input: providerView(body.input),
      }))
      const t2 = await host.turn('Turn 2: after the replay.', {
        continue: true,
      })
      out.t2 = t2.exit
      // Rotate A's token in the pool's state file: the next replay must
      // carry the new one, resolved through the pool, not a saved bearer.
      rotateToken(host.configDir, 'main', 'tok-A-rotated')
      const recordsRotate = host.records().length
      out.replayRotated = (
        await host.control(`/replay-http?session=${sessionID}`)
      ).json
      out.replayRotatedWire = host
        .records()
        .slice(recordsRotate)
        .map((record) => record.headers.authorization)
      // Move the session to B: a refusal before output reroutes the turn.
      host.mock.reject('A')
      const t3 = await host.turn('Turn 3: the account fails over.', {
        continue: true,
      })
      out.t3 = t3.exit
      const recordsRepin = host.records().length
      out.replayRepinned = (
        await host.control(`/replay-http?session=${sessionID}`)
      ).json
      out.replayRepinnedWire = host
        .records()
        .slice(recordsRepin)
        .map((record) => record.headers.authorization)
      // Subagent identity: a child session of this one.
      const child = await host.api('POST', '/api/session', {
        parentID: sessionID,
      })
      const childID = isRecord(child.json)
        ? ((isRecord(child.json.data) ? child.json.data.id : child.json.id) as
            | string
            | undefined)
        : undefined
      out.child = { status: child.status, id: childID }
      if (childID) {
        const c1 = await host.turn('Child turn: say hello.', {
          session: childID,
        })
        out.childTurn = c1.exit
      }
      // Reload locations: the old setup must be disposed before the new one serves.
      const reload = await host.api('POST', '/api/location/reload')
      out.reload = reload.status
      const t4 = await host.turn('Turn 4: after reload.', {
        session: sessionID,
      })
      out.t4 = t4.exit
      out.capturesAfterReload = (await host.control('/captures')).json
      // Delete the session: the plugin is told, and its capture is gone.
      const removed = await host.api('DELETE', `/api/session/${sessionID}`)
      out.deleted = removed.status
      await Bun.sleep(500)
      out.replayAfterDelete = (
        await host.control(`/replay-http?session=${sessionID}`)
      ).status
      const trace = host.trace()
      out.sequence = sequence(trace)
      out.deletedEvents = trace
        .filter((event) => event.hook === 'session.deleted')
        .map((event) =>
          event.sessionID === sessionID
            ? 'parent'
            : event.sessionID === childID
              ? 'child'
              : event.sessionID,
        )
      out.childEvidence = trace
        .filter(
          (event) =>
            event.sessionID === childID &&
            ['context', 'model.request'].includes(event.hook),
        )
        .map((event) => ({
          hook: event.hook,
          parentID: event.parentID,
          parentHeader:
            (event.headers as Record<string, string> | undefined)?.[
              'x-opencode-parent-session-id'
            ] ?? null,
        }))
      out.wire = host.records().map((record) => ({
        identity: record.identity,
        auth: record.headers.authorization,
        outcome: record.outcome,
        input: providerView(record.conversation),
      }))
      evidence('p6.http', out)

      const parse = (record: ProofRecord | undefined) =>
        JSON.parse(record?.raw ?? '{}') as Record<string, unknown>
      const all = host.records()
      const primary = parse(
        all
          .slice(0, recordsBefore)
          .findLast((record) => Array.isArray(parse(record).tools)),
      )
      const replay = parse(all[recordsBefore])
      // The replay got a complete answer, under the account that served the
      // turn, with the turn's cache key, tools and instructions and no cap.
      expect(out.replay1).toMatchObject({
        status: 200,
        completed: true,
        row: 'main',
      })
      expect(
        replayRecord.map((record) => record.headers.authorization),
      ).toEqual(['<bearer:A:seeded>'])
      expect(replay.store).toBe(false)
      expect(replay.prompt_cache_key).toBe(primary.prompt_cache_key)
      expect(replay.tools).toEqual(primary.tools)
      expect(replay.instructions).toBe(primary.instructions)
      expect(replay.input).toEqual(primary.input)
      expect('max_output_tokens' in replay).toBe(false)
      // The capture kept the cache headers but no credential.
      const kept = (out.replay1 as { headers: string[] }).headers
      for (const name of ['session-id', 'version', 'originator', 'thread-id'])
        expect(kept).toContain(name)
      expect(kept).not.toContain('authorization')
      expect(kept).not.toContain('chatgpt-account-id')
      // The host noticed nothing: no hook ran, no message was added.
      expect(out.hooksDuringReplay).toEqual(['replay', 'replay-result'])
      expect(out.messagesAfter).toEqual(out.messagesBefore)
      // The next real turn carries the conversation once, without the replay's answer.
      const next = all.find(
        (record) =>
          record.seq > (all[recordsBefore]?.seq ?? 0) &&
          providerView(record.conversation).at(-1) ===
            'user:"Turn 2: after the replay."',
      )
      const replayAnswer = `assistant:PROOF-REPLY-${all[recordsBefore]?.responseID?.slice(5)}`
      expect(providerView(next?.conversation)).toHaveLength(3)
      expect(providerView(next?.conversation)).not.toContain(replayAnswer)
      // A rotated token and a moved session are picked up through the pool.
      expect(out.replayRotatedWire).toEqual(['<bearer:A:rotated>'])
      expect(out.replayRepinned).toMatchObject({
        status: 200,
        completed: true,
        row: 'B',
      })
      expect(out.replayRepinnedWire).toEqual(['<bearer:B:seeded>'])
      // A subagent's parent is visible to the plugin before its request.
      expect(out.childEvidence).toEqual([
        { hook: 'context', parentID: sessionID, parentHeader: null },
        { hook: 'model.request', parentHeader: sessionID },
      ])
      // A location reload disposes the old setup before the new one serves,
      // and the new one starts with nothing captured from before.
      expect(out.reload).toBe(204)
      const lifecycle = trace
        .filter((event) => ['setup', 'dispose'].includes(event.hook))
        .map((event) => event.hook)
      expect(lifecycle).toEqual(['setup', 'dispose', 'setup'])
      expect(out.capturesAfterReload).toEqual({
        sessions: [sessionID],
        mirrors: [],
      })
      // Deleting the session reaches the plugin, child first, and ends its capture.
      expect(out.deleted).toBe(204)
      expect(out.deletedEvents).toEqual(['child', 'parent'])
      expect(out.replayAfterDelete).toBe(404)
    } finally {
      await host.stop()
    }
  }, 300_000)

  test('plugin HTTP keep-warm stays invisible, follows the captured account and stops on deletion or reload', async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'http',
      accounts: ['A', 'B'],
      used: { A: 5, B: 40 },
      keepWarm: true,
    })
    const tick = () => host.control('/cache-tick?advance=240000')
    const bodies = (records: ProofRecord[]) =>
      records
        .filter((r) => r.transport === 'http' && r.outcome !== undefined)
        .map((r) => ({ record: r, body: JSON.parse(r.raw ?? '{}') }))
    try {
      const first = await host.turn('Turn 1: say hello.')
      expect(first.exit).toBe(0)
      const sessionID = first.sessionID!
      const original = bodies(host.records()).findLast(({ body }) =>
        Array.isArray(body.tools),
      )!
      const before = await messageCount(host, sessionID)
      const hooks = host.trace().length
      const records = host.records().length
      expect((await tick()).json).toMatchObject({
        managers: 1,
        holders: [1],
        armed: 1,
        cleared: 0,
        status: [{ targets: [{ warmCount: 1, failures: 0 }] }],
      })
      const warms = bodies(host.records().slice(records))
      expect(warms).toHaveLength(1)
      const warm = warms[0]!
      expect(warm.record).toMatchObject({ identity: 'A', outcome: 'text' })
      expect(warm.body.store).toBe(false)
      expect(warm.body.prompt_cache_key).toBe(original.body.prompt_cache_key)
      expect(warm.body.input).toEqual(original.body.input)
      for (const cap of [
        'max_output_tokens',
        'max_tokens',
        'max_completion_tokens',
      ])
        expect(warm.body).not.toHaveProperty(cap)
      expect(host.trace().slice(hooks)).toEqual([])
      expect(await messageCount(host, sessionID)).toEqual(before)
      expect(
        (await host.turn('Turn 2: after plugin warm.', { session: sessionID }))
          .exit,
      ).toBe(0)
      const next = bodies(host.records()).findLast(({ body }) =>
        Array.isArray(body.tools),
      )!
      expect(providerView(next.body.input)).toEqual([
        'user:"Turn 1: say hello."',
        `assistant:PROOF-REPLY-${original.record.responseID?.slice(5)}`,
        'user:"Turn 2: after plugin warm."',
      ])
      // A recorded account change alone cannot replay an old capture on the
      // new account. Only the next real request may supply its prompt.
      await host.control(`/record-account?session=${sessionID}&account=B`)
      const moved = host.records().length
      const retired = await tick()
      expect(retired.json.status).toMatchObject([{ tracked: 0 }])
      expect(host.records()).toHaveLength(moved)
      host.mock.reject('A')
      expect(
        (await host.turn('Turn 3: move to B.', { session: sessionID })).exit,
      ).toBe(0)
      const capturedB = host.records().length
      await tick()
      expect(
        bodies(host.records().slice(capturedB)).map(
          ({ record }) => record.identity,
        ),
      ).toEqual(['B'])

      expect((await host.api('POST', '/api/location/reload')).status).toBe(204)
      expect(
        (await host.turn('Turn 4: after reload.', { session: sessionID })).exit,
      ).toBe(0)
      const reloaded = host.records().length
      expect((await tick()).json).toMatchObject({
        managers: 1,
        holders: [1],
        armed: 2,
        cleared: 1,
      })
      expect(
        bodies(host.records().slice(reloaded)).map(
          ({ record }) => record.identity,
        ),
      ).toEqual(['B'])
      expect(
        (await host.api('DELETE', `/api/session/${sessionID}`)).status,
      ).toBe(204)
      const deleted = host.records().length
      expect((await tick()).json.status).toMatchObject([{ tracked: 0 }])
      expect(host.records()).toHaveLength(deleted)
      evidence('plugin.http.keep-warm', {
        warm: warm.record,
        messages: before,
        lifecycle: (await host.control('/cache')).json,
      })
    } finally {
      await host.stop()
    }
  }, 300_000)

  test('the production frame mirror follows host tool, compaction and failover conversations without warming', async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'websocket',
      accounts: ['A', 'B'],
      used: { A: 5, B: 40 },
      pool: true,
      keepWarm: true,
      compaction: { auto: false, keep: { tokens: 1 } },
    })
    try {
      const first = await host.turn('Turn 1: USE-TOOL read the readme.')
      const sessionID = first.sessionID ?? ''
      const assertHead = async () => {
        const result = await host.control(`/frame-mirror?session=${sessionID}`)
        expect(result.status).toBe(200)
        const body = result.json.body as Record<string, unknown>
        const last = host
          .trace()
          .filter(
            (event) =>
              event.hook === 'context' && event.sessionID === sessionID,
          )
          .at(-1)
        const view = providerView(body.input as unknown[])
        expect(view.slice(0, -1)).toEqual(last?.view as string[])
        expect(view.at(-1)).toStartWith('assistant:')
        expect(body.stream).toBe(true)
        expect(body).not.toHaveProperty('type')
        expect(body).not.toHaveProperty('previous_response_id')
        const probe = await host.control(`/replay-ws?session=${sessionID}`)
        expect(body.input).toEqual(
          (probe.json.body as Record<string, unknown>).input,
        )
      }
      expect(first.exit).toBe(0)
      await assertHead()
      expect((await host.turn('Turn 2: hello.', { continue: true })).exit).toBe(
        0,
      )
      await assertHead()
      expect(await compact(host, sessionID)).toMatchObject({
        started: 200,
        waited: 204,
      })
      expect(
        (await host.turn('Turn 3: after compaction.', { continue: true })).exit,
      ).toBe(0)
      await assertHead()
      host.mock.reject('A')
      expect(
        (await host.turn('Turn 4: fail over.', { continue: true })).exit,
      ).toBe(0)
      await assertHead()
      expect(
        (await host.turn('Turn 5: new socket chain.', { continue: true })).exit,
      ).toBe(0)
      await assertHead()
      const beforeWarm = host.records().length
      const cache = await host.control('/cache-tick?advance=240000')
      expect(cache.json.status).toEqual([
        expect.objectContaining({ tracked: 0 }),
      ])
      expect(host.records().slice(beforeWarm)).toEqual([])
      expect(
        host
          .records()
          .filter((record) => record.action === 'handshake')
          .map((r) => r.identity),
      ).toEqual(['A', 'B'])
    } finally {
      await host.stop()
    }
  }, 300_000)

  test('P6: a WebSocket session as rebuilt from its frames', async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'websocket',
      accounts: ['A'],
      pool: true,
    })
    try {
      const out: Record<string, unknown> = {}
      const t1 = await host.turn('Turn 1: USE-TOOL read the readme.')
      const sessionID = t1.sessionID ?? ''
      await host.turn('Turn 2: say hello.', { continue: true })
      const rebuilt = (await host.control(`/replay-ws?session=${sessionID}`))
        .json
      const body = rebuilt.body as Record<string, unknown> | undefined
      out.rebuiltKeys = body ? Object.keys(body) : rebuilt
      out.rebuilt = providerView(body?.input as unknown[])
      const last = host
        .trace()
        .filter(
          (event) => event.hook === 'context' && event.sessionID === sessionID,
        )
        .at(-1)
      out.hostView = last?.view
      out.lastFrame = host
        .records()
        .filter((record) => record.action === 'frame')
        .map((record) => providerView(record.conversation))
        .at(-1)
      evidence('p6.ws', out)
      // The frames since the socket's first full send rebuild the whole
      // conversation: the host's last context plus the answer to it, as an
      // HTTP body (no `type`, no `previous_response_id`).
      const hostView = out.hostView as string[]
      const rebuiltView = out.rebuilt as string[]
      expect(rebuiltView.slice(0, -1)).toEqual(hostView)
      expect(rebuiltView.at(-1)).toStartWith('assistant:')
      expect(rebuiltView).toContain('call:call_2:read')
      expect(out.rebuiltKeys).not.toContain('type')
      expect(out.rebuiltKeys).not.toContain('previous_response_id')
      expect(body?.store).toBe(false)
    } finally {
      await host.stop()
    }
  }, 300_000)

  for (const transport of ['http', 'websocket'] as const) {
    test(`P6: OpenCode 2's own session warming on ${transport}`, async () => {
      const host = await startProofHost({
        cli,
        consumer,
        transport,
        accounts: ['A'],
        warming: { interval: '3 seconds', duration: '8 seconds' },
        keepWarm: true,
      })
      try {
        const out: Record<string, unknown> = {}
        const t1 = await host.turn('Turn 1: say hello.')
        const sessionID = t1.sessionID ?? ''
        out.messagesBefore = await messageCount(host, sessionID)
        await Bun.sleep(9000)
        out.messagesAfter = await messageCount(host, sessionID)
        const countAfterHostWarm = host.records().length
        expect(
          (await host.control('/cache-tick?advance=240000')).json.status,
        ).toMatchObject([{ tracked: 0 }])
        expect(host.records()).toHaveLength(countAfterHostWarm)
        const t2 = await host.turn('Turn 2: after warming.', { continue: true })
        out.t2 = t2.exit
        out.sequence = sequence(host.trace(), sessionID)
        out.wire = host.records().map((record) => ({
          transport: record.transport,
          action: record.action,
          identity: record.identity,
          previous: record.previous ?? null,
          outcome: record.outcome,
          input: providerView(record.conversation),
          body: (() => {
            try {
              const body = JSON.parse(record.raw ?? '{}')
              return {
                store: body.store,
                cacheKey: body.prompt_cache_key,
                tools: Array.isArray(body.tools) ? body.tools.length : null,
                instructions:
                  typeof body.instructions === 'string'
                    ? body.instructions.length
                    : null,
                reasoning: body.reasoning ?? null,
                capped: 'max_output_tokens' in body,
                toolChoice: body.tool_choice ?? null,
              }
            } catch {
              return null
            }
          })(),
        }))
        out.hostLog = host
          .hostLog()
          .split('\n')
          .filter((line) => /warm/i.test(line))
          .slice(0, 12)
        evidence(`p6.native.${transport}`, out)
        const keepAlive =
          'user:This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK'
        const wire = out.wire as Array<{
          transport: string
          action: string
          identity: string
          previous: string | null
          input: string[]
          body: Record<string, unknown> | null
        }>
        const warms = wire.filter((entry) => entry.input.at(-1) === keepAlive)
        const turns = wire.filter(
          (entry) =>
            entry.input.at(-1)?.startsWith('user:"Turn') &&
            entry.body?.tools !== null,
        )
        // The host warmed the session on its own, over HTTP on either
        // transport, as the session's pool account, with the turn's cache
        // key, tools and instructions and the whole conversation before a
        // short keep-alive prompt.
        expect(warms.length).toBeGreaterThanOrEqual(1)
        for (const warm of warms) {
          expect(warm.transport).toBe('http')
          expect(warm.identity).toBe('A')
          expect(warm.body?.cacheKey).toBe(turns[0]?.body?.cacheKey)
          expect(warm.body?.tools).toBe(turns[0]?.body?.tools)
          expect(warm.body?.instructions).toBe(turns[0]?.body?.instructions)
          expect(warm.input.slice(0, 2)).toEqual([
            'user:"Turn 1: say hello."',
            'assistant:PROOF-REPLY-2',
          ])
        }
        expect(
          host
            .trace()
            .filter(
              (event) =>
                event.hook === 'http.request' && event.sessionID === sessionID,
            )
            .map((event) => event.kind),
        ).toContain('generate')
        // Nothing was added to the session, and the next turn neither
        // repeats the keep-alive nor (on WebSocket) loses its chain.
        expect(out.messagesAfter).toEqual(out.messagesBefore)
        expect(out.t2).toBe(0)
        const after = turns.at(-1)
        expect(after?.input).toEqual([
          'user:"Turn 1: say hello."',
          'assistant:PROOF-REPLY-2',
          'user:"Turn 2: after warming."',
        ])
        if (transport === 'websocket') expect(after?.previous).not.toBeNull()
      } finally {
        await host.stop()
      }
    }, 300_000)
  }

  test('P5: what the plugin knows about a WebSocket request before its account is chosen', async () => {
    const host = await startProofHost({
      cli,
      consumer,
      transport: 'websocket',
      accounts: ['A', 'B'],
      used: { A: 10, B: 10 },
      thirdParty: { bytes: 20_000 },
      quota: false,
    })
    try {
      const big = `Session big: ${'lorem ipsum '.repeat(6000)}`
      const s1 = await host.turn(big)
      const s1b = await host.turn('Session big, continued.', {
        continue: true,
        session: s1.sessionID,
      })
      const s2 = await host.turn('Session small two.')
      const s3 = await host.turn('Session small three.')
      const trace = host.trace()
      const records = host.records()
      const calls = trace
        .filter((event) => event.hook === 'ws.handshake')
        .map((handshake) => {
          const before = trace.filter(
            (event) =>
              event.sessionID === handshake.sessionID &&
              event.seq < handshake.seq,
          )
          const context = before
            .filter((event) => event.hook === 'context')
            .at(-1)
          const modelRequest = before
            .filter((event) => event.hook === 'model.request')
            .at(-1)
          const send = trace.find(
            (event) =>
              event.hook === 'ws.send' &&
              event.sessionID === handshake.sessionID &&
              event.seq > handshake.seq,
          )
          return {
            sessionID: handshake.sessionID,
            order: [context?.seq, modelRequest?.seq, handshake.seq, send?.seq],
            contextBytes: context?.contextBytes,
            modelRequestFields:
              (modelRequest?.draftKeys as string[] | undefined) ?? [],
            frameBytes: send?.frameBytes,
            previous: send?.previous ?? null,
            account: (
              handshake.headers as Record<string, string> | undefined
            )?.['chatgpt-account-id'],
          }
        })
      evidence('p5', {
        exits: [s1.exit, s1b.exit, s2.exit, s3.exit],
        sessions: [s1.sessionID, s2.sessionID, s3.sessionID],
        calls,
        thirdParty: trace.filter(
          (event) => event.hook === 'third-party.context',
        ).length,
        frames: records
          .filter((record) => record.action === 'frame')
          .map((record) => ({
            identity: record.identity,
            bytes: record.raw?.length,
          })),
        handshakeFields: [
          ...new Set(
            trace
              .filter((event) => event.hook === 'ws.handshake')
              .flatMap(
                (event) => (event.draftKeys as string[] | undefined) ?? [],
              ),
          ),
        ],
      })
      expect([s1.exit, s1b.exit, s2.exit, s3.exit]).toEqual([0, 0, 0, 0])
      expect(calls.length).toBe(4)
      for (const call of calls) {
        // context, then model.request, then the handshake that picks the
        // account, and only then the frame: no body exists before the choice.
        const [context, modelRequest, handshake, send] = call.order as number[]
        expect(context).toBeLessThan(modelRequest as number)
        expect(modelRequest).toBeLessThan(handshake as number)
        expect(handshake).toBeLessThan(send as number)
        expect(call.modelRequestFields.sort()).toEqual([
          'agent',
          'baseURL',
          'headers',
          'kind',
          'model',
          'sessionID',
        ])
      }
      // The handshake draft carries a URL and headers, nothing sized.
      const draftFields = new Set(
        trace
          .filter((event) => event.hook === 'ws.handshake')
          .flatMap((event) => (event.draftKeys as string[] | undefined) ?? []),
      )
      expect(draftFields).toEqual(
        new Set(['sessionID', 'agent', 'model', 'kind', 'url', 'headers']),
      )
      // The other plugin's context growth reached every frame.
      expect(
        trace.filter((event) => event.hook === 'third-party.context').length,
      ).toBe(4)
      for (const record of records.filter((entry) => entry.action === 'frame'))
        expect(record.raw).toContain('THIRD-PARTY-CONTEXT')
      // Placement today counts sessions, not bytes: the small third session
      // joins the large first one on A although B carries only one small one.
      expect(calls.map((call) => call.account)).toEqual([
        'acct-A',
        'acct-A',
        'acct-B',
        'acct-A',
      ])
    } finally {
      await host.stop()
    }
  }, 300_000)
})
