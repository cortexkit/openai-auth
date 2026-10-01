// The surfaces outside the request path on a migrated install: the
// background refresh and quota poll, the sidebar, the account commands,
// cachekeep, reset credits and the auth menu. Each reads and writes the
// account pool's rows, never the legacy main slot plus fallback list.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type AccountPaths,
  loadAccounts,
} from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
import type { OpenAICacheKeepManager } from '../core/cachekeep'
import { PoolAccountSource } from '../core/pool-account-source'
import { buildPoolSidebarMachineState } from '../core/pool-sidebar'
import {
  __resetBootQuotaSeedForTest,
  createResetTargetResolver,
} from '../index.ts'
import {
  drainSidebarWrites,
  normalizeSidebarState,
  type SidebarState,
} from '../sidebar-state.ts'
import {
  HOUR,
  installWire,
  loadPlugin,
  quotaMap,
  readJson,
  seedPool,
  sleep,
  usageBody,
  waitFor,
} from './fixtures/pool-install'
import { restoreEnv } from './setup-env'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

let configDir: string
let files: { configFile: string; stateFile: string }
let paths: AccountPaths
let sidebarFile: string
let originalFetch: typeof globalThis.fetch
let hooks: Hooks | undefined

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'oai-pool-surfaces-'))
  files = {
    configFile: join(configDir, 'openai-auth.json'),
    stateFile: join(configDir, 'openai-auth-state.json'),
  }
  paths = { configPath: files.configFile, statePath: files.stateFile }
  sidebarFile = join(configDir, 'sidebar-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = files.configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = files.stateFile
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(configDir, 'test.log')
  process.env.NODE_ENV = 'test'
  process.env.OPENCODE_CONFIG_DIR = configDir
  originalFetch = globalThis.fetch
  hooks = undefined
  // Every test starts as a fresh process would, so the one-time boot quota
  // seed (a legacy quota poll at loader start) is allowed to run.
  __resetBootQuotaSeedForTest()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await hooks?.dispose?.()
  await drainSidebarWrites()
  // Background pool writes may still be landing; let them finish before the
  // directory goes away.
  await sleep(50)
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = FLOOR_SIDEBAR_STATE_FILE
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
  restoreEnv('OPENCODE_CONFIG_DIR')
  delete process.env.NODE_ENV
  rmSync(configDir, { recursive: true, force: true })
})

/** Background poller timers whose tick the test fires by hand. */
function manualTimers() {
  const timers = {
    tick: undefined as (() => void) | undefined,
    options: {
      setIntervalFn: (callback: () => void) => {
        timers.tick = callback
        return {} as ReturnType<typeof setInterval>
      },
      clearIntervalFn: () => {},
    },
  }
  return timers
}

type PoolConfig = {
  accounts: Array<{ id: string; enabled?: boolean }>
  commonAuthPool: {
    rows: Record<string, { quota?: unknown; disabledReason?: string }>
  }
  killswitch?: { accounts?: Record<string, unknown> }
}

function config(): PoolConfig {
  return readJson(files.configFile) as unknown as PoolConfig
}

function _stateAccounts(): Record<string, { access?: string }> {
  return (readJson(files.stateFile).accounts ?? {}) as Record<
    string,
    { access?: string }
  >
}

function poolPrimaryUsed(id: string): number | undefined {
  const quota = config().commonAuthPool.rows[id]?.quota as
    | { limits?: Array<{ label: string; kind: string; usedPercent?: number }> }
    | undefined
  return quota?.limits?.find(
    (limit) => limit.label === 'primary' && limit.kind === 'reading',
  )?.usedPercent
}

type CommandHook = (input: {
  command: string
  arguments: string
  sessionID: string
}) => Promise<void>

async function _runCommand(command: string, args = '') {
  const hook = (hooks as unknown as Record<string, CommandHook | undefined>)?.[
    'command.execute.before'
  ]
  if (!hook) throw new Error('command hook missing')
  // The hook ends every handled command by throwing its sentinel.
  await hook({ command, arguments: args, sessionID: 'session-1' }).catch(
    () => {},
  )
}

// ---------------------------------------------------------------------------
// Background refresh and quota poll
// ---------------------------------------------------------------------------

