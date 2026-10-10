// The `/openai` command: one menu replacing the eight per-feature commands.
//
// The menu runs over a migrated install's pool store. These tests drive it
// the way the TUI's drawer does (open, then apply one action), and check
// what each action writes to the account files: settings through the store's
// `updateSettings` (the roster and the state file untouched), with the older
// setting names moved to the shared vocabulary on the way.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type {
  CommandApplyRequest,
  CommandInvocation,
} from '@cortexkit/common-auth/commands'
import {
  acquireRefreshFileLock,
  type CacheKeepManager,
  fallbackRefreshLockName,
  type IngestAccount,
  loadAccounts,
  OpenAiVault,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import type { Config, PluginInput } from '@opencode-ai/plugin'
import {
  applyOpenAiMenu,
  createOpenCodeMenu,
  type OpenCodeMenuContext,
  openOpenAiMenu,
} from '../commands'
import { getSettings, refreshSettings } from '../config'
import { MAIN_REFRESH_LOCK_NAME } from '../core/host-slot'
import { openAccountPool } from '../core/pool-accounts'
import { CodexAuthPlugin } from '../index'
import { setLogLevel } from '../logger'
import { quotaMap, readJson, seedPool } from './fixtures/pool-install'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env'

let tmpDir: string
let files: { configFile: string; stateFile: string }

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'openai-menu-'))
  files = {
    configFile: join(tmpDir, 'openai-auth.json'),
    stateFile: join(tmpDir, 'openai-auth-state.json'),
  }
  process.env.OPENCODE_OPENAI_AUTH_FILE = files.configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = files.stateFile
})

afterEach(() => {
  // The Diagnostics action sets the process-wide log level; later test
  // files read their log at the level they expect.
  setLogLevel(undefined)
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  refreshSettings()
  rmSync(tmpDir, { recursive: true, force: true })
})

function seed(settings: Record<string, unknown> = {}) {
  seedPool(
    files,
    [
      { id: 'main', quota: quotaMap(10) },
      { id: 'alpha', quota: quotaMap(40) },
    ],
    settings,
  )
}

function context(
  overrides: Partial<OpenCodeMenuContext> = {},
): OpenCodeMenuContext {
  const paths = { configPath: files.configFile, statePath: files.stateFile }
  return {
    accountStoragePath: files.configFile,
    accountStatePath: files.stateFile,
    packageVersion: 'test',
    quotaManager: new QuotaManager({
      configPath: files.configFile,
      storage: null,
    }),
    loadAccounts,
    store: () => openAccountPool(paths),
    migration: async () => ({ migrated: true }),
    // Never connected here: its status reads files only.
    vault: new OpenAiVault({
      host: 'opencode',
      stateDir: join(tmpDir, 'vault'),
      pollIntervalMs: 0,
    }),
    ...overrides,
  }
}

const notices: string[] = []
const invocation: CommandInvocation = {
  sessionId: 'session-a',
  notify: (message) => notices.push(message),
}

function apply(
  ctx: OpenCodeMenuContext,
  request: Omit<CommandApplyRequest, 'command'>,
) {
  return createOpenCodeMenu(ctx).apply(
    { command: 'openai', ...request },
    invocation,
  )
}

function config() {
  return readJson(files.configFile)
}

describe('/openai on an install that has not migrated', () => {
  test('shows one section: why, and each process holding the move back', async () => {
    seed()
    const before = readFileSync(files.configFile, 'utf8')
    const ctx = context({
      migration: async () => ({
        migrated: false,
        blockers: [
          { pid: 4242, version: '0.10.0' },
          { pid: 'unknown', version: 'unknown' },
        ],
      }),
    })

    const payload = await openOpenAiMenu(ctx, 'session-a')

    expect(payload.menu.sections.map((section) => section.id)).toEqual([
      'migration',
    ])
    const [notice] = payload.menu.sections
    expect(notice?.lines.join('\n')).toContain(
      'once every OpenCode process on this machine runs this version',
    )
    expect(notice?.items.map((item) => [item.label, item.detail])).toEqual([
      ['pid 4242', 'version 0.10.0'],
      ['processes that could not be read', 'version unknown'],
    ])

    // Nothing applies until the move: no legacy menu is kept.
    const result = await apply(ctx, {
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'fallback-first' },
    })
    expect(result.ok).toBe(false)
    expect(result.menu.sections.map((section) => section.id)).toEqual([
      'migration',
    ])
    expect(readFileSync(files.configFile, 'utf8')).toBe(before)
  })
})

