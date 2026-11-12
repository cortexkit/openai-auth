import { afterEach, beforeEach, describe, expect, spyOn } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { BuiltinSettingsPort } from '@cortexkit/common-auth/commands'
import {
  FallbackAccountManager,
  loadAccounts,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import { SettingsAuthorityRefusal } from '@cortexkit/openai-auth-core/settings-authority'
import { getSettingsDecision } from '@cortexkit/openai-auth-core/settings-decisions'
import { resolveDefaultSettingsStores } from '@cortexkit/openai-auth-core/settings-install'
import { SETTINGS_ADOPTING_VERSION } from '@cortexkit/openai-auth-core/settings-process-records'
import * as snapshots from '@cortexkit/openai-auth-core/settings-snapshot'
import type { PluginInput } from '@opencode-ai/plugin'
import { SettingsFs } from '../../node_modules/@cortexkit/common-auth/dist/settings/fs.js'
import type { OpenCodeMenuContext } from '../commands'
import * as configReader from '../config'
import {
  __resetRuntimeLayoutsForTest,
  getAccountPaths,
  runtimeLayoutLocation,
} from '../core/account-paths'
import * as cachekeep from '../core/cachekeep'
import * as heartbeat from '../core/process-heartbeat'
import {
  __menuContextForTest,
  CodexAuthPlugin,
  createResetTargetResolver,
  OpenAIAuthPlugin,
} from '../index'
import { flushForTest, setLogLevel } from '../logger'
import { createRequestTestScope } from './request-test-scope'
import { unsetEnv } from './setup-env'

const scope = createRequestTestScope()
const { it } = scope
const envKeys = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_OPENAI_AUTH_FILE',
  'OPENCODE_OPENAI_AUTH_STATE_FILE',
  'OPENCODE_OPENAI_AUTH_SETTINGS_FILE',
  'OPENCODE_OPENAI_AUTH_LOG_FILE',
  'OPENCODE_OPENAI_AUTH_LOG_LEVEL',
  'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE',
] as const
let savedEnv: Record<string, string | undefined>
let folder: string
let config: string
let target: string
let root: string
let originalFetch: typeof fetch
let wire: string[]
let urls: string[]
let liveSnapshot: snapshots.SettingsSnapshot
let refreshes: number
const restores: Array<() => void> = []

beforeEach(async () => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  await mkdir(scratch, { recursive: true })
  folder = await mkdtemp(join(scratch, 'settings-opencode-v1-'))
  process.env.HOME = folder
  process.env.USERPROFILE = folder
  process.env.APPDATA = join(folder, 'config')
  process.env.XDG_CONFIG_HOME = join(folder, 'config')
  process.env.XDG_STATE_HOME = join(folder, 'state')
  process.env.XDG_DATA_HOME = join(folder, 'data')
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(folder, 'test.log')
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    folder,
    'sidebar.json',
  )
  config = join(folder, 'config', 'opencode', 'openai-auth.json')
  target = join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')
  root = join(folder, 'state', 'cortexkit', 'openai-auth')
  heartbeat.__resetProcessHeartbeatForTest()
  __resetRuntimeLayoutsForTest()
  configReader.resetSettingsForTest()
  setLogLevel(undefined)
  scope.capturePluginWork({ vaultPolls: true })
  // Hold the watcher back: explicit menu refreshes, not filesystem events,
  // must make this process's next request see its own preference edit.
  const create = snapshots.createSettingsSnapshot
  const snapshotSpy = spyOn(
    snapshots,
    'createSettingsSnapshot',
  ).mockImplementation(async (options) => {
    liveSnapshot = await create({
      ...options,
      handle: { ...options.handle, watch: () => () => {} },
    })
    return liveSnapshot
  })
  restores.push(() => snapshotSpy.mockRestore())
  originalFetch = globalThis.fetch
  wire = []
  urls = []
  refreshes = 0
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/oauth/token')) {
        refreshes++
        return Response.json({
          access_token: 'renewed',
          refresh_token: 'renewed-r',
          expires_in: 86400,
        })
      }
      if (url.includes('/responses')) {
        urls.push(url)
        wire.push(new Headers(init?.headers).get('authorization') ?? '')
        return Response.json({ output: [] })
      }
      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18000,
            reset_at: Math.floor(Date.now() / 1000) + 7200,
          },
        },
      })
    },
    { preconnect() {} },
  ) as typeof fetch
})

