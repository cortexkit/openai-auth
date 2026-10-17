import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { PluginInput } from '@opencode-ai/plugin'
import { resetSettingsForTest } from '../config'
import { CODEX_USER_AGENT, CODEX_VERSION, CodexAuthPlugin } from '../index'
import { uuidV7 } from '../util/uuid-v7'
import {
  CodexHttpState,
  MidConversationEffort,
  rewriteCodexHttpRequest,
} from '../v2/codex-wire'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { createRequestTestScope } from './request-test-scope'
import { restoreEnv } from './setup-env'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(dump = false) {
  const files = poolFiles()
  seedPool(files, 'main-first', [{ id: 'main' }])
  const host = fakeOpenCode2Host()
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  if (dump) {
    for (const [key, value] of Object.entries({
      CORTEXKIT_OPENAI_AUTH_DUMP: '1',
      OPENCODE_OPENAI_AUTH_DUMP_DIR: join(files.dir, 'dumps'),
    })) {
      const previous = process.env[key]
      process.env[key] = value
      cleanups.push(() => restoreEnv(key, previous))
    }
    resetSettingsForTest()
    cleanups.push(resetSettingsForTest)
  }
  const stop = await setupOpenAIAuth(host.ctx, {
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
  return Object.assign(host, { files, stop })
}

const user = (text: string) => ({
  role: 'user',
  content: [{ type: 'input_text', text }],
})
function request(body: Record<string, unknown>) {
  return new Request('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${placeholderSecret('openai')}`,
      'content-type': 'application/json',
      'session-id': 'ses_1',
      'x-session-id': 'obsolete',
      'x-session-affinity': 'obsolete',
      'content-length': '999',
      'x-openai-auth-agent': 'build',
    },
    body: JSON.stringify(body),
  })
}

async function send(
  host: Awaited<ReturnType<typeof start>>,
  body: Record<string, unknown>,
) {
  const draft = { ...scope(), request: request(body) }
  await host.fire('http.request', draft)
  return draft.request
}

describe('OpenCode 2 HTTP shape', () => {
  for (const lite of [false, true]) {
    it(`captures host history before effort and Lite exactly once (Lite=${lite})`, async () => {
      const effort = new MidConversationEffort()
      const history = [user('one')]
      const turns: string[] = []
      for (const [index, input] of [
        history,
        history,
        [
          ...history,
          { type: 'function_call_output', call_id: 'c', output: 'ok' },
        ],
      ].entries()) {
        const emitted = await rewriteCodexHttpRequest(
          request({
            model: 'gpt-6.1-sol',
            input,
            reasoning: { effort: index === 0 ? 'low' : 'high' },
          }),
          scope(),
          effort,
          lite,
        )
        turns.push(
          JSON.parse(emitted!.headers.get('x-codex-turn-metadata')!).turn_id,
        )
        const body = await emitted!.json()
        expect(
          body.input.filter(
            (item: { type: string }) => item.type === 'configuration_update',
          ),
        ).toHaveLength(index === 0 ? 0 : 1)
        expect(
          body.input.filter(
            (item: { type: string }) => item.type === 'additional_tools',
          ),
        ).toHaveLength(lite ? 1 : 0)
        expect(body.reasoning.effort).toBe('low')
      }
      expect(new Set(turns).size).toBe(1)
    })
  }
  it('always shapes an owned request without effort, Lite or output-cap changes', async () => {
    const host = await start()
    const emitted = await send(host, {
      stream: true,
      input: [user('one')],
      model: 'gpt-5.5',
    })
    const body = await emitted.json()
    const thread = emitted.headers.get('thread-id')
    expect(thread).toMatch(/^[\da-f-]{36}$/)
    expect(emitted.headers.get('session-id')).toBe(thread)
    expect(emitted.headers.get('x-client-request-id')).toBe(thread)
    expect(emitted.headers.get('x-codex-window-id')).toBe(`${thread}:0`)
    expect(emitted.headers.get('accept')).toBe('text/event-stream')
    expect(emitted.headers.get('originator')).toBe('codex_exec')
    expect(emitted.headers.get('version')).toBe(CODEX_VERSION)
    expect(emitted.headers.get('user-agent')).toBe(CODEX_USER_AGENT)
    expect(emitted.headers.get('authorization')).toBe('Bearer main-token')
    expect(emitted.headers.get('x-codex-beta-features')).toBe(
      'terminal_resize_reflow',
    )
    for (const name of [
      'x-session-id',
      'x-session-affinity',
      'content-length',
      'x-openai-auth-agent',
    ])
      expect(emitted.headers.has(name)).toBe(false)
    expect(body.prompt_cache_key).toBe(thread)
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.tools).toBeUndefined()
    expect(body.input).toEqual([user('one')])
    expect(Object.keys(body)).toEqual([
      'model',
      'input',
      'parallel_tool_calls',
      'stream',
      'prompt_cache_key',
      'client_metadata',
    ])
  })

  it('keeps the handshake host session id while HTTP uses the thread id and response attribution survives', async () => {
    const host = await start(true)
    const handshake = {
      ...scope(),
      url: 'wss://api.openai.com/v1/responses',
      headers: {
        authorization: `Bearer ${placeholderSecret('openai')}`,
      } as Record<string, string>,
    }
    await host.fire('experimental.ws.handshake', handshake)
    expect(handshake.headers['session-id']).toBe('ses_1')
    expect(handshake.headers['thread-id']).toBeUndefined()
    expect(handshake.headers['x-codex-turn-metadata']).toBeUndefined()
    const emitted = await send(host, { model: 'gpt-5.5', input: [user('one')] })
    expect(emitted.headers.get('session-id')).toBe(
      emitted.headers.get('thread-id'),
    )
    expect(emitted.headers.get('session-id')).not.toBe('ses_1')
    const received = {
      ...scope(),
      request: emitted,
      response: new Response('data: {"error":"main-token"}\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-primary-used-percent': '23',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-after-seconds': '3600',
        },
      }),
    }
    await host.fire('http.response', received)
    expect(await received.response.text()).toBe(
      'data: {"error":"[credential]"}\n\n',
    )
    const dumpDir = join(host.files.dir, 'dumps')
    const records = readdirSync(dumpDir).filter((name) =>
      name.endsWith('.meta.json'),
    )
    expect(records).toHaveLength(1)
    const meta = JSON.parse(readFileSync(join(dumpDir, records[0]!), 'utf8'))
    expect(meta.session).toBe('ses_1')
    expect(meta.status).toBe(200)
    const again = {
      ...scope(),
      url: handshake.url,
      headers: {
        authorization: `Bearer ${placeholderSecret('openai')}`,
      } as Record<string, string>,
    }
    await host.fire('experimental.ws.handshake', again)
    expect(again.headers).toEqual(handshake.headers)
    await host.stop?.()
    expect(
      host.files
        .readConfig()
        .commonAuthPool.rows.main?.quota?.limits?.some(
          (limit) => limit.usedPercent === 23,
        ),
    ).toBe(true)
  })

  it('normalizes only function tools, preserves extras and never adds hosted search', async () => {
    const host = await start()
    const emitted = await send(host, {
      model: 'gpt-5.5',
      input: [user('one')],
      tools: [
        {
          name: 'read',
          type: 'function',
          description: 'Read',
          parameters: { $schema: 'dialect', type: 'object' },
          extension: 42,
        },
        { type: 'function', name: 'strict', strict: true, parameters: {} },
        { type: 'custom', name: 'third_party', format: { type: 'text' } },
      ],
    })
    const body = await emitted.json()
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read',
        strict: false,
        parameters: { type: 'object' },
        extension: 42,
      },
      { type: 'function', name: 'strict', strict: true, parameters: {} },
      { type: 'custom', name: 'third_party', format: { type: 'text' } },
    ])
    expect(Object.keys(body.tools[0])).toEqual([
      'type',
      'name',
      'description',
      'strict',
      'parameters',
      'extension',
    ])
    expect(
      body.tools.some((tool: { type: string }) => tool.type === 'web_search'),
    ).toBe(false)
  })
})

