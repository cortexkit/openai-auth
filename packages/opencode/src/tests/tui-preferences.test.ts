import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeEffectiveOrder,
  DEFAULT_PREFS,
  getTuiPreferencesFile,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveOpenaiAuthPrefs,
  TUI_PREFS_FILE_ENV,
} from '../tui-preferences'
import { unsetEnv } from './setup-env'

let dir: string
let file: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [TUI_PREFS_FILE_ENV, 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME']

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  dir = await mkdtemp(join(tmpdir(), 'tui-prefs-test-'))
  file = join(dir, 'tui-preferences.jsonc')
  process.env[TUI_PREFS_FILE_ENV] = file
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await rm(dir, { recursive: true, force: true })
})

describe('getTuiPreferencesFile', () => {
  test('env override wins', () => {
    expect(getTuiPreferencesFile()).toBe(file)
  })

  test('OPENCODE_CONFIG_DIR beats XDG_CONFIG_HOME', () => {
    delete process.env[TUI_PREFS_FILE_ENV]
    process.env.OPENCODE_CONFIG_DIR = '/cfg/opencode-dir'
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getTuiPreferencesFile()).toBe(
      '/cfg/opencode-dir/tui-preferences.jsonc',
    )
  })

  test('XDG_CONFIG_HOME fallback appends opencode/', () => {
    delete process.env[TUI_PREFS_FILE_ENV]
    unsetEnv('OPENCODE_CONFIG_DIR')
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getTuiPreferencesFile()).toBe('/xdg/opencode/tui-preferences.jsonc')
  })
})

describe('resolveOpenaiAuthPrefs', () => {
  test('empty root yields defaults', () => {
    const prefs = resolveOpenaiAuthPrefs({})
    expect(prefs).toEqual(DEFAULT_PREFS)
    expect(prefs.order).toBe(160)
    expect(prefs.collapsed).toBeNull()
  })

  test('valid values pass through', () => {
    const prefs = resolveOpenaiAuthPrefs({
      'openai-auth': {
        forceToTop: true,
        order: -500,
        startCollapsed: true,
        rememberCollapsed: false,
        collapsed: true,
        pollMs: 5000,
        refreshDebounceMs: 100,
        header: { label: 'QUOTA', showVersion: false },
        sections: { routing: false },
        appearance: { barWidth: 20, warnThreshold: 60, errorThreshold: 90 },
      },
    })
    expect(prefs.forceToTop).toBe(true)
    expect(prefs.order).toBe(-500)
    expect(prefs.startCollapsed).toBe(true)
    expect(prefs.rememberCollapsed).toBe(false)
    expect(prefs.collapsed).toBe(true)
    expect(prefs.pollMs).toBe(5000)
    expect(prefs.refreshDebounceMs).toBe(100)
    expect(prefs.header).toEqual({ label: 'QUOTA', showVersion: false })
    expect(prefs.sections).toEqual({
      quota: true,
      fallbackAccounts: true,
      routing: false,
      health: true,
      pacing: true,
    })
    expect(prefs.appearance.barWidth).toBe(20)
    expect(prefs.appearance.warnThreshold).toBe(60)
    expect(prefs.appearance.errorThreshold).toBe(90)
  })

  test('numbers are clamped to their ranges', () => {
    const prefs = resolveOpenaiAuthPrefs({
      'openai-auth': {
        order: 99999999,
        pollMs: 1,
        refreshDebounceMs: 999999,
        appearance: { barWidth: 1000, warnThreshold: -5, errorThreshold: 400 },
      },
    })
    expect(prefs.order).toBe(10000)
    expect(prefs.pollMs).toBe(500)
    expect(prefs.refreshDebounceMs).toBe(5000)
    expect(prefs.appearance.barWidth).toBe(40)
    expect(prefs.appearance.warnThreshold).toBe(0)
    expect(prefs.appearance.errorThreshold).toBe(100)
  })

  test('errorThreshold is forced above warnThreshold', () => {
    const prefs = resolveOpenaiAuthPrefs({
      'openai-auth': {
        appearance: { warnThreshold: 80, errorThreshold: 30 },
      },
    })
    expect(prefs.appearance.warnThreshold).toBe(80)
    expect(prefs.appearance.errorThreshold).toBe(81)
  })

  test('warnThreshold is clamped to 0..99 so error can stay strictly above it', () => {
    const prefs = resolveOpenaiAuthPrefs({
      'openai-auth': {
        appearance: { warnThreshold: 100, errorThreshold: 30 },
      },
    })
    expect(prefs.appearance.warnThreshold).toBe(99)
    expect(prefs.appearance.errorThreshold).toBe(100)
  })

  test('label is truncated to 20 chars and empty label falls back', () => {
    const long = resolveOpenaiAuthPrefs({
      'openai-auth': { header: { label: 'X'.repeat(50) } },
    })
    expect(long.header.label).toBe('X'.repeat(20))
    const empty = resolveOpenaiAuthPrefs({
      'openai-auth': { header: { label: '' } },
    })
    expect(empty.header.label).toBe('OPENAI')
  })

  test('bar chars reduce to first code point', () => {
    const prefs = resolveOpenaiAuthPrefs({
      'openai-auth': {
        appearance: { barFilledChar: 'abc', barEmptyChar: '🟦🟦' },
      },
    })
    expect(prefs.appearance.barFilledChar).toBe('a')
    expect(prefs.appearance.barEmptyChar).toBe('🟦')
  })

  test('wrong types fall back per key, unknown keys ignored', () => {
    const prefs = resolveOpenaiAuthPrefs({
      'openai-auth': {
        forceToTop: 'yes',
        order: 'high',
        pollMs: null,
        header: 'big',
        sections: { quota: 1, bogus: true },
        appearance: { barWidth: '12' },
        somethingElse: { nested: true },
      },
    })
    expect(prefs.forceToTop).toBe(false)
    expect(prefs.order).toBe(160)
    expect(prefs.pollMs).toBe(1500)
    expect(prefs.header).toEqual(DEFAULT_PREFS.header)
    expect(prefs.sections.quota).toBe(true)
    expect(prefs.appearance.barWidth).toBe(10)
    expect('bogus' in prefs.sections).toBe(false)
  })

  test('non-object plugin entry yields defaults', () => {
    expect(resolveOpenaiAuthPrefs({ 'openai-auth': 42 })).toEqual(DEFAULT_PREFS)
  })

  test('sections.pacing defaults true, accepts false, rejects wrong type', () => {
    expect(resolveOpenaiAuthPrefs({}).sections.pacing).toBe(true)
    expect(
      resolveOpenaiAuthPrefs({
        'openai-auth': { sections: { pacing: false } },
      }).sections.pacing,
    ).toBe(false)
    expect(
      resolveOpenaiAuthPrefs({
        'openai-auth': { sections: { pacing: 'off' } },
      }).sections.pacing,
    ).toBe(true)
  })
})

