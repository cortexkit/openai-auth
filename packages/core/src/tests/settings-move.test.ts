import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import * as commonSettings from '@cortexkit/common-auth/settings'
import { openaiSettings } from '../settings-definition.js'
import {
  resolveDefaultSettingsStores,
  resolveSettingsInstall,
  type SettingsInstall,
} from '../settings-install.js'
import * as floorsMapper from '../settings-map-floors.js'
import { runSettingsMove } from '../settings-move.js'
import { settingsNoteNamesTarget } from '../settings-note.js'

type Store = Record<string, unknown> | string | undefined
const roots: string[] = []
const scratch = resolve(import.meta.dir, '../../../../target/scratch')

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(stores: [Store, Store] = [{}, {}]) {
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'settings-runner-'))
  roots.push(root)
  const home = join(root, 'home')
  const env = {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(root, 'state'),
  }
  const options = { env, platform: 'linux' as const, homedir: () => home }
  const sources = resolveDefaultSettingsStores(options)
  const bytes = new Map<string, string>()
  for (const [index, source] of sources.entries()) {
    const store = stores[index]
    if (store === undefined) continue
    for (const [path, text] of [
      [
        source.configPath,
        typeof store === 'string' ? store : JSON.stringify(store),
      ],
      [source.statePath, '{"state":"must stay byte-identical"}\n'],
    ] as const) {
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, text)
      bytes.set(path, text)
    }
  }
  const install = resolveSettingsInstall({
    ...options,
    host: 'opencode',
    paths: sources[0]!,
  })
  const warnings: string[] = []
  const log = { warn: (message: string) => warnings.push(message) }
  return {
    root,
    home,
    env,
    options,
    sources,
    install,
    warnings,
    log,
    async unchanged() {
      for (const [path, text] of bytes)
        expect(await readFile(path, 'utf8')).toBe(text)
    },
    async unpublished() {
      expect(await stat(install.target).catch(() => null)).toBeNull()
      for (const source of sources)
        expect(
          await stat(`${source.configPath}.MOVED_READPLEASE`).catch(() => null),
        ).toBeNull()
    },
  }
}

async function document(install: SettingsInstall) {
  return JSON.parse(
    (await readFile(install.target, 'utf8')).replace(/^\/\/.*$/gm, ''),
  ) as Record<string, unknown>
}

function expectComplete(result: Awaited<ReturnType<typeof runSettingsMove>>) {
  expect(result?.outcome).toBe('moved')
  expect(result?.differing).toEqual([])
  expect(
    result?.unmapped.filter((entry) =>
      ['unknown-setting', 'invalid-value'].includes(entry.reason),
    ),
  ).toEqual([])
  expect(result?.failure).toBeUndefined()
}

