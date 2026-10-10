import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'

import {
  DEFAULT_CODEX_API_ENDPOINT,
  getSettings,
  refreshSettings,
  resetSettingsForTest,
} from '../config'
import { dumpCodexRequest, resetDumpStateForTest } from '../dump'
import { CodexAuthPlugin, rewriteResponsesLiteBody } from '../index'
import { createRequestTestScope } from './request-test-scope'

const scope = createRequestTestScope()
const test = scope.it
const plugins = new Set<Awaited<ReturnType<typeof CodexAuthPlugin>>>()

beforeEach(() => scope.capturePluginWork())
afterEach(async () => {
  await scope.teardown(async () => {
    plugins.clear()
  })
})

async function disposePluginWork() {
  // Loader timers resolve account paths and fetch lazily. Stop them and drain
  // submitted work while the network and paths still belong to this fixture.
  for (const hooks of plugins) await hooks.dispose?.()
  await scope.settlePluginWork()
}

describe('request dumps', () => {
  test('disposes every dump loader before restoring the shared network and account paths', async () => {
    const originalFetch = globalThis.fetch
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const timers = new Set<ReturnType<typeof setInterval>>()
    const stopped: Array<{
      fetch: typeof globalThis.fetch
      config: string | undefined
    }> = []
    const fixtureFetch = Object.assign(
      async () => new Response('unavailable', { status: 503 }),
      { preconnect: () => {} },
    ) as typeof globalThis.fetch
    let fixtureConfig: string | undefined
    try {
      await withDumpEnv(async () => {
        globalThis.fetch = fixtureFetch
        fixtureConfig = process.env.OPENCODE_OPENAI_AUTH_FILE
        for (let index = 0; index < 2; index++) {
          const hooks = await dumpPlugin({
            experimentalWebSockets: false,
            backgroundQuota: {
              setIntervalFn: () => {
                const timer = {} as ReturnType<typeof setInterval>
                timers.add(timer)
                return timer
              },
              clearIntervalFn: (timer) => {
                timers.delete(timer)
                stopped.push({
                  fetch: globalThis.fetch,
                  config: process.env.OPENCODE_OPENAI_AUTH_FILE,
                })
              },
            },
          })
          await pluginFetch(hooks)
        }
        expect(timers.size).toBe(2)
      })
      expect(timers.size).toBe(0)
      expect(stopped).toEqual([
        { fetch: fixtureFetch, config: fixtureConfig },
        { fetch: fixtureFetch, config: fixtureConfig },
      ])
      expect(process.env.OPENCODE_OPENAI_AUTH_FILE).toBe(originalConfigFile)
    } finally {
      await disposePluginWork()
      globalThis.fetch = originalFetch
    }
  })

  test('Responses Lite removes image details without mutating host items', () => {
    const image = {
      type: 'input_image',
      image_url: 'data:image/png;base64,AA==',
      detail: 'high',
    }
    const text = { type: 'input_text', text: 'inspect' }
    const message = { role: 'user', content: [text, image] }
    const reasoning = { type: 'reasoning', summary: [] }
    const input = [message, reasoning]
    const parsed: Record<string, unknown> = { input }
    rewriteResponsesLiteBody(parsed)
    expect(image.detail).toBe('high')
    expect(input[0]).toBe(message)
    const sent = parsed.input as Array<Record<string, any>>
    expect(sent[1]).not.toBe(message)
    expect(sent[1]!.content[1]).not.toBe(image)
    expect(sent[1]!.content[1]).not.toHaveProperty('detail')
    expect(sent[1]!.content[0]).toBe(text)
    expect(sent[2]).toBe(reasoning)
  })

  test('Responses Lite image histories keep HTTP turns below and above the cache cap', async () => {
    await withDumpEnv(async () => {
      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '0'
      resetSettingsForTest()
      const originalFetch = globalThis.fetch
      const turns: string[] = []
      const bodies: Array<Record<string, unknown>> = []
      globalThis.fetch = Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          turns.push(
            JSON.parse(new Headers(init?.headers).get('x-codex-turn-metadata')!)
              .turn_id,
          )
          bodies.push(JSON.parse(String(init?.body)))
          return new Response('ok')
        },
        { preconnect: () => {} },
      )
      try {
        const hooks = await dumpPlugin({
          experimentalWebSockets: false,
          responsesLite: true,
        })
        const fetch = await pluginFetch(hooks)
        try {
          for (const count of [2, 513]) {
            const input = [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_image',
                    image_url: 'data:image/png;base64,AA==',
                    detail: 'high',
                  },
                ],
              },
              ...Array.from({ length: count - 1 }, (_, i) => ({
                type: 'function_call_output',
                call_id: `call_${i}`,
                output: 'ok',
              })),
            ]
            for (const history of [
              input,
              [
                ...input,
                {
                  type: 'function_call_output',
                  call_id: 'last',
                  output: 'next',
                },
              ],
            ]) {
              await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: { 'x-session-affinity': `lite-images-${count}` },
                body: JSON.stringify({
                  ...toolRequestBody(),
                  model: 'gpt-6-astra',
                  input: history,
                }),
              })
            }
            expect(turns.at(-1)).toBe(turns.at(-2))
          }
          expect(bodies).toHaveLength(4)
          for (const sent of bodies)
            expect(JSON.stringify(sent.input)).not.toContain('"detail"')
        } finally {
          await hooks.dispose?.()
        }
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  test('does not serialize lazy bodies when dumps are disabled', async () => {
    await withDumpEnv(async () => {
      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '0'
      resetSettingsForTest()
      let serialized = 0
      for (const phase of ['prewarm', 'main'] as const) {
        await dumpCodexRequest({
          sessionID: 'disabled-lazy',
          transport: 'websocket',
          phase,
          bodyText: () => {
            serialized++
            return JSON.stringify(toolRequestBody())
          },
        })
      }
      expect(serialized).toBe(0)
    })
  })

  test('lazy enabled dumps preserve body bytes and prewarm main order', async () => {
    await withDumpEnv(async (dumpDir) => {
      const payload = {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'read', type: 'function' }],
        extra: 'last',
      }
      const text = JSON.stringify(payload)
      const order: string[] = []
      for (const phase of ['prewarm', 'main'] as const) {
        await dumpCodexRequest({
          sessionID: 'eager',
          transport: 'websocket',
          phase,
          bodyText: text,
        })
        await dumpCodexRequest({
          sessionID: 'lazy',
          transport: 'websocket',
          phase,
          bodyText: () => {
            order.push(phase)
            return JSON.stringify(payload)
          },
        })
      }
      expect(order).toEqual(['prewarm', 'main'])
      const files = (await readdir(dumpDir))
        .filter((name) => name.endsWith('.body.json'))
        .sort()
      expect(files).toHaveLength(4)
      const bodies = await Promise.all(
        files.map((name) => readFile(join(dumpDir, name), 'utf8')),
      )
      expect(bodies[1]).toBe(bodies[0])
      expect(bodies[2]).toBe(bodies[0])
      expect(bodies[3]).toBe(bodies[0])
      expect(bodies[0]).toContain('"model":"gpt-5.5","input":')
    })
  })

  test('resolves configured Codex endpoint with env-over-config precedence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openai-auth-endpoint-test-'))
    const configPath = join(dir, 'openai-auth.json')
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalEndpoint = process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          codexApiEndpoint: 'http://127.0.0.1:8899/v1/responses',
        }),
      )
      process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
      delete process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT
      resetSettingsForTest()
      expect(getSettings().codexApiEndpoint).toBe(
        'http://127.0.0.1:8899/v1/responses',
      )

      process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT =
        'http://127.0.0.1:9900/v1/responses'
      resetSettingsForTest()
      expect(getSettings().codexApiEndpoint).toBe(
        'http://127.0.0.1:9900/v1/responses',
      )
    } finally {
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT', originalEndpoint)
      resetSettingsForTest()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('routes Codex HTTP requests to configured endpoint without changing body shape', async () => {
    const originalFetch = globalThis.fetch
    const originalEndpoint = process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const seen: Array<{ url: string; body: Record<string, unknown> }> = []
    process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT =
      'http://127.0.0.1:8899/v1/responses'
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(
      tmpdir(),
      'missing-openai-auth.json',
    )
    resetSettingsForTest()
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: url.toString(),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return new Response('ok', { status: 200 })
      },
      { preconnect: () => {} },
    )
    try {
      const hooks = await dumpPlugin({
        experimentalWebSockets: false,
      })
      const fetch = await pluginFetch(hooks)
      await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-affinity': 'ses_endpoint',
        },
        body: JSON.stringify({ ...toolRequestBody(), store: false }),
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe('http://127.0.0.1:8899/v1/responses')
      expect(seen[0]?.body.store).toBe(false)
      expect(typeof seen[0]?.body.prompt_cache_key).toBe('string')
      expect(
        (
          seen[0]?.body.tools as Array<Record<string, unknown>> | undefined
        )?.some((tool) => tool.type === 'web_search') ?? false,
      ).toBe(false)
    } finally {
      await disposePluginWork()
      globalThis.fetch = originalFetch
      restoreEnv('CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT', originalEndpoint)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      resetSettingsForTest()
    }
  })

  test('defaults Codex endpoint to ChatGPT backend', () => {
    const originalEndpoint = process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(
      tmpdir(),
      'missing-openai-auth.json',
    )
    delete process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT
    resetSettingsForTest()
    try {
      expect(getSettings().codexApiEndpoint).toBe(DEFAULT_CODEX_API_ENDPOINT)
    } finally {
      restoreEnv('CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT', originalEndpoint)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      resetSettingsForTest()
    }
  })

  test('does not install the Codex/WebSocket fetch for manual API-key auth', async () => {
    const hooks = await dumpPlugin({
      experimentalWebSockets: true,
    })
    const auth = hooks.auth
    if (!auth?.loader) throw new Error('missing auth loader')

    const loaded = await auth.loader(
      async () => ({ type: 'api', key: 'sk-test' }) as any,
      {} as Parameters<NonNullable<typeof auth.loader>>[1],
    )

    expect(loaded.fetch).toBeUndefined()
    const output = { headers: {} as Record<string, string> }
    await hooks['chat.headers']?.(
      {
        agent: 'build',
        sessionID: 'api-key-session',
        model: { providerID: 'openai' },
      } as Parameters<NonNullable<(typeof hooks)['chat.headers']>>[0],
      output,
    )
    expect(output.headers['x-openai-auth-agent']).toBeUndefined()
    await hooks.dispose?.()
  })

  test('drops cached Codex session metadata when OpenCode deletes a session', async () => {
    await withDumpEnv(async () => {
      const originalFetch = globalThis.fetch
      const promptCacheKeys: string[] = []
      globalThis.fetch = Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          promptCacheKeys.push(String(body.prompt_cache_key))
          return new Response('ok', { status: 200 })
        },
        { preconnect: () => {} },
      )
      try {
        const hooks = await dumpPlugin({
          experimentalWebSockets: false,
        })
        const fetch = await pluginFetch(hooks)

        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_deleted',
          },
          body: JSON.stringify(toolRequestBody()),
        })
        await hooks.event?.({
          event: {
            type: 'session.deleted',
            properties: { info: { id: 'ses_deleted' } },
          },
        } as Parameters<NonNullable<typeof hooks.event>>[0])
        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_deleted',
          },
          body: JSON.stringify(toolRequestBody()),
        })

        expect(promptCacheKeys).toHaveLength(2)
        expect(promptCacheKeys[1]).not.toBe(promptCacheKeys[0])
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  test('persists Codex prompt_cache_key mapping across plugin restarts', async () => {
    await withDumpEnv(async () => {
      const originalFetch = globalThis.fetch
      const promptCacheKeys: string[] = []
      globalThis.fetch = Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          promptCacheKeys.push(String(body.prompt_cache_key))
          return new Response('ok', { status: 200 })
        },
        { preconnect: () => {} },
      )
      try {
        const firstHooks = await dumpPlugin({
          experimentalWebSockets: false,
        })
        const firstFetch = await pluginFetch(firstHooks)
        await firstFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_persisted',
          },
          body: JSON.stringify(toolRequestBody()),
        })
        await firstHooks.dispose?.()

        const secondHooks = await dumpPlugin({
          experimentalWebSockets: false,
        })
        const secondFetch = await pluginFetch(secondHooks)
        await secondFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_persisted',
          },
          body: JSON.stringify(toolRequestBody()),
        })

        expect(promptCacheKeys).toHaveLength(2)
        expect(promptCacheKeys[1]).toBe(promptCacheKeys[0])
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  test('rotates HTTP turn metadata for a new user turn and keeps it during tool continuations', async () => {
    await withDumpEnv(async () => {
      const originalFetch = globalThis.fetch
      const turnIDs: string[] = []
      globalThis.fetch = Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          turnIDs.push(
            JSON.parse(headers.get('x-codex-turn-metadata') ?? '{}').turn_id,
          )
          return new Response('ok', { status: 200 })
        },
        { preconnect: () => {} },
      )
      try {
        const hooks = await dumpPlugin({
          experimentalWebSockets: false,
        })
        const fetch = await pluginFetch(hooks)

        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_turn_http',
          },
          body: JSON.stringify({
            ...toolRequestBody(),
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
            ],
          }),
        })
        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_turn_http',
          },
          body: JSON.stringify({
            ...toolRequestBody(),
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
              { type: 'function_call', call_id: 'call_1', name: 'bash' },
              { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
            ],
          }),
        })
        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_turn_http',
          },
          body: JSON.stringify({
            ...toolRequestBody(),
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
        })

        expect(turnIDs).toHaveLength(3)
        expect(turnIDs[1]).toBe(turnIDs[0])
        expect(turnIDs[2]).not.toBe(turnIDs[0])
        expect(turnIDs.every((id) => id[14] === '7')).toBe(true)
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  test('HTTP cached decisions still detect edits compaction and rewrites', async () => {
    await withDumpEnv(async () => {
      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '0'
      resetSettingsForTest()
      const originalFetch = globalThis.fetch
      const ids: string[] = []
      globalThis.fetch = Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          ids.push(
            JSON.parse(new Headers(init?.headers).get('x-codex-turn-metadata')!)
              .turn_id,
          )
          return new Response('ok')
        },
        { preconnect: () => {} },
      )
      try {
        const hooks = await dumpPlugin({
          experimentalWebSockets: false,
        })
        const fetch = await pluginFetch(hooks)
        const user = { type: 'message', role: 'user', content: 'one' }
        const output = {
          type: 'function_call_output',
          call_id: 'c',
          output: 'ok',
        }
        const cases = [
          [user],
          [user, output],
          [{ ...user, content: 'edited' }, output],
          [output],
          [output],
          [{ ...user, content: 'rewritten' }],
        ]
        for (const input of cases) {
          await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'x-session-affinity': 'cached-http' },
            body: JSON.stringify({ ...toolRequestBody(), input }),
          })
        }
        expect(ids[1]).toBe(ids[0])
        expect(ids[2]).not.toBe(ids[1])
        expect(ids[3]).not.toBe(ids[2])
        expect(ids[4]).toBe(ids[3])
        expect(ids[5]).not.toBe(ids[4])
        await hooks.dispose?.()
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  test('dumps final HTTP body and redacted request metadata when enabled', async () => {
    await withDumpEnv(async (dumpDir) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = Object.assign(
        async () => new Response('ok', { status: 200 }),
        { preconnect: () => {} },
      )
      try {
        const hooks = await dumpPlugin({
          experimentalWebSockets: false,
        })
        const fetch = await pluginFetch(hooks)

        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_dump_http',
            'x-openai-auth-agent': 'build',
          },
          body: JSON.stringify(toolRequestBody()),
        })

        const files = await readdir(dumpDir)
        const bodyFile = requireFile(files, '.body.json')
        const metaFile = requireFile(files, '.meta.json')
        const requestFile = requireFile(files, '.request.json')
        const body = await readFile(join(dumpDir, bodyFile), 'utf8')
        const meta = JSON.parse(await readFile(join(dumpDir, metaFile), 'utf8'))
        const request = JSON.parse(
          await readFile(join(dumpDir, requestFile), 'utf8'),
        )

        expect((await stat(dumpDir)).mode & 0o777).toBe(0o700)
        for (const file of [bodyFile, metaFile, requestFile]) {
          expect((await stat(join(dumpDir, file))).mode & 0o777).toBe(0o600)
        }
        expect(body).not.toContain('"type":"web_search"')
        expect(meta).toMatchObject({
          channel: 'http',
          phase: 'http',
          status: 200,
          body: {
            parseable: true,
            inputCount: 1,
          },
        })
        expect(request.headers.authorization).toBe('***REDACTED***')
        for (const file of files) {
          expect(await readFile(join(dumpDir, file), 'utf8')).not.toContain(
            'x-openai-auth-agent',
          )
        }
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  async function readMetas(dumpDir: string) {
    const names = (await readdir(dumpDir)).filter((name) =>
      name.endsWith('.meta.json'),
    )
    return await Promise.all(
      names.map(async (name) =>
        JSON.parse(await readFile(join(dumpDir, name), 'utf8')),
      ),
    )
  }

  test('switches dumps on and off at runtime without a restart', async () => {
    await withDumpEnv(async (dumpDir) => {
      const dump = (session: string) =>
        dumpCodexRequest({
          sessionID: session,
          transport: 'http',
          phase: 'http',
          bodyText: JSON.stringify({ input: [] }),
        })

      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '0'
      refreshSettings()
      await dump('ses_switch_off')
      expect(await readMetas(dumpDir).catch(() => [])).toEqual([])

      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '1'
      refreshSettings()
      await dump('ses_switch_on')
      const metas = await readMetas(dumpDir)
      expect(metas.map((meta) => meta.session)).toEqual(['ses_switch_on'])
    })
  })

  test('the cache-cliff analyzer parses dumps written by this plugin', async () => {
    await withDumpEnv(async (dumpDir) => {
      const session = 'ses_cliff_analyzer'
      const body = (turns: number) =>
        JSON.stringify({
          model: 'gpt-5.5',
          input: Array.from({ length: turns }, (_unused, i) => ({
            role: 'user',
            content: `turn ${i}`,
          })),
        })
      await dumpCodexRequest({
        sessionID: session,
        transport: 'websocket',
        phase: 'prewarm',
        bodyText: body(0),
      })
      await dumpCodexRequest({
        sessionID: session,
        transport: 'websocket',
        phase: 'main',
        bodyText: body(2),
      })

      const dbPath = join(dumpDir, '..', 'opencode.db')
      const db = new Database(dbPath)
      db.run(
        'create table part (id text, message_id text, session_id text, time_created integer, data text)',
      )
      db.run('insert into part values (?, ?, ?, ?, ?)', [
        'prt_1',
        'msg_1',
        session,
        Date.now() + 1_000,
        JSON.stringify({
          type: 'step-finish',
          reason: 'stop',
          tokens: { input: 10, output: 1, cache: { read: 90, write: 0 } },
        }),
      ])
      db.close()

      const script = join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '..',
        'scripts',
        'analyze-cache-cliffs.mjs',
      )
      const run = Bun.spawnSync([
        process.execPath,
        script,
        '--session',
        session,
        '--dump-dir',
        dumpDir,
        '--db',
        dbPath,
      ])
      const stdout = run.stdout.toString()
      expect(run.exitCode).toBe(0)
      // Phases come from the metadata, so only the main dump counts as main.
      expect(stdout).toContain('dumps: 2 (1 main)')
      expect(stdout).toContain('usageRows: 1')
      // The timeline row pairs the usage with the main dump: its input count
      // comes from the body summary and its name from the dump file.
      const mainMeta = (await readMetas(dumpDir)).find(
        (meta) => meta.phase === 'main',
      )
      const row = stdout
        .split('\n')
        .find((line) => line.endsWith(`\t${mainMeta.id}`))
      expect(row?.split('\t')[7]).toBe('2')
    })
  })

  test('records the internal serving account without exposing a ChatGPT account id', async () => {
    await withDumpEnv(async (dumpDir) => {
      await dumpCodexRequest({
        sessionID: 'ses_dump_account',
        transport: 'http',
        phase: 'http',
        accountId: 'work-alt',
        bodyText: JSON.stringify({ input: [] }),
        headers: { 'chatgpt-account-id': 'chatgpt-account-secret' },
      })

      const files = await readdir(dumpDir)
      const metadata = JSON.parse(
        await readFile(join(dumpDir, requireFile(files, '.meta.json')), 'utf8'),
      )
      const request = JSON.parse(
        await readFile(
          join(dumpDir, requireFile(files, '.request.json')),
          'utf8',
        ),
      )

      expect(metadata.accountId).toBe('work-alt')
      expect(request.accountId).toBe('work-alt')
      expect(request.headers['chatgpt-account-id']).toBe('***REDACTED***')
      expect(JSON.stringify({ metadata, request })).not.toContain(
        'chatgpt-account-secret',
      )
    })
  })

  test('redacts credentials from JSON dump bodies', async () => {
    await withDumpEnv(async (dumpDir) => {
      const bearer = 'Bearer dump-body-token'
      const accountID = 'chatgpt-account-secret'
      const metadataToken = 'Bearer client-metadata-token'
      const prompt = 'keep this prompt for cache debugging'
      await dumpCodexRequest({
        sessionID: 'ses_dump_redaction',
        transport: 'http',
        phase: 'http',
        bodyText: JSON.stringify({
          authorization: bearer,
          chatgptAccountId: accountID,
          'chatgpt-account-id': accountID,
          client_metadata: { trace: metadataToken },
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: prompt }],
            },
          ],
        }),
      })

      const bodyFile = requireFile(await readdir(dumpDir), '.body.json')
      const body = await readFile(join(dumpDir, bodyFile), 'utf8')

      expect(body).not.toContain(bearer)
      expect(body).not.toContain(accountID)
      expect(body).not.toContain(metadataToken)
      expect(body).not.toContain('\n')
      expect(body).toContain(prompt)
    })
  })

  test('keeps tool schemas intact while scrubbing credentials inside them', async () => {
    await withDumpEnv(async (dumpDir) => {
      const leaked = 'Bearer schema-description-token'
      await dumpCodexRequest({
        sessionID: 'ses_dump_schema',
        transport: 'http',
        phase: 'http',
        bodyText: JSON.stringify({
          tools: [
            {
              type: 'function',
              name: 'call_api',
              parameters: {
                type: 'object',
                properties: {
                  // Names an argument the tool accepts; holds no secret.
                  api_key: { type: 'string', description: 'the caller key' },
                  auth_token: { type: 'string', description: leaked },
                },
              },
            },
          ],
        }),
      })

      const bodyFile = requireFile(await readdir(dumpDir), '.body.json')
      const body = await readFile(join(dumpDir, bodyFile), 'utf8')
      const parsed = JSON.parse(body)
      const properties = parsed.tools[0].parameters.properties

      // The schema still parses as a schema rather than collapsing to a string.
      expect(properties.api_key).toEqual({
        type: 'string',
        description: 'the caller key',
      })
      expect(properties.auth_token.type).toBe('string')
      // A credential written into a description is still removed.
      expect(body).not.toContain(leaked)
    })
  })

  test('agent tags are stripped on HTTP fallback and requests without session metadata', async () => {
    await withDumpEnv(async () => {
      const originalFetch = globalThis.fetch
      const outgoing: Headers[] = []
      globalThis.fetch = Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          outgoing.push(new Headers(init?.headers))
          return new Response('{}')
        },
        { preconnect: () => {} },
      )
      let hooks: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
      try {
        hooks = await dumpPlugin({
          experimentalWebSockets: true,
        })
        const fetch = await pluginFetch(hooks)
        for (const session of ['fallback-title', undefined]) {
          const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-openai-auth-agent': 'title',
              'x-opencode-title': 'true',
              ...(session ? { 'session-id': session } : {}),
            },
            body: JSON.stringify(toolRequestBody()),
          })
          await response.text()
        }
        expect(outgoing).toHaveLength(2)
        expect(
          outgoing.every((headers) => !headers.has('x-openai-auth-agent')),
        ).toBe(true)
      } finally {
        await hooks?.dispose?.()
        await disposePluginWork()
        globalThis.fetch = originalFetch
      }
    })
  })

  test('WebSocket effort history keeps full-turn prefixes and incremental tool frames', async () => {
    await withDumpEnv(async (dumpDir) => {
      const originalFetch = globalThis.fetch
      const originalWebSocket = globalThis.WebSocket
      FakeWebSocket.frames = []
      FakeWebSocket.upgrades = []
      globalThis.fetch = Object.assign(async () => new Response('{}'), {
        preconnect: () => {},
      })
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
      let hooks: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
      try {
        hooks = await dumpPlugin({
          experimentalWebSockets: true,
        })
        const fetch = await pluginFetch(hooks)
        const input: unknown[] = []
        for (const [turn, effort] of [
          'medium',
          'medium',
          'high',
          'high',
        ].entries()) {
          input.push({ role: 'user', content: `turn ${turn}` })
          for (let step = 0; step < 2; step++) {
            if (step)
              input.push({
                type: 'function_call_output',
                call_id: `call_${turn}`,
                output: 'ok',
              })
            const response = await fetch(
              'https://api.openai.com/v1/responses',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'session-id': 'effort-ws',
                  'x-openai-auth-agent': 'build',
                },
                body: JSON.stringify({
                  ...toolRequestBody(),
                  model: 'gpt-6.1-sol',
                  reasoning: { effort },
                  input,
                }),
              },
            )
            await response.text()
          }
        }
        const frames = FakeWebSocket.frames.filter(
          (frame) => frame.generate !== false,
        )
        expect(frames).toHaveLength(8)
        for (const frame of frames) {
          expect(frame.previous_response_id).toBeDefined()
          expect(frame.reasoning).toEqual({ effort: 'medium' })
        }
        // A fresh user turn first sends an input with no prior messages, then
        // replays the full input. Keeping configuration updates at their original
        // positions lets the replay reuse the previously cached prefix.
        expect(
          frames.map((frame) => (frame.input as unknown[]).length),
        ).toEqual([1, 1, 3, 1, 6, 1, 8, 1])
        const fullTurns = frames.filter((_frame, index) => index % 2 === 0)
        for (let i = 1; i < fullTurns.length; i++) {
          const previous = fullTurns[i - 1]!.input as unknown[]
          expect(
            (fullTurns[i]!.input as unknown[]).slice(0, previous.length),
          ).toEqual(previous)
        }
        expect((frames[4]!.input as unknown[]).slice(-2)).toEqual([
          { type: 'configuration_update', reasoning: { effort: 'high' } },
          { type: 'message', role: 'user', content: 'turn 2' },
        ])
        for (const [i, frame] of frames.entries()) {
          if (i % 2 === 0) continue
          expect(frame.previous_response_id).toBe('resp_main')
          expect(frame.input).toEqual([
            {
              type: 'function_call_output',
              call_id: `call_${Math.floor(i / 2)}`,
              output: 'ok',
            },
          ])
        }
        expect(FakeWebSocket.upgrades.length).toBeGreaterThan(0)
        expect(
          FakeWebSocket.upgrades.every(
            (headers) => !headers.has('x-openai-auth-agent'),
          ),
        ).toBe(true)
        for (const file of await readdir(dumpDir)) {
          expect(await readFile(join(dumpDir, file), 'utf8')).not.toContain(
            'x-openai-auth-agent',
          )
        }
      } finally {
        await hooks?.dispose?.()
        await disposePluginWork()
        globalThis.fetch = originalFetch
        globalThis.WebSocket = originalWebSocket
      }
    })
  })

  test('dumps final WebSocket prewarm and main bodies when enabled', async () => {
    await withDumpEnv(async (dumpDir) => {
      const originalFetch = globalThis.fetch
      const originalWebSocket = globalThis.WebSocket
      globalThis.fetch = Object.assign(
        async () => {
          throw new Error('unexpected HTTP fetch')
        },
        { preconnect: () => {} },
      )
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
      try {
        const hooks = await dumpPlugin({
          experimentalWebSockets: true,
        })
        const fetch = await pluginFetch(hooks)
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_dump_ws',
          },
          body: JSON.stringify(toolRequestBody()),
        })
        await response.text()

        const files = await readdir(dumpDir)
        const metas = await Promise.all(
          files
            .filter((file) => file.endsWith('.meta.json'))
            .map(async (file) =>
              JSON.parse(await readFile(join(dumpDir, file), 'utf8')),
            ),
        )
        const prewarm = metas.find((meta) => meta.phase === 'prewarm')
        const main = metas.find((meta) => meta.phase === 'main')

        expect(prewarm).toMatchObject({
          channel: 'websocket',
          body: { generate: false, inputCount: 0 },
        })
        expect(main).toMatchObject({
          channel: 'websocket',
          body: {
            previousResponseID: 'resp_prewarm',
            inputCount: 1,
          },
        })
      } finally {
        await disposePluginWork()
        globalThis.fetch = originalFetch
        globalThis.WebSocket = originalWebSocket
      }
    })
  })
})

