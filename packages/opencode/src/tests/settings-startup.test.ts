import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { SettingsAuthorityRefusal } from '@cortexkit/openai-auth-core/settings-authority'
import { SETTINGS_ADOPTING_VERSION } from '@cortexkit/openai-auth-core/settings-process-records'
import type { SettingsSnapshot } from '@cortexkit/openai-auth-core/settings-snapshot'
import { SettingsFs } from '../../node_modules/@cortexkit/common-auth/dist/settings/fs.js'
import { getAccountPaths } from '../core/account-paths.ts'
import * as heartbeat from '../core/process-heartbeat.ts'
import {
  prepareSettingsStartup,
  type SettingsStartup,
} from '../core/settings-startup.ts'
import {
  createLogger,
  flushForTest,
  type Level,
  setLogLevel,
} from '../logger.ts'

const log = { warn() {}, info() {} }
const version = SETTINGS_ADOPTING_VERSION
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
] as const
let savedEnv: Record<string, string | undefined>
let folder: string
let config: string
let target: string
let root: string
const snapshots: SettingsSnapshot[] = []

beforeEach(async () => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  await mkdir(scratch, { recursive: true })
  folder = await mkdtemp(join(scratch, 'opencode-settings-startup-'))
  process.env.HOME = folder
  process.env.USERPROFILE = folder
  process.env.APPDATA = join(folder, 'config')
  process.env.XDG_CONFIG_HOME = join(folder, 'config')
  process.env.XDG_STATE_HOME = join(folder, 'state')
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(folder, 'test.log')
  config = join(folder, 'config', 'opencode', 'openai-auth.json')
  target = join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')
  root = join(folder, 'state', 'cortexkit', 'openai-auth')
  heartbeat.__resetProcessHeartbeatForTest()
  setLogLevel(undefined)
})

afterEach(async () => {
  for (const snapshot of snapshots.splice(0)) snapshot.dispose()
  await flushForTest()
  setLogLevel(undefined)
  heartbeat.__resetProcessHeartbeatForTest()
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await rm(folder, { recursive: true, force: true })
})

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function start(): Promise<SettingsStartup> {
  const result = await prepareSettingsStartup({ version, log })
  if (result.snapshot) snapshots.push(result.snapshot)
  return result
}

function shared(result: SettingsStartup) {
  expect(result.authority.decision).toBe('shared')
  if (!result.handle || !result.snapshot) throw new Error('No shared snapshot')
  return { handle: result.handle, snapshot: result.snapshot }
}

async function levels(label: string): Promise<Level[]> {
  const logger = createLogger('settings-startup-test')
  const names = ['error', 'warn', 'info', 'debug', 'trace'] as const
  for (const name of names) logger[name](`${label}-${name}`)
  await flushForTest()
  const text = readFileSync(process.env.OPENCODE_OPENAI_AUTH_LOG_FILE!, 'utf8')
  return names.filter((name) => text.includes(`${label}-${name}`))
}