describe('settings move runner wiring', () => {
  it('passes the install target and OpenCode then Pi, with only config/state save locks', async () => {
    const f = await fixture()
    const actualMove = commonSettings.moveSettingsOnce
    const mover = spyOn(commonSettings, 'moveSettingsOnce').mockImplementation(
      actualMove,
    )
    try {
      const result = await runSettingsMove({
        install: { ...f.install, sources: [...f.install.sources].reverse() },
        fence: () => true,
        log: f.log,
      })
      expectComplete(result)
      expect(mover).toHaveBeenCalledTimes(1)
      const options = mover.mock.calls[0]![0]
      expect(options.target).toBe(f.install.target)
      expect(options.definition).toBe(openaiSettings)
      expect(options.separateInstall).toBe(false)
      expect(
        options.sources.map(({ host, path, locks }) => ({ host, path, locks })),
      ).toEqual(
        f.sources.map((source) => ({
          host: source.host,
          path: source.configPath,
          locks: [
            { path: source.configPath, name: 'save' },
            { path: source.statePath, name: 'save' },
          ],
        })),
      )
      await f.unchanged()
    } finally {
      mover.mockRestore()
    }
  })

  it('holds the store save locks during the locked fence and never needs main-refresh', async () => {
    const f = await fixture()
    const outer = await acquireRefreshFileLock({
      path: f.sources[0]!.configPath,
      name: 'main-refresh',
      ttlMs: 10_000,
    })
    expect(outer).not.toBeNull()
    let checks = 0
    try {
      expectComplete(
        await runSettingsMove({
          install: f.install,
          async fence() {
            if (++checks === 2) {
              for (const source of f.sources) {
                for (const path of [source.configPath, source.statePath]) {
                  const lock = await acquireRefreshFileLock({
                    path,
                    name: 'save',
                    ttlMs: 10_000,
                  })
                  if (lock) await lock.release()
                  expect(lock).toBeNull()
                }
              }
            }
            return true
          },
          log: f.log,
        }),
      )
      expect(checks).toBe(2)
    } finally {
      await outer?.release()
    }
  })

  it('never invokes the mover or fence for a separate install or an opt-in with no sources', async () => {
    const f = await fixture()
    const mover = spyOn(commonSettings, 'moveSettingsOnce')
    let fences = 0
    try {
      for (const install of [
        { ...f.install, separate: true },
        { ...f.install, sources: [] },
      ]) {
        expect(
          await runSettingsMove({
            install,
            fence: () => {
              fences++
              return true
            },
            log: f.log,
          }),
        ).toBeUndefined()
      }
      expect(mover).not.toHaveBeenCalled()
      expect(fences).toBe(0)
      await f.unpublished()
      await f.unchanged()
    } finally {
      mover.mockRestore()
    }
  })

  it('has no pool marker, migration, vault or slot precondition and changes no store', async () => {
    const f = await fixture([
      {
        routing: { mode: 'sticky-balanced' },
        main: { token: 'private-token' },
      },
      {},
    ])
    // These inputs belong to the startup/migration layer, not the mover. A
    // missing or unwritable auth slot must not become a move dependency.
    const slot = join(f.root, 'unwritable-slot')
    await mkdir(slot)
    expect(
      await writeFile(slot, '{}').then(
        () => false,
        () => true,
      ),
    ).toBe(true)
    const install = {
      ...f.install,
      vaultMode: true,
      migrationEnabled: false,
      migrationRefused: true,
      slot,
    }
    expectComplete(
      await runSettingsMove({ install, fence: () => true, log: f.log }),
    )
    expect((await document(install)).routing_mode).toEqual({
      default: 'sticky-balanced',
      pi: 'main-first',
    })
    await f.unchanged()
    expect((await stat(slot)).isDirectory()).toBe(true)
  })
})

const allPreferences = {
  routing: { mode: 'sticky-balanced', maxSameAccountWait: 'max' },
  fallbackOn: [429, 503],
  refresh: { enabled: false, refreshBeforeExpiryMinutes: 300 },
  quota: {
    enabled: false,
    checkIntervalMinutes: 8,
    minimumRemaining: { primary: 20, secondary: 30 },
    failClosedOnUnknownQuota: true,
  },
  costZeroing: { enabled: false },
  killswitch: {
    schema: 'floors-v1',
    enabled: true,
    defaults: { primary: 7, secondary: 11 },
    accounts: { main: { primary: 12, secondary: 13 } },
  },
  cacheKeep: {
    enabled: true,
    subagents: true,
    sustain: true,
    startHour: 22,
    endHour: 6,
  },
  logging: { level: 'debug' },
  dump: { enabled: true },
  dumpDir: '/custom/dumps',
  dumpMaxBytes: 1024,
  webSockets: true,
  rawWebSocket: true,
  responsesLite: true,
  codexApiEndpoint: 'https://example.test/responses',
}