afterEach(async () => {
  await scope.teardown(async () => {
    for (const restore of restores.splice(0)) restore()
    await flushForTest()
    globalThis.fetch = originalFetch
    setLogLevel(undefined)
    configReader.resetSettingsForTest()
    heartbeat.__resetProcessHeartbeatForTest()
    __resetRuntimeLayoutsForTest()
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await rm(folder, { recursive: true, force: true })
  })
})

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

function input(): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    },
    project: { id: 'settings', name: 'settings' },
    directory: '',
    worktree: folder,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost:0'),
    $: {},
  } as unknown as PluginInput
}

async function start() {
  return scope.ownPlugin(
    await CodexAuthPlugin(input(), {
      experimentalWebSockets: false,
      poolMigration: { enabled: false },
      vault: {
        stateDir: join(folder, 'vault'),
        connectionFile: () => join(folder, 'no-daemon.json'),
        pollIntervalMs: 0,
      },
    }),
  )
}

const auth = () => ({
  type: 'oauth',
  access: 'main-access',
  refresh: 'main-refresh',
  expires: Date.now() + 86400_000,
})

async function loader(hooks: Awaited<ReturnType<typeof start>>) {
  const loaded = await hooks.auth!.loader!(
    auth as never,
    { id: 'openai', models: {} } as never,
  )
  return scope.wrap(
    (loaded as { fetch: (url: string, init: RequestInit) => Promise<Response> })
      .fetch,
  )
}

function context() {
  const ctx = __menuContextForTest()
  expect(ctx).not.toBeNull()
  return ctx as OpenCodeMenuContext & {
    configPath?: string
    settings?: BuiltinSettingsPort
    settingsSnapshot?: snapshots.SettingsSnapshot
  }
}

function request(send: Awaited<ReturnType<typeof loader>>) {
  return send('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [{ role: 'user', content: 'hello' }],
    }),
  })
}

async function seed(extra = {}) {
  await put(config, {
    version: 1,
    accounts: [
      {
        id: 'fallback',
        type: 'oauth',
        enabled: true,
        access: 'fallback-access',
        refresh: 'fallback-refresh',
        expires: Date.now() + 86400_000,
      },
    ],
    quota: { enabled: false },
    refresh: { enabled: false },
    ...extra,
  })
}