function pluginInput() {
  return {
    client: {
      auth: {
        set: async () => {},
      },
    },
  } as unknown as PluginInput
}

async function dumpPlugin(options: Parameters<typeof CodexAuthPlugin>[1]) {
  const hooks = scope.ownPlugin(await CodexAuthPlugin(pluginInput(), options))
  plugins.add(hooks)
  return hooks
}

async function pluginFetch(hooks: Awaited<ReturnType<typeof CodexAuthPlugin>>) {
  const auth = hooks.auth
  if (!auth?.loader) throw new Error('missing auth loader')
  const loaded = await auth.loader(
    async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }),
    {} as Parameters<NonNullable<typeof auth.loader>>[1],
  )
  if (!loaded.fetch) throw new Error('missing fetch')
  return scope.wrap(
    async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      loaded.fetch!(url, init),
  )
}

function toolRequestBody() {
  return {
    model: 'gpt-5.5-fast',
    stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [
      {
        type: 'function',
        name: 'bash',
        description: 'run shell commands',
        parameters: { type: 'object', properties: {} },
      },
    ],
  }
}

async function withDumpEnv(run: (dumpDir: string) => Promise<void>) {
  const rootDir = await mkdtemp(join(tmpdir(), 'openai-auth-dump-test-'))
  const dumpDir = join(rootDir, 'dumps')
  const originalDump = process.env.CORTEXKIT_OPENAI_AUTH_DUMP
  const originalDumpDir = process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR
  const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '1'
  process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR = dumpDir
  process.env.OPENCODE_OPENAI_AUTH_FILE = join(rootDir, 'missing.json')
  process.env.OPENCODE_CONFIG_DIR = rootDir
  resetSettingsForTest()
  resetDumpStateForTest()
  try {
    await run(dumpDir)
  } finally {
    await disposePluginWork()
    restoreEnv('CORTEXKIT_OPENAI_AUTH_DUMP', originalDump)
    restoreEnv('OPENCODE_OPENAI_AUTH_DUMP_DIR', originalDumpDir)
    restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
    restoreEnv('OPENCODE_CONFIG_DIR', originalConfigDir)
    resetSettingsForTest()
    resetDumpStateForTest()
    await rm(rootDir, { recursive: true, force: true })
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function requireFile(files: string[], suffix: string) {
  const file = files.find((entry) => entry.endsWith(suffix))
  if (!file) throw new Error(`missing ${suffix}`)
  return file
}

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static frames: Array<Record<string, unknown>> = []
  static upgrades: Headers[] = []

  readyState = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(
    readonly url: string,
    options?: { headers?: HeadersInit },
  ) {
    FakeWebSocket.upgrades.push(new Headers(options?.headers))
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
    const listener = options?.once
      ? (event: unknown) => {
          this.removeEventListener(type, listener)
          fn(event)
        }
      : fn
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.get(type)?.delete(fn)
  }

  send(data: string) {
    const parsed = JSON.parse(data) as Record<string, unknown>
    FakeWebSocket.frames.push(parsed)
    this.emit('message', {
      data: JSON.stringify({
        type: 'response.completed',
        response: {
          id: parsed.generate === false ? 'resp_prewarm' : 'resp_main',
        },
      }),
    })
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code: 1000, reason: '' })
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}
