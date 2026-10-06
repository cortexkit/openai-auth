// The request path of a migrated install.
//
// Once `openaiAuthPool.migratedAt` is set and OpenCode's slot holds the pool
// placeholder, every account (main included) is a row of the account pool:
// credentials and quota maps live in the pool's files, routing is decided by
// `@cortexkit/common-auth/routing`, and quota is recorded through the store.
// These tests drive the plugin's real fetch override against that layout in
// all three routing modes, the way integration.test.ts drives a legacy one.

import { afterEach, beforeEach, describe, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import { fallbackRefreshLockName } from '@cortexkit/openai-auth-core/internal'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { POOL_QUOTA_UNKNOWN_RETRY_SECONDS } from '../core/pool-routing.ts'
import { CodexAuthPlugin } from '../index.ts'
import { ResponseStreamError } from '../response-stream-error.ts'
import {
  drainSidebarWrites,
  hashSidebarSessionId,
  normalizeSidebarState,
  type SidebarState,
} from '../sidebar-state.ts'
import { createRequestTestScope } from './request-test-scope.ts'
import { restoreEnv } from './setup-env'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

// How long a request may take while the store locks are held; the same bound
// hot-path-bookkeeping.test.ts uses. Far below any lock timeout, so a request
// that waits on a lock at all overruns it, and loose enough for a loaded
// machine.
const HOT_PATH_BOUND_MS = 1_000

const PLACEHOLDER = {
  type: 'oauth' as const,
  access: '',
  refresh: 'common-auth-placeholder:v1:openai',
  expires: 0,
}

type Mode = 'main-first' | 'fallback-first' | 'sticky-balanced'
const MODES: Mode[] = ['main-first', 'fallback-first', 'sticky-balanced']

let configDir: string
let configFile: string
let stateFile: string
let sidebarFile: string
let originalFetch: typeof globalThis.fetch
let hooks: Hooks | undefined
const heldLocks: Array<{ release(): Promise<void> }> = []
const scope = createRequestTestScope()
const it = scope.it
const releasePolls: Array<() => void> = []

type Phase = { name: string; offsetMs: number; durationMs?: number }
let phaseClock:
  | { step<T>(name: string, run: () => T): T; report(reason: string): void }
  | undefined

// Retain nested phases so a stuck request identifies its last wire or sidebar
// operation, not just the outer fetch. Ordinary successful tests stay silent.
function phaseIt(name: string, body: () => Promise<void>) {
  return scope.it(name, async () => {
    const started = performance.now()
    const phases: Phase[] = []
    const clock = {
      step<T>(step: string, run: () => T): T {
        const start = performance.now()
        const phase: Phase = { name: step, offsetMs: start - started }
        phases.push(phase)
        const finish = () => {
          phase.durationMs = performance.now() - start
        }
        try {
          const result = run()
          if (result instanceof Promise) return result.finally(finish) as T
          finish()
          return result
        } catch (error) {
          finish()
          throw error
        }
      },
      report(reason: string) {
        const elapsedMs = performance.now() - started
        console.error(
          JSON.stringify({
            test: name,
            reason,
            elapsedMs,
            phases: phases.map((phase) => ({
              ...phase,
              durationMs: phase.durationMs ?? elapsedMs - phase.offsetMs,
              inFlight: phase.durationMs === undefined,
            })),
          }),
        )
      },
    }
    phaseClock = clock
    const deadline = setTimeout(
      () => clock.report('body exceeded 5000 ms'),
      5_000,
    )
    try {
      await body()
      if (performance.now() - started >= 5_000)
        clock.report('slow body completed')
    } catch (error) {
      clock.report('body failed')
      throw error
    } finally {
      clearTimeout(deadline)
    }
  })
}

function phase<T>(name: string, run: () => T): T {
  return phaseClock ? phaseClock.step(name, run) : run()
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'oai-pool-request-'))
  configFile = join(configDir, 'openai-auth.json')
  stateFile = join(configDir, 'openai-auth-state.json')
  sidebarFile = join(configDir, 'sidebar-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(configDir, 'test.log')
  process.env.NODE_ENV = 'test'
  process.env.OPENCODE_CONFIG_DIR = configDir
  originalFetch = globalThis.fetch
  hooks = undefined
  phaseClock = undefined
})

