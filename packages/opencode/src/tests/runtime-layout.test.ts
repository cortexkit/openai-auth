// The one-time move of the runtime files (account state, vault folder, Codex
// sessions) out of OpenCode's config folder into the state home, and the
// resolver that follows it. Real files in temporary folders throughout.
//
// The tests reach new parts of the module through `layoutModule()` rather
// than named imports, so each one fails on its own assertion against a build
// that lacks them instead of the whole file failing to load.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  vaultEnrollmentName,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import {
  __resetRuntimeLayoutsForTest,
  getAccountPaths,
  getCodexSessionsPath,
  runtimeLayoutLocation,
} from '../core/account-paths'
import {
  __resetProcessHeartbeatForTest,
  processHeartbeatPath,
  startProcessHeartbeat,
} from '../core/process-heartbeat'
import * as runtimeLayout from '../core/runtime-layout'
import {
  __resetRuntimeLayoutRunsForTest,
  prepareRuntimeLayout,
  RUNTIME_LAYOUT_DEFERRED_MESSAGE,
  type RuntimeLayoutOptions,
} from '../core/runtime-layout'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { processHeartbeatDir } from '../core/version-fence'
import { restoreEnv, unsetEnv } from './setup-env'

const VERSION = '1.7.0'
const ENV_NAMES = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_OPENAI_AUTH_FILE',
  'OPENCODE_OPENAI_AUTH_STATE_FILE',
] as const
const POSIX = process.platform !== 'win32'

let root: string
let saved: Record<string, string | undefined>
let logged: { level: string; message: string; meta?: unknown }[]

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-layout-')))
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  process.env.XDG_STATE_HOME = join(root, 'state')
  unsetEnv('OPENCODE_CONFIG_DIR')
  unsetEnv('OPENCODE_OPENAI_AUTH_FILE')
  unsetEnv('OPENCODE_OPENAI_AUTH_STATE_FILE')
  resetProcess()
  logged = []
})

afterEach(() => {
  for (const name of ENV_NAMES) restoreEnv(name, saved[name])
  resetProcess()
  try {
    chmodSync(join(root, 'state'), 0o700)
  } catch {}
  rmSync(root, { recursive: true, force: true })
})

/** Stands in for a new process: nothing decided, nothing logged. */
function resetProcess() {
  __resetRuntimeLayoutsForTest()
  __resetRuntimeLayoutRunsForTest()
  __resetProcessHeartbeatForTest()
}

/** The module's exports, including ones a build might lack. */
const layoutModule = () =>
  runtimeLayout as typeof runtimeLayout & Record<string, unknown>

function prepare(options: Partial<RuntimeLayoutOptions> = {}) {
  return prepareRuntimeLayout({
    version: VERSION,
    log: {
      info: (message, meta) => logged.push({ level: 'info', message, meta }),
      warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
    },
    ...options,
  })
}

/** OpenCode's config folder in these tests: `opencode` in XDG_CONFIG_HOME. */
const configDir = () => join(root, 'config', 'opencode')
/** The state-home runtime folder the resolver names for that config folder. */
const runtimeDir = () => runtimeLayoutLocation().stateHomeDir
const stateRoot = () => join(root, 'state', 'cortexkit', 'openai-auth')

function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Every runtime file of the old layout, relative to its folder, with bytes. */
function oldLayout(tag = 'a'): Record<string, string> {
  const name = vaultEnrollmentName('opencode')
  return {
    'openai-auth-state.json': `${JSON.stringify({ version: 1, accounts: { main: { refresh: `refresh-${tag}` } } }, null, 2)}\n`,
    'openai-auth-vault/opencode-enrollment.json': JSON.stringify({
      token: '01'.repeat(32),
      token_generation: 1,
    }),
    'openai-auth-vault/opencode-enrollment-state.json': `${JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName: name,
      approvedName: name,
      tokenGeneration: 1,
      updatedAt: 1,
    })}\n`,
    'openai-auth-vault/opencode-roster.json': `${JSON.stringify({ version: 1, accounts: [], tag })}\n`,
    'openai-auth-sessions.json': `${JSON.stringify({ version: 1, sessions: { ses_1: { threadID: `t1-${tag}` } } })}\n`,
    'openai-auth-sessions-opencode2.json': `${JSON.stringify({ version: 1, sessions: { ses_2: { threadID: `t2-${tag}` } } })}\n`,
  }
}

function seed(dir: string, files: Record<string, string>) {
  for (const [relative, text] of Object.entries(files))
    writePrivate(join(dir, relative), text)
}

function present(dir: string, files: Record<string, string>) {
  return Object.fromEntries(
    Object.keys(files).map((relative) => {
      const path = join(dir, relative)
      return [relative, existsSync(path) ? readFileSync(path, 'utf8') : null]
    }),
  )
}

const absent = (files: Record<string, string>) =>
  Object.fromEntries(Object.keys(files).map((relative) => [relative, null]))

/** The approved enrollment state file, relative to the config folder. */
const VAULT_STATE = 'openai-auth-vault/opencode-enrollment-state.json'

/**
 * What a finished move leaves of `files` in the config folder: only an
 * approved enrollment state file, byte for byte, so older versions stay in
 * vault mode.
 */
const leftAfterMove = (files: Record<string, string>) => ({
  ...absent(files),
  ...(VAULT_STATE in files ? { [VAULT_STATE]: files[VAULT_STATE] } : {}),
})

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex')

