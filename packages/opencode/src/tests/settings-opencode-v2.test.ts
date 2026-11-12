import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as authFs from '@cortexkit/common-auth/fs'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { loadAccountSettings } from '@cortexkit/openai-auth-core/internal'
import {
  getSettingsAuthority,
  SettingsAuthorityRefusal,
} from '@cortexkit/openai-auth-core/settings-authority'
import { recordSettingsDecision } from '@cortexkit/openai-auth-core/settings-decisions'
import { SETTINGS_ADOPTING_VERSION } from '@cortexkit/openai-auth-core/settings-process-records'
import { SettingsFs } from '../../node_modules/@cortexkit/common-auth/dist/settings/fs.js'
import * as config from '../config'
import { getAccountPaths } from '../core/account-paths'
import * as heartbeat from '../core/process-heartbeat'
import * as runtimeLayout from '../core/runtime-layout'
import { createLogger, flushForTest, setLogLevel } from '../logger'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import * as cacheKeep from '../v2/cache-keep'
import { opencode1HostSlot } from '../v2/host-slot'
import * as menu from '../v2/menu'
import { type OpenAIAuthV2Options, setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  type PoolFiles,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const envKeys = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_OPENAI_AUTH_FILE',
  'OPENCODE_OPENAI_AUTH_STATE_FILE',
  'OPENCODE_OPENAI_AUTH_SETTINGS_FILE',
  'OPENCODE_OPENAI_AUTH_LOG_FILE',
  'OPENCODE_OPENAI_AUTH_LOG_LEVEL',
  'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
  'CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT',
] as const
let saved: Record<string, string | undefined>
let folder: string
let target: string
let root: string
const cleanups: Array<() => unknown> = []
const offline = Object.assign(
  async () => {
    throw new Error('offline in settings wiring tests')
  },
  { preconnect() {} },
) as typeof fetch

beforeEach(async () => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  await mkdir(scratch, { recursive: true })
  folder = await mkdtemp(join(scratch, 'settings-opencode-v2-'))
  process.env.HOME = folder
  process.env.USERPROFILE = folder
  process.env.APPDATA = join(folder, 'config')
  process.env.XDG_CONFIG_HOME = join(folder, 'config')
  process.env.XDG_STATE_HOME = join(folder, 'state')
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(folder, 'test.log')
  target = join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')
  root = join(folder, 'state', 'cortexkit', 'openai-auth')
  heartbeat.__resetProcessHeartbeatForTest()
  config.resetSettingsForTest()
  setLogLevel(undefined)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await flushForTest()
  setLogLevel(undefined)
  heartbeat.__resetProcessHeartbeatForTest()
  config.resetSettingsForTest()
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await rm(folder, { recursive: true, force: true })
})

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function filesAtDefault() {
  await runtimeLayout.prepareRuntimeLayout({
    version: SETTINGS_ADOPTING_VERSION,
  })
  const paths = getAccountPaths()
  await mkdir(dirname(paths.configPath), { recursive: true })
  await mkdir(dirname(paths.statePath), { recursive: true })
  return {
    ...poolFiles(dirname(paths.configPath)),
    ...paths,
    paths: () => paths,
  }
}

async function start(files: PoolFiles, options: OpenAIAuthV2Options = {}) {
  const host = fakeOpenCode2Host({ directory: files.dir })
  const registration = spyOn(config, 'registerSettingsSnapshot')
  cleanups.push(() => registration.mockRestore())
  const dispose = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    version: SETTINGS_ADOPTING_VERSION,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    heartbeat: false,
    poolMigration: false,
    fetch: offline,
    vault: { stateDir: join(files.dir, 'vault'), pollIntervalMs: 0 },
    ...options,
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await dispose?.()
  }
  cleanups.push(stop)
  return { host, stop, snapshot: registration.mock.calls.at(-1)?.[1] }
}

async function request(
  host: ReturnType<typeof fakeOpenCode2Host>,
  id = 'ses_1',
) {
  const draft = {
    ...scope(id),
    request: new Request('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
      body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
    }),
  }
  await host.fire('http.request', draft)
  return draft.request
}

