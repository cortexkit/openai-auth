import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { OAuthAccount } from '../core/accounts.ts'
import { migrateIfNeeded } from '../core/accounts.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import { CodexAuthPlugin, findCachekeepFallbackAccount } from '../index.ts'
import {
  drainSidebarWrites,
  getSidebarStateFile,
  type SidebarState,
} from '../sidebar-state.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForSidebarState(
  file: string,
  predicate: (s: SidebarState) => boolean,
  timeoutMs = 2000,
): Promise<SidebarState> {
  const deadline = Date.now() + timeoutMs
  let last: SidebarState | undefined
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as SidebarState
      last = parsed
      if (predicate(parsed)) return parsed
    } catch {
      /* file not written yet */
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitForSidebarState timed out; last=${JSON.stringify(last)}`)
}

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createMockPluginInput(
  overrides: Partial<PluginInput> = {},
): PluginInput {
  return {
    client: {
      auth: {
        set: async () => {},
      },
      session: {
        promptAsync: async () => {},
      },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test 1: Migration from a settings-only config
// ---------------------------------------------------------------------------

describe('integration: migration', () => {
  let configDir: string
  let configFile: string
  let stateFile: string

  beforeEach(() => {
    configDir = tempDir('oai-int-migration-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
  })

  afterEach(() => {
    // Restore to the floor (not delete) so any in-flight write resolves to a
    // temp path rather than the operator's live default.
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  })

  it('seeds account store from a settings-only openai-auth.json without dropping transport keys', async () => {
    // Write a settings-only config (no accounts/version key — pre-migration shape)
    writeFileSync(
      configFile,
      JSON.stringify({
        webSockets: true,
        rawWebSocket: true,
        dump: false,
        dumpDir: '/custom/dump',
      }),
    )

    await migrateIfNeeded(
      {
        type: 'oauth',
        access: 'test-access-token',
        refresh: 'test-refresh-token',
        expires: Date.now() + 3600_000,
      },
      configFile,
    )

    const cfg = JSON.parse(readFileSync(configFile, 'utf8'))

    // Transport keys preserved (FE-5)
    expect(cfg.webSockets).toBe(true)
    expect(cfg.rawWebSocket).toBe(true)
    expect(cfg.dump).toBe(false)
    expect(cfg.dumpDir).toBe('/custom/dump')

    // Account store seeded
    expect(cfg.version).toBe(1)
    expect(cfg.main?.type).toBe('opencode')
    expect(cfg.main?.provider).toBe('openai')
    expect(Array.isArray(cfg.accounts)).toBe(true)
  })

  it('is idempotent — second run does not re-migrate or duplicate', async () => {
    writeFileSync(configFile, JSON.stringify({ webSockets: true }))

    await migrateIfNeeded(
      {
        type: 'oauth',
        access: 'a1',
        refresh: 'r1',
        expires: Date.now() + 3600_000,
      },
      configFile,
    )
    const first = JSON.parse(readFileSync(configFile, 'utf8'))

    // Second run — already migrated, should be no-op
    await migrateIfNeeded(
      {
        type: 'oauth',
        access: 'a2',
        refresh: 'r2',
        expires: Date.now() + 3600_000,
      },
      configFile,
    )
    const second = JSON.parse(readFileSync(configFile, 'utf8'))

    // Content discriminator guard: second run does NOT change version or main
    expect(second.version).toBe(first.version)
    expect(second.main?.type).toBe(first.main?.type)
  })
})

// ---------------------------------------------------------------------------
// Test 2: HTTP quota push via the loader's fetch override
// ---------------------------------------------------------------------------

describe('integration: HTTP quota push', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string
  const accessToken = 'sk-test-access-123'
  const refreshToken = 'sk-test-refresh-456'

  beforeEach(() => {
    configDir = tempDir('oai-int-http-quota-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    sidebarFile = join(configDir, 'sidebar-state.json')
    logFile = join(configDir, 'test.log')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.NODE_ENV = 'test'
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    // Drain any in-flight sidebar writes BEFORE restoring the env floor so
    // no late write can re-resolve getSidebarStateFile() to the live default.
    await drainSidebarWrites()
    // Restore to the floor (not delete) — a fire-and-forget write still in
    // flight after this point will resolve to the floor temp path, not the
    // operator's live /tmp/opencode-openai-auth/ default.
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    // Restore to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  it('pushes main quota from x-codex-* headers into sidebar state', async () => {
    // Seed account store so migration is a no-op and loadAccounts succeeds
    const store = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
    }
    writeFileSync(configFile, JSON.stringify(store))

    // Mock fetch to return a 200 with x-codex-* headers
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
      return new Response('{"choices":[{"delta":{"content":"hello"}}]}', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-primary-used-percent': '42',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': '1781729038',
          'x-codex-secondary-used-percent': '15',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': '1781766665',
        },
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput()
      hooks = await CodexAuthPlugin(input, {
        experimentalWebSockets: false,
      })

      // Get the auth loader
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')

      // Call the loader with a mock getAuth
      const loaderResult = await authHook.loader(
        async () => ({
          type: 'oauth' as const,
          provider: 'openai',
          access: accessToken,
          refresh: refreshToken,
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
      )

      expect(loaderResult).toBeDefined()
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: string, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      // Drive a request through the gate pipeline
      const response = await fetchOverride(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.5',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      expect(response.status).toBe(200)
      // Don't consume the body — we only care about the side-effect (quota push)
      await response.body?.cancel()

      const sidebar = await waitForSidebarState(
        sidebarFile,
        (s) =>
          s.main.quota?.primary?.usedPercent === 42 &&
          s.main.quota?.secondary?.usedPercent === 15,
      )
      expect(sidebar.main.quota?.primary?.usedPercent).toBe(42)
      expect(sidebar.main.quota?.secondary?.usedPercent).toBe(15)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })
})

// ---------------------------------------------------------------------------
// Test 3: WS quota push (frame consumed, not relayed)
// ---------------------------------------------------------------------------

describe('integration: WS quota push', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string

  beforeEach(() => {
    configDir = tempDir('oai-int-ws-quota-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    sidebarFile = join(configDir, 'sidebar-state.json')
    logFile = join(configDir, 'test.log')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.NODE_ENV = 'test'
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    // Restore to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  it('onQuota fires for codex.rate_limits frame and the frame is NOT relayed as SSE output', async () => {
    const { streamResponsesWebSocket } = await import('../ws.ts')

    // Minimal WebSocket stub
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const socket = {
      url: 'wss://chatgpt.com/backend-api/codex/responses',
      readyState: 1,
      addEventListener(event: string, fn: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)!.add(fn)
      },
      removeEventListener(event: string, fn: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(fn)
      },
      close() {},
      send(_data: string) {},
      write(data: string) {
        const fns = listeners.get('message')
        if (!fns) return
        const event = { data } as MessageEvent
        for (const fn of fns) fn(event)
      },
    } as WebSocket & { write: (data: string) => void }

    let quotaSnapshot: Record<string, unknown> | undefined
    const relayedLines: string[] = []

    const response = streamResponsesWebSocket({
      socket: socket as unknown as WebSocket,
      body: { model: 'gpt-5.5' },
      onQuota: (s) => {
        quotaSnapshot = s
      },
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // Wait for attach() to register onMessage
    await new Promise((r) => setTimeout(r, 10))

    // Emit the codex.rate_limits frame
    socket.write(
      JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: {
          primary: { used_percent: 88, window_minutes: 300, reset_at: 1 },
        },
      }),
    )

    // Emit a regular data event
    socket.write(
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'world',
      }),
    )

    // Emit terminal
    socket.write(
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', usage: {} },
      }),
    )

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      relayedLines.push(decoder.decode(value))
    }

    // onQuota was called with the correct snapshot
    expect(quotaSnapshot).toBeDefined()
    expect(quotaSnapshot!.primary).toBeDefined()
    expect(
      (quotaSnapshot!.primary as Record<string, unknown>).usedPercent,
    ).toBe(88)

    // codex.rate_limits was NOT relayed as SSE output
    const allOutput = relayedLines.join('')
    expect(allOutput).not.toContain('codex.rate_limits')
    // Regular data WAS relayed
    expect(allOutput).toContain('world')
    // Terminal [DONE] emitted
    expect(allOutput).toContain('[DONE]')
  })
})

// ---------------------------------------------------------------------------
// Test 4: 429 → reactive fallback (P5 regression guard)
// ---------------------------------------------------------------------------

describe('integration: 429 → reactive fallback', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string
  const mainToken = 'sk-main-token-abc'
  const fallbackToken = 'sk-fallback-token-xyz'

  beforeEach(() => {
    configDir = tempDir('oai-int-fallback-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    sidebarFile = join(configDir, 'sidebar-state.json')
    logFile = join(configDir, 'test.log')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.NODE_ENV = 'test'
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    // Restore to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  it('retries through a fallback account when main returns 429', async () => {
    // Seed account store with 2 accounts
    const store = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          label: 'Backup Account',
          enabled: true,
          access: fallbackToken,
          refresh: 'fb-refresh',
          expires: Date.now() + 3600_000,
          accountId: 'acc-fb-1',
        },
      ],
    }
    writeFileSync(configFile, JSON.stringify(store))

    const mainTokenRef = { current: mainToken }

    // Mock fetch: first call (main token) returns 429, second (fallback token) returns 200
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      // Inspect the Authorization header to distinguish main vs fallback
      let authHeader = ''
      const headers = (init as Record<string, unknown> | undefined)?.headers
      if (headers) {
        if (headers instanceof Headers) {
          authHeader = headers.get('authorization') ?? ''
        } else if (Array.isArray(headers)) {
          const found = headers.find(
            ([k]: [string, unknown]) => k.toLowerCase() === 'authorization',
          )
          authHeader = found ? String(found[1]) : ''
        } else if (typeof headers === 'object') {
          authHeader = String(
            (headers as Record<string, string>).authorization ?? '',
          )
        }
      }

      if (authHeader.includes(fallbackToken)) {
        return new Response(
          JSON.stringify({
            choices: [{ delta: { content: 'fallback-response' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      // Main token gets 429
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput()
      hooks = await CodexAuthPlugin(input, {
        experimentalWebSockets: false,
      })

      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')

      const loaderResult = await authHook.loader(
        async () => ({
          type: 'oauth' as const,
          provider: 'openai',
          access: mainTokenRef.current,
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
      )

      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: string, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      const response = await fetchOverride(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.5',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      // The response should come from the fallback (200, not 429)
      expect(response.status).toBe(200)

      // P5 regression guard: the response body is live (not cancelled)
      const text = await response.text()
      expect(text).toContain('fallback-response')

      await hooks?.dispose?.()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ---------------------------------------------------------------------------
// Test 5: active fallback routing through the production fetch override
// ---------------------------------------------------------------------------

describe('integration: active fallback routing', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string

  beforeEach(() => {
    configDir = tempDir('oai-int-active-fallback-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    sidebarFile = join(configDir, 'sidebar-state.json')
    logFile = join(configDir, 'test.log')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.NODE_ENV = 'test'
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    // Restore to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  async function loadFetchOverride(
    input: PluginInput,
    mainExpires: number,
    experimentalWebSockets = false,
  ) {
    const hooks = await CodexAuthPlugin(input, {
      experimentalWebSockets,
    })
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error('No auth loader')
    const loaderResult = await authHook.loader(
      async () => ({
        type: 'oauth' as const,
        provider: 'openai',
        access: 'main-stale-token',
        refresh: 'main-refresh-token',
        expires: mainExpires,
      }),
      {
        id: 'openai',
        label: 'OpenAI',
        models: [],
      } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
    )

    const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
      | ((url: string, init?: RequestInit) => Promise<Response>)
      | undefined
    if (!fetchOverride) throw new Error('No fetch in loader result')
    return { hooks, fetchOverride }
  }

  async function runCommand(hooks: Hooks, command: string, args = '') {
    const hook = hooks['command.execute.before'] as
      | ((input: {
          command: string
          arguments: string
          sessionID: string
        }) => Promise<void>)
      | undefined
    if (!hook) throw new Error('No command hook')
    try {
      await hook({ command, arguments: args, sessionID: 'test-session' })
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== '__OPENCODE_OPENAI_AUTH_COMMAND_HANDLED__'
      ) {
        throw error
      }
    }
  }

  function requestInit(): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }
  }

  function responseRequestInit(
    headers: Record<string, string> = {},
  ): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    }
  }

  function headerValue(init: unknown, name: string) {
    const headers = (init as { headers?: HeadersInit } | undefined)?.headers
    if (!headers) return ''
    if (headers instanceof Headers) return headers.get(name) ?? ''
    if (Array.isArray(headers)) {
      const found = headers.find(([key]) => key.toLowerCase() === name)
      return found ? String(found[1]) : ''
    }
    return String((headers as Record<string, string>)[name] ?? '')
  }

  function seedStorage(account: Partial<OAuthAccount>, routing = {}) {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            label: 'Fallback',
            enabled: true,
            refresh: 'fallback-refresh-token',
            accountId: 'acc-fallback-1',
            expires: Date.now() + 3600_000 * 24,
            ...account,
          },
        ],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { activeId: 'fallback-1', ...routing },
      }),
    )
  }

  it('uses the active fallback token without writing it to the auth slot', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const authSetCalls: unknown[] = []
    const seen: Array<{ authorization: string; accountId: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        throw new Error('refresh unavailable')
      }
      seen.push({
        authorization: headerValue(init, 'authorization'),
        accountId: headerValue(init, 'ChatGPT-Account-Id') || null,
      })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput({
        client: {
          auth: { set: async (payload: unknown) => authSetCalls.push(payload) },
          session: { promptAsync: async () => {} },
        } as unknown as PluginInput['client'],
      })
      const loaded = await loadFetchOverride(input, Date.now() + 3600_000)
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seen).toEqual([
        {
          authorization: 'Bearer fallback-access-token',
          accountId: 'acc-fallback-1',
        },
      ])
      expect(authSetCalls).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('waits on a held main refresh file lock and uses the rotated auth token', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
      }),
    )
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    let oauthRefreshCalls = 0
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        oauthRefreshCalls++
        throw new Error('second process must not refresh')
      }
      seen.push(headerValue(init, 'authorization'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const heldLock = await acquireRefreshFileLock({
      name: 'main-refresh',
      ttlMs: 60_000,
      path: configFile,
      renew: true,
    })
    if (!heldLock) throw new Error('failed to acquire test lock')

    let auth = {
      type: 'oauth' as const,
      provider: 'openai',
      access: 'main-stale-token',
      refresh: 'main-refresh-token',
      expires: Date.now() - 1_000,
    }
    setTimeout(() => {
      auth = {
        type: 'oauth' as const,
        provider: 'openai',
        access: 'main-rotated-token',
        refresh: 'main-rotated-refresh',
        expires: Date.now() + 3600_000,
      }
    }, 25)

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput()
      hooks = await CodexAuthPlugin(input, { experimentalWebSockets: false })
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')
      const loaderResult = await authHook.loader(async () => auth, {
        id: 'openai',
        label: 'OpenAI',
        models: [],
      } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1])
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: string, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      const response = await fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(oauthRefreshCalls).toBe(0)
      expect(seen).toEqual(['Bearer main-rotated-token'])
    } finally {
      await heldLock.release()
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('deduplicates concurrent in-process main refreshes and releases the lock on success', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
      }),
    )
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    const authSetCalls: unknown[] = []
    let oauthRefreshCalls = 0
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        oauthRefreshCalls++
        await new Promise((resolve) => setTimeout(resolve, 25))
        return new Response(
          JSON.stringify({
            access_token: 'main-fresh-token',
            refresh_token: 'main-fresh-refresh',
            expires_in: 3600,
            id_token: 'id',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      seen.push(headerValue(init, 'authorization'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let auth = {
      type: 'oauth' as const,
      provider: 'openai',
      access: 'main-stale-token',
      refresh: 'main-refresh-token',
      expires: Date.now() - 1_000,
    }
    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput({
        client: {
          auth: {
            set: async (payload: unknown) => {
              authSetCalls.push(payload)
              const body = (payload as { body: typeof auth }).body
              auth = { ...auth, ...body }
            },
          },
          session: { promptAsync: async () => {} },
        } as unknown as PluginInput['client'],
      })
      hooks = await CodexAuthPlugin(input, { experimentalWebSockets: false })
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')
      const loaderResult = await authHook.loader(async () => auth, {
        id: 'openai',
        label: 'OpenAI',
        models: [],
      } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1])
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: string, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      const [first, second] = await Promise.all([
        fetchOverride('https://api.openai.com/v1/responses', requestInit()),
        fetchOverride('https://api.openai.com/v1/responses', requestInit()),
      ])

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(oauthRefreshCalls).toBe(1)
      expect(authSetCalls).toHaveLength(1)
      expect(seen).toEqual([
        'Bearer main-fresh-token',
        'Bearer main-fresh-token',
      ])

      const releasedLock = await acquireRefreshFileLock({
        name: 'main-refresh',
        ttlMs: 60_000,
        path: configFile,
      })
      expect(releasedLock).not.toBeNull()
      await releasedLock?.release()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('uses a stale main token on refresh failure and releases the lock', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
      }),
    )
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    let oauthRefreshCalls = 0
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        oauthRefreshCalls++
        return new Response('bad refresh', { status: 500 })
      }
      seen.push(headerValue(init, 'authorization'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() - 1_000,
      )
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(oauthRefreshCalls).toBe(1)
      expect(seen).toEqual(['Bearer main-stale-token'])

      const releasedLock = await acquireRefreshFileLock({
        name: 'main-refresh',
        ttlMs: 60_000,
        path: configFile,
      })
      expect(releasedLock).not.toBeNull()
      await releasedLock?.release()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('captures cachekeep fallback targets by storage id, not ChatGPT account id', async () => {
    seedStorage({
      access: 'fallback-access-token',
      accountId: 'chatgpt-work-alt',
    })
    const prompts: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput({
          client: {
            auth: { set: async () => {} },
            session: {
              promptAsync: async (request: unknown) => {
                const body = (
                  request as { body?: { parts?: Array<{ text?: string }> } }
                ).body
                const text = body?.parts?.[0]?.text
                if (text) prompts.push(text)
              },
            },
          } as unknown as PluginInput['client'],
        }),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      await runCommand(hooks, 'openai-cachekeep', 'on')
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'session-id': 'main-session' }),
      )
      await runCommand(hooks, 'openai-cachekeep', 'status')

      const status = prompts.at(-1) ?? ''
      expect(status).toContain('Tracked sessions: **1**')
      expect(status).toContain('(fallback-1)')
      expect(status).not.toContain('(chatgpt-work-alt)')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('keeps capture enabled across loader reconstruction so the new manager can self-arm', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const prompts: string[] = []
    const client = {
      auth: { set: async () => {} },
      session: {
        promptAsync: async (request: unknown) => {
          const body = (
            request as { body?: { parts?: Array<{ text?: string }> } }
          ).body
          const text = body?.parts?.[0]?.text
          if (text) prompts.push(text)
        },
      },
    } as unknown as PluginInput['client']
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let firstHooks: Hooks | undefined
    let secondHooks: Hooks | undefined
    try {
      const first = await loadFetchOverride(
        createMockPluginInput({ client }),
        Date.now() + 3600_000,
      )
      firstHooks = first.hooks
      await runCommand(firstHooks, 'openai-cachekeep', 'on')

      const second = await loadFetchOverride(
        createMockPluginInput({ client }),
        Date.now() + 3600_000,
      )
      secondHooks = second.hooks

      await second.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'session-id': 'main-session' }),
      )
      await runCommand(secondHooks, 'openai-cachekeep', 'status')

      const status = prompts.at(-1) ?? ''
      expect(status).toContain('Timer: **armed**')
      expect(status).toContain('Tracked sessions: **1**')
    } finally {
      globalThis.fetch = originalFetch
      await secondHooks?.dispose?.()
      await firstHooks?.dispose?.()
    }
  })

  it('persists cachekeep enabled on and off', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const client = {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client']

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput({ client }),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      await runCommand(hooks, 'openai-cachekeep', 'on')
      expect(JSON.parse(readFileSync(configFile, 'utf8')).cachekeep).toEqual({
        enabled: true,
      })

      await runCommand(hooks, 'openai-cachekeep', 'off')
      expect(JSON.parse(readFileSync(configFile, 'utf8')).cachekeep).toEqual({
        enabled: false,
      })
    } finally {
      await hooks?.dispose?.()
    }
  })

  it('resolves cachekeep fallback accounts by storage id or ChatGPT account id', () => {
    const accounts: OAuthAccount[] = [
      {
        id: 'work-alt',
        type: 'oauth',
        label: 'Work Alt',
        enabled: true,
        access: 'fallback-access-token',
        refresh: 'fallback-refresh-token',
        expires: Date.now() + 3600_000,
        accountId: '8c97f046-7e21-409b-9829-0488897e475b',
      },
    ]

    expect(findCachekeepFallbackAccount(accounts, 'work-alt')?.id).toBe(
      'work-alt',
    )
    expect(
      findCachekeepFallbackAccount(
        accounts,
        '8c97f046-7e21-409b-9829-0488897e475b',
      )?.id,
    ).toBe('work-alt')
  })

  it('attributes active fallback quota to the fallback and keeps the fresh sidebar activeId', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            label: 'Work Alt',
            enabled: true,
            access: 'work-alt-token',
            refresh: 'work-alt-refresh',
            expires: Date.now() + 3600_000 * 24,
            accountId: 'chatgpt-work-alt',
          },
        ],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { activeId: 'main' },
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-codex-primary-used-percent': '63',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': '1781729038',
        },
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      writeFileSync(
        configFile,
        JSON.stringify({
          version: 1,
          main: { type: 'opencode', provider: 'openai' },
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              label: 'Work Alt',
              enabled: true,
              access: 'work-alt-token',
              refresh: 'work-alt-refresh',
              expires: Date.now() + 3600_000 * 24,
              accountId: 'chatgpt-work-alt',
            },
          ],
          refresh: { refreshBeforeExpiryMinutes: 5 },
          routing: { activeId: 'work-alt' },
        }),
      )

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(response.status).toBe(200)
      await response.body?.cancel()

      const sidebar = await waitForSidebarState(
        sidebarFile,
        (s) =>
          s.activeId === 'work-alt' &&
          s.main.quota === null &&
          s.fallbacks.find((a) => a.id === 'work-alt')?.quota?.primary
            ?.usedPercent === 63,
      )
      expect(sidebar.activeId).toBe('work-alt')
      expect(sidebar.main.quota).toBeNull()
      expect(
        sidebar.fallbacks.find((a) => a.id === 'work-alt')?.quota?.primary
          ?.usedPercent,
      ).toBe(63)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('refreshes an expired active fallback without writing the auth slot', async () => {
    seedStorage({
      access: 'fallback-stale-token',
      expires: Date.now() - 60_000,
    })
    const authSetCalls: unknown[] = []
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'fallback-refreshed-token',
            refresh_token: 'fallback-refresh-new',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      seenAuth.push(headerValue(init, 'authorization'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput({
        client: {
          auth: { set: async (payload: unknown) => authSetCalls.push(payload) },
          session: { promptAsync: async () => {} },
        } as unknown as PluginInput['client'],
      })
      const loaded = await loadFetchOverride(input, Date.now() + 3600_000)
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer fallback-refreshed-token'])
      expect(authSetCalls).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does not throw when active fallback refresh fails and falls back to stale fallback access', async () => {
    seedStorage({
      access: 'fallback-stale-token',
      expires: Date.now() - 60_000,
    })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        throw new Error('refresh unavailable')
      }
      seenAuth.push(headerValue(init, 'authorization'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer fallback-stale-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('captures cachekeep bodies before the WebSocket transport early return', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { activeId: 'main' },
      }),
    )

    const prompts: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput({
          client: {
            auth: { set: async () => {} },
            session: {
              promptAsync: async (request: unknown) => {
                const body = (
                  request as { body?: { parts?: Array<{ text?: string }> } }
                ).body
                const text = body?.parts?.[0]?.text
                if (text) prompts.push(text)
              },
            },
          } as unknown as PluginInput['client'],
        }),
        Date.now() + 3600_000,
        true,
      )
      hooks = loaded.hooks

      await runCommand(hooks, 'openai-cachekeep', 'on')
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'session-id': 'main-session' }),
      )
      await runCommand(hooks, 'openai-cachekeep', 'status')

      expect(prompts.at(-1)).toContain('Tracked sessions: **1**')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does not capture subagent cachekeep bodies with x-parent-session-id', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { activeId: 'main' },
      }),
    )

    const prompts: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, _init?: unknown) => {
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput({
          client: {
            auth: { set: async () => {} },
            session: {
              promptAsync: async (request: unknown) => {
                const body = (
                  request as { body?: { parts?: Array<{ text?: string }> } }
                ).body
                const text = body?.parts?.[0]?.text
                if (text) prompts.push(text)
              },
            },
          } as unknown as PluginInput['client'],
        }),
        Date.now() + 3600_000,
        false,
      )
      hooks = loaded.hooks

      await runCommand(hooks, 'openai-cachekeep', 'on')
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'session-id': 'main-session',
          'x-parent-session-id': 'parent-session',
        }),
      )
      await runCommand(hooks, 'openai-cachekeep', 'status')

      expect(prompts.at(-1)).toContain('Tracked sessions: **0**')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('demotes to main when active fallback has no usable access token', async () => {
    seedStorage({ access: undefined, expires: Date.now() - 60_000 })
    const seen: Array<{ authorization: string; accountId: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      seen.push({
        authorization: headerValue(init, 'authorization'),
        accountId: headerValue(init, 'ChatGPT-Account-Id') || null,
      })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seen.filter((entry) => entry.authorization)).toEqual([
        { authorization: 'Bearer main-stale-token', accountId: null },
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sends the refreshed main token when main primary starts expired', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { activeId: 'main' },
      }),
    )
    const authSetCalls: unknown[] = []
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'main-refreshed-token',
            refresh_token: 'main-refresh-new',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      seenAuth.push(headerValue(init, 'authorization'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput({
        client: {
          auth: { set: async (payload: unknown) => authSetCalls.push(payload) },
          session: { promptAsync: async () => {} },
        } as unknown as PluginInput['client'],
      })
      const loaded = await loadFetchOverride(input, Date.now() - 60_000)
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer main-refreshed-token'])
      expect(authSetCalls.length).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('uses main before other fallbacks when routing mode is unset', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            enabled: true,
            access: 'fallback-primary-token',
            refresh: 'fallback-primary-refresh',
            expires: Date.now() + 3600_000 * 24,
            accountId: 'acc-fallback-primary',
          },
          {
            id: 'fallback-2',
            type: 'oauth',
            enabled: true,
            access: 'fallback-secondary-token',
            refresh: 'fallback-secondary-refresh',
            expires: Date.now() + 3600_000 * 24,
            accountId: 'acc-fallback-secondary',
          },
        ],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { activeId: 'fallback-1' },
      }),
    )
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      return new Response('{}', {
        status: auth.includes('fallback-primary-token') ? 429 : 200,
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual([
        'Bearer fallback-primary-token',
        'Bearer main-stale-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })
})

// ---------------------------------------------------------------------------
// Test 6: Isolated env — no real user config read
// ---------------------------------------------------------------------------

describe('integration: no real config read', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string

  beforeEach(() => {
    configDir = tempDir('oai-int-isolated-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    sidebarFile = join(configDir, 'sidebar-state.json')
    logFile = join(configDir, 'test.log')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.NODE_ENV = 'test'
  })

  afterEach(async () => {
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    // Restore to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  it('getConfigPath uses the isolated temp file, not the real user config', () => {
    const { getConfigPath } = require('../config.ts')
    const path = getConfigPath()
    expect(path).toBe(configFile)
    expect(path).not.toContain('.config/opencode')
  })

  it('getAccountStoragePath uses the isolated temp file', () => {
    const { getAccountStoragePath } = require('../core/accounts.ts')
    const path = getAccountStoragePath()
    expect(path).toBe(configFile)
  })

  it('getAccountStatePath uses the isolated temp file', () => {
    const { getAccountStatePath } = require('../core/accounts.ts')
    const path = getAccountStatePath()
    expect(path).toBe(stateFile)
  })

  it('getSidebarStateFile uses the isolated temp file', () => {
    const sidebarPath = getSidebarStateFile()
    expect(sidebarPath).toBe(sidebarFile)
  })
})

// ---------------------------------------------------------------------------
// Models hook: cost-zeroing toggle
// ---------------------------------------------------------------------------

describe('integration: models cost-zeroing', () => {
  let configDir: string
  let configFile: string
  let stateFile: string

  function mockProvider() {
    return {
      id: 'openai',
      name: 'OpenAI',
      source: 'config' as const,
      env: [],
      options: {},
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          providerID: 'openai',
          api: { id: 'gpt-5.5', url: '', npm: '' },
          name: 'GPT 5.5',
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: { input: 15, output: 60, cache: { read: 7.5, write: 15 } },
          limit: { context: 200_000, output: 128_000 },
          status: 'active' as const,
          options: {},
          headers: {},
          release_date: '2025-01-01',
        },
      },
    }
  }

  function oauthCtx() {
    return {
      auth: {
        type: 'oauth' as const,
        access: 'tok',
        refresh: 'rtok',
        expires: Date.now() + 3600_000,
      },
    }
  }

  function nonOAuthCtx() {
    return { auth: { type: 'api' as const, key: 'sk-test' } }
  }

  beforeEach(() => {
    configDir = tempDir('oai-int-models-')
    configFile = join(configDir, 'openai-auth.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.NODE_ENV = 'test'
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    // Restore path envs to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  it('OAuth + no costZeroing key → costs ZEROED (default-on preserved)', async () => {
    writeFileSync(configFile, JSON.stringify({ version: 1, accounts: [] }))
    const input = createMockPluginInput()
    const hooks = await CodexAuthPlugin(input)
    const modelsFn = hooks.provider?.models
    if (!modelsFn) throw new Error('No models hook')
    const result = await modelsFn(mockProvider(), oauthCtx())
    const model = result['gpt-5.5']!
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  it('OAuth + costZeroing.enabled === false → original cost PRESERVED', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        accounts: [],
        costZeroing: { enabled: false },
      }),
    )
    const input = createMockPluginInput()
    const hooks = await CodexAuthPlugin(input)
    const modelsFn = hooks.provider?.models
    if (!modelsFn) throw new Error('No models hook')
    const result = await modelsFn(mockProvider(), oauthCtx())
    const model = result['gpt-5.5']!
    expect(model.cost).toEqual({
      input: 15,
      output: 60,
      cache: { read: 7.5, write: 15 },
    })
  })

  it('OAuth + costZeroing.enabled === true → costs ZEROED', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        accounts: [],
        costZeroing: { enabled: true },
      }),
    )
    const input = createMockPluginInput()
    const hooks = await CodexAuthPlugin(input)
    const modelsFn = hooks.provider?.models
    if (!modelsFn) throw new Error('No models hook')
    const result = await modelsFn(mockProvider(), oauthCtx())
    const model = result['gpt-5.5']!
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  it('non-OAuth → provider.models returned untouched (no storage read)', async () => {
    const input = createMockPluginInput()
    const hooks = await CodexAuthPlugin(input)
    const modelsFn = hooks.provider?.models
    if (!modelsFn) throw new Error('No models hook')
    const provider = mockProvider()
    const result = await modelsFn(provider, nonOAuthCtx())
    expect(result).toBe(provider.models)
  })
})