function marker(dir = runtimeDir()) {
  const path = join(dir, 'layout.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function authority() {
  return enrollmentAuthority(
    hostEnrollmentPaths({
      stateDir: vaultStateDir(getAccountPaths().statePath),
      host: 'opencode',
    }),
    vaultEnrollmentName('opencode'),
  )
}

function heartbeat(pid: number, body: Record<string, unknown>) {
  const dir = processHeartbeatDir(join(root, 'state'))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${pid}.json`)
  writeFileSync(path, JSON.stringify({ pid, startedAt: 1, ...body }))
  return path
}

const REFUSED = /^openai-auth cannot start: /

const credentialConflictMessage = (relative: string) =>
  `openai-auth cannot start: runtime credentials conflict between ${join(configDir(), relative)} and ${join(runtimeDir(), relative)}. Keep the newer one, delete the other, then restart OpenCode.`

const CREDENTIAL_FILES = [
  'openai-auth-state.json',
  'openai-auth-vault/opencode-enrollment.json',
  'openai-auth-vault/opencode-enrollment-state.json',
  'openai-auth-vault/opencode-roster.json',
  'openai-auth-vault/another-credential.json',
]

describe('where the runtime folder is', () => {
  it('is opencode/ only for <home>/.config/opencode, and a keyed folder for every other config folder', async () => {
    const home = join(root, 'home')
    // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows.
    const env = (extra: Record<string, string | undefined>) => ({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: undefined,
      OPENCODE_CONFIG_DIR: undefined,
      ...extra,
    })
    const atHome = await spawnLayoutProcess('once', env({}))
    const first = await spawnLayoutProcess(
      'once',
      env({ XDG_CONFIG_HOME: join(root, 'xdg-a') }),
    )
    const second = await spawnLayoutProcess(
      'once',
      env({ XDG_CONFIG_HOME: join(root, 'xdg-b') }),
    )
    expect(atHome.result.runtimeDir).toBe(join(stateRoot(), 'opencode'))
    for (const other of [first, second])
      expect(other.result.runtimeDir).toMatch(
        /[\\/]cortexkit[\\/]openai-auth[\\/]opencode-[0-9a-f]{16}$/,
      )
    // Two XDG_CONFIG_HOME values never share a folder.
    expect(first.result.runtimeDir).not.toBe(second.result.runtimeDir)
    expect(
      JSON.parse(
        readFileSync(
          join(atHome.result.runtimeDir as string, 'config-dir.json'),
          'utf8',
        ),
      ),
    ).toEqual({ version: 1, configDir: join(home, '.config', 'opencode') })
  })

  it('names the config folder by its real path, without folding case', () => {
    const real = join(root, 'Real-Config')
    mkdirSync(real, { recursive: true })
    const link = join(root, 'link-config')
    symlinkSync(real, link, POSIX ? 'dir' : 'junction')
    process.env.OPENCODE_CONFIG_DIR = link
    const viaLink = runtimeLayoutLocation()
    expect(viaLink.key).toBe(realpathSync.native(real))
    __resetRuntimeLayoutsForTest()
    process.env.OPENCODE_CONFIG_DIR = real
    expect(runtimeLayoutLocation().stateHomeDir).toBe(viaLink.stateHomeDir)
    // A folder that does not exist yet is named by its resolved path.
    __resetRuntimeLayoutsForTest()
    process.env.OPENCODE_CONFIG_DIR = join(root, 'Not-There')
    expect(runtimeLayoutLocation().key).toBe(join(root, 'Not-There'))
  })
})

describe('the runtime layout on a fresh install', () => {
  it('writes the marker and resolves every runtime file in the state home', async () => {
    expect(await prepare()).toBe('state-home')
    expect(runtimeDir()).toMatch(/[\\/]opencode-[0-9a-f]{16}$/)
    expect(marker()).toEqual({
      version: 1,
      oldDir: runtimeLayoutLocation().key,
      oldFilesRemoved: true,
    })
    const paths = getAccountPaths()
    expect(paths.configPath).toBe(join(configDir(), 'openai-auth.json'))
    expect(paths.statePath).toBe(join(runtimeDir(), 'openai-auth-state.json'))
    expect(vaultStateDir(paths.statePath)).toBe(
      join(runtimeDir(), 'openai-auth-vault'),
    )
    expect(getCodexSessionsPath('opencode1')).toBe(
      join(runtimeDir(), 'openai-auth-sessions.json'),
    )
    expect(getCodexSessionsPath('opencode2')).toBe(
      join(runtimeDir(), 'openai-auth-sessions-opencode2.json'),
    )
    expect(
      JSON.parse(readFileSync(join(runtimeDir(), 'config-dir.json'), 'utf8')),
    ).toEqual({ version: 1, configDir: runtimeLayoutLocation().key })
    if (POSIX) expect(statSync(runtimeDir()).mode & 0o777).toBe(0o700)
    // Nothing was created in OpenCode's config folder.
    expect(existsSync(configDir())).toBe(false)
  })

  it('a tool that never prepared follows the marker alone', async () => {
    expect(getAccountPaths().statePath).toBe(
      join(configDir(), 'openai-auth-state.json'),
    )
    await prepare()
    resetProcess()
    expect(getAccountPaths().statePath).toBe(
      join(runtimeDir(), 'openai-auth-state.json'),
    )
  })
})

describe('moving an existing layout', () => {
  it('moves the state, the vault folder and both sessions files byte for byte, keeping vault mode', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    writePrivate(join(configDir(), 'openai-auth.json'), '{"keep":true}\n')
    expect(await authority()).toBe('vault')

    resetProcess()
    expect(await prepare()).toBe('state-home')

    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    // Only the approved enrollment state stays in the old vault folder.
    expect(readdirSync(join(configDir(), 'openai-auth-vault'))).toEqual([
      'opencode-enrollment-state.json',
    ])
    // The settings file stays where OpenCode users edit it.
    expect(readFileSync(join(configDir(), 'openai-auth.json'), 'utf8')).toBe(
      '{"keep":true}\n',
    )
    expect(await authority()).toBe('vault')
    expect(
      vaultPaths(vaultStateDir(getAccountPaths().statePath), 'opencode')
        .rosterPath,
    ).toBe(join(runtimeDir(), 'openai-auth-vault', 'opencode-roster.json'))
    if (POSIX) {
      for (const relative of Object.keys(files))
        expect(statSync(join(runtimeDir(), relative)).mode & 0o777).toBe(0o600)
      expect(
        statSync(join(runtimeDir(), 'openai-auth-vault')).mode & 0o777,
      ).toBe(0o700)
    }
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(join(runtimeDir(), 'layout-moving.json'))).toBe(false)
    expect(logged.map((line) => line.message)).toContain(
      "openai-auth moved its runtime files out of OpenCode's config folder",
    )
  })

  it('a crash after the copy and before the marker leaves the old files authoritative; the next start completes', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    expect(
      await prepare({
        steps: {
          afterCopy: () => {
            throw new Error('crash')
          },
        },
      }),
    ).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
    expect(getAccountPaths().statePath).toBe(
      join(configDir(), 'openai-auth-state.json'),
    )
    expect(getCodexSessionsPath('opencode2')).toBe(
      join(configDir(), 'openai-auth-sessions-opencode2.json'),
    )

    // A later start: the old files changed meanwhile (they were still
    // authoritative), so the partial copies must not survive.
    const changed: Record<string, string> = {
      ...files,
      'openai-auth-state.json': '{"refresh":"b"}\n',
    }
    seed(configDir(), changed)
    rmSync(join(configDir(), 'openai-auth-sessions.json'))
    const { 'openai-auth-sessions.json': _gone, ...remaining } = changed
    // The test's own heartbeat says legacy; this "next start" is another
    // process, which would not see its own pid.
    rmSync(processHeartbeatPath(), { force: true })
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(runtimeDir(), changed)).toEqual({
      ...remaining,
      'openai-auth-sessions.json': null,
    })
    expect(present(configDir(), changed)).toEqual(leftAfterMove(changed))
  })

  it('a crash after the marker: the next start removes identical leftovers and keeps differing sessions', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    expect(
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      }),
    ).toBe('state-home')
    expect(marker()).toEqual({
      version: 1,
      oldDir: runtimeLayoutLocation().key,
      keptVaultState: sha256(files[VAULT_STATE] as string),
    })
    expect(present(configDir(), files)).toEqual(files)
    expect(present(runtimeDir(), files)).toEqual(files)

    const differing = join(configDir(), 'openai-auth-sessions.json')
    writeFileSync(differing, '{"downgrade":true}\n')
    resetProcess()
    expect(await prepare()).toBe('state-home')
    const { 'openai-auth-sessions.json': _kept, ...identical } = files
    expect(present(configDir(), identical)).toEqual(leftAfterMove(identical))
    expect(readFileSync(differing, 'utf8')).toBe('{"downgrade":true}\n')
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        meta: expect.objectContaining({ kept: [differing] }),
      }),
    )
  })

  it.each(CREDENTIAL_FILES)(
    'refuses changed old credentials during immediate cleanup: %s',
    async (relative) => {
      const files = { ...oldLayout(), [relative]: 'original-credentials\n' }
      seed(configDir(), files)
      await expect(
        prepare({
          steps: {
            afterMarker: () => {
              writePrivate(join(configDir(), relative), 'newer-credentials\n')
            },
          },
        }),
      ).rejects.toMatchObject({
        name: 'RuntimeLayoutRefusal',
        message: credentialConflictMessage(relative),
      })
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(readFileSync(join(configDir(), relative), 'utf8')).toBe(
        'newer-credentials\n',
      )
      expect(readFileSync(join(runtimeDir(), relative), 'utf8')).toBe(
        'original-credentials\n',
      )
    },
  )

  it.each(CREDENTIAL_FILES)(
    'refuses changed old credentials when cleanup retries after a crash: %s',
    async (relative) => {
      const files = { ...oldLayout(), [relative]: 'original-credentials\n' }
      seed(configDir(), files)
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      })
      writePrivate(join(configDir(), relative), 'newer-credentials\n')
      resetProcess()
      await expect(prepare()).rejects.toMatchObject({
        name: 'RuntimeLayoutRefusal',
        message: credentialConflictMessage(relative),
      })
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(readFileSync(join(configDir(), relative), 'utf8')).toBe(
        'newer-credentials\n',
      )
      expect(readFileSync(join(runtimeDir(), relative), 'utf8')).toBe(
        'original-credentials\n',
      )
    },
  )

  it.each([
    'openai-auth-state.json',
    'openai-auth-vault/opencode-enrollment.json',
  ])(
    'refuses cleanup when the new credential copy cannot be compared: %s',
    async (relative) => {
      seed(configDir(), oldLayout())
      await expect(
        prepare({
          steps: {
            afterMarker: () => {
              rmSync(join(runtimeDir(), relative))
            },
          },
        }),
      ).rejects.toThrow(credentialConflictMessage(relative))
      expect(existsSync(join(configDir(), relative))).toBe(true)
      expect(marker()?.oldFilesRemoved).not.toBe(true)
    },
  )

  // An old credential identical to its copy that cannot be removed, as when
  // Windows holds it open, stands in here as a folder made read-only right
  // before the removal. Root ignores folder permissions, so the test needs an
  // ordinary user.
  it
    .skipIf(!POSIX || process.getuid?.() === 0)
    .each(['openai-auth-state.json', 'openai-auth-vault/opencode-roster.json'])(
    'an old credential that cannot be removed is retried at the next start, not refused: %s',
    async (relative) => {
      const files = oldLayout()
      seed(configDir(), files)
      const oldPath = join(configDir(), relative)
      const folder = dirname(oldPath)
      try {
        expect(
          await prepare({
            steps: {
              // Writable again before the next removal, so the lock files
              // in that folder can go when the move releases them.
              beforeRemove: (path) => {
                chmodSync(folder, path === oldPath ? 0o500 : 0o700)
              },
            },
          }),
        ).toBe('state-home')
      } finally {
        chmodSync(folder, 0o700)
      }
      expect(readFileSync(oldPath, 'utf8')).toBe(files[relative] as string)
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(
        logged.filter((line) =>
          line.message.startsWith('openai-auth could not finish removing'),
        ),
      ).toEqual([
        expect.objectContaining({
          level: 'warn',
          meta: expect.objectContaining({
            step: 'remove-old-copies',
            errorClass: 'old-credential-kept',
            file: basename(relative),
          }),
        }),
      ])

      // The file can be removed again: the next start finishes the cleanup
      // instead of finding a reappeared credential.
      resetProcess()
      logged = []
      expect(await prepare()).toBe('state-home')
      expect(existsSync(oldPath)).toBe(false)
      expect(present(configDir(), files)).toEqual(leftAfterMove(files))
      expect(present(runtimeDir(), files)).toEqual(files)
      expect(marker()?.oldFilesRemoved).toBe(true)
      expect(logged.filter((line) => line.level === 'warn')).toEqual([])
      resetProcess()
      expect(await prepare()).toBe('state-home')
    },
  )

  it.skipIf(!POSIX || process.getuid?.() === 0)(
    'an old credential that a later start cannot remove is logged once and retried again',
    async () => {
      const files = oldLayout()
      seed(configDir(), files)
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      })
      const oldPath = join(configDir(), 'openai-auth-state.json')
      resetProcess()
      try {
        expect(
          await prepare({
            steps: {
              beforeRemove: (path) => {
                chmodSync(configDir(), path === oldPath ? 0o500 : 0o700)
              },
            },
          }),
        ).toBe('state-home')
      } finally {
        chmodSync(configDir(), 0o700)
      }
      expect(existsSync(oldPath)).toBe(true)
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(logged).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          meta: expect.objectContaining({
            step: 'remove-old-copies',
            errorClass: 'old-credential-kept',
          }),
        }),
      )

      resetProcess()
      expect(await prepare()).toBe('state-home')
      expect(present(configDir(), files)).toEqual(leftAfterMove(files))
      expect(marker()?.oldFilesRemoved).toBe(true)
    },
  )

  it('cleanup after a crash waits for the store lock and compares again before it unlinks', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    await prepare({
      steps: {
        afterMarker: () => {
          throw new Error('crash')
        },
      },
    })
    const oldState = join(configDir(), 'openai-auth-state.json')
    // A writer holds the store's lock on the old state file and replaces it.
    const held = await acquireRefreshFileLock({
      name: 'save',
      path: oldState,
      ttlMs: 10_000,
    })
    expect(held).not.toBeNull()
    resetProcess()
    let settled = false
    const run = prepare().then((layout) => {
      settled = true
      return layout
    })
    await Bun.sleep(300)
    expect(settled).toBe(false)
    writeFileSync(oldState, '{"refresh":"written-under-the-lock"}\n')
    await held?.release()
    await expect(run).rejects.toThrow(
      credentialConflictMessage('openai-auth-state.json'),
    )
    expect(readFileSync(oldState, 'utf8')).toBe(
      '{"refresh":"written-under-the-lock"}\n',
    )
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  it.each(CREDENTIAL_FILES)(
    'refuses old credentials that reappear after a finished move: %s',
    async (relative) => {
      const files = { ...oldLayout(), [relative]: 'original-credentials\n' }
      seed(configDir(), files)
      await prepare()
      expect(marker()?.oldFilesRemoved).toBe(true)
      writePrivate(join(configDir(), relative), 'newer-credentials\n')
      resetProcess()
      await expect(prepare()).rejects.toMatchObject({
        name: 'RuntimeLayoutRefusal',
        message: credentialConflictMessage(relative),
      })
      expect(readFileSync(join(configDir(), relative), 'utf8')).toBe(
        'newer-credentials\n',
      )
      expect(readFileSync(join(runtimeDir(), relative), 'utf8')).toBe(
        'original-credentials\n',
      )
    },
  )

  it('does not conflict with reappeared state and vault files owned by a state override', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    seed(configDir(), oldLayout('override'))
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      configDir(),
      'openai-auth-state.json',
    )
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(configDir(), oldLayout('override'))).toEqual(
      oldLayout('override'),
    )
  })

  it.each(['OPENCODE_OPENAI_AUTH_STATE_FILE', 'OPENCODE_OPENAI_AUTH_FILE'])(
    'does not conflict with an individual reappeared vault file named by %s',
    async (override) => {
      seed(configDir(), oldLayout())
      await prepare()
      const relative = 'openai-auth-vault/opencode-enrollment.json'
      const path = join(configDir(), relative)
      writePrivate(path, 'override-owned\n')
      process.env[override] = path
      resetProcess()
      expect(await prepare()).toBe('state-home')
      expect(readFileSync(path, 'utf8')).toBe('override-owned\n')

      writePrivate(
        join(configDir(), 'openai-auth-vault/unowned.json'),
        'unowned-credentials\n',
      )
      resetProcess()
      await expect(prepare()).rejects.toThrow(
        credentialConflictMessage('openai-auth-vault/unowned.json'),
      )
    },
  )

  it('old sessions that reappear after the move are never read nor removed, and /openai shows it once', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    // An older version ran again and wrote its own files.
    const downgrade = Object.fromEntries(
      Object.entries(oldLayout('downgrade')).filter(([relative]) =>
        relative.startsWith('openai-auth-sessions'),
      ),
    )
    seed(configDir(), downgrade)
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(configDir(), downgrade)).toEqual(downgrade)
    expect(present(runtimeDir(), oldLayout())).toEqual(oldLayout())
    expect(getAccountPaths().statePath).toBe(
      join(runtimeDir(), 'openai-auth-state.json'),
    )
    const warnings = logged.filter((line) => line.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.meta).toMatchObject({ configDir: configDir() })
    const take = layoutModule().takeRuntimeLayoutNotice as
      | (() => string | undefined)
      | undefined
    expect(typeof take).toBe('function')
    expect(take?.()).toContain(configDir())
    expect(take?.()).toBeUndefined()
    // One warning per process.
    __resetRuntimeLayoutsForTest()
    await prepare()
    expect(logged.filter((line) => line.level === 'warn')).toHaveLength(1)
  })

  it.each(['{ not json', 'null', '[]', 'false', '42', '"marker"'])(
    'a malformed marker refuses the start and leaves old files untouched: %s',
    async (text) => {
      const files = oldLayout()
      seed(configDir(), files)
      const path = join(runtimeDir(), 'layout.json')
      writePrivate(path, text)
      await expect(prepare()).rejects.toMatchObject({
        name: 'RuntimeLayoutRefusal',
        message: `openai-auth cannot start: ${path} is malformed. The old files are still in OpenCode's config folder. Delete layout.json, then restart OpenCode.`,
      })
      expect(present(configDir(), files)).toEqual(files)
      expect(present(runtimeDir(), files)).toEqual(absent(files))
      expect(readFileSync(path, 'utf8')).toBe(text)
    },
  )

  it('a marker that cannot be read refuses the start instead of counting as moved', async () => {
    seed(configDir(), oldLayout())
    // A folder where the marker should be: it exists, and reading it fails.
    mkdirSync(join(runtimeDir(), 'layout.json'), { recursive: true })
    await expect(prepare()).rejects.toThrow(REFUSED)
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a layout lease lost before the marker writes no marker and refuses to run unregistered', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const lockPath = `${join(runtimeDir(), 'layout.json')}.runtime-layout.lock`
    await expect(
      prepare({
        steps: {
          afterCopy: () => {
            // Another process took the lease over while this one stalled.
            writeFileSync(
              lockPath,
              JSON.stringify({
                ownerId: 'another-process',
                expiresAt: Date.now() + 60_000,
              }),
            )
          },
        },
      }),
    ).rejects.toThrow(REFUSED)
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
  })
})

