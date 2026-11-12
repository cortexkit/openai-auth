import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { migrateIfNeeded } from '../accounts.ts'
import {
  hasMappedPreferenceKeys,
  inspectSettingsCompletion,
} from '../settings-completion.ts'
import { openaiSettings } from '../settings-definition.ts'
import {
  resolveDefaultSettingsStores,
  resolveSettingsInstall,
  type SettingsHost,
  type SettingsInstall,
} from '../settings-install.ts'

let root: string
let install: SettingsInstall
const hosts: SettingsHost[] = ['opencode', 'pi']

beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  fs.mkdirSync(scratch, { recursive: true })
  root = fs.realpathSync.native(
    fs.mkdtempSync(join(scratch, 'settings-completion-')),
  )
  const options = { env: {}, homedir: () => join(root, 'home') }
  const paths = resolveDefaultSettingsStores(options)[0]
  install = resolveSettingsInstall({ ...options, host: 'opencode', paths })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function seed(path: string, text = '{}') {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, text)
}

function note(source: number, target = install.target) {
  seed(
    `${install.sources[source]!.configPath}.MOVED_READPLEASE`,
    `Settings moved to ${target}.\nA rollback loses changes made after the move.\n`,
  )
}

describe('completed settings moves', () => {
  it('classifies all four starts without creating a file', () => {
    expect(inspectSettingsCompletion(install)).toEqual({
      kind: 'no-source',
      completed: false,
      targetExists: false,
      noteNamesTarget: false,
      sourcePresent: false,
      preExistingFile: false,
      removedFile: false,
    })
    seed(install.sources[1]!.configPath)
    expect(inspectSettingsCompletion(install)).toEqual({
      kind: 'move-needed',
      completed: false,
      targetExists: false,
      noteNamesTarget: false,
      sourcePresent: true,
      preExistingFile: false,
      removedFile: false,
    })
    note(1)
    expect(inspectSettingsCompletion(install)).toEqual({
      kind: 'target-removed',
      completed: true,
      targetExists: false,
      noteNamesTarget: true,
      sourcePresent: true,
      preExistingFile: false,
      removedFile: true,
    })
    seed(install.target, 'not JSON: completion never parses the target')
    expect(inspectSettingsCompletion(install)).toEqual({
      kind: 'target-exists',
      completed: true,
      targetExists: true,
      noteNamesTarget: true,
      sourcePresent: true,
      preExistingFile: false,
      removedFile: false,
    })
  })

  it('only a config file, not a state file, makes a source present', () => {
    for (const source of install.sources) seed(source.statePath)
    expect(inspectSettingsCompletion(install).kind).toBe('no-source')
    expect(fs.existsSync(install.target)).toBe(false)
    seed(install.sources[1]!.configPath)
    expect(inspectSettingsCompletion(install).kind).toBe('move-needed')
  })

  it.each([0, 1])(
    'a note beside source %s counts without its config',
    (index) => {
      note(index)
      const result = inspectSettingsCompletion(install)
      expect(result.completed).toBe(true)
      expect(result.sourcePresent).toBe(false)
      expect(result.removedFile).toBe(true)
    },
  )

  it.each([false, true])(
    'matches real path identities, target exists=%s',
    (exists) => {
      const actual = join(root, 'actual')
      const alias = join(root, 'alias')
      fs.mkdirSync(actual)
      fs.symlinkSync(actual, alias, 'junction')
      install.target = join(actual, 'not', 'created', 'settings.jsonc')
      note(0, join(alias, 'not', 'created', 'settings.jsonc'))
      if (exists) seed(install.target)
      const result = inspectSettingsCompletion(install)
      expect(result.noteNamesTarget).toBe(true)
      expect(result.completed).toBe(true)
      expect(result.removedFile).toBe(!exists)
    },
  )

  it.each([
    'Settings moved to /another/install/settings.jsonc.\n',
    'unknown note format',
    'Other text\nSettings moved to /target.\n',
  ])('ignores an unrelated or malformed note: %s', (text) => {
    seed(install.sources[0]!.configPath, '{"routing":{"mode":"ordered"}}')
    seed(`${install.sources[0]!.configPath}.MOVED_READPLEASE`, text)
    expect(inspectSettingsCompletion(install).kind).toBe('move-needed')
    seed(install.target)
    const result = inspectSettingsCompletion(install)
    expect(result.noteNamesTarget).toBe(false)
    expect(result.preExistingFile).toBe(true)
  })

  it('a note outside this install sources never completes its move', () => {
    const unrelated = join(root, 'other-store.json')
    seed(
      `${unrelated}.MOVED_READPLEASE`,
      `Settings moved to ${install.target}.\n`,
    )
    expect(inspectSettingsCompletion(install).kind).toBe('no-source')
    expect(
      inspectSettingsCompletion({ target: install.target, sources: [] }).kind,
    ).toBe('no-source')
  })
})

