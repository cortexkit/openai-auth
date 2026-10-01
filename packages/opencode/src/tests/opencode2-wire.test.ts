// What openai-auth changes in OpenCode 2's own OpenAI requests: the Codex
// client identity, the mid-conversation effort rule on HTTP bodies and
// WebSocket frames, and Responses Lite on HTTP (`v2/codex-wire.ts`), checked
// on the rewrite functions and through the real setup on a fake host.

import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { CODEX_USER_AGENT, CODEX_VERSION } from '../index'
import {
  CODEX_CLIENT_HEADERS,
  MidConversationEffort,
  RESPONSES_LITE_HEADER,
  rewriteCodexFrame,
  rewriteCodexHttpRequest,
} from '../v2/codex-wire'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  type RequestKind,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const SESSION = { sessionID: 'ses_1', kind: 'primary' }

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
const call = {
  type: 'function_call',
  call_id: 'c1',
  name: 'x',
  arguments: '{}',
}
const output = { type: 'function_call_output', call_id: 'c1', output: 'ok' }
const update = (effort: string) => ({
  type: 'configuration_update',
  reasoning: { effort },
})

function frame(
  effort: string,
  input: unknown[],
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: 'response.create',
    model: 'gpt-6.1-sol',
    input,
    instructions: 'be brief',
    tools: [{ type: 'function', name: 'x' }],
    reasoning: { effort, summary: 'auto' },
    ...extra,
  })
}

function httpBody(
  effort: string,
  input: unknown[],
  extra: Record<string, unknown> = {},
) {
  return new Request('https://codex.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6.1-sol',
      input,
      instructions: 'be brief',
      tools: [{ type: 'function', name: 'x' }],
      reasoning: { effort, summary: 'auto' },
      ...extra,
    }),
  })
}

describe('mid-conversation effort on WebSocket frames', () => {
  it('pins the first effort, then adds the update before the new user message of an incremental frame and changes nothing else', () => {
    const effort = new MidConversationEffort()
    expect(
      rewriteCodexFrame(frame('low', [user('one')]), SESSION, effort),
    ).toBe(undefined)
    const incremental = frame('high', [user('two')], {
      previous_response_id: 'resp_1',
    })
    const rewritten = JSON.parse(
      rewriteCodexFrame(incremental, SESSION, effort) ?? 'null',
    )
    expect(rewritten).toEqual({
      ...JSON.parse(incremental),
      reasoning: { effort: 'low', summary: 'auto' },
      input: [update('high'), user('two')],
    })
    // The field order the host sent is kept.
    expect(Object.keys(rewritten)).toEqual(Object.keys(JSON.parse(incremental)))
  })

  it('keeps the pinned effort on a tool-output frame without adding the update again', () => {
    const effort = new MidConversationEffort()
    rewriteCodexFrame(frame('low', [user('one')]), SESSION, effort)
    const toolStep = frame('high', [output], { previous_response_id: 'resp_2' })
    expect(
      JSON.parse(rewriteCodexFrame(toolStep, SESSION, effort) ?? 'null'),
    ).toEqual({
      ...JSON.parse(toolStep),
      reasoning: { effort: 'low', summary: 'auto' },
    })
  })

  it('puts the update before the last user message of a full frame', () => {
    const effort = new MidConversationEffort()
    rewriteCodexFrame(frame('low', [user('one')]), SESSION, effort)
    const full = frame('high', [
      user('one'),
      assistant('a'),
      user('two'),
      call,
      output,
    ])
    expect(
      JSON.parse(rewriteCodexFrame(full, SESSION, effort) ?? 'null').input,
    ).toEqual([
      user('one'),
      assistant('a'),
      update('high'),
      user('two'),
      call,
      output,
    ])
  })

  it('never places an update right after another one', () => {
    const effort = new MidConversationEffort()
    rewriteCodexFrame(frame('low', [user('one')]), SESSION, effort)
    const already = frame('high', [update('xhigh'), user('two')])
    expect(
      JSON.parse(rewriteCodexFrame(already, SESSION, effort) ?? 'null').input,
    ).toEqual([update('xhigh'), user('two')])
  })

  it('leaves frames of other models, other request kinds and an unchanged effort alone', () => {
    const effort = new MidConversationEffort()
    rewriteCodexFrame(frame('low', [user('one')]), SESSION, effort)
    expect(
      rewriteCodexFrame(frame('low', [user('two')]), SESSION, effort),
    ).toBe(undefined)
    expect(
      rewriteCodexFrame(
        frame('high', [user('two')], { model: 'gpt-5.5' }),
        SESSION,
        effort,
      ),
    ).toBe(undefined)
    // OpenCode 2 carries an effort change for the gpt-6 models itself.
    for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
      expect(
        rewriteCodexFrame(
          frame('high', [user('two')], { model }),
          SESSION,
          effort,
        ),
      ).toBe(undefined)
    // A title request neither pins nor is rewritten.
    const title = { sessionID: 'ses_2', kind: 'title' }
    expect(rewriteCodexFrame(frame('low', [user('t')]), title, effort)).toBe(
      undefined,
    )
    expect(rewriteCodexFrame(frame('high', [user('t')]), title, effort)).toBe(
      undefined,
    )
    expect(
      rewriteCodexFrame(frame('high', [user('one')]), SESSION, effort),
    ).not.toBe(undefined)
  })

  it('starts over for a forgotten session', () => {
    const effort = new MidConversationEffort()
    rewriteCodexFrame(frame('low', [user('one')]), SESSION, effort)
    effort.forget(SESSION.sessionID)
    expect(
      rewriteCodexFrame(frame('high', [user('two')]), SESSION, effort),
    ).toBe(undefined)
  })
})