describe('processes that could still write the old files', () => {
  it('a live older version defers the move; once it is gone the move completes', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    // The test runner's parent is alive and is not this process.
    const older = heartbeat(process.ppid, { version: '1.6.2' })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
    expect(getAccountPaths().statePath).toBe(
      join(configDir(), 'openai-auth-state.json'),
    )
    expect(logged).toContainEqual(
      expect.objectContaining({ message: RUNTIME_LAYOUT_DEFERRED_MESSAGE }),
    )
    // This process recorded its legacy layout for others to see.
    const own = JSON.parse(readFileSync(processHeartbeatPath(), 'utf8'))
    expect(own.layouts).toEqual({ [runtimeLayoutLocation().key]: 'legacy' })

    rmSync(older)
    rmSync(processHeartbeatPath())
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
  })

  it('a heartbeat without layouts predates the move and defers it, even at the same version', async () => {
    seed(configDir(), oldLayout())
    heartbeat(process.ppid, { version: VERSION })
    expect(await prepare()).toBe('legacy')
  })

  it('a live legacy heartbeat under another config folder key blocks the move too', async () => {
    seed(configDir(), oldLayout())
    heartbeat(process.ppid, {
      version: VERSION,
      layouts: { [join(root, 'some', 'other', 'opencode')]: 'legacy' },
    })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a fresh install waits for an older version too', async () => {
    heartbeat(process.ppid, { version: '1.6.2' })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
  })

  it('a process that cannot record its legacy layout refuses to start', async () => {
    seed(configDir(), oldLayout())
    heartbeat(process.ppid, { version: '1.6.2' })
    // This process's own heartbeat file cannot be written: a folder is in
    // its place.
    mkdirSync(processHeartbeatPath(), { recursive: true })
    await expect(prepare()).rejects.toThrow(REFUSED)
  })

  it('a state folder that cannot be created refuses the start rather than run unregistered', async () => {
    seed(configDir(), oldLayout())
    mkdirSync(join(root, 'state', 'cortexkit'), { recursive: true })
    // A file where the state folder's parent should be.
    writeFileSync(stateRoot(), 'not a folder')
    await expect(prepare()).rejects.toThrow(REFUSED)
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a live process on the legacy layout keeps a new one legacy; after it exits the next start moves', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const older = heartbeat(process.ppid, { version: '1.6.2' })
    // Process A starts while an older version runs, so it takes the legacy
    // layout, and keeps running after the older version exits.
    const a = await spawnLayoutProcess('hold')
    expect(a.result.layout).toBe('legacy')
    rmSync(older)

    // Process B starts while A is alive: legacy too.
    const b = await spawnLayoutProcess('once')
    expect(b.result.layout).toBe('legacy')
    expect(present(configDir(), files)).toEqual(files)

    a.child.kill()
    await a.child.exited
    // Process C starts after A exited (B has exited as well): it moves.
    const c = await spawnLayoutProcess('once')
    expect(c.result.layout).toBe('state-home')
    expect(c.result.statePath).toBe(
      join(runtimeDir(), 'openai-auth-state.json'),
    )
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
  })

  it('two processes starting together produce one move and identical files', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const [one, two] = await Promise.all([
      spawnLayoutProcess('once'),
      spawnLayoutProcess('once'),
    ])
    expect([one.result.layout, two.result.layout]).toEqual([
      'state-home',
      'state-home',
    ])
    expect(one.result.statePath).toBe(two.result.statePath as string)
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(
      readdirSync(runtimeDir()).filter((name) => name.includes('.tmp')),
    ).toEqual([])
  })

  it('a legacy-layout process keeps its heartbeat after its last owner releases it', async () => {
    heartbeat(process.ppid, { version: '1.6.2' })
    await prepare()
    const handle = await startProcessHeartbeat({
      version: VERSION,
      logger: { warn() {} },
    })
    await handle.release()
    expect(existsSync(processHeartbeatPath())).toBe(true)
  })
})