afterEach(async () => {
  for (const lock of heldLocks.splice(0)) await lock.release()
  for (const release of releasePolls.splice(0)) release()
  await scope.teardown(
    async () => {
      await hooks?.dispose?.()
      globalThis.fetch = originalFetch
      await drainSidebarWrites()
      // Startup pool pulls are not tracked by the request scope. Keep a short
      // grace period for their writes before removing this test's files.
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        FLOOR_SIDEBAR_STATE_FILE
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
      restoreEnv('OPENCODE_CONFIG_DIR')
      delete process.env.NODE_ENV
      rmSync(configDir, { recursive: true, force: true })
    },
    () => phaseClock?.report('request scope teardown: body still in flight'),
  )
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HOUR = 3600_000

function iso(ms: number) {
  return new Date(ms).toISOString()
}

/** A pool quota map with one primary reading (and optionally a budget). */
function quotaMap(
  usedPercent: number,
  options: {
    checkedAt?: number
    resetInMs?: number
    budget?: { reached: boolean; resetInMs?: number }
  } = {},
) {
  const checkedAt = options.checkedAt ?? Date.now()
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent,
        resetsAt: iso(Date.now() + (options.resetInMs ?? 2 * HOUR)),
        windowMinutes: 300,
      },
    ],
    ...(options.budget
      ? {
          budget: {
            kind: 'reading',
            checkedAt,
            reached: options.budget.reached,
            remainingPercent: options.budget.reached ? 0 : 50,
            resetsAt: iso(Date.now() + (options.budget.resetInMs ?? 24 * HOUR)),
          },
        }
      : {}),
  }
}

type RowSeed = {
  id: string
  quota?: ReturnType<typeof quotaMap>
  expires?: number
}

/** Writes a migrated install: roster, pool entries, credentials in the state file. */
function seedPool(
  mode: Mode,
  rows: RowSeed[],
  settings: Record<string, unknown> = {},
) {
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode },
      refresh: { refreshBeforeExpiryMinutes: 5 },
      ...settings,
      accounts: rows.map((row) => ({
        id: row.id,
        type: 'oauth',
        label: row.id,
        enabled: true,
        accountId: `chatgpt-${row.id}`,
        addedAt: 1,
      })),
      commonAuthPool: {
        schemaVersion: 1,
        rows: Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              credentialEpoch: 1,
              needsFirstReading: row.quota === undefined,
              ...(row.quota ? { quota: row.quota } : {}),
            },
          ]),
        ),
      },
      openaiAuthPool: { migratedAt: Date.now() - 60_000 },
    }),
  )
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      accounts: Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            access: `${row.id}-token`,
            refresh: `${row.id}-refresh`,
            expires: row.expires ?? Date.now() + 24 * HOUR,
          },
        ]),
      ),
    }),
  )
}

/** The legacy layout of the same accounts: no pool key, no migration marker. */
function seedLegacy(mode: Mode, ids: string[]) {
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode },
      refresh: { refreshBeforeExpiryMinutes: 5 },
      accounts: ids.map((id) => ({
        id,
        type: 'oauth',
        label: id,
        enabled: true,
        access: `${id}-token`,
        refresh: `${id}-refresh`,
        expires: Date.now() + 24 * HOUR,
        accountId: `chatgpt-${id}`,
      })),
    }),
  )
}

function readConfig(): Record<string, unknown> & {
  commonAuthPool: { rows: Record<string, { quota?: unknown }> }
} {
  return JSON.parse(readFileSync(configFile, 'utf8'))
}

function poolPrimaryUsed(id: string): number | undefined {
  const quota = readConfig().commonAuthPool.rows[id]?.quota as
    | { limits?: Array<{ label: string; kind: string; usedPercent?: number }> }
    | undefined
  return quota?.limits?.find(
    (limit) => limit.label === 'primary' && limit.kind === 'reading',
  )?.usedPercent
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 5_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

function quotaHeaders(usedPercent: number, resetInMs = 2 * HOUR) {
  return {
    'content-type': 'application/json',
    'x-codex-primary-used-percent': String(usedPercent),
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': String(
      Math.floor((Date.now() + resetInMs) / 1000),
    ),
  }
}

function usageBody(usedPercent: number) {
  return JSON.stringify({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18_000,
        reset_at: Math.floor((Date.now() + 2 * HOUR) / 1000),
      },
    },
  })
}

interface Wire {
  /** Bearer of every model request, in order. */
  sends: string[]
  /** Bearer of every quota poll, in order. */
  polls: string[]
  refreshTokens: string[]
}

// Unknown-quota fixtures hold polls only until teardown, rather than leaving
// immortal promises behind when an assertion or a test timeout ends the body.
function heldUsagePoll() {
  const gate = Promise.withResolvers<Response>()
  releasePolls.push(() => gate.resolve(new Response('', { status: 503 })))
  return () => gate.promise
}