describe('OpenCode 1 settings authority wiring', () => {
  it('decides and registers before the public entry reads any preference', async () => {
    await seed({
      rawWebSocket: true,
      codexApiEndpoint: 'https://obsolete.invalid',
    })
    await put(target, {
      raw_web_socket: false,
      codex_api_endpoint: 'https://shared.invalid',
    })
    const get = configReader.getSettings
    const reads = spyOn(configReader, 'getSettings').mockImplementation(
      (path) => {
        expect(getSettingsDecision(config)).toBe('shared')
        return get(path)
      },
    )
    restores.push(() => reads.mockRestore())
    const hooks = scope.ownPlugin(await OpenAIAuthPlugin(input()))
    expect(reads).toHaveBeenCalled()
    expect(configReader.getSettings(config).codexApiEndpoint).toBe(
      'https://shared.invalid',
    )
    expect(
      configReader.getResolvedSettingsView(null, config).routing?.mode,
    ).toBe('main-first')
    await hooks.dispose?.()
    expect(configReader.getSettings(config).codexApiEndpoint).not.toBe(
      'https://shared.invalid',
    )
  })

  it('refuses at the plugin entry before hooks, providers, menus or preferences exist', async () => {
    await seed()
    await put(join(root, 'pi-processes', `${process.ppid}.json`), {
      pid: process.ppid,
      version: SETTINGS_ADOPTING_VERSION,
      settings: 'legacy',
    })
    const record = spyOn(heartbeat, 'recordProcessSettings').mockRejectedValue(
      new Error('record denied'),
    )
    const reads = spyOn(configReader, 'getSettings')
    restores.push(
      () => record.mockRestore(),
      () => reads.mockRestore(),
    )
    let error: unknown
    try {
      await start()
    } catch (cause) {
      error = cause
    }
    expect(error).toBeInstanceOf(SettingsAuthorityRefusal)
    expect((error as Error).message).toContain(root)
    expect((error as Error).message).toContain('record denied')
    expect(reads).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(false)
  })

  it.each([false, true])(
    'fresh start with fence closed=%s creates no shared file or source',
    async (closed) => {
      if (closed)
        await put(join(root, 'pi-processes', `${process.ppid}.json`), {
          pid: process.ppid,
          version: SETTINGS_ADOPTING_VERSION,
          settings: 'legacy',
        })
      await start()
      expect(getSettingsDecision(config)).toBe('shared')
      expect(existsSync(target)).toBe(false)
      expect(existsSync(config)).toBe(false)
      expect(configReader.getResolvedSettingsView(null, config)).toMatchObject({
        routing: { mode: 'main-first' },
        killswitch: { enabled: false },
      })
      expect(
        JSON.parse(readFileSync(heartbeat.processHeartbeatPath(), 'utf8'))
          .settings,
      ).toBe('shared')
    },
  )

  it('a fresh OpenCode beside Pi moves Pi preferences, then never moves again', async () => {
    const pi = resolveDefaultSettingsStores()[1]
    await put(pi.configPath, {
      version: 1,
      accounts: [],
      routing: { mode: 'sticky-balanced' },
    })
    const hooks = await start()
    expect(existsSync(target)).toBe(true)
    expect(
      configReader.getResolvedSettingsView(null, config).routing?.mode,
    ).toBe('sticky-balanced')
    const bytes = readFileSync(target, 'utf8')
    await hooks.dispose?.()
    await put(pi.configPath, {
      version: 1,
      accounts: [],
      routing: { mode: 'ordered' },
    })
    await start()
    expect(readFileSync(target, 'utf8')).toBe(bytes)
    expect(
      configReader.getResolvedSettingsView(null, config).routing?.mode,
    ).toBe('sticky-balanced')
  })
})

