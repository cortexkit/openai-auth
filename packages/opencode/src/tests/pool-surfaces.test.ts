// The surfaces outside the request path on a migrated install: the
// background refresh and quota poll, the sidebar, the account commands,
// cachekeep, reset credits and the auth menu. Each reads and writes the
// account pool's rows, never the legacy main slot plus fallback list.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type AccountPaths,
  fallbackRefreshLockName,
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
import { createAuthMethods } from '../auth/methods'
import { buildDialogPayload, type CommandContext } from '../commands'
import { PoolAccountSource } from '../core/pool-account-source'
import { MAIN_REFRESH_LOCK_NAME } from '../core/custody-transition'
import { commandAccountPool, openAccountPool } from '../core/pool-accounts'
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

function stateAccounts(): Record<string, { access?: string }> {
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

async function runCommand(command: string, args = '') {
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

  it('/openai-quota polls every pool row through the store', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
      { id: 'fallback-2', quota: quotaMap(10) },
    ])
    let used = 10
    const wire = installWire({
      usage: () => new Response(usageBody(used), { status: 200 }),
    })
    const prompts: string[] = []
    hooks = await loadPlugin({}, undefined, (text) => prompts.push(text))
    await waitFor(
      () => (wire.polls.length >= 3 ? true : undefined),
      'the first pool polls',
    )
    await sleep(100)

    used = 55
    await runCommand('openai-quota')

    expect(wire.polls.slice(3).sort()).toEqual([
      'Bearer fallback-1-token',
      'Bearer fallback-2-token',
      'Bearer main-token',
    ])
    for (const id of ['main', 'fallback-1', 'fallback-2']) {
      expect(poolPrimaryUsed(id)).toBe(55)
    }
    expect(prompts.join('\n')).toContain('### Main account')
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

// ---------------------------------------------------------------------------
// /openai-account and /openai-killswitch
// ---------------------------------------------------------------------------

function commandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    accountStoragePath: files.configFile,
    accountStatePath: files.stateFile,
    packageVersion: '0.0.0-test',
    quotaManager: new QuotaManager({
      storage: null,
      configPath: files.configFile,
    }),
    loadAccounts,
    client: { auth: { set: async () => undefined } },
    accountPool: commandAccountPool({
      paths: () => paths,
      store: () => openAccountPool(paths),
    }),
    ...overrides,
  }
}

function login(id: string, accountId: string): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `${id}-access`,
    refresh: `${id}-refresh`,
    expires: Date.now() + HOUR,
    enabled: true,
    addedAt: Date.now(),
    lastUsed: 0,
    accountId,
  }
}

