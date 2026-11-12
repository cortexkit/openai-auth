import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'
import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
  type OAuthAccount,
} from '@cortexkit/openai-auth-core/internal'
import { recordSettingsDecision } from '@cortexkit/openai-auth-core/settings-decisions'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import { createSettingsSnapshot } from '@cortexkit/openai-auth-core/settings-snapshot'
import { SettingsFs } from '../../node_modules/@cortexkit/common-auth/dist/settings/fs.js'
import {
  DEFAULT_CODEX_API_ENDPOINT,
  DEFAULT_DUMP_MAX_BYTES,
  getResolvedSettingsView,
  getSettings,
  isRequestDumpEnabled,
  refreshSettings,
  registerSettingsSnapshot,
  resetSettingsForTest,
} from '../config'
import { PoolAccountSource } from '../core/pool-account-source'
import { resolvePoolMainAccess } from '../core/pool-main'
import {
  type PoolRequestContext,
  routableRows,
  servePoolRequest,
} from '../core/pool-request'
import { flushForTest } from '../logger'
import { type PoolRowSeed, quotaMap, seedPool } from './fixtures/pool-install'

const envKeys = [
  'OPENCODE_OPENAI_AUTH_FILE',
  'OPENCODE_OPENAI_AUTH_LOG_FILE',
  'CORTEXKIT_OPENAI_AUTH_WEBSOCKETS',
  'CORTEXKIT_OPENAI_AUTH_RAW_WS',
  'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
  'CORTEXKIT_OPENAI_AUTH_DUMP',
  'OPENCODE_OPENAI_AUTH_DUMP_DIR',
  'OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES',
  'CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT',
] as const
let saved: Record<string, string | undefined>
let folder: string
let config: string
let target: string
const cleanup: (() => void | Promise<void>)[] = []
const log = { warn() {}, info() {} }

beforeEach(async () => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  await mkdir(scratch, { recursive: true })
  folder = await mkdtemp(join(scratch, 'shared-readers-'))
  config = join(folder, 'openai-auth.json')
  target = join(folder, 'settings.jsonc')
  process.env.OPENCODE_OPENAI_AUTH_FILE = config
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(folder, 'test.log')
  resetSettingsForTest()
})

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetSettingsForTest()
  await flushForTest()
  await rm(folder, { recursive: true, force: true })
})

async function put(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value))
}

async function shared(values: Record<string, unknown> = {}, watch = false) {
  await put(target, values)
  recordSettingsDecision(config, 'shared')
  const handle = openSettings(openaiSettings, {
    file: target,
    log,
    createMissing: true,
    separateInstall: false,
  })
  if (!watch) handle.watch = () => () => {}
  const snapshot = await createSettingsSnapshot({
    handle,
    host: 'opencode',
    file: target,
  })
  const unregister = registerSettingsSnapshot(config, snapshot)
  cleanup.push(() => {
    unregister()
    snapshot.dispose()
  })
  return { snapshot, handle, unregister }
}