describe('paths the move must not touch', () => {
  it('OPENCODE_OPENAI_AUTH_STATE_FILE elsewhere: no move and no marker, the chosen files untouched', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const chosenDir = join(root, 'chosen')
    const chosen = oldLayout('chosen')
    seed(chosenDir, chosen)
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      chosenDir,
      'openai-auth-state.json',
    )
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(getAccountPaths().statePath).toBe(
      join(chosenDir, 'openai-auth-state.json'),
    )
    expect(present(chosenDir, chosen)).toEqual(chosen)
    expect(present(configDir(), files)).toEqual(files)
    expect(await authority()).toBe('vault')
  })

  it('a state file override naming the old default file writes no marker, so a later start without it moves the state', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      configDir(),
      'openai-auth-state.json',
    )
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)

    // Because the start with the override wrote no marker, a later process
    // without the override moves every file, the state file included.
    rmSync(processHeartbeatPath(), { force: true })
    unsetEnv('OPENCODE_OPENAI_AUTH_STATE_FILE')
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(runtimeDir(), files)).toEqual(files)
  })

  it('an override follows an existing marker for the files it does not name', async () => {
    await prepare()
    resetProcess()
    const chosen = join(root, 'chosen', 'state.json')
    writePrivate(chosen, '{"chosen":true}\n')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = chosen
    expect(await prepare()).toBe('state-home')
    expect(getAccountPaths().statePath).toBe(chosen)
    expect(getCodexSessionsPath('opencode2')).toBe(
      join(runtimeDir(), 'openai-auth-sessions-opencode2.json'),
    )
  })

  it('an explicit state file inside the destination is never overwritten or deleted', async () => {
    seed(configDir(), oldLayout())
    const destination = join(runtimeDir(), 'openai-auth-state.json')
    writePrivate(destination, '{"only-copy":true}\n')
    const vaultToken = join(
      runtimeDir(),
      'openai-auth-vault',
      'opencode-enrollment.json',
    )
    writePrivate(vaultToken, '{"vault-only-copy":true}\n')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = destination
    expect(await prepare()).toBe('legacy')
    expect(readFileSync(destination, 'utf8')).toBe('{"only-copy":true}\n')
    expect(readFileSync(vaultToken, 'utf8')).toBe('{"vault-only-copy":true}\n')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a custom config file whose state lies in the destination is never touched', async () => {
    const custom = join(runtimeDir(), 'openai-auth.json')
    writePrivate(custom, '{}\n')
    const derived = join(runtimeDir(), 'openai-auth-state.json')
    writePrivate(derived, '{"custom-state":true}\n')
    process.env.OPENCODE_OPENAI_AUTH_FILE = custom
    expect(await prepare()).toBe('legacy')
    expect(getAccountPaths().statePath).toBe(derived)
    expect(readFileSync(derived, 'utf8')).toBe('{"custom-state":true}\n')
    expect(marker()).toBeUndefined()
  })

  it('a runtime file another process put in the destination stops the move and is kept', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    // A state file left in the destination by a process whose state-file
    // override pointed there.
    const foreign = join(runtimeDir(), 'openai-auth-state.json')
    writePrivate(foreign, '{"someone-elses":true}\n')
    expect(await prepare()).toBe('legacy')
    expect(readFileSync(foreign, 'utf8')).toBe('{"someone-elses":true}\n')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
  })

  it('a state folder that is the config folder itself (a link) is refused and nothing is lost', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    mkdirSync(dirname(runtimeDir()), { recursive: true })
    symlinkSync(configDir(), runtimeDir(), POSIX ? 'dir' : 'junction')
    if (POSIX) {
      // Registered on the legacy layout; the move is refused.
      expect(await prepare()).toBe('legacy')
    } else {
      // Windows' private-files check refuses the junction when the layout
      // lock is taken there, so the start is refused instead.
      await expect(prepare()).rejects.toThrow(
        /is not a folder only your user can access, or it is a link/,
      )
    }
    expect(present(configDir(), files)).toEqual(files)
    expect(existsSync(join(configDir(), 'layout.json'))).toBe(false)
  })

  it('a state folder that names another config folder is refused and left untouched', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    writePrivate(
      join(runtimeDir(), 'config-dir.json'),
      `${JSON.stringify({ version: 1, configDir: join(root, 'elsewhere') })}\n`,
    )
    await expect(prepare()).rejects.toThrow(/belongs to another OpenCode/)
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()).toBeUndefined()
  })

  it('a marker naming another config folder is refused', async () => {
    seed(configDir(), oldLayout())
    writePrivate(
      join(runtimeDir(), 'layout.json'),
      `${JSON.stringify({ version: 1, oldDir: join(root, 'elsewhere'), oldFilesRemoved: true })}\n`,
    )
    await expect(prepare()).rejects.toThrow(/belongs to another OpenCode/)
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('two config folders never share a runtime folder', async () => {
    const first = join(root, 'first-config')
    const second = join(root, 'second-config')
    seed(first, oldLayout('first'))
    seed(second, oldLayout('second'))

    process.env.OPENCODE_CONFIG_DIR = first
    expect(await prepare()).toBe('state-home')
    const firstDir = runtimeDir()

    resetProcess()
    process.env.OPENCODE_CONFIG_DIR = second
    expect(await prepare()).toBe('state-home')
    const secondDir = runtimeDir()

    expect(secondDir).not.toBe(firstDir)
    expect(present(firstDir, oldLayout('first'))).toEqual(oldLayout('first'))
    expect(present(secondDir, oldLayout('second'))).toEqual(oldLayout('second'))
    for (const [dir, config] of [
      [firstDir, first],
      [secondDir, second],
    ] as const)
      expect(
        JSON.parse(readFileSync(join(dir, 'config-dir.json'), 'utf8')),
      ).toEqual({ version: 1, configDir: config })
  })
})