describe('/openai-account on a migrated install', () => {
  beforeEach(() => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
    ])
  })

  it('lists the pool rows with row main as the main account, and no credentials', async () => {
    const payload = await buildDialogPayload(
      'openai-account',
      '',
      commandContext(),
    )
    expect(payload.text).toContain('`main` (oauth, main account)')
    expect(payload.text).toContain('`fallback-1` (oauth)')
    expect(payload.knobs.accounts).toEqual([
      { id: 'main', type: 'oauth', enabled: true, label: 'main' },
      { id: 'fallback-1', type: 'oauth', enabled: true, label: 'fallback-1' },
    ])
    expect(JSON.stringify(payload)).not.toMatch(/-token|-refresh/)
  })

  it('disables through the store and enables the roster row again', async () => {
    const off = await buildDialogPayload(
      'openai-account',
      'disable fallback-1',
      commandContext(),
    )
    expect(off.text).toContain('Account Disabled')
    expect(
      config().accounts.find((row) => row.id === 'fallback-1')?.enabled,
    ).toBe(false)
    expect(config().commonAuthPool.rows['fallback-1']?.disabledReason).toBe(
      'disabled-by-user',
    )

    await buildDialogPayload(
      'openai-account',
      'enable fallback-1',
      commandContext(),
    )
    expect(
      config().accounts.find((row) => row.id === 'fallback-1')?.enabled,
    ).toBe(true)
  })

  it('reorders the roster, removes a row, and refuses to remove main', async () => {
    await buildDialogPayload(
      'openai-account',
      'order fallback-1 main',
      commandContext(),
    )
    expect(config().accounts.map((row) => row.id)).toEqual([
      'fallback-1',
      'main',
    ])

    const refused = await buildDialogPayload(
      'openai-account',
      'remove main',
      commandContext(),
    )
    expect(refused.text).toContain('Cannot Remove Account')
    expect(config().accounts.map((row) => row.id)).toContain('main')
    expect(stateAccounts().main?.access).toBe('main-token')

    const removed = await buildDialogPayload(
      'openai-account',
      'remove fallback-1',
      commandContext(),
    )
    expect(removed.text).toContain('Account Removed')
    expect(config().accounts.map((row) => row.id)).toEqual(['main'])
    expect(stateAccounts()['fallback-1']).toBeUndefined()
    expect(JSON.stringify(removed.knobs)).not.toMatch(/-token|-refresh/)
  })

  it('adds a new login as a pool row', async () => {
    const notices: string[] = []
    const ctx = commandContext({
      notify: (payload) => notices.push(payload.text),
      beginAccountLogin: (async () => ({
        url: 'https://auth.example/login',
        instructions: 'Sign in.',
        completion: Promise.resolve(login('new-acct', 'chatgpt-new')),
      })) as unknown as CommandContext['beginAccountLogin'],
    })
    await buildDialogPayload('openai-account', 'add', ctx)
    await waitFor(
      () => (notices.length > 0 ? true : undefined),
      'the add notice',
    )

    expect(notices[0]).toContain('Account Added')
    expect(config().accounts.map((row) => row.id)).toEqual([
      'main',
      'fallback-1',
      'new-acct',
    ])
    // `store.add` writes the row's pool entry along with its roster row; the
    // legacy roster writer would leave the pool entry out.
    expect(config().commonAuthPool.rows['new-acct']).toBeDefined()
    expect(stateAccounts()['new-acct']?.access).toBe('new-acct-access')
  })

  it('refuses to add the account row main already holds', async () => {
    const notices: string[] = []
    await buildDialogPayload(
      'openai-account',
      'add',
      commandContext({
        notify: (payload) => notices.push(payload.text),
        beginAccountLogin: (async () => ({
          url: 'https://auth.example/login',
          instructions: 'Sign in.',
          completion: Promise.resolve(login('dup', 'chatgpt-main')),
        })) as unknown as CommandContext['beginAccountLogin'],
      }),
    )
    await waitFor(
      () => (notices.length > 0 ? true : undefined),
      'the add notice',
    )
    expect(notices[0]).toContain('already your main account')
    expect(config().accounts.map((row) => row.id)).toEqual([
      'main',
      'fallback-1',
    ])
  })

  it('refuses to remove a row a pending migration transfer names', async () => {
    const raw = readJson(files.configFile)
    raw.openaiAuthPool = {
      ...(raw.openaiAuthPool as Record<string, unknown>),
      pending: {
        rowId: 'fallback-1',
        operation: 'rotate',
        rowFingerprint: null,
        slotFingerprint: 'slot-fingerprint',
        credentialFingerprint: 'credential-fingerprint',
        carryLegacyMain: false,
        recordedAt: 1,
      },
    }
    writeFileSync(files.configFile, JSON.stringify(raw))

    const refused = await buildDialogPayload(
      'openai-account',
      'remove fallback-1',
      commandContext(),
    )
    expect(refused.text).toContain('Cannot Remove Account')
    expect(refused.text).toContain('migration is moving')
    expect(config().accounts.map((row) => row.id)).toEqual([
      'main',
      'fallback-1',
    ])
    expect(stateAccounts()['fallback-1']?.access).toBe('fallback-1-token')
  })

  it('refuses to enable a row whose ChatGPT account another enabled row holds', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
      { id: 'fallback-2', quota: quotaMap(10), enabled: false },
    ])
    const raw = readJson(files.configFile) as {
      accounts: Array<{ id: string; accountId?: string }>
    }
    const twin = raw.accounts.find((row) => row.id === 'fallback-2')
    if (!twin) throw new Error('fallback-2 not seeded')
    twin.accountId = 'chatgpt-fallback-1'
    writeFileSync(files.configFile, JSON.stringify(raw))

    const refused = await buildDialogPayload(
      'openai-account',
      'enable fallback-2',
      commandContext(),
    )
    expect(refused.text).toContain('Cannot Enable Account')
    expect(refused.text).toContain(
      '`fallback-2` is the same ChatGPT account as `fallback-1`',
    )
    expect(
      config().accounts.find((row) => row.id === 'fallback-2')?.enabled,
    ).toBe(false)
  })

  // An older openai-auth process refreshes a roster row under the row's
  // fallback refresh lock and the slot's token under `main-refresh`; a row
  // write must wait for either rather than land in the middle of a refresh.
  const fallbackLock = fallbackRefreshLockName('fallback-1')
  for (const [command, lockLabel, lockName] of [
    ['disable', 'fallback refresh', fallbackLock],
    ['enable', 'fallback refresh', fallbackLock],
    ['remove', 'fallback refresh', fallbackLock],
    ['disable', 'main-refresh', MAIN_REFRESH_LOCK_NAME],
    ['enable', 'main-refresh', MAIN_REFRESH_LOCK_NAME],
    ['remove', 'main-refresh', MAIN_REFRESH_LOCK_NAME],
  ] as const) {
    it(`${command} waits for the legacy ${lockLabel} lock and completes once it is released`, async () => {
      if (command === 'enable') {
        seedPool(files, [
          { id: 'main', quota: quotaMap(10) },
          { id: 'fallback-1', quota: quotaMap(10), enabled: false },
        ])
      }
      const before = readFileSync(files.configFile, 'utf8')
      const lock = await acquireRefreshFileLock({
        name: lockName,
        ttlMs: 60_000,
        path: files.configFile,
      })
      if (!lock) throw new Error('legacy lock not taken')
      let settled = false
      const pending = buildDialogPayload(
        'openai-account',
        `${command} fallback-1`,
        commandContext(),
      ).finally(() => {
        settled = true
      })
      try {
        await sleep(400)
        expect(settled).toBe(false)
        expect(readFileSync(files.configFile, 'utf8')).toBe(before)
      } finally {
        await lock.release()
      }

      const done = await pending
      expect(done.text).not.toContain('Cannot')
      const row = config().accounts.find(
        (candidate) => candidate.id === 'fallback-1',
      )
      if (command === 'remove') expect(row).toBeUndefined()
      else expect(row?.enabled).toBe(command === 'enable')
    })
  }

  it('order swaps two rows through the store; every row, pool entry and the state file stay as they were', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
      { id: 'fallback-2', quota: quotaMap(10) },
    ])
    const raw = readJson(files.configFile) as {
      accounts: Array<Record<string, unknown>>
    }
    // A field neither the store nor the legacy loader recognises:
    // `store.reorder` moves the row as it is, while the legacy roster writer
    // rebuilds each row from the fields it loaded.
    raw.accounts[1] = { ...raw.accounts[1], futureField: { kept: true } }
    // A row the store reads as invalid keeps its position; the legacy roster
    // writer could not load it and appended it after the others.
    raw.accounts.splice(2, 0, { id: 'broken', type: 'mystery' })
    writeFileSync(files.configFile, JSON.stringify(raw))
    const rowsBefore = new Map(
      raw.accounts.map((row) => [row.id, JSON.stringify(row)]),
    )
    const entriesBefore = JSON.stringify(config().commonAuthPool)
    const stateBefore = readFileSync(files.stateFile, 'utf8')

    const done = await buildDialogPayload(
      'openai-account',
      'order main fallback-2',
      commandContext(),
    )

    expect(done.text).toContain('Accounts Reordered')
    const after = (
      readJson(files.configFile) as {
        accounts: Array<Record<string, unknown>>
      }
    ).accounts
    expect(after.map((row) => row.id)).toEqual([
      'fallback-2',
      'fallback-1',
      'broken',
      'main',
    ])
    for (const row of after)
      expect(JSON.stringify(row)).toBe(rowsBefore.get(row.id) as string)
    expect(JSON.stringify(config().commonAuthPool)).toBe(entriesBefore)
    expect(readFileSync(files.stateFile, 'utf8')).toBe(stateBefore)
  })

  it('order waits for the legacy main-refresh lock and completes once it is released', async () => {
    const before = readFileSync(files.configFile, 'utf8')
    const lock = await acquireRefreshFileLock({
      name: MAIN_REFRESH_LOCK_NAME,
      ttlMs: 60_000,
      path: files.configFile,
    })
    if (!lock) throw new Error('legacy lock not taken')
    let settled = false
    const pending = buildDialogPayload(
      'openai-account',
      'order fallback-1 main',
      commandContext(),
    ).finally(() => {
      settled = true
    })
    try {
      await sleep(400)
      expect(settled).toBe(false)
      expect(readFileSync(files.configFile, 'utf8')).toBe(before)
    } finally {
      await lock.release()
    }

    expect((await pending).text).toContain('Accounts Reordered')
    expect(config().accounts.map((row) => row.id)).toEqual([
      'fallback-1',
      'main',
    ])
  })

  // The order changes no row's credential, so it holds `main-refresh` only and
  // never waits on a row's fallback refresh lock.
  it('order does not wait for a row fallback refresh lock', async () => {
    const lock = await acquireRefreshFileLock({
      name: fallbackLock,
      ttlMs: 60_000,
      path: files.configFile,
    })
    if (!lock) throw new Error('legacy lock not taken')
    try {
      const done = await Promise.race([
        buildDialogPayload(
          'openai-account',
          'order fallback-1 main',
          commandContext(),
        ),
        sleep(2_000).then(() => undefined),
      ])
      expect(done?.text).toContain('Accounts Reordered')
      expect(config().accounts.map((row) => row.id)).toEqual([
        'fallback-1',
        'main',
      ])
    } finally {
      await lock.release()
    }
  })

  it('/openai-killswitch keys thresholds by row id and leaves row main to `main`', async () => {
    await buildDialogPayload(
      'openai-killswitch',
      'set all:50,60',
      commandContext(),
    )
    const accounts = config().killswitch?.accounts ?? {}
    expect(Object.keys(accounts)).toEqual(['fallback-1'])
  })
})