describe('completion notices', () => {
  it.each(hosts)('needs a mapped preference in a present %s source', (host) => {
    const source = install.sources.find((item) => item.host === host)!
    seed(install.target)
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(false)
    seed(source.configPath, '{"version":1,"accounts":[]}')
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(false)
    seed(source.configPath, '{"killswitch":{"enabled":"invalid"}}')
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(true)
    note(0)
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(false)
  })

  it('keeps notices current after removal, recreation and source edits', () => {
    seed(install.sources[0]!.configPath, '{"routing":{"mode":null}}')
    seed(install.target)
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(true)
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(true)
    note(1)
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(false)
    fs.rmSync(install.target)
    expect(inspectSettingsCompletion(install).removedFile).toBe(true)
    seed(install.target)
    expect(inspectSettingsCompletion(install).removedFile).toBe(false)
    fs.rmSync(`${install.sources[1]!.configPath}.MOVED_READPLEASE`)
    seed(install.sources[0]!.configPath)
    expect(inspectSettingsCompletion(install).preExistingFile).toBe(false)
  })

  it.each([false, true])(
    'publication with no matching note can move again after removal, older note=%s',
    (olderNote) => {
      seed(install.sources[0]!.configPath, '{"killswitch":{"enabled":true}}')
      if (olderNote) note(0, join(root, 'sandbox', 'settings.jsonc'))
      // Publication alone is authoritative even when every note failed, or an
      // older note was preserved. Removing that target loses completion proof.
      seed(install.target)
      expect(inspectSettingsCompletion(install).preExistingFile).toBe(true)
      fs.rmSync(install.target)
      const result = inspectSettingsCompletion(install)
      expect(result.kind).toBe('move-needed')
      expect(result.completed).toBe(false)
      expect(result.removedFile).toBe(false)
    },
  )

  it('a fresh install stays notice-free after its first edit and restart', () => {
    expect(inspectSettingsCompletion(install).kind).toBe('no-source')
    seed(install.target, '{"routing_mode":"ordered"}')
    const result = inspectSettingsCompletion({ ...install })
    expect(result.completed).toBe(true)
    expect(result.preExistingFile).toBe(false)
  })

  it('a token migration creates a source with no preference key', async () => {
    seed(install.target)
    await migrateIfNeeded(
      {
        type: 'oauth',
        access: 'test-access',
        refresh: 'test-refresh',
        expires: 0,
      },
      install.sources[0]!,
    )
    const result = inspectSettingsCompletion(install)
    expect(result.sourcePresent).toBe(true)
    expect(result.preExistingFile).toBe(false)
  })
})

