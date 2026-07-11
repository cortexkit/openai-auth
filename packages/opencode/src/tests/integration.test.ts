import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { OAuthAccount } from '../core/accounts.ts'
import { migrateIfNeeded } from '../core/accounts.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import {
  AuthPersistError,
  CodexAuthPlugin,
  findCachekeepFallbackAccount,
  MAIN_REFRESH_LEASE_TTL_MS,
  MAIN_REFRESH_LOCK_TTL_MS,
} from '../index.ts'
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

type FakeWebSocketContext = {
  message(data: string): void
  close(code?: number, reason?: string): void
  /** The `authorization` connect header for this socket, if present. */
  authorization: string
}

type FakeWebSocketBehavior = {
  autoOpen?: boolean
  send?: (data: string) => void
  close?: () => void
}

function headerValue(init: unknown, name: string) {
  const headers = (init as { headers?: HeadersInit } | undefined)?.headers
  if (!headers) return ''
  const lowerName = name.toLowerCase()
  if (headers instanceof Headers) return headers.get(name) ?? ''
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === lowerName)
    return found ? String(found[1]) : ''
  }
  const record = headers as Record<string, string>
  return String(record[name] ?? record[lowerName] ?? '')
}

async function withFakeWebSocket(
  behavior: (context: FakeWebSocketContext) => FakeWebSocketBehavior,
  run: () => Promise<void>,
) {
  const original = globalThis.WebSocket

  class FakeWebSocket {
    static OPEN = 1
    static CLOSED = 3

    url: string
    readyState = 0
    private readonly listeners = new Map<
      string,
      Set<{ fn: (event: unknown) => void; once: boolean }>
    >()
    private readonly behavior: FakeWebSocketBehavior

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url
      this.behavior = behavior({
        message: (data) => this.emit('message', { data }),
        close: (code = 1000, reason = '') => {
          this.readyState = FakeWebSocket.CLOSED
          this.emit('close', { code, reason })
        },
        authorization: options?.headers?.authorization ?? '',
      })
      if (this.behavior.autoOpen !== false) {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN
          this.emit('open', {})
        })
      }
    }

    addEventListener(
      type: string,
      fn: (event: unknown) => void,
      options?: { once?: boolean },
    ) {
      const listeners = this.listeners.get(type) ?? new Set()
      listeners.add({ fn, once: options?.once === true })
      this.listeners.set(type, listeners)
    }

    removeEventListener(type: string, fn: (event: unknown) => void) {
      const listeners = this.listeners.get(type)
      if (!listeners) return
      for (const listener of listeners) {
        if (listener.fn === fn) listeners.delete(listener)
      }
    }

    send(data: string) {
      this.behavior.send?.(data)
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.behavior.close?.()
    }

    private emit(type: string, event: unknown) {
      const listeners = this.listeners.get(type)
      if (!listeners) return
      for (const listener of [...listeners]) {
        listener.fn(event)
        if (listener.once) listeners.delete(listener)
      }
    }
  }

  ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket
  try {
    await run()
  } finally {
    ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      original
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
// Test 2b: Killswitch enforcement through the loader fetch override (end-to-end)
// ---------------------------------------------------------------------------

describe('integration: killswitch enforcement', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string
  const accessToken = 'sk-ks-access'
  const refreshToken = 'sk-ks-refresh'

  beforeEach(() => {
    configDir = tempDir('oai-int-ks-')
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
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
  })

  // Mock fetch: a 200 whose x-codex-* headers report `usedPercent` for the
  // primary window. Counts calls so we can prove a blocked request never spends.
  function mockCodexFetch(usedPercent: number) {
    let calls = 0
    const fn = (async () => {
      calls++
      return new Response('{"choices":[{"delta":{"content":"hi"}}]}', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-primary-used-percent': String(usedPercent),
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(
            Math.floor((Date.now() + 5 * 3600_000) / 1000),
          ),
          'x-codex-secondary-used-percent': String(usedPercent),
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': String(
            Math.floor((Date.now() + 7 * 24 * 3600_000) / 1000),
          ),
        },
      })
    }) as unknown as typeof globalThis.fetch
    return { fn, calls: () => calls }
  }

  async function loaderFetch(hooks: Hooks) {
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error('No auth loader')
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
    const fetchOverride = (loaderResult as Record<string, unknown>).fetch as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>
    if (!fetchOverride) throw new Error('No fetch in loader result')
    return fetchOverride
  }

  const REQ_INIT: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }

  it('blocks the main account with a synthetic 429 + Retry-After once quota drops below the threshold, without spending', async () => {
    // Killswitch ON, main threshold high so a near-exhausted account is killed.
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        killswitch: {
          enabled: true,
          main: { primary: 50, secondary: 50 },
        },
      }),
    )

    const originalFetch = globalThis.fetch
    const mock = mockCodexFetch(95) // 95% used → 5% remaining → below 50%
    globalThis.fetch = mock.fn
    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })
      const fetchOverride = await loaderFetch(hooks)

      // First request: quota is unknown, so it passes the gate, hits upstream,
      // and the 95%-used headers push low quota into the manager.
      const first = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()
      expect(mock.calls()).toBe(1)

      // Second request: cached quota is now below threshold → hard block.
      const second = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(second.status).toBe(429)
      expect(second.headers.get('retry-after')).toBeTruthy()
      const body = (await second.json()) as {
        error?: { type?: string; message?: string }
      }
      expect(body.error?.type).toBe('rate_limit_exceeded')
      expect(body.error?.message).toContain('Killswitch')

      // The blocked request did NOT reach upstream — no extra spend.
      expect(mock.calls()).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does NOT block when the killswitch is disabled (opt-in)', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        // killswitch absent → disabled
      }),
    )

    const originalFetch = globalThis.fetch
    const mock = mockCodexFetch(99) // basically exhausted
    globalThis.fetch = mock.fn
    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })
      const fetchOverride = await loaderFetch(hooks)

      const first = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()

      // Even with quota at 1% remaining, a disabled killswitch never blocks.
      const second = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()
      expect(mock.calls()).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('keeps blocking a killed main across a token refresh (no fail-open leak)', async () => {
    // The leak: the quota cache is token-bound, so a routine OAuth token refresh
    // would turn a known-exhausted account into "unknown" → fail open → spend.
    // The policy peek is identity-bound, so the block must survive the refresh.
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const originalFetch = globalThis.fetch
    const mock = mockCodexFetch(95) // below threshold
    globalThis.fetch = mock.fn
    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })

      // getAuth returns a DIFFERENT access token on each call, emulating a token
      // refresh between the two requests (same account, new credential).
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')
      let authCall = 0
      const loaderResult = await authHook.loader(
        async () => ({
          type: 'oauth' as const,
          provider: 'openai',
          access: `sk-rotating-${authCall++}`,
          refresh: refreshToken,
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
      )
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>

      // Request 1: unknown quota → passes, hits upstream, pushes low quota bound
      // to the first token.
      const first = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()
      expect(mock.calls()).toBe(1)

      // Request 2: getAuth now returns a NEW token. A token-bound read would miss
      // and fail open; the identity-bound policy peek still sees the kill.
      const second = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(second.status).toBe(429)
      await second.body?.cancel()
      // Still no extra spend despite the token change.
      expect(mock.calls()).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does not block a NEW main account with the OLD main account cached quota after a switch', async () => {
    // Killswitch ON. Account A gets killed via its response headers, then the
    // loader stays alive but getAuth() starts returning account B (a re-auth).
    // The killswitch read is bound to the ChatGPT account identity, so B must
    // NOT be blocked by A's killed quota (and must not spend under A's).
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const originalFetch = globalThis.fetch
    const mock = mockCodexFetch(95) // below threshold → A gets killed
    globalThis.fetch = mock.fn
    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')
      // getAuth returns account A first, then account B (identity via accountId).
      let account: 'A' | 'B' = 'A'
      const loaderResult = await authHook.loader(
        async () => ({
          type: 'oauth' as const,
          provider: 'openai',
          access: account === 'A' ? 'access-A' : 'access-B',
          refresh: refreshToken,
          expires: Date.now() + 3600_000,
          accountId: account === 'A' ? 'chatgpt-A' : 'chatgpt-B',
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
      )
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>

      // Req 1 (account A): unknown quota → passes; A's 95%-used headers kill it.
      const first = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()

      // Req 2 (still A): now blocked (A is killed).
      const secondA = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(secondA.status).toBe(429)
      await secondA.body?.cancel()

      // Switch to account B and request again: B has unknown quota → passes.
      account = 'B'
      const firstB = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(firstB.status).toBe(200)
      await firstB.body?.cancel()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('reroutes to a healthy fallback when the killswitch kills main', async () => {
    // Main killed (high threshold), one fallback whose quota is unknown — unknown
    // fails OPEN by default, so it survives the killswitch filter and serves.
    const fallback: OAuthAccount = {
      id: 'fb-healthy',
      type: 'oauth',
      access: 'sk-fb-access',
      refresh: 'sk-fb-refresh',
      expires: Date.now() + 3600_000,
      enabled: true,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [fallback],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const originalFetch = globalThis.fetch
    const mock = mockCodexFetch(95)
    globalThis.fetch = mock.fn
    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })
      const fetchOverride = await loaderFetch(hooks)

      // First request pushes low main quota.
      const first = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()

      // Second request: main is killswitch-blocked, but the healthy fallback
      // serves a 200 (not a 429).
      const second = await fetchOverride(
        'https://api.openai.com/v1/responses',
        REQ_INIT,
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()
      // Two upstream calls served by the fallback path (main never spent on req 2).
      expect(mock.calls()).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('drops late main quota pushed for a previous identity after a switch', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const init = (): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: false }),
    })
    const quotaResponse = (used: number) =>
      new Response('{}', {
        status: 200,
        headers: {
          'x-codex-primary-used-percent': String(used),
          'x-codex-secondary-used-percent': String(used),
        },
      })

    const originalFetch = globalThis.fetch
    let account: 'A' | 'B' = 'A'
    let resolveA: ((response: Response) => void) | undefined
    let sawA: (() => void) | undefined
    const sawAPromise = new Promise<void>((resolve) => {
      sawA = resolve
    })
    const seenAuth: string[] = []
    globalThis.fetch = (async (_url: unknown, request?: unknown) => {
      const auth = headerValue(request, 'authorization')
      seenAuth.push(auth)
      if (auth.includes('access-A')) {
        sawA?.()
        return new Promise<Response>((resolve) => {
          resolveA = resolve
        })
      }
      return quotaResponse(95)
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')
      const loaderResult = await authHook.loader(
        async () => ({
          type: 'oauth' as const,
          provider: 'openai',
          access: account === 'A' ? 'access-A' : 'access-B',
          refresh: refreshToken,
          expires: Date.now() + 3600_000,
          accountId: account === 'A' ? 'chatgpt-A' : 'chatgpt-B',
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
      )
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>

      const firstPromise = fetchOverride(
        'https://api.openai.com/v1/responses',
        init(),
      )
      await sawAPromise

      account = 'B'
      const second = await fetchOverride(
        'https://api.openai.com/v1/responses',
        init(),
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()

      resolveA?.(quotaResponse(10))
      const first = await firstPromise
      expect(first.status).toBe(200)
      await first.body?.cancel()

      const third = await fetchOverride(
        'https://api.openai.com/v1/responses',
        init(),
      )
      expect(third.status).toBe(429)
      await third.body?.cancel()
      expect(seenAuth).toEqual(['Bearer access-A', 'Bearer access-B'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('keeps the newest main identity published when an older refresh finishes late', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const init = (): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: false }),
    })
    const quotaResponse = (used: number) =>
      new Response('{}', {
        status: 200,
        headers: {
          'x-codex-primary-used-percent': String(used),
          'x-codex-secondary-used-percent': String(used),
        },
      })

    const originalFetch = globalThis.fetch
    let account: 'A' | 'B' = 'A'
    let signalRefreshStarted: (() => void) | undefined
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve
    })
    let resolveRefresh: ((response: Response) => void) | undefined
    const seenAuth: string[] = []
    globalThis.fetch = (async (url: unknown, request?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        signalRefreshStarted?.()
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve
        })
      }
      const authorization = headerValue(request, 'authorization')
      seenAuth.push(authorization)
      return quotaResponse(authorization.includes('access-B') ? 95 : 10)
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      hooks = await CodexAuthPlugin(createMockPluginInput(), {
        experimentalWebSockets: false,
      })
      const authHook = hooks.auth
      if (!authHook?.loader) throw new Error('No auth loader')
      const loaderResult = await authHook.loader(
        async () => ({
          type: 'oauth' as const,
          provider: 'openai',
          access: account === 'A' ? 'access-A' : 'access-B',
          refresh: refreshToken,
          expires: account === 'A' ? Date.now() - 1_000 : Date.now() + 3600_000,
          accountId: account === 'A' ? 'chatgpt-A' : 'chatgpt-B',
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
      )
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>

      const firstPromise = fetchOverride(
        'https://api.openai.com/v1/responses',
        init(),
      )
      await refreshStarted

      account = 'B'
      const second = await fetchOverride(
        'https://api.openai.com/v1/responses',
        init(),
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()

      resolveRefresh?.(
        new Response(
          JSON.stringify({
            access_token: 'refreshed-A',
            refresh_token: 'refreshed-A-refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      const first = await firstPromise
      expect(first.status).toBe(200)
      await first.body?.cancel()

      const third = await fetchOverride(
        'https://api.openai.com/v1/responses',
        init(),
      )
      expect(third.status).toBe(429)
      await third.body?.cancel()
      expect(seenAuth).toEqual(['Bearer access-B', 'Bearer refreshed-A'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('uses the served WebSocket ChatGPT account id for main killswitch policy after re-auth', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'x-codex-primary-used-percent': '10',
          'x-codex-secondary-used-percent': '10',
        },
      })) as unknown as typeof globalThis.fetch

    let wsSends = 0
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
          wsSends++
          message(
            JSON.stringify({
              type: 'codex.rate_limits',
              rate_limits: {
                primary: { used_percent: 95, window_minutes: 300 },
                secondary: { used_percent: 95, window_minutes: 10080 },
              },
            }),
          )
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_${wsSends}` },
            }),
          )
        },
      }),
      async () => {
        let account: 'A' | 'B' = 'A'
        try {
          hooks = await CodexAuthPlugin(createMockPluginInput(), {
            experimentalWebSockets: true,
          })
          const authHook = hooks.auth
          if (!authHook?.loader) throw new Error('No auth loader')
          const loaderResult = await authHook.loader(
            async () => ({
              type: 'oauth' as const,
              provider: 'openai',
              access: account === 'A' ? 'access-A' : 'access-B',
              refresh: refreshToken,
              expires: Date.now() + 3600_000,
              accountId: account === 'A' ? 'chatgpt-A' : 'chatgpt-B',
            }),
            {
              id: 'openai',
              label: 'OpenAI',
              models: [],
            } as unknown as Parameters<
              NonNullable<(typeof authHook)['loader']>
            >[1],
          )
          const fetchOverride = (loaderResult as Record<string, unknown>)
            .fetch as (url: string, init?: RequestInit) => Promise<Response>
          const request = (stream: boolean): RequestInit => ({
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'session-id': 'ws-main-identity-session',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream }),
          })

          const seedA = await fetchOverride(
            'https://api.openai.com/v1/responses',
            request(false),
          )
          expect(seedA.status).toBe(200)
          await seedA.body?.cancel()

          account = 'B'
          const pushedB = await fetchOverride(
            'https://api.openai.com/v1/responses',
            request(true),
          )
          expect(pushedB.status).toBe(200)
          await pushedB.text()
          await waitForSidebarState(
            sidebarFile,
            (s) => s.main.quota?.primary?.usedPercent === 95,
          )

          const blockedB = await fetchOverride(
            'https://api.openai.com/v1/responses',
            request(true),
          )
          expect(blockedB.status).toBe(429)
          await blockedB.body?.cancel()
          expect(wsSends).toBe(1)
        } finally {
          globalThis.fetch = originalFetch
          await hooks?.dispose?.()
        }
      },
    )
  })

  it('reroutes to a healthy fallback after main signals mid-stream quota exhaustion over WebSocket', async () => {
    // Killswitch OFF — this reroute must fire purely from the WS mid-stream
    // response.failed rate_limit_reached_type signal, not the killswitch's
    // cached-quota policy. Main's HTTP status is always the synthetic 200 the
    // WS transport returns at upgrade, so a reactive HTTP-status fallback
    // alone would never see this account is exhausted.
    const fallback: OAuthAccount = {
      id: 'fb-healthy',
      type: 'oauth',
      access: 'sk-fb-access-rl',
      refresh: 'sk-fb-refresh-rl',
      expires: Date.now() + 3600_000,
      enabled: true,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [fallback],
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let mainSends = 0
    let fallbackSends = 0
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message, authorization }) => ({
        send() {
          // Distinguish by the ACTUAL account credential on this connection's
          // upgrade headers, not connection order — main reconnects with a
          // fresh socket after invalidate(), so order alone would not prove
          // the reroute reached a different account.
          if (authorization === 'Bearer access-main-rl') {
            // Main's connection: mid-stream quota exhaustion.
            mainSends++
            message(
              JSON.stringify({
                type: 'response.failed',
                response: {
                  id: 'resp_main_failed',
                  failed: { rate_limit_reached_type: 'primary' },
                },
              }),
            )
            return
          }
          // The fallback's connection: succeeds normally.
          fallbackSends++
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_fb_${fallbackSends}` },
            }),
          )
        },
      }),
      async () => {
        try {
          hooks = await CodexAuthPlugin(createMockPluginInput(), {
            experimentalWebSockets: true,
          })
          const authHook = hooks.auth
          if (!authHook?.loader) throw new Error('No auth loader')
          const loaderResult = await authHook.loader(
            async () => ({
              type: 'oauth' as const,
              provider: 'openai',
              access: 'access-main-rl',
              refresh: refreshToken,
              expires: Date.now() + 3600_000,
              accountId: 'chatgpt-main-rl',
            }),
            {
              id: 'openai',
              label: 'OpenAI',
              models: [],
            } as unknown as Parameters<
              NonNullable<(typeof authHook)['loader']>
            >[1],
          )
          const fetchOverride = (loaderResult as Record<string, unknown>)
            .fetch as (url: string, init?: RequestInit) => Promise<Response>
          const wsRequest: RequestInit = {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'session-id': 'ws-rate-limit-reroute-session',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
          }

          // Request 1: main's stream hits mid-stream rate_limit_reached_type.
          // The synthetic WS status is still 200 — the reroute cannot come
          // from a reactive HTTP-status check on THIS response.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await first.text()

          // Request 2: main is now marked rate-limited from request 1's
          // in-band signal, so the fetch override must reroute to the
          // fallback WITHOUT ever re-sending to main.
          const second = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(second.status).toBe(200)
          await second.text()

          expect(mainSends).toBe(1)
          expect(fallbackSends).toBe(1)
        } finally {
          globalThis.fetch = originalFetch
          await hooks?.dispose?.()
        }
      },
    )
  })

  it('excludes a rate-limited fallback from candidate selection after a mid-stream mark', async () => {
    // fallback-first: the single fallback is tried before main. Its own
    // mid-stream rate_limit_reached_type mark must make usableFallbackCandidates
    // exclude it on the NEXT request — this filter is always-on, independent
    // of the killswitch (off here).
    const fallback: OAuthAccount = {
      id: 'fb-excluded',
      type: 'oauth',
      access: 'sk-fb-access-excl',
      refresh: 'sk-fb-refresh-excl',
      expires: Date.now() + 3600_000,
      enabled: true,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [fallback],
        routing: { mode: 'fallback-first' },
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let fallbackSends = 0
    let mainSends = 0
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message, authorization }) => ({
        send() {
          // Distinguish by the ACTUAL account credential on this connection's
          // upgrade headers, not connection order — the fallback pool entry
          // can reconnect with a fresh socket after invalidate(), so order
          // alone would not prove request 2 actually reached main.
          if (authorization === 'Bearer sk-fb-access-excl') {
            // The fallback's own connection: mid-stream exhaustion, but the
            // WS transport still returns 200, so tryFallbackFirst treats
            // this as a success and serves it.
            fallbackSends++
            message(
              JSON.stringify({
                type: 'response.failed',
                response: {
                  id: 'resp_fb_failed',
                  failed: { rate_limit_reached_type: 'secondary' },
                },
              }),
            )
            return
          }
          // Main's connection — only reached on request 2, once the
          // fallback is excluded from candidate selection.
          mainSends++
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_main_${mainSends}` },
            }),
          )
        },
      }),
      async () => {
        try {
          hooks = await CodexAuthPlugin(createMockPluginInput(), {
            experimentalWebSockets: true,
          })
          const authHook = hooks.auth
          if (!authHook?.loader) throw new Error('No auth loader')
          const loaderResult = await authHook.loader(
            async () => ({
              type: 'oauth' as const,
              provider: 'openai',
              access: 'access-main-excl',
              refresh: refreshToken,
              expires: Date.now() + 3600_000,
              accountId: 'chatgpt-main-excl',
            }),
            {
              id: 'openai',
              label: 'OpenAI',
              models: [],
            } as unknown as Parameters<
              NonNullable<(typeof authHook)['loader']>
            >[1],
          )
          const fetchOverride = (loaderResult as Record<string, unknown>)
            .fetch as (url: string, init?: RequestInit) => Promise<Response>
          const wsRequest: RequestInit = {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'session-id': 'ws-fallback-exclude-session',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
          }

          // Request 1: fallback-first tries the fallback; its stream hits
          // mid-stream rate_limit_reached_type but still returns 200, so
          // tryFallbackFirst marks it used and serves this response.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await first.text()

          // Request 2: the fallback is now marked rate-limited from request
          // 1's in-band signal, so usableFallbackCandidates excludes it and
          // routing falls through to main WITHOUT re-trying the fallback.
          const second = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(second.status).toBe(200)
          await second.text()

          expect(fallbackSends).toBe(1)
          expect(mainSends).toBe(1)
        } finally {
          globalThis.fetch = originalFetch
          await hooks?.dispose?.()
        }
      },
    )
  })

  it('reroutes on a mid-stream mark even with the killswitch ENABLED (OR precedence, not AND)', async () => {
    // Killswitch ON, but main's cached quota is unknown (nothing has pushed
    // it in this test), so killswitchPassesPolicy fails OPEN and
    // killswitchBlocksMain is false on its own — only the mid-stream mark
    // makes `killswitchBlocksMain || mainRateLimited` true. This documents
    // the block condition is an OR, not an AND: a future re-ordering to
    // `&&` would silently stop rerouting on a mid-stream mark whenever the
    // killswitch happens to be enabled, and this test would catch it.
    const fallback: OAuthAccount = {
      id: 'fb-healthy-ks-on',
      type: 'oauth',
      access: 'sk-fb-access-ks-on',
      refresh: 'sk-fb-refresh-ks-on',
      expires: Date.now() + 3600_000,
      enabled: true,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    }
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [fallback],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let mainSends = 0
    let fallbackSends = 0
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message, authorization }) => ({
        send() {
          if (authorization === 'Bearer access-main-ks-on') {
            mainSends++
            message(
              JSON.stringify({
                type: 'response.failed',
                response: {
                  id: 'resp_main_failed_ks_on',
                  failed: { rate_limit_reached_type: 'primary' },
                },
              }),
            )
            return
          }
          fallbackSends++
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_fb_ks_on_${fallbackSends}` },
            }),
          )
        },
      }),
      async () => {
        try {
          hooks = await CodexAuthPlugin(createMockPluginInput(), {
            experimentalWebSockets: true,
          })
          const authHook = hooks.auth
          if (!authHook?.loader) throw new Error('No auth loader')
          const loaderResult = await authHook.loader(
            async () => ({
              type: 'oauth' as const,
              provider: 'openai',
              access: 'access-main-ks-on',
              refresh: refreshToken,
              expires: Date.now() + 3600_000,
              accountId: 'chatgpt-main-ks-on',
            }),
            {
              id: 'openai',
              label: 'OpenAI',
              models: [],
            } as unknown as Parameters<
              NonNullable<(typeof authHook)['loader']>
            >[1],
          )
          const fetchOverride = (loaderResult as Record<string, unknown>)
            .fetch as (url: string, init?: RequestInit) => Promise<Response>
          const wsRequest: RequestInit = {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'session-id': 'ws-rate-limit-reroute-ks-on-session',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
          }

          // Request 1: main's stream hits mid-stream rate_limit_reached_type.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await first.text()

          // Request 2: main is marked rate-limited from request 1's in-band
          // signal. The killswitch itself is enabled but fails open on
          // main's unknown quota — the reroute must still fire from the
          // mid-stream mark alone, proving the OR (not AND) semantics.
          const second = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(second.status).toBe(200)
          await second.text()

          expect(mainSends).toBe(1)
          expect(fallbackSends).toBe(1)
        } finally {
          globalThis.fetch = originalFetch
          await hooks?.dispose?.()
        }
      },
    )
  })

  it('a mid-stream block with no cached quota gives a ~60s Retry-After (the mark), not the killswitch 300s default', async () => {
    // Killswitch OFF, no fallback accounts — the hard-block path. With no
    // cached quota anywhere, killswitchRetryAfterSeconds alone would fall
    // back to its 300s default; the mark's own DEFAULT_MID_STREAM_RATE_LIMIT_
    // RESET_MS (~60s) must win instead so the client isn't told to wait 4
    // extra minutes past the mark's actual expiry.
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let mainSends = 0
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
          mainSends++
          message(
            JSON.stringify({
              type: 'response.failed',
              response: {
                id: 'resp_main_failed_no_quota',
                failed: { rate_limit_reached_type: 'primary' },
              },
            }),
          )
        },
      }),
      async () => {
        try {
          hooks = await CodexAuthPlugin(createMockPluginInput(), {
            experimentalWebSockets: true,
          })
          const authHook = hooks.auth
          if (!authHook?.loader) throw new Error('No auth loader')
          const loaderResult = await authHook.loader(
            async () => ({
              type: 'oauth' as const,
              provider: 'openai',
              access: 'access-main-no-quota',
              refresh: refreshToken,
              expires: Date.now() + 3600_000,
              accountId: 'chatgpt-main-no-quota',
            }),
            {
              id: 'openai',
              label: 'OpenAI',
              models: [],
            } as unknown as Parameters<
              NonNullable<(typeof authHook)['loader']>
            >[1],
          )
          const fetchOverride = (loaderResult as Record<string, unknown>)
            .fetch as (url: string, init?: RequestInit) => Promise<Response>
          const wsRequest: RequestInit = {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'session-id': 'ws-mid-stream-retry-after-session',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
          }

          // Request 1: main hits mid-stream rate_limit_reached_type; no
          // fallback exists to reroute to, so the mark is set for the next
          // request.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await first.text()

          // Request 2: main is marked rate-limited and there is no fallback
          // to reroute to, so this hits the hard-block path.
          const second = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(second.status).toBe(429)
          const retryAfter = Number(second.headers.get('retry-after'))
          expect(retryAfter).toBeGreaterThan(0)
          expect(retryAfter).toBeLessThanOrEqual(60)
          await second.body?.cancel()

          expect(mainSends).toBe(1)
        } finally {
          globalThis.fetch = originalFetch
          await hooks?.dispose?.()
        }
      },
    )
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
        // fallback-first: the single fallback is tried before main, so it serves.
        routing: { mode: 'fallback-first', ...routing },
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

  it('fallback-first attributes served-fallback quota to the fallback and marks it active in the sidebar', async () => {
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
        // fallback-first: the fallback is tried before main and serves.
        routing: { mode: 'fallback-first' },
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

  it('fallback-first uses a still-valid fallback token when its refresh fails', async () => {
    // Token is inside the refresh window (needs refresh) but NOT expired, so a
    // failed refresh must not drop it — the still-valid token is used.
    seedStorage({
      access: 'fallback-stale-token',
      expires: Date.now() + 2 * 60_000,
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

  it('fallback-first does not re-try fallbacks reactively after main also fails (no double-spend)', async () => {
    // fallback-first with one fallback that 429s: the proactive gate tries it,
    // falls through to main, and main also 429s. The reactive path must NOT
    // re-try the already-tried fallback — so the fallback is hit exactly once.
    seedStorage({ access: 'fallback-access-token' })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        throw new Error('refresh unavailable')
      }
      seenAuth.push(headerValue(init, 'authorization'))
      // Everything is rate-limited.
      return new Response('{}', { status: 429 })
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
      expect(response.status).toBe(429)
      await response.body?.cancel()
      // Fallback tried once (proactive), then main once — no reactive re-try.
      expect(seenAuth).toEqual([
        'Bearer fallback-access-token',
        'Bearer main-stale-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('fallback-first propagates a transport error without replaying on main', async () => {
    // The fallback send may already have generated or billed before the
    // transport error surfaced, so routing must stop instead of replaying.
    seedStorage({ access: 'fallback-access-token' })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        throw new Error('refresh unavailable')
      }
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      if (auth.includes('fallback-access-token')) {
        throw new Error('ECONNRESET')
      }
      return new Response('main must not be called', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      let caught: unknown
      try {
        await loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          requestInit(),
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe('ECONNRESET')
      expect(seenAuth).toEqual(['Bearer fallback-access-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('fallback-first propagates caller aborts without trying main', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      throw new DOMException('request aborted', 'AbortError')
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      let caught: unknown
      try {
        await loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          requestInit(),
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DOMException)
      expect((caught as DOMException).name).toBe('AbortError')
      expect(seenAuth).toEqual(['Bearer fallback-access-token'])
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
        routing: { mode: 'main-first' },
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
        routing: { mode: 'main-first' },
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
        routing: { mode: 'main-first' },
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

  it('main-first (default): tries main first, then reactively falls back on 429', async () => {
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
        // Default (main-first): main is the primary; no per-account pin.
        routing: { mode: 'main-first' },
      }),
    )
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    // Main (main-stale-token) is rate-limited → reactive fallback to fallback-1.
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      return new Response('{}', {
        status: auth.includes('main-stale-token') ? 429 : 200,
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
      // Main tried first, then the first usable fallback served.
      expect(seenAuth).toEqual([
        'Bearer main-stale-token',
        'Bearer fallback-primary-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('records quota from a failed fallback so the killswitch skips it next turn', async () => {
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
            access: 'fallback-access-token',
            refresh: 'fallback-refresh-token',
            expires: Date.now() + 3600_000 * 24,
            accountId: 'acc-fallback-1',
          },
        ],
        routing: { mode: 'fallback-first' },
        killswitch: {
          enabled: true,
          accounts: { 'fallback-1': { primary: 50, secondary: 50 } },
        },
      }),
    )

    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      if (auth.includes('fallback-access-token')) {
        return new Response('{}', {
          status: 429,
          headers: {
            'x-codex-primary-used-percent': '95',
            'x-codex-secondary-used-percent': '95',
          },
        })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const first = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()

      const second = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()
      expect(seenAuth).toEqual([
        'Bearer fallback-access-token',
        'Bearer main-stale-token',
        'Bearer main-stale-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('preserves a fresh fallback quota window when a partial failed snapshot arrives', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const originalFetch = globalThis.fetch
    let fallbackCalls = 0
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      if (auth.includes('fallback-access-token')) {
        fallbackCalls++
        return new Response('{}', {
          status: 429,
          headers:
            fallbackCalls === 1
              ? {
                  'x-codex-primary-used-percent': '10',
                  'x-codex-secondary-used-percent': '95',
                }
              : { 'x-codex-primary-used-percent': '20' },
        })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const first = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()

      const second = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()

      const sidebar = await waitForSidebarState(
        sidebarFile,
        (s) =>
          s.fallbacks.find((a) => a.id === 'fallback-1')?.quota?.primary
            ?.usedPercent === 20 &&
          s.fallbacks.find((a) => a.id === 'fallback-1')?.quota?.secondary
            ?.usedPercent === 95,
      )
      const quota = sidebar.fallbacks.find((a) => a.id === 'fallback-1')?.quota
      expect(quota?.primary?.usedPercent).toBe(20)
      expect(quota?.secondary?.usedPercent).toBe(95)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does not preserve a fallback quota window after its reset passed', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const originalFetch = globalThis.fetch
    const pastReset = Math.floor((Date.now() - 60_000) / 1000)
    let fallbackCalls = 0
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      if (auth.includes('fallback-access-token')) {
        fallbackCalls++
        return new Response('{}', {
          status: 429,
          headers:
            fallbackCalls === 1
              ? {
                  'x-codex-primary-used-percent': '10',
                  'x-codex-secondary-used-percent': '95',
                  'x-codex-secondary-reset-at': String(pastReset),
                }
              : { 'x-codex-primary-used-percent': '20' },
        })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const first = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(first.status).toBe(200)
      await first.body?.cancel()

      const second = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(second.status).toBe(200)
      await second.body?.cancel()

      const sidebar = await waitForSidebarState(sidebarFile, (state) => {
        const quota = state.fallbacks.find(
          (account) => account.id === 'fallback-1',
        )?.quota
        return quota?.primary?.usedPercent === 20 && !quota.secondary
      })
      const quota = sidebar.fallbacks.find(
        (account) => account.id === 'fallback-1',
      )?.quota
      expect(quota?.primary?.usedPercent).toBe(20)
      expect(quota?.secondary).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does not replay non-responses POSTs or GET requests through fallbacks', async () => {
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
            access: 'fallback-access-token',
            refresh: 'fallback-refresh-token',
            expires: Date.now() + 3600_000 * 24,
            accountId: 'acc-fallback-1',
          },
        ],
        routing: { mode: 'main-first' },
      }),
    )

    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      seenAuth.push(headerValue(init, 'authorization'))
      return new Response('main limited', { status: 429 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      const chat = await loaded.fetchOverride(
        'https://api.openai.com/v1/chat/completions',
        requestInit(),
      )
      expect(chat.status).toBe(429)
      expect(await chat.text()).toBe('main limited')

      const get = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        { method: 'GET' },
      )
      expect(get.status).toBe(429)
      expect(await get.text()).toBe('main limited')
      expect(seenAuth).toEqual([
        'Bearer main-stale-token',
        'Bearer main-stale-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('stops reactive fallback on an indeterminate transport throw and returns the primary response', async () => {
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
            access: 'fallback-throw-token',
            refresh: 'fallback-throw-refresh',
            expires: Date.now() + 3600_000 * 24,
          },
          {
            id: 'fallback-2',
            type: 'oauth',
            enabled: true,
            access: 'fallback-never-token',
            refresh: 'fallback-never-refresh',
            expires: Date.now() + 3600_000 * 24,
          },
        ],
        routing: { mode: 'main-first' },
      }),
    )

    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      if (auth.includes('fallback-throw-token')) throw new Error('ECONNRESET')
      if (auth.includes('fallback-never-token')) {
        return new Response('should not be called', { status: 200 })
      }
      return new Response('primary body stays readable', { status: 429 })
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
      expect(response.status).toBe(429)
      expect(await response.text()).toBe('primary body stays readable')
      expect(seenAuth).toEqual([
        'Bearer main-stale-token',
        'Bearer fallback-throw-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('propagates caller aborts from reactive fallback attempts', async () => {
    seedStorage({ access: 'fallback-access-token' }, { mode: 'main-first' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      if (auth.includes('fallback-access-token')) {
        throw new DOMException('request aborted', 'AbortError')
      }
      return new Response('main limited', { status: 429 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      let caught: unknown
      try {
        await loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          requestInit(),
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DOMException)
      expect((caught as DOMException).name).toBe('AbortError')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('orders HTTP Codex bodies the same way as WebSocket bodies', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        routing: { mode: 'main-first' },
      }),
    )
    const request = (): RequestInit => ({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'session-id': 'body-order-session',
      },
      body: JSON.stringify({
        stream: true,
        client_metadata: { existing: 'yes' },
        input: [{ role: 'user', content: 'hi' }],
        previous_response_id: 'resp_prev',
        model: 'gpt-5.5',
        type: 'response.create',
        reasoning: { effort: 'low' },
        tools: [],
        store: false,
      }),
    })
    const expectedKeys = [
      'type',
      'model',
      'previous_response_id',
      'input',
      'tools',
      'parallel_tool_calls',
      'reasoning',
      'store',
      'stream',
      'prompt_cache_key',
      'client_metadata',
    ]

    const originalFetch = globalThis.fetch
    let httpBody = ''
    let httpHooks: Hooks | undefined
    try {
      globalThis.fetch = (async (_url: unknown, init?: unknown) => {
        httpBody = String((init as { body?: unknown } | undefined)?.body ?? '')
        return new Response('{}', { status: 200 })
      }) as unknown as typeof globalThis.fetch
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
      )
      httpHooks = loaded.hooks
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )
      expect(response.status).toBe(200)
      await response.body?.cancel()
    } finally {
      globalThis.fetch = originalFetch
      await httpHooks?.dispose?.()
    }

    let wsBody = ''
    let wsHooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message }) => ({
        send(data) {
          wsBody = data
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_order' },
            }),
          )
        },
      }),
      async () => {
        try {
          globalThis.fetch = (async () =>
            new Response('{}', {
              status: 200,
            })) as unknown as typeof globalThis.fetch
          const loaded = await loadFetchOverride(
            createMockPluginInput(),
            Date.now() + 3600_000,
            true,
          )
          wsHooks = loaded.hooks
          const response = await loaded.fetchOverride(
            'https://api.openai.com/v1/responses',
            request(),
          )
          expect(response.status).toBe(200)
          await response.text()
        } finally {
          globalThis.fetch = originalFetch
          await wsHooks?.dispose?.()
        }
      },
    )

    expect(Object.keys(JSON.parse(httpBody))).toEqual(expectedKeys)
    expect(Object.keys(JSON.parse(wsBody))).toEqual(expectedKeys)
  })

  it('keeps the main refresh advisory lease shorter than the file lock TTL', () => {
    expect(MAIN_REFRESH_LEASE_TTL_MS).toBe(90_000)
    expect(MAIN_REFRESH_LEASE_TTL_MS).toBeLessThan(MAIN_REFRESH_LOCK_TTL_MS)
  })

  it('retries persisting rotated main tokens without refreshing twice', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { mode: 'main-first' },
      }),
    )
    const originalFetch = globalThis.fetch
    const seenAuth: string[] = []
    let oauthRefreshCalls = 0
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        oauthRefreshCalls++
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

    let authSetCalls = 0
    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput({
        client: {
          auth: {
            set: async () => {
              authSetCalls++
              if (authSetCalls < 3) throw new Error('temporary auth write')
            },
          },
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
      await response.body?.cancel()
      expect(oauthRefreshCalls).toBe(1)
      expect(authSetCalls).toBe(3)
      expect(seenAuth).toEqual(['Bearer main-refreshed-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('surfaces a distinct auth persistence error after rotated tokens cannot be saved', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { mode: 'main-first' },
      }),
    )
    const originalFetch = globalThis.fetch
    const seenAuth: string[] = []
    let oauthRefreshCalls = 0
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        oauthRefreshCalls++
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

    let authSetCalls = 0
    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput({
        client: {
          auth: {
            set: async () => {
              authSetCalls++
              throw new Error('auth write failed')
            },
          },
          session: { promptAsync: async () => {} },
        } as unknown as PluginInput['client'],
      })
      const loaded = await loadFetchOverride(input, Date.now() - 60_000)
      hooks = loaded.hooks

      let caught: unknown
      try {
        await loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          requestInit(),
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AuthPersistError)
      expect((caught as AuthPersistError).code).toBe(
        'OPENAI_AUTH_PERSIST_FAILED',
      )
      expect(oauthRefreshCalls).toBe(1)
      expect(authSetCalls).toBe(3)
      expect(seenAuth).toEqual([])
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