describe('/openai-account on a legacy install', () => {
  it('keeps the legacy account list when the host offers a pool', async () => {
    writeFileSync(
      files.configFile,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            enabled: true,
            addedAt: 1,
            access: 'a',
            refresh: 'r',
            expires: Date.now() + HOUR,
          },
        ],
      }),
    )
    const payload = await buildDialogPayload(
      'openai-account',
      'remove main',
      commandContext(),
    )
    // A legacy install has no pool rows, so the legacy remove handles the
    // request and finds no account `main` in its roster.
    expect(payload.text).toContain('Account Not Found')
  })
})

// ---------------------------------------------------------------------------
// Cachekeep and reset credits
// ---------------------------------------------------------------------------

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
    installWire()
    hooks = await loadPlugin({}, slot)
    const managers = (
      globalThis as {
        __openaiAuthCacheKeepManagers?: Map<string, unknown>
      }
    ).__openaiAuthCacheKeepManagers
    const manager = [...(managers?.values() ?? [])].at(-1) as
      | {
          getMainToken: () => Promise<string>
          refreshFallback: (id: string) => Promise<{ token: string }>
        }
      | undefined
    if (!manager) throw new Error('no cachekeep manager')

    expect(await manager.getMainToken()).toBe('main-token')
    expect((await manager.refreshFallback('fallback-1')).token).toBe(
      'fallback-1-token',
    )
  })

  it('/openai-reset previews main with row main token, never the slot', async () => {
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    hooks = await loadPlugin({}, slot)
    await waitFor(
      () => (wire.polls.length >= 1 ? true : undefined),
      'the first pool poll',
    )
    await sleep(100)
    const before = wire.polls.length

    await runCommand('openai-reset')

    const previews = wire.polls.slice(before)
    expect(previews).toContain('Bearer main-token')
    expect(previews).not.toContain('Bearer slot-token')
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

describe('the auth menu on a migrated install', () => {
  type MenuAction = 'add-account' | 'delete-all' | 'check-quotas'

  // Every call the menu makes to the legacy roster writer. On a migrated
  // install the store is the roster's only writer, so this stays empty.
  let legacyRosterWrites: unknown[]
  beforeEach(() => {
    legacyRosterWrites = []
  })

  function methods(
    action: MenuAction,
    loginAccount = login('menu-acct', 'chatgpt-menu'),
  ) {
    return createAuthMethods({
      client: { auth: { set: async () => undefined } } as never,
      getAuth: async () => ({ type: 'oauth', refresh: 'x' }) as never,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => action,
        confirm: async () => true,
        openBrowser: async () => true,
        mutateAccounts: (async (...args: Parameters<typeof mutateAccounts>) => {
          legacyRosterWrites.push(args)
          return mutateAccounts(...args)
        }) as typeof mutateAccounts,
        beginAccountLogin: (async () => ({
          url: 'https://auth.example/login',
          instructions: 'Sign in.',
          completion: Promise.resolve(loginAccount),
        })) as never,
      },
    })
  }

  async function runMenu(action: MenuAction) {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const method = methods(action)[0]
      if (method?.type !== 'oauth') throw new Error('no oauth method')
      await method.authorize({})
      return log.mock.calls.flat().map(String).join('\n')
    } finally {
      log.mockRestore()
    }
  }

  it('add-account writes a pool row', async () => {
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const output = await runMenu('add-account')
    expect(legacyRosterWrites).toEqual([])
    expect(output).toContain('Added account menu-acct.')
    expect(config().accounts.map((row) => row.id)).toEqual([
      'main',
      'menu-acct',
    ])
    expect(config().commonAuthPool.rows['menu-acct']).toBeDefined()
    expect(stateAccounts()['menu-acct']?.access).toBe('menu-acct-access')
  })

  it('check-quotas polls every pool row into the pool, refreshing nothing', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
    ])
    const wire = installWire({
      usage: () => new Response(usageBody(66), { status: 200 }),
    })
    const output = await runMenu('check-quotas')
    expect(output).toContain('main: quota refreshed')
    expect(output).toContain('fallback-1: quota refreshed')
    expect(poolPrimaryUsed('main')).toBe(66)
    expect(poolPrimaryUsed('fallback-1')).toBe(66)
    expect(wire.refreshTokens).toEqual([])
  })

  it('delete-all removes every row except main, and says so', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
      { id: 'fallback-2', quota: quotaMap(10) },
    ])
    const output = await runMenu('delete-all')
    expect(legacyRosterWrites).toEqual([])
    expect(output).toContain('Deleted 2 account(s).')
    expect(output).toContain('Kept `main`')
    expect(config().accounts.map((row) => row.id)).toEqual(['main'])
    expect(Object.keys(stateAccounts())).toEqual(['main'])
  })

  it('delete-all keeps main and a row a pending transfer names, and removes the rest through the store', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
      { id: 'fallback-2', quota: quotaMap(10) },
      { id: 'fallback-3', quota: quotaMap(10) },
    ])
    const raw = readJson(files.configFile) as {
      accounts: Array<Record<string, unknown>>
      openaiAuthPool: Record<string, unknown>
    }
    raw.openaiAuthPool = {
      ...raw.openaiAuthPool,
      pending: {
        rowId: 'fallback-2',
        operation: 'rotate',
        rowFingerprint: null,
        slotFingerprint: 'slot-fingerprint',
        credentialFingerprint: 'credential-fingerprint',
        carryLegacyMain: false,
        recordedAt: 1,
      },
    }
    // A row the store reads as invalid is a row like any other here: it goes.
    // An entry with no id is no row of the pool, so it stays as it is.
    raw.accounts.push({ id: 'broken', type: 'mystery' }, { label: 'no id' })
    writeFileSync(files.configFile, JSON.stringify(raw))

    const output = await runMenu('delete-all')

    expect(legacyRosterWrites).toEqual([])
    expect(output).toContain('Deleted 3 account(s).')
    expect(output).toContain('Kept `main`, the account OpenCode signs in with.')
    expect(output).toContain('Kept `fallback-2`. The account-pool migration')
    const roster = (
      readJson(files.configFile) as { accounts: Array<{ id?: string }> }
    ).accounts
    expect(roster.map((row) => row.id ?? null)).toEqual([
      'main',
      'fallback-2',
      null,
    ])
    expect(Object.keys(stateAccounts())).toEqual(['main', 'fallback-2'])
    // `store.remove` drops a removed row's pool entry with its roster row; the
    // legacy roster writer left the entries behind.
    expect(Object.keys(config().commonAuthPool.rows)).toEqual([
      'main',
      'fallback-2',
    ])
  })

  it('delete-all waits for a row legacy fallback refresh lock before removing it', async () => {
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'fallback-1', quota: quotaMap(10) },
    ])
    const before = readFileSync(files.configFile, 'utf8')
    const lock = await acquireRefreshFileLock({
      name: fallbackRefreshLockName('fallback-1'),
      ttlMs: 60_000,
      path: files.configFile,
    })
    if (!lock) throw new Error('legacy lock not taken')
    let settled = false
    const pending = runMenu('delete-all').finally(() => {
      settled = true
    })
    try {
      await sleep(400)
      expect(settled).toBe(false)
      expect(readFileSync(files.configFile, 'utf8')).toBe(before)
    } finally {
      await lock.release()
    }
    expect(await pending).toContain('Deleted 1 account(s).')
    expect(config().accounts.map((row) => row.id)).toEqual(['main'])
  })
})
