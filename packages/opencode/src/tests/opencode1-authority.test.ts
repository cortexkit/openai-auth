import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vaultPaths } from '@cortexkit/openai-auth-core/internal'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index.ts'
import { createRequestTestScope } from './request-test-scope.ts'
import { restoreEnv } from './setup-env.ts'

const scope = createRequestTestScope()
let dir: string
let hooks: Hooks | undefined
let wire: string[]
let oldFetch: typeof fetch
let configPath: string
let statePath: string
let vaultDir: string
let envBefore: Record<string, string | undefined>
let modelReply: (() => Response) | undefined
let oauthReply: (() => Response) | undefined
let authWrites: number
const envNames = [
  'OPENCODE_OPENAI_AUTH_FILE',
  'OPENCODE_OPENAI_AUTH_STATE_FILE',
  'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_OPENAI_AUTH_LOG_FILE',
]

beforeEach(() => {
  envBefore = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]]),
  )
  dir = mkdtempSync(join(tmpdir(), 'review-opencode1-'))
  configPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  vaultDir = join(dir, 'vault')
  mkdirSync(vaultDir, { mode: 0o700 })
  process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    dir,
    'sidebar.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(dir, 'plugin.log')
  writeFileSync(configPath, JSON.stringify({ version: 1, accounts: [] }))
  oldFetch = globalThis.fetch
  wire = []
  modelReply = undefined
  oauthReply = undefined
  authWrites = 0
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/oauth/token') && oauthReply) return oauthReply()
      if (url.includes('/responses')) {
        wire.push(new Headers(init?.headers).get('authorization') ?? '')
        return modelReply?.() ?? Response.json({ output: [] })
      }
      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18000,
            reset_at: Math.floor(Date.now() / 1000) + 7200,
          },
        },
      })
    },
    { preconnect() {} },
  ) as typeof fetch
  scope.capturePluginWork({ vaultPolls: true })
})
afterEach(async () => {
  await scope.teardown(async () => {
    globalThis.fetch = oldFetch
    for (const name of envNames) restoreEnv(name, envBefore[name])
    rmSync(dir, { recursive: true, force: true })
  })
  hooks = undefined
})

function enroll() {
  writeFileSync(
    vaultPaths(vaultDir, 'opencode').tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
}
async function plugin() {
  hooks = scope.ownPlugin(
    await CodexAuthPlugin(
      {
        client: {
          auth: {
            set: async () => {
              authWrites++
            },
          },
          session: { promptAsync: async () => {} },
        },
        project: { id: 'review', name: 'review' },
        directory: '',
        worktree: dir,
        experimental_workspace: { register() {} },
        serverUrl: new URL('http://localhost:0'),
        $: {},
      } as unknown as PluginInput,
      {
        experimentalWebSockets: false,
        poolMigration: { enabled: false },
        vault: {
          stateDir: vaultDir,
          connectionFile: () => join(dir, 'no-daemon.json'),
          pollIntervalMs: 0,
        },
      },
    ),
  )
  return hooks.auth!.loader!
}
const auth = () => ({
  type: 'oauth' as const,
  access: 'review-local-access',
  refresh: 'review-local-refresh',
  expires: Date.now() + 3600_000,
})

for (const contentType of [undefined, 'text/plain']) {
  test(`OpenCode1 streaming sends scrub errors with ${contentType ?? 'missing'} content-type`, async () => {
    const token = auth().access
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature'
    modelReply = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: {"type":"error","message":"Stream refused key ${token}; ${jwt}"}\n\n`,
              ),
            )
            controller.close()
          },
        }),
        { headers: contentType ? { 'content-type': contentType } : {} },
      )
    const loader = await plugin()
    const loaded = (await loader(async () => auth(), {
      id: 'openai',
      models: {},
    } as never)) as { fetch: typeof fetch }
    const response = await loaded.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.4', input: [], stream: true }),
    })
    expect(wire).toEqual([`Bearer ${token}`])
    expect(await response.text()).toBe(
      'data: {"type":"error","message":"Stream refused key [credential]; [credential]"}\n\n',
    )
  })
}

test('OpenCode1 enrollment during host auth lookup prevents a local model send', async () => {
  let armed = false
  const loader = await plugin()
  const loaded = (await loader(
    async () => {
      if (armed) enroll()
      return auth()
    },
    { id: 'openai', models: {} } as never,
  )) as { fetch: typeof fetch }
  const request = {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5.4', input: [], stream: false }),
  }
  await scope.settlePluginWork()
  expect(
    (await loaded.fetch('https://api.openai.com/v1/responses', request)).status,
  ).toBe(200)
  expect(wire).toEqual(['Bearer review-local-access'])
  wire.length = 0
  armed = true
  await loaded.fetch('https://api.openai.com/v1/responses', request)
  expect(wire).toEqual([])
})

test('OpenCode1 vault loader declines locally even when the unused local account file is malformed', async () => {
  enroll()
  writeFileSync(configPath, '{broken')
  const before = readFileSync(configPath)
  const loader = await plugin()
  const outcome = await loader(async () => auth(), {
    id: 'openai',
    models: {},
  } as never).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  )
  expect(outcome.error).toBeUndefined()
  const loaded = outcome.value as { fetch: typeof fetch }
  const response = await loaded.fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5.4', input: [], stream: false }),
  })
  expect(await response.text()).toContain('Request refused locally')
  expect(wire).toEqual([])
  expect(readFileSync(configPath)).toEqual(before)
})

for (const transport of ['http', 'sse', 'exception'] as const) {
  test(`OpenCode1 ${transport} error redacts the attempt bearer and token patterns`, async () => {
    const token = auth().access
    const message = `Invalid API key: ${token} twice ${token}; Bearer other-opaque-key; eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature`
    modelReply = () => {
      if (transport === 'exception') throw new Error(message)
      if (transport === 'sse')
        return new Response(
          `data: {"type":"error","message":"${message}"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      return Response.json({ error: { message } }, { status: 401 })
    }
    const loader = await plugin()
    const loaded = (await loader(async () => auth(), {
      id: 'openai',
      models: {},
    } as never)) as { fetch: typeof fetch }
    await scope.settlePluginWork()
    const result = await loaded
      .fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          input: [],
          stream: transport === 'sse',
        }),
      })
      .then(
        (response) => response.text(),
        (error: Error) => error.message,
      )
    expect(wire).toEqual([`Bearer ${token}`])
    expect(result).toContain('Invalid API key: [credential] twice [credential]')
    expect(result).not.toContain(token)
    expect(result).not.toContain('other-opaque-key')
    expect(result).not.toContain('eyJ')
  })
}