describe('/openai on a migrated install', () => {
  test('opens every section in the fixed order', async () => {
    seed()
    const payload = await openOpenAiMenu(context(), 'session-a')

    expect(payload.command).toBe('openai')
    expect(payload.menu.sections.map((section) => section.id)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
      'cache',
      'diagnostics',
      'session',
      'vault',
    ])
  })

  test('no credential reaches a payload', async () => {
    seed({ killswitch: { enabled: true, main: { primary: 20 } } })
    const ctx = context()

    const opened = JSON.stringify(await openOpenAiMenu(ctx, 'session-a'))
    const applied = JSON.stringify(
      await apply(ctx, {
        sectionId: 'routing',
        actionId: 'mode',
        values: { mode: 'sticky-balanced' },
      }),
    )

    for (const text of [opened, applied]) {
      for (const secret of [
        'main-token',
        'main-refresh',
        'alpha-token',
        'alpha-refresh',
      ])
        expect(text).not.toContain(secret)
      expect(text).not.toMatch(
        /"(access|refresh|apiKey|authHeader|credential|\w*[Tt]oken)"\s*:/,
      )
    }
  })

  test('a settings write goes through the store, leaving the roster and state file alone', async () => {
    seed()
    const before = config()
    const stateBefore = readFileSync(files.stateFile, 'utf8')

    const result = await apply(context(), {
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'fallback-first' },
    })

    expect(result.ok).toBe(true)
    const after = config()
    expect((after.routing as { mode: string }).mode).toBe('fallback-first')
    expect(after.accounts).toEqual(before.accounts)
    expect(after.commonAuthPool).toEqual(before.commonAuthPool)
    expect(readFileSync(files.stateFile, 'utf8')).toBe(stateBefore)
  })

  test('a settings write waits for the store lock', async () => {
    seed()
    const held = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: 10_000,
      path: files.configFile,
    })
    expect(held).not.toBeNull()

    const pending = apply(context(), {
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'fallback-first' },
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Bun.sleep(400)
    expect(settled).toBe(false)
    expect((config().routing as { mode: string }).mode).toBe('main-first')

    await held?.release()
    expect((await pending).ok).toBe(true)
    expect((config().routing as { mode: string }).mode).toBe('fallback-first')
  })

  test('the killswitch reads older thresholds as floors and rewrites them once', async () => {
    seed({
      killswitch: {
        enabled: true,
        main: { primary: 20, '1w': 30 },
        accounts: { alpha: { '5h': 40 } },
      },
    })
    const ctx = context()

    const limits = (await openOpenAiMenu(ctx, 'session-a')).menu.sections.find(
      (section) => section.id === 'limits',
    )
    expect(limits?.items.map((item) => [item.id, item.status])).toEqual([
      ['main', '5h ≥20% · secondary ≥30%'],
      ['alpha', '5h ≥40% · secondary ≥10%'],
    ])
    // Reading changes nothing on disk.
    expect((config().killswitch as Record<string, unknown>).main).toEqual({
      primary: 20,
      '1w': 30,
    })

    const result = await apply(ctx, {
      sectionId: 'limits',
      actionId: 'killswitch',
      values: { enabled: false },
    })

    expect(result.ok).toBe(true)
    expect(config().killswitch).toEqual({
      enabled: false,
      accounts: {
        main: { primary: 20, secondary: 30 },
        alpha: { primary: 40, secondary: 10 },
      },
      // What the older block gave an account it did not name: `main`'s
      // thresholds. A row added later is judged by these.
      defaults: { primary: 20, secondary: 30 },
      schema: 'floors-v1',
    })
  })

  test('a floor set from the menu lands under killswitch.accounts', async () => {
    seed()
    const result = await apply(context(), {
      sectionId: 'limits',
      itemId: 'alpha',
      actionId: 'floors',
      values: { primary: 25, secondary: null },
    })

    expect(result.ok).toBe(true)
    // Creating the block gives every account it does not name the default
    // floors, and keeps them as the block's defaults for rows added later;
    // the floors set here stay exactly as set.
    expect(config().killswitch).toEqual({
      accounts: {
        alpha: { primary: 25 },
        main: { primary: 5, secondary: 10 },
      },
      defaults: { primary: 5, secondary: 10 },
      schema: 'floors-v1',
    })
  })

  test('turning the killswitch on with no block protects every account with the default floors', async () => {
    seed()
    const result = await apply(context(), {
      sectionId: 'limits',
      actionId: 'killswitch',
      values: { enabled: true },
    })

    expect(result.ok).toBe(true)
    expect(config().killswitch).toEqual({
      enabled: true,
      accounts: {
        main: { primary: 5, secondary: 10 },
        alpha: { primary: 5, secondary: 10 },
      },
      defaults: { primary: 5, secondary: 10 },
      schema: 'floors-v1',
    })
  })

  test('signing in again to an account a row holds replaces its credential, adding no row', async () => {
    seed()
    notices.length = 0
    const ctx = context({
      beginAccountLogin: (async () => ({
        url: 'https://auth.example/authorize',
        instructions: '',
        completion: Promise.resolve({
          id: 'alpha-again',
          type: 'oauth',
          access: 'alpha-new-token',
          refresh: 'alpha-new-refresh',
          enabled: true,
          addedAt: 1,
          lastUsed: 1,
          accountId: 'chatgpt-alpha',
        } satisfies IngestAccount),
      })) as unknown as OpenCodeMenuContext['beginAccountLogin'],
    })

    await apply(ctx, {
      sectionId: 'accounts',
      actionId: 'add',
      values: { headless: false },
    })
    for (let i = 0; i < 200 && notices.length === 0; i++) await Bun.sleep(10)

    expect(notices.at(-1)).toContain('its credential was updated')
    const rows = config().accounts as Array<{ id: string; enabled: boolean }>
    expect(rows.map((row) => [row.id, row.enabled])).toEqual([
      ['main', true],
      ['alpha', true],
    ])
    const state = readJson(files.stateFile).accounts as Record<
      string,
      { refresh?: string }
    >
    expect(state.alpha?.refresh).toBe('alpha-new-refresh')
  })

  // An older openai-auth process refreshes a roster row under the row's
  // fallback refresh lock and the slot's token under `main-refresh`; a row
  // write from the menu waits for either rather than land in the middle of
  // a refresh.
  for (const [actionId, lockLabel, lockName] of [
    ['disable', 'fallback refresh', fallbackRefreshLockName('alpha')],
    ['enable', 'fallback refresh', fallbackRefreshLockName('alpha')],
    ['remove', 'fallback refresh', fallbackRefreshLockName('alpha')],
    ['disable', 'main-refresh', MAIN_REFRESH_LOCK_NAME],
    ['enable', 'main-refresh', MAIN_REFRESH_LOCK_NAME],
    ['remove', 'main-refresh', MAIN_REFRESH_LOCK_NAME],
  ] as const) {
    test(`${actionId} waits for the legacy ${lockLabel} lock and completes once it is released`, async () => {
      seedPool(files, [
        { id: 'main', quota: quotaMap(10) },
        { id: 'alpha', quota: quotaMap(10), enabled: actionId !== 'enable' },
      ])
      const before = readFileSync(files.configFile, 'utf8')
      const lock = await acquireRefreshFileLock({
        name: lockName,
        ttlMs: 60_000,
        path: files.configFile,
      })
      if (!lock) throw new Error('legacy lock not taken')
      let settled = false
      const pending = apply(context(), {
        sectionId: 'accounts',
        itemId: 'alpha',
        actionId,
        ...(actionId === 'remove' ? { confirmed: true } : {}),
      }).finally(() => {
        settled = true
      })
      try {
        await Bun.sleep(400)
        expect(settled).toBe(false)
        expect(readFileSync(files.configFile, 'utf8')).toBe(before)
      } finally {
        await lock.release()
      }

      expect((await pending).ok).toBe(true)
      const row = (
        config().accounts as Array<{ id: string; enabled: boolean }>
      ).find((candidate) => candidate.id === 'alpha')
      if (actionId === 'remove') expect(row).toBeUndefined()
      else expect(row?.enabled).toBe(actionId === 'enable')
    })
  }

  test('the roster order waits for main-refresh only, not a row fallback refresh lock', async () => {
    seed()
    const lock = await acquireRefreshFileLock({
      name: fallbackRefreshLockName('alpha'),
      ttlMs: 60_000,
      path: files.configFile,
    })
    try {
      const result = await apply(context(), {
        sectionId: 'routing',
        actionId: 'order',
        values: { order: 'alpha, main' },
      })
      expect(result.ok).toBe(true)
      expect(
        (config().accounts as Array<{ id: string }>).map((row) => row.id),
      ).toEqual(['alpha', 'main'])
    } finally {
      await lock?.release()
    }
  })

  test('row main cannot be removed, and disabling another row goes through the store', async () => {
    seed()
    const ctx = context()

    const removal = await apply(ctx, {
      sectionId: 'accounts',
      itemId: 'main',
      actionId: 'remove',
      confirmed: true,
    })
    expect(removal.ok).toBe(false)
    expect(
      (config().accounts as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(['main', 'alpha'])

    const disabled = await apply(ctx, {
      sectionId: 'accounts',
      itemId: 'alpha',
      actionId: 'disable',
    })
    expect(disabled.ok).toBe(true)
    expect(
      (config().accounts as Array<{ id: string; enabled: boolean }>).find(
        (row) => row.id === 'alpha',
      )?.enabled,
    ).toBe(false)
  })

  test('removing an account needs the confirmation', async () => {
    seed()
    const result = await apply(context(), {
      sectionId: 'accounts',
      itemId: 'alpha',
      actionId: 'remove',
    })

    expect(result.needsConfirmation).toBe(true)
    expect(
      (config().accounts as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(['main', 'alpha'])
  })

  test('adding an account shows the sign-in URL and adds the row when the login finishes', async () => {
    seed()
    notices.length = 0
    let finish: (account: IngestAccount) => void = () => {}
    const ctx = context({
      beginAccountLogin: (async () => ({
        url: 'https://auth.example/authorize',
        instructions: 'Sign in.',
        completion: new Promise<IngestAccount>((resolve) => {
          finish = resolve
        }),
      })) as unknown as OpenCodeMenuContext['beginAccountLogin'],
    })

    const result = await apply(ctx, {
      sectionId: 'accounts',
      actionId: 'add',
      values: { label: 'work', headless: false },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('https://auth.example/authorize')

    finish({
      id: 'work',
      label: 'work',
      type: 'oauth',
      access: 'work-token',
      refresh: 'work-refresh',
      expires: Date.now() + 3600_000,
      enabled: true,
      addedAt: 1,
      lastUsed: 1,
      accountId: 'chatgpt-work',
    })
    for (let i = 0; i < 100 && notices.length === 0; i++) await Bun.sleep(10)

    expect(notices.at(-1)).toContain('Added work')
    expect(
      (config().accounts as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(['main', 'alpha', 'work'])
  })

  test("a login of the main account's ChatGPT account is not added again", async () => {
    seed()
    notices.length = 0
    const ctx = context({
      beginAccountLogin: (async () => ({
        url: 'https://auth.example/authorize',
        instructions: '',
        completion: Promise.resolve({
          id: 'again',
          type: 'oauth',
          refresh: 'again-refresh',
          enabled: true,
          addedAt: 1,
          lastUsed: 1,
          accountId: 'chatgpt-main',
        } satisfies IngestAccount),
      })) as unknown as OpenCodeMenuContext['beginAccountLogin'],
    })

    await apply(ctx, {
      sectionId: 'accounts',
      actionId: 'add',
      values: { headless: false },
    })
    for (let i = 0; i < 100 && notices.length === 0; i++) await Bun.sleep(10)

    expect(notices.at(-1)).toContain('already your main account')
    expect(
      (config().accounts as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(['main', 'alpha'])
  })

  test('a quota check reports a rejected sign-in as needing re-adding', async () => {
    seed()
    const ctx = context({
      refreshAllQuota: async () => [
        { account: 'main', ok: true },
        {
          account: 'alpha',
          ok: false,
          permanent: true,
          error: 'invalid_grant',
        },
      ],
    })

    const result = await apply(ctx, {
      sectionId: 'quota',
      actionId: 'check',
      values: { account: '*' },
    })

    expect(result.ok).toBe(false)
    expect(result.text).toContain(
      'alpha: sign-in no longer accepted — remove and add this account again',
    )
  })

  test('the Cache section moves cachekeep to cacheKeep and drives the live manager', async () => {
    seed({
      cachekeep: { enabled: false, subagents: true, startHour: 9, endHour: 18 },
    })
    const calls: string[] = []
    const manager: CacheKeepManager = {
      status: () => ({
        running: false,
        sustain: false,
        window: { startHour: 9, endHour: 18 },
        tracked: 0,
        generatedAt: 0,
        ttlMs: 300_000,
        leadMs: 75_000,
        maxIdleWarmMs: 3600_000,
        maxSubagentIdleMs: 1800_000,
        targets: [],
      }),
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      remove: () => {},
    }
    const ctx = context({
      cacheKeepManager: manager,
      setCacheKeepEnabled: (on) => calls.push(`enabled:${on}`),
      setCacheKeepSustain: (on) => calls.push(`sustain:${on}`),
      setCacheKeepWindow: (window) =>
        calls.push(
          `window:${window ? `${window.startHour}-${window.endHour}` : 'none'}`,
        ),
    })

    const on = await apply(ctx, {
      sectionId: 'cache',
      actionId: 'enabled',
      values: { enabled: true },
    })
    expect(on.ok).toBe(true)
    expect(config().cachekeep).toBeUndefined()
    expect(config().cacheKeep).toEqual({
      enabled: true,
      subagents: true,
      startHour: 9,
      endHour: 18,
    })
    expect(calls).toEqual(['enabled:true', 'start'])

    const sustain = await apply(ctx, {
      sectionId: 'cache',
      actionId: 'sustain',
      values: { sustain: true },
    })
    expect(sustain.text).toContain('cache_ttl')
    expect((config().cacheKeep as { sustain: boolean }).sustain).toBe(true)

    const invalid = await apply(ctx, {
      sectionId: 'cache',
      actionId: 'window',
      values: { window: '7-7' },
    })
    expect(invalid.ok).toBe(false)
    expect((config().cacheKeep as { startHour: number }).startHour).toBe(9)

    await apply(ctx, {
      sectionId: 'cache',
      actionId: 'window',
      values: { window: '22-6' },
    })
    expect(config().cacheKeep).toMatchObject({ startHour: 22, endHour: 6 })

    await apply(ctx, {
      sectionId: 'cache',
      actionId: 'window',
      values: { window: null },
    })
    expect(config().cacheKeep).not.toHaveProperty('startHour')
    expect(calls.slice(-3)).toEqual([
      'sustain:true',
      'window:22-6',
      'window:none',
    ])
  })

  test('Diagnostics turns request dumps on and sets the log level', async () => {
    seed()
    const ctx = context()

    const dump = await apply(ctx, {
      sectionId: 'diagnostics',
      actionId: 'dump',
      values: { enabled: true },
    })
    expect(dump.ok).toBe(true)
    expect(config().dump).toEqual({ enabled: true })
    // The running process sees it at once.
    expect(getSettings().dump).toBe(true)

    const level = await apply(ctx, {
      sectionId: 'diagnostics',
      actionId: 'logging',
      values: { level: 'debug' },
    })
    expect(level.ok).toBe(true)
    expect(config().logging).toEqual({ level: 'debug' })
  })

  test("the session section clears this session's pin only", async () => {
    seed()
    const cleared: string[] = []
    const ctx = context({
      getStickyRouting: async () => 'alpha',
      clearStickyRouting: async (sessionId) => {
        cleared.push(sessionId)
        return true
      },
    })

    const session = (await openOpenAiMenu(ctx, 'session-a')).menu.sections.find(
      (section) => section.id === 'session',
    )
    expect(session?.lines).toEqual(['Pinned to alpha'])

    const result = await apply(ctx, {
      sectionId: 'session',
      actionId: 'clear-pin',
    })
    expect(result.ok).toBe(true)
    expect(cleared).toEqual(['session-a'])
  })

  test('the Vault section says this host is not connected and offers Connect', async () => {
    seed()
    const vault = (
      await openOpenAiMenu(context(), 'session-a')
    ).menu.sections.find((section) => section.id === 'vault')
    expect(vault?.lines).toEqual([
      'Not connected',
      'OpenCode (openai-auth-opencode): not connected to the Claustrum vault.',
    ])
    expect(vault?.actions.map((action) => action.id)).toEqual(['connect'])
  })

  test('an apply from the RPC carries its own session', async () => {
    seed()
    const cleared: string[] = []
    const ctx = context({
      clearStickyRouting: async (sessionId) => {
        cleared.push(sessionId)
        return true
      },
    })

    await applyOpenAiMenu(ctx, {
      command: 'openai',
      sectionId: 'session',
      actionId: 'clear-pin',
      sessionId: 'session-b',
    })

    expect(cleared).toEqual(['session-b'])
  })
})

describe('/openai registration', () => {
  test('the config hook registers /openai and none of the per-feature commands', async () => {
    writeFileSync(
      files.configFile,
      JSON.stringify({ version: 1, accounts: [] }),
    )
    const hooks = await CodexAuthPlugin(
      {
        client: {
          auth: { set: async () => {} },
          session: { promptAsync: async () => {} },
        },
        project: { id: 'test', name: 'test' },
        directory: '',
        worktree: '/tmp/test-worktree',
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {},
      } as unknown as PluginInput,
      { experimentalWebSockets: false },
    )
    const config: Config = {
      command: { 'some-other': { template: 'some-other' } },
    }
    await hooks.config?.(config)

    expect(config.command?.['some-other']).toBeDefined()
    expect(
      Object.keys(config.command ?? {}).filter((name) =>
        name.startsWith('openai'),
      ),
    ).toEqual(['openai'])
  })
})

describe('legacy account writers', () => {
  // Every remaining caller of the legacy writer, and why it may still call
  // it. A new caller fails this test until it is either moved to the store
  // or added here with its reason.
  const ALLOWED: Record<string, string> = {
    'core/src/accounts.ts': 'the legacy store itself',
    'opencode/src/index.ts':
      'writeLoaderSettings: only on an install that has not migrated',
    'opencode/src/auth/doctor.ts':
      'repairs offered only on an install that has not migrated',
  }

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory())
        return name === 'tests' || name === 'tui-compiled' ? [] : sources(path)
      return /\.(ts|tsx)$/.test(name) ? [path] : []
    })
  }

  test('packages/opencode/src and packages/core/src call mutateAccounts only from the allowed places', () => {
    const packages = join(import.meta.dir, '..', '..', '..')
    const callers = [
      ...sources(join(packages, 'opencode', 'src')),
      ...sources(join(packages, 'core', 'src')),
    ]
      .filter((path) =>
        /\bmutateAccounts\s*\(/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(packages, path))
      .sort()

    expect(callers).toEqual(Object.keys(ALLOWED).sort())
  })
})
