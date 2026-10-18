import { describe, expect, spyOn, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { CACHE_KEEP_CAPS } from '../core/cachekeep'
import {
  acquireFrameMirror,
  FrameMirror,
  type FrameMirrorCapture,
} from '../v2/frame-mirror'

const user = (content: string) => ({ role: 'user', content })
const text = (content: string) => ({ role: 'assistant', content })
const full = (input: unknown[], fields = {}) =>
  JSON.stringify({
    type: 'response.create',
    model: 'gpt-5.5',
    input,
    ...fields,
  })
const delta = (previous: string, input: unknown[]) =>
  full(input, { previous_response_id: previous })
function complete(
  mirror: FrameMirror,
  sessionID: string,
  id: string,
  output: unknown[] = [],
  track?: (capture: FrameMirrorCapture) => void,
) {
  for (const item of output)
    mirror.receive(
      sessionID,
      JSON.stringify({ type: 'response.output_item.done', item }),
      track,
    )
  mirror.receive(
    sessionID,
    JSON.stringify({ type: 'response.completed', response: { id } }),
    track,
  )
}

function replay(mirror: FrameMirror, sessionID = 'ses') {
  const body = mirror.replay(sessionID)
  return body === undefined ? undefined : JSON.parse(body)
}

describe('OpenCode 2 frame mirror', () => {
  test('disabled mirroring does no JSON work and enabling recovers only at a full frame', () => {
    const mirror = new FrameMirror()
    const frames = [
      full([user('x'.repeat(2 * 1024 * 1024))]),
      delta('old', [user('delta')]),
    ]
    const events = [
      JSON.stringify({ type: 'response.created', response: { id: 'old' } }),
      JSON.stringify({
        type: 'response.output_item.done',
        item: text('answer'),
      }),
      JSON.stringify({ type: 'response.completed', response: { id: 'old' } }),
    ]
    const parse = spyOn(JSON, 'parse')
    const stringify = spyOn(JSON, 'stringify')
    try {
      for (let i = 0; i < 50; i++) {
        mirror.send('ses', frames[i % 2]!)
        for (const frame of events) mirror.receive('ses', frame)
      }
      expect(parse).not.toHaveBeenCalled()
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
      stringify.mockRestore()
    }
    mirror.setEnabled(true)
    mirror.send('ses', frames[1]!)
    complete(mirror, 'ses', 'delta')
    expect(replay(mirror)).toBeUndefined()
    mirror.send('ses', frames[0]!)
    complete(mirror, 'ses', 'full')
    expect(replay(mirror)).toBeDefined()
    mirror.send('pending', full([user('also clear pending')]))
    mirror.setEnabled(false)
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
    mirror.setEnabled(true)
    mirror.send('ses', delta('full', [user('no old baseline')]))
    complete(mirror, 'ses', 'lost')
    expect(replay(mirror)).toBeUndefined()
  })

  test('fifty output items never serialize the two MiB head and deltas are never parsed', () => {
    const mirror = new FrameMirror(true)
    mirror.send('ses', full([user('x'.repeat(2 * 1024 * 1024))]))
    complete(mirror, 'ses', 'r1')
    const sent = delta('r1', [user('next')])
    const created = JSON.stringify({
      type: 'response.created',
      response: { id: 'r2' },
    })
    const output = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({
        type: 'response.output_item.done',
        item: text(`item-${i}`),
      }),
    )
    const completed = JSON.stringify({
      type: 'response.completed',
      response: { id: 'r2' },
    })
    const deltaFrame = JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'tokens',
    })
    const stringify = JSON.stringify
    const lengths: number[] = []
    const spy = spyOn(JSON, 'stringify').mockImplementation(((
      ...args: Parameters<typeof JSON.stringify>
    ) => {
      const value = stringify(...args)
      lengths.push(value?.length ?? 0)
      return value
    }) as typeof JSON.stringify)
    try {
      mirror.send('ses', sent)
      mirror.receive('ses', created)
      for (const frame of output) mirror.receive('ses', frame)
      mirror.receive('ses', completed)
      expect(lengths.length).toBeGreaterThanOrEqual(50)
      expect(Math.max(...lengths)).toBeLessThan(1024)
      expect(lengths.reduce((sum, value) => sum + value, 0)).toBeLessThan(
        10_000,
      )
    } finally {
      spy.mockRestore()
    }
    mirror.send('ses', delta('r2', []))
    const parse = spyOn(JSON, 'parse')
    try {
      for (let i = 0; i < 50; i++) mirror.receive('ses', deltaFrame)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
    expect(replay(mirror)?.input).toHaveLength(52)
  })

  test('rebuilds tool, compaction, failover and new-socket resends with encrypted output intact', () => {
    const mirror = new FrameMirror(true)
    const tracked: FrameMirrorCapture[] = []
    const track = (capture: FrameMirrorCapture) => tracked.push(capture)
    const reasoning = {
      type: 'reasoning',
      encrypted_content: 'opaque-密文\\u1234',
    }
    const tool = {
      type: 'function_call',
      call_id: 'call',
      name: 'read',
      arguments: '{}',
    }
    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call',
      output: 'readme',
    }
    const fields = {
      instructions: 'system',
      tools: [{ type: 'function', name: 'read' }],
      stream: false,
    }
    let host: unknown[] = [user('use tool')]
    mirror.send('ses', full(host, fields))
    expect(replay(mirror)).toBeUndefined()
    complete(mirror, 'ses', 'r1', [reasoning, tool], track)
    host = [...host, reasoning, tool]
    expect(replay(mirror)).toEqual({
      model: 'gpt-5.5',
      ...fields,
      input: host,
      stream: true,
    })
    mirror.send('ses', delta('r1', [toolOutput]))
    complete(mirror, 'ses', 'r2', [text('done')], track)
    host = [...host, toolOutput, text('done')]
    expect(replay(mirror)?.input).toEqual(host)

    // HTTP compaction replaces the next full frame's context, not the old chain.
    host = [user('summary'), text('compacted'), user('after compaction')]
    mirror.send('ses', full(host, { instructions: 'new system' }))
    expect(replay(mirror)).toBeUndefined()
    complete(mirror, 'ses', 'r3', [text('three')], track)
    host = [...host, text('three')]
    expect(replay(mirror)?.input).toEqual(host)
    mirror.send('ses', delta('r3', [user('fail over')]))
    // The refused pending send is replaced by a full resend on another account.
    host = [...host, user('fail over')]
    mirror.send('ses', full(host))
    complete(mirror, 'ses', 'r4', [text('four')], track)
    host = [...host, text('four')]
    expect(replay(mirror)?.input).toEqual(host)
    mirror.send('ses', full(host))
    complete(mirror, 'ses', 'r5', [text('new socket')], track)
    expect(replay(mirror)?.input).toEqual([...host, text('new socket')])
    expect(tracked.map((capture) => capture.responseID)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ])
    expect(JSON.parse(tracked.at(-1)!.bodyText)).toEqual(replay(mirror))
    expect(replay(mirror)).not.toHaveProperty('type')
    expect(replay(mirror)).not.toHaveProperty('previous_response_id')
    expect(mirror.status().sessions).toEqual([
      expect.objectContaining({
        sessionID: 'ses',
        responseID: 'r5',
        pending: false,
      }),
    ])
  })

  test('tracks exactly once per completed response and ignores unrelated or duplicate events', () => {
    const mirror = new FrameMirror(true)
    const tracked: FrameMirrorCapture[] = []
    const track = (capture: FrameMirrorCapture) => tracked.push(capture)
    mirror.send('ses', full([user('hello')]))
    mirror.receive('ses', 'not json', track)
    mirror.receive(
      'ses',
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'not an item',
      }),
      track,
    )
    complete(mirror, 'ses', 'r1', [text('one')], track)
    expect(mirror.status().sessions[0]?.pending).toBe(false)
    complete(mirror, 'ses', 'r1', [], track)
    mirror.send('ses', delta('r1', [user('two')]))
    complete(mirror, 'ses', 'r1', [], track)
    complete(mirror, 'ses', 'r2', [text('two')], track)
    expect(tracked.map((capture) => capture.responseID)).toEqual(['r1', 'r2'])
    expect(replay(mirror)?.input).toEqual([
      user('hello'),
      text('one'),
      user('two'),
      text('two'),
    ])
  })

  test('an unavailable baseline stores no delta or output until a full frame recovers', () => {
    const mirror = new FrameMirror(true)
    const tracked: FrameMirrorCapture[] = []
    const track = (capture: FrameMirrorCapture) => tracked.push(capture)
    mirror.send('ses', full([user('old')]))
    complete(mirror, 'ses', 'old')
    for (const previous of ['missing', 'old', 'missing']) {
      mirror.send('ses', delta(previous, [user('must not retain')]))
      complete(mirror, 'ses', 'unknown', [text('also not retained')], track)
      expect(replay(mirror)).toBeUndefined()
      expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
    }
    expect(tracked).toEqual([])
    mirror.send('ses', full([user('recovered')]))
    complete(mirror, 'ses', 'new', [text('ok')], track)
    expect(replay(mirror)?.input).toEqual([user('recovered'), text('ok')])
    expect(tracked).toHaveLength(1)
    mirror.forget('ses')
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
  })

  test('response ids keep stale output and completion out of the pending send', () => {
    const mirror = new FrameMirror(true)
    const tracked: FrameMirrorCapture[] = []
    const track = (capture: FrameMirrorCapture) => tracked.push(capture)
    mirror.send('ses', full([user('hello')]))
    mirror.receive(
      'ses',
      JSON.stringify({ type: 'response.created', response: { id: 'live' } }),
    )
    mirror.receive(
      'ses',
      JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'stale',
        item: text('stale'),
      }),
    )
    complete(mirror, 'ses', 'stale', [], track)
    expect(tracked).toEqual([])
    expect(replay(mirror)).toBeUndefined()
    complete(mirror, 'ses', 'live', [text('live')], track)
    expect(replay(mirror)?.input).toEqual([user('hello'), text('live')])
    expect(tracked).toHaveLength(1)
  })

  test('completed head plus pending input and unfinished output share the byte budget', () => {
    const mirror = new FrameMirror(true)
    const tracked: FrameMirrorCapture[] = []
    const chunk = 'x'.repeat(Math.floor(CACHE_KEEP_CAPS.maxBytes / 4))
    mirror.send('ses', full([user(chunk)]))
    complete(mirror, 'ses', 'r1')
    mirror.send('ses', delta('r1', [user(chunk)]))
    mirror.receive(
      'ses',
      JSON.stringify({ type: 'response.output_item.done', item: text(chunk) }),
    )
    expect(mirror.status().sessions).toHaveLength(1)
    mirror.receive(
      'ses',
      JSON.stringify({ type: 'response.output_item.done', item: text(chunk) }),
    )
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
    complete(mirror, 'ses', 'r2', [], (capture) => tracked.push(capture))
    expect(tracked).toEqual([])
  })

  test('per-session byte cap drops oversized full frames, pending deltas and completed output', () => {
    const mirror = new FrameMirror(true)
    const huge = user('密'.repeat(Math.ceil(CACHE_KEEP_CAPS.maxBytes / 3)))
    mirror.send('safe', full([user('safe')]))
    complete(mirror, 'safe', 'safe')
    mirror.send('ses', full([huge]))
    expect(replay(mirror)).toBeUndefined()
    expect(mirror.status().sessions.map((s) => s.sessionID)).toEqual(['safe'])
    mirror.send('ses', full([user('small')]))
    complete(mirror, 'ses', 'r1')
    mirror.send('ses', delta('r1', [huge]))
    expect(mirror.status().sessions.map((s) => s.sessionID)).toEqual(['safe'])
    mirror.send('ses', full([user('small')]))
    complete(mirror, 'ses', 'r2', [huge])
    expect(mirror.status().sessions.map((s) => s.sessionID)).toEqual(['safe'])
    expect(mirror.status().bytes).toBeLessThanOrEqual(CACHE_KEEP_CAPS.maxBytes)
  })

  test('total byte cap evicts the least recently used session including pending sends', () => {
    const mirror = new FrameMirror(true)
    const chunk = user('x'.repeat(Math.floor(CACHE_KEEP_CAPS.maxBytes / 3)))
    for (const id of ['old', 'recent']) {
      mirror.send(id, full([chunk]))
      complete(mirror, id, id)
    }
    expect(replay(mirror, 'old')).toBeDefined()
    mirror.send('pending', full([chunk]))
    expect(mirror.status().sessions.map((s) => s.sessionID)).toEqual([
      'old',
      'pending',
    ])
    expect(replay(mirror, 'recent')).toBeUndefined()
    expect(mirror.status().bytes).toBeLessThanOrEqual(CACHE_KEEP_CAPS.maxBytes)
  })

  test('session count cap is LRU and keeps only one head and one pending send', () => {
    const mirror = new FrameMirror(true)
    for (let i = 0; i < CACHE_KEEP_CAPS.maxTargets; i++) {
      mirror.send(String(i), full([user('first')]))
      complete(mirror, String(i), `r${i}`)
    }
    mirror.send('0', delta('r0', [user('pending one')]))
    mirror.send('0', delta('r0', [user('pending replacement')]))
    mirror.send('extra', full([user('extra')]))
    expect(mirror.status().sessions).toHaveLength(CACHE_KEEP_CAPS.maxTargets)
    expect(replay(mirror, '1')).toBeUndefined()
    complete(mirror, '0', 'next')
    expect(replay(mirror, '0')?.input).toEqual([
      user('first'),
      user('pending replacement'),
    ])
    mirror.send('1', delta('r1', [user('evicted')]))
    expect(replay(mirror, '1')).toBeUndefined()
  })

  test('process registry shares a mirror only for the same resolved store paths', () => {
    const root = `.frame-mirror-${randomUUID()}`
    const paths = { configPath: `${root}/c.json`, statePath: `${root}/s.json` }
    const mirror = acquireFrameMirror(paths)
    mirror.setEnabled(true)
    const same = acquireFrameMirror({
      configPath: resolve(paths.configPath),
      statePath: resolve(paths.statePath),
    })
    expect(same).toBe(mirror)
    expect(
      acquireFrameMirror({ ...paths, statePath: `${root}/other.json` }),
    ).not.toBe(mirror)
    mirror.send('ses', full([user('shared')]))
    complete(same, 'ses', 'r1')
    expect(replay(mirror)?.input).toEqual([user('shared')])
    same.forget('ses')
    expect(replay(mirror)).toBeUndefined()
  })

  test('incremental bytes equal serialized payload bytes through every state transition and the exact cap boundary', () => {
    const mirror = new FrameMirror(true)
    const fields = { model: 'gpt-5.5', instructions: '密\\"' }
    const input = [user('雪'), user('escaped\\"')]
    const output = [
      text('🙂'),
      { type: 'reasoning', encrypted_content: '密文' },
    ]
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
    mirror.send('ses', full(input, fields))
    expect(mirror.status().bytes).toBe(
      size({ fields, pending: { input, output: [] } }),
    )
    mirror.receive(
      'ses',
      JSON.stringify({ type: 'response.created', response: { id: 'r密' } }),
    )
    expect(mirror.status().bytes).toBe(
      size({ fields, pending: { input, output: [], responseID: 'r密' } }),
    )
    for (const item of output)
      mirror.receive(
        'ses',
        JSON.stringify({ type: 'response.output_item.done', item }),
      )
    expect(mirror.status().bytes).toBe(
      size({ fields, pending: { input, output, responseID: 'r密' } }),
    )
    complete(mirror, 'ses', 'r密')
    const head = { responseID: 'r密', input: [...input, ...output] }
    expect(mirror.status().bytes).toBe(size({ fields, head }))
    const added = [user('next')]
    mirror.send('ses', delta('r密', added))
    expect(mirror.status().bytes).toBe(
      size({ fields, head, pending: { input: added, output: [] } }),
    )
    complete(mirror, 'ses', 'next')
    expect(mirror.status().bytes).toBe(
      size({
        fields,
        head: { responseID: 'next', input: [...head.input, ...added] },
      }),
    )
    mirror.forget('ses')
    expect(mirror.status().bytes).toBe(0)

    const overhead = size({
      fields: { model: 'gpt-5.5' },
      pending: { input: [user('')], output: [] },
    })
    mirror.send(
      'fits',
      full([user('x'.repeat(mirror.caps.maxBytes - overhead))]),
    )
    expect(mirror.status().bytes).toBe(mirror.caps.maxBytes)
    expect(mirror.status().sessions).toHaveLength(1)
    mirror.forget('fits')
    mirror.send(
      'over',
      full([user('x'.repeat(mirror.caps.maxBytes - overhead + 1))]),
    )
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
  })
})