describe('OpenCode settings startup', () => {
  it('moves at startup, records through the heartbeat and snapshots the shared values', async () => {
    const source = { version: 1, accounts: [], logging: { level: 'warn' } }
    await put(config, source)
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'trace'
    const result = await start()
    const { snapshot } = shared(result)
    expect(result.authority.ranMove).toBe(true)
    expect(result.authority.move?.outcome).toBe('moved')
    expect(snapshot.get('log_level')).toBe('warn')
    expect(snapshot.view().logging?.level).toBe('warn')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual(source)
    expect(existsSync(`${config}.MOVED_READPLEASE`)).toBe(true)
    expect(
      JSON.parse(readFileSync(heartbeat.processHeartbeatPath(), 'utf8')),
    ).toMatchObject({
      pid: process.pid,
      version,
      settings: 'shared',
    })
    expect(await levels('moved')).toEqual(['error', 'warn'])
  })

  it('reuses one decision and record for concurrent and later plugin instances', async () => {
    await put(config, {
      version: 1,
      accounts: [],
      routing: { mode: 'ordered' },
    })
    const record = spyOn(heartbeat, 'recordProcessSettings')
    try {
      const [first, second] = await Promise.all([start(), start()])
      expect(first.authority).toBe(second.authority)
      expect(first.snapshot).not.toBe(second.snapshot)
      const later = await start()
      expect(later.authority).toBe(first.authority)
      expect(record).toHaveBeenCalledTimes(1)
      expect(shared(later).snapshot.get('routing_mode')).toBe('ordered')
    } finally {
      record.mockRestore()
    }
  })

  it('uses the host config and state overrides rather than resolving store paths itself', async () => {
    const ownConfig = join(folder, 'custom', 'account.json')
    const ownState = join(folder, 'other', 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = `  ${ownConfig}  `
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = `  ${ownState}  `
    process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = target
    await put(ownConfig, {
      version: 1,
      accounts: [],
      logging: { level: 'debug' },
    })
    const result = await start()
    expect(result.authority.install.configIdentity).toBe(ownConfig)
    expect(result.authority.install.sources).toEqual([
      { host: 'opencode', ...getAccountPaths() },
    ])
    expect(result.authority.install.sources[0]?.statePath).toBe(ownState)
    expect(shared(result).snapshot.get('log_level')).toBe('debug')
  })

  it('does not create a shared file or account store on a fresh start; the first edit can', async () => {
    const result = await start()
    const { handle, snapshot } = shared(result)
    expect(result.authority.ranMove).toBe(false)
    expect(snapshot.get('log_level')).toBe('default')
    expect(snapshot.view()).not.toBeNull()
    expect(existsSync(target)).toBe(false)
    expect(existsSync(config)).toBe(false)
    await handle.update([{ setting: 'log_level', value: 'warn' }], {
      host: 'opencode',
    })
    await snapshot.refresh()
    expect(existsSync(target)).toBe(true)
    expect(existsSync(config)).toBe(false)
    expect(await levels('first-edit')).toEqual(['error', 'warn'])
  })

  it("keeps requests memory-only and applies this instance's edit without waiting for watch", async () => {
    await put(target, { log_level: 'info' })
    const { handle, snapshot } = shared(await start())
    const disk = spyOn(SettingsFs, 'readFile')
    try {
      for (let request = 0; request < 20; request++) {
        expect(snapshot.view().logging?.level).toBe('info')
        expect(snapshot.get('log_level')).toBe('info')
      }
      expect(disk).not.toHaveBeenCalled()
      await handle.update([{ setting: 'log_level', value: 'trace' }], {
        host: 'opencode',
      })
      await snapshot.refresh()
      expect(await levels('own-edit')).toEqual([
        'error',
        'warn',
        'info',
        'debug',
        'trace',
      ])
    } finally {
      disk.mockRestore()
    }
  })

  it('opens no shared handle for a separate config even with a shared file present', async () => {
    process.env.OPENCODE_CONFIG_DIR = join(folder, 'separate')
    await put(target, { log_level: 'trace' })
    setLogLevel('error')
    const disk = spyOn(SettingsFs, 'readFile')
    try {
      const result = await start()
      expect(result.authority.decision).toBe('separate')
      expect(result.authority.install.configIdentity).toBe(
        join(folder, 'separate', 'openai-auth.json'),
      )
      expect(result.handle).toBeUndefined()
      expect(result.snapshot).toBeUndefined()
      expect(disk).not.toHaveBeenCalled()
      expect(await levels('separate')).toEqual(['error'])
    } finally {
      disk.mockRestore()
    }
  })

  it('retains a legacy decision after the fence opens and makes no later move', async () => {
    await put(config, { version: 1, accounts: [], logging: { level: 'warn' } })
    // A different pid's live record is supplied by the parent process.
    const parentRecord = join(root, 'pi-processes', `${process.ppid}.json`)
    await put(parentRecord, { pid: process.ppid, version, settings: 'legacy' })
    setLogLevel('warn')
    const first = await start()
    expect(first.authority.decision).toBe('legacy')
    expect(first.authority.ranMove).toBe(false)
    expect(first.snapshot).toBeUndefined()
    expect(first.handle).toBeUndefined()
    await rm(parentRecord)
    await put(config, { version: 1, accounts: [], logging: { level: 'trace' } })
    const later = await start()
    expect(later.authority).toBe(first.authority)
    expect(later.snapshot).toBeUndefined()
    expect(existsSync(target)).toBe(false)
    expect(await levels('legacy-edit')).toEqual(['error', 'warn'])
    expect(
      JSON.parse(readFileSync(heartbeat.processHeartbeatPath(), 'utf8'))
        .settings,
    ).toBe('legacy')
  })

  it('opens no shared handle after a failed move', async () => {
    await mkdir(dirname(config), { recursive: true })
    await writeFile(config, 'not JSON')
    const result = await start()
    expect(result.authority.decision).toBe('legacy')
    expect(result.authority.move?.outcome).toBe('failed')
    expect(result.handle).toBeUndefined()
    expect(result.snapshot).toBeUndefined()
    expect(existsSync(target)).toBe(false)
  })

  it('throws a refusal naming the records folder and cause before opening shared settings', async () => {
    await put(config, { version: 1, accounts: [] })
    await put(root, 'not a folder')
    const disk = spyOn(SettingsFs, 'readFile')
    try {
      let refusal: unknown
      try {
        await start()
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(SettingsAuthorityRefusal)
      const error = refusal as SettingsAuthorityRefusal
      expect(error.folder).toBe(root)
      expect(error.cause).toBeInstanceOf(Error)
      expect(error.message).toContain(root)
      expect(error.message).toContain((error.cause as Error).message)
      expect(disk).not.toHaveBeenCalled()
      expect(existsSync(target)).toBe(false)
      await expect(start()).rejects.toBe(refusal)
    } finally {
      disk.mockRestore()
    }
  })

  it.each(['fresh', 'completed'])(
    'does not refuse a %s install when records cannot be made',
    async (kind) => {
      if (kind === 'completed') {
        await put(config, {
          version: 1,
          accounts: [],
          logging: { level: 'error' },
        })
        await put(target, { log_level: 'debug' })
      }
      await put(root, 'not a folder')
      const result = await start()
      expect(shared(result).snapshot.get('log_level')).toBe(
        kind === 'fresh' ? 'default' : 'debug',
      )
      expect(result.authority.ranMove).toBe(false)
    },
  )
})

describe('shared startup log level', () => {
  it.each(['absent', 'default'])(
    'makes no level call at startup for %s',
    async (kind) => {
      process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'trace'
      await put(target, kind === 'default' ? { log_level: 'default' } : {})
      // A startup with no saved level must not reset an existing live override.
      setLogLevel('error')
      const { snapshot } = shared(await start())
      expect(snapshot.get('log_level')).toBe('default')
      expect(await levels(`startup-${kind}`)).toEqual(['error'])
    },
  )

  it.each(['error', 'warn', 'info', 'debug', 'trace'] as const)(
    'saved %s overrides the environment at startup',
    async (level) => {
      process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL =
        level === 'trace' ? 'error' : 'trace'
      await put(target, { log_level: level })
      shared(await start())
      const order = ['error', 'warn', 'info', 'debug', 'trace'] as const
      expect(await levels(`saved-${level}`)).toEqual(
        order.slice(0, order.indexOf(level) + 1),
      )
    },
  )

  for (const env of ['trace', undefined] as const) {
    for (const edit of ['removed', 'default'] as const) {
      it(`restores ${env ?? 'info'} after an external ${edit} level, on the watch callback`, async () => {
        if (env) process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = env
        await put(target, { log_level: 'info' })
        const { snapshot } = shared(await start())
        expect(await levels('before-external')).toEqual([
          'error',
          'warn',
          'info',
        ])
        const changed = new Promise<void>((resolve) => {
          snapshot.onChange(() => {
            if (snapshot.get('log_level') === 'default') resolve()
          })
        })
        await put(target, edit === 'removed' ? {} : { log_level: 'default' })
        await changed
        expect(await levels('after-external')).toEqual(
          env === 'trace'
            ? ['error', 'warn', 'info', 'debug', 'trace']
            : ['error', 'warn', 'info'],
        )
      })
    }
  }

  it.each(['trace', undefined] as const)(
    'a default watch refresh replaces a menu override with environment %s',
    async (env) => {
      if (env) process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = env
      await put(target, { log_level: 'default' })
      const { snapshot } = shared(await start())
      setLogLevel('error')
      const changed = new Promise<void>((resolve) => {
        snapshot.onChange(() => {
          if (snapshot.get('request_dumps')) resolve()
        })
      })
      await put(target, { log_level: 'default', request_dumps: true })
      await changed
      expect(await levels('menu-override-reset')).toEqual(
        env === 'trace'
          ? ['error', 'warn', 'info', 'debug', 'trace']
          : ['error', 'warn', 'info'],
      )
    },
  )

  it('applies an external concrete level to each shared instance on its watch callback', async () => {
    await put(target, { log_level: 'info' })
    const first = shared(await start())
    const second = shared(await start())
    const callbacks = [first, second].map(
      ({ snapshot }) =>
        new Promise<void>((resolve) => {
          snapshot.onChange(() => {
            if (snapshot.get('log_level') === 'debug') resolve()
          })
        }),
    )
    await put(target, { log_level: 'debug' })
    await Promise.all(callbacks)
    expect(await levels('two-watches')).toEqual([
      'error',
      'warn',
      'info',
      'debug',
    ])
  })
})