describe('shared OpenCode transport readers', () => {
  it('reads the snapshot rather than frozen old preferences, with no request-path file reads', async () => {
    await put(config, { dump: false, webSockets: false })
    await shared({ request_dumps: true, web_sockets: true })
    const settingsRead = spyOn(SettingsFs, 'readFile')
    const legacyRead = spyOn(fs, 'readFileSync')
    const stat = spyOn(fs, 'statSync')
    try {
      expect(getSettings().webSockets).toBe(true)
      for (let i = 0; i < 3; i++) {
        expect(isRequestDumpEnabled()).toBe(true)
        expect(getResolvedSettingsView(null)).not.toBeNull()
      }
      expect(settingsRead).not.toHaveBeenCalled()
      expect(legacyRead).not.toHaveBeenCalled()
      expect(stat).not.toHaveBeenCalled()
    } finally {
      settingsRead.mockRestore()
      legacyRead.mockRestore()
      stat.mockRestore()
    }
  })

  it('keeps every transport value start-only until explicit refresh, but dump decisions live', async () => {
    const { snapshot } = await shared({
      web_sockets: true,
      raw_web_socket: true,
      responses_lite: true,
      request_dumps: true,
      dump_dir: '/before',
      dump_max_bytes: 1234,
      codex_api_endpoint: 'https://before.example/responses',
    })
    const first = getSettings()
    expect(first).toEqual({
      webSockets: true,
      rawWebSocket: true,
      responsesLite: true,
      dump: true,
      dumpDir: '/before',
      dumpMaxBytes: 1234,
      codexApiEndpoint: 'https://before.example/responses',
    })
    await put(target, {
      web_sockets: false,
      raw_web_socket: false,
      responses_lite: false,
      request_dumps: false,
      dump_dir: '/after',
      dump_max_bytes: 4321,
      codex_api_endpoint: 'https://after.example/responses',
    })
    await snapshot.refresh()
    expect(getSettings()).toBe(first)
    expect(isRequestDumpEnabled()).toBe(false)
    expect(refreshSettings()).toEqual({
      webSockets: false,
      rawWebSocket: false,
      responsesLite: false,
      dump: false,
      dumpDir: '/after',
      dumpMaxBytes: 4321,
      codexApiEndpoint: 'https://after.example/responses',
    })
  })

  it('sees another process dump edit on the watch callback within one poll period', async () => {
    const { snapshot } = await shared({ request_dumps: false }, true)
    expect(isRequestDumpEnabled()).toBe(false)
    const changed = new Promise<void>((done) => {
      snapshot.onChange(() => {
        if (snapshot.get('request_dumps')) done()
      })
    })
    await put(target, { request_dumps: true })
    await changed
    expect(isRequestDumpEnabled()).toBe(true)
  })

  it('makes an own menu edit visible without a watcher, even with two registered instances', async () => {
    const first = await shared({ request_dumps: false })
    const secondHandle = openSettings(openaiSettings, {
      file: target,
      log,
      createMissing: true,
      separateInstall: false,
    })
    secondHandle.watch = () => () => {}
    const second = await createSettingsSnapshot({
      handle: secondHandle,
      host: 'opencode',
      file: target,
    })
    const unregister = registerSettingsSnapshot(config, second)
    cleanup.push(() => {
      unregister()
      second.dispose()
    })
    expect(getSettings().dump).toBe(false)
    await first.handle.update([{ setting: 'request_dumps', value: true }], {
      host: 'opencode',
    })
    await first.snapshot.refresh()
    expect(refreshSettings().dump).toBe(true)
    expect(isRequestDumpEnabled()).toBe(true)
    unregister()
    expect(isRequestDumpEnabled()).toBe(true)
  })

  it('keeps start-only values across instance registration and disposal while live readers keep a remaining snapshot', async () => {
    const first = await shared({ web_sockets: true, request_dumps: false })
    const startOnly = getSettings()
    const second = await shared({ web_sockets: false, request_dumps: true })
    expect(getSettings()).toBe(startOnly)
    expect(isRequestDumpEnabled()).toBe(true)
    first.unregister()
    expect(getSettings()).toBe(startOnly)
    expect(isRequestDumpEnabled()).toBe(true)
    second.unregister()
    expect(getSettings().webSockets).toBe(false)
    expect(isRequestDumpEnabled()).toBe(false)
    await shared({ request_dumps: true })
    first.unregister()
    expect(isRequestDumpEnabled()).toBe(true)
  })

  it.each([undefined, '', '   '])(
    'resolves dump directory %j to the named temporary folder',
    async (dumpDir) => {
      await shared(dumpDir === undefined ? {} : { dump_dir: dumpDir })
      expect(getSettings().dumpDir).toBe(
        join(tmpdir(), 'opencode-openai-auth-dumps'),
      )
    },
  )

  it('retains each environment override and its invalid-input handling', async () => {
    await shared({
      web_sockets: true,
      raw_web_socket: true,
      responses_lite: true,
      request_dumps: true,
      dump_dir: '/saved',
      dump_max_bytes: 4096,
      codex_api_endpoint: 'https://saved.example',
    })
    for (const key of [
      'CORTEXKIT_OPENAI_AUTH_WEBSOCKETS',
      'CORTEXKIT_OPENAI_AUTH_RAW_WS',
      'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
      'CORTEXKIT_OPENAI_AUTH_DUMP',
    ])
      process.env[key] = ' OFF '
    process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR = ' /env '
    process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES = ' 8192 '
    process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT = ' https://env.example '
    expect(refreshSettings()).toEqual({
      webSockets: false,
      rawWebSocket: false,
      responsesLite: false,
      dump: false,
      dumpDir: '/env',
      dumpMaxBytes: 8192,
      codexApiEndpoint: 'https://env.example',
    })
    expect(isRequestDumpEnabled()).toBe(false)
    for (const key of [
      'CORTEXKIT_OPENAI_AUTH_WEBSOCKETS',
      'CORTEXKIT_OPENAI_AUTH_RAW_WS',
      'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
      'CORTEXKIT_OPENAI_AUTH_DUMP',
    ])
      process.env[key] = 'unknown'
    process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR = ' '
    process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT = ' '
    for (const invalid of [
      '',
      ' ',
      '-1',
      '1.5',
      'NaN',
      'Infinity',
      '12MiB',
      '9007199254740992',
    ]) {
      process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES = invalid
      expect(refreshSettings()).toEqual({
        webSockets: true,
        rawWebSocket: true,
        responsesLite: true,
        dump: true,
        dumpDir: '/saved',
        dumpMaxBytes: DEFAULT_DUMP_MAX_BYTES,
        codexApiEndpoint: 'https://saved.example',
      })
    }
    expect(isRequestDumpEnabled()).toBe(true)
  })

  it('uses declared defaults without a registered shared snapshot, never the old store', async () => {
    await put(config, {
      webSockets: true,
      dump: true,
      dumpMaxBytes: 1,
      routing: { mode: 'fallback-first' },
      killswitch: { enabled: true },
    })
    recordSettingsDecision(config, 'shared')
    expect(getSettings()).toEqual({
      webSockets: false,
      rawWebSocket: false,
      responsesLite: false,
      dump: false,
      dumpDir: join(tmpdir(), 'opencode-openai-auth-dumps'),
      dumpMaxBytes: DEFAULT_DUMP_MAX_BYTES,
      codexApiEndpoint: DEFAULT_CODEX_API_ENDPOINT,
    })
    expect(isRequestDumpEnabled()).toBe(false)
    expect(
      getResolvedSettingsView({
        version: 1,
        accounts: [],
        killswitch: { enabled: true },
      }).killswitch?.enabled,
    ).toBe(false)
    await flushForTest()
    expect(
      fs
        .readFileSync(process.env.OPENCODE_OPENAI_AUTH_LOG_FILE!, 'utf8')
        .split('Shared settings snapshot is not registered'),
    ).toHaveLength(2)
  })

  it('defaults stay aligned with a real default snapshot, including absent stores', async () => {
    recordSettingsDecision(config, 'shared')
    const fallback = getResolvedSettingsView(null)
    const { snapshot } = await shared()
    expect(fallback).toEqual(snapshot.view(null))
    expect(getResolvedSettingsView(null)).not.toBeNull()
  })

  it.each(['shared-first', 'separate-first'])(
    'isolates memoized settings per config path (%s)',
    async (order) => {
      const separate = join(folder, 'separate.json')
      await put(separate, { webSockets: false, dump: false })
      recordSettingsDecision(separate, 'separate')
      if (order === 'separate-first')
        expect(getSettings(separate).webSockets).toBe(false)
      await shared({ web_sockets: true, request_dumps: true })
      expect(getSettings(config).webSockets).toBe(true)
      expect(getSettings(separate).webSockets).toBe(false)
      expect(isRequestDumpEnabled(config)).toBe(true)
      expect(isRequestDumpEnabled(separate)).toBe(false)
      await put(separate, { webSockets: true, dump: true })
      expect(refreshSettings(separate).webSockets).toBe(true)
      expect(getSettings(config).webSockets).toBe(true)
    },
  )

  it('keeps requests available when a settings edit is invalid or unreadable', async () => {
    const { snapshot } = await shared({
      request_dumps: true,
      killswitch_enabled: true,
      killswitch_account_floors: [
        { account: 'main', host: 'opencode', primary: 80, secondary: 80 },
      ],
    })
    await put(target, {
      request_dumps: 'invalid',
      killswitch_enabled: true,
      killswitch_account_floors: [
        { account: 'main', host: 'opencode', primary: 0 },
      ],
    })
    await snapshot.refresh()
    expect(() => isRequestDumpEnabled()).not.toThrow()
    expect(
      getKillswitchThresholdsForAccount(getResolvedSettingsView(null)),
    ).toEqual({ primary: 80, secondary: 80 })
    await writeFile(target, '{ not json')
    await snapshot.refresh()
    expect(() => refreshSettings()).not.toThrow()
    expect(
      getKillswitchThresholdsForAccount(getResolvedSettingsView(null)),
    ).toEqual({ primary: 80, secondary: 80 })
  })

  it.each(['legacy', 'separate', undefined] as const)(
    'keeps %s decisions reading the old file',
    async (decision) => {
      await put(config, { dump: { enabled: true }, webSockets: true })
      await put(target, { request_dumps: false, web_sockets: false })
      if (decision) recordSettingsDecision(config, decision)
      expect(getSettings().webSockets).toBe(true)
      expect(isRequestDumpEnabled()).toBe(true)
      await put(config, { dump: false, webSockets: false })
      expect(isRequestDumpEnabled()).toBe(false)
      expect(getSettings().webSockets).toBe(true)
      expect(refreshSettings().webSockets).toBe(false)
      const store: AccountStorage = {
        version: 1,
        accounts: [],
        routing: { mode: 'fallback-first' },
      }
      expect(getResolvedSettingsView(store)).toBe(store)
      expect(getResolvedSettingsView(null)).toEqual({
        version: 1,
        accounts: [],
      })
    },
  )
})