/** Replace the network. Model requests answer `respond`; quota polls `usage`. */
function installWire(
  options: {
    respond?: (bearer: string) => Response
    usage?: (bearer: string) => Response | Promise<Response>
  } = {},
): Wire {
  const wire: Wire = { sends: [], polls: [], refreshTokens: [] }
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    const bearer = new Headers(init?.headers).get('authorization') ?? ''
    if (target.includes('/oauth/token')) {
      const refreshToken =
        new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? ''
      wire.refreshTokens.push(refreshToken)
      return new Response(
        JSON.stringify({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
          id_token: 'id',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (target.includes('/wham/usage')) {
      wire.polls.push(bearer)
      return options.usage
        ? options.usage(bearer)
        : new Response(usageBody(10), { status: 200 })
    }
    if (target.includes('/responses')) {
      return phase(`wire send ${wire.sends.length + 1}: ${bearer}`, () => {
        wire.sends.push(bearer)
        return options.respond
          ? options.respond(bearer)
          : new Response('{}', { status: 200, headers: quotaHeaders(42) })
      })
    }
    return new Response('unavailable', { status: 503 })
  }) as unknown as typeof globalThis.fetch
  return wire
}

function mockPluginInput(): PluginInput {
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

type FetchOverride = (
  url: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

async function loadFetch(
  experimentalWebSockets = false,
): Promise<FetchOverride> {
  hooks = await phase('plugin initialization', () =>
    CodexAuthPlugin(mockPluginInput(), { experimentalWebSockets }),
  )
  const authHook = hooks.auth
  if (!authHook?.loader) throw new Error('No auth loader')
  const loaded = await phase('auth loader', () =>
    authHook.loader!(
      (async () => ({ ...PLACEHOLDER })) as never,
      { id: 'openai', label: 'OpenAI', models: [] } as unknown as Parameters<
        NonNullable<(typeof authHook)['loader']>
      >[1],
    ),
  )
  const fetchOverride = (loaded as Record<string, unknown>).fetch as
    | FetchOverride
    | undefined
  if (!fetchOverride) throw new Error('No fetch in loader result')
  let call = 0
  return scope.wrap((url, init) =>
    phase(`fetchOverride ${++call}`, () => fetchOverride(url, init)),
  )
}

const URL_RESPONSES = 'https://api.openai.com/v1/responses'

function request(sessionId?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { 'session-id': sessionId } : {}),
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }),
  }
}

async function sidebar(): Promise<SidebarState> {
  return phase('sidebar read (including drainSidebarWrites)', async () => {
    await drainSidebarWrites()
    return normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
  })
}

function pinOf(state: SidebarState, sessionId: string) {
  return state.stickyAssignments?.[hashSidebarSessionId(sessionId)]?.accountId
}

const healthy = () => quotaMap(10)
const bearer = (id: string) => `Bearer ${id}-token`

// ---------------------------------------------------------------------------
// Serving and recording
// ---------------------------------------------------------------------------

describe('a migrated install serves requests from the account pool', () => {
  for (const mode of MODES) {
    it(`${mode}: sends with a pool row and records its quota through the store`, async () => {
      seedPool(mode, [
        { id: 'main', quota: healthy() },
        { id: 'fallback-1', quota: healthy() },
      ])
      // Quota polls fail, so only the response under test writes quota.
      const wire = installWire({
        usage: () => new Response('', { status: 503 }),
      })
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-serve'))

      expect(response.status).toBe(200)
      const expected = mode === 'fallback-first' ? 'fallback-1' : 'main'
      expect(wire.sends).toEqual([bearer(expected)])
      // The placeholder is never sent nor refreshed.
      expect(wire.refreshTokens).toEqual([])
      await waitFor(
        () => (poolPrimaryUsed(expected) === 42 ? true : undefined),
        5_000,
        `${expected}'s quota in the pool`,
      )
      if (mode === 'sticky-balanced') {
        expect(pinOf(await sidebar(), 's-serve')).toBe(expected)
      }
    })
  }

  it('refreshes an expired row token through the store before sending it', async () => {
    seedPool('main-first', [
      { id: 'main', quota: healthy(), expires: Date.now() - 1_000 },
    ])
    const wire = installWire()
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request())

    expect(response.status).toBe(200)
    // The expired token is refreshed once, before the send. (The background
    // quota seed may later refresh the rotated token; never the spent one.)
    expect(wire.refreshTokens[0]).toBe('main-refresh')
    expect(
      wire.refreshTokens.filter((token) => token === 'main-refresh'),
    ).toHaveLength(1)
    expect(wire.sends).toEqual(['Bearer refreshed-access'])
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state.accounts.main.refresh).toBe('refreshed-refresh')
  })
})

// ---------------------------------------------------------------------------
// Unknown quota
// ---------------------------------------------------------------------------

