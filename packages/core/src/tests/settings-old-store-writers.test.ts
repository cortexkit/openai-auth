import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type AccountPaths,
  type AccountStorage,
  acquireSaveAccountsLock,
  loadAccountSettings,
  loadAccounts,
  mutateAccounts,
  saveAccountState,
  saveAccounts,
} from '../accounts.ts'
import { recordSettingsDecision } from '../settings-decisions.ts'

let root: string
beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  mkdirSync(scratch, { recursive: true })
  root = mkdtempSync(join(scratch, 'old-store-writers-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function paths(host = 'opencode'): AccountPaths {
  return {
    configPath: join(root, `${host}-openai-auth.json`),
    statePath: join(root, `${host}-openai-auth-state.json`),
  }
}

function read(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const oldPreferences = {
  routing: { mode: 'ordered', maxSameAccountWait: 0 },
  fallbackOn: [429, 1.5],
  refresh: { enabled: false, refreshBeforeExpiryMinutes: '300' },
  quota: {
    enabled: false,
    checkIntervalMinutes: 0.5,
    refreshEveryNRequests: 7,
    minimumRemaining: { '5h': '20', '1w': null },
    failClosedOnUnknownQuota: 'true',
  },
  dump: true,
  costZeroing: null,
  killswitch: {
    enabled: 'yes',
    main: { '5h': '20', '1w': null },
    accounts: { local: { primary: -2, secondary: 101 } },
  },
  logging: { level: 'trace' },
  cachekeep: { enabled: true, subagents: true, startHour: '8', endHour: 20 },
  cacheKeep: { enabled: false, sustain: true },
  dumpDir: 'old-dumps',
  dumpMaxBytes: 123,
  webSockets: true,
  rawWebSocket: true,
  responsesLite: true,
  codexApiEndpoint: 'https://old.example/responses',
}

function seed(pair: AccountPaths, preferences: Record<string, unknown> = {}) {
  writeFileSync(
    pair.configPath,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
      ...preferences,
      commonAuthPool: { migrated: true },
      claustrum: { mode: 'retired' },
    }),
  )
}

function sharedView(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts: [],
    routing: { mode: 'sticky-balanced', maxSameAccountWait: 'max' },
    fallbackOn: [401, 403],
    refresh: { enabled: true, refreshBeforeExpiryMinutes: 10 },
    quota: {
      enabled: true,
      checkIntervalMinutes: 3,
      refreshEveryNRequests: 2,
      minimumRemaining: { primary: 90, secondary: 80 },
      failClosedOnUnknownQuota: false,
    },
    dump: { enabled: false },
    costZeroing: { enabled: true },
    killswitch: {
      enabled: false,
      schema: 'floors-v1',
      defaults: { primary: 50, secondary: 60 },
    },
    logging: { level: 'error' },
    cachekeep: { enabled: false },
    cacheKeep: { enabled: true, sustain: false, startHour: 1, endHour: 2 },
  }
}

const writers = {
  saveAccounts: async (storage: AccountStorage, pair: AccountPaths) => {
    await saveAccounts(storage, pair)
  },
  mutateAccounts: async (storage: AccountStorage, pair: AccountPaths) => {
    await mutateAccounts((current) => ({ ...current, ...storage }), pair)
  },
}