describe('OpenCode 1 preference readers', () => {
  it('passes this config and the shared port to the menu; the next request sees its edit without a watcher or settings read', async () => {
    await seed({ routing: { mode: 'ordered' }, fallbackOn: [500] })
    await put(target, {
      routing_mode: 'main-first',
      refresh_enabled: false,
      quota_enabled: false,
    })
    const send = await loader(await start())
    const ctx = context()
    expect(ctx.configPath).toBe(config)
    expect(ctx.settings).toBeDefined()
    expect(ctx.settingsSnapshot).toBeDefined()
    const disk = spyOn(SettingsFs, 'readFile')
    try {
      expect((await request(send)).status).toBe(200)
      expect(wire.at(-1)).toBe('Bearer main-access')
      expect(disk).not.toHaveBeenCalled()
      await ctx.settings!.update((settings) => {
        settings.routing = { mode: 'fallback-first' }
      })
      disk.mockClear()
      expect((await request(send)).status).toBe(200)
      expect(wire.at(-1)).toBe('Bearer fallback-access')
      expect(disk).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(config, 'utf8')).routing.mode).toBe(
        'ordered',
      )
      expect(JSON.parse(readFileSync(config, 'utf8')).fallbackOn).toEqual([500])
    } finally {
      disk.mockRestore()
    }
  })

  it('pins loader-time cache and entry-time transport while ignoring the main preemptive-refresh preference', async () => {
    await seed({
      cacheKeep: { enabled: true, subagents: true, sustain: true },
      killswitch: { enabled: true },
      costZeroing: { enabled: false },
    })
    await put(target, {
      codex_api_endpoint: 'https://entry.invalid/responses',
      web_sockets: false,
      cache_keep_enabled: false,
      refresh_enabled: false,
      quota_enabled: false,
    })
    const hooks = await start()
    await put(target, {
      codex_api_endpoint: 'https://later.invalid/responses',
      web_sockets: false,
      cache_keep_enabled: true,
      cache_keep_subagents: true,
      refresh_enabled: false,
      quota_enabled: false,
    })
    // A reload before the loader may change loader-time preferences, but it
    // must not change the already captured transport/endpoint for this entry.
    await liveSnapshot.refresh()
    const capture = spyOn(cachekeep, 'buildKeepwarmCapture')
    restores.push(() => capture.mockRestore())
    const send = await loader(hooks)
    const ctx = context()
    expect(
      configReader.getResolvedSettingsView(null, config).cacheKeep?.enabled,
    ).toBe(true)
    const response = await request(send)
    expect(response.status).toBe(200)
    expect(configReader.getSettings(config).codexApiEndpoint).toBe(
      'https://entry.invalid/responses',
    )
    expect(urls.at(-1)).toBe('https://entry.invalid/responses')
    expect(capture.mock.calls.at(-1)?.[0].includeSubagents).toBe(true)
    await put(target, {
      cache_keep_subagents: false,
      refresh_before_expiry_minutes: 100000,
      quota_enabled: false,
    })
    await liveSnapshot.refresh()
    await request(send)
    expect(capture.mock.calls.at(-1)?.[0].includeSubagents).toBe(true)
    ctx.setCacheKeepSubagents!(false)
    await request(send)
    expect(capture.mock.calls.at(-1)?.[0].includeSubagents).toBe(false)
    expect(refreshes).toBe(0)
    expect(
      configReader.getResolvedSettingsView(null, config).killswitch?.enabled,
    ).toBe(false)
    expect(
      configReader.getResolvedSettingsView(null, config).costZeroing?.enabled,
    ).toBe(true)
  })

  it.each(['shared', 'legacy'] as const)(
    'background loads use the %s refresh window',
    async (decision) => {
      await seed({
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 240 },
      })
      const source = JSON.parse(readFileSync(config, 'utf8'))
      source.accounts[0].expires = Date.now() + 3600_000
      await put(config, source)
      if (decision === 'shared')
        await put(target, {
          refresh_enabled: true,
          refresh_before_expiry_minutes: 5,
          quota_enabled: false,
        })
      else
        await put(join(root, 'pi-processes', `${process.ppid}.json`), {
          pid: process.ppid,
          version: SETTINGS_ADOPTING_VERSION,
          settings: 'legacy',
        })
      let manager: FallbackAccountManager | undefined
      const background = spyOn(
        FallbackAccountManager.prototype,
        'startBackgroundRefresh',
      ).mockImplementation(function (this: FallbackAccountManager) {
        manager = this
      })
      restores.push(() => background.mockRestore())
      await loader(await start())
      expect(manager).toBeDefined()
      expect((await manager!.load())?.refresh?.refreshBeforeExpiryMinutes).toBe(
        decision === 'shared' ? 5 : 240,
      )
      await manager!.refreshDueAccounts()
      expect(refreshes).toBe(decision === 'shared' ? 0 : 1)
    },
  )

  it('keeps loader state writes in the old config without changing any old preference', async () => {
    await seed({
      routing: { mode: 'ordered' },
      refresh: { enabled: false, refreshBeforeExpiryMinutes: 240 },
      fallbackOn: [429, 1.5],
    })
    await put(target, {
      routing_mode: 'main-first',
      refresh_enabled: true,
      refresh_before_expiry_minutes: 5,
      quota_enabled: false,
    })
    const hooks = await start()
    const claims = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'live-main-id' },
      }),
    ).toString('base64url')
    await hooks.auth!.loader!(
      (() => ({ ...auth(), access: `header.${claims}.signature` })) as never,
      { id: 'openai', models: {} } as never,
    )
    const old = JSON.parse(readFileSync(config, 'utf8'))
    expect(old.mainAccountId).toBe('live-main-id')
    expect(old.routing).toEqual({ mode: 'ordered' })
    expect(old.refresh).toEqual({
      enabled: false,
      refreshBeforeExpiryMinutes: 240,
    })
    expect(old.fallbackOn).toEqual([429, 1.5])
    expect(JSON.parse(readFileSync(target, 'utf8')).routing_mode).toBe(
      'main-first',
    )
  })

  it('preserves every missing-store branch while the resolved settings view remains non-null', async () => {
    await put(target, {
      cost_zeroing: false,
      routing_mode: 'fallback-first',
      refresh_before_expiry_minutes: 5,
      web_sockets: false,
    })
    const hooks = await start()
    expect(await loadAccounts(getAccountPaths())).toBeNull()
    const model = {
      id: 'gpt-5.4',
      api: { id: 'gpt-5.4' },
      options: {},
      cost: { input: 5, output: 10 },
    }
    const result = await hooks.provider!.models!(
      { models: { 'gpt-5.4': model } } as never,
      { auth: { type: 'oauth' } } as never,
    )
    expect(result['gpt-5.4']?.cost.input).toBe(0)
    expect(await loadAccounts(getAccountPaths())).toBeNull()
    const refresh = spyOn(
      {
        async run() {
          return auth()
        },
      },
      'run',
    )
    const reset = createResetTargetResolver({
      getAuth: async () => ({ ...auth(), expires: Date.now() + 600_000 }),
      refreshMainWithLease: refresh,
      refreshFallbackAccount: async (account) => account,
      loadAccounts: async () => null,
      accountStoragePath: config,
      accountStatePath: getAccountPaths().statePath,
      now: Date.now,
    })
    expect((await reset('main')).accessToken).toBe('main-access')
    expect(refresh).not.toHaveBeenCalled()
    // Enrolling without local files drives the settings-only display/request
    // readers, whose null loads must not manufacture a credential store.
    await hooks.dispose?.()
    const vaultFolder = join(folder, 'vault')
    await put(vaultPaths(vaultFolder, 'opencode').tokenPath, {
      token: '01'.repeat(32),
      token_generation: 1,
    })
    const send = await loader(await start())
    expect((await request(send)).status).toBe(401)
    await context().refreshSidebar!()
    expect(
      JSON.parse(readFileSync(join(folder, 'sidebar.json'), 'utf8')).route,
    ).toBe('fallback-first')
    expect(configReader.getResolvedSettingsView(null, config)).not.toBeNull()
    expect(existsSync(config)).toBe(false)
    expect(existsSync(getAccountPaths().statePath)).toBe(false)
  })
})

