import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { moveSettingsOnce } from '@cortexkit/common-auth/settings'
import { openaiSettings } from '../settings-definition.ts'
import {
  readSettingsNoteTarget,
  settingsNoteNamesTarget,
  settingsNoteTarget,
} from '../settings-note.ts'

let root: string
let source: string

beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  mkdirSync(scratch, { recursive: true })
  root = realpathSync.native(mkdtempSync(join(scratch, 'settings-note-')))
  source = join(root, 'old-store.json')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('move note target reader', () => {
  it.each([
    '',
    'Settings moved to /target',
    'Settings moved to /target. trailing text',
    ' Settings moved to /target.',
    'Other text\nSettings moved to /target.\n',
    'settings moved to /target.',
    '{"target":"/target"}',
  ])(
    'content without the exact first-line shape names no target: %j',
    (text) => {
      expect(settingsNoteTarget(text)).toBeUndefined()
    },
  )

  it.each([
    '/folder with spaces/settings.jsonc',
    '/folder.with.periods/settings.jsonc',
    'C:\\Users\\person\\settings.jsonc',
    '/folder/"quoted" settings.jsonc',
    '/folder/設定.jsonc',
    '/folder/trailing-dot.',
  ])('reads the target text without unescaping: %s', (target) => {
    expect(
      settingsNoteTarget(
        `Settings moved to ${target}.\nA rollback loses changes made after the move.\n`,
      ),
    ).toBe(target)
  })

  it('uses only the first line, without requiring the rollback line', () => {
    expect(settingsNoteTarget('Settings moved to /chosen.jsonc.')).toBe(
      '/chosen.jsonc',
    )
    expect(
      settingsNoteTarget('Settings moved to /chosen.jsonc.\nother text'),
    ).toBe('/chosen.jsonc')
    expect(
      settingsNoteTarget('Settings moved to /chosen.jsonc.\r\nother text'),
    ).toBe('/chosen.jsonc')
  })

  it('a missing, unreadable or malformed note names no target', () => {
    expect(readSettingsNoteTarget(source)).toBeUndefined()
    mkdirSync(`${source}.MOVED_READPLEASE`)
    expect(readSettingsNoteTarget(source)).toBeUndefined()
    rmSync(`${source}.MOVED_READPLEASE`, { recursive: true })
    writeFileSync(`${source}.MOVED_READPLEASE`, 'unknown note format')
    expect(readSettingsNoteTarget(source)).toBeUndefined()
    expect(settingsNoteNamesTarget(source, join(root, 'settings.jsonc'))).toBe(
      false,
    )
  })

  it.each([false, true])(
    'compares note targets by real path identity, present=%s',
    (present) => {
      const actual = join(root, 'actual')
      const alias = join(root, 'alias')
      mkdirSync(actual)
      symlinkSync(actual, alias, 'junction')
      const target = join(actual, 'not', 'created', 'settings.jsonc')
      if (present) {
        mkdirSync(join(actual, 'not', 'created'), { recursive: true })
        writeFileSync(target, '{}')
      }
      writeFileSync(
        `${source}.MOVED_READPLEASE`,
        `Settings moved to ${join(alias, 'not', 'created', 'settings.jsonc')}.\n`,
      )
      expect(settingsNoteNamesTarget(source, target)).toBe(true)
      expect(
        settingsNoteNamesTarget(source, join(actual, 'different.jsonc')),
      ).toBe(false)
    },
  )

  it('reads the exact unescaped bytes written by common-auth writeNotes', async () => {
    const target = join(root, 'spaces and 設定', 'settings.jsonc')
    writeFileSync(source, '{}')
    const result = await moveSettingsOnce({
      definition: openaiSettings,
      target,
      separateInstall: false,
      sources: [
        { host: 'opencode', path: source, locks: [], read: JSON.parse },
      ],
      map: () => ({ entries: [], unmapped: [] }),
      fence: () => true,
      log: { warn() {}, info() {} },
    })
    expect(result.outcome).toBe('moved')
    expect(result.noteFailures).toEqual([])
    expect(readFileSync(`${source}.MOVED_READPLEASE`, 'utf8')).toBe(
      `Settings moved to ${target}.\nA rollback loses changes made after the move.\n`,
    )
    expect(readSettingsNoteTarget(source)).toBe(target)
    expect(settingsNoteNamesTarget(source, target)).toBe(true)
    rmSync(target)
    expect(settingsNoteNamesTarget(source, target)).toBe(true)
  })
})