describe('a migrated install refreshes and polls its rows only through the pool', () => {
  it('runs no legacy background refresh or legacy quota poll against pool rows', async () => {
    // Both tokens are inside the refresh window (five minutes), so the legacy
    // background refresh and the legacy boot quota seed would refresh them.
    const soon = Date.now() + 3 * 60_000
    seedPool(files, [
      { id: 'main', quota: quotaMap(10), expires: soon },
      { id: 'fallback-1', quota: quotaMap(10), expires: soon },
    ])
    const wire = installWire()
    const timers = manualTimers()
    hooks = await loadPlugin({ backgroundQuota: timers.options })

    await waitFor(
      () => (wire.polls.length >= 2 ? true : undefined),
      'the first pool polls',
    )
    await sleep(750)

    // The pool polled each row once, at load; nothing refreshed a token.
    expect([...wire.polls].sort()).toEqual([
      'Bearer fallback-1-token',
      'Bearer main-token',
    ])
    expect(wire.refreshTokens).toEqual([])
  })

  it('polls under the bg-quota-refresh lease, refreshing due tokens through the pool', async () => {
    const stale = Date.now() - HOUR
    seedPool(files, [
      { id: 'main', quota: quotaMap(10, stale) },
      {
        id: 'fallback-1',
        quota: quotaMap(10, stale),
        expires: Date.now() + 3 * 60_000,
      },
    ])
    let usage = () => new Response('', { status: 503 })
    const wire = installWire({ usage: () => usage() })
    const timers = manualTimers()
    hooks = await loadPlugin({ backgroundQuota: timers.options })
    await waitFor(
      () => (wire.polls.length >= 2 ? true : undefined),
      'the first pool polls',
    )
    await sleep(100)
    const tick = timers.tick
    if (!tick) throw new Error('the background poller was not started')

    // Another process holds the bg-quota-refresh lease: this process's
    // background pass polls no row.
    const lease = await acquireRefreshFileLock({
      name: 'bg-quota-refresh',
      ttlMs: 120_000,
      path: files.configFile,
    })
    if (!lease) throw new Error('lease not taken')
    tick()
    await sleep(750)
    expect(wire.polls).toHaveLength(2)
    expect(wire.refreshTokens).toEqual([])
    await lease.release()

    // With the lease free, the pass refreshes the due token and polls both
    // stale rows, and the readings land in the pool's quota maps.
    usage = () => new Response(usageBody(33), { status: 200 })
    tick()
    await waitFor(
      () =>
        poolPrimaryUsed('main') === 33 && poolPrimaryUsed('fallback-1') === 33
          ? true
          : undefined,
      'both rows polled into the pool',
    )
    expect(wire.refreshTokens).toEqual(['fallback-1-refresh'])
    expect(wire.polls.slice(2).sort()).toEqual([
      'Bearer main-token',
      'Bearer refreshed-fallback-1-refresh',
    ])
  })
})

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

describe('the sidebar of a migrated install', () => {
  it('shows row main as the main account and the other rows in roster order', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(20) },
      { id: 'fallback-2', quota: quotaMap(30) },
      { id: 'fallback-1', quota: quotaMap(40) },
    ])
    installWire({ usage: () => new Response('', { status: 503 }) })
    hooks = await loadPlugin()

    const state = await waitFor(() => {
      try {
        const parsed = normalizeSidebarState(
          JSON.parse(readFileSync(sidebarFile, 'utf8')),
        )
        return parsed.accountPool ? parsed : undefined
      } catch {
        return undefined
      }
    }, 'the pool sidebar snapshot')
    await drainSidebarWrites()

    expect(state.main.mainAccountId).toBe('chatgpt-main')
    expect(state.main.quota?.primary?.usedPercent).toBe(20)
    expect(state.fallbacks.map((entry) => entry.id)).toEqual([
      'fallback-2',
      'fallback-1',
    ])
    expect(
      state.fallbacks.map((entry) => entry.quota?.primary?.usedPercent),
    ).toEqual([30, 40])
  })

  it('projects rows without renaming any field an older reader knows', () => {
    const rows = [
      {
        id: 'fallback-1',
        type: 'oauth' as const,
        label: 'work',
        enabled: true,
        identity: 'chatgpt-fallback-1',
        needsFirstReading: false,
        hasEntry: true,
        candidate: true,
        quota: quotaMap(40),
      },
      {
        id: 'main',
        type: 'oauth' as const,
        enabled: true,
        identity: 'chatgpt-main',
        needsFirstReading: false,
        hasEntry: true,
        candidate: true,
        quota: quotaMap(20),
      },
      {
        id: 'off',
        type: 'oauth' as const,
        enabled: false,
        needsFirstReading: false,
        hasEntry: true,
        candidate: false,
      },
    ]
    const state = buildPoolSidebarMachineState(
      rows,
      { routing: { mode: 'sticky-balanced' } },
      1_000,
      (id) => (id === 'main' ? 2 : undefined),
    )
    expect(state.accountPool).toBe(true)
    expect(state.route).toBe('sticky-balanced')
    expect(state.main.mainAccountId).toBe('chatgpt-main')
    expect(state.main.resetCredits).toBe(2)
    expect(state.main.quota?.primary?.usedPercent).toBe(20)
    expect(state.fallbacks).toHaveLength(1)
    expect(state.fallbacks[0]).toMatchObject({
      id: 'fallback-1',
      label: 'work',
      accountId: 'chatgpt-fallback-1',
      killed: false,
      enabled: true,
    })
    // Read back through the normaliser every TUI version shares.
    const read: SidebarState = normalizeSidebarState(
      JSON.parse(JSON.stringify({ ...state, activeId: undefined })),
    )
    expect(read.main.quota?.primary?.usedPercent).toBe(20)
    expect(read.fallbacks[0]?.id).toBe('fallback-1')
  })
})