test('OpenCode1 enrollment during native refresh drops host and local persistence', async () => {
  const loader = await plugin()
  const loaded = (await loader(async () => ({ ...auth(), expires: 1 }), {
    id: 'openai',
    models: {},
  } as never)) as { fetch: typeof fetch }
  await scope.settlePluginWork()
  let refreshes = 0
  let before: string[] = []
  const bytes = () =>
    [configPath, statePath].map((path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    })
  oauthReply = () => {
    refreshes++
    before = bytes()
    enroll()
    return Response.json({
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    })
  }
  const writesBefore = authWrites
  await loaded.fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5.4', input: [], stream: false }),
  })
  await scope.settlePluginWork()
  expect(refreshes).toBe(1)
  expect(authWrites).toBe(writesBefore)
  expect(wire).toEqual([])
  expect(bytes()).toEqual(before)
})

test('OpenCode1 unreadable authority refuses without parsing a malformed local store', async () => {
  enroll()
  writeFileSync(vaultPaths(vaultDir, 'opencode').tokenPath, '{broken', {
    mode: 0o600,
  })
  writeFileSync(configPath, '{broken')
  const before = readFileSync(configPath)
  const loader = await plugin()
  const loaded = (await loader(async () => auth(), {
    id: 'openai',
    models: {},
  } as never)) as { fetch: typeof fetch }
  const response = await loaded.fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5.4', input: [], stream: false }),
  })
  expect(await response.text()).toContain('Request refused locally')
  expect(wire).toEqual([])
  expect(readFileSync(configPath)).toEqual(before)
})

test('OpenCode1 enrollment during request body await prevents physical local dispatch', async () => {
  const loader = await plugin()
  const loaded = (await loader(async () => auth(), {
    id: 'openai',
    models: {},
  } as never)) as { fetch: typeof fetch }
  await scope.settlePluginWork()
  const body = JSON.stringify({ model: 'gpt-5.4', input: [], stream: false })
  await loaded.fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body,
  })
  expect(wire).toEqual(['Bearer review-local-access'])
  wire.length = 0
  const original = Request.prototype.text
  let awaited = 0
  const read = spyOn(Request.prototype, 'text').mockImplementation(
    async function (this: Request) {
      awaited++
      const text = await original.call(this)
      enroll()
      return text
    },
  )
  try {
    await loaded.fetch(
      new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        body,
      }),
    )
    expect(awaited).toBe(1)
    expect(wire).toEqual([])
  } finally {
    read.mockRestore()
  }
})