describe('OpenCode 2 settings wiring', () => {
  it('registers the location snapshot, and passes its config identity to direct routableRows', async () => {
    const ownDir = join(folder, 'location')
    await mkdir(ownDir)
    const files = poolFiles(ownDir)
    seedPool(files, 'fallback-first', [
      { id: 'blocked', usedPercent: 10 },
      { id: 'allowed', usedPercent: 0 },
    ])
    process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = target
    // The process default has different authority. Omitting the location path
    // in routableRows would replace its quota policy with declared defaults.
    const defaultConfig = getAccountPaths().configPath
    recordSettingsDecision(defaultConfig, 'shared')
    await put(target, {
      responses_lite: true,
      routing_mode: 'ordered',
      quota_minimum_remaining: [{ window: 'primary', floor: 95 }],
    })
    const { host, stop } = await start(files)
    const authority = await getSettingsAuthority(files.configPath)
    expect(authority?.decision).toBe('shared')
    expect(authority?.install.configIdentity).toBe(files.configPath)
    expect(getSettingsAuthority(defaultConfig)).toBeUndefined()
    expect(config.getSettings(files.configPath).responsesLite).toBe(true)
    const disk = spyOn(SettingsFs, 'readFile')
    try {
      expect((await request(host)).headers.get('authorization')).toBe(
        'Bearer allowed-token',
      )
      expect(disk).not.toHaveBeenCalled()
    } finally {
      disk.mockRestore()
    }
    await stop()
    expect(
      config.getResolvedSettingsView(null, files.configPath).routing?.mode,
    ).toBe('main-first')
  })

  it('moves before the migration-off early return and disposes its registration', async () => {
    const files = await filesAtDefault()
    await put(files.configPath, {
      version: 1,
      accounts: [],
      routing: { mode: 'sticky-balanced' },
    })
    const { host, snapshot, stop } = await start(files)
    expect(snapshot?.view().routing?.mode).toBe('sticky-balanced')
    expect(host.methods).toHaveLength(0)
    expect(existsSync(target)).toBe(true)
    expect(
      JSON.parse(readFileSync(heartbeat.processHeartbeatPath(), 'utf8'))
        .settings,
    ).toBe('shared')
    await stop()
    expect(
      config.getResolvedSettingsView(null, files.configPath).routing?.mode,
    ).toBe('main-first')
  })

  it('keeps the absent-store branch while the resolved view is non-null', async () => {
    const files = await filesAtDefault()
    expect(await loadAccountSettings(files.paths())).toBeNull()
    const { host } = await start(files)
    expect(await loadAccountSettings(files.paths())).toBeNull()
    expect(
      config.getResolvedSettingsView(null, files.configPath),
    ).not.toBeNull()
    expect(host.methods).toHaveLength(0)
    expect(existsSync(files.configPath)).toBe(false)
    expect(existsSync(files.statePath)).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  for (const failure of ['folder', 'record', 'lock'] as const) {
    it(`throws from setup on a required ${failure} failure even without periodic heartbeat`, async () => {
      const files = await filesAtDefault()
      await put(files.configPath, { version: 1, accounts: [] })
      if (failure === 'folder') {
        // Fail the records folder only after layout has settled. Otherwise
        // the earlier layout step, rather than settings authority, refuses.
        const prepare = runtimeLayout.prepareRuntimeLayout
        const layout = spyOn(
          runtimeLayout,
          'prepareRuntimeLayout',
        ).mockImplementation(async (options) => {
          const result = await prepare(options)
          await rm(root, { recursive: true, force: true })
          await put(root, 'not a folder')
          return result
        })
        cleanups.push(() => layout.mockRestore())
      } else {
        await put(join(root, 'pi-processes', `${process.ppid}.json`), {
          pid: process.ppid,
          version: SETTINGS_ADOPTING_VERSION,
          settings: 'legacy',
        })
        if (failure === 'record') {
          const record = spyOn(
            heartbeat,
            'recordProcessSettings',
          ).mockRejectedValue(new Error('injected record failure'))
          cleanups.push(() => record.mockRestore())
        } else {
          const withLock = authFs.withLock
          const lock = spyOn(authFs, 'withLock').mockImplementation(
            (...args) => {
              if (args[1].name === 'settings-authority')
                return Promise.reject(new Error('injected lock timeout'))
              return withLock(...args)
            },
          )
          cleanups.push(() => lock.mockRestore())
        }
      }
      const host = fakeOpenCode2Host()
      const before = readFileSync(files.configPath, 'utf8')
      const error = await setupOpenAIAuth(host.ctx, {
        paths: files.paths,
        version: SETTINGS_ADOPTING_VERSION,
        heartbeat: false,
        poolMigration: false,
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(error).toBeInstanceOf(SettingsAuthorityRefusal)
      const refusal = error as SettingsAuthorityRefusal
      expect(refusal.message).toContain(root)
      expect(refusal.message).toContain((refusal.cause as Error).message)
      expect(host.hooks).toHaveLength(0)
      expect(host.methods).toHaveLength(0)
      expect(existsSync(target)).toBe(false)
      expect(readFileSync(files.configPath, 'utf8')).toBe(before)
    })
  }

  it('separate settings never refuse or read the shared file and retain old routing', async () => {
    const dir = join(folder, 'separate')
    await mkdir(dir)
    const files = poolFiles(dir)
    seedPool(files, 'fallback-first', [{ id: 'main' }, { id: 'fallback' }])
    await put(target, { routing_mode: 'main-first', log_level: 'trace' })
    const record = spyOn(heartbeat, 'recordProcessSettings').mockRejectedValue(
      new Error('separate record failed'),
    )
    cleanups.push(() => record.mockRestore())
    const disk = spyOn(SettingsFs, 'readFile')
    try {
      const { host } = await start(files)
      expect((await getSettingsAuthority(files.configPath))?.decision).toBe(
        'separate',
      )
      expect((await request(host)).headers.get('authorization')).toBe(
        'Bearer fallback-token',
      )
      expect(disk).not.toHaveBeenCalled()
    } finally {
      disk.mockRestore()
    }
  })

  it('a closed settings fence retains legacy routing and cache spelling', async () => {
    const files = await filesAtDefault()
    seedPool(files, 'fallback-first', [{ id: 'main' }, { id: 'fallback' }])
    const stored = JSON.parse(readFileSync(files.configPath, 'utf8'))
    stored.cachekeep = { enabled: true, subagents: true, sustain: true }
    writeFileSync(files.configPath, JSON.stringify(stored))
    await put(join(root, 'pi-processes', `${process.ppid}.json`), {
      pid: process.ppid,
      version: SETTINGS_ADOPTING_VERSION,
      settings: 'legacy',
    })
    const { host } = await start(files)
    expect((await getSettingsAuthority(files.configPath))?.decision).toBe(
      'legacy',
    )
    expect((await request(host)).headers.get('authorization')).toBe(
      'Bearer fallback-token',
    )
    expect(cacheKeep.cacheKeepSettingsOf(stored, files.configPath)).toEqual({
      enabled: true,
      subagents: true,
      sustain: true,
      window: undefined,
    })
    expect(existsSync(target)).toBe(false)
  })

  it('applies external routing, keep-warm and log changes on the snapshot watch callback', async () => {
    const files = await filesAtDefault()
    seedPool(files, 'main-first', [{ id: 'main' }, { id: 'fallback' }])
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'trace'
    await put(target, {
      routing_mode: 'fallback-first',
      log_level: 'info',
      cache_keep_enabled: true,
      cache_keep_subagents: true,
      cache_keep_sustain: true,
      cache_keep_window: [{ start_hour: 23, end_hour: 6 }],
    })
    const manager = spyOn(cacheKeep, 'acquireCacheKeep')
    cleanups.push(() => manager.mockRestore())
    const { host, snapshot } = await start(files)
    if (!snapshot) throw new Error('Shared snapshot was not registered')
    const lease = manager.mock.results[0]!.value as ReturnType<
      typeof cacheKeep.acquireCacheKeep
    >
    const configure = spyOn(lease, 'configure')
    cleanups.push(() => configure.mockRestore())
    expect(cacheKeep.cacheKeepSettingsOf(null, files.configPath)).toEqual({
      enabled: true,
      subagents: true,
      sustain: true,
      window: { startHour: 23, endHour: 6 },
    })
    const logger = createLogger('v2-settings-watch')
    logger.trace('before-watch-trace')
    await flushForTest()
    expect(
      readFileSync(process.env.OPENCODE_OPENAI_AUTH_LOG_FILE!, 'utf8'),
    ).not.toContain('before-watch-trace')
    expect((await request(host)).headers.get('authorization')).toBe(
      'Bearer fallback-token',
    )
    const changed = new Promise<void>((done) => {
      snapshot.onChange(() => {
        if (snapshot.get('routing_mode') === 'main-first') done()
      })
    })
    await put(target, {
      routing_mode: 'main-first',
      // A broken edit cannot widen the already applied background-traffic window.
      cache_keep_window: [
        { start_hour: 1, end_hour: 2 },
        { start_hour: 3, end_hour: 4 },
      ],
    })
    await changed
    expect(configure).toHaveBeenLastCalledWith({
      enabled: false,
      subagents: false,
      sustain: false,
      window: { startHour: 23, endHour: 6 },
    })
    expect(snapshot.report()).toContainEqual(
      expect.objectContaining({
        keyPath: ['cache_keep_window'],
        reason: 'invalid-value',
      }),
    )
    expect(
      (await request(host, 'after-watch')).headers.get('authorization'),
    ).toBe('Bearer main-token')
    logger.trace('after-watch-trace')
    await flushForTest()
    expect(
      readFileSync(process.env.OPENCODE_OPENAI_AUTH_LOG_FILE!, 'utf8'),
    ).toContain('after-watch-trace')
  })

  it('an unread warm window at startup has no applied hours to restrict', async () => {
    const files = await filesAtDefault()
    await put(target, {
      cache_keep_window: [{ start_hour: 6, end_hour: 6 }],
    })
    const { snapshot } = await start(files)
    expect(
      cacheKeep.cacheKeepSettingsOf(null, files.configPath).window,
    ).toBeUndefined()
    expect(snapshot?.report()).toContainEqual(
      expect.objectContaining({
        keyPath: ['cache_keep_window'],
        reason: 'invalid-value',
      }),
    )
  })

  it('passes configPath, the builtin port and the snapshot to this location menu', async () => {
    const files = await filesAtDefault()
    seedPool(files, 'main-first', [{ id: 'main' }])
    await put(target, { routing_mode: 'ordered' })
    const createMenu = spyOn(menu, 'createControlPlaneMenu')
    cleanups.push(() => createMenu.mockRestore())
    const { host, snapshot } = await start(files)
    const context = createMenu.mock.calls[0]![0]
    expect(context).toMatchObject({
      configPath: files.configPath,
      settingsSnapshot: snapshot,
    })
    expect(context).toHaveProperty('settings')
    const old = JSON.parse(readFileSync(files.configPath, 'utf8')).routing
    const client = createRpcClient(
      (await resolveRpcDir(files.dir)).dir,
      process.pid,
    )
    await client.pending(0, 'menu-session')
    await host.commands[0]!.execute({ sessionID: 'menu-session' })
    const result = await client.apply({
      command: 'openai',
      sectionId: 'routing',
      actionId: 'mode',
      sessionId: 'menu-session',
      values: { mode: 'fallback-first' },
    })
    expect(result.ok).toBe(true)
    expect(
      config.getResolvedSettingsView(null, files.configPath).routing?.mode,
    ).toBe('fallback-first')
    expect(JSON.parse(readFileSync(files.configPath, 'utf8')).routing).toEqual(
      old,
    )
    expect(JSON.parse(readFileSync(target, 'utf8')).routing_mode).toBe(
      'fallback-first',
    )
  })
})