describe('unknown quota on a migrated install', () => {
  for (const mode of MODES) {
    it(`${mode}: blocks until the first quota poll, which the load starts`, async () => {
      seedPool(mode, [{ id: 'main' }, { id: 'fallback-1' }])
      // Hold every quota poll until released, so the first request finds no
      // reading anywhere.
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      releasePolls.push(release)
      const wire = installWire({
        usage: async () => {
          await gate
          return new Response(usageBody(10), { status: 200 })
        },
      })
      const fetchOverride = await loadFetch()

      // The load already asked for both rows' first readings.
      await waitFor(
        () =>
          wire.polls.includes(bearer('main')) &&
          wire.polls.includes(bearer('fallback-1'))
            ? true
            : undefined,
        5_000,
        'the load-time quota polls',
      )
      const blocked = await fetchOverride(URL_RESPONSES, request('s-unknown'))
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBe(
        String(POOL_QUOTA_UNKNOWN_RETRY_SECONDS),
      )
      expect(wire.sends).toEqual([])

      release()
      await waitFor(
        () =>
          poolPrimaryUsed('main') === 10 && poolPrimaryUsed('fallback-1') === 10
            ? true
            : undefined,
        5_000,
        'the polled readings in the pool',
      )
      const served = await fetchOverride(URL_RESPONSES, request('s-unknown'))
      expect(served.status).toBe(200)
      expect(wire.sends).toHaveLength(1)
    })
  }

  it('a row whose reading is unknown is skipped while another serves', async () => {
    seedPool('main-first', [
      { id: 'main' },
      { id: 'fallback-1', quota: healthy() },
    ])
    const wire = installWire({ usage: heldUsagePoll() })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request())

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('fallback-1')])
  })

  it('sticky-balanced: a pinned row awaiting a reading serves elsewhere and keeps the pin', async () => {
    seedPool('sticky-balanced', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1' },
    ])
    const now = Date.now()
    writeFileSync(
      sidebarFile,
      JSON.stringify({
        main: { quota: null, killed: false },
        fallbacks: [],
        route: 'sticky-balanced',
        lastUpdated: now,
        stickyAssignments: {
          [hashSidebarSessionId('s-detour')]: {
            accountId: 'fallback-1',
            assignedAt: now - 1_000,
            lastSeenAt: now - 1_000,
            inputBytes: 10,
          },
        },
      }),
    )
    const wire = installWire({ usage: heldUsagePoll() })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request('s-detour'))

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('main')])
    expect(pinOf(await sidebar(), 's-detour')).toBe('fallback-1')
  })

  it('the legacy install still fails open on unknown quota', async () => {
    // Same placeholder slot and rows, but never migrated: the legacy path
    // serves main from row `main` without any quota reading.
    seedLegacy('main-first', ['main', 'fallback-1'])
    const wire = installWire({ usage: heldUsagePoll() })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request())

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('main')])
    // Nothing was turned into a pool: the legacy files stay legacy.
    expect(readConfig().commonAuthPool).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Ordered modes
// ---------------------------------------------------------------------------

describe('ordered routing on a migrated install', () => {
  it('main-first: a 429 from main is retried on the next row', async () => {
    seedPool('main-first', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    const wire = installWire({
      respond: (b) =>
        b === bearer('main')
          ? new Response('{}', { status: 429 })
          : new Response('{}', { status: 200, headers: quotaHeaders(42) }),
    })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request())

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('main'), bearer('fallback-1')])
  })

  it('fallback-first: tries the fallbacks, then row main, never row main twice', async () => {
    seedPool('fallback-first', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    const wire = installWire({
      respond: (b) =>
        b === bearer('fallback-1')
          ? new Response('{}', { status: 429 })
          : new Response('{}', { status: 200, headers: quotaHeaders(42) }),
    })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request())

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('fallback-1'), bearer('main')])
  })

  for (const mode of MODES) {
    it(`${mode}: a request that cannot be replayed goes to main once and is never retried`, async () => {
      seedPool(mode, [
        { id: 'main', quota: healthy() },
        { id: 'fallback-1', quota: healthy() },
      ])
      const wire = installWire({
        respond: () => new Response('{}', { status: 429 }),
      })
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, { method: 'GET' })

      expect(response.status).toBe(429)
      expect(wire.sends).toEqual([bearer('main')])
    })
  }
})

// ---------------------------------------------------------------------------
// Exhaustion, credit budget and the last path
// ---------------------------------------------------------------------------

describe('exhaustion and the credit budget on a migrated install', () => {
  for (const mode of MODES) {
    it(`${mode}: an exhausted account is skipped while another can serve`, async () => {
      // fallback-first puts main last; exhaust the account its mode tries first.
      const first = mode === 'fallback-first' ? 'fallback-1' : 'main'
      const other = first === 'main' ? 'fallback-1' : 'main'
      seedPool(mode, [
        { id: 'main', quota: first === 'main' ? quotaMap(100) : healthy() },
        {
          id: 'fallback-1',
          quota: first === 'fallback-1' ? quotaMap(100) : healthy(),
        },
      ])
      const wire = installWire()
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-exh'))

      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([bearer(other)])
    })

    it(`${mode}: a spent credit budget is skipped while another can serve`, async () => {
      const first = mode === 'fallback-first' ? 'fallback-1' : 'main'
      const other = first === 'main' ? 'fallback-1' : 'main'
      const spent = quotaMap(10, { budget: { reached: true } })
      seedPool(mode, [
        { id: 'main', quota: first === 'main' ? spent : healthy() },
        { id: 'fallback-1', quota: first === 'fallback-1' ? spent : healthy() },
      ])
      const wire = installWire()
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-budget'))

      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([bearer(other)])
    })

    it(`${mode}: when every account is exhausted the request still reaches the provider`, async () => {
      // Both windows at 100%: admission refuses both rows, and the request
      // still goes out on the last path rather than being denied unasked.
      seedPool(mode, [
        { id: 'main', quota: quotaMap(100) },
        { id: 'fallback-1', quota: quotaMap(100) },
      ])
      const wire = installWire({
        respond: () => new Response('{}', { status: 429 }),
      })
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-last'))

      expect(response.status).toBe(429)
      expect(wire.sends.length).toBeGreaterThan(0)
    })

    it(`${mode}: when every credit budget is spent the request still reaches the provider`, async () => {
      const spent = () => quotaMap(10, { budget: { reached: true } })
      seedPool(mode, [
        { id: 'main', quota: spent() },
        { id: 'fallback-1', quota: spent() },
      ])
      const wire = installWire()
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-spent'))

      expect(response.status).toBe(200)
      expect(wire.sends).toHaveLength(1)
    })
  }
})