/** The vault mode an older version reads from OpenCode's config folder. */
function oldFolderAuthority() {
  return enrollmentAuthority(
    hostEnrollmentPaths({
      stateDir: join(configDir(), 'openai-auth-vault'),
      host: 'opencode',
    }),
    vaultEnrollmentName('opencode'),
  )
}

/** Another process takes the layout lease over from this one. */
function stealLayoutLease() {
  writeFileSync(
    layoutLockPath(),
    JSON.stringify({
      ownerId: 'another-process',
      expiresAt: Date.now() + 60_000,
    }),
  )
}

const layoutLockPath = () =>
  `${join(runtimeDir(), 'layout.json')}.runtime-layout.lock`

/** The old layout with an enrollment that was never approved. */
function pendingLayout(): Record<string, string> {
  return {
    ...oldLayout(),
    [VAULT_STATE]: `${JSON.stringify({
      version: 1,
      phase: 'pending',
      proposedName: vaultEnrollmentName('opencode'),
      createdAt: 1,
      updatedAt: 1,
    })}\n`,
  }
}

/** The old vault token, relative to the config folder. */
const VAULT_TOKEN = 'openai-auth-vault/opencode-enrollment.json'

/**
 * What an older version's reconcile() writes over an approved state whose
 * token is gone.
 */