// Compare actual OpenCode 1 fetch bytes with the final OpenCode 2 hook draft,
// not two invocations of the shared builder. No header is silently ignored.
const ORACLE_HEADERS = new Set([
  'originator',
  'accept',
  'session-id',
  'thread-id',
  'x-codex-window-id',
  'x-client-request-id',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
  'user-agent',
  'version',
  'x-openai-internal-codex-responses-lite',
  'authorization',
  'chatgpt-account-id',
])
const HEADER_ALLOWLIST: Record<string, string> = {
  'content-type':
    'Both hosts supply the JSON media type before the plugin runs.',
}

for (const lite of [false, true]) {
  for (const capped of [false, true]) {
    it(`S6 oracle matches final OpenCode 1 bytes (Lite=${lite}, cap=${capped})`, async () => {
      const work = createRequestTestScope()
      work.capturePluginWork()
      const files = poolFiles()
      cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
      const env = {
        OPENCODE_CONFIG_DIR: files.dir,
        OPENCODE_OPENAI_AUTH_FILE: files.configPath,
        OPENCODE_OPENAI_AUTH_STATE_FILE: files.statePath,
        OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE: join(
          files.dir,
          'sidebar.json',
        ),
        CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE: lite ? '1' : '0',
        CORTEXKIT_OPENAI_AUTH_DUMP: '0',
      }
      for (const [key, value] of Object.entries(env)) {
        const previous = process.env[key]
        process.env[key] = value
        cleanups.push(() => restoreEnv(key, previous))
      }
      resetSettingsForTest()
      cleanups.push(resetSettingsForTest)
      const clock = spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
      const installationID = '00000000-0000-4000-8000-000000000001'
      const installation = spyOn(crypto, 'randomUUID').mockReturnValue(
        installationID,
      )
      let counter = 0
      const random = spyOn(crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView | null>(array: T): T => {
          if (!array) throw new Error('missing random buffer')
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
            ++counter,
          )
          return array
        },
      )
      cleanups.push(() => {
        random.mockRestore()
        installation.mockRestore()
        clock.mockRestore()
      })
      seedPool(files, 'main-first', [{ id: 'main' }])
      const sent: Array<{ headers: Headers; body: string }> = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          if (String(url).includes('/responses'))
            sent.push({
              headers: new Headers(init?.headers),
              body: String(init?.body),
            })
          return new Response('{}', { status: 200 })
        },
        { preconnect: () => {} },
      ) as typeof fetch
      cleanups.push(() => {
        globalThis.fetch = originalFetch
      })
      cleanups.push(async () => {
        await work.teardown(async () => {})
      })
      const hooks = work.ownPlugin(
        await CodexAuthPlugin(
          {
            client: {
              auth: { set: async () => {} },
              session: { promptAsync: async () => {} },
            },
            project: { id: 'oracle', name: 'oracle' },
            directory: files.dir,
            worktree: files.dir,
            experimental_workspace: { register: () => {} },
            serverUrl: new URL('http://localhost:0'),
            $: {},
          } as unknown as PluginInput,
          { experimentalWebSockets: false, responsesLite: lite },
        ),
      )
      const loaded = await hooks.auth!.loader!(
        async () => ({
          type: 'oauth',
          access: 'main-token',
          refresh: 'main-refresh',
          expires: Date.now() + 3_600_000,
          accountId: 'chatgpt-main',
        }),
        { id: 'openai', models: {} } as never,
      )
      const fetchOne = (loaded as { fetch: typeof fetch }).fetch
      const host = fakeOpenCode2Host()
      const stop = await setupOpenAIAuth(host.ctx, {
        paths: files.paths,
        heartbeat: false,
        sidebarStateFile: join(files.dir, 'sidebar2.json'),
        codex: new CodexHttpState(
          { now: Date.now, uuid: uuidV7 },
          installationID,
        ),
        fetch: originalFetch,
        vault: {
          stateDir: join(files.dir, 'vault2'),
          connectionFile: () => join(files.dir, 'no-vault'),
          pollIntervalMs: 0,
        },
      })
      cleanups.push(async () => {
        await stop?.()
      })
      const first = [user('one')]
      const generated = [user('generate task')]
      const tool = [
        ...generated,
        { type: 'function_call', name: 'read', call_id: 'c', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: 'ok' },
      ]
      const sequence = [
        { kind: 'primary', input: first },
        { kind: 'title', input: [user('name this session')] },
        { kind: 'compaction', input: [user('summarize this session')] },
        { kind: 'generate', input: generated },
        { kind: 'primary', input: tool },
        { kind: 'primary', input: [...tool, user('two')] },
      ] as const
      const bodies = sequence.map((step) => ({
        stream: true,
        input: step.input,
        model: 'gpt-6.1-sol',
        instructions: 'Be brief',
        tools: [
          {
            name: 'read',
            type: 'function',
            parameters: { $schema: 'dialect', type: 'object' },
          },
          { type: 'custom', name: 'third-party', format: { type: 'text' } },
        ],
        reasoning: { effort: 'low' },
        client_metadata: { extra: 'preserved' },
        ...(capped ? { max_output_tokens: 1024 } : {}),
      }))
      counter = 0
      for (let i = 0; i < sequence.length; i++) {
        const source = request(bodies[i]!)
        source.headers.set(
          'x-openai-auth-agent',
          sequence[i]!.kind === 'primary' ? 'build' : sequence[i]!.kind,
        )
        await work.wrap(fetchOne)(source.url, {
          method: source.method,
          headers: source.headers,
          body: await source.text(),
        })
      }
      expect(sent).toHaveLength(6)
      counter = 0
      const turns: string[] = []
      for (let i = 0; i < sequence.length; i++) {
        const draft = {
          ...scope('ses_1', sequence[i]!.kind),
          request: request(bodies[i]!),
        }
        draft.request.headers.set(
          'x-openai-auth-agent',
          sequence[i]!.kind === 'primary' ? 'build' : sequence[i]!.kind,
        )
        await host.fire('http.request', draft)
        const expected = sent[i]!
        const actualHeaders = draft.request.headers
        for (const name of new Set([
          ...expected.headers.keys(),
          ...actualHeaders.keys(),
        ])) {
          expect(ORACLE_HEADERS.has(name) || name in HEADER_ALLOWLIST).toBe(
            true,
          )
          expect({ [name]: actualHeaders.get(name) }).toEqual({
            [name]: expected.headers.get(name),
          })
        }
        expect(actualHeaders.get('authorization')).toBe('Bearer main-token')
        expect(actualHeaders.get('chatgpt-account-id')).toBe('chatgpt-main')
        const expectedBody = JSON.parse(expected.body)
        if (capped) delete expectedBody.max_output_tokens
        expect(await draft.request.text()).toBe(
          capped ? JSON.stringify(expectedBody) : expected.body,
        )
        turns.push(
          JSON.parse(actualHeaders.get('x-codex-turn-metadata')!).turn_id,
        )
      }
      expect(new Set(turns.slice(0, 4)).size).toBe(4)
      expect(turns[4]).toBe(turns[3])
      expect(turns[5]).not.toBe(turns[4])
    })
  }
}
