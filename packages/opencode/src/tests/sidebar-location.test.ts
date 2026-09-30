import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSidebarState,
  getSidebarStateFile,
  setLegacySidebarStateFileForTest,
} from '../sidebar-state'
import { restoreEnv, unsetEnv } from './setup-env'

const FILE_ENV = 'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'

let root: string
let savedFile: string | undefined
let savedStateHome: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sidebar-location-'))
  savedFile = process.env[FILE_ENV]
  savedStateHome = process.env.XDG_STATE_HOME
  unsetEnv(FILE_ENV)
  process.env.XDG_STATE_HOME = join(root, 'state')
})

afterEach(async () => {
  restoreEnv(FILE_ENV, savedFile)
  restoreEnv('XDG_STATE_HOME', savedStateHome)
  await rm(root, { recursive: true, force: true })
})

const PINNED_AT = Date.now()
const pinnedState = (session: string) =>
  JSON.stringify({
    version: 1,
    stickyAssignments: {
      [session]: {
        accountId: 'main',
        assignedAt: PINNED_AT,
        lastSeenAt: PINNED_AT,
        inputBytes: 0,
      },
    },
  })

describe('sidebar state location', () => {
  test('defaults to the user state directory, not the temp folder', () => {
    expect(getSidebarStateFile()).toBe(
      join(root, 'state', 'cortexkit', 'openai-auth', 'sidebar-state.json'),
    )
  })

  test('the file override still wins', () => {
    process.env[FILE_ENV] = join(root, 'custom.json')
    expect(getSidebarStateFile()).toBe(join(root, 'custom.json'))
  })

  test('the first read imports the old temp-folder file once, leaving it in place', async () => {
    const session = 'a'.repeat(64)
    const legacy = join(root, 'legacy', 'sidebar-state.json')
    await mkdir(join(root, 'legacy'), { recursive: true })
    await writeFile(legacy, pinnedState(session))
    setLegacySidebarStateFileForTest(legacy)

    const state = await getSidebarState()
    expect(Object.keys(state.stickyAssignments ?? {})).toEqual([session])
    expect(await readFile(getSidebarStateFile(), 'utf8')).toBe(
      pinnedState(session),
    )
    expect((await stat(legacy)).isFile()).toBe(true)
  })

  test('an existing file in the new location is never overwritten by the old one', async () => {
    const legacy = join(root, 'legacy', 'sidebar-state.json')
    await mkdir(join(root, 'legacy'), { recursive: true })
    await writeFile(legacy, pinnedState('b'.repeat(64)))
    setLegacySidebarStateFileForTest(legacy)
    // Built by hand: resolving it through getSidebarStateFile would run the
    // import before this file exists.
    const current = join(
      root,
      'state',
      'cortexkit',
      'openai-auth',
      'sidebar-state.json',
    )
    await mkdir(join(current, '..'), { recursive: true })
    await writeFile(current, pinnedState('c'.repeat(64)))

    const state = await getSidebarState()
    expect(Object.keys(state.stickyAssignments ?? {})).toEqual(['c'.repeat(64)])
  })
})
