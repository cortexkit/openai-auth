import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { OAuthAccount } from '../core/accounts.ts'
import { migrateIfNeeded } from '../core/accounts.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import { QUOTA_STALENESS_MS } from '../core/sticky-routing.ts'
import {
  AuthPersistError,
  type ClaustrumCacheTransportLike,
  CodexAuthPlugin,
  type CustodyRuntime,
  findCachekeepFallbackAccount,
  MAIN_REFRESH_LEASE_TTL_MS,
  MAIN_REFRESH_LOCK_TTL_MS,
  resolveSidebarSessionId,
} from '../index.ts'
import { flushForTest, setLogLevel } from '../logger.ts'
import { resetModelCostsForTest } from '../model-costs.ts'
import { ResponseStreamError } from '../response-stream-error'
import {
  drainSidebarWrites,
  getSidebarStateFile,
  hashSidebarSessionId,
  normalizeSidebarState,
  resolveSessionSidebarRouting,
  type SidebarState,
} from '../sidebar-state.ts'
import {
  claustrumConfig,
  enrollmentManifest,
  makeSentinelAccount,
} from './custody-fixtures.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_MODELS_CACHE,
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
  upgradeHeaders: Record<string, string>
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
        upgradeHeaders: options?.headers ?? {},
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

/**
 * True for the turn's own request to the provider.
 *
 * The loader also issues authorized background traffic — a wham/usage quota
 * refresh at init, and OAuth token exchanges — which is unawaited, so a recorder
 * or counter that captures every fetch races it: the extra call lands before an
 * assertion on an idle machine and after it under suite load. Filtering by
 * destination keeps a test measuring the request it is about, rather than
 * whatever the loader happened to send alongside it.
 */