describe('settings move publication', () => {
  it('publishes every setting-table row without losing an entry at the merge', async () => {
    const f = await fixture([allPreferences, allPreferences])
    const result = await runSettingsMove({
      install: f.install,
      fence: () => true,
      log: f.log,
    })
    expectComplete(result)
    const expected = {
      schema_version: 1,
      routing_mode: 'sticky-balanced',
      max_same_account_wait: 'cache',
      fallback_on: [429, 503],
      refresh_enabled: false,
      refresh_before_expiry_minutes: 300,
      quota_enabled: false,
      quota_check_interval_minutes: 8,
      quota_minimum_remaining: [
        { window: 'primary', floor: 20 },
        { window: 'secondary', floor: 30 },
      ],
      quota_fail_closed_on_unknown: true,
      cost_zeroing: false,
      killswitch_enabled: true,
      killswitch_default_primary: 7,
      killswitch_default_secondary: 11,
      killswitch_account_floors: [
        { account: 'main', host: 'opencode', primary: 12, secondary: 13 },
        { account: 'main', host: 'pi', primary: 12, secondary: 13 },
      ],
      cache_keep_enabled: true,
      cache_keep_subagents: true,
      cache_keep_sustain: true,
      cache_keep_window: [{ start_hour: 22, end_hour: 6 }],
      log_level: 'debug',
      request_dumps: true,
      dump_dir: '/custom/dumps',
      dump_max_bytes: 1024,
      web_sockets: true,
      raw_web_socket: true,
      responses_lite: true,
      codex_api_endpoint: 'https://example.test/responses',
    }
    expect(
      Object.keys(expected)
        .filter((key) => key !== 'schema_version')
        .sort(),
    ).toEqual(Object.keys(openaiSettings.settings).sort())
    expect(await document(f.install)).toEqual(expected)
    await f.unchanged()
  })

  it('keeps aliases, absent windows, old shapes and every movable garbage fixture through the merge', async () => {
    const fixtures: Record<string, unknown>[] = [
      {},
      { routing: { maxSameAccountWait: 0 } },
      { routing: { maxSameAccountWait: 15 } },
      { routing: { maxSameAccountWait: 'max' } },
      { cachekeep: allPreferences.cacheKeep },
      { cacheKeep: { enabled: true }, cachekeep: { sustain: true } },
      { dump: true },
      { dump: false },
      { quota: { minimumRemaining: { '5h': 20, '1w': 30 } } },
      { quota: { minimumRemaining: { secondary: 30 } } },
      { quota: { minimumRemaining: { primary: null } } },
      { killswitch: { enabled: 'yes' } },
      { killswitch: { schema: 'floors-v1' } },
      {
        killswitch: {
          schema: 'floors-v1',
          accounts: { main: { primary: 20 } },
        },
      },
      {
        killswitch: {
          main: { '5h': 20, '1w': 30 },
          accounts: { main: { primary: 90 } },
        },
      },
      {
        killswitch: {
          main: { primary: null },
          accounts: { row: { secondary: null } },
        },
      },
      { quota: { failClosedOnUnknownQuota: 1 } },
      { quota: { failClosedOnUnknownQuota: 'true' } },
      { quota: { checkIntervalMinutes: 0.5 } },
      { refresh: { refreshBeforeExpiryMinutes: '300' } },
      ...['20', 'abc', null, -10, 120].flatMap((floor) =>
        [undefined, 'floors-v1'].map((schema) => ({
          killswitch: {
            schema,
            main: { primary: floor, secondary: floor },
            defaults: { primary: floor, secondary: floor },
            accounts: { row: { primary: floor, secondary: floor } },
          },
        })),
      ),
    ]
    for (const host of ['opencode', 'pi'] as const) {
      for (const store of fixtures) {
        const f = await fixture(host === 'opencode' ? [store, {}] : [{}, store])
        expectComplete(
          await runSettingsMove({
            install: f.install,
            fence: () => true,
            log: f.log,
          }),
        )
        await f.unchanged()
      }
    }
  })

  it('preserves each present host effective value when only one stores a key, without an opencode override', async () => {
    for (const stores of [
      [{ routing: { mode: 'sticky-balanced' } }, {}],
      [{}, { routing: { mode: 'sticky-balanced' } }],
    ] as [Store, Store][]) {
      const f = await fixture(stores)
      expectComplete(
        await runSettingsMove({
          install: f.install,
          fence: () => true,
          log: f.log,
        }),
      )
      const expected =
        typeof stores[0] === 'object' && 'routing' in stores[0]
          ? ({ default: 'sticky-balanced', pi: 'main-first' } as const)
          : ({ default: 'main-first', pi: 'sticky-balanced' } as const)
      expect((await document(f.install)).routing_mode).toEqual(expected)
      expect(
        Object.keys((await document(f.install)).routing_mode as object),
      ).not.toContain('opencode')
      const handle = commonSettings.openSettings(openaiSettings, {
        file: f.install.target,
        separateInstall: false,
        log: { warn() {}, info() {} },
      })
      expect(await handle.get('routing_mode', { host: 'opencode' })).toBe(
        expected.default,
      )
      expect(await handle.get('routing_mode', { host: 'pi' })).toBe(expected.pi)
    }
  })
})