async function pool(
  rows: PoolRowSeed[] = [
    { id: 'main', quota: quotaMap(10) },
    { id: 'B', quota: quotaMap(10) },
  ],
) {
  const paths = { configPath: config, statePath: join(folder, 'state.json') }
  seedPool({ configFile: config, stateFile: paths.statePath }, rows, {
    routing: { mode: 'fallback-first', maxSameAccountWait: 0 },
    fallbackOn: [429],
    refresh: { refreshBeforeExpiryMinutes: 1 },
    killswitch: { enabled: false },
  })
  const refreshes: string[] = []
  const source = new PoolAccountSource({
    paths: () => paths,
    pullQuota: async () => undefined,
    refreshProvider: async (credential) => {
      refreshes.push(credential.refresh)
      return {
        access: 'refreshed',
        refresh: credential.refresh,
        expires: Date.now() + 3600_000,
      }
    },
  })
  cleanup.push(async () => {
    source.dispose()
    await source.settled()
  })
  await source.load()
  await source.settled()
  return { source, paths, refreshes }
}

function context(
  source: PoolAccountSource,
  send: PoolRequestContext['send'],
  storage: AccountStorage | null = null,
): PoolRequestContext {
  return {
    source,
    configPath: config,
    storage,
    rateLimitMarks: () => new Map(),
    mode: 'fallback-first',
    sessionId: undefined,
    body: '{}',
    replayable: true,
    now: Date.now,
    send,
    recordQuota() {},
    placePin: () => undefined,
    blocked: (_block, _quotas, cause) => new Response(cause, { status: 401 }),
    resetCredits: () => undefined,
    isAbort: () => false,
    log: { debug() {} },
  }
}