describe('computeEffectiveOrder', () => {
  test('missing key returns default order', () => {
    expect(computeEffectiveOrder({}, 'openai-auth', 160)).toBe(160)
  })

  test('explicit order knob is used and clamped', () => {
    expect(
      computeEffectiveOrder(
        { 'openai-auth': { order: 42 } },
        'openai-auth',
        160,
      ),
    ).toBe(42)
    expect(
      computeEffectiveOrder(
        { 'openai-auth': { order: -99999999 } },
        'openai-auth',
        160,
      ),
    ).toBe(-10000)
  })

  test('forceToTop beats any explicit order', () => {
    expect(
      computeEffectiveOrder(
        { 'openai-auth': { forceToTop: true, order: -10000 } },
        'openai-auth',
        160,
      ),
    ).toBe(-100000)
  })

  test('multiple forced plugins order by key position in file', () => {
    const root = {
      'plugin-a': { forceToTop: true },
      'plugin-b': { order: 5 },
      'plugin-c': { forceToTop: true },
    }
    expect(computeEffectiveOrder(root, 'plugin-a', 0)).toBe(-100000)
    expect(computeEffectiveOrder(root, 'plugin-c', 0)).toBe(-99998)
    expect(computeEffectiveOrder(root, 'plugin-b', 0)).toBe(5)
  })

  test('non-boolean forceToTop is ignored', () => {
    expect(
      computeEffectiveOrder(
        { 'openai-auth': { forceToTop: 'yes' } },
        'openai-auth',
        160,
      ),
    ).toBe(160)
  })
})

// The shared reader, writer and watcher are tested in @cortexkit/common-auth.
// These pin what this plugin adds on top: its own header on a file it creates,
// and updates that never reject.
describe('openai-auth preferences writer', () => {
  test('a file this plugin creates starts with the openai-auth header', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const text = await readFile(file, 'utf8')
    expect(text).toStartWith(
      '// Shared preferences for opencode TUI plugins.\n// One top-level key per plugin (short name).',
    )
    expect(await readTuiPreferencesFile()).toEqual({
      'openai-auth': { collapsed: true },
    })
  })

  test('a failed update resolves instead of rejecting', async () => {
    // A regular file where the preferences directory should be makes both the
    // directory creation and the write fail.
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, 'x', 'utf8')
    process.env[TUI_PREFS_FILE_ENV] = join(blocker, 'tui-preferences.jsonc')
    await expect(
      queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true),
    ).resolves.toBeUndefined()
  })
})
