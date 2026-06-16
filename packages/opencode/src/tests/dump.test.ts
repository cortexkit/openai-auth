import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'

import { resetSettingsForTest } from '../config'
import { resetDumpStateForTest } from '../dump'
import { CodexAuthPlugin } from '../index'

describe('request dumps', () => {
  test('does not install the Codex/WebSocket fetch for manual API-key auth', async () => {
    const hooks = await CodexAuthPlugin(pluginInput(), {
      experimentalWebSockets: true,
    })
    const auth = hooks.auth
    if (!auth?.loader) throw new Error('missing auth loader')

    const loaded = await auth.loader(
      async () => ({ type: 'api', key: 'sk-test' }) as any,
      {} as Parameters<NonNullable<typeof auth.loader>>[1],
    )

    expect(loaded.fetch).toBeUndefined()
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
        const hooks = await CodexAuthPlugin(pluginInput(), {
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
        const firstHooks = await CodexAuthPlugin(pluginInput(), {
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

        const secondHooks = await CodexAuthPlugin(pluginInput(), {
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
        const hooks = await CodexAuthPlugin(pluginInput(), {
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
        const hooks = await CodexAuthPlugin(pluginInput(), {
          experimentalWebSockets: false,
        })
        const fetch = await pluginFetch(hooks)

        await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-affinity': 'ses_dump_http',
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

        expect(body).toContain('"type":"web_search"')
        expect(meta).toMatchObject({
          transport: 'http',
          phase: 'http',
          status: 200,
          body: {
            parseable: true,
            inputCount: 1,
            hasWebSearch: true,
          },
        })
        expect(request.headers.authorization).toBe('[redacted]')
      } finally {
        globalThis.fetch = originalFetch
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
        const hooks = await CodexAuthPlugin(pluginInput(), {
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
          transport: 'websocket',
          body: { generate: false, inputCount: 0, hasWebSearch: true },
        })
        expect(main).toMatchObject({
          transport: 'websocket',
          body: {
            previousResponseID: 'resp_prewarm',
            inputCount: 1,
            hasWebSearch: true,
          },
        })
      } finally {
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
  return loaded.fetch
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
  const dumpDir = await mkdtemp(join(tmpdir(), 'openai-auth-dump-test-'))
  const originalDump = process.env.CORTEXKIT_OPENAI_AUTH_DUMP
  const originalDumpDir = process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR
  const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '1'
  process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR = dumpDir
  process.env.OPENCODE_OPENAI_AUTH_FILE = join(dumpDir, 'missing.json')
  process.env.OPENCODE_CONFIG_DIR = dumpDir
  resetSettingsForTest()
  resetDumpStateForTest()
  try {
    await run(dumpDir)
  } finally {
    restoreEnv('CORTEXKIT_OPENAI_AUTH_DUMP', originalDump)
    restoreEnv('OPENCODE_OPENAI_AUTH_DUMP_DIR', originalDumpDir)
    restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
    restoreEnv('OPENCODE_CONFIG_DIR', originalConfigDir)
    resetSettingsForTest()
    resetDumpStateForTest()
    await rm(dumpDir, { recursive: true, force: true })
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

  readyState = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(readonly url: string) {
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