describe('key-name-only preference probe', () => {
  const both = [true, true]
  const opencodeOnly = [true, false]
  const neither = [false, false]
  const fixtures: [string, unknown, boolean[]][] = [
    ['mode', { routing: { mode: null } }, both],
    ['wait', { routing: { maxSameAccountWait: 0 } }, both],
    ['fallback', { fallbackOn: [] }, both],
    ['refresh switch', { refresh: { enabled: false } }, opencodeOnly],
    [
      'refresh timing',
      { refresh: { refreshBeforeExpiryMinutes: 'abc' } },
      both,
    ],
    ['quota switch', { quota: { enabled: false } }, both],
    ['quota polling', { quota: { checkIntervalMinutes: null } }, opencodeOnly],
    ['quota primary', { quota: { minimumRemaining: { primary: null } } }, both],
    ['quota 5h alias', { quota: { minimumRemaining: { '5h': null } } }, both],
    [
      'quota secondary',
      { quota: { minimumRemaining: { secondary: null } } },
      both,
    ],
    ['quota 1w alias', { quota: { minimumRemaining: { '1w': null } } }, both],
    ['quota closed', { quota: { failClosedOnUnknownQuota: false } }, both],
    ['cost switch', { costZeroing: { enabled: false } }, opencodeOnly],
    ['killswitch switch', { killswitch: { enabled: 'yes' } }, both],
    ['floors default', { killswitch: { defaults: { primary: null } } }, both],
    ['old main', { killswitch: { main: { secondary: null } } }, both],
    ['old main 5h', { killswitch: { main: { '5h': null } } }, both],
    ['old main 1w', { killswitch: { main: { '1w': null } } }, both],
    ['account floors', { killswitch: { accounts: {} } }, both],
    ['cache', { cacheKeep: { enabled: null } }, opencodeOnly],
    ['old cache', { cachekeep: { enabled: null } }, opencodeOnly],
    ['cache window', { cacheKeep: { startHour: null } }, opencodeOnly],
    ['old cache window', { cachekeep: { endHour: null } }, opencodeOnly],
    ['logging', { logging: { level: null } }, opencodeOnly],
    ['dump scalar', { dump: false }, opencodeOnly],
    ['dump object', { dump: { enabled: null } }, opencodeOnly],
    ['dump dir', { dumpDir: '' }, opencodeOnly],
    ['dump size', { dumpMaxBytes: 0 }, opencodeOnly],
    ['web sockets', { webSockets: false }, opencodeOnly],
    ['raw web socket', { rawWebSocket: false }, opencodeOnly],
    ['responses lite', { responsesLite: false }, opencodeOnly],
    ['endpoint', { codexApiEndpoint: null }, opencodeOnly],
    ['retired quota poll', { quota: { refreshEveryNRequests: 1 } }, neither],
    ['retired preference', { routing: { removedPreference: true } }, neither],
    ['empty containers', { routing: {}, refresh: {}, quota: {} }, neither],
    ['invalid container', { routing: null, quota: 'invalid' }, neither],
    ['format marker', { killswitch: { schema: 'floors-v1' } }, neither],
    ['account state', { version: 1, main: {}, accounts: [{}] }, neither],
    [
      'runtime state',
      {
        refresh: {
          mainLastRefreshError: 'error',
          mainRefreshLeaseId: 'lease',
          mainRefreshLeaseUntil: 1,
          mainRefreshLeaseTokenHash: 'hash',
        },
        quota: { mainQuota: {}, mainQuotaCheckedAt: 1 },
      },
      neither,
    ],
  ]

  it.each(fixtures)(
    '%s counts only for declared source families',
    (_, value, expected) => {
      expect(hosts.map((host) => hasMappedPreferenceKeys(value, host))).toEqual(
        expected,
      )
    },
  )

  it('checks every declared alias without accessing its leaf value', () => {
    for (const setting of Object.values(openaiSettings.settings)) {
      for (const legacy of setting.legacy) {
        const value: Record<string, unknown> = {}
        let parent = value
        for (const key of legacy.path.slice(0, -1)) {
          const child = {}
          parent[key] = child
          parent = child
        }
        Object.defineProperty(parent, legacy.path.at(-1)!, {
          get() {
            throw new Error('The key probe must not read a preference value')
          },
        })
        const host = legacy.source === 'opencode-store' ? 'opencode' : 'pi'
        expect(hasMappedPreferenceKeys(value, host)).toBe(true)
      }
    }
  })

  it.each([null, false, 0, '', [], ['routing']].map((value) => [value]))(
    'non-object stores hold no mapped preference: %j',
    (value) => expect(hasMappedPreferenceKeys(value, 'opencode')).toBe(false),
  )

  it('inherited names are not saved keys', () => {
    expect(
      hasMappedPreferenceKeys(
        Object.create({ routing: { mode: 'ordered' } }),
        'opencode',
      ),
    ).toBe(false)
    expect(
      hasMappedPreferenceKeys(
        { routing: Object.create({ mode: 'ordered' }) },
        'opencode',
      ),
    ).toBe(false)
  })

  it.each(['not JSON', 'null', '[]', '42'])(
    '%s cannot block shared authority',
    (text) => {
      seed(install.sources[0]!.configPath, text)
      seed(install.sources[1]!.configPath, '{"routing":{"mode":"ordered"}}')
      seed(install.target)
      const result = inspectSettingsCompletion(install)
      expect(result.completed).toBe(true)
      expect(result.preExistingFile).toBe(true)
      fs.rmSync(install.sources[1]!.configPath)
      expect(inspectSettingsCompletion(install).preExistingFile).toBe(false)
    },
  )

  it('an unreadable source does not block a shared target', () => {
    fs.mkdirSync(install.sources[0]!.configPath, { recursive: true })
    seed(install.target)
    const result = inspectSettingsCompletion(install)
    expect(result.completed).toBe(true)
    expect(result.sourcePresent).toBe(true)
    expect(result.preExistingFile).toBe(false)
  })

  it('reads old config only for the notice, outside legacy preference reads', () => {
    const source = install.sources[0]!
    const text = '{"routing":{"mode":"saved-value-must-not-escape"}}'
    seed(source.configPath, text)
    seed(source.statePath, '{"routing":{"mode":"ordered"}}')
    seed(install.target, '{"routing_mode":"fallback-first"}')
    const read = spyOn(fs, 'readFileSync')
    const legacyRead = spyOn(promises, 'readFile')
    try {
      expect(inspectSettingsCompletion(install).kind).toBe('target-exists')
      expect(
        read.mock.calls.filter(([path]) => path === source.configPath),
      ).toHaveLength(1)
      expect(read.mock.calls.some(([path]) => path === source.statePath)).toBe(
        false,
      )
      expect(read.mock.calls.some(([path]) => path === install.target)).toBe(
        false,
      )
      expect(legacyRead).not.toHaveBeenCalled()
      read.mockClear()
      note(1)
      const matching = inspectSettingsCompletion(install)
      expect(matching.preExistingFile).toBe(false)
      expect(read.mock.calls.some(([path]) => path === source.configPath)).toBe(
        false,
      )
      expect(JSON.stringify(matching)).not.toContain(
        'saved-value-must-not-escape',
      )
      read.mockClear()
      fs.rmSync(install.target)
      expect(inspectSettingsCompletion(install).removedFile).toBe(true)
      expect(read.mock.calls.some(([path]) => path === source.configPath)).toBe(
        false,
      )
      fs.rmSync(`${install.sources[1]!.configPath}.MOVED_READPLEASE`)
      read.mockClear()
      expect(inspectSettingsCompletion(install).kind).toBe('move-needed')
      expect(read.mock.calls.some(([path]) => path === source.configPath)).toBe(
        false,
      )
      expect(legacyRead).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      legacyRead.mockRestore()
    }
    expect(fs.readFileSync(source.configPath, 'utf8')).toBe(text)
  })
})
