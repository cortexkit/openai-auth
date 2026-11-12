import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  openSettings,
  type ReportEntry,
  type ReportReason,
  SETTINGS_REFUSAL_CODES,
  SettingsRefusal,
} from '@cortexkit/common-auth/settings'
import {
  decideSettingsAuthority,
  SettingsAuthorityRefusal,
  type SettingsAuthorityResult,
} from '../settings-authority.js'
import type { SettingsCompletion } from '../settings-completion.js'
import { openaiSettings } from '../settings-definition.js'
import {
  buildSettingsDiagnostics,
  settingsDecisionLine,
  settingsDiagnosticsSection,
  settingsRefusalText,
  settingsReportLine,
  SETTINGS_DIAGNOSTICS_TEXT as text,
} from '../settings-diagnostics.js'
import type { SettingsInstall } from '../settings-install.js'
import {
  createSettingsSnapshot,
  type SettingsSnapshot,
} from '../settings-snapshot.js'

const roots: string[] = []
const snapshots: SettingsSnapshot[] = []
afterEach(async () => {
  for (const snapshot of snapshots.splice(0)) snapshot.dispose()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

type Rendered<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => string
    ? string
    : T[K] extends string
      ? string
      : Rendered<T[K]>
}

describe('settings diagnostic text contract', () => {
  it('holds every table line as a literal string', () => {
    const rendered: Rendered<typeof text> = {
      file: text.file('/settings.jsonc'),
      separate: text.separate,
      legacyProcess: text.legacyProcess,
      legacyBusy: text.legacyBusy,
      legacySetting: text.legacySetting('quota_minimum_remaining'),
      legacyFailed: text.legacyFailed('SOURCE_NOT_JSON'),
      sharedMissing: text.sharedMissing,
      sharedMoved: text.sharedMoved,
      sharedFound: text.sharedFound,
      preExistingFile: text.preExistingFile('/settings.jsonc'),
      removedFile: text.removedFile('/settings.jsonc'),
      refused: text.refused('/records', 'permission denied'),
      report: {
        'unknown-key': text.report['unknown-key']('unknown.child'),
        'override-not-allowed': text.report['override-not-allowed'](
          'routing_mode.host.pi',
        ),
        'user-only-in-project':
          text.report['user-only-in-project']('log_level'),
        'invalid-value': text.report['invalid-value']('killswitch_enabled'),
        'invalid-schema-version':
          text.report['invalid-schema-version']('schema_version'),
        'newer-version-key-ignored':
          text.report['newer-version-key-ignored']('future_setting'),
        'duplicate-key': text.report['duplicate-key']('routing_mode'),
        unparseable: text.report.unparseable('/settings.jsonc'),
        unreadable: text.report.unreadable('/settings.jsonc'),
      },
      checks: { ...text.checks },
      refusal: { ...text.refusal },
    }
    expect(rendered).toEqual({
      file: 'Settings file: /settings.jsonc',
      separate: "Settings stay in this install's account store.",
      legacyProcess:
        'Settings stay in the old account store because another process still uses it.',
      legacyBusy:
        'Settings stay in the old account store because the stores were busy.',
      legacySetting:
        "Settings stay in the old account store because quota_minimum_remaining couldn't be moved.",
      legacyFailed:
        'Settings stay in the old account store because the move failed: SOURCE_NOT_JSON.',
      sharedMissing: 'No settings file, so defaults are in use.',
      sharedMoved: 'Settings were moved to the settings file in this process.',
      sharedFound: 'Settings file found.',
      preExistingFile:
        "Settings come from /settings.jsonc. Preferences in the old account store weren't copied, because this file already existed.",
      removedFile:
        "The settings file /settings.jsonc was removed, so defaults are in use. Old preferences aren't copied again.",
      refused:
        "openai-auth didn't start. Process records folder: /records. Cause: permission denied",
      report: {
        'unknown-key': 'Unknown settings key: unknown.child.',
        'override-not-allowed':
          'Settings override not allowed: routing_mode.host.pi.',
        'user-only-in-project':
          'User-only setting found in a project file: log_level.',
        'invalid-value': 'Invalid settings value: killswitch_enabled.',
        'invalid-schema-version':
          'Invalid settings schema version: schema_version.',
        'newer-version-key-ignored':
          'Settings key from a newer version ignored: future_setting.',
        'duplicate-key': 'Duplicate settings key: routing_mode.',
        unparseable: "The settings file /settings.jsonc can't be parsed.",
        unreadable: "The settings file /settings.jsonc can't be read.",
      },
      checks: {
        duplicateFloors:
          'Invalid killswitch_account_floors: duplicate account and host pair.',
        localBoth:
          'Invalid killswitch_account_floors: only vault accounts may use host both.',
        duplicateQuota:
          'Invalid quota_minimum_remaining: duplicate quota window.',
        warmWindow:
          'Invalid cache_keep_window: use at most one window with unequal hours.',
      },
      refusal: {
        'settings-unparseable':
          "The settings file can't be read. Fix it or remove it, then try again.",
        'settings-newer-version':
          'The settings file is from a newer openai-auth. Update openai-auth to change settings.',
        'settings-invalid-value': "That value isn't allowed for this setting.",
        'settings-busy': 'The settings file is busy. Try again.',
        'settings-unavailable': "Settings can't be saved for this install.",
      },
    } satisfies Rendered<typeof text>)
  })

  it.each(SETTINGS_REFUSAL_CODES)(
    'formats only the fixed menu text for %s',
    (code) => {
      const refusal = new SettingsRefusal(
        code,
        'provider text /private/settings.jsonc',
      )
      const line = settingsRefusalText(refusal.code)
      expect(line).toBe(text.refusal[code])
      expect(line).not.toContain('provider text')
      expect(line).not.toContain('/private/settings.jsonc')
    },
  )
})

function entry(
  reason: ReportReason,
  keyPath = ['setting', 'nested'],
): ReportEntry {
  return {
    file: { kind: 'user', path: '/settings.jsonc' },
    keyPath,
    reason,
    detail: 'private value',
  }
}

describe('settings report formatting', () => {
  it.each(Object.keys(text.report) as ReportReason[])(
    'formats %s with the key path or file and no raw detail',
    (reason) => {
      const location = ['unparseable', 'unreadable'].includes(reason)
        ? '/settings.jsonc'
        : 'setting.nested'
      expect(settingsReportLine(entry(reason))).toBe(
        text.report[reason](location),
      )
      expect(settingsReportLine(entry(reason, []))).toBe(
        text.report[reason]('/settings.jsonc'),
      )
      expect(settingsReportLine(entry(reason))).not.toContain('private value')
    },
  )

  it.each([
    [
      'killswitch_account_floors',
      'Duplicate account and host pair',
      text.checks.duplicateFloors,
    ],
    [
      'killswitch_account_floors',
      'Only vault accounts may use host both',
      text.checks.localBoth,
    ],
    [
      'quota_minimum_remaining',
      'Duplicate quota window',
      text.checks.duplicateQuota,
    ],
    [
      'cache_keep_window',
      'Use at most one window with unequal hours',
      text.checks.warmWindow,
    ],
  ])(
    'names the setting for semantic check %s: %s',
    (setting, detail, expected) => {
      expect(
        settingsReportLine({ ...entry('invalid-value', [setting]), detail }),
      ).toBe(expected)
      expect(
        settingsReportLine({
          ...entry('invalid-value', ['another_setting']),
          detail,
        }),
      ).toBe('Invalid settings value: another_setting.')
      expect(
        settingsReportLine({ ...entry('unknown-key', [setting]), detail }),
      ).toBe(text.report['unknown-key'](setting))
    },
  )
})

async function put(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

async function fixture(
  options: { separate?: boolean; source?: string; target?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'settings-diagnostics-'))
  roots.push(root)
  const install: SettingsInstall = {
    host: 'opencode',
    configIdentity: join(root, 'store', 'openai-auth.json'),
    target: join(root, 'settings.jsonc'),
    optIn: false,
    separate: options.separate ?? false,
    sources: [],
  }
  install.sources.push({
    host: 'opencode',
    configPath: install.configIdentity,
    statePath: join(root, 'store', 'state.json'),
  })
  if (options.source !== undefined)
    await put(install.configIdentity, options.source)
  if (options.target !== undefined) await put(install.target, options.target)
  const warnings: string[] = []
  const log = {
    warn(message: string) {
      warnings.push(message)
    },
  }
  const start = (record = async () => {}) =>
    decideSettingsAuthority({
      install,
      stateHome: join(root, 'state'),
      record,
      log,
    })
  const open = (snapshot?: Pick<SettingsSnapshot, 'refresh' | 'report'>) =>
    buildSettingsDiagnostics({
      configPath: install.configIdentity,
      snapshot,
      log,
    })
  return { root, install, start, open, warnings, log }
}

function completion(targetExists: boolean): SettingsCompletion {
  return {
    kind: targetExists ? 'target-exists' : 'no-source',
    completed: targetExists,
    targetExists,
    noteNamesTarget: false,
    sourcePresent: false,
    preExistingFile: false,
    removedFile: false,
  }
}

function move(
  outcome: NonNullable<SettingsAuthorityResult['move']>['outcome'],
): NonNullable<SettingsAuthorityResult['move']> {
  return {
    outcome,
    unmapped: [],
    differing: [],
    noteFailures: [],
    postPublishFailures: [],
  }
}

describe('settings decision lines', () => {
  it('distinguishes each legacy reason without exposing the failed value', async () => {
    const { install } = await fixture()
    const authority: SettingsAuthorityResult = {
      install,
      decision: 'legacy',
      ranMove: true,
    }
    expect(
      settingsDecisionLine(
        { ...authority, move: move('fence-closed') },
        completion(false),
      ),
    ).toBe(text.legacyProcess)
    expect(
      settingsDecisionLine(
        { ...authority, fence: { open: false, blockers: [] } },
        completion(false),
      ),
    ).toBe(text.legacyProcess)
    expect(
      settingsDecisionLine(
        { ...authority, move: move('busy') },
        completion(false),
      ),
    ).toBe(text.legacyBusy)
    expect(
      settingsDecisionLine(
        {
          ...authority,
          move: {
            ...move('failed'),
            failure: { kind: 'setting', setting: 'quota_minimum_remaining' },
            cause: new Error('private stored value'),
          },
        },
        completion(false),
      ),
    ).toBe(text.legacySetting('quota_minimum_remaining'))
    expect(
      settingsDecisionLine(
        {
          ...authority,
          move: {
            ...move('failed'),
            failure: {
              kind: 'cause',
              host: 'pi',
              path: '/pi/store.json',
              code: 'SOURCE_NOT_JSON',
            },
            cause: new Error('private stored value'),
          },
        },
        completion(false),
      ),
    ).toBe(
      'Settings stay in the old account store because the move failed: pi /pi/store.json: SOURCE_NOT_JSON.',
    )
    expect(
      settingsDecisionLine(
        {
          ...authority,
          move: {
            ...move('failed'),
            failure: { kind: 'cause', code: 'EACCES' },
            cause: new Error('private stored value'),
          },
        },
        completion(false),
      ),
    ).toBe(text.legacyFailed('EACCES'))
    expect(
      settingsDecisionLine(
        {
          ...authority,
          move: { ...move('failed'), cause: 'private stored value' },
        },
        completion(false),
      ),
    ).toBe(text.legacyFailed('SETTINGS_MOVE_FAILED'))
  })

  it('requires an actual move by this process and no observed removal for the moved line', async () => {
    const { install } = await fixture()
    const authority: SettingsAuthorityResult = {
      install,
      decision: 'shared',
      ranMove: true,
      move: move('moved'),
    }
    expect(settingsDecisionLine(authority, completion(false))).toBe(
      text.sharedMissing,
    )
    expect(settingsDecisionLine(authority, completion(true))).toBe(
      text.sharedMoved,
    )
    expect(settingsDecisionLine(authority, completion(true), true)).toBe(
      text.sharedFound,
    )
    expect(
      settingsDecisionLine({ ...authority, ranMove: false }, completion(true)),
    ).toBe(text.sharedFound)
    for (const outcome of ['done-already', 'aborted-target-appeared'] as const)
      expect(
        settingsDecisionLine(
          { ...authority, move: move(outcome) },
          completion(true),
        ),
      ).toBe(text.sharedFound)
  })
})

describe('config-scoped Diagnostics section', () => {
  it('fails clearly if startup never decided this config file', async () => {
    const { open } = await fixture()
    await expect(open()).rejects.toThrow(
      'Settings authority has not been decided',
    )
  })

  it('isolates a separate install from a shared instance and all settings probes', async () => {
    const shared = await fixture({ target: '{}' })
    const separate = await fixture({
      separate: true,
      source: '{"routing":{"mode":"sticky-balanced"}}',
      target: 'invalid',
    })
    await Promise.all([shared.start(), separate.start()])
    const snapshot = {
      async refresh() {
        throw new Error('Separate install must not refresh settings')
      },
      report(): ReportEntry[] {
        throw new Error('Separate install must not report settings')
      },
    }
    const section = settingsDiagnosticsSection({
      configPath: separate.install.configIdentity,
      snapshot,
      log: separate.log,
    })
    expect(section.title).toBe('Diagnostics')
    expect(await section.build()).toEqual({
      lines: ["Settings stay in this install's account store."],
    })
    expect(await shared.open()).toEqual({
      lines: [text.file(shared.install.target), text.sharedFound],
    })
    expect(await section.build()).toEqual({ lines: [text.separate] })
    expect(separate.warnings).toEqual([])
  })

  it('reselects defaults and file-found on every open of a fresh install', async () => {
    const f = await fixture()
    await f.start()
    expect(await f.open()).toEqual({
      lines: [text.file(f.install.target), text.sharedMissing],
    })
    await put(f.install.target, '{}')
    expect(await f.open()).toEqual({
      lines: [text.file(f.install.target), text.sharedFound],
    })
    expect(f.warnings).toEqual([])
  })

  it('forgets moved-now after observing a removal, even when a menu recreates the file', async () => {
    const f = await fixture({
      source: '{"routing":{"mode":"sticky-balanced"}}',
    })
    expect((await f.start()).move?.outcome).toBe('moved')
    expect(await f.open()).toEqual({
      lines: [text.file(f.install.target), text.sharedMoved],
    })
    await rm(f.install.target)
    expect(await f.open()).toEqual({
      lines: [
        text.file(f.install.target),
        text.sharedMissing,
        text.removedFile(f.install.target),
      ],
    })
    const handle = openSettings(openaiSettings, {
      file: f.install.target,
      separateInstall: false,
      createMissing: true,
      log: { warn() {}, info() {} },
    })
    await handle.update(
      [{ setting: 'routing_mode', value: 'sticky-balanced' }],
      { host: 'opencode' },
    )
    expect(await f.open()).toEqual({
      lines: [text.file(f.install.target), text.sharedFound],
    })
    expect(f.warnings).toEqual([text.removedFile(f.install.target)])
  })

  it('shows notices at every open while their conditions hold but logs each only once', async () => {
    const f = await fixture({
      source: '{"routing":{"mode":"sticky-balanced"}}',
      target: '{}',
    })
    await f.start()
    const existing = text.preExistingFile(f.install.target)
    for (let i = 0; i < 2; i++)
      expect((await f.open()).lines).toEqual([
        text.file(f.install.target),
        text.sharedFound,
        existing,
      ])
    expect(f.warnings).toEqual([existing])
    const note = `${f.install.configIdentity}.MOVED_READPLEASE`
    await put(
      note,
      `Settings moved to ${f.install.target}.\nA rollback loses changes made after the move.\n`,
    )
    expect((await f.open()).lines).toEqual([
      text.file(f.install.target),
      text.sharedFound,
    ])
    await rm(f.install.target)
    const removed = text.removedFile(f.install.target)
    for (let i = 0; i < 2; i++)
      expect((await f.open()).lines).toEqual([
        text.file(f.install.target),
        text.sharedMissing,
        removed,
      ])
    expect(f.warnings).toEqual([existing, removed])
    await put(f.install.target, '{}')
    await rm(note)
    expect((await f.open()).lines).toEqual([
      text.file(f.install.target),
      text.sharedFound,
      existing,
    ])
    expect(f.warnings).toEqual([existing, removed])
  })

  it('shares once-per-process notice logging across config files using the same target', async () => {
    const first = await fixture({
      source: '{"routing":{"mode":"sticky-balanced"}}',
      target: '{}',
    })
    const second = await fixture()
    second.install.target = first.install.target
    second.install.sources = first.install.sources
    await first.start()
    await second.start()
    await first.open()
    expect((await second.open()).lines).toContain(
      text.preExistingFile(first.install.target),
    )
    expect(first.warnings).toEqual([text.preExistingFile(first.install.target)])
    expect(second.warnings).toEqual([])
  })

  it('remembers a target removal observed through another config in the same process', async () => {
    const mover = await fixture({
      source: '{"routing":{"mode":"sticky-balanced"}}',
    })
    const other = await fixture()
    other.install.target = mover.install.target
    other.install.sources = mover.install.sources
    await mover.start()
    await other.start()
    expect((await mover.open()).lines).toContain(text.sharedMoved)
    await rm(mover.install.target)
    expect((await other.open()).lines).toContain(text.sharedMissing)
    await put(mover.install.target, '{}')
    expect((await mover.open()).lines).toEqual([
      text.file(mover.install.target),
      text.sharedFound,
    ])
  })

  it('refreshes report and all four semantic checks when the watcher has not run', async () => {
    const f = await fixture({ target: '{}' })
    await f.start()
    const handle = openSettings(openaiSettings, {
      file: f.install.target,
      separateInstall: false,
      createMissing: true,
      log: { warn() {}, info() {} },
    })
    const snapshot = await createSettingsSnapshot({
      handle: { ...handle, watch: () => () => {} },
      file: f.install.target,
      host: 'opencode',
    })
    snapshots.push(snapshot)
    await put(
      f.install.target,
      JSON.stringify({
        unknown: 'private stored value',
        killswitch_enabled: 'private stored value',
        killswitch_account_floors: [
          { account: 'main', host: 'both', primary: 10, secondary: 20 },
          { account: 'main', host: 'both', primary: 30, secondary: 40 },
        ],
        quota_minimum_remaining: [
          { window: 'primary', floor: 20 },
          { window: 'primary', floor: 30 },
        ],
        cache_keep_window: [{ start_hour: 1, end_hour: 1 }],
      }),
    )
    expect(snapshot.report()).toEqual([])
    const { lines } = await f.open(snapshot)
    expect(lines).toEqual([
      text.file(f.install.target),
      text.sharedFound,
      text.report['unknown-key']('unknown'),
      text.report['invalid-value']('killswitch_enabled'),
      text.checks.duplicateFloors,
      text.checks.localBoth,
      text.checks.duplicateQuota,
      text.checks.warmWindow,
    ])
    expect(lines.join('\n')).not.toContain('private stored value')
    await put(f.install.target, 'not json')
    expect((await f.open(snapshot)).lines).toContain(
      text.report.unparseable(f.install.target),
    )
    await put(f.install.target, '{}')
    expect(await f.open(snapshot)).toEqual({
      lines: [text.file(f.install.target), text.sharedFound],
    })
  })

  it('keeps a failed move visible on every open and never shows the source value', async () => {
    const f = await fixture({
      source: '{"quota":{"checkIntervalMinutes":"private stored value"}}',
    })
    expect((await f.start()).decision).toBe('legacy')
    for (let i = 0; i < 2; i++) {
      const { lines } = await f.open()
      expect(lines).toEqual([
        text.file(f.install.target),
        text.legacySetting('quota_check_interval_minutes'),
      ])
      expect(lines.join('\n')).not.toContain('private stored value')
    }
  })

  it('names the source file and safe cause for an unreadable move', async () => {
    const f = await fixture({ source: 'private non-json source value' })
    await f.start()
    expect((await f.open()).lines).toEqual([
      text.file(f.install.target),
      text.legacyFailed(
        `opencode ${f.install.configIdentity}: SOURCE_NOT_JSON`,
      ),
    ])
  })

  it('renders refused startup with the records folder and cause, and never opens settings', async () => {
    const f = await fixture({ source: 'not json' })
    const error = await f
      .start(async () => {
        throw new Error('permission denied')
      })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SettingsAuthorityRefusal)
    if (!(error instanceof SettingsAuthorityRefusal))
      throw new Error('Expected authority refusal')
    const snapshot = {
      async refresh() {
        throw new Error('Refused startup must not refresh settings')
      },
      report(): ReportEntry[] {
        throw new Error('Refused startup must not report settings')
      },
    }
    expect(await f.open(snapshot)).toEqual({
      lines: [text.refused(error.folder, 'permission denied')],
    })
  })
})
