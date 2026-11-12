import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as commonFs from '@cortexkit/common-auth/fs'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { moveSettingsOnce, openSettings } from '@cortexkit/common-auth/settings'
import {
  getSettingsDecision,
  recordSettingsDecision,
} from '@cortexkit/openai-auth-core/settings-decisions'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import { resolveSettingsInstall } from '@cortexkit/openai-auth-core/settings-install'
import { MAIN_REFRESH_LOCK_NAME } from '../core/host-slot.ts'
import {
  adoptHostSlotLogin,
  migrateToPool,
  POOL_MIGRATION_KEY,
  type PoolMigrationDeps,
} from '../core/pool-migration.ts'
import {
  fileSlot,
  login,
  MAIN_QUOTA,
} from './fixtures/pool-migration-harness.ts'

const log = { info() {}, warn() {} }
const envKeys = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_OPENAI_AUTH_SETTINGS_FILE',
] as const
let root: string
let savedEnv: (string | undefined)[]

beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  fs.mkdirSync(scratch, { recursive: true })
  root = fs.realpathSync.native(fs.mkdtempSync(join(scratch, 'settings-pool-')))
  savedEnv = envKeys.map((key) => process.env[key])
  process.env.HOME = join(root, 'home')
  process.env.USERPROFILE = process.env.HOME
  process.env.APPDATA = join(root, 'appdata')
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  process.env.XDG_STATE_HOME = join(root, 'state')
  delete process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE
})