describe('shared OpenCode pool readers', () => {
  it('uses shared quota preferences in the standalone pool eligibility reader', async () => {
    const { source } = await pool([
      { id: 'main', quota: quotaMap(70) },
      { id: 'B', quota: quotaMap(70) },
    ])
    const { snapshot } = await shared({
      quota_enabled: true,
      quota_minimum_remaining: [{ window: 'primary', floor: 40 }],
    })
    expect(
      routableRows(source.peek().rows, null, Date.now()).map((row) => row.id),
    ).toEqual(['main'])
    expect(routableRows([], null, Date.now())).toEqual([])
    await put(target, { quota_enabled: false })
    await snapshot.refresh()
    expect(
      routableRows(source.peek().rows, null, Date.now()).map((row) => row.id),
    ).toEqual(['main', 'B'])
  })
  it('routes with shared mode and fallback statuses instead of old store preferences', async () => {
    const { source } = await pool()
    const { snapshot } = await shared({
      routing_mode: 'main-first',
      fallback_on: [500],
      max_same_account_wait: 'cache',
    })
    const storage: AccountStorage = JSON.parse(fs.readFileSync(config, 'utf8'))
    const sent: string[] = []
    const read = spyOn(SettingsFs, 'readFile')
    try {
      const result = await servePoolRequest(
        context(
          source,
          async (row) => {
            sent.push(row.id)
            return new Response('sent', {
              status: row.id === 'main' ? 500 : 200,
            })
          },
          storage,
        ),
      )
      expect(sent).toEqual(['main', 'B'])
      expect(result.servedId).toBe('B')
      expect(getResolvedSettingsView(storage).routing?.maxSameAccountWait).toBe(
        'max',
      )
      expect(read).not.toHaveBeenCalled()
      await put(target, { routing_mode: 'fallback-first', fallback_on: [500] })
      await snapshot.refresh()
      sent.length = 0
      await servePoolRequest(
        context(
          source,
          async (row) => {
            sent.push(row.id)
            return new Response('ok')
          },
          storage,
        ),
      )
      expect(sent).toEqual(['B'])
    } finally {
      read.mockRestore()
    }
  })

  it('applies OpenCode and both floors, with host-specific precedence and separate main entries', async () => {
    const { source } = await pool([
      { id: 'main', quota: quotaMap(70) },
      { id: 'B', quota: quotaMap(70) },
    ])
    await shared({
      routing_mode: 'main-first',
      killswitch_enabled: true,
      killswitch_account_floors: [
        { account: 'main', host: 'opencode', primary: 80, secondary: 80 },
        { account: 'main', host: 'pi', primary: 0, secondary: 0 },
        { account: 'B', host: 'opencode', primary: 40, secondary: 40 },
        {
          account: 'vault:shared',
          host: 'opencode',
          primary: 60,
          secondary: 70,
        },
        { account: 'vault:shared', host: 'both', primary: 20, secondary: 20 },
        { account: 'vault:both', host: 'both', primary: 50, secondary: 50 },
        { account: 'pi-only', host: 'pi', primary: 99, secondary: 99 },
      ],
    })
    const view = getResolvedSettingsView(null)
    expect(getKillswitchThresholdsForAccount(view)).toEqual({
      primary: 80,
      secondary: 80,
    })
    expect(getKillswitchThresholdsForAccount(view, 'B')).toEqual({
      primary: 40,
      secondary: 40,
    })
    expect(getKillswitchThresholdsForAccount(view, 'vault:shared')).toEqual({
      primary: 60,
      secondary: 70,
    })
    expect(getKillswitchThresholdsForAccount(view, 'vault:both')).toEqual({
      primary: 50,
      secondary: 50,
    })
    expect(getKillswitchThresholdsForAccount(view, 'pi-only')).toEqual({
      primary: 5,
      secondary: 10,
    })
    const sent: string[] = []
    const result = await servePoolRequest(
      context(source, async (row) => {
        sent.push(row.id)
        return new Response('ok')
      }),
    )
    expect(sent).toEqual([])
    expect(result.response.status).toBe(401)
  })

  it('reads the pool token refresh window live from shared settings while leaving backoff state in the store', async () => {
    const { source, refreshes } = await pool([
      { id: 'main', quota: quotaMap(10), expires: Date.now() + 10 * 60_000 },
      { id: 'B', quota: quotaMap(10), expires: Date.now() + 10 * 60_000 },
    ])
    const { snapshot } = await shared({ refresh_before_expiry_minutes: 20 })
    const rows = source.peek().rows
    await source.prepareTokens(rows, null, { waitForAll: true })
    // prepareTokens refreshes rows concurrently, so their order isn't fixed.
    expect([...refreshes].sort()).toEqual(['B-refresh', 'main-refresh'])
    await put(target, { refresh_before_expiry_minutes: 1 })
    await snapshot.refresh()
    refreshes.length = 0
    await source.prepareTokens(rows, null, { waitForAll: true })
    expect(refreshes).toEqual([])
  })

  it('reads the main refresh window live but retains the absent-main-store branch', async () => {
    const { snapshot } = await shared({ refresh_before_expiry_minutes: 20 })
    const now = Date.now()
    const account: OAuthAccount = {
      id: 'main',
      type: 'oauth',
      label: 'Main',
      enabled: true,
      addedAt: 1,
      access: 'token',
      refresh: 'refresh',
      expires: now + 10 * 60_000,
    }
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [account],
      refresh: { refreshBeforeExpiryMinutes: 1 },
    }
    const refreshed: string[] = []
    const deps = {
      configPath: config,
      now: () => now,
      storage,
      refreshAccount: async (row: OAuthAccount) => {
        refreshed.push(row.id)
        return row
      },
    }
    expect((await resolvePoolMainAccess(deps))?.token).toBe('token')
    expect(refreshed).toEqual(['main'])
    await put(target, { refresh_before_expiry_minutes: 1 })
    await snapshot.refresh()
    refreshed.length = 0
    expect((await resolvePoolMainAccess(deps))?.token).toBe('token')
    expect(refreshed).toEqual([])
    expect(
      await resolvePoolMainAccess({ ...deps, storage: null }),
    ).toBeUndefined()
    expect(refreshed).toEqual([])
    expect(fs.existsSync(config)).toBe(false)
    expect(getResolvedSettingsView(null)).not.toBeNull()
  })

  it.each(['shared', 'legacy', 'separate', undefined] as const)(
    'retains the missing-store request branch on %s',
    async (decision) => {
      if (decision === 'shared')
        await shared({
          routing_mode: 'sticky-balanced',
          killswitch_enabled: true,
        })
      else if (decision) recordSettingsDecision(config, decision)
      const source = new PoolAccountSource({
        paths: () => ({
          configPath: config,
          statePath: join(folder, 'state.json'),
        }),
        pullQuota: async () => undefined,
        refreshProvider: async () => {
          throw new Error('No store must mean no refresh')
        },
      })
      cleanup.push(async () => {
        source.dispose()
        await source.settled()
      })
      await source.load()
      const sent: string[] = []
      const result = await servePoolRequest(
        context(source, async (row) => {
          sent.push(row.id)
          return new Response('unexpected')
        }),
      )
      expect(await result.response.text()).toBe('no-accounts')
      expect(sent).toEqual([])
      expect(getResolvedSettingsView(null)).not.toBeNull()
      expect(fs.existsSync(config)).toBe(false)
      expect(fs.existsSync(join(folder, 'state.json'))).toBe(false)
    },
  )
})
