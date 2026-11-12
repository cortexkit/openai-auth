import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  recordPiProcessSettings,
  SETTINGS_ADOPTING_VERSION,
} from '@cortexkit/openai-auth-core/settings-process-records'
import {
  __resetProcessHeartbeatForTest,
  recordProcessLayout,
  recordProcessSettings,
  startProcessHeartbeat,
} from '../core/process-heartbeat'
import { migrationFenceOpen } from '../core/version-fence'

const PID = 11
const NOW = 1_900_000_000_000
let root: string
let dir: string
let path: string
let warnings: string[]

beforeEach(() => {
  __resetProcessHeartbeatForTest()
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  mkdirSync(scratch, { recursive: true })
  root = mkdtempSync(join(scratch, 'settings-heartbeat-'))
  dir = join(root, 'cortexkit', 'openai-auth', 'processes')
  path = join(dir, `${PID}.json`)
  warnings = []
})
afterEach(() => {
  __resetProcessHeartbeatForTest()
  rmSync(root, { recursive: true, force: true })
})

function read() {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function decide(config: string, settings: 'legacy' | 'shared' | 'separate') {
  return recordProcessSettings({
    configPath: join(root, config),
    settings,
    version: SETTINGS_ADOPTING_VERSION,
    dir,
    pid: PID,
    now: () => NOW,
  })
}

function start() {
  return startProcessHeartbeat({
    version: SETTINGS_ADOPTING_VERSION,
    logger: { warn: (message) => warnings.push(message) },
    dir,
    pid: PID,
    now: () => NOW + 1,
  })
}

describe('settings in OpenCode heartbeats', () => {
  it('leaves settings absent before a decision and carries it on every later write', async () => {
    await recordProcessLayout({
      key: 'config',
      layout: 'legacy',
      version: SETTINGS_ADOPTING_VERSION,
      dir,
      pid: PID,
      now: () => NOW,
    })
    expect(read()).not.toHaveProperty('settings')
    await decide('config.json', 'shared')
    expect(read()).toMatchObject({
      pid: PID,
      version: SETTINGS_ADOPTING_VERSION,
      startedAt: NOW,
      settings: 'shared',
      layouts: { config: 'legacy' },
    })
    const handle = await start()
    expect(read().settings).toBe('shared')
    await recordProcessLayout({
      key: 'other',
      layout: 'legacy',
      version: SETTINGS_ADOPTING_VERSION,
      dir,
      pid: PID,
    })
    expect(read().settings).toBe('shared')
    await handle.release()
  })

  it.each([
    ['shared', 'separate'],
    ['separate', 'shared'],
  ] as const)(
    'records mixed instances as shared in order %s then %s',
    async (first, second) => {
      await decide('first.json', first)
      await decide('second.json', second)
      expect(read().settings).toBe('shared')
      expect(readdirSync(dir)).toEqual([`${PID}.json`])
    },
  )

  it('records separate only when every config decision is separate', async () => {
    await decide('a.json', 'separate')
    await decide('b.json', 'separate')
    expect(read().settings).toBe('separate')
  })

  it.each([
    ['legacy', 'shared', 'separate'],
    ['separate', 'shared', 'legacy'],
  ] as const)(
    'legacy wins all other config decisions in order %s, %s, %s',
    async (first, second, third) => {
      await decide('first.json', first)
      await decide('second.json', second)
      await decide('third.json', third)
      expect(read().settings).toBe('legacy')
    },
  )

  it('keeps the first decision for a canonical config identity', async () => {
    await decide('a.json', 'legacy')
    await decide('nested/../a.json', 'shared')
    expect(read().settings).toBe('legacy')
  })

  it('keeps a legacy-settings heartbeat after its last owner releases it', async () => {
    await decide('a.json', 'legacy')
    const handle = await start()
    await handle.release()
    await handle.release()
    expect(existsSync(path)).toBe(true)
    expect(read().settings).toBe('legacy')
  })

  it.each(['shared', 'separate'] as const)(
    'removes a %s heartbeat only after its last owner releases it',
    async (settings) => {
      await decide('a.json', settings)
      const first = await start()
      const second = await start()
      await first.release()
      expect(existsSync(path)).toBe(true)
      await second.release()
      expect(existsSync(path)).toBe(false)
    },
  )

  it('does not lose legacy settings to concurrent heartbeat and layout writes', async () => {
    const [handle] = await Promise.all([
      start(),
      decide('a.json', 'legacy'),
      decide('b.json', 'shared'),
      recordProcessLayout({
        key: 'config',
        layout: 'legacy',
        version: SETTINGS_ADOPTING_VERSION,
        dir,
        pid: PID,
      }),
    ])
    expect(read().settings).toBe('legacy')
    await handle.release()
    expect(read().settings).toBe('legacy')
  })

  it('orders last-owner disposal before a concurrent legacy decision', async () => {
    const handle = await start()
    await Promise.all([handle.release(), decide('a.json', 'legacy')])
    expect(existsSync(path)).toBe(true)
    expect(read().settings).toBe('legacy')
  })

  it('shares settings choices and write order across separately loaded bundle copies', async () => {
    const copy = await import(
      `../core/process-heartbeat.ts?settings-copy=${crypto.randomUUID()}`
    )
    await decide('a.json', 'shared')
    await copy.recordProcessSettings({
      configPath: join(root, 'b.json'),
      settings: 'legacy',
      version: SETTINGS_ADOPTING_VERSION,
      dir,
      pid: PID,
      now: () => NOW,
    })
    const handle = await start()
    expect(read().settings).toBe('legacy')
    await handle.release()
    expect(existsSync(path)).toBe(true)
  })

  it('reports decision-write failures instead of logging and continuing', async () => {
    mkdirSync(join(dir, `${PID}.json`), { recursive: true })
    await expect(decide('a.json', 'legacy')).rejects.toThrow()
    expect(warnings).toEqual([])
    expect(readdirSync(dir)).toEqual([`${PID}.json`])
  })

  it('reports records-folder failure even without a heartbeat owner', async () => {
    mkdirSync(join(root, 'cortexkit', 'openai-auth'), { recursive: true })
    writeFileSync(dir, '{}')
    await expect(decide('a.json', 'legacy')).rejects.toThrow()
    expect(warnings).toEqual([])
  })

  it('still logs an ordinary best-effort heartbeat failure', async () => {
    mkdirSync(join(root, 'cortexkit', 'openai-auth'), { recursive: true })
    writeFileSync(dir, '{}')
    const handle = await start()
    expect(handle.path).toBeUndefined()
    expect(warnings).toEqual(['process heartbeat not written'])
    await handle.release()
  })
})

describe('released version-fence reader compatibility', () => {
  it.each(['shared', 'legacy', 'separate'] as const)(
    'reads an extra settings:%s field without closing pool or layout fences',
    async (settings) => {
      await recordProcessLayout({
        key: 'config',
        layout: 'state-home',
        version: SETTINGS_ADOPTING_VERSION,
        dir,
        pid: PID,
      })
      await decide('a.json', settings)
      for (const layoutMove of [false, true]) {
        expect(
          await migrationFenceOpen({
            stateHome: root,
            currentVersion: SETTINGS_ADOPTING_VERSION,
            selfPid: 1000,
            isAlive: (pid) => pid === PID,
            now: () => NOW + 1000,
            uptime: () => 3600,
            layoutMove,
          }),
        ).toEqual({ open: true })
      }
    },
  )

  it('does not scan Pi records for either the pool-migration or layout fence', async () => {
    await recordPiProcessSettings({
      configPath: join(root, 'pi.json'),
      settings: 'legacy',
      version: '0.0.1',
      stateHome: root,
      pid: PID,
      now: () => NOW,
    })
    for (const layoutMove of [false, true]) {
      expect(
        await migrationFenceOpen({
          stateHome: root,
          currentVersion: SETTINGS_ADOPTING_VERSION,
          selfPid: 1000,
          isAlive: (pid) => pid === PID,
          now: () => NOW + 1000,
          uptime: () => 3600,
          layoutMove,
        }),
      ).toEqual({ open: true })
    }
  })
})