afterEach(() => {
  mock.restore()
  for (const [index, key] of envKeys.entries()) {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function write(path: string, value: unknown) {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, JSON.stringify(value))
}

function fixture(separate = false) {
  const folder = separate
    ? join(root, 'separate')
    : join(root, 'config', 'opencode')
  const paths = {
    configPath: join(folder, 'openai-auth.json'),
    statePath: join(folder, 'openai-auth-state.json'),
  }
  const authPath = join(folder, 'auth.json')
  const slot = fileSlot(authPath)
  const deps = {
    paths,
    slot,
    fence: async () => ({ open: true as const }),
    log,
  }
  const target = resolveSettingsInstall({ host: 'opencode', paths }).target
  const config = () => JSON.parse(fs.readFileSync(paths.configPath, 'utf8'))
  const seed = (routing?: unknown) => {
    write(paths.configPath, {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      mainAccountId: 'acct-main',
      accounts: [],
      ...(routing === undefined ? {} : { routing }),
    })
    write(authPath, { openai: login('acct-main', 'r-main') })
  }
  return { paths, authPath, deps, target, config, seed }
}

function expectFinished(f: ReturnType<typeof fixture>, routing: unknown) {
  const config = f.config()
  expect(config.routing).toEqual(routing)
  expect(config[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
  expect(config[POOL_MIGRATION_KEY].pending).toBeUndefined()
  expect(config.mainAccountId).toBeUndefined()
}

function watchTarget(target: string) {
  const sync = spyOn(fs, 'readFileSync')
  const async = spyOn(fsPromises, 'readFile')
  const exists = spyOn(fs, 'existsSync')
  return () => {
    expect(sync.mock.calls.filter(([path]) => String(path) === target)).toEqual(
      [],
    )
    expect(
      async.mock.calls.filter(([path]) => String(path) === target),
    ).toEqual([])
    expect(
      exists.mock.calls.filter(([path]) => String(path) === target),
    ).toEqual([])
  }
}

describe('settings authority during pool migration', () => {
  for (const removed of [false, true]) {
    for (const routing of [undefined, { stickyBreakMinutes: 7 }, null]) {
      it(`shared keeps routing ${JSON.stringify(routing)} unchanged, removed=${removed}`, async () => {
        const f = fixture()
        f.seed(routing)
        write(f.target, { schema_version: 1, routing_mode: 'sticky-balanced' })
        recordSettingsDecision(f.paths.configPath, 'shared')
        if (removed) fs.unlinkSync(f.target)
        expect(await migrateToPool(f.deps)).toMatchObject({
          status: 'completed',
        })
        expectFinished(f, routing)
      })
    }
  }

  for (const decision of [undefined, 'legacy'] as const) {
    it(`an existing target skips the pin with decision ${decision}`, async () => {
      const f = fixture()
      f.seed({ stickyBreakMinutes: 7 })
      if (decision) recordSettingsDecision(f.paths.configPath, decision)
      expect(
        await migrateToPool({
          ...f.deps,
          onStep(step) {
            if (step === 'after-placeholder-write')
              write(f.target, { schema_version: 1 })
          },
        }),
      ).toMatchObject({ status: 'completed' })
      expectFinished(f, { stickyBreakMinutes: 7 })
    })
  }

  it('legacy without a target still pins in the marker write', async () => {
    const f = fixture()
    f.seed({ stickyBreakMinutes: 7 })
    recordSettingsDecision(f.paths.configPath, 'legacy')
    expect(await migrateToPool(f.deps)).toMatchObject({ status: 'completed' })
    expectFinished(f, { stickyBreakMinutes: 7, mode: 'main-first' })
  })

  for (const recorded of [false, true]) {
    it(`a separate install pins without probing the user's target, recorded=${recorded}`, async () => {
      const f = fixture(true)
      f.seed()
      write(f.target, { schema_version: 1, routing_mode: 'sticky-balanced' })
      if (recorded) recordSettingsDecision(f.paths.configPath, 'separate')
      const unread = watchTarget(f.target)
      expect(await migrateToPool(f.deps)).toMatchObject({ status: 'completed' })
      expectFinished(f, { mode: 'main-first' })
      unread()
    })
  }

  for (const sharedFirst of [false, true]) {
    it(`mixed shared and separate instances follow their own decision, sharedFirst=${sharedFirst}`, async () => {
      const shared = fixture()
      const separate = fixture(true)
      shared.seed()
      separate.seed()
      write(shared.target, {
        schema_version: 1,
        routing_mode: 'sticky-balanced',
      })
      recordSettingsDecision(shared.paths.configPath, 'shared')
      recordSettingsDecision(separate.paths.configPath, 'separate')
      const unread = watchTarget(shared.target)
      for (const f of sharedFirst ? [shared, separate] : [separate, shared]) {
        expect(await migrateToPool(f.deps)).toMatchObject({
          status: 'completed',
        })
      }
      expectFinished(shared, undefined)
      expectFinished(separate, { mode: 'main-first' })
      unread()
    })
  }

  for (const customStore of [false, true]) {
    for (const present of [false, true]) {
      it(`an absolute opt-in uses the same pin rule, customStore=${customStore}, present=${present}`, async () => {
        process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = join(
          root,
          'opt-in.jsonc',
        )
        const f = fixture(customStore)
        f.seed()
        expect(f.target).toBe(process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE)
        if (present) write(f.target, { schema_version: 1 })
        expect(await migrateToPool(f.deps)).toMatchObject({
          status: 'completed',
        })
        expectFinished(f, present ? undefined : { mode: 'main-first' })
      })
    }
  }

  it('an absolute opt-in respects a shared decision after the target is removed', async () => {
    process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = join(root, 'opt-in.jsonc')
    const f = fixture(true)
    f.seed({ stickyBreakMinutes: 7 })
    write(f.target, { schema_version: 1 })
    recordSettingsDecision(f.paths.configPath, 'shared')
    fs.unlinkSync(f.target)
    expect(await migrateToPool(f.deps)).toMatchObject({ status: 'completed' })
    expectFinished(f, { stickyBreakMinutes: 7 })
  })

  it('an absolute opt-in does not bypass the read-only slot gate', async () => {
    process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = join(root, 'opt-in.jsonc')
    const f = fixture(true)
    f.seed()
    write(f.target, { schema_version: 1 })
    const before = fs.readFileSync(f.paths.configPath, 'utf8')
    expect(
      await migrateToPool({
        ...f.deps,
        slot: { ...f.deps.slot, migrationDisabledReason: () => 'read-only' },
      }),
    ).toEqual({ status: 'slot-read-only', reason: 'read-only' })
    expect(fs.readFileSync(f.paths.configPath, 'utf8')).toBe(before)
  })

  it('a shared migration with no slot login still writes its marker and drops the shield', async () => {
    const f = fixture()
    f.seed({ stickyBreakMinutes: 7 })
    write(f.authPath, { other: { type: 'api', key: 'unrelated' } })
    recordSettingsDecision(f.paths.configPath, 'shared')
    expect(await migrateToPool(f.deps)).toMatchObject({
      status: 'nothing-to-import',
    })
    expectFinished(f, { stickyBreakMinutes: 7 })
  })

  it('adopting another login does not pin a shared store', async () => {
    const f = fixture()
    f.seed()
    recordSettingsDecision(f.paths.configPath, 'shared')
    expect(await migrateToPool(f.deps)).toMatchObject({ status: 'completed' })
    write(f.authPath, { openai: login('acct-other', 'r-other') })
    expect(await adoptHostSlotLogin(f.deps)).toMatchObject({
      status: 'completed',
    })
    expectFinished(f, undefined)
  })

  for (const plainMode of [undefined, 'sticky-balanced'] as const) {
    it(`a fresh sign-in leaves old routing absent and resolves the shared mode ${plainMode ?? 'main-first'}`, async () => {
      const f = fixture()
      expect(fs.existsSync(f.paths.configPath)).toBe(false)
      recordSettingsDecision(f.paths.configPath, 'shared')
      if (plainMode)
        write(f.target, { schema_version: 1, routing_mode: plainMode })
      write(f.authPath, { openai: login('acct-main', 'r-main') })
      expect(await migrateToPool(f.deps)).toMatchObject({ status: 'completed' })
      expectFinished(f, undefined)
      const settings = openSettings(openaiSettings, {
        file: f.target,
        separateInstall: false,
        log,
      })
      expect(await settings.get('routing_mode', { host: 'opencode' })).toBe(
        plainMode ?? 'main-first',
      )
      expect(fs.existsSync(f.target)).toBe(plainMode !== undefined)
    })
  }
})

describe('pool migration and settings move lock independence', () => {
  it('config, row, quota and legacy state writes keep saves last and on this host only', async () => {
    const f = fixture()
    f.seed()
    write(f.paths.statePath, {
      version: 1,
      main: { quota: MAIN_QUOTA, quotaCheckedAt: Date.now() },
      accounts: {},
    })
    recordSettingsDecision(f.paths.configPath, 'shared')
    const acquire = commonFs.acquireRefreshFileLock
    const requested: { name: string; path: string }[] = []
    spyOn(commonFs, 'acquireRefreshFileLock').mockImplementation(
      async (options) => {
        requested.push({ name: options.name, path: options.path })
        return acquire(options)
      },
    )
    const sequences: { name: string; path: string }[][] = []
    let sequence: { name: string; path: string }[] = []
    let held = 0
    const onLockEvent: NonNullable<PoolMigrationDeps['store']>['onLockEvent'] =
      (event) => {
        if (event.type === 'acquired') {
          held++
          sequence.push({ name: event.name, path: event.path })
        } else if (event.type === 'released' && --held === 0) {
          sequences.push(sequence)
          sequence = []
        }
      }
    expect(
      await migrateToPool({ ...f.deps, store: { onLockEvent } }),
    ).toMatchObject({ status: 'completed' })
    expectFinished(f, undefined)
    expect(requested.some(({ name }) => name === 'save')).toBe(true)
    expect(
      requested.every(
        ({ name, path }) =>
          name !== 'settings-authority' &&
          name !== 'settings-move' &&
          [f.paths.configPath, f.paths.statePath, f.authPath].includes(path),
      ),
    ).toBe(true)
    const pair = [
      { name: 'save', path: f.paths.configPath },
      { name: 'save', path: f.paths.statePath },
    ]
    expect(sequences.length).toBeGreaterThan(1)
    for (const locks of sequences) expect(locks.slice(-2)).toEqual(pair)
    const rowWrite = sequences.find((locks) =>
      locks.some(({ name }) => name === MAIN_REFRESH_LOCK_NAME),
    )
    expect(rowWrite).toBeDefined()
    expect(
      rowWrite?.findIndex(({ name }) => name === MAIN_REFRESH_LOCK_NAME),
    ).toBeLessThan((rowWrite?.length ?? 0) - 2)
    expect(f.config()[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
  })

  for (const optIn of [false, true]) {
    it(`migration finishes while settings-move and Pi saves are held, optIn=${optIn}`, async () => {
      if (optIn)
        process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = join(
          root,
          'opt-in.jsonc',
        )
      const f = fixture(optIn)
      f.seed()
      const piConfig = join(root, 'home', '.pi', 'agent', 'openai-auth.json')
      const piState = join(dirname(piConfig), 'openai-auth-state.json')
      write(piConfig, { version: 1, accounts: [] })
      const held = []
      try {
        for (const [name, path] of [
          ['settings-move', f.target],
          ['save', piConfig],
          ['save', piState],
        ] as const) {
          const lock = await acquireRefreshFileLock({
            name,
            path,
            ttlMs: 10_000,
          })
          expect(lock).not.toBeNull()
          if (lock) held.push(lock)
        }
        expect(await migrateToPool(f.deps)).toMatchObject({
          status: 'completed',
        })
        expectFinished(f, { mode: 'main-first' })
      } finally {
        for (const lock of held.reverse()) await lock.release()
      }
    })

    it(`the move runs while a pool transfer is unfinished, optIn=${optIn}`, async () => {
      if (optIn)
        process.env.OPENCODE_OPENAI_AUTH_SETTINGS_FILE = join(
          root,
          'opt-in.jsonc',
        )
      const f = fixture(optIn)
      f.seed()
      let moved = false
      expect(
        await migrateToPool({
          ...f.deps,
          async onStep(step) {
            if (step !== 'after-record-write') return
            expect(f.config()[POOL_MIGRATION_KEY].migratedAt).toBeUndefined()
            const before = fs.readFileSync(f.paths.configPath, 'utf8')
            const result = await moveSettingsOnce({
              definition: openaiSettings,
              target: f.target,
              separateInstall: false,
              sources: [
                {
                  host: 'opencode',
                  path: f.paths.configPath,
                  locks: [
                    { name: 'save', path: f.paths.configPath },
                    { name: 'save', path: f.paths.statePath },
                  ],
                  read: JSON.parse,
                },
              ],
              map: () => ({ entries: [], unmapped: [] }),
              fence: () => true,
              log,
            })
            expect(result.outcome).toBe('moved')
            expect(fs.readFileSync(f.paths.configPath, 'utf8')).toBe(before)
            moved = true
          },
        }),
      ).toMatchObject({ status: 'completed' })
      expect(moved).toBe(true)
      expect(getSettingsDecision(f.paths.configPath)).toBeUndefined()
      expectFinished(f, undefined)
    })
  }
})