const BLOCKED_MISSING_TOKEN = `${JSON.stringify({
  version: 1,
  phase: 'blocked',
  proposedName: vaultEnrollmentName('opencode'),
  errorCode: 'missing_token',
  updatedAt: 2,
})}\n`

/** The approved state with a newer timestamp than the one that moved. */
const APPROVED_LATER = (oldLayout()[VAULT_STATE] as string).replace(
  '"updatedAt":1',
  '"updatedAt":2',
)

describe('an approved vault enrollment and older versions', () => {
  it('the move removes the old token but leaves the old state, so an older version stays in vault mode', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    expect(await prepare()).toBe('state-home')
    expect(
      existsSync(
        join(configDir(), 'openai-auth-vault/opencode-enrollment.json'),
      ),
    ).toBe(false)
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
      files[VAULT_STATE] as string,
    )
    expect(marker()).toMatchObject({
      oldFilesRemoved: true,
      keptVaultState: sha256(files[VAULT_STATE] as string),
    })
    // An older version reads the old folder: approved without a token is
    // vault mode with a missing token, never local.
    expect(await oldFolderAuthority()).toBe('vault')
    expect(await authority()).toBe('vault')
  })

  it('the next start accepts the leftover without a conflict or a warning', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    await prepare()
    resetProcess()
    logged = []
    expect(await prepare()).toBe('state-home')
    expect(logged.filter((line) => line.level === 'warn')).toEqual([])
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
      files[VAULT_STATE] as string,
    )
  })

  it.each([
    ['blocked for the missing token', BLOCKED_MISSING_TOKEN],
    ['approved at a newer time', APPROVED_LATER],
  ])(
    "accepts an older version's rewrite of the leftover (%s) and the old folder still reads vault",
    async (_label, rewritten) => {
      seed(configDir(), oldLayout())
      await prepare()
      // An older version's reconcile() found the approved state without its
      // token and rewrote it.
      writePrivate(join(configDir(), VAULT_STATE), rewritten)
      resetProcess()
      logged = []
      expect(await prepare()).toBe('state-home')
      expect(logged.filter((line) => line.level === 'warn')).toEqual([])
      expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
        rewritten,
      )
      expect(await oldFolderAuthority()).toBe('vault')
      expect(await authority()).toBe('vault')
    },
  )

  it.each([
    [
      'an enrollment request with its secret',
      `${JSON.stringify({
        version: 1,
        phase: 'pending',
        proposedName: vaultEnrollmentName('opencode'),
        requestSecret: 'ab'.repeat(32),
        createdAt: 2,
        updatedAt: 2,
      })}\n`,
    ],
    ['a file that is not an enrollment state', '{"someone-elses":true}\n'],
    [
      "another enrollment's state",
      BLOCKED_MISSING_TOKEN.replace(
        vaultEnrollmentName('opencode'),
        vaultEnrollmentName('pi'),
      ),
    ],
  ])(
    'anything else at the leftover path is still a conflict: %s',
    async (_label, other) => {
      seed(configDir(), oldLayout())
      await prepare()
      writePrivate(join(configDir(), VAULT_STATE), other)
      resetProcess()
      await expect(prepare()).rejects.toMatchObject({
        name: 'RuntimeLayoutRefusal',
        message: credentialConflictMessage(VAULT_STATE),
      })
      expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(other)
    },
  )

  it.each([
    ['as it moved', undefined],
    ['rewritten by an older version', BLOCKED_MISSING_TOKEN],
  ])(
    'a token file in the old vault folder is a conflict, beside the leftover %s',
    async (_label, rewritten) => {
      const files = oldLayout()
      seed(configDir(), files)
      await prepare()
      if (rewritten) writePrivate(join(configDir(), VAULT_STATE), rewritten)
      writePrivate(join(configDir(), VAULT_TOKEN), files[VAULT_TOKEN] as string)
      resetProcess()
      await expect(prepare()).rejects.toMatchObject({
        name: 'RuntimeLayoutRefusal',
        message: credentialConflictMessage(
          rewritten ? VAULT_STATE : VAULT_TOKEN,
        ),
      })
      expect(existsSync(join(configDir(), VAULT_TOKEN))).toBe(true)
    },
  )

  it('an enrollment that was never approved is removed as before', async () => {
    const files = pendingLayout()
    seed(configDir(), files)
    expect(await prepare()).toBe('state-home')
    expect(present(configDir(), files)).toEqual(absent(files))
    expect(existsSync(join(configDir(), 'openai-auth-vault'))).toBe(false)
    expect(marker()?.keptVaultState).toBeUndefined()
  })

  it('Disconnect on this version removes the leftover, and an older version then reads local', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    const lease = acquireOpenCodeVault(
      {
        host: 'opencode',
        stateDir: vaultStateDir(getAccountPaths().statePath),
        connectionFile: () => join(root, 'no-vault.json'),
        pollIntervalMs: 0,
      },
      getAccountPaths(),
    )
    try {
      await lease.vault.disconnect()
    } finally {
      lease.release()
    }
    expect(existsSync(join(configDir(), VAULT_STATE))).toBe(false)
    expect(existsSync(join(configDir(), 'openai-auth-vault'))).toBe(false)
    expect(await oldFolderAuthority()).toBe('local')
    expect(await authority()).toBe('local')
  })

  it('Disconnect removes the leftover an older version rewrote', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    writePrivate(join(configDir(), VAULT_STATE), BLOCKED_MISSING_TOKEN)
    const lease = acquireOpenCodeVault(
      {
        host: 'opencode',
        stateDir: vaultStateDir(getAccountPaths().statePath),
        connectionFile: () => join(root, 'no-vault.json'),
        pollIntervalMs: 0,
      },
      getAccountPaths(),
    )
    try {
      await lease.vault.disconnect()
    } finally {
      lease.release()
    }
    expect(existsSync(join(configDir(), VAULT_STATE))).toBe(false)
    expect(existsSync(join(configDir(), 'openai-auth-vault'))).toBe(false)
    expect(await oldFolderAuthority()).toBe('local')
  })

  it('Disconnect leaves a state file at the leftover path that the move did not leave', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    const other = '{"someone-elses":true}\n'
    writePrivate(join(configDir(), VAULT_STATE), other)
    const lease = acquireOpenCodeVault(
      {
        host: 'opencode',
        stateDir: vaultStateDir(getAccountPaths().statePath),
        connectionFile: () => join(root, 'no-vault.json'),
        pollIntervalMs: 0,
      },
      getAccountPaths(),
    )
    try {
      await lease.vault.disconnect()
    } finally {
      lease.release()
    }
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(other)
  })
})