// ---------------------------------------------------------------------------
// Killswitch
// ---------------------------------------------------------------------------

describe('the killswitch on a migrated install', () => {
  const it = phaseIt
  const killswitch = { killswitch: { enabled: true } }

  for (const mode of MODES) {
    it(`${mode}: an account below its threshold is never spent on`, async () => {
      seedPool(
        mode,
        [
          { id: 'main', quota: quotaMap(98) },
          { id: 'fallback-1', quota: healthy() },
        ],
        killswitch,
      )
      const wire = installWire()
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-ks'))

      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([bearer('fallback-1')])
    })

    it(`${mode}: every account below its threshold returns the killswitch 429 without spending`, async () => {
      seedPool(
        mode,
        [
          { id: 'main', quota: quotaMap(98) },
          { id: 'fallback-1', quota: quotaMap(97) },
        ],
        killswitch,
      )
      const wire = installWire()
      const fetchOverride = await loadFetch()

      const response = await fetchOverride(URL_RESPONSES, request('s-ks-all'))

      expect(response.status).toBe(429)
      expect(await response.text()).toContain('Killswitch')
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(wire.sends).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Sticky placement
// ---------------------------------------------------------------------------

describe('sticky-balanced on a migrated install', () => {
  const it = phaseIt
  it('drains a timed-out sticky body before restoring fetch, naming its owner', async () => {
    seedPool(
      'sticky-balanced',
      [
        { id: 'main', quota: healthy() },
        { id: 'fallback-1', quota: healthy() },
      ],
      { killswitch: { enabled: true } },
    )
    let used = 42
    const wire = installWire({
      respond: (b) =>
        new Response('{}', {
          status: 200,
          headers: quotaHeaders(b === bearer('main') ? used : 42),
        }),
      usage: () => new Response('', { status: 503 }),
    })
    const wireFetch = globalThis.fetch
    const fetchOverride = await loadFetch()
    const interrupted = createRequestTestScope()
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const draining = Promise.withResolvers<void>()
    const owner =
      'moves a pin off a row that falls below the killswitch threshold'
    let bodyError: unknown
    const body = interrupted
      .run(owner, async () => {
        await fetchOverride(URL_RESPONSES, request('s-timeout'))
        used = 98
        await fetchOverride(URL_RESPONSES, request('s-timeout'))
        entered.resolve()
        await resume.promise
        await fetchOverride(URL_RESPONSES, request('s-timeout'))
      })
      .catch((error: unknown) => {
        bodyError = error
      })
    await entered.promise
    // Model Bun starting afterEach while the timed-out callback is suspended.
    // The barrier fixes the ordering without relying on machine load or timers.
    const teardown = interrupted
      .teardown(
        async () => {
          globalThis.fetch = originalFetch
        },
        () => draining.resolve(),
      )
      .catch((error: unknown) => error)
    try {
      await draining.promise
      resume.resolve()
      await body
      const error = await teardown
      expect(bodyError).toBeUndefined()
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        `Request work outlived test: ${owner}`,
      )
      expect(wire.sends).toEqual([
        bearer('main'),
        bearer('main'),
        bearer('fallback-1'),
      ])
    } finally {
      resume.resolve()
      await body
      await teardown
      globalThis.fetch = wireFetch
    }
  })

  it('keeps a session on its row across requests', async () => {
    seedPool('sticky-balanced', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    const wire = installWire()
    const fetchOverride = await loadFetch()

    await fetchOverride(URL_RESPONSES, request('s-keep'))
    await fetchOverride(URL_RESPONSES, request('s-keep'))

    expect(wire.sends).toHaveLength(2)
    expect(wire.sends[1]).toBe(wire.sends[0])
    const pinned = pinOf(await sidebar(), 's-keep')
    expect(wire.sends[0]).toBe(bearer(pinned ?? ''))
  })

  it('moves the pin when a 429 carries quota confirming exhaustion, and stays moved', async () => {
    seedPool('sticky-balanced', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    let exhaustMain = false
    const wire = installWire({
      respond: (b) =>
        b === bearer('main') && exhaustMain
          ? new Response('{}', { status: 429, headers: quotaHeaders(100) })
          : new Response('{}', { status: 200, headers: quotaHeaders(42) }),
    })
    const fetchOverride = await loadFetch()

    await fetchOverride(URL_RESPONSES, request('s-move'))
    expect(wire.sends).toEqual([bearer('main')])
    expect(pinOf(await sidebar(), 's-move')).toBe('main')

    exhaustMain = true
    const moved = await fetchOverride(URL_RESPONSES, request('s-move'))
    expect(moved.status).toBe(200)
    expect(wire.sends).toEqual([
      bearer('main'),
      bearer('main'),
      bearer('fallback-1'),
    ])
    expect(pinOf(await sidebar(), 's-move')).toBe('fallback-1')

    await fetchOverride(URL_RESPONSES, request('s-move'))
    expect(wire.sends.at(-1)).toBe(bearer('fallback-1'))
  })

  it('places a new session by the bytes other sessions committed to each row', async () => {
    seedPool('sticky-balanced', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    // No quota on the responses: the readings the pins were judged on stay
    // current, so the first session's bytes still weigh on its row.
    const wire = installWire({
      respond: () => new Response('{}', { status: 200 }),
      usage: () => new Response('', { status: 503 }),
    })
    const fetchOverride = await loadFetch()

    await fetchOverride(URL_RESPONSES, request('s-first'))
    await fetchOverride(URL_RESPONSES, request('s-second'))

    expect(wire.sends).toEqual([bearer('main'), bearer('fallback-1')])
    const state = await sidebar()
    expect(pinOf(state, 's-first')).toBe('main')
    expect(pinOf(state, 's-second')).toBe('fallback-1')
  })

  it('moves a pin off a row that falls below the killswitch threshold', async () => {
    seedPool(
      'sticky-balanced',
      [
        { id: 'main', quota: healthy() },
        { id: 'fallback-1', quota: healthy() },
      ],
      { killswitch: { enabled: true } },
    )
    let used = 42
    const wire = installWire({
      respond: (b) =>
        new Response('{}', {
          status: 200,
          headers: quotaHeaders(b === bearer('main') ? used : 42),
        }),
      usage: () => new Response('', { status: 503 }),
    })
    const fetchOverride = await loadFetch()

    await fetchOverride(URL_RESPONSES, request('s-floor'))
    expect(pinOf(await sidebar(), 's-floor')).toBe('main')
    // This response leaves main below its 5% floor.
    used = 98
    await fetchOverride(URL_RESPONSES, request('s-floor'))
    await fetchOverride(URL_RESPONSES, request('s-floor'))

    expect(wire.sends).toEqual([
      bearer('main'),
      bearer('main'),
      bearer('fallback-1'),
    ])
    expect(pinOf(await sidebar(), 's-floor')).toBe('fallback-1')
  })

  /** Writes a sidebar file pinning `sessionId` to row `accountId`. */
  function presetPin(sessionId: string, accountId: string) {
    const now = Date.now()
    writeFileSync(
      sidebarFile,
      JSON.stringify({
        main: { quota: null, killed: false },
        fallbacks: [],
        route: 'sticky-balanced',
        lastUpdated: now,
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId,
            assignedAt: now - 1_000,
            lastSeenAt: now - 1_000,
            inputBytes: 10,
          },
        },
      }),
    )
  }

  it('moves a pin off a row confirmed exhausted before sending, to a row that can serve', async () => {
    seedPool('sticky-balanced', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: quotaMap(100) },
    ])
    presetPin('s-exhausted-pin', 'fallback-1')
    const wire = installWire({
      respond: () => new Response('{}', { status: 200 }),
      usage: () => new Response('', { status: 503 }),
    })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(
      URL_RESPONSES,
      request('s-exhausted-pin'),
    )

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('main')])
    expect(pinOf(await sidebar(), 's-exhausted-pin')).toBe('main')
  })

  it('sends to a pinned exhausted row when no other row can serve (the last path)', async () => {
    // Row order would send an unpinned request to main first; the session's
    // own row is the one still probed.
    seedPool('sticky-balanced', [
      { id: 'main', quota: quotaMap(100) },
      { id: 'fallback-1', quota: quotaMap(100) },
    ])
    presetPin('s-last-pin', 'fallback-1')
    const wire = installWire({
      respond: () => new Response('{}', { status: 200 }),
      usage: () => new Response('', { status: 503 }),
    })
    const fetchOverride = await loadFetch()

    const response = await fetchOverride(URL_RESPONSES, request('s-last-pin'))

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([bearer('fallback-1')])
    expect(pinOf(await sidebar(), 's-last-pin')).toBe('fallback-1')
  })

  it("places a new session by the quota above each account's own killswitch threshold", async () => {
    // fallback-1 has more quota left (90% against 50%), but placement counts
    // only the quota above an account's killswitch threshold: 90 - 85 = 5
    // for fallback-1 against 50 - 5 (the default threshold) = 45 for main.
    seedPool(
      'sticky-balanced',
      [
        { id: 'main', quota: quotaMap(50) },
        { id: 'fallback-1', quota: quotaMap(10) },
      ],
      {
        killswitch: {
          enabled: false,
          accounts: { 'fallback-1': { primary: 85, secondary: 85 } },
        },
      },
    )
    const wire = installWire({
      respond: () => new Response('{}', { status: 200 }),
      usage: () => new Response('', { status: 503 }),
    })
    const fetchOverride = await loadFetch()

    await fetchOverride(URL_RESPONSES, request('s-reserve'))

    expect(wire.sends).toEqual([bearer('main')])
    expect(pinOf(await sidebar(), 's-reserve')).toBe('main')
  })

  it('a 429 without exhausting quota keeps the pin and the response', async () => {
    seedPool('sticky-balanced', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    let fail = false
    const wire = installWire({
      respond: (b) =>
        b === bearer('main') && fail
          ? new Response('{}', { status: 429, headers: quotaHeaders(50) })
          : new Response('{}', { status: 200, headers: quotaHeaders(42) }),
    })
    const fetchOverride = await loadFetch()

    await fetchOverride(URL_RESPONSES, request('s-transient'))
    fail = true
    const response = await fetchOverride(URL_RESPONSES, request('s-transient'))

    expect(response.status).toBe(429)
    expect(wire.sends).toEqual([bearer('main'), bearer('main')])
    expect(pinOf(await sidebar(), 's-transient')).toBe('main')
  })
})

// ---------------------------------------------------------------------------
// Mid-stream rate limit over WebSocket
// ---------------------------------------------------------------------------

type FakeSocketContext = {
  message(data: string): void
  authorization: string
}

async function withFakeWebSocket(
  behavior: (context: FakeSocketContext) => { send?: (data: string) => void },
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
    private readonly behavior: { send?: (data: string) => void }
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url
      this.behavior = behavior({
        message: (data) => this.emit('message', { data }),
        authorization: options?.headers?.authorization ?? '',
      })
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
      for (const listener of this.listeners.get(type) ?? []) {
        if (listener.fn === fn) this.listeners.get(type)?.delete(listener)
      }
    }
    send(data: string) {
      this.behavior.send?.(data)
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED
    }
    private emit(type: string, event: unknown) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        listener.fn(event)
        if (listener.once) this.listeners.get(type)?.delete(listener)
      }
    }
  }
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  try {
    await run()
  } finally {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = original
  }
}