for (const [name, write] of Object.entries(writers)) {
  test(`${name} preserves every raw preference from its shared config read`, async () => {
    const pair = paths()
    seed(pair, oldPreferences)
    recordSettingsDecision(pair.configPath, 'shared')
    await write(sharedView(), pair)
    const actual = read(pair.configPath)
    for (const [key, value] of Object.entries(oldPreferences)) {
      expect(actual[key]).toEqual(value)
    }
    expect(actual).not.toHaveProperty('claustrum')
  })

  test(`${name} uses its locked read rather than an earlier normalized snapshot`, async () => {
    const pair = paths()
    seed(pair, oldPreferences)
    const snapshot = await loadAccounts(pair)
    expect(snapshot?.fallbackOn).toEqual([429])
    expect(snapshot).not.toBeNull()
    recordSettingsDecision(pair.configPath, 'shared')
    const changed = {
      ...oldPreferences,
      fallbackOn: [403, 2.5],
      routing: { mode: 'fallback-first', maxSameAccountWait: 15 },
    }
    seed(pair, changed)
    await write(snapshot!, pair)
    const actual = read(pair.configPath)
    for (const [key, value] of Object.entries(changed)) {
      expect(actual[key]).toEqual(value)
    }
  })

  test(`${name} never inserts absent preferences from an AccountStorage view`, async () => {
    const pair = paths()
    seed(pair)
    recordSettingsDecision(pair.configPath, 'shared')
    await write(sharedView(), pair)
    const actual = read(pair.configPath)
    for (const key of Object.keys(oldPreferences)) {
      expect(actual).not.toHaveProperty(key)
    }
  })

  for (const raw of [null, false, ['unusable']] as const) {
    test(`${name} preserves malformed preference blocks (${JSON.stringify(raw)})`, async () => {
      const pair = paths()
      const preferences = Object.fromEntries(
        Object.keys(oldPreferences).map((key) => [key, raw]),
      )
      seed(pair, preferences)
      recordSettingsDecision(pair.configPath, 'shared')
      await write(sharedView(), pair)
      const actual = read(pair.configPath)
      for (const key of Object.keys(preferences))
        expect(actual[key]).toEqual(raw)
    })
  }

  test(`${name} still writes roster, identity, reset, markers and main refresh state`, async () => {
    const pair = paths()
    seed(pair, oldPreferences)
    recordSettingsDecision(pair.configPath, 'shared')
    const runtime = {
      mainLastRefreshError: {
        message: 'backoff',
        checkedAt: 10,
        nextRetryAt: 20,
      },
      mainRefreshLeaseId: 'lease',
      mainRefreshLeaseUntil: 30,
      mainRefreshLeaseTokenHash: 'hash',
    }
    const storage = sharedView()
    storage.refresh = { ...storage.refresh, ...runtime }
    storage.mainAccountId = 'identity'
    storage.reset = { local: { cooldownUntil: 50 } }
    storage.accounts = [
      { id: 'local', type: 'oauth', refresh: 'token', access: 'access' },
    ]
    await write(storage, pair)
    const config = read(pair.configPath)
    expect(config.refresh).toEqual({ ...oldPreferences.refresh, ...runtime })
    expect(config.main).toEqual({ type: 'opencode', provider: 'openai' })
    expect(config.mainAccountId).toBe('identity')
    expect(config.reset).toEqual({ local: { cooldownUntil: 50 } })
    expect(config.commonAuthPool).toEqual({ migrated: true })
    expect(config.accounts).toEqual([{ id: 'local', type: 'oauth' }])
    const state = read(pair.statePath)
    expect(state.main).toEqual({
      lastRefreshError: runtime.mainLastRefreshError,
      refreshLeaseId: 'lease',
      refreshLeaseUntil: 30,
      refreshLeaseTokenHash: 'hash',
    })
    expect(state.accounts.local).toMatchObject({
      refresh: 'token',
      access: 'access',
    })

    storage.refresh = { enabled: true }
    await write(storage, pair)
    expect(read(pair.configPath).refresh).toEqual(oldPreferences.refresh)
    expect(read(pair.statePath).main).toEqual({})
  })

  for (const decision of ['legacy', 'separate', undefined] as const) {
    test(`${name} keeps today's writes for decision ${decision}`, async () => {
      const shared = paths('shared')
      seed(shared, oldPreferences)
      recordSettingsDecision(shared.configPath, 'shared')
      const pair = paths('other')
      seed(pair, oldPreferences)
      if (decision) recordSettingsDecision(pair.configPath, decision)
      const view = sharedView()
      await write(view, shared)
      await write(view, pair)
      expect(read(shared.configPath).fallbackOn).toEqual([429, 1.5])
      const actual = read(pair.configPath)
      for (const key of [
        'routing',
        'fallbackOn',
        'refresh',
        'quota',
        'dump',
        'costZeroing',
        'killswitch',
        'logging',
        'cachekeep',
        'cacheKeep',
      ] as const) {
        expect(actual[key]).toEqual(view[key])
      }
      expect(actual).not.toHaveProperty('claustrum')
    })
  }
}

test('mutateAccounts preserves the raw read before in-place preference edits', async () => {
  const pair = paths()
  seed(pair, oldPreferences)
  recordSettingsDecision(pair.configPath, 'shared')
  await mutateAccounts((current) => {
    if (current.routing) current.routing.mode = 'fallback-first'
    if (current.refresh) current.refresh.enabled = true
    if (current.quota) current.quota.minimumRemaining = { primary: 80 }
    if (current.logging) current.logging.level = 'warn'
    if (current.cachekeep) current.cachekeep.enabled = false
    if (current.cacheKeep) current.cacheKeep.enabled = true
    current.fallbackOn?.push(500)
    return current
  }, pair)
  const actual = read(pair.configPath)
  for (const [key, value] of Object.entries(oldPreferences)) {
    expect(actual[key]).toEqual(value)
  }
})