describe('the layout lease before every removal', () => {
  it('a lease lost right before an old file is unlinked removes nothing', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const removing: string[] = []
    await prepare({
      steps: {
        beforeRemove: (path) => {
          removing.push(path)
          if (removing.length === 1) stealLayoutLease()
        },
      },
    })
    expect(removing[0]).toBe(join(configDir(), 'openai-auth-state.json'))
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  it('a lease lost right before the manifest is removed keeps it; the next start removes it', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const manifest = join(runtimeDir(), 'layout-moving.json')
    await prepare({
      steps: {
        beforeRemove: (path) => {
          if (path === manifest) stealLayoutLease()
        },
      },
    })
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(manifest)).toBe(true)

    rmSync(layoutLockPath(), { force: true })
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(existsSync(manifest)).toBe(false)
  })

  it('a manifest left after a finished move is removed at the next start', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    const manifest = join(runtimeDir(), 'layout-moving.json')
    // As if the move stopped between its last marker write and this removal.
    writePrivate(
      manifest,
      `${JSON.stringify({ version: 1, files: [join(runtimeDir(), 'openai-auth-state.json')] })}\n`,
    )
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(existsSync(manifest)).toBe(false)
    expect(existsSync(join(runtimeDir(), 'openai-auth-state.json'))).toBe(true)
  })

  it('a lease lost right before the old vault folder is removed keeps the folder', async () => {
    seed(configDir(), pendingLayout())
    const oldVault = join(configDir(), 'openai-auth-vault')
    await prepare({
      steps: {
        beforeRemove: (path) => {
          if (path === oldVault) stealLayoutLease()
        },
      },
    })
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(oldVault)).toBe(true)
    expect(readdirSync(oldVault)).toEqual([])
  })

  it('cleanup after a crash reads the fence again under the data locks', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    await prepare({
      steps: {
        afterMarker: () => {
          throw new Error('crash')
        },
      },
    })
    resetProcess()
    let reads = 0
    // Open before the locks; closed under them, as when a process on the
    // legacy layout started while this one waited for them.
    const fence = async () => {
      reads++
      return reads === 1
        ? { open: true as const }
        : { open: false as const, blockers: [] }
    }
    expect(await prepare({ fence })).toBe('state-home')
    expect(reads).toBe(2)
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })
})

/**
 * Runs the layout decision in its own process with this test's environment
 * plus `extra` (an undefined value removes a variable).
 */
async function spawnLayoutProcess(
  mode: 'once' | 'hold',
  extra: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    RUNTIME_LAYOUT_TEST_VERSION: VERSION,
    ...extra,
  }
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name]
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('./fixtures/runtime-layout-process.ts', import.meta.url),
      ),
      mode,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = child.stdout.getReader()
  let text = ''
  while (!text.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  if (!text.includes('\n')) {
    const stderr = await new Response(child.stderr).text()
    throw new Error(`layout process printed nothing: ${stderr}`)
  }
  if (mode === 'once') await child.exited
  return {
    child,
    result: JSON.parse(text.trim()) as {
      layout?: string
      error?: string
      pid?: number
      statePath?: string
      runtimeDir?: string
    },
  }
}