function isResponsesSend(url: unknown) {
  return String(url).includes('/responses')
}

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
    resetModelCostsForTest()
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
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
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

  it('records served routing for child and parent sessions', async () => {
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
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch

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
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      const serve = async (sessionId: string, parentId?: string) => {
        const headers = new Headers({
          'content-type': 'application/json',
          'session-id': sessionId,
        })
        if (parentId) headers.set('x-parent-session-id', parentId)
        const response = await fetchOverride(
          'https://api.openai.com/v1/responses',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
          },
        )
        expect(response.status).toBe(200)
        await response.body?.cancel()
      }

      await serve('child-session', 'parent-session')
      await serve('child-only-session')
      await serve('same-session', 'same-session')
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(Object.keys(sidebar.activeRouting ?? {}).sort()).toEqual([
        'child-only-session',
        'child-session',
        'parent-session',
        'same-session',
      ])
      expect(sidebar.activeRouting?.['child-session']).toMatchObject({
        activeId: 'main',
        route: 'main-first',
      })
      expect(sidebar.activeRouting?.['parent-session']).toEqual(
        sidebar.activeRouting?.['child-session'],
      )
      expect(sidebar.activeRouting?.['child-only-session']).toMatchObject({
        activeId: 'main',
        route: 'main-first',
      })
      expect(sidebar.activeRouting?.['same-session']).toMatchObject({
        activeId: 'main',
        route: 'main-first',
      })

      renameSync(sidebarFile, `${sidebarFile}.saved`)
      mkdirSync(sidebarFile)
      await serve('unwritable-child', 'unwritable-parent')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('a complete header frame reporting every window retired clears cached windows', async () => {
    const store = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
    }
    writeFileSync(configFile, JSON.stringify(store))

    // First response carries a real primary window — seeds the cache.
    let respondWithRealWindow = true
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      const headers = new Headers(
        respondWithRealWindow
          ? {
              'content-type': 'text/event-stream',
              'x-codex-primary-used-percent': '42',
              'x-codex-primary-window-minutes': '10080',
              'x-codex-primary-reset-at': '1781729038',
            }
          : {
              'content-type': 'text/event-stream',
              'x-codex-primary-used-percent': '0',
              'x-codex-primary-window-minutes': '0',
              'x-codex-secondary-used-percent': '0',
              'x-codex-secondary-window-minutes': '0',
            },
      )
      return new Response('{"choices":[{"delta":{"content":"hello"}}]}', {
        status: 200,
        headers,
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput()
      hooks = await CodexAuthPlugin(input, { experimentalWebSockets: false })
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
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      const request = (): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      const seed = await fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )
      await seed.body?.cancel()
      await waitForSidebarState(
        sidebarFile,
        (s) => s.main.quota?.primary?.usedPercent === 42,
      )

      respondWithRealWindow = false
      const retired = await fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )
      await retired.body?.cancel()

      const sidebar = await waitForSidebarState(
        sidebarFile,
        (s) => s.main.quota?.primary === undefined,
      )
      expect(sidebar.main.quota?.primary).toBeUndefined()
      expect(sidebar.main.quota?.secondary).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('a truly empty header set (no x-codex-* headers) does NOT clobber cached windows', async () => {
    const store = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
    }
    writeFileSync(configFile, JSON.stringify(store))

    let respondWithRealWindow = true
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      const headers = new Headers(
        respondWithRealWindow
          ? {
              'content-type': 'text/event-stream',
              'x-codex-primary-used-percent': '42',
              'x-codex-primary-window-minutes': '10080',
              'x-codex-primary-reset-at': '1781729038',
            }
          : { 'content-type': 'text/event-stream' },
      )
      return new Response('{"choices":[{"delta":{"content":"hello"}}]}', {
        status: 200,
        headers,
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const input = createMockPluginInput()
      hooks = await CodexAuthPlugin(input, { experimentalWebSockets: false })
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
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('No fetch in loader result')

      const request = (): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      const seed = await fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )
      await seed.body?.cancel()
      await waitForSidebarState(
        sidebarFile,
        (s) => s.main.quota?.primary?.usedPercent === 42,
      )

      respondWithRealWindow = false
      const nonQuota = await fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )
      await nonQuota.body?.cancel()

      // Give any (incorrect) clearing write a chance to land before asserting
      // the cache survived.
      await drainSidebarWrites()
      const sidebar = JSON.parse(
        readFileSync(sidebarFile, 'utf8'),
      ) as SidebarState
      expect(sidebar.main.quota?.primary?.usedPercent).toBe(42)
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
    const fn = (async (url: unknown) => {
      // Count the turn's own sends only. The loader also issues an authorized,
      // unawaited quota refresh at init, so counting every fetch makes any
      // call-count assertion race it: it lands before the assertion on an idle
      // machine and after it under suite load.
      if (isResponsesSend(url)) calls++
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
    globalThis.fetch = (async (url: unknown, request?: unknown) => {
      const auth = headerValue(request, 'authorization')
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(auth)
      // Serve quota only to the turn's own send. This stub answers every URL,
      // and the loader's init quota refresh calls wham/usage before the test's
      // first request — so without this the refresh seeds the 95%-used quota
      // below, the killswitch acts on it, and the request under test is blocked
      // before the identity logic this test is about ever runs.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 200 })
      }
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(authorization)
      // Make the quota endpoint unavailable: this test is about which
      // identity's quota wins, not about quota reporting. The loader refreshes
      // quota at init,
      // and a SUCCESSFUL response there is worse than an error — an empty body
      // publishes an "unknown" snapshot that overwrites the exhausted quota this
      // test establishes, and unknown fails open, so the request under test
      // reaches the wire instead of being blocked.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 500 })
      }
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
          // The synthetic WS status is 200 at upgrade, but reading the body
          // must REJECT with a retryable stream error — that is exactly what
          // makes OpenCode's outer retry loop re-issue the request (a normal
          // close would end the turn silently with no reroute). The mark is
          // set as a side effect before the body errors.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          let firstError: unknown
          try {
            await first.text()
          } catch (err) {
            firstError = err
          }
          expect(firstError).toBeInstanceOf(ResponseStreamError)
          expect((firstError as { isRetryable?: boolean }).isRetryable).toBe(
            true,
          )

          // Request 2 models OpenCode's retry-driven re-issue: main is now
          // marked rate-limited from request 1's in-band signal, so the fetch
          // override must reroute to the fallback WITHOUT re-sending to main.
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

  it('reroutes to a healthy fallback after main rejects WebSocket admission with usage_limit_reached', async () => {
    const fallback: OAuthAccount = {
      id: 'fb-admission-healthy',
      type: 'oauth',
      access: 'sk-fb-admission-access',
      refresh: 'sk-fb-admission-refresh',
      expires: Date.now() + 24 * 3600_000,
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
          if (authorization === 'Bearer access-main-admission-rl') {
            mainSends++
            message(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'usage_limit_reached',
                  message: 'The usage limit has been reached',
                  plan_type: 'team',
                  resets_at: 1_784_958_366,
                  eligible_promo: null,
                  resets_in_seconds: 514_504,
                },
              }),
            )
            return
          }
          fallbackSends++
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_fb_admission_${fallbackSends}` },
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
              access: 'access-main-admission-rl',
              refresh: refreshToken,
              expires: Date.now() + 24 * 3600_000,
              accountId: 'chatgpt-main-admission-rl',
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
              'session-id': 'ws-admission-rate-limit-reroute-session',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
          }

          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await expect(first.text()).rejects.toMatchObject({
            isRetryable: true,
          })

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
          // mid-stream rate_limit_reached_type. The response is served (200 at
          // upgrade) but reading the body rejects with a retryable stream
          // error, which sets the mark and drives OpenCode's re-issue.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await expect(first.text()).rejects.toBeInstanceOf(ResponseStreamError)

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
          // Reading the body rejects with the retryable stream error (the
          // reissue trigger) and sets the mark as a side effect.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await expect(first.text()).rejects.toBeInstanceOf(ResponseStreamError)

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
          // fallback exists to reroute to. Reading the body rejects with the
          // retryable stream error and sets the mark for the re-issue.
          const first = await fetchOverride(
            'https://api.openai.com/v1/responses',
            wsRequest,
          )
          expect(first.status).toBe(200)
          await expect(first.text()).rejects.toBeInstanceOf(ResponseStreamError)

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

  it('attributes an early fallback WS quota push to the served fallback', async () => {
    const now = Date.now()
    const fallback = {
      id: 'fallback-1',
      type: 'oauth' as const,
      label: 'Fallback 1',
      enabled: true,
      access: 'fallback-access',
      refresh: 'fallback-refresh',
      expires: now + 24 * 3600_000,
      accountId: 'chatgpt-fallback-1',
    }
    const quota = (usedPercent: number, resetCreditsAvailable: number) => ({
      primary: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        checkedAt: now,
        windowMinutes: 300,
      },
      resetCreditsAvailable,
    })
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [{ ...fallback, quota: quota(30, 2) }],
        routing: { mode: 'fallback-first' },
        quota: {
          mainQuota: quota(20, 4),
          mainQuotaCheckedAt: now,
        },
      }),
    )
    writeFileSync(
      sidebarFile,
      JSON.stringify({
        main: { quota: quota(20, 4), killed: false },
        fallbacks: [
          {
            id: fallback.id,
            label: fallback.label,
            quota: quota(30, 2),
            killed: false,
            enabled: true,
            resetCredits: 2,
          },
        ],
        activeId: 'main',
        route: 'fallback-first',
        lastUpdated: 1,
      }),
    )

    const originalFetch = globalThis.fetch
    // The quota endpoint is deliberately unavailable: this test seeds reset
    // credits into the sidebar and asserts a WS quota push preserves them. The
    // loader's init quota refresh answers from this same stub, and a successful
    // empty body there publishes a snapshot carrying no credits, which erases
    // the seeded value before the assertion reads it.
    globalThis.fetch = (async (url: unknown) =>
      isResponsesSend(url)
        ? new Response('{}', { status: 200 })
        : new Response('{}', {
            status: 500,
          })) as unknown as typeof globalThis.fetch
    let hooks: Hooks | undefined
    let releaseFirstEvent: (() => void) | undefined
    let quotaFrameSent: (() => void) | undefined
    const quotaFrameSentPromise = new Promise<void>((resolve) => {
      quotaFrameSent = resolve
    })

    await withFakeWebSocket(
      ({ message, authorization }) => ({
        send() {
          expect(authorization).toBe('Bearer fallback-access')
          message(
            JSON.stringify({
              type: 'codex.rate_limits',
              rate_limits: {
                primary: { used_percent: 35, window_minutes: 300 },
              },
            }),
          )
          releaseFirstEvent = () => {
            message(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_fallback_1' },
              }),
            )
          }
          quotaFrameSent?.()
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
              access: 'main-access',
              refresh: 'main-refresh',
              expires: now + 3600_000,
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
          const responsePromise = fetchOverride(
            'https://api.openai.com/v1/responses',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'session-id': 'early-fallback-quota',
              },
              body: JSON.stringify({
                model: 'gpt-5.5',
                input: [],
                stream: true,
              }),
            },
          )

          await quotaFrameSentPromise
          const sidebarWaitMs = 2000
          const sidebarDeadline = Date.now() + sidebarWaitMs
          let sidebarWriteLanded = false
          while (Date.now() < sidebarDeadline) {
            const earlySidebar = JSON.parse(
              await readFile(sidebarFile, 'utf8'),
            ) as SidebarState
            if (
              earlySidebar.fallbacks.find(
                (account) => account.id === fallback.id,
              )?.quota?.primary?.usedPercent === 35
            ) {
              sidebarWriteLanded = true
              break
            }
            await Promise.resolve()
          }
          if (!sidebarWriteLanded) {
            throw new Error(
              `early fallback WS sidebar write did not land within ${sidebarWaitMs}ms`,
            )
          }
          expect(releaseFirstEvent).toBeDefined()
          releaseFirstEvent?.()

          const response = await responsePromise
          expect(response.status).toBe(200)
          await response.body?.cancel()
          await drainSidebarWrites()

          const sidebar = JSON.parse(
            await readFile(sidebarFile, 'utf8'),
          ) as SidebarState
          expect(sidebar.activeId).toBe('fallback-1')
          expect(
            sidebar.activeRouting?.['early-fallback-quota']?.activeId,
          ).toBe('fallback-1')
          expect(
            sidebar.fallbacks.find((account) => account.id === fallback.id)
              ?.resetCredits,
          ).toBe(2)
        } finally {
          globalThis.fetch = originalFetch
          await hooks?.dispose?.()
        }
      },
    )
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
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
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

  it('reports a vault-backed 401 returned by the WebSocket branch', async () => {
    const fallback = makeSentinelAccount({
      id: 'ws-custody',
      accountId: 'acct-ws-custody',
      enabled: true,
    })
    const manifest = enrollmentManifest(fallback.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const manifestPath = join(configDir, 'handles.json')
    const vaultAccess = `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: fallback.accountId })).toString('base64url')}.signature`
    const reports: number[] = []
    let runtime: CustodyRuntime | undefined
    let hooks: Hooks | undefined
    const originalFetch = globalThis.fetch
    process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
    writeFileSync(manifestPath, JSON.stringify(manifest.value))
    chmodSync(manifestPath, 0o600)
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [fallback],
        claustrum: claustrumConfig({ mode: 'claustrum' }),
        routing: { mode: 'fallback-first' },
      }),
    )
    globalThis.fetch = (async (url: unknown) =>
      new Response('{}', {
        status: String(url).includes('wham') ? 500 : 401,
      })) as typeof globalThis.fetch
    const transport: ClaustrumCacheTransportLike = {
      async getCredential() {
        return {
          material: vaultAccess,
          recordVersion: 101,
          expiresAtMs: Date.now() + 60_000,
        }
      },
      async statusCredential() {
        return {
          ready: true,
          lastErrorCode: null,
          leaseHeld: false,
          recordVersion: 101,
        }
      },
      async reportAuthFailure(params) {
        reports.push(params.recordVersion)
      },
      close() {},
    }
    await withFakeWebSocket(
      ({ message }) => ({
        send() {
          message(
            JSON.stringify({
              type: 'error',
              status: 401,
              error: { message: 'expired' },
            }),
          )
        },
      }),
      async () => {
        try {
          hooks = await CodexAuthPlugin(createMockPluginInput(), {
            experimentalWebSockets: true,
            custody: {
              transport,
              detection: 'available',
              onRuntime: (value) => {
                runtime = value
              },
            },
          })
          const loader = hooks.auth?.loader
          if (!loader) throw new Error('expected auth loader')
          const result = await loader(
            async () => ({
              type: 'oauth' as const,
              access: 'main-access',
              refresh: 'main-refresh',
              expires: Date.now() + 3_600_000,
            }),
            {} as never,
          )
          if (!runtime) throw new Error('expected custody runtime')
          await runtime.runTick()
          expect(runtime.isEnabled()).toBe(true)
          expect(
            runtime
              .getCache()
              ?.peek(manifest.value.providers[0]!.accounts[0]!.handle),
          ).toBeDefined()
          const fetchOverride = (result as { fetch?: typeof globalThis.fetch })
            .fetch
          if (!fetchOverride) throw new Error('expected fetch override')
          const response = await fetchOverride(
            'https://api.openai.com/v1/responses',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: 'gpt-5.5',
                input: [],
                stream: true,
              }),
            },
          )
          expect(response.status).toBe(401)
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(reports).toEqual([101])
        } finally {
          await hooks?.dispose?.()
        }
      },
    )
    globalThis.fetch = originalFetch
    delete process.env.CLAUSTRUM_OPENCODE_HANDLES
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
    responsesLite = false,
    mainAccountId?: string,
  ) {
    const hooks = await CodexAuthPlugin(input, {
      experimentalWebSockets,
      responsesLite,
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
        ...(mainAccountId ? { accountId: mainAccountId } : {}),
      }),
      {
        id: 'openai',
        label: 'OpenAI',
        models: [],
      } as unknown as Parameters<NonNullable<(typeof authHook)['loader']>>[1],
    )

    const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
      | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined
    if (!fetchOverride) throw new Error('No fetch in loader result')
    return { hooks, fetchOverride }
  }

  async function runCommand(
    hooks: Hooks,
    command: string,
    args = '',
    sessionID = 'test-session',
  ) {
    const hook = hooks['command.execute.before'] as
      | ((input: {
          command: string
          arguments: string
          sessionID: string
        }) => Promise<void>)
      | undefined
    if (!hook) throw new Error('No command hook')
    try {
      await hook({ command, arguments: args, sessionID })
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

  function responsesLiteRequestInit(
    model: string,
    sessionID: string,
    options: { stream?: boolean; hostedTool?: boolean } = {},
  ): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'session-id': sessionID },
      body: JSON.stringify({
        model,
        instructions: 'Be concise',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'hi' },
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,AA==',
                detail: 'high',
              },
            ],
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: [
              {
                type: 'input_image',
                image_url: 'https://example.test/function.png',
                detail: 'low',
              },
            ],
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_2',
            output: [
              {
                type: 'input_image',
                image_url: 'https://example.test/custom.png',
                detail: 'auto',
              },
            ],
          },
        ],
        tools: [
          { type: 'function', name: 'read', parameters: {} },
          ...(options.hostedTool ? [{ type: 'web_search' }] : []),
        ],
        reasoning: { effort: 'low' },
        stream: options.stream ?? false,
      }),
    }
  }

  function seedEmptyAccountStorage() {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      }),
    )
  }

  async function captureResponsesLiteHttpRequest(
    model: string,
    responsesLite: boolean,
    sessionID: string,
    options: { hostedTool?: boolean } = {},
  ) {
    seedEmptyAccountStorage()
    const originalFetch = globalThis.fetch
    let captured: RequestInit | undefined
    let hooks: Hooks | undefined
    try {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        captured = init
        return new Response('{}', { status: 200 })
      }) as typeof globalThis.fetch
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        responsesLite,
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responsesLiteRequestInit(model, sessionID, options),
      )
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
    if (!captured) throw new Error('missing captured request')
    return captured
  }

  // Two turns in one session at different efforts; returns both wire bodies.
  async function captureEffortChange(model: string, efforts: [string, string]) {
    seedEmptyAccountStorage()
    const originalFetch = globalThis.fetch
    const sent: Array<Record<string, unknown>> = []
    let hooks: Hooks | undefined
    try {
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (
          String(url).includes('/responses') &&
          typeof init?.body === 'string'
        )
          sent.push(JSON.parse(init.body))
        return new Response('{}', { status: 200 })
      }) as typeof globalThis.fetch
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks
      for (const effort of efforts) {
        await loaded.fetchOverride('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'session-id': 'sess-effort',
          },
          body: JSON.stringify({
            model,
            instructions: 'Be concise',
            reasoning: { effort, summary: 'auto' },
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
            ],
          }),
        })
      }
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
    return sent
  }

  test('astra carries a mid-session effort change as a configuration_update', async () => {
    const sent = await captureEffortChange('gpt-6-astra', ['low', 'xhigh'])
    expect(sent).toHaveLength(2)
    // Request-level effort stays at what the session opened with, so the prefix
    // the backend caches on does not move.
    expect((sent[1]?.reasoning as Record<string, unknown>)?.effort).toBe('low')
    const input = sent[1]?.input as Array<Record<string, unknown>>
    const update = input.find((item) => item.type === 'configuration_update')
    expect(update?.reasoning).toEqual({ effort: 'xhigh' })
    // Immediately before the new user message: past the cached prefix, and two
    // updates can never land adjacent.
    expect(input[input.length - 2]?.type).toBe('configuration_update')
  })

  test('astra leaves an unchanged effort alone', async () => {
    const sent = await captureEffortChange('gpt-6-astra', ['high', 'high'])
    const input = sent[1]?.input as Array<Record<string, unknown>>
    expect((sent[1]?.reasoning as Record<string, unknown>)?.effort).toBe('high')
    expect(input.some((item) => item.type === 'configuration_update')).toBe(
      false,
    )
  })

  test('a model that rejects the item keeps the request-level effort change', async () => {
    // gpt-5.6-sol answers 400 for configuration_update, so the only correct
    // behaviour there is to let the request-level value change as before.
    const sent = await captureEffortChange('gpt-5.6-sol', ['low', 'xhigh'])
    const input = sent[1]?.input as Array<Record<string, unknown>>
    expect((sent[1]?.reasoning as Record<string, unknown>)?.effort).toBe(
      'xhigh',
    )
    expect(input.some((item) => item.type === 'configuration_update')).toBe(
      false,
    )
  })

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

  function seedAdmissionAccounts(
    ids: string[],
    mode: 'main-first' | 'fallback-first' = 'fallback-first',
    quotas: Record<string, OAuthAccount['quota']> = {},
  ) {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: ids.map((id) => ({
          id,
          type: 'oauth',
          label: id,
          enabled: true,
          access: `${id}-token`,
          refresh: `${id}-refresh`,
          expires: Date.now() + 24 * 3600_000,
          accountId: `chatgpt-${id}`,
          ...(quotas[id] ? { quota: quotas[id] } : {}),
        })),
        refresh: { refreshBeforeExpiryMinutes: 5 },
        routing: { mode },
      }),
    )
  }

  function admissionQuota(
    usedPercent: number,
    resetsAt: string,
    checkedAt: number,
  ): NonNullable<OAuthAccount['quota']> {
    return {
      primary: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt,
        checkedAt,
        windowMinutes: 10_080,
      },
    }
  }

  function writeAdmissionSidebarState(input: {
    fallbackIds: string[]
    fallbackQuotas?: Record<string, SidebarState['main']['quota'] | undefined>
    fallbackAccountIds?: Record<string, string>
    mainQuota?: SidebarState['main']['quota']
    mainAccountId?: string
    activeId?: string
    route?: 'main-first' | 'fallback-first'
  }) {
    const state: SidebarState = {
      main: { quota: input.mainQuota ?? null, killed: false },
      fallbacks: input.fallbackIds.map((id) => ({
        id,
        label: id,
        ...(input.fallbackAccountIds?.[id] !== undefined
          ? { accountId: input.fallbackAccountIds[id] }
          : {}),
        quota: input.fallbackQuotas?.[id] ?? null,
        killed: false,
        enabled: true,
      })),
      activeId: input.activeId,
      route: input.route ?? 'fallback-first',
      lastUpdated: Date.now(),
    }
    if (input.mainAccountId !== undefined) {
      state.main.mainAccountId = input.mainAccountId
    }
    writeFileSync(sidebarFile, JSON.stringify(state))
  }

  function stickyQuota(remainingPercent: number, checkedAt: number) {
    return {
      primary: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
        resetsAt: new Date(checkedAt + 7 * 24 * 3600_000).toISOString(),
        windowMinutes: 300,
      },
    }
  }

  function seedStickyBalancedAccounts() {
    const checkedAt = Date.now()
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'sticky-balanced' },
        refresh: { refreshBeforeExpiryMinutes: 5 },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            enabled: true,
            access: 'fallback-1-token',
            refresh: 'fallback-1-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-1',
          },
          {
            id: 'fallback-2',
            type: 'oauth',
            enabled: true,
            access: 'fallback-2-token',
            refresh: 'fallback-2-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-2',
          },
        ],
      }),
    )
    writeFileSync(
      sidebarFile,
      JSON.stringify({
        main: {
          quota: stickyQuota(20, checkedAt),
          mainAccountId: 'acc-main',
          killed: false,
        },
        fallbacks: [
          {
            id: 'fallback-1',
            label: 'Fallback 1',
            accountId: 'acc-fallback-1',
            quota: stickyQuota(90, checkedAt),
            killed: false,
            enabled: true,
          },
          {
            id: 'fallback-2',
            label: 'Fallback 2',
            accountId: 'acc-fallback-2',
            quota: stickyQuota(100, checkedAt),
            killed: false,
            enabled: true,
          },
        ],
        route: 'sticky-balanced',
        lastUpdated: checkedAt,
      }),
    )
  }

  it('sticky-balanced pins a session, retains it, and balances a new session by pending bytes', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks

      const first = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'sticky-session' }),
      )
      expect(first.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer fallback-2-token'])

      await drainSidebarWrites()
      const firstState = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      const firstAssignment =
        firstState.stickyAssignments?.[hashSidebarSessionId('sticky-session')]
      expect(firstAssignment?.accountId).toBe('fallback-2')
      expect(firstAssignment?.wireAccountId).toBe('acc-fallback-2')

      const changed = JSON.parse(readFileSync(sidebarFile, 'utf8'))
      changed.fallbacks[0].quota = stickyQuota(100, Date.now())
      changed.fallbacks[1].quota = stickyQuota(1, Date.now())
      writeFileSync(sidebarFile, JSON.stringify(changed))

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'sticky-session' }),
      )
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'cold-session' }),
      )
      expect(seenAuth).toEqual([
        'Bearer fallback-2-token',
        'Bearer fallback-2-token',
        'Bearer fallback-1-token',
      ])

      await drainSidebarWrites()
      const finalState = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(
        finalState.stickyAssignments?.[hashSidebarSessionId('cold-session')]
          ?.accountId,
      ).toBe('fallback-1')
      expect(
        finalState.stickyAssignments?.[hashSidebarSessionId('cold-session')]
          ?.wireAccountId,
      ).toBe('acc-fallback-1')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('logs a new sticky placement with its selection fields', async () => {
    seedStickyBalancedAccounts()
    const sessionId = 'placement-log-session'
    const request = responseRequestInit({ 'x-session-affinity': sessionId })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
    setLogLevel('debug')
    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride('https://api.openai.com/v1/responses', request)
      await flushForTest()

      const line = readFileSync(logFile, 'utf8')
        .split('\n')
        .find((entry) => entry.includes('sticky routing: placed session pin'))
      if (!line) throw new Error('missing sticky placement log')
      const payload = JSON.parse(line.slice(line.indexOf('{')))
      expect(payload).toMatchObject({
        sessionHash: hashSidebarSessionId(sessionId),
        accountId: 'fallback-2',
        source: 'weighted',
        requestBytes: Buffer.byteLength(String(request.body), 'utf8'),
        pendingBytes: 0,
      })
      expect(line).not.toContain(sessionId)
    } finally {
      globalThis.fetch = originalFetch
      setLogLevel(undefined)
      await hooks?.dispose?.()
    }
  })

  it('logs both reachable sticky migration paths with account and reason', async () => {
    const sessionId = 'pre-send-migration-session'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      return new Response('{}', {
        status: auth.includes('fallback-2') ? 401 : 200,
      })
    }) as unknown as typeof globalThis.fetch
    setLogLevel('debug')
    let hooks: Hooks | undefined
    try {
      seedStickyBalancedAccounts()
      const preSendState = JSON.parse(readFileSync(sidebarFile, 'utf8'))
      preSendState.fallbacks[1].quota = stickyQuota(0, Date.now())
      preSendState.stickyAssignments = {
        [hashSidebarSessionId(sessionId)]: {
          accountId: 'fallback-2',
          assignedAt: Date.now(),
          lastSeenAt: Date.now(),
          inputBytes: 1,
        },
      }
      writeFileSync(sidebarFile, JSON.stringify(preSendState))
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': sessionId }),
      )

      const postResponseSession = 'post-response-migration-session'
      seedStickyBalancedAccounts()
      const postResponseState = JSON.parse(readFileSync(sidebarFile, 'utf8'))
      postResponseState.stickyAssignments = {
        [hashSidebarSessionId(postResponseSession)]: {
          accountId: 'fallback-2',
          assignedAt: Date.now(),
          lastSeenAt: Date.now(),
          inputBytes: 1,
        },
      }
      writeFileSync(sidebarFile, JSON.stringify(postResponseState))
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': postResponseSession }),
      )
      await flushForTest()

      const migrations = readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((entry) =>
          entry.includes('sticky routing: migrated session pin'),
        )
        .map((entry) => JSON.parse(entry.slice(entry.indexOf('{'))))
      expect(migrations).toContainEqual(
        expect.objectContaining({
          sessionHash: hashSidebarSessionId(sessionId),
          fromAccountId: 'fallback-2',
          toAccountId: 'fallback-1',
          reason: 'exhausted',
        }),
      )
      expect(migrations).toContainEqual(
        expect.objectContaining({
          sessionHash: hashSidebarSessionId(postResponseSession),
          fromAccountId: 'fallback-2',
          toAccountId: 'fallback-1',
          reason: 'permanent',
        }),
      )
    } finally {
      globalThis.fetch = originalFetch
      setLogLevel(undefined)
      await hooks?.dispose?.()
    }
  })

  it('does not log placement or migration when retaining a healthy sticky pin', async () => {
    seedStickyBalancedAccounts()
    const sessionId = 'healthy-retained-pin'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
    setLogLevel('debug')
    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': sessionId }),
      )
      await flushForTest()
      writeFileSync(logFile, '')

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': sessionId }),
      )
      await flushForTest()

      const text = readFileSync(logFile, 'utf8')
      expect(text).not.toContain('sticky routing: placed session pin')
      expect(text).not.toContain('sticky routing: migrated session pin')
    } finally {
      globalThis.fetch = originalFetch
      setLogLevel(undefined)
      await hooks?.dispose?.()
    }
  })

  it('a degraded request roster read preserves existing fallback pins through the main-path sidebar writer', async () => {
    seedStickyBalancedAccounts()
    const retainedHash = hashSidebarSessionId('retained-after-degraded-read')
    const seeded = JSON.parse(readFileSync(sidebarFile, 'utf8'))
    seeded.stickyAssignments = {
      [retainedHash]: {
        accountId: 'fallback-1',
        assignedAt: Date.now(),
        lastSeenAt: Date.now(),
        inputBytes: 1,
      },
    }
    writeFileSync(sidebarFile, JSON.stringify(seeded))

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      renameSync(configFile, `${configFile}.unavailable`)

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'degraded-read-session' }),
      )
      expect(response.status).toBe(200)
      await drainSidebarWrites()

      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[retainedHash]?.accountId,
      ).toBe('fallback-1')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('a degraded roster read on session deletion removes only the deleted pin', async () => {
    seedStickyBalancedAccounts()
    const deletedSessionId = 'deleted-after-degraded-read'
    const retainedHash = hashSidebarSessionId('retained-after-degraded-delete')
    const seeded = JSON.parse(readFileSync(sidebarFile, 'utf8'))
    seeded.stickyAssignments = {
      [hashSidebarSessionId(deletedSessionId)]: {
        accountId: 'fallback-1',
        assignedAt: Date.now(),
        lastSeenAt: Date.now(),
        inputBytes: 1,
      },
      [retainedHash]: {
        accountId: 'fallback-2',
        assignedAt: Date.now(),
        lastSeenAt: Date.now(),
        inputBytes: 2,
      },
    }
    writeFileSync(sidebarFile, JSON.stringify(seeded))

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      renameSync(configFile, `${configFile}.unavailable`)
      const event = (
        hooks as unknown as {
          event?: (input: {
            event: {
              type: 'session.deleted'
              properties: { info: { id: string } }
            }
          }) => Promise<void>
        }
      ).event
      if (!event) throw new Error('No event hook')

      await event({
        event: {
          type: 'session.deleted',
          properties: { info: { id: deletedSessionId } },
        },
      })
      await drainSidebarWrites()

      const stickyAssignments = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      ).stickyAssignments
      expect(
        stickyAssignments?.[hashSidebarSessionId(deletedSessionId)],
      ).toBeUndefined()
      expect(stickyAssignments?.[retainedHash]?.accountId).toBe('fallback-2')
    } finally {
      await hooks?.dispose?.()
    }
  })

  it('routing reset removes a session pin without forcing a different account', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      const sessionId = 'reset-same-account-session'

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': sessionId }),
      )
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId(sessionId)]?.accountId,
      ).toBe('fallback-2')

      const beforeReset = JSON.parse(readFileSync(sidebarFile, 'utf8'))
      const selectionNow = Date.now()
      beforeReset.main.quota = stickyQuota(1, selectionNow)
      beforeReset.fallbacks[0].quota = stickyQuota(1, selectionNow)
      beforeReset.fallbacks[1].quota = stickyQuota(100, selectionNow)
      writeFileSync(sidebarFile, JSON.stringify(beforeReset))

      await runCommand(hooks, 'openai-routing', 'reset', sessionId)
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId(sessionId)],
      ).toBeUndefined()

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': sessionId }),
      )

      expect(seenAuth).toEqual([
        'Bearer fallback-2-token',
        'Bearer fallback-2-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced keeps the assignment high-water request size', async () => {
    seedStickyBalancedAccounts()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'high-water-session' }),
      )
      await drainSidebarWrites()
      const first = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      ).stickyAssignments?.[hashSidebarSessionId('high-water-session')]
      const longer = responseRequestInit({
        'x-session-affinity': 'high-water-session',
      })
      longer.body = `${longer.body}${'x'.repeat(1_024)}`
      await loaded.fetchOverride('https://api.openai.com/v1/responses', longer)
      await drainSidebarWrites()
      const second = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      ).stickyAssignments?.[hashSidebarSessionId('high-water-session')]

      expect(second?.inputBytes).toBeGreaterThan(first?.inputBytes ?? 0)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced migrates only on confirmed exhaustion or permanent auth failure', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (!String(url).includes('responses'))
        return new Response('{}', { status: 200 })
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      return new Response('{}', {
        status: auth.includes('fallback-2-token') ? 401 : 200,
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'migrate-session' }),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual([
        'Bearer fallback-2-token',
        'Bearer fallback-1-token',
      ])
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId('migrate-session')]
          ?.accountId,
      ).toBe('fallback-1')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced skips a fallback pin marked by the fallback-first path', async () => {
    seedStickyBalancedAccounts()
    const markingConfig = JSON.parse(readFileSync(configFile, 'utf8'))
    markingConfig.routing.mode = 'fallback-first'
    markingConfig.accounts[0].enabled = false
    writeFileSync(configFile, JSON.stringify(markingConfig))

    let fallbackTwoSends = 0
    let replacementSends = 0
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message, authorization }) => ({
        send() {
          if (authorization === 'Bearer fallback-2-token') {
            fallbackTwoSends += 1
            if (fallbackTwoSends === 1) {
              message(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'usage_limit_reached',
                    resets_in_seconds: 0.05,
                  },
                }),
              )
              return
            }
            message(
              JSON.stringify({
                type: 'response.completed',
                response: { id: `fallback-two-${fallbackTwoSends}` },
              }),
            )
            return
          }
          replacementSends += 1
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `replacement-${replacementSends}` },
            }),
          )
        },
      }),
      async () => {
        try {
          const loaded = await loadFetchOverride(
            createMockPluginInput(),
            Date.now() + 3600_000,
            true,
            false,
            'acc-main',
          )
          hooks = loaded.hooks
          const request = (sessionId: string) => {
            const init = responseRequestInit({ 'session-id': sessionId })
            init.body = JSON.stringify({
              model: 'gpt-5.5',
              input: [],
              stream: true,
            })
            return init
          }

          const marked = await loaded.fetchOverride(
            'https://api.openai.com/v1/responses',
            request('marked-fallback-session'),
          )
          await expect(marked.text()).rejects.toMatchObject({
            isRetryable: true,
          })
          expect(fallbackTwoSends).toBe(1)

          const stickyConfig = JSON.parse(readFileSync(configFile, 'utf8'))
          stickyConfig.routing.mode = 'sticky-balanced'
          stickyConfig.accounts[0].enabled = true
          writeFileSync(configFile, JSON.stringify(stickyConfig))
          await drainSidebarWrites()
          const stickyState = JSON.parse(readFileSync(sidebarFile, 'utf8'))
          stickyState.stickyAssignments = {
            ...(stickyState.stickyAssignments ?? {}),
            [hashSidebarSessionId('marked-fallback-session')]: {
              accountId: 'fallback-2',
              assignedAt: Date.now(),
              lastSeenAt: Date.now(),
              inputBytes: 1,
            },
          }
          writeFileSync(sidebarFile, JSON.stringify(stickyState))

          const replacement = await loaded.fetchOverride(
            'https://api.openai.com/v1/responses',
            request('marked-fallback-session'),
          )
          await replacement.text()
          expect(fallbackTwoSends).toBe(1)
          expect(replacementSends).toBe(1)

          await Bun.sleep(100)
          await drainSidebarWrites()
          const expiredState = JSON.parse(readFileSync(sidebarFile, 'utf8'))
          expiredState.stickyAssignments = {
            ...(expiredState.stickyAssignments ?? {}),
            [hashSidebarSessionId('eligible-fallback-session')]: {
              accountId: 'fallback-2',
              assignedAt: Date.now(),
              lastSeenAt: Date.now(),
              inputBytes: 1,
            },
          }
          writeFileSync(sidebarFile, JSON.stringify(expiredState))

          const afterExpiry = await loaded.fetchOverride(
            'https://api.openai.com/v1/responses',
            request('eligible-fallback-session'),
          )
          await afterExpiry.text()
          expect(fallbackTwoSends).toBe(2)
        } finally {
          await drainSidebarWrites()
          await hooks?.dispose?.()
        }
      },
    )
  })

  it('sticky-balanced skips a freshly exhausted pin before sending and excludes it from migration', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      // Fail quota requests: sticky placement weighs each account's known
      // quota, and answering the loader's startup refresh with an empty success
      // publishes an unknown reading that changes which account this test's
      // second request is placed on.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'pre-break-session' }),
      )
      await drainSidebarWrites()
      const changed = JSON.parse(readFileSync(sidebarFile, 'utf8'))
      changed.fallbacks[1].quota = stickyQuota(0, Date.now() + 1_000)
      writeFileSync(sidebarFile, JSON.stringify(changed))

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'pre-break-session' }),
      )

      expect(seenAuth).toEqual([
        'Bearer fallback-2-token',
        'Bearer fallback-1-token',
      ])
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId('pre-break-session')]
          ?.accountId,
      ).toBe('fallback-1')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced retries a 429 only after its fresh quota headers confirm exhaustion', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      // Fail quota requests rather than answering them: this test drives an
      // account to exhaustion through its own sends, and a successful empty
      // body from the loader's startup refresh publishes an unknown snapshot
      // over that state.
      if (!String(url).includes('responses'))
        return new Response('{}', { status: 500 })
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      if (auth.includes('fallback-2-token')) {
        return new Response('{}', {
          status: 429,
          headers: {
            'x-codex-primary-used-percent': '100',
            'x-codex-primary-window-minutes': '300',
            'x-codex-primary-reset-at': String(
              Math.floor((Date.now() + 3600_000) / 1000),
            ),
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
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'rate-limit-session' }),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual([
        'Bearer fallback-2-token',
        'Bearer fallback-1-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced does not replay a successful exhausted response and migrates on the next request', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (!String(url).includes('responses'))
        return new Response('{}', { status: 200 })
      const auth = headerValue(init, 'authorization')
      seenAuth.push(auth)
      if (auth.includes('fallback-2-token')) {
        return new Response('served', {
          status: 200,
          headers: {
            'x-codex-primary-used-percent': '100',
            'x-codex-primary-window-minutes': '300',
            'x-codex-primary-reset-at': String(
              Math.floor((Date.now() + 3600_000) / 1000),
            ),
          },
        })
      }
      return new Response('replacement', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      const first = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'successful-exhaustion' }),
      )

      expect(first.status).toBe(200)
      expect(await first.text()).toBe('served')
      expect(seenAuth).toEqual(['Bearer fallback-2-token'])
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(
          JSON.parse(readFileSync(sidebarFile, 'utf8')),
        ).fallbacks.find((account) => account.id === 'fallback-2')?.quota
          ?.primary?.remainingPercent,
      ).toBe(0)

      const second = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'successful-exhaustion' }),
      )
      expect(second.status).toBe(200)
      expect(await second.text()).toBe('replacement')
      expect(seenAuth).toHaveLength(2)
      expect(seenAuth[0]).toBe('Bearer fallback-2-token')
      expect(seenAuth[1]).not.toBe('Bearer fallback-2-token')
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId('successful-exhaustion')]
          ?.accountId,
      ).not.toBe('fallback-2')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced retains a pin after a transient server failure', async () => {
    seedStickyBalancedAccounts()
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
        return new Response('{}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'transient-session' }),
      )

      expect(response.status).toBe(500)
      expect(seenAuth).toEqual(['Bearer fallback-2-token'])
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId('transient-session')]
          ?.accountId,
      ).toBe('fallback-2')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced fails open in configured order when every quota is stale and logs the fallback', async () => {
    seedStickyBalancedAccounts()
    await drainSidebarWrites()
    const stale = JSON.parse(readFileSync(sidebarFile, 'utf8'))
    stale.main.quota = stickyQuota(100, 0)
    for (const fallback of stale.fallbacks) {
      fallback.quota = stickyQuota(100, 0)
    }
    writeFileSync(sidebarFile, JSON.stringify(stale))
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    const originalLevel = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'stale-session' }),
      )

      expect(seenAuth).toEqual(['Bearer main-stale-token'])
      await flushForTest()
      expect(readFileSync(logFile, 'utf8')).toContain(
        'sticky routing: no fresh weighted candidates; using configured order',
      )
    } finally {
      if (originalLevel === undefined) {
        delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
      } else {
        process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = originalLevel
      }
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced captures cachekeep only for the account that serves', async () => {
    seedStickyBalancedAccounts()
    const prompts: string[] = []
    const originalFetch = globalThis.fetch
    // Fail quota requests: the loader's startup quota refresh answers from this
    // stub too, and a successful empty body publishes an unknown snapshot that
    // disturbs the state this test establishes through its own sends.
    globalThis.fetch = (async (url: unknown) =>
      isResponsesSend(url)
        ? new Response('{}', { status: 200 })
        : new Response('{}', {
            status: 500,
          })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput({
          client: {
            auth: { set: async () => {} },
            session: {
              promptAsync: async (request: unknown) => {
                const text = (
                  request as { body?: { parts?: Array<{ text?: string }> } }
                ).body?.parts?.[0]?.text
                if (text) prompts.push(text)
              },
            },
          } as unknown as PluginInput['client'],
        }),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await runCommand(hooks, 'openai-cachekeep', 'on')
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'capture-session' }),
      )
      await runCommand(hooks, 'openai-cachekeep', 'status')

      const status = prompts.at(-1) ?? ''
      expect(status).toContain('Tracked sessions: **1**')
      expect(status).toContain('(fallback-2)')
      expect(status).not.toContain('(fallback-1)')
      expect(status).not.toContain('(main)')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced does not pin sessionless or non-replayable requests', async () => {
    seedStickyBalancedAccounts()
    const originalFetch = globalThis.fetch
    // Fail quota requests: the loader's startup quota refresh answers from this
    // stub too, and a successful empty body publishes an unknown snapshot that
    // disturbs the state this test establishes through its own sends.
    globalThis.fetch = (async (url: unknown) =>
      isResponsesSend(url)
        ? new Response('{}', { status: 200 })
        : new Response('{}', {
            status: 500,
          })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit(),
      )
      await loaded.fetchOverride(
        'https://api.openai.com/v1/models',
        responseRequestInit({ 'x-session-affinity': 'non-replayable-session' }),
      )

      await drainSidebarWrites()
      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(sidebar.stickyAssignments).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced retains its pin and wire response when no replacement exists', async () => {
    const checkedAt = Date.now()
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'sticky-balanced' },
        accounts: [],
      }),
    )
    writeFileSync(
      sidebarFile,
      JSON.stringify({
        main: {
          quota: stickyQuota(100, checkedAt),
          mainAccountId: 'acc-main',
          killed: false,
        },
        fallbacks: [],
        route: 'sticky-balanced',
        lastUpdated: checkedAt,
      }),
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) =>
      new Response('{}', {
        status: String(url).includes('responses') ? 401 : 200,
      })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'main-only-session' }),
      )

      expect(response.status).toBe(401)
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId('main-only-session')]
          ?.accountId,
      ).toBe('main')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced preserves the parent display pin instead of mirroring a child account', async () => {
    seedStickyBalancedAccounts()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'parent-session' }),
      )
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'x-session-affinity': 'child-session',
          'x-parent-session-id': 'parent-session',
        }),
      )
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(sidebar.activeRouting?.['parent-session']?.activeId).toBe(
        sidebar.stickyAssignments?.[hashSidebarSessionId('parent-session')]
          ?.accountId,
      )
      expect(sidebar.activeRouting?.['parent-session']?.activeId).not.toBe(
        sidebar.activeRouting?.['child-session']?.activeId,
      )
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced does not overwrite a parent display that has no pin', async () => {
    seedStickyBalancedAccounts()
    await drainSidebarWrites()
    const seeded = JSON.parse(readFileSync(sidebarFile, 'utf8'))
    seeded.activeRouting = {
      'parent-no-pin': {
        activeId: 'main',
        route: 'sticky-balanced',
        updatedAt: Date.now(),
      },
    }
    writeFileSync(sidebarFile, JSON.stringify(seeded))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'x-session-affinity': 'child-no-pin',
          'x-parent-session-id': 'parent-no-pin',
        }),
      )
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(sidebar.activeRouting?.['child-no-pin']?.activeId).toBe(
        'fallback-2',
      )
      expect(sidebar.activeRouting?.['parent-no-pin']).toMatchObject({
        activeId: 'main',
        route: 'sticky-balanced',
      })
      expect(
        sidebar.stickyAssignments?.[hashSidebarSessionId('parent-no-pin')],
      ).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  function mockAdmissionFetch(seenAuth: string[], status = 200) {
    return (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      return new Response('{}', { status })
    }) as unknown as typeof globalThis.fetch
  }

  test.each([
    [
      {
        'x-session-affinity': 'affinity',
        'x-opencode-session': 'opencode',
        'x-session-id': 'x-session',
        'session-id': 'session',
      },
      'affinity',
    ],
    [
      { 'x-opencode-session': 'opencode', 'x-session-id': 'x-session' },
      'opencode',
    ],
    [{ 'x-session-id': 'x-session', 'session-id': 'session' }, 'x-session'],
    [{ 'session-id': 'session' }, 'session'],
    [{}, undefined],
  ])(
    'resolves sidebar session headers by documented precedence',
    (raw, expected) => {
      expect(resolveSidebarSessionId(new Headers(raw))).toBe(expected)
    },
  )

  it('keeps different served accounts under different session keys', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-opencode-session': 'sess-fallback' }),
      )

      seedStorage({ access: 'fallback-access-token' }, { mode: 'main-first' })
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-opencode-session': 'sess-main' }),
      )
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(sidebar.activeRouting?.['sess-fallback']).toMatchObject({
        activeId: 'fallback-1',
        route: 'fallback-first',
      })
      expect(sidebar.activeRouting?.['sess-main']).toMatchObject({
        activeId: 'main',
        route: 'main-first',
      })
      expect(sidebar.activeId).toBe('main')
      expect(sidebar.route).toBe('main-first')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('records fallback-served routing on the parent session', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'x-opencode-session': 'child-session',
          'x-parent-session-id': 'parent-session',
        }),
      )
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(sidebar.activeRouting?.['child-session']).toMatchObject({
        activeId: 'fallback-1',
        route: 'fallback-first',
      })
      // A fallback (not main) served the child; the parent entry must mirror
      // that same fallback so the parent's sidebar highlights the live account.
      expect(sidebar.activeRouting?.['parent-session']).toMatchObject({
        activeId: 'fallback-1',
        route: 'fallback-first',
      })
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('uses legacy display routing when the request carries no session headers', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit(),
      )
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      // Sessionless requests write only the legacy display fields, never a
      // per-session entry.
      expect(sidebar.activeRouting).toBeUndefined()
      expect(sidebar.activeId).toBe('fallback-1')
      expect(sidebar.route).toBe('fallback-first')
      // Resolving without a session reads those legacy fields and must yield
      // defined routing rather than crash or return undefined.
      expect(resolveSessionSidebarRouting(sidebar, undefined)).toEqual({
        activeId: 'fallback-1',
        route: 'fallback-first',
      })
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('reads the sidebar session from a Request and strips it before the wire', async () => {
    seedEmptyAccountStorage()
    const originalFetch = globalThis.fetch
    let wireHeaders = new Headers()
    let wireMethod: string | undefined
    let wireBody: BodyInit | null | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      wireHeaders = new Headers(init?.headers)
      wireMethod = init?.method
      wireBody = init?.body
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks
      const requestBody = responseRequestInit()
      const request = new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opencode-session': 'request-session',
        },
        body: requestBody.body,
      })
      await loaded.fetchOverride(request)
      await drainSidebarWrites()

      const sidebar = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      )
      expect(sidebar.activeRouting?.['request-session']).toMatchObject({
        activeId: 'main',
        route: 'main-first',
      })
      expect(wireHeaders.has('x-opencode-session')).toBe(false)
      expect(wireMethod).toBe('POST')
      expect(JSON.parse(String(wireBody)).model).toBe('gpt-5.5')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('does not mutate frozen caller-owned request headers', async () => {
    seedEmptyAccountStorage()
    const callerHeaders = Object.freeze({
      authorization: 'Bearer caller-token',
      'content-type': 'application/json',
      'x-api-key': 'caller-key',
    })
    const callerInit = Object.freeze({
      method: 'POST',
      headers: callerHeaders,
      body: responseRequestInit().body,
    }) as RequestInit
    const originalFetch = globalThis.fetch
    let wireHeaders = new Headers()
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      wireHeaders = new Headers(init?.headers)
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        callerInit,
      )

      expect(callerHeaders.authorization).toBe('Bearer caller-token')
      expect(callerHeaders['x-api-key']).toBe('caller-key')
      expect(wireHeaders.get('authorization')).toBe('Bearer main-stale-token')
      expect(wireHeaders.has('x-api-key')).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('uses the active fallback token without writing it to the auth slot', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const authSetCalls: unknown[] = []
    const seen: Array<{ authorization: string; accountId: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/oauth/token')) {
        throw new Error('refresh unavailable')
      }
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seen.push({
          authorization: headerValue(init, 'authorization'),
          accountId: headerValue(init, 'ChatGPT-Account-Id') || null,
        })
      }
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seen.push(headerValue(init, 'authorization'))
      }
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
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seen.push(headerValue(init, 'authorization'))
      }
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
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seen.push(headerValue(init, 'authorization'))
      }
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

  it('sustain command flips the loader live gate and bypasses main idle pruning', async () => {
    seedEmptyAccountStorage()
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    let now = originalNow()
    let hooks: Hooks | undefined
    Date.now = () => now
    try {
      globalThis.fetch = (async () =>
        new Response('{}', {
          status: 200,
        })) as unknown as typeof globalThis.fetch
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks

      await runCommand(hooks, 'openai-cachekeep', 'on')
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'session-id': 'main-session' }),
      )

      now += 60 * 60_000 + 1
      await runCommand(hooks, 'openai-cachekeep', 'sustain on')
      const manager = (
        globalThis as typeof globalThis & {
          __openaiAuthCacheKeepManager?: {
            tick(): Promise<void>
            status(): { tracked: number; sustain: boolean }
          }
        }
      ).__openaiAuthCacheKeepManager
      if (!manager) throw new Error('missing cachekeep manager')

      await manager.tick()
      expect(manager.status()).toMatchObject({ tracked: 1, sustain: true })
    } finally {
      Date.now = originalNow
      globalThis.fetch = originalFetch
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
    globalThis.fetch = (async (url: unknown, _init?: unknown) => {
      // Fail quota requests: this test asserts which account the served quota is
      // attributed to, and the loader's startup quota refresh would answer from
      // this same stub and attribute a second reading of its own.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 500 })
      }
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
      expect(sidebar.activeRouting).toBeUndefined()
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

  it('returns a served fallback response without waiting on the lastUsed stamp', async () => {
    // The stamp runs after the provider response is in hand and records a
    // timestamp no routing, quota, or killswitch decision reads. Awaiting it puts
    // a contended store write between the provider's answer and the caller;
    // measured at seconds on a busy host. Hold the store lock so any await would
    // block for the full acquire window, then assert the response still returns
    // promptly.
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
        routing: { mode: 'fallback-first' },
      }),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    let held: { release: () => Promise<void> } | null = null
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      // Block the state-file lock the stamp needs, for longer than this test
      // could tolerate waiting.
      held = await acquireRefreshFileLock({
        name: 'save',
        ttlMs: 60_000,
        path: stateFile,
        renew: true,
      })
      expect(held).not.toBeNull()

      const startedAt = Date.now()
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      const elapsedMs = Date.now() - startedAt
      expect(response.status).toBe(200)
      await response.body?.cancel()

      // Well under the multi-second acquire window an awaited stamp would pay.
      expect(elapsedMs).toBeLessThan(2_000)
    } finally {
      await held?.release()
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota skips an exhausted first fallback from the shared sidebar state', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt', 'client-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt', 'client-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now),
          'client-alt': admissionQuota(20, reset, now),
        },
        fallbackAccountIds: {
          'work-alt': 'chatgpt-work-alt',
          'client-alt': 'chatgpt-client-alt',
        },
        activeId: 'work-alt',
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer client-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota skips a file-exhausted fallback with an empty process quota cache', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now),
        },
        fallbackAccountIds: { 'work-alt': 'chatgpt-work-alt' },
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer main-stale-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota uses fresher healthy memory instead of a stale exhausted file row', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt'], 'fallback-first', {
      'work-alt': admissionQuota(20, reset, now),
    })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now - 60_000),
        },
      })

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(seenAuth).toEqual(['Bearer work-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota uses a fresher exhausted file row instead of stale healthy memory', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt', 'client-alt'], 'fallback-first', {
      'work-alt': admissionQuota(20, reset, now - 60_000),
    })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt', 'client-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now),
          'client-alt': admissionQuota(20, reset, now),
        },
        fallbackAccountIds: {
          'work-alt': 'chatgpt-work-alt',
          'client-alt': 'chatgpt-client-alt',
        },
      })

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(seenAuth).toEqual(['Bearer client-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota skips from fresher exhausted memory instead of a stale healthy file row', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt', 'client-alt'], 'fallback-first', {
      'work-alt': admissionQuota(100, reset, now),
    })
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt', 'client-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(20, reset, now - 60_000),
          'client-alt': admissionQuota(20, reset, now),
        },
      })

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(seenAuth).toEqual(['Bearer client-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  test.each([
    ['missing quota', null],
    ['missing reset', { primary: { usedPercent: 100, remainingPercent: 0 } }],
    [
      'malformed reset',
      {
        primary: {
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: 'not-a-date',
        },
      },
    ],
    [
      'malformed usage',
      {
        primary: {
          usedPercent: '100',
          remainingPercent: 0,
          resetsAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    ],
  ])('admission quota retains a fallback with %s', async (_label, quota) => {
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': quota as SidebarState['main']['quota'],
        },
      })

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(seenAuth).toEqual(['Bearer work-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota preserves probe order when every account is exhausted', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt', 'client-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth, 429)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt', 'client-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now),
          'client-alt': admissionQuota(100, reset, now),
        },
        fallbackAccountIds: {
          'work-alt': 'chatgpt-work-alt',
          'client-alt': 'chatgpt-client-alt',
        },
        mainQuota: admissionQuota(100, reset, now),
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(429)
      expect(seenAuth).toEqual([
        'Bearer work-alt-token',
        'Bearer client-alt-token',
        'Bearer main-stale-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota reroutes a file-exhausted main without probing it', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['client-alt'], 'main-first')
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      await new Promise((resolve) => setTimeout(resolve, 2))
      const checkedAt = Date.now()
      writeAdmissionSidebarState({
        fallbackIds: ['client-alt'],
        fallbackQuotas: {
          'client-alt': admissionQuota(20, reset, checkedAt),
        },
        mainQuota: admissionQuota(100, reset, checkedAt),
        route: 'main-first',
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer client-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota ignores an exhausted main row from a different account', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['client-alt'], 'main-first')
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
        false,
        false,
        'new-account',
      )
      hooks = loaded.hooks
      await new Promise((resolve) => setTimeout(resolve, 2))
      const checkedAt = Date.now()
      writeAdmissionSidebarState({
        fallbackIds: ['client-alt'],
        fallbackQuotas: {
          'client-alt': admissionQuota(20, reset, checkedAt),
        },
        mainQuota: admissionQuota(100, reset, checkedAt),
        mainAccountId: 'old-account',
        route: 'main-first',
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer main-stale-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota ignores an exhausted fallback row stamped with a different account identity', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    // Live account identity is chatgpt-work-alt (see seedAdmissionAccounts).
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now),
        },
        // The file row belongs to a previous login of this stable id; the live
        // account is a different ChatGPT identity, so the exhausted row must be
        // treated as absent (fail-open) rather than blocking the replacement.
        fallbackAccountIds: { 'work-alt': 'chatgpt-stale' },
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer work-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota honors an exhausted fallback row matching the live account identity', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, now),
        },
        // Identity matches the live account, so the exhausted row is honored
        // and the fallback is skipped in favor of main.
        fallbackAccountIds: { 'work-alt': 'chatgpt-work-alt' },
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer main-stale-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota skips a fallback exhausted only on its secondary window', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          // No primary window; the secondary window alone is exhausted.
          'work-alt': {
            secondary: {
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: reset,
              checkedAt: now,
              windowMinutes: 10_080,
            },
          },
        },
        fallbackAccountIds: { 'work-alt': 'chatgpt-work-alt' },
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer main-stale-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota retains an exhausted-looking fallback after its reset passes', async () => {
    const now = Date.now()
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(
            100,
            new Date(now - 60_000).toISOString(),
            now,
          ),
        },
      })

      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      expect(seenAuth).toEqual(['Bearer work-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota ignores an unstamped (no accountId) exhausted fallback row against a known identity', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    // Live account identity is chatgpt-work-alt (see seedAdmissionAccounts).
    seedAdmissionAccounts(['work-alt'])
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      await new Promise((resolve) => setTimeout(resolve, 2))
      const checkedAt = Date.now()
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(100, reset, checkedAt),
        },
        // No fallbackAccountIds — the file row carries no accountId stamp.
        // The live identity is known (chatgpt-work-alt), so this exhausted
        // unstamped row must not be trusted: the fallback is still probed.
      })

      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )

      // Fallback is probed — not skipped based on an unstamped file row.
      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer work-alt-token'])
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('admission quota probes main for a non-replayable request even when the file says exhausted and a fallback is retained', async () => {
    const now = Date.now()
    const reset = new Date(now + 7 * 24 * 3600_000).toISOString()
    seedAdmissionAccounts(['work-alt'], 'main-first')
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockAdmissionFetch(seenAuth)

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        now + 3600_000,
      )
      hooks = loaded.hooks
      await new Promise((resolve) => setTimeout(resolve, 2))
      const checkedAt = Date.now()
      writeAdmissionSidebarState({
        fallbackIds: ['work-alt'],
        fallbackQuotas: {
          'work-alt': admissionQuota(20, reset, checkedAt),
        },
        mainQuota: admissionQuota(100, reset, checkedAt),
        route: 'main-first',
      })

      // A non-replayable GET request: main is file-exhausted and a healthy
      // fallback is retained, but without the replayability guard the
      // quotaBlocksMain check would produce a synthetic 429 without ever
      // probing main. With the fix, main IS probed.
      const response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      )

      // Main was probed — not skipped by a synthetic 429.
      expect(response.status).toBe(200)
      expect(seenAuth).toEqual(['Bearer main-stale-token'])
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
      }
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
      }
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(auth)
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
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(auth)
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
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      // Record the turn's own send only. Configuring a fallback starts the
      // loader's background quota refresh, whose wham/usage call is authorized
      // and unawaited, so recording every authorized fetch makes this assertion
      // a race: the quota call lands before it on an idle machine and after it
      // under suite load.
      if (isResponsesSend(url)) {
        seen.push({
          authorization: headerValue(init, 'authorization'),
          accountId: headerValue(init, 'ChatGPT-Account-Id') || null,
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
      }
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
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(auth)
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
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(auth)
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

  it('a later single-primary snapshot fully replaces an earlier two-window snapshot, not merges with it', async () => {
    // Header/WS pushes are always complete snapshots of every live window
    // (never a partial subset), so a later push that omits a window means
    // the wire genuinely dropped it — the cached value must not survive.
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
            ?.usedPercent === 20,
      )
      const quota = sidebar.fallbacks.find((a) => a.id === 'fallback-1')?.quota
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
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
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
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const auth = headerValue(init, 'authorization')
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) seenAuth.push(auth)
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
        reasoning: { effort: 'max', summary: 'auto' },
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

    const parsedHttpBody = JSON.parse(httpBody)
    const parsedWsBody = JSON.parse(wsBody)
    expect(Object.keys(parsedHttpBody)).toEqual(expectedKeys)
    expect(Object.keys(parsedWsBody)).toEqual(expectedKeys)
    expect(parsedHttpBody.reasoning).toEqual({ effort: 'max', summary: 'auto' })
    expect(parsedWsBody.reasoning).toEqual({ effort: 'max', summary: 'auto' })
  })

  it('gates Responses Lite by setting and exact HTTP model', async () => {
    const cases = [
      { name: 'sol', model: 'gpt-5.6-sol', enabled: true, marked: true },
      {
        name: 'legacy-pro',
        model: 'gpt-5.6-sol-pro',
        enabled: true,
        marked: false,
      },
      { name: 'disabled', model: 'gpt-5.6-sol', enabled: false, marked: false },
    ]
    for (const testCase of cases) {
      const captured = await captureResponsesLiteHttpRequest(
        testCase.model,
        testCase.enabled,
        `responses-lite-${testCase.name}`,
      )
      expect(
        new Headers(captured.headers).get(
          'x-openai-internal-codex-responses-lite',
        ),
      ).toBe(testCase.marked ? 'true' : null)
    }
  })

  it('rewrites an eligible HTTP body for Responses Lite', async () => {
    const captured = await captureResponsesLiteHttpRequest(
      'gpt-5.6-sol',
      true,
      'responses-lite-body',
      { hostedTool: true },
    )
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>
    expect(body.reasoning).toEqual({ effort: 'low', context: 'all_turns' })
    expect(body.parallel_tool_calls).toBe(false)
    expect('instructions' in body).toBe(false)
    expect('tools' in body).toBe(false)

    const input = body.input as Array<Record<string, unknown>>
    expect(input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
    })
    expect(input[0]?.tools).toContainEqual({
      type: 'function',
      name: 'read',
      strict: false,
      parameters: {},
    })
    expect(
      (input[0]?.tools as Array<Record<string, unknown>> | undefined)?.some(
        (tool) => tool.type === 'web_search',
      ) ?? false,
    ).toBe(false)
    expect(input[1]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Be concise' }],
    })
    const sourceInput = input.slice(2)
    expect([
      (
        sourceInput[0]?.content as Array<Record<string, unknown>> | undefined
      )?.[1]?.detail,
      (
        sourceInput[1]?.output as Array<Record<string, unknown>> | undefined
      )?.[0]?.detail,
      (
        sourceInput[2]?.output as Array<Record<string, unknown>> | undefined
      )?.[0]?.detail,
    ]).toEqual([undefined, undefined, undefined])
  })

  it('preserves the standard body when Responses Lite is disabled', async () => {
    const captured = await captureResponsesLiteHttpRequest(
      'gpt-5.6-sol',
      false,
      'responses-lite-disabled',
    )
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>
    const input = body.input as Array<Record<string, unknown>>
    expect([
      (input[0]?.content as Array<Record<string, unknown>> | undefined)?.[1]
        ?.detail,
      (input[1]?.output as Array<Record<string, unknown>> | undefined)?.[0]
        ?.detail,
      (input[2]?.output as Array<Record<string, unknown>> | undefined)?.[0]
        ?.detail,
    ]).toEqual(['high', 'low', 'auto'])
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.instructions).toBe('Be concise')
    expect(body.tools).toBeDefined()
  })

  it('marks Responses Lite in WS metadata and still prewarms', async () => {
    seedEmptyAccountStorage()
    const sent: Array<Record<string, unknown>> = []
    let seenUpgradeHeaders: Record<string, string> = {}
    let hooks: Hooks | undefined
    await withFakeWebSocket(
      ({ message, upgradeHeaders }) => ({
        send(data) {
          seenUpgradeHeaders = upgradeHeaders
          const body = JSON.parse(data) as Record<string, unknown>
          sent.push(body)
          message(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: body.generate === false ? 'resp_prewarm' : 'resp_main',
              },
            }),
          )
        },
      }),
      async () => {
        try {
          const loaded = await loadFetchOverride(
            createMockPluginInput(),
            Date.now() + 3600_000,
            true,
            true,
          )
          hooks = loaded.hooks
          const response = await loaded.fetchOverride(
            'https://api.openai.com/v1/responses',
            responsesLiteRequestInit('gpt-5.6-sol', 'responses-lite-ws', {
              stream: true,
            }),
          )
          await response.text()
        } finally {
          await hooks?.dispose?.()
        }
      },
    )

    expect(sent).toHaveLength(2)
    expect(sent[0]?.generate).toBe(false)
    const main = sent[1]!
    expect(
      (main.client_metadata as Record<string, unknown>)
        .ws_request_header_x_openai_internal_codex_responses_lite,
    ).toBe('true')
    expect(
      seenUpgradeHeaders['x-openai-internal-codex-responses-lite'],
    ).toBeUndefined()
  })

  it('converts a WS Responses Lite capture into a sanitized HTTP cachekeep request', async () => {
    seedEmptyAccountStorage()
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    let now = originalNow()
    const warmRequests: RequestInit[] = []
    let hooks: Hooks | undefined
    Date.now = () => now
    try {
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        // Record only the keep-warm request this test is about — the replay the
        // plugin sends to keep a prompt cache alive. The loader's startup quota
        // refresh also passes through this stub, and capturing that would make
        // the assertion below race it.
        if (init && isResponsesSend(url)) warmRequests.push(init)
        return new Response('{}', { status: 200 })
      }) as typeof globalThis.fetch
      await withFakeWebSocket(
        ({ message }) => ({
          send(data) {
            const body = JSON.parse(data) as Record<string, unknown>
            message(
              JSON.stringify({
                type: 'response.completed',
                response: {
                  id: body.generate === false ? 'resp_prewarm' : 'resp_main',
                },
              }),
            )
          },
        }),
        async () => {
          const loaded = await loadFetchOverride(
            createMockPluginInput(),
            now + 3600_000,
            true,
            true,
          )
          hooks = loaded.hooks
          await runCommand(hooks, 'openai-cachekeep', 'on')
          const request = responsesLiteRequestInit(
            'gpt-5.6-sol',
            'responses-lite-keepwarm',
            { stream: true },
          )
          const headers = new Headers(request.headers)
          headers.set('x-opencode-session', 'internal-session')
          request.headers = headers
          const response = await loaded.fetchOverride(
            'https://api.openai.com/v1/responses',
            request,
          )
          await response.text()
          now += 30 * 60_000
          const manager = (
            globalThis as typeof globalThis & {
              __openaiAuthCacheKeepManager?: { tick(): Promise<void> }
            }
          ).__openaiAuthCacheKeepManager
          if (!manager) throw new Error('missing cachekeep manager')
          await manager.tick()
        },
      )
    } finally {
      Date.now = originalNow
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }

    expect(warmRequests).toHaveLength(1)
    const warm = warmRequests[0]!
    const warmHeaders = new Headers(warm.headers)
    expect(warmHeaders.get('x-openai-internal-codex-responses-lite')).toBe(
      'true',
    )
    expect(warmHeaders.has('x-opencode-session')).toBe(false)
    const body = JSON.parse(String(warm.body)) as Record<string, unknown>
    const metadata = body.client_metadata as Record<string, unknown>
    expect('x-codex-turn-metadata' in metadata).toBe(false)
    expect('x-codex-ws-stream-request-start-ms' in metadata).toBe(false)
    expect(
      'ws_request_header_x_openai_internal_codex_responses_lite' in metadata,
    ).toBe(false)
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
      }
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
      // Record the turn's own send only: the loader also issues an authorized,
      // unawaited quota refresh at init, so recording every authorized fetch
      // makes this assertion race it.
      if (isResponsesSend(url)) {
        seenAuth.push(headerValue(init, 'authorization'))
      }
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

  it('a fallback that stops sending a secondary window does not keep resurrecting it from cache', async () => {
    seedStorage({ access: 'fallback-access-token' })
    const originalFetch = globalThis.fetch
    const farFuture = Math.floor((Date.now() + 7 * 24 * 3600_000) / 1000)
    let responseHeaders: Record<string, string> = {
      'x-codex-primary-used-percent': '10',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(farFuture),
      'x-codex-secondary-used-percent': '20',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': String(farFuture),
    }
    globalThis.fetch = (async (url: unknown) => {
      // Fail quota requests: this test asserts a window disappears from cache
      // once the account stops sending it, and the loader's startup quota
      // refresh would answer from this stub and republish the window.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 500 })
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', ...responseHeaders },
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
      )
      hooks = loaded.hooks

      // First push: real two-window frame — cache now holds both windows.
      let response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(response.status).toBe(200)
      await response.body?.cancel()

      await waitForSidebarState(
        sidebarFile,
        (s) =>
          s.fallbacks.find((a) => a.id === 'fallback-1')?.quota?.secondary
            ?.usedPercent === 20,
      )

      // The backend stops sending a secondary window entirely (the current
      // live wire shape) — every subsequent push is single-primary.
      responseHeaders = {
        'x-codex-primary-used-percent': '15',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(farFuture),
      }
      response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(response.status).toBe(200)
      await response.body?.cancel()

      response = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        requestInit(),
      )
      expect(response.status).toBe(200)
      await response.body?.cancel()

      const sidebar = await waitForSidebarState(
        sidebarFile,
        (s) =>
          s.fallbacks.find((a) => a.id === 'fallback-1')?.quota?.primary
            ?.usedPercent === 15,
      )
      // The removed secondary must not be perpetuated from the stale cache.
      expect(
        sidebar.fallbacks.find((a) => a.id === 'fallback-1')?.quota?.secondary,
      ).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  // ---------------------------------------------------------------------------
  // Sticky-balanced + killswitch (the maintainer's blocker)
  // ---------------------------------------------------------------------------

  // Seeds a sticky-balanced config with killswitch enabled. Every account's
  // quota is parked near the floor so the killswitch rejects them.
  function seedStickyBalancedKillswitchAllBelowFloor() {
    const checkedAt = Date.now()
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'sticky-balanced' },
        refresh: { refreshBeforeExpiryMinutes: 5 },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            enabled: true,
            access: 'fallback-1-token',
            refresh: 'fallback-1-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-1',
          },
          {
            id: 'fallback-2',
            type: 'oauth',
            enabled: true,
            access: 'fallback-2-token',
            refresh: 'fallback-2-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-2',
          },
        ],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )
    // All accounts sit between 0% and the 50% floor — the band the killswitch
    // exists to protect. They are NOT exhausted (remainingPercent > 0), so
    // today's break decision would retain them.
    const belowFloor = (window: 'primary' | 'secondary', base: number) => ({
      usedPercent: 100 - base,
      remainingPercent: base,
      checkedAt,
      resetsAt: new Date(checkedAt + 7 * 24 * 3600_000).toISOString(),
      windowMinutes: window === 'primary' ? 300 : 10_080,
    })
    writeFileSync(
      sidebarFile,
      JSON.stringify({
        main: {
          quota: {
            primary: belowFloor('primary', 40),
            secondary: belowFloor('secondary', 40),
          },
          mainAccountId: 'acc-main',
          killed: false,
        },
        fallbacks: [
          {
            id: 'fallback-1',
            label: 'Fallback 1',
            accountId: 'acc-fallback-1',
            quota: {
              primary: belowFloor('primary', 30),
              secondary: belowFloor('secondary', 30),
            },
            killed: false,
            enabled: true,
          },
          {
            id: 'fallback-2',
            label: 'Fallback 2',
            accountId: 'acc-fallback-2',
            quota: {
              primary: belowFloor('primary', 35),
              secondary: belowFloor('secondary', 35),
            },
            killed: false,
            enabled: true,
          },
        ],
        route: 'sticky-balanced',
        lastUpdated: checkedAt,
      }),
    )
  }

  it('sticky-balanced + killswitch: every account below the floor returns the shared 429 and never reaches the wire', async () => {
    seedStickyBalancedKillswitchAllBelowFloor()
    // The kill check is peek-based (memory only). The response headers push
    // below-floor quota for the account that served, so each request can only
    // populate ONE account's memory. To verify the 429 on the test request
    // we walk every account once, then send the test request — its roster
    // is empty (all-killed) and the main path's killswitch block fires.
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      // Count and answer only the sends this test makes. The loader starts its
      // own quota refresh during initialization, unawaited, so counting it makes
      // the call-count assertions below race it. Answering it with the
      // below-floor headers would be worse: this test establishes quota for one
      // account at a time by sending to each in turn, and that refresh would
      // establish it for an account out of sequence.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 500 })
      }
      fetchCalls++
      return new Response('{}', {
        status: 200,
        headers: {
          'x-codex-primary-used-percent': '95',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(
            Math.floor((Date.now() + 5 * 3600_000) / 1000),
          ),
          'x-codex-secondary-used-percent': '95',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': String(
            Math.floor((Date.now() + 7 * 24 * 3600_000) / 1000),
          ),
        },
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      // Setup: each request cycles through the remaining accounts (the
      // killswitch filter excludes the most-recently-killed one). After all
      // three, every account has below-floor quota in memory.
      for (let i = 0; i < 3; i++) {
        const response = await loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          responseRequestInit({
            'x-session-affinity': `all-killed-spend-${i}`,
          }),
        )
        expect(response.status).toBe(200)
      }
      const setupCalls = fetchCalls
      expect(setupCalls).toBe(3)

      // Test request: the roster is empty (all-killed), the sticky path
      // returns undefined, and the main path returns the shared 429.
      const test = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'all-killed-block' }),
      )
      expect(test.status).toBe(429)
      expect(test.headers.get('retry-after')).toBeTruthy()
      const body = (await test.json()) as {
        error?: { type?: string; message?: string }
      }
      expect(body.error?.type).toBe('rate_limit_exceeded')
      expect(body.error?.message).toContain('Killswitch')

      // The blocked request did NOT reach upstream.
      expect(fetchCalls).toBe(setupCalls)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced + killswitch: a retained pin migrates off an account that drops below the floor', async () => {
    // Healthy at pin time, then drops below the floor — the band the killswitch
    // exists to protect. The break decision must migrate the pin.
    seedStickyBalancedAccounts()
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'sticky-balanced' },
        refresh: { refreshBeforeExpiryMinutes: 5 },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            enabled: true,
            access: 'fallback-1-token',
            refresh: 'fallback-1-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-1',
          },
          {
            id: 'fallback-2',
            type: 'oauth',
            enabled: true,
            access: 'fallback-2-token',
            refresh: 'fallback-2-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-2',
          },
        ],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
        const auth = headerValue(init, 'authorization')
        // Push below-floor quota ONLY for the pinned account (fallback-2) so
        // the peek-based kill check trips on the next request.
        if (auth.includes('fallback-2-token')) {
          return new Response('{}', {
            status: 200,
            headers: {
              'x-codex-primary-used-percent': '95',
              'x-codex-primary-window-minutes': '300',
              'x-codex-primary-reset-at': String(
                Math.floor((Date.now() + 5 * 3600_000) / 1000),
              ),
              'x-codex-secondary-used-percent': '95',
              'x-codex-secondary-window-minutes': '10080',
              'x-codex-secondary-reset-at': String(
                Math.floor((Date.now() + 7 * 24 * 3600_000) / 1000),
              ),
            },
          })
        }
      }
      // Fail quota requests: this test decides which account to stop using from
      // the quota headers on individual sends, and a successful empty body from
      // the loader's startup refresh would overwrite that with an "unknown"
      // reading. Sends still get a 200, because this branch also serves the
      // accounts the test intends to leave healthy.
      if (!isResponsesSend(url)) {
        return new Response('{}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      // First request: sticky places the session on fallback-2 (roomiest
      // account). The response headers push below-floor quota for fallback-2.
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'pin-migrate-session' }),
      )
      await drainSidebarWrites()
      const initialPin = normalizeSidebarState(
        JSON.parse(readFileSync(sidebarFile, 'utf8')),
      ).stickyAssignments?.[hashSidebarSessionId('pin-migrate-session')]
        ?.accountId
      expect(initialPin).toBe('fallback-2')

      // Second request: kill filter excludes fallback-2 (memory has below-floor
      // quota). The pin migrates to fallback-1.
      const next = await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'pin-migrate-session' }),
      )
      expect(next.status).toBe(200)
      expect(seenAuth).toEqual([
        'Bearer fallback-2-token',
        'Bearer fallback-1-token',
      ])
      await drainSidebarWrites()
      expect(
        normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
          .stickyAssignments?.[hashSidebarSessionId('pin-migrate-session')]
          ?.accountId,
      ).toBe('fallback-1')
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced + killswitch: a killed account is never picked by the mode-fallback fail-open branch', async () => {
    // The "subtle half" from the brief: with every quota stale the mode-fallback
    // branch is the only branch that runs. It must never spend on a killed
    // account. Pin to the killed account first (so its memory has below-floor
    // quota), then verify the next request does NOT pick it (the kill filter
    // excludes it from the mode-fallback fail-open).
    seedStickyBalancedAccounts()
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'sticky-balanced' },
        refresh: { refreshBeforeExpiryMinutes: 5 },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            enabled: true,
            access: 'fallback-1-token',
            refresh: 'fallback-1-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-1',
          },
          {
            id: 'fallback-2',
            type: 'oauth',
            enabled: true,
            access: 'fallback-2-token',
            refresh: 'fallback-2-refresh',
            expires: Date.now() + 24 * 3600_000,
            accountId: 'acc-fallback-2',
          },
        ],
        killswitch: { enabled: true, main: { primary: 50, secondary: 50 } },
      }),
    )
    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      // First request: get below-floor quota into memory for the chosen
      // account. Subsequent requests: return whatever quota the caller pushes.
      return new Response('{}', {
        status: 200,
        headers: {
          'x-codex-primary-used-percent': '95',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(
            Math.floor((Date.now() + 5 * 3600_000) / 1000),
          ),
          'x-codex-secondary-used-percent': '95',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': String(
            Math.floor((Date.now() + 7 * 24 * 3600_000) / 1000),
          ),
        },
      })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      // Setup: pin a session to whichever account the sticky path picks.
      // The response headers push below-floor quota into memory for that
      // account.
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({ 'x-session-affinity': 'killswitch-pin-setup' }),
      )
      const pinnedId = (seenAuth[0] ?? '')
        .replace('Bearer ', '')
        .replace('-token', '')
      await drainSidebarWrites()
      // Now make all quotas stale so the mode-fallback is the only branch.
      const stale = JSON.parse(readFileSync(sidebarFile, 'utf8'))
      stale.main.quota = stickyQuota(100, Date.now() - QUOTA_STALENESS_MS - 1)
      stale.fallbacks[0].quota = stickyQuota(
        100,
        Date.now() - QUOTA_STALENESS_MS - 1,
      )
      stale.fallbacks[1].quota = stickyQuota(
        100,
        Date.now() - QUOTA_STALENESS_MS - 1,
      )
      writeFileSync(sidebarFile, JSON.stringify(stale))

      // Test: the pinned account's memory has below-floor quota. The kill
      // filter MUST exclude it. Without the filter, mode-fallback would pick
      // the same account (the pin is honored when the account is still in
      // the candidates list).
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'x-session-affinity': 'killswitch-mode-fallback',
        }),
      )

      // Either the pin migrates (kill filter excludes the pinned account) OR
      // the mode-fallback picks a different account. The key assertion is
      // that the killed account is NOT picked.
      expect(seenAuth[1]).not.toBe(`Bearer ${pinnedId}-token`)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  it('sticky-balanced + killswitch DISABLED: placement and retention are byte-identical (no-op)', async () => {
    // Load-bearing negative case: the dominant path with killswitch off must
    // be unchanged. Even with one account near zero, the request goes through.
    seedStickyBalancedAccounts()
    await drainSidebarWrites()
    const state = JSON.parse(readFileSync(sidebarFile, 'utf8'))
    // fallback-1 below the floor; killswitch is OFF so it must still be served.
    state.fallbacks[0].quota = stickyQuota(20, Date.now())
    writeFileSync(sidebarFile, JSON.stringify(state))

    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'x-session-affinity': 'killswitch-disabled-session',
        }),
      )

      // Killswitch disabled — the dominant path. Weighted placement behaves
      // identically to the pre-killswitch implementation. The selection picks
      // the roomiest account; this is the load-bearing negative case.
      expect(seenAuth).toHaveLength(1)
      expect(seenAuth[0]).toMatch(/Bearer fallback-[12]-token/)
    } finally {
      globalThis.fetch = originalFetch
      await hooks?.dispose?.()
    }
  })

  // ---------------------------------------------------------------------------
  // resetCreditsAvailable → resetCreditsApplicable wiring (the real path)
  // ---------------------------------------------------------------------------
  // The shotgun unit test (`prefers a positive optional reset-credit count in
  // empty-set fallback` in sticky-routing.test.ts) bypasses the extractor at
  // index.ts:1962 by setting `resetCreditsApplicable` directly on the candidate.
  // The extractor was reading the WRONG key — `.resetCreditsApplicable` instead
  // of the real field `.resetCreditsAvailable` — so the wiring was dead in
  // production. This test goes through the sidebar file → roster builder → sort
  // pipeline and would fail until the extractor reads the right key.

  it('sticky-balanced: mode-fallback prefers the credit-bearing account via the REAL wiring (resetCreditsAvailable)', async () => {
    seedStickyBalancedAccounts()
    await drainSidebarWrites()
    const state = JSON.parse(readFileSync(sidebarFile, 'utf8'))
    // All credentials stale → mode-fallback is the only branch that runs.
    // configuredOrder says fallback-1 wins (added first → configuredOrder 1).
    // resetCreditsAvailable says fallback-2 wins (higher credit priority).
    // The fix that makes this test green is the extractor reading
    // `resetCreditsAvailable` from the quota — the sort then picks fallback-2.
    state.main.quota = stickyQuota(100, Date.now() - QUOTA_STALENESS_MS - 1)
    state.fallbacks[0].quota = {
      primary: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: Date.now() - QUOTA_STALENESS_MS - 1,
        windowMinutes: 300,
      },
      resetCreditsAvailable: 0,
    }
    state.fallbacks[1].quota = {
      primary: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: Date.now() - QUOTA_STALENESS_MS - 1,
        windowMinutes: 300,
      },
      resetCreditsAvailable: 1,
    }
    writeFileSync(sidebarFile, JSON.stringify(state))

    const seenAuth: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('responses')) {
        // Record the turn's own send only: the loader also issues an authorized,
        // unawaited quota refresh at init, so recording every authorized fetch
        // makes this assertion race it.
        if (isResponsesSend(url)) {
          seenAuth.push(headerValue(init, 'authorization'))
        }
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    let hooks: Hooks | undefined
    try {
      const loaded = await loadFetchOverride(
        createMockPluginInput(),
        Date.now() + 3600_000,
        false,
        false,
        'acc-main',
      )
      hooks = loaded.hooks
      await loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit({
          'x-session-affinity': 'credit-priority-session',
        }),
      )

      // The mode-fallback sort is
      //   resetCreditsApplicable DESC → configuredOrder ASC → id ASC.
      // Without the fix: the extractor returns undefined for both accounts
      //   (it reads the wrong key). The sort falls through to configuredOrder,
      //   and fallback-1 wins by its lower configuredOrder.
      // With the fix: the extractor reads `resetCreditsAvailable=1` from
      //   fallback-2's quota and sets `resetCreditsApplicable=1` on its
      //   candidate. fallback-1 has `resetCreditsAvailable=0`. The sort picks
      //   fallback-2.
      expect(seenAuth[0]).toBe('Bearer fallback-2-token')
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
  let modelsCacheFile: string
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
    modelsCacheFile = join(configDir, 'models.json')
    stateFile = join(configDir, 'openai-auth-state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = modelsCacheFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
    process.env.NODE_ENV = 'test'
    process.env.OPENCODE_CONFIG_DIR = configDir
    resetModelCostsForTest()
  })

  afterEach(() => {
    // Restore path envs to floor (not delete) — keeps in-flight writes away from live defaults.
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = FLOOR_MODELS_CACHE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.NODE_ENV
    resetModelCostsForTest()
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

  it('OAuth + costZeroing.enabled === false → catalog cost RESTORED', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        accounts: [],
        costZeroing: { enabled: false },
      }),
    )
    writeFileSync(
      modelsCacheFile,
      JSON.stringify({
        openai: {
          models: {
            'gpt-5.5': {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
                cache_write: 6.25,
                tiers: [
                  {
                    input: 10,
                    output: 45,
                    cache_read: 1,
                    cache_write: 12.5,
                    tier: { type: 'context', size: 272_000 },
                  },
                ],
                context_over_200k: {
                  input: 10,
                  output: 45,
                  cache_read: 1,
                  cache_write: 12.5,
                },
              },
            },
          },
        },
      }),
    )
    const input = createMockPluginInput()
    const hooks = await CodexAuthPlugin(input)
    const modelsFn = hooks.provider?.models
    if (!modelsFn) throw new Error('No models hook')
    const result = await modelsFn(mockProvider(), oauthCtx())
    const model = result['gpt-5.5']!
    expect(model.cost).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0.5, write: 6.25 },
      tiers: [
        {
          input: 10,
          output: 45,
          cache: { read: 1, write: 12.5 },
          tier: { type: 'context', size: 272_000 },
        },
      ],
      experimentalOver200K: {
        input: 10,
        output: 45,
        cache: { read: 1, write: 12.5 },
      },
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