for (const decision of ['shared', 'legacy', 'separate', undefined] as const) {
  test(`missing-store loads remain null with decision ${decision}`, async () => {
    const pair = paths()
    if (decision) recordSettingsDecision(pair.configPath, decision)
    expect(await loadAccounts(pair)).toBeNull()
    expect(await loadAccountSettings(pair)).toBeNull()
    writeFileSync(pair.statePath, '{"version":1,"accounts":{}}')
    expect(await loadAccounts(pair)).toBeNull()
    expect(await loadAccountSettings(pair)).toBeNull()
  })
}

test('the exported save lock still excludes the save name on its supplied path', async () => {
  const pair = paths()
  const lock = await acquireSaveAccountsLock(pair.configPath)
  try {
    expect(
      await acquireRefreshFileLock({
        name: 'save',
        path: pair.configPath,
        ttlMs: 10_000,
      }),
    ).toBeNull()
  } finally {
    await lock.release()
  }
  const next = await acquireRefreshFileLock({
    name: 'save',
    path: pair.configPath,
    ttlMs: 10_000,
  })
  expect(next).not.toBeNull()
  await next?.release()
})

test('saveAccountState continues state writes without touching a shared config', async () => {
  const pair = paths()
  seed(pair, oldPreferences)
  recordSettingsDecision(pair.configPath, 'shared')
  const before = readFileSync(pair.configPath, 'utf8')
  await saveAccountState(
    {
      version: 1,
      accounts: [],
      refresh: { mainRefreshLeaseId: 'state-lease' },
      quota: { mainQuotaCheckedAt: 42 },
    },
    pair,
  )
  expect(readFileSync(pair.configPath, 'utf8')).toBe(before)
  expect(read(pair.statePath).main).toEqual({
    refreshLeaseId: 'state-lease',
    quotaCheckedAt: 42,
  })
})

test('all three writers acquire only their own ordered save locks', async () => {
  const pair = paths()
  seed(pair)
  // Isolate the module mock so other tests keep common-auth's real locks.
  // Recording every lock request detects an unexpected settings-authority,
  // settings-move or other host's save lock without a timeout or sleep.
  const program = `
    import { mock } from 'bun:test';
    const fs = await import('@cortexkit/common-auth/fs');
    const calls = [];
    mock.module('@cortexkit/common-auth/fs', () => ({
      ...fs,
      acquireRefreshFileLock: async (options) => {
        calls.push(['acquire', options.name, options.path, options.ttlMs, options.renew]);
        return { release: async () => { calls.push(['release', options.path]); } };
      },
      withLock: async () => { throw new Error('writer must not wait for settings locks'); },
    }));
    const a = await import(${JSON.stringify(new URL('../accounts.ts', import.meta.url).href)});
    const pair = ${JSON.stringify(pair)};
    const storage = { version: 1, accounts: [] };
    for (const decision of ['shared', 'legacy', 'separate', undefined]) {
      const current = { configPath: pair.configPath + '-' + decision, statePath: pair.statePath + '-' + decision };
      if (decision) {
        const { recordSettingsDecision } = await import(${JSON.stringify(new URL('../settings-decisions.ts', import.meta.url).href)});
        recordSettingsDecision(current.configPath, decision);
      }
      calls.push(['decision', decision ?? 'undecided']);
      await a.saveAccounts(storage, current);
      await a.mutateAccounts(x => x, current);
      await a.saveAccountState(storage, current);
    }
    console.log(JSON.stringify(calls));
  `
  const child = Bun.spawn([process.execPath, '--eval', program], {
    cwd: resolve(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const expected = []
  for (const decision of ['shared', 'legacy', 'separate', undefined]) {
    const config = `${pair.configPath}-${decision}`
    const state = `${pair.statePath}-${decision}`
    expected.push(['decision', decision ?? 'undecided'])
    for (const _writer of ['saveAccounts', 'mutateAccounts']) {
      expected.push(
        ['acquire', 'save', config, 10_000, false],
        ['acquire', 'save', state, 10_000, false],
        ['release', state],
        ['release', config],
      )
    }
    expected.push(['acquire', 'save', state, 10_000, false], ['release', state])
  }
  expect(JSON.parse(stdout)).toEqual(expected)
})