describe('mid-conversation effort and Responses Lite on HTTP', () => {
  it('carries the update on every request after a change, before the turn user message', async () => {
    const effort = new MidConversationEffort()
    expect(
      await rewriteCodexHttpRequest(
        httpBody('low', [user('one')]),
        SESSION,
        effort,
        false,
      ),
    ).toBe(undefined)
    const turn = await rewriteCodexHttpRequest(
      httpBody('high', [user('one'), assistant('a'), user('two')]),
      SESSION,
      effort,
      false,
    )
    const step = await rewriteCodexHttpRequest(
      httpBody('high', [
        user('one'),
        assistant('a'),
        user('two'),
        call,
        output,
      ]),
      SESSION,
      effort,
      false,
    )
    const turnBody = await turn?.json()
    const stepBody = await step?.json()
    expect(turnBody.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(turnBody.input).toEqual([
      user('one'),
      assistant('a'),
      update('high'),
      user('two'),
    ])
    expect(stepBody.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(stepBody.input).toEqual([
      user('one'),
      assistant('a'),
      update('high'),
      user('two'),
      call,
      output,
    ])
    expect(turn?.headers.get(RESPONSES_LITE_HEADER)).toBe(null)
  })

  it('sends a Lite model in the Lite shape with its header when the setting is on', async () => {
    const request = () =>
      httpBody('low', [user('one')], {
        model: 'gpt-5.6-luna',
        parallel_tool_calls: true,
      })
    const effort = new MidConversationEffort()
    expect(
      await rewriteCodexHttpRequest(request(), SESSION, effort, false),
    ).toBe(undefined)
    const lite = await rewriteCodexHttpRequest(request(), SESSION, effort, true)
    expect(lite?.headers.get(RESPONSES_LITE_HEADER)).toBe('true')
    const body = await lite?.json()
    expect(body.tools).toBe(undefined)
    expect(body.instructions).toBe(undefined)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.reasoning.context).toBe('all_turns')
    expect(body.input).toEqual([
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'function', name: 'x' }],
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'be brief' }],
      },
      user('one'),
    ])
    // A model not marked Lite keeps the standard shape.
    expect(
      await rewriteCodexHttpRequest(
        httpBody('low', [user('one')], { model: 'gpt-5.5' }),
        SESSION,
        effort,
        true,
      ),
    ).toBe(undefined)
  })

  it('leaves requests to other endpoints alone', async () => {
    const effort = new MidConversationEffort()
    const other = new Request('https://codex.test/v1/models', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-luna' }),
    })
    expect(await rewriteCodexHttpRequest(other, SESSION, effort, true)).toBe(
      undefined,
    )
  })
})

describe('through the OpenCode 2 entry', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function start() {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    const host = fakeOpenCode2Host()
    const stop = await setupOpenAIAuth(host.ctx, {
      paths: files.paths,
      slot: opencode1HostSlot(join(files.dir, 'auth.json')),
      fence: async () => ({ open: true }),
      heartbeat: false,
      fetch: (async () => {
        throw new Error('offline in tests')
      }) as unknown as typeof fetch,
    })
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    cleanups.push(async () => {
      await stop?.()
    })
    return host
  }

  const draftScope = (kind: RequestKind = 'primary') => ({
    ...scope('ses_1', kind),
    model: { providerID: 'openai', id: 'gpt-6.1-sol' },
  })

  it('sends the Codex client identity with the credential, the same on every request', async () => {
    expect(CODEX_CLIENT_HEADERS).toEqual({
      version: CODEX_VERSION,
      'user-agent': CODEX_USER_AGENT,
      originator: 'codex_exec',
    })
    const host = await start()
    const seen: Array<Record<string, string>> = []
    for (let turn = 0; turn < 2; turn++) {
      const draft = {
        ...draftScope(),
        headers: {
          authorization: `Bearer ${PLACEHOLDER}`,
          'User-Agent': 'opencode/latest/2.0.21/cli',
        } as Record<string, string>,
      }
      await host.fire('model.request', draft)
      seen.push(draft.headers)
    }
    for (const headers of seen) {
      expect(headers.authorization).toBe('Bearer main-token')
      expect(headers.version).toBe(CODEX_VERSION)
      expect(headers.originator).toBe('codex_exec')
      // The host's own spelling of the name is replaced, not doubled.
      expect(headers['user-agent']).toBe(CODEX_USER_AGENT)
      expect(headers['User-Agent']).toBe(undefined)
    }
    expect(seen[1]).toEqual(seen[0] as Record<string, string>)
  })

  it('rewrites WebSocket frames and HTTP bodies through the hooks', async () => {
    const host = await start()
    const send = async (text: string) => {
      const draft = { ...draftScope(), frame: text }
      await host.fire('experimental.ws.send', draft)
      return draft.frame
    }
    expect(await send(frame('low', [user('one')]))).toBe(
      frame('low', [user('one')]),
    )
    expect(
      JSON.parse(
        await send(frame('high', [user('two')], { previous_response_id: 'r' })),
      ).input,
    ).toEqual([update('high'), user('two')])

    await host.fire('model.request', {
      ...draftScope(),
      headers: {} as Record<string, string>,
    })
    const draft = {
      ...draftScope(),
      request: httpBody('high', [user('one'), assistant('a'), user('three')]),
    }
    await host.fire('http.request', draft)
    const body = await draft.request.json()
    expect(body.reasoning.effort).toBe('low')
    expect(body.input).toContainEqual(update('high'))
    expect(draft.request.headers.get('authorization')).toBe('Bearer main-token')
    expect(draft.request.headers.get('originator')).toBe('codex_exec')
  })
})