describe('settings move failures and reports', () => {
  it('fails without publishing for an undeclared or descriptor-invalid composed map entry', async () => {
    for (const entry of [
      { setting: 'undeclared_setting', value: 'private-value-never-log' },
      { setting: 'routing_mode', value: 'private-value-never-log' },
      { setting: 'fallback_on', value: [429, 1.5] },
      {
        setting: 'killswitch_account_floors',
        value: [{ account: 'main', host: 'opencode', primary: 5 }],
      },
    ]) {
      const f = await fixture()
      const seam = spyOn(floorsMapper, 'mapKillswitchFloors').mockReturnValue({
        entries: [{ source: 0, ...entry }],
        unmapped: [],
      })
      try {
        const result = await runSettingsMove({
          install: f.install,
          fence: () => true,
          log: f.log,
        })
        expect(result?.outcome).toBe('failed')
        expect(result?.failure).toEqual({
          kind: 'setting',
          setting: entry.setting,
        })
        expect(f.warnings).toEqual([
          `Settings move failed: cannot move setting ${entry.setting}`,
        ])
        expect(f.warnings.join('\n')).not.toContain('private-value-never-log')
        await f.unpublished()
        await f.unchanged()
      } finally {
        seam.mockRestore()
      }
    }
  })

  it('classifies unreproducible garbage by setting, never by its value', async () => {
    for (const [setting, store] of [
      [
        'quota_minimum_remaining',
        { quota: { minimumRemaining: { primary: 'private-value-never-log' } } },
      ],
      [
        'quota_check_interval_minutes',
        { quota: { checkIntervalMinutes: 'private-value-never-log' } },
      ],
    ] as const) {
      const f = await fixture([store, {}])
      const result = await runSettingsMove({
        install: f.install,
        fence: () => true,
        log: f.log,
      })
      expect(result?.outcome).toBe('failed')
      expect(result?.failure).toEqual({ kind: 'setting', setting })
      expect(f.warnings).toEqual([
        `Settings move failed: cannot move setting ${setting}`,
      ])
      expect(JSON.stringify(result?.failure)).not.toContain(
        'private-value-never-log',
      )
      await f.unpublished()
      await f.unchanged()
    }
  })

  it('fails on either unreadable source beside a healthy store and moves after repair', async () => {
    for (const host of ['opencode', 'pi'] as const) {
      for (const broken of [
        '{private-value-never-log',
        'null',
        '[]',
        '"private-value-never-log"',
      ]) {
        const healthy = { routing: { mode: 'sticky-balanced' } }
        const f = await fixture(
          host === 'opencode' ? [broken, healthy] : [healthy, broken],
        )
        const result = await runSettingsMove({
          install: f.install,
          fence: () => true,
          log: f.log,
        })
        const path = f.sources.find(
          (source) => source.host === host,
        )!.configPath
        const code = broken.startsWith('{')
          ? 'SOURCE_NOT_JSON'
          : 'SOURCE_NOT_OBJECT'
        expect(result?.outcome).toBe('failed')
        expect(result?.failure).toEqual({ kind: 'cause', host, path, code })
        expect(f.warnings).toEqual([
          `Settings move failed: ${host} ${path}: ${code}`,
        ])
        expect(f.warnings.join('\n')).not.toContain('private-value-never-log')
        await f.unpublished()
        await f.unchanged()
        await writeFile(path, '{}')
        expectComplete(
          await runSettingsMove({
            install: f.install,
            fence: () => true,
            log: f.log,
          }),
        )
        expect((await document(f.install)).routing_mode).toEqual(
          host === 'opencode'
            ? { default: 'main-first', pi: 'sticky-balanced' }
            : { default: 'sticky-balanced', pi: 'main-first' },
        )
      }
    }
  })

  it('classifies filesystem and unexpected failures by code without exposing error text', async () => {
    const f = await fixture()
    const mover = spyOn(commonSettings, 'moveSettingsOnce')
    try {
      for (const cause of [
        Object.assign(new Error('private-value-never-log'), {
          code: 'EACCES',
          path: f.sources[1]!.configPath,
        }),
        Object.assign(new Error('private-value-never-log'), {
          code: 'ENOTSUP',
        }),
        new Error('private-value-never-log'),
      ]) {
        mover.mockResolvedValueOnce({
          outcome: 'failed',
          unmapped: [],
          differing: [],
          noteFailures: [],
          postPublishFailures: [],
          cause,
        })
        const result = await runSettingsMove({
          install: f.install,
          fence: () => true,
          log: f.log,
        })
        expect(result?.failure).toEqual(
          'path' in cause
            ? {
                kind: 'cause',
                host: 'pi',
                path: f.sources[1]!.configPath,
                code: 'EACCES',
              }
            : {
                kind: 'cause',
                code: 'code' in cause ? 'ENOTSUP' : 'SETTINGS_MOVE_FAILED',
              },
        )
      }
      expect(f.warnings).toHaveLength(3)
      expect(f.warnings.join('\n')).not.toContain('private-value-never-log')
      await f.unpublished()
    } finally {
      mover.mockRestore()
    }
  })

  it('warns once per unmapped entry and failed note with host, key/path and reason only', async () => {
    const f = await fixture([
      {
        future: 'private-value-never-log',
        cacheKeep: { enabled: true },
        cachekeep: { enabled: 'private-value-never-log' },
        killswitch: { enabled: 'private-value-never-log' },
      },
      { dumpDir: 'private-value-never-log' },
    ])
    const path = f.sources[0]!.configPath
    const actualMove = commonSettings.moveSettingsOnce
    // Inject the report, not a permission change: privileged test runners can
    // still write notes in a read-only directory.
    const mover = spyOn(
      commonSettings,
      'moveSettingsOnce',
    ).mockImplementationOnce(async (options) => ({
      ...(await actualMove(options)),
      noteFailures: [
        {
          path: `${path}.MOVED_READPLEASE`,
          error: Object.assign(new Error('private-value-never-log'), {
            code: 'EACCES',
          }),
        },
      ],
    }))
    const result = await runSettingsMove({
      install: f.install,
      fence: () => true,
      log: f.log,
    }).finally(() => mover.mockRestore())
    expectComplete(result)
    expect(result?.unmapped).toEqual([
      { source: 0, key: 'future', reason: 'retired' },
      { source: 0, key: 'cachekeep', reason: 'shadowed' },
      { source: 1, key: 'dumpDir', reason: 'other-host' },
      { source: 0, key: 'killswitch.enabled', reason: 'invalid' },
    ])
    expect(result?.noteFailures.map((entry) => entry.path)).toEqual([
      `${path}.MOVED_READPLEASE`,
    ])
    expect(f.warnings).toEqual([
      'Settings move: opencode future: retired',
      'Settings move: opencode cachekeep: shadowed',
      'Settings move: pi dumpDir: other-host',
      'Settings move: opencode killswitch.enabled: invalid',
      `Settings move note: opencode ${path}.MOVED_READPLEASE: EACCES`,
    ])
    expect(f.warnings.join('\n')).not.toContain('private-value-never-log')
    await f.unchanged()
  })
})