describe('a mid-stream rate limit on a migrated install', () => {
  it('fallback-first: the marked row is skipped on the next request', async () => {
    seedPool('fallback-first', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    installWire()
    const sends: string[] = []
    await withFakeWebSocket(
      ({ message, authorization }) => ({
        send() {
          sends.push(authorization)
          if (authorization === bearer('fallback-1')) {
            message(
              JSON.stringify({
                type: 'response.failed',
                response: {
                  id: 'resp_failed',
                  failed: { rate_limit_reached_type: 'primary' },
                },
              }),
            )
            return
          }
          message(
            JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_${sends.length}` },
            }),
          )
        },
      }),
      async () => {
        const fetchOverride = await loadFetch(true)
        const wsRequest: RequestInit = {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'session-id': 's-ws' },
          body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
        }
        const first = await fetchOverride(URL_RESPONSES, wsRequest)
        expect(first.status).toBe(200)
        await expect(first.text()).rejects.toBeInstanceOf(ResponseStreamError)

        const second = await fetchOverride(URL_RESPONSES, wsRequest)
        expect(second.status).toBe(200)
        await second.text()
        expect(sends).toEqual([bearer('fallback-1'), bearer('main')])
      },
    )
  })
})

// ---------------------------------------------------------------------------
// Hot path
// ---------------------------------------------------------------------------

async function withinBound(
  pending: Promise<Response>,
  boundMs: number,
): Promise<Response | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), boundMs)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Background work (a load-time poll reading its credential) may hold a store
// lock for a moment, so taking one is retried briefly.
async function holdLock(path: string, name: string) {
  const deadline = Date.now() + 3_000
  for (;;) {
    const lock = await acquireRefreshFileLock({
      path,
      name,
      ttlMs: 60_000,
      renew: true,
    })
    if (lock) {
      heldLocks.push(lock)
      return
    }
    if (Date.now() > deadline)
      throw new Error(`could not take the ${name} lock on ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('the migrated request path never waits on the store locks', () => {
  for (const mode of MODES) {
    it(`${mode}: reaches the wire within the bound while every store lock is held, and the quota lands after release`, async () => {
      seedPool(mode, [
        { id: 'main', quota: healthy() },
        { id: 'fallback-1', quota: healthy() },
      ])
      const wire = installWire({
        usage: () => new Response('', { status: 503 }),
      })
      const fetchOverride = await loadFetch()
      await drainSidebarWrites()
      // Let the load-time polls (which take the store locks briefly to read
      // the credential) reach the network before this test takes the locks.
      await waitFor(
        () => (wire.polls.length >= 2 ? true : undefined),
        5_000,
        'the load-time quota polls',
      )

      // Hold every lock a pool write or refresh could take: the store's save
      // locks, its provider-wide lock, every row lock, the legacy refresh
      // locks a pool refresh also takes, and the sidebar lock.
      await holdLock(configFile, 'save')
      await holdLock(stateFile, 'save')
      await holdLock(stateFile, 'provider-openai')
      for (const id of ['main', 'fallback-1']) {
        await holdLock(stateFile, `row-${encodeURIComponent(`chatgpt-${id}`)}`)
        await holdLock(configFile, fallbackRefreshLockName(id))
      }
      await holdLock(configFile, 'main-refresh')
      await holdLock(sidebarFile, 'sidebar-write')

      const started = performance.now()
      const outcome = await withinBound(
        fetchOverride(URL_RESPONSES, request(`locked-${mode}`)),
        HOT_PATH_BOUND_MS,
      )
      const elapsedMs = performance.now() - started
      if (outcome === 'timed-out') {
        throw new Error(
          `${mode} request waited on a store lock: no response within ${HOT_PATH_BOUND_MS}ms`,
        )
      }
      expect(outcome.status).toBe(200)
      expect(wire.sends).toHaveLength(1)
      expect(elapsedMs).toBeLessThan(HOT_PATH_BOUND_MS)
      const served = (wire.sends[0] ?? '')
        .replace(/^Bearer /, '')
        .replace(/-token$/, '')
      // Nothing reached the pool while its locks were held.
      expect(poolPrimaryUsed(served)).toBe(10)

      for (const lock of heldLocks.splice(0)) await lock.release()
      await waitFor(
        () => (poolPrimaryUsed(served) === 42 ? true : undefined),
        10_000,
        'the queued quota write after release',
      )
    }, 30_000)
  }
})

describe('a row whose replace stopped between its two writes', () => {
  it('is completed by its first poll, takes its first reading with the new login, and serves it', async () => {
    seedPool('fallback-first', [
      { id: 'main', quota: healthy() },
      { id: 'fallback-1', quota: healthy() },
    ])
    // A replace that wrote the new login's credential (state file) and died
    // before the config write that records its account and epoch.
    const crashing = openPoolStore({
      provider: 'openai',
      configPath: configFile,
      statePath: stateFile,
      quota: quotaCodec,
      onStep: (step, { operation }) => {
        if (operation === 'replace' && step === 'before-config-write')
          throw new Error('crash between the writes')
      },
    })
    await expect(
      crashing.replace(
        'fallback-1',
        {
          type: 'oauth',
          access: 'fallback-1-new-token',
          refresh: 'fallback-1-new-refresh',
          expires: Date.now() + 24 * HOUR,
        },
        { identity: 'chatgpt-fallback-1-new' },
      ),
    ).rejects.toThrow()
    const reader = openPoolStore({
      provider: 'openai',
      configPath: configFile,
      statePath: stateFile,
      quota: quotaCodec,
    })
    const tornRow = async () => {
      const load = await reader.read()
      return load.status === 'ready'
        ? load.rows.find((row) => row.id === 'fallback-1')
        : undefined
    }
    expect(await tornRow()).toMatchObject({ torn: true, candidate: false })

    // Loading the plugin polls the torn row (it is never a candidate, so
    // only its own poll heals it): the pull first completes the replace from
    // the stamp beside the credential, then polls with the new login, and
    // that first reading is the new account's.
    const wire = installWire()
    const fetchOverride = await loadFetch()
    let completed = await tornRow()
    for (
      const deadline = Date.now() + 10_000;
      (completed?.torn || completed?.needsFirstReading) &&
      Date.now() < deadline;
      completed = await tornRow()
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(completed).toMatchObject({
      candidate: true,
      credentialEpoch: 2,
      identity: 'chatgpt-fallback-1-new',
    })
    expect(completed?.torn).toBeUndefined()

    // fallback-first tries fallback-1 first: it serves with the new login.
    // The credential the replace retired never reaches the wire.
    const response = await fetchOverride(URL_RESPONSES, request('torn'))
    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer fallback-1-new-token'])
    expect(wire.polls).toContain('Bearer fallback-1-new-token')
    expect([...wire.sends, ...wire.polls]).not.toContain(
      'Bearer fallback-1-token',
    )
  }, 30_000)
})