describe('cachekeep and reset credits on a migrated install', () => {
  // OpenCode's slot holds a real login here (one not adopted yet), so a
  // surface that read main from the slot would send `slot-token`.
  const slot = {
    type: 'oauth',
    access: 'slot-token',
    refresh: 'slot-refresh',
    expires: Date.now() + 24 * HOUR,
  }

  it('cachekeep warms main with row main token, never the slot', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
    ])
    const wire = installWire()
    hooks = await loadPlugin({}, slot)
    const managers = (
      globalThis as {
        __openaiAuthCacheKeepManagers?: Map<string, unknown>
      }
    ).__openaiAuthCacheKeepManagers
    const manager = [...(managers?.values() ?? [])].at(-1) as
      | OpenAICacheKeepManager
      | undefined
    if (!manager) throw new Error('no cachekeep manager')

    // Track one session per account, move both cache expiries to now so the
    // tick warms them, and check that each warm request carries the bearer
    // the plugin resolved for that account.
    const body = JSON.stringify({ model: 'gpt-5.5', input: [] })
    for (const accountId of ['main', 'fallback-1']) {
      manager.track({
        sessionKey: `warm-${accountId}`,
        bodyText: body,
        accountId,
        meta: { replayHeaders: {} },
      })
    }
    const targets = (
      manager as unknown as {
        targets: Map<string, { cacheExpiresAt: number }>
      }
    ).targets
    for (const target of targets.values()) target.cacheExpiresAt = Date.now()
    const before = wire.sends.length
    await manager.tick()

    const warms = wire.sends.slice(before)
    expect(warms).toContain('Bearer main-token')
    expect(warms).toContain('Bearer fallback-1-token')
    expect(warms).not.toContain('Bearer slot-token')
  })

  it('the reset resolver reads row main through the pool source', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'off', quota: quotaMap(10), enabled: false },
    ])
    installWire()
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async () => {
        throw new Error('no refresh expected')
      },
      pullQuota: async () => undefined,
    })
    await source.load()
    const legacy = async (): Promise<never> => {
      throw new Error('the legacy path must not run')
    }
    const resolve = createResetTargetResolver({
      getAuth: legacy,
      refreshMainWithLease: legacy,
      refreshFallbackAccount: legacy,
      poolAccess: (key) => source.rowAccess(key, null),
      loadAccounts,
      accountStoragePath: files.configFile,
      accountStatePath: files.stateFile,
      now: Date.now,
    })

    const target = await resolve('main')
    expect(target).toMatchObject({
      accountKey: 'main',
      label: 'Main account',
      accessToken: 'main-token',
      chatgptAccountId: 'chatgpt-main',
    })
    await expect(resolve('off')).rejects.toMatchObject({
      code: 'disabled_account',
    })
    await expect(resolve('missing')).rejects.toMatchObject({
      code: 'unknown_account',
    })
    source.dispose()
    await source.settled()
  })
})

// ---------------------------------------------------------------------------
// Auth menu
// ---------------------------------------------------------------------------