describe('OpenCode 1 legacy and move boundaries', () => {
  it.each(['fence', 'failed', 'separate'] as const)(
    'a %s decision stays on the old store for this process',
    async (kind) => {
      if (kind === 'separate') {
        process.env.OPENCODE_CONFIG_DIR = join(folder, 'isolated')
        config = join(folder, 'isolated', 'openai-auth.json')
      }
      await seed({
        routing: { mode: 'ordered' },
        ...(kind === 'failed'
          ? { quota: { checkIntervalMinutes: 'abc' } }
          : {}),
      })
      const blocker = join(root, 'pi-processes', `${process.ppid}.json`)
      if (kind === 'fence')
        await put(blocker, {
          pid: process.ppid,
          version: SETTINGS_ADOPTING_VERSION,
          settings: 'legacy',
        })
      await start()
      expect(getSettingsDecision(config)).toBe(
        kind === 'separate' ? 'separate' : 'legacy',
      )
      if (kind === 'fence') await rm(blocker)
      await put(config, {
        version: 1,
        accounts: [],
        routing: { mode: 'fallback-first' },
      })
      await start()
      expect(
        configReader.getResolvedSettingsView(
          await loadAccounts(getAccountPaths()),
          config,
        ).routing?.mode,
      ).toBe('fallback-first')
      expect(existsSync(target)).toBe(false)
      const send = await loader(await start())
      expect(context().configPath).toBe(config)
      expect(context().settings).toBeUndefined()
      expect((await request(send)).status).toBe(200)
      if (kind === 'failed') {
        await flushForTest()
        const lines = readFileSync(
          process.env.OPENCODE_OPENAI_AUTH_LOG_FILE!,
          'utf8',
        )
          .split('\n')
          .filter((line) =>
            line.includes(
              'Settings move failed: cannot move setting quota_check_interval_minutes',
            ),
          )
        expect(lines.length).toBe(1)
      }
    },
  )

  it.each(['opencode', 'pi'] as const)(
    'with both stores present, a key only in %s keeps OpenCode effective values',
    async (owner) => {
      await put(config, {
        version: 1,
        accounts: [],
        ...(owner === 'opencode'
          ? { routing: { mode: 'sticky-balanced' } }
          : {}),
      })
      await put(resolveDefaultSettingsStores()[1].configPath, {
        version: 1,
        accounts: [],
        ...(owner === 'pi' ? { routing: { mode: 'sticky-balanced' } } : {}),
      })
      await start()
      expect(
        configReader.getResolvedSettingsView(null, config).routing?.mode,
      ).toBe(owner === 'opencode' ? 'sticky-balanced' : 'main-first')
    },
  )

  it('an empty isolated folder leaves both default stores and the shared target untouched', async () => {
    await seed({ routing: { mode: 'ordered' } })
    await put(resolveDefaultSettingsStores()[1].configPath, {
      version: 1,
      accounts: [],
      routing: { mode: 'sticky-balanced' },
    })
    await put(target, { routing_mode: 'fallback-first' })
    const paths = [config, resolveDefaultSettingsStores()[1].configPath, target]
    const bytes = paths.map((path) => readFileSync(path, 'utf8'))
    process.env.OPENCODE_CONFIG_DIR = join(folder, 'isolated')
    await start()
    expect(getSettingsDecision(getAccountPaths().configPath)).toBe('separate')
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(bytes)
    expect(existsSync(getAccountPaths().configPath)).toBe(false)
  })

  it.each(['shared-first', 'separate-first'] as const)(
    'mixed instances keep their own config authority and state paths: %s',
    async (order) => {
      const sharedConfig = config
      const separateFolder = join(folder, 'separate')
      const separateConfig = join(separateFolder, 'openai-auth.json')
      await seed({ routing: { mode: 'ordered' } })
      await put(target, {
        routing_mode: 'main-first',
        quota_enabled: false,
        refresh_enabled: false,
      })
      const shared = async () => {
        unsetEnv('OPENCODE_CONFIG_DIR')
        config = sharedConfig
        return start()
      }
      const separate = async () => {
        process.env.OPENCODE_CONFIG_DIR = separateFolder
        config = separateConfig
        await seed({ routing: { mode: 'fallback-first' } })
        return start()
      }
      const [sharedHooks, separateHooks] =
        order === 'shared-first'
          ? [await shared(), await separate()]
          : await (async () => {
              const own = await separate()
              return [await shared(), own]
            })()
      const sharedSend = await loader(sharedHooks!)
      const sharedContext = context()
      expect(sharedContext.configPath).toBe(sharedConfig)
      expect(sharedContext.settings).toBeDefined()
      const separateSend = await loader(separateHooks!)
      expect(context().configPath).toBe(separateConfig)
      expect(context().settings).toBeUndefined()
      await request(sharedSend)
      expect(wire.at(-1)).toBe('Bearer main-access')
      await request(separateSend)
      expect(wire.at(-1)).toBe('Bearer fallback-access')
      await sharedContext.settings!.update((settings) => {
        settings.routing = { mode: 'fallback-first' }
      })
      await request(sharedSend)
      expect(wire.at(-1)).toBe('Bearer fallback-access')
      expect(JSON.parse(readFileSync(sharedConfig, 'utf8')).routing.mode).toBe(
        'ordered',
      )
      expect(
        JSON.parse(readFileSync(separateConfig, 'utf8')).routing.mode,
      ).toBe('fallback-first')
    },
  )
})

describe('OpenCode default settings-store parity', () => {
  it.each(['none', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const)(
    'core matches host paths with %s and with or without a layout marker',
    async (env) => {
      unsetEnv('XDG_CONFIG_HOME')
      unsetEnv('XDG_STATE_HOME')
      if (env === 'XDG_CONFIG_HOME')
        process.env.XDG_CONFIG_HOME = join(folder, 'alternate-config')
      if (env === 'XDG_STATE_HOME')
        process.env.XDG_STATE_HOME = join(folder, 'alternate-state')
      for (const marker of [false, true]) {
        if (marker)
          await put(join(runtimeLayoutLocation().stateHomeDir, 'layout.json'), {
            version: 1,
          })
        const { host, ...core } = resolveDefaultSettingsStores()[0]
        expect(host).toBe('opencode')
        expect(core).toEqual(getAccountPaths())
      }
    },
  )
})
