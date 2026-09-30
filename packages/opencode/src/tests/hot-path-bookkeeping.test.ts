/**
 * The request path must never wait on, or fail because of, bookkeeping.
 *
 * The sidebar file (display state plus the cross-process pin ledger) and the
 * account store's save locks are bookkeeping. A request is sent from in-memory
 * state and returns as soon as the provider answers; the routing display,
 * pushed quota and sticky pin are written in the background and land once the
 * file can be written again, without another request having to come along.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index.ts'
import { flushForTest } from '../logger.ts'
import {
  drainSidebarWrites,
  hashSidebarSessionId,
  normalizeSidebarState,
  type SidebarState,
} from '../sidebar-state.ts'
import { restoreEnv } from './setup-env'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

// Far below the sidebar lock's 15 s acquisition timeout, and loose enough to
// hold on a loaded machine: a request that waits on the lock at all overruns
// it by an order of magnitude.
const HOT_PATH_BOUND_MS = 1_000

type FetchOverride = (
  url: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function createMockPluginInput(): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

async function loadFetchOverride(experimentalWebSockets = false) {
  const hooks = await CodexAuthPlugin(createMockPluginInput(), {
    experimentalWebSockets,
  })
  const authHook = hooks.auth
  if (!authHook?.loader) throw new Error('No auth loader')
  const loaderResult = await authHook.loader(
    async () => ({
      type: 'oauth' as const,
      provider: 'openai',
      access: 'main-access-token',
      refresh: 'main-refresh-token',
      expires: Date.now() + 3600_000,
      accountId: 'acc-main',
    }),
    { id: 'openai', label: 'OpenAI', models: [] } as unknown as Parameters<
      NonNullable<(typeof authHook)['loader']>
    >[1],
  )
  const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
    | FetchOverride
    | undefined
  if (!fetchOverride) throw new Error('No fetch in loader result')
  return { hooks, fetchOverride }
}

function responseRequestInit(sessionId: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'session-id': sessionId },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  }
}

function isResponsesSend(url: unknown) {
  return String(url).includes('/responses')
}

function quotaWindow(remainingPercent: number, checkedAt: number) {
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

function fallbackAccount(id: string) {
  return {
    id,
    type: 'oauth',
    enabled: true,
    access: `${id}-token`,
    refresh: `${id}-refresh`,
    expires: Date.now() + 24 * 3600_000,
    accountId: `acc-${id}`,
  }
}

// Settles with the request's outcome, or with 'timed-out' once the bound
// passes. The request itself is left running so a failing run does not have
// to wait out the lock timeout before the test reports.
async function withinBound(
  request: Promise<Response>,
  boundMs: number,
): Promise<Response | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), boundMs)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForFile<T>(
  read: () => T | undefined,
  timeoutMs: number,
  describeLast: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms; last=${describeLast()}`)
}

function readSidebar(file: string): SidebarState | undefined {
  try {
    return normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

describe('request path never waits on bookkeeping', () => {
  let configDir: string
  let configFile: string
  let stateFile: string
  let sidebarFile: string
  let logFile: string
  let originalFetch: typeof globalThis.fetch
  let hooks: Hooks | undefined
  const heldLocks: Array<{ release(): Promise<void> }> = []

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'oai-hot-path-'))
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
    originalFetch = globalThis.fetch
    hooks = undefined
  })

  afterEach(async () => {
    for (const lock of heldLocks.splice(0)) await lock.release()
    globalThis.fetch = originalFetch
    await hooks?.dispose?.()
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    restoreEnv('OPENCODE_CONFIG_DIR')
    delete process.env.NODE_ENV
    rmSync(configDir, { recursive: true, force: true })
  })

  // Every provider call answers 200 with a quota header, so the served
  // account's quota has something to publish.
  function installWire(seen: string[]) {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (isResponsesSend(url)) {
        seen.push(new Headers(init?.headers).get('authorization') ?? '')
      }
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-codex-primary-used-percent': '42',
          'x-codex-primary-window-minutes': '300',
        },
      })
    }) as unknown as typeof globalThis.fetch
  }

  function seedStore(mode: string, fallbackIds: string[]) {
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode },
        refresh: { refreshBeforeExpiryMinutes: 5 },
        accounts: fallbackIds.map(fallbackAccount),
      }),
    )
  }

  function seedSidebar(file: string, route: string, fallbackIds: string[]) {
    const checkedAt = Date.now()
    writeFileSync(
      file,
      JSON.stringify({
        main: {
          quota: quotaWindow(20, checkedAt),
          mainAccountId: 'acc-main',
          killed: false,
        },
        fallbacks: fallbackIds.map((id, index) => ({
          id,
          label: id,
          accountId: `acc-${id}`,
          quota: quotaWindow(90 + index * 5, checkedAt),
          killed: false,
          enabled: true,
        })),
        route,
        lastUpdated: checkedAt,
      }),
    )
  }

  async function holdLock(path: string, name: string) {
    const lock = await acquireRefreshFileLock({
      path,
      name,
      ttlMs: 60_000,
      renew: true,
    })
    if (!lock) throw new Error(`could not take the ${name} lock on ${path}`)
    heldLocks.push(lock)
  }

  async function releaseLocks() {
    for (const lock of heldLocks.splice(0)) await lock.release()
  }

  it('a sticky-balanced request reaches the wire when the sidebar write fails, and its pin lands once writes work again', async () => {
    // The sidebar path sits under a regular file, so every write fails at
    // once (the directory cannot be created) and every read sees no file.
    const blocker = join(configDir, 'sidebar-blocked')
    const blockedSidebarFile = join(blocker, 'sidebar-state.json')
    writeFileSync(blocker, 'not a directory')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = blockedSidebarFile
    seedStore('sticky-balanced', ['fallback-1', 'fallback-2'])
    const seen: string[] = []
    installWire(seen)

    const loaded = await loadFetchOverride()
    hooks = loaded.hooks
    const sessionId = 'sticky-write-fails'
    const outcome = await withinBound(
      loaded.fetchOverride(
        'https://api.openai.com/v1/responses',
        responseRequestInit(sessionId),
      ),
      HOT_PATH_BOUND_MS,
    )
    if (outcome === 'timed-out') {
      throw new Error('sticky request did not return within the bound')
    }
    expect(outcome.status).toBe(200)
    expect(seen).toHaveLength(1)

    // Keep the writes failing across more than one retry, then let them
    // through. Nothing else is sent: the retry alone must land the pin.
    await new Promise((resolve) => setTimeout(resolve, 1_700))
    rmSync(blocker)
    mkdirSync(blocker)
    const state = await waitForFile(
      () => {
        const current = readSidebar(blockedSidebarFile)
        return current?.stickyAssignments?.[hashSidebarSessionId(sessionId)] &&
          current.activeRouting?.[sessionId]
          ? current
          : undefined
      },
      10_000,
      () => JSON.stringify(readSidebar(blockedSidebarFile)),
    )
    const pin = state.stickyAssignments?.[hashSidebarSessionId(sessionId)]
    const servedToken = `Bearer ${pin?.accountId === 'main' ? 'main-access' : pin?.accountId}-token`
    expect(seen).toEqual([servedToken])
    expect(state.activeRouting?.[sessionId]?.activeId).toBe(pin?.accountId)
    expect(seen).toHaveLength(1)

    // One warning per failing write, not one per retry tick.
    await flushForTest()
    const warnings = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) =>
        line.includes(
          'sidebar bookkeeping write failed; retrying in the background',
        ),
      )
    const labels = warnings.map(
      (line) => JSON.parse(line.slice(line.indexOf('{'))).write,
    )
    expect(labels.length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(labels.length)
  }, 20_000)

  for (const mode of ['main-first', 'fallback-first', 'sticky-balanced']) {
    it(`${mode}: returns within the bound while the sidebar and store locks are held, and the bookkeeping lands after release`, async () => {
      const fallbackIds =
        mode === 'main-first' ? [] : ['fallback-1', 'fallback-2']
      seedStore(mode, fallbackIds)
      seedSidebar(sidebarFile, mode, fallbackIds)
      const seen: string[] = []
      installWire(seen)
      const loaded = await loadFetchOverride()
      hooks = loaded.hooks
      await drainSidebarWrites()

      await holdLock(sidebarFile, 'sidebar-write')
      await holdLock(configFile, 'save')
      await holdLock(stateFile, 'save')

      const sessionId = `locked-${mode}`
      const started = performance.now()
      const outcome = await withinBound(
        loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          responseRequestInit(sessionId),
        ),
        HOT_PATH_BOUND_MS,
      )
      const elapsedMs = performance.now() - started
      if (outcome === 'timed-out') {
        throw new Error(
          `${mode} request waited on bookkeeping: no response within ${HOT_PATH_BOUND_MS}ms`,
        )
      }
      expect(outcome.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(elapsedMs).toBeLessThan(HOT_PATH_BOUND_MS)

      // Nothing reached the file while the lock was held.
      const whileHeld = readSidebar(sidebarFile)
      expect(whileHeld?.activeRouting?.[sessionId]).toBeUndefined()

      await releaseLocks()
      const served = seen[0] ?? ''
      const servedId =
        served === 'Bearer main-access-token'
          ? 'main'
          : served.replace(/^Bearer /, '').replace(/-token$/, '')
      const landed = await waitForFile(
        () => {
          const current = readSidebar(sidebarFile)
          if (!current) return undefined
          const routed = current.activeRouting?.[sessionId]?.activeId
          const quota =
            servedId === 'main'
              ? current.main.quota
              : current.fallbacks.find((account) => account.id === servedId)
                  ?.quota
          const pinned =
            mode !== 'sticky-balanced' ||
            current.stickyAssignments?.[hashSidebarSessionId(sessionId)]
              ?.accountId === servedId
          return routed === servedId &&
            quota?.primary?.usedPercent === 42 &&
            pinned
            ? current
            : undefined
        },
        10_000,
        () => JSON.stringify(readSidebar(sidebarFile)),
      )
      expect(landed.activeRouting?.[sessionId]?.activeId).toBe(servedId)
      expect(seen).toHaveLength(1)
    }, 30_000)
  }

  it('a WebSocket quota push whose sidebar write fails raises no unhandled rejection', async () => {
    const blocker = join(configDir, 'sidebar-blocked')
    const blockedSidebarFile = join(blocker, 'sidebar-state.json')
    writeFileSync(blocker, 'not a directory')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = blockedSidebarFile
    seedStore('main-first', [])
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof fetch

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await withFakeWebSocket(async () => {
        const loaded = await loadFetchOverride(true)
        hooks = loaded.hooks
        const response = await loaded.fetchOverride(
          'https://api.openai.com/v1/responses',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'session-id': 'ws-quota-write-fails',
            },
            body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
          },
        )
        expect(response.status).toBe(200)
        await response.text()
        // Let the failed write settle and any rejection be reported.
        await new Promise((resolve) => setTimeout(resolve, 200))
      })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

// A WebSocket stand-in that answers every request with a quota frame and a
// completed response.
async function withFakeWebSocket(run: () => Promise<void>) {
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

    constructor(url: string) {
      this.url = url
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

    send(_data: string) {
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            type: 'codex.rate_limits',
            rate_limits: {
              primary: { used_percent: 35, window_minutes: 300 },
            },
          }),
        })
        this.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_hot_path' },
          }),
        })
      })
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED
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