describe('settings move target isolation', () => {
  it('can move again outside a sandbox, preserving killswitch floors and an older Pi note', async () => {
    for (const piOnly of [false, true]) {
      const store = {
        killswitch: {
          schema: 'floors-v1',
          enabled: true,
          defaults: { primary: 20, secondary: 30 },
          accounts: { 'vault:shared': { primary: 40, secondary: 50 } },
        },
      }
      const f = await fixture([piOnly ? undefined : store, store])
      const sandboxOptions = {
        ...f.options,
        env: { ...f.env, XDG_CONFIG_HOME: join(f.root, 'sandbox') },
      }
      const sandboxSources = resolveDefaultSettingsStores(sandboxOptions)
      if (!piOnly) {
        await mkdir(resolve(sandboxSources[0]!.configPath, '..'), {
          recursive: true,
        })
        await writeFile(sandboxSources[0]!.configPath, JSON.stringify(store))
      }
      const sandbox = resolveSettingsInstall({
        ...sandboxOptions,
        host: 'pi',
        paths: sandboxSources[1]!,
      })
      expect(sandbox.target).not.toBe(f.install.target)
      expectComplete(
        await runSettingsMove({
          install: sandbox,
          fence: () => true,
          log: f.log,
        }),
      )
      const notePath = `${f.sources[1]!.configPath}.MOVED_READPLEASE`
      const sandboxNote = await readFile(notePath, 'utf8')
      expect(sandboxNote).toBe(
        `Settings moved to ${sandbox.target}.\nA rollback loses changes made after the move.\n`,
      )
      expect(
        settingsNoteNamesTarget(f.sources[1]!.configPath, f.install.target),
      ).toBe(false)
      await f.unchanged()
      const result = await runSettingsMove({
        install: f.install,
        fence: () => true,
        log: f.log,
      })
      expectComplete(result)
      expect(result?.noteFailures).toEqual([])
      expect(await readFile(notePath, 'utf8')).toBe(sandboxNote)
      const moved = await document(f.install)
      expect(moved.killswitch_enabled).toBe(true)
      expect(moved.killswitch_default_primary).toBe(20)
      expect(moved.killswitch_default_secondary).toBe(30)
      expect(moved.killswitch_account_floors).toEqual([
        {
          account: 'vault:shared',
          host: piOnly ? 'pi' : 'both',
          primary: 40,
          secondary: 50,
        },
      ])
      await f.unchanged()
    }
  })

  it('an opt-in on a default store moves nothing and never creates or replaces its note', async () => {
    for (const host of ['opencode', 'pi'] as const) {
      const f = await fixture([allPreferences, allPreferences])
      const install = resolveSettingsInstall({
        ...f.options,
        env: {
          ...f.env,
          [host === 'opencode'
            ? 'OPENCODE_OPENAI_AUTH_SETTINGS_FILE'
            : 'PI_OPENAI_AUTH_SETTINGS_FILE']: join(f.root, 'opt-in.jsonc'),
        },
        host,
        paths: f.sources.find((source) => source.host === host)!,
      })
      expect(install.sources).toEqual([])
      expect(
        await runSettingsMove({ install, fence: () => true, log: f.log }),
      ).toBeUndefined()
      expect(await stat(install.target).catch(() => null)).toBeNull()
      await f.unpublished()
      expectComplete(
        await runSettingsMove({
          install: f.install,
          fence: () => true,
          log: f.log,
        }),
      )
      const notes = await Promise.all(
        f.sources.map((source) =>
          readFile(`${source.configPath}.MOVED_READPLEASE`, 'utf8'),
        ),
      )
      expect(
        await runSettingsMove({ install, fence: () => true, log: f.log }),
      ).toBeUndefined()
      expect(
        await Promise.all(
          f.sources.map((source) =>
            readFile(`${source.configPath}.MOVED_READPLEASE`, 'utf8'),
          ),
        ),
      ).toEqual(notes)
      expect(await stat(install.target).catch(() => null)).toBeNull()
      await f.unchanged()
    }
  })

  it('an opt-in on a custom store moves only that host store, never either default store', async () => {
    for (const host of ['opencode', 'pi'] as const) {
      const f = await fixture([allPreferences, allPreferences])
      const custom = {
        configPath: join(f.root, 'custom', 'openai-auth.json'),
        statePath: join(f.root, 'custom', 'openai-auth-state.json'),
      }
      await mkdir(resolve(custom.configPath, '..'), { recursive: true })
      const bytes = '{"routing":{"mode":"ordered"}}\n'
      await writeFile(custom.configPath, bytes)
      const install = resolveSettingsInstall({
        ...f.options,
        env: {
          ...f.env,
          [host === 'opencode'
            ? 'OPENCODE_OPENAI_AUTH_SETTINGS_FILE'
            : 'PI_OPENAI_AUTH_SETTINGS_FILE']: join(f.root, 'opt-in.jsonc'),
        },
        host,
        paths: custom,
      })
      expect(install.sources).toEqual([{ host, ...custom }])
      expectComplete(
        await runSettingsMove({ install, fence: () => true, log: f.log }),
      )
      expect(await document(install)).toEqual({
        schema_version: 1,
        routing_mode: 'ordered',
      })
      expect(await readFile(custom.configPath, 'utf8')).toBe(bytes)
      expect(settingsNoteNamesTarget(custom.configPath, install.target)).toBe(
        true,
      )
      await f.unpublished()
      await f.unchanged()
    }
  })
})
