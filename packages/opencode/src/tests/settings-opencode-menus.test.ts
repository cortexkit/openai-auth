import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandApplyRequest } from '@cortexkit/common-auth/commands'
import * as settingsApi from '@cortexkit/common-auth/settings'
import * as internalApi from '@cortexkit/openai-auth-core/internal'
import { loadAccounts } from '@cortexkit/openai-auth-core/internal'
import { decideSettingsAuthority } from '@cortexkit/openai-auth-core/settings-authority'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import { SETTINGS_DIAGNOSTICS_TEXT as text } from '@cortexkit/openai-auth-core/settings-diagnostics'
import { createBuiltinSettingsPort } from '@cortexkit/openai-auth-core/settings-port'
import {
  createSettingsSnapshot,
  type SettingsSnapshot,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import { createOpenCodeMenu, type OpenCodeMenuContext } from '../commands'
import * as configApi from '../config'
import {
  getSettings,
  registerSettingsSnapshot,
  resetSettingsForTest,
} from '../config'
import { openAccountPool } from '../core/pool-accounts'
import { createLogger, flushForTest, setLogLevel } from '../logger'
import { createControlPlaneMenu } from '../v2/menu'
import { poolFiles, seedPool } from './fixtures/opencode2-host'

const log = { warn() {}, info() {} }
const cleanups: Array<() => void> = []
const roots: string[] = []
const previousLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  setLogLevel(undefined)
  resetSettingsForTest()
  await flushForTest()
  if (previousLogFile === undefined)
    delete process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
  else process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = previousLogFile
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function fixture(
  values: Record<string, unknown> | string | null = {},
  mode: 'shared' | 'separate' | 'moved' | 'failed' | 'fresh' = 'shared',
) {
  const root = await mkdtemp(join(tmpdir(), 'settings-opencode-menus-'))
  roots.push(root)
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(root, 'test.log')
  const files = poolFiles(root)
  seedPool(files, 'ordered', [{ id: 'main' }, { id: 'alpha' }])
  if (mode === 'fresh') {
    rmSync(files.configPath)
    rmSync(files.statePath)
  }
  const target = join(root, 'settings.jsonc')
  if (mode === 'failed')
    writeFileSync(files.configPath, '{ broken source with private-value')
  if (mode !== 'moved' && mode !== 'failed' && values !== null)
    writeFileSync(
      target,
      typeof values === 'string' ? values : JSON.stringify(values),
    )
  const authority = await decideSettingsAuthority({
    install: {
      host: 'opencode',
      configIdentity: files.configPath,
      target,
      optIn: false,
      separate: mode === 'separate',
      sources: [{ host: 'opencode', ...files.paths() }],
    },
    stateHome: join(root, 'state'),
    record: async () => {},
    log,
  })
  let snapshot: SettingsSnapshot | undefined
  if (authority.decision === 'shared') {
    const handle = settingsApi.openSettings(openaiSettings, {
      file: target,
      log,
      separateInstall: false,
      createMissing: true,
    })
    // Hold watcher delivery: hand edits must be observed by the menu itself.
    handle.watch = () => () => {}
    snapshot = await createSettingsSnapshot({
      handle,
      file: target,
      host: 'opencode',
    })
    cleanups.push(() => snapshot?.dispose())
    cleanups.push(registerSettingsSnapshot(files.configPath, snapshot))
  }
  const effects: unknown[] = []
  const context: OpenCodeMenuContext = {
    accountStoragePath: files.configPath,
    accountStatePath: files.statePath,
    configPath: files.configPath,
    settingsSnapshot: snapshot,
    packageVersion: 'test',
    loadAccounts,
    store: () => openAccountPool(files.paths()),
    migration: async () => ({ migrated: true }),
    cacheKeepManager: {
      status: () => ({
        running: false,
        sustain: false,
        tracked: 0,
        generatedAt: 0,
        ttlMs: 300_000,
        leadMs: 75_000,
        maxIdleWarmMs: 3_600_000,
        maxSubagentIdleMs: 1_800_000,
        targets: [],
      }),
      start: () => effects.push('start'),
      stop: () => effects.push('stop'),
      remove() {},
    },
    setCacheKeepEnabled: (on) =>
      effects.push(['enabled', on, snapshot?.get('cache_keep_enabled')]),
    setCacheKeepSubagents: (on) =>
      effects.push(['subagents', on, snapshot?.get('cache_keep_subagents')]),
    setCacheKeepSustain: (on) =>
      effects.push(['sustain', on, snapshot?.get('cache_keep_sustain')]),
    setCacheKeepWindow: (window) =>
      effects.push(['window', window, snapshot?.get('cache_keep_window')]),
  }
  return { root, files, target, authority, snapshot, context, effects }
}

function menuFor(context: OpenCodeMenuContext, host: 1 | 2) {
  const invocation = { sessionId: 'settings-test', notify() {} }
  if (host === 2) {
    const menu = createControlPlaneMenu(context)
    return {
      open: () => menu.open('settings-test'),
      apply: (request: CommandApplyRequest) => menu.apply(request),
    }
  }
  const menu = createOpenCodeMenu(context)
  return {
    open: () => menu.open(invocation),
    apply: (request: CommandApplyRequest) => menu.apply(request, invocation),
  }
}
function apply(
  menu: ReturnType<typeof menuFor>,
  sectionId: string,
  actionId: string,
  values: CommandApplyRequest['values'],
) {
  return menu.apply({ command: 'openai', sectionId, actionId, values })
}
async function diagnostics(menu: ReturnType<typeof menuFor>) {
  return (await menu.open()).menu.sections.find((s) => s.id === 'diagnostics')!
}

for (const host of [1, 2] as const) {
  test(`OpenCode ${host} shared Cache and Diagnostics edits preserve comments and refresh before effects`, async () => {
    const f = await fixture(`// preserve this comment\n{
      "cache_keep_enabled": false,
      "cache_keep_subagents": false,
      "cache_keep_sustain": false,
      "request_dumps": false,
      "log_level": "default"
    }`)
    const menu = menuFor(f.context, host)
    const actualOpen = settingsApi.openSettings
    const checkedOpen: typeof actualOpen = (definition, options) => {
      expect(options.createMissing).toBe(true)
      const handle = actualOpen(definition, options)
      const update = handle.update
      handle.update = (edits, context) => {
        expect(context).toEqual({ host: 'opencode' })
        return update(edits, context)
      }
      return handle
    }
    const opening = spyOn(settingsApi, 'openSettings').mockImplementation(
      checkedOpen,
    )
    cleanups.push(() => opening.mockRestore())
    const before = readFileSync(f.files.configPath, 'utf8')
    for (const action of ['enabled', 'subagents', 'sustain'])
      expect((await apply(menu, 'cache', action, { [action]: true })).ok).toBe(
        true,
      )
    expect(f.effects).toEqual([
      ['enabled', true, true],
      'start',
      ['subagents', true, true],
      ['sustain', true, true],
    ])
    expect((await apply(menu, 'cache', 'window', { window: '22-6' })).ok).toBe(
      true,
    )
    expect(f.effects.at(-1)).toEqual([
      'window',
      { startHour: 22, endHour: 6 },
      [{ start_hour: 22, end_hour: 6 }],
    ])
    expect((await apply(menu, 'cache', 'window', { window: '' })).ok).toBe(true)
    expect(f.effects.at(-1)).toEqual(['window', undefined, []])
    const actualRefresh = configApi.refreshSettings
    const refresh = spyOn(configApi, 'refreshSettings').mockImplementation(
      (configPath) => {
        expect(f.snapshot!.get('request_dumps')).toBe(true)
        return actualRefresh(configPath)
      },
    )
    try {
      expect(
        (await apply(menu, 'diagnostics', 'dump', { enabled: true })).ok,
      ).toBe(true)
      expect(refresh).toHaveBeenCalledWith(f.files.configPath)
    } finally {
      refresh.mockRestore()
    }
    expect(f.snapshot!.get('request_dumps')).toBe(true)
    expect(getSettings(f.files.configPath).dump).toBe(true)
    const setLevel = internalApi.setLogLevel
    const level = spyOn(internalApi, 'setLogLevel').mockImplementation(
      (next) => {
        expect(f.snapshot!.get('log_level')).toBe('debug')
        setLevel(next)
      },
    )
    try {
      expect(
        (await apply(menu, 'diagnostics', 'logging', { level: 'debug' })).ok,
      ).toBe(true)
      expect(level).toHaveBeenCalledWith('debug')
    } finally {
      level.mockRestore()
    }
    expect(f.snapshot!.get('log_level')).toBe('debug')
    const logger = createLogger('settings-menu-test')
    logger.debug('menu-debug-applied')
    await flushForTest()
    expect(readFileSync(join(f.root, 'test.log'), 'utf8')).toContain(
      'menu-debug-applied',
    )
    const saved = readFileSync(f.target, 'utf8')
    expect(saved).toContain('// preserve this comment')
    expect(
      JSON.parse(saved.replace('// preserve this comment', ''))
        .cache_keep_enabled,
    ).toBe(true)
    expect(readFileSync(f.files.configPath, 'utf8')).toBe(before)
  })

  test(`OpenCode ${host} passes a shared settings port and keeps no-port Routing on the store`, async () => {
    const shared = await fixture({
      routing_mode: { opencode: 'ordered', pi: 'ordered' },
    })
    shared.context.settings = createBuiltinSettingsPort({
      file: shared.target,
      host: 'opencode',
      snapshot: shared.snapshot!,
      log,
    })
    const before = readFileSync(shared.files.configPath, 'utf8')
    expect(
      (
        await apply(menuFor(shared.context, host), 'routing', 'mode', {
          mode: 'sticky-balanced',
        })
      ).ok,
    ).toBe(true)
    expect(shared.snapshot!.get('routing_mode')).toBe('sticky-balanced')
    expect(
      JSON.parse(readFileSync(shared.target, 'utf8')).routing_mode,
    ).toEqual({ opencode: 'sticky-balanced', pi: 'ordered' })
    expect(readFileSync(shared.files.configPath, 'utf8')).toBe(before)
    delete shared.context.settings
    const automatic = menuFor(shared.context, host)
    expect(
      (
        await apply(automatic, 'routing', 'maxSameAccountWait', {
          maxSameAccountWait: 'max',
        })
      ).ok,
    ).toBe(true)
    expect(shared.snapshot!.get('max_same_account_wait')).toBe('cache')
    expect(
      (await apply(automatic, 'limits', 'killswitch', { enabled: true })).ok,
    ).toBe(true)
    const floors = await automatic.apply({
      command: 'openai',
      sectionId: 'limits',
      itemId: 'main',
      actionId: 'floors',
      values: { primary: 20, secondary: 30 },
    })
    expect(floors.ok).toBe(true)
    expect(shared.snapshot!.get('killswitch_account_floors')).toEqual([
      { account: 'main', host: 'opencode', primary: 20, secondary: 30 },
    ])
    expect(readFileSync(shared.files.configPath, 'utf8')).toBe(before)
    const separate = await fixture({}, 'separate')
    expect(
      (
        await apply(menuFor(separate.context, host), 'routing', 'mode', {
          mode: 'sticky-balanced',
        })
      ).ok,
    ).toBe(true)
    expect(
      JSON.parse(readFileSync(separate.files.configPath, 'utf8')).routing.mode,
    ).toBe('sticky-balanced')
    expect(readFileSync(separate.target, 'utf8')).toBe('{}')
  })

  test(`OpenCode ${host} log choices exclude default and show info for absent/default`, async () => {
    for (const values of [{}, { log_level: 'default' }]) {
      const f = await fixture(values)
      const section = await diagnostics(menuFor(f.context, host))
      expect(section.lines).toContain('Log level: info')
      const knob = section.actions.find((a) => a.id === 'logging')!.knobs[0]!
      expect(knob).toMatchObject({
        value: 'info',
        choices: ['error', 'warn', 'info', 'debug', 'trace'].map((value) => ({
          value,
          label: value,
        })),
      })
    }
  })

  for (const bad of [
    [{ start_hour: 9 }],
    [{ start_hour: 9, end_hour: 9 }],
    [
      { start_hour: 9, end_hour: 18 },
      { start_hour: 22, end_hour: 6 },
    ],
    'not JSON',
    'unreadable',
  ]) {
    test(`OpenCode ${host} refuses unread warm-window set and clear (${JSON.stringify(bad)})`, async () => {
      const f = await fixture({
        cache_keep_window: [{ start_hour: 9, end_hour: 18 }],
      })
      if (bad === 'unreadable') {
        rmSync(f.target)
        mkdirSync(f.target)
      } else
        writeFileSync(
          f.target,
          typeof bad === 'string'
            ? bad
            : JSON.stringify({ cache_keep_window: bad }),
        )
      expect(f.snapshot!.get('cache_keep_window')).toEqual([
        { start_hour: 9, end_hour: 18 },
      ])
      const before =
        bad === 'unreadable' ? null : readFileSync(f.target, 'utf8')
      const menu = menuFor(f.context, host)
      for (const window of ['22-6', '']) {
        const result = await apply(menu, 'cache', 'window', { window })
        expect(result).toMatchObject({
          ok: false,
          code: 'settings-invalid-value',
          text: text.refusal['settings-invalid-value'],
        })
        if (before !== null) expect(readFileSync(f.target, 'utf8')).toBe(before)
      }
      expect(f.effects).toEqual([])
    })
  }

  test(`OpenCode ${host} Diagnostics refreshes descriptor and semantic reports without watcher delivery`, async () => {
    const f = await fixture()
    const menu = menuFor(f.context, host)
    for (const floor of [
      { account: 'main', primary: 20, secondary: 30 },
      { account: 'main', host: 'opencode', primary: 20 },
    ]) {
      writeFileSync(
        f.target,
        JSON.stringify({ killswitch_account_floors: [floor] }),
      )
      const key = 'host' in floor ? 'secondary' : 'host'
      expect((await diagnostics(menu)).lines).toContain(
        text.report['invalid-value'](`killswitch_account_floors.0.${key}`),
      )
    }
    writeFileSync(
      f.target,
      JSON.stringify({
        unknown_menu_key: 'secret-value',
        killswitch_account_floors: [
          { account: 'main', host: 'both', primary: 20, secondary: 30 },
          { account: 'main', host: 'both', primary: 40, secondary: 50 },
        ],
        quota_minimum_remaining: [
          { window: 'primary', floor: 20 },
          { window: 'primary', floor: 30 },
        ],
        cache_keep_window: [{ start_hour: 9, end_hour: 9 }],
      }),
    )
    const lines = (await diagnostics(menu)).lines
    for (const line of [
      text.file(f.target),
      text.sharedFound,
      text.preExistingFile(f.target),
      text.report['unknown-key']('unknown_menu_key'),
      text.checks.duplicateFloors,
      text.checks.localBoth,
      text.checks.duplicateQuota,
      text.checks.warmWindow,
    ])
      expect(lines).toContain(line)
    expect(lines.join('\n')).not.toContain('secret-value')
    writeFileSync(f.target, 'broken settings')
    expect((await diagnostics(menu)).lines).toContain(
      text.report.unparseable(f.target),
    )
    rmSync(f.target)
    mkdirSync(f.target)
    expect((await diagnostics(menu)).lines).toContain(
      text.report.unreadable(f.target),
    )
  })

  test(`OpenCode ${host} separate Diagnostics omits shared paths notices and reports`, async () => {
    const f = await fixture({ unknown_menu_key: 'secret-value' }, 'separate')
    const lines = (await diagnostics(menuFor(f.context, host))).lines
    expect(lines).toContain(text.separate)
    expect(lines.some((line) => line.includes(f.target))).toBe(false)
    expect(lines.some((line) => line.includes('unknown_menu_key'))).toBe(false)
  })

  test(`OpenCode ${host} failed source move stays visible at every menu open without values`, async () => {
    const f = await fixture(null, 'failed')
    expect(f.authority.decision).toBe('legacy')
    const menu = menuFor(f.context, host)
    for (let i = 0; i < 2; i++) {
      const lines = (await diagnostics(menu)).lines
      expect(lines).toContain(
        text.legacyFailed(`opencode ${f.files.configPath}: SOURCE_NOT_JSON`),
      )
      const failure = lines.find((line) => line.includes('move failed:'))!
      expect(failure).toContain('opencode')
      expect(failure).toContain(f.files.configPath)
      expect(failure).toContain('SOURCE_NOT_JSON')
      expect(failure).not.toContain('private-value')
      expect(failure).not.toContain('routing_mode')
    }
    expect(existsSync(f.target)).toBe(false)
  })

  test(`OpenCode ${host} moved and pre-existing files can be removed and recreated by a menu edit`, async () => {
    for (const mode of ['shared', 'moved'] as const) {
      const f = await fixture(mode === 'shared' ? {} : null, mode)
      const menu = menuFor(f.context, host)
      if (mode === 'moved') {
        expect(f.authority.move?.outcome).toBe('moved')
        expect((await diagnostics(menu)).lines).toContain(text.sharedMoved)
      }
      rmSync(f.target)
      const missing = (await diagnostics(menu)).lines
      expect(missing).toContain(text.sharedMissing)
      if (mode === 'moved')
        expect(missing).toContain(text.removedFile(f.target))
      expect(
        (await apply(menu, 'cache', 'enabled', { enabled: true })).ok,
      ).toBe(true)
      expect(f.snapshot!.get('cache_keep_enabled')).toBe(true)
      const found = (await diagnostics(menu)).lines
      expect(found).toContain(text.sharedFound)
      expect(found).not.toContain(text.removedFile(f.target))
      expect(readFileSync(f.target, 'utf8')).toContain('cache_keep_enabled')
    }
  })

  test(`OpenCode ${host} first Cache edit creates a fresh settings file and refreshes its snapshot`, async () => {
    const f = await fixture(null, 'fresh')
    expect(f.authority.ranMove).toBe(false)
    expect(existsSync(f.target)).toBe(false)
    const menu = menuFor(f.context, host)
    expect((await apply(menu, 'cache', 'enabled', { enabled: true })).ok).toBe(
      true,
    )
    expect(f.snapshot!.get('cache_keep_enabled')).toBe(true)
    expect(readFileSync(f.target, 'utf8')).toContain('// openai-auth settings')
    expect(existsSync(f.files.configPath)).toBe(false)
    const lines = (await diagnostics(menu)).lines
    expect(lines).toContain(text.sharedFound)
    expect(lines).not.toContain(text.preExistingFile(f.target))
  })

  for (const code of settingsApi.SETTINGS_REFUSAL_CODES) {
    test(`OpenCode ${host} ${code} uses fixed text and applies no dump log or cache effect`, async () => {
      const f = await fixture()
      const menu = menuFor(f.context, host)
      const before = readFileSync(f.target, 'utf8')
      const actualOpen = settingsApi.openSettings
      const level = spyOn(internalApi, 'setLogLevel')
      const refresh = spyOn(configApi, 'refreshSettings')
      const refuseOpen: typeof actualOpen = (definition, options) => {
        const handle = actualOpen(definition, options)
        handle.update = async () => {
          throw new settingsApi.SettingsRefusal(code, f.target)
        }
        return handle
      }
      const opening = spyOn(settingsApi, 'openSettings').mockImplementation(
        refuseOpen,
      )
      try {
        for (const [section, action, values] of [
          ['cache', 'enabled', { enabled: true }],
          ['diagnostics', 'dump', { enabled: true }],
          ['diagnostics', 'logging', { level: 'trace' }],
        ] as const) {
          const result = await apply(menu, section, action, values)
          expect(result).toMatchObject({
            ok: false,
            code,
            text: text.refusal[code],
          })
          expect(result.text).not.toContain(f.target)
        }
        expect(level).not.toHaveBeenCalled()
        expect(refresh).not.toHaveBeenCalled()
      } finally {
        opening.mockRestore()
        level.mockRestore()
        refresh.mockRestore()
      }
      expect(f.effects).toEqual([])
      expect(f.snapshot!.get('request_dumps')).toBe(false)
      expect(f.snapshot!.get('log_level')).toBe('default')
      expect(getSettings(f.files.configPath).dump).toBe(false)
      expect(readFileSync(f.target, 'utf8')).toBe(before)
    })
  }

  test(`OpenCode ${host} legacy Cache and Diagnostics still write their account store`, async () => {
    const f = await fixture(null, 'failed')
    seedPool(f.files, 'ordered', [{ id: 'main' }])
    const menu = menuFor(f.context, host)
    expect((await apply(menu, 'cache', 'enabled', { enabled: true })).ok).toBe(
      true,
    )
    expect(
      (await apply(menu, 'cache', 'subagents', { subagents: true })).ok,
    ).toBe(true)
    expect((await apply(menu, 'cache', 'sustain', { sustain: true })).ok).toBe(
      true,
    )
    expect((await apply(menu, 'cache', 'window', { window: '22-6' })).ok).toBe(
      true,
    )
    expect(
      (await apply(menu, 'diagnostics', 'dump', { enabled: true })).ok,
    ).toBe(true)
    expect(
      (await apply(menu, 'diagnostics', 'logging', { level: 'debug' })).ok,
    ).toBe(true)
    expect(f.files.readConfig()).toMatchObject({
      cacheKeep: {
        enabled: true,
        subagents: true,
        sustain: true,
        startHour: 22,
        endHour: 6,
      },
      dump: { enabled: true },
      logging: { level: 'debug' },
    })
    expect(existsSync(f.target)).toBe(false)
  })
}
