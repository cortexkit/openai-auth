// The one-time move of the runtime files (account state, vault folder, Codex
// sessions) out of OpenCode's config folder into the state home, and the
// resolver that follows it. Real files in temporary folders throughout.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
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
import {
  __resetRuntimeLayoutRunsForTest,
  prepareRuntimeLayout,
  RUNTIME_LAYOUT_DEFERRED_MESSAGE,
  type RuntimeLayoutOptions,
} from '../core/runtime-layout'
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

let root: string
let saved: Record<string, string | undefined>
let logged: { level: string; message: string; meta?: unknown }[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-layout-'))
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
  rmSync(root, { recursive: true, force: true })
})

/** Stands in for a new process: nothing decided, nothing logged. */
function resetProcess() {
  __resetRuntimeLayoutsForTest()
  __resetRuntimeLayoutRunsForTest()
  __resetProcessHeartbeatForTest()
}

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

const defaultConfigDir = () => join(root, 'config', 'opencode')
const stateHomeDir = () => join(root, 'state', 'cortexkit', 'openai-auth')

function writePrivate(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
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

function marker(dir = stateHomeDir()) {
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

describe('the runtime layout on a fresh install', () => {
  it('writes the marker and resolves every runtime file in the state home', async () => {
    expect(await prepare()).toBe('state-home')
    expect(marker()).toEqual({
      version: 1,
      oldDir: defaultConfigDir(),
      oldFilesRemoved: true,
    })
    const paths = getAccountPaths()
    expect(paths.configPath).toBe(join(defaultConfigDir(), 'openai-auth.json'))
    expect(paths.statePath).toBe(join(stateHomeDir(), 'openai-auth-state.json'))
    expect(vaultStateDir(paths.statePath)).toBe(
      join(stateHomeDir(), 'openai-auth-vault'),
    )
    expect(getCodexSessionsPath('opencode1')).toBe(
      join(stateHomeDir(), 'openai-auth-sessions.json'),
    )
    expect(getCodexSessionsPath('opencode2')).toBe(
      join(stateHomeDir(), 'openai-auth-sessions-opencode2.json'),
    )
    if (process.platform !== 'win32')
      expect(statSync(stateHomeDir()).mode & 0o777).toBe(0o700)
    // Nothing was created in OpenCode's config folder.
    expect(existsSync(defaultConfigDir())).toBe(false)
  })

  it('a tool that never prepared follows the marker alone', async () => {
    expect(getAccountPaths().statePath).toBe(
      join(defaultConfigDir(), 'openai-auth-state.json'),
    )
    await prepare()
    resetProcess()
    expect(getAccountPaths().statePath).toBe(
      join(stateHomeDir(), 'openai-auth-state.json'),
    )
  })
})

describe('moving an existing layout', () => {
  it('moves the state, the vault folder and both sessions files byte for byte, keeping vault mode', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
    writePrivate(
      join(defaultConfigDir(), 'openai-auth.json'),
      '{"keep":true}\n',
    )
    expect(await authority()).toBe('vault')

    resetProcess()
    expect(await prepare()).toBe('state-home')

    expect(present(stateHomeDir(), files)).toEqual(files)
    expect(present(defaultConfigDir(), files)).toEqual(absent(files))
    expect(existsSync(join(defaultConfigDir(), 'openai-auth-vault'))).toBe(
      false,
    )
    // The settings file stays where OpenCode users edit it.
    expect(
      readFileSync(join(defaultConfigDir(), 'openai-auth.json'), 'utf8'),
    ).toBe('{"keep":true}\n')
    expect(await authority()).toBe('vault')
    expect(
      vaultPaths(vaultStateDir(getAccountPaths().statePath), 'opencode')
        .rosterPath,
    ).toBe(join(stateHomeDir(), 'openai-auth-vault', 'opencode-roster.json'))
    if (process.platform !== 'win32') {
      for (const relative of Object.keys(files))
        expect(statSync(join(stateHomeDir(), relative)).mode & 0o777).toBe(
          0o600,
        )
      expect(
        statSync(join(stateHomeDir(), 'openai-auth-vault')).mode & 0o777,
      ).toBe(0o700)
    }
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(logged.map((line) => line.message)).toContain(
      "openai-auth moved its runtime files out of OpenCode's config folder",
    )
  })

  it('a crash after the copy and before the marker leaves the old files authoritative; the next start completes', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
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
    expect(present(defaultConfigDir(), files)).toEqual(files)
    expect(getAccountPaths().statePath).toBe(
      join(defaultConfigDir(), 'openai-auth-state.json'),
    )
    expect(getCodexSessionsPath('opencode2')).toBe(
      join(defaultConfigDir(), 'openai-auth-sessions-opencode2.json'),
    )

    // A later start: the old files changed meanwhile (they were still
    // authoritative), so the partial copies must not survive.
    const changed = { ...files, 'openai-auth-state.json': '{"refresh":"b"}\n' }
    seed(defaultConfigDir(), changed)
    rmSync(join(defaultConfigDir(), 'openai-auth-sessions.json'))
    const { 'openai-auth-sessions.json': _gone, ...remaining } = changed
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(stateHomeDir(), changed)).toEqual({
      ...remaining,
      'openai-auth-sessions.json': null,
    })
    expect(present(defaultConfigDir(), changed)).toEqual(absent(changed))
  })

  it('a crash after the marker: the next start removes identical leftovers and keeps differing ones', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
    expect(
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      }),
    ).toBe('state-home')
    expect(marker()).toEqual({ version: 1, oldDir: defaultConfigDir() })
    expect(present(defaultConfigDir(), files)).toEqual(files)
    expect(present(stateHomeDir(), files)).toEqual(files)

    const differing = join(defaultConfigDir(), 'openai-auth-sessions.json')
    writeFileSync(differing, '{"downgrade":true}\n')
    resetProcess()
    expect(await prepare()).toBe('state-home')
    const { 'openai-auth-sessions.json': _kept, ...identical } = files
    expect(present(defaultConfigDir(), identical)).toEqual(absent(identical))
    expect(readFileSync(differing, 'utf8')).toBe('{"downgrade":true}\n')
    expect(present(stateHomeDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        meta: expect.objectContaining({ kept: [differing] }),
      }),
    )
  })

  it('old files that reappear after the move are never read nor removed', async () => {
    seed(defaultConfigDir(), oldLayout())
    await prepare()
    // An older version ran again and wrote its own files.
    const downgrade = oldLayout('downgrade')
    seed(defaultConfigDir(), downgrade)
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(defaultConfigDir(), downgrade)).toEqual(downgrade)
    expect(present(stateHomeDir(), oldLayout())).toEqual(oldLayout())
    expect(getAccountPaths().statePath).toBe(
      join(stateHomeDir(), 'openai-auth-state.json'),
    )
    const warnings = logged.filter((line) => line.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.meta).toMatchObject({ configDir: defaultConfigDir() })
    // One warning per process.
    __resetRuntimeLayoutsForTest()
    await prepare()
    expect(logged.filter((line) => line.level === 'warn')).toHaveLength(1)
  })
})

describe('processes that could still write the old files', () => {
  it('a live older version defers the move; once it is gone the move completes', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
    // The test runner's parent is alive and is not this process.
    const older = heartbeat(process.ppid, { version: '1.6.2' })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(defaultConfigDir(), files)).toEqual(files)
    expect(getAccountPaths().statePath).toBe(
      join(defaultConfigDir(), 'openai-auth-state.json'),
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
    expect(present(stateHomeDir(), files)).toEqual(files)
    expect(present(defaultConfigDir(), files)).toEqual(absent(files))
  })

  it('a heartbeat without layouts predates the move and defers it, even at the same version', async () => {
    seed(defaultConfigDir(), oldLayout())
    heartbeat(process.ppid, { version: VERSION })
    expect(await prepare()).toBe('legacy')
  })

  it('a fresh install waits for an older version too', async () => {
    heartbeat(process.ppid, { version: '1.6.2' })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
  })

  it('a live process on the legacy layout keeps a new one legacy; after it exits the next start moves', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
    const older = heartbeat(process.ppid, { version: '1.6.2' })
    // Process A starts while an older version runs, so it takes the legacy
    // layout, and keeps running after the older version exits.
    const a = await spawnLayoutProcess('hold')
    expect(a.result.layout).toBe('legacy')
    rmSync(older)

    // Process B starts while A is alive: legacy too.
    const b = await spawnLayoutProcess('once')
    expect(b.result.layout).toBe('legacy')
    expect(present(defaultConfigDir(), files)).toEqual(files)

    a.child.kill()
    await a.child.exited
    // Process C starts after A exited (B has exited as well): it moves.
    const c = await spawnLayoutProcess('once')
    expect(c.result.layout).toBe('state-home')
    expect(c.result.statePath).toBe(
      join(stateHomeDir(), 'openai-auth-state.json'),
    )
    expect(present(stateHomeDir(), files)).toEqual(files)
    expect(present(defaultConfigDir(), files)).toEqual(absent(files))
  })

  it('two processes starting together produce one move and identical files', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
    const [one, two] = await Promise.all([
      spawnLayoutProcess('once'),
      spawnLayoutProcess('once'),
    ])
    expect([one.result.layout, two.result.layout]).toEqual([
      'state-home',
      'state-home',
    ])
    expect(one.result.statePath).toBe(two.result.statePath)
    expect(present(stateHomeDir(), files)).toEqual(files)
    expect(present(defaultConfigDir(), files)).toEqual(absent(files))
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(
      readdirSync(stateHomeDir()).filter((name) => name.endsWith('.tmp')),
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

describe('chosen paths and other config folders', () => {
  it('OPENCODE_OPENAI_AUTH_STATE_FILE wins and its files are never moved', async () => {
    const chosenDir = join(root, 'chosen')
    const chosen = oldLayout('chosen')
    seed(chosenDir, chosen)
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      chosenDir,
      'openai-auth-state.json',
    )
    expect(await prepare()).toBe('state-home')
    expect(getAccountPaths().statePath).toBe(
      join(chosenDir, 'openai-auth-state.json'),
    )
    expect(present(chosenDir, chosen)).toEqual(chosen)
    expect(await authority()).toBe('vault')
  })

  it('a state file override naming the old default file keeps it and its vault in place', async () => {
    const files = oldLayout()
    seed(defaultConfigDir(), files)
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      defaultConfigDir(),
      'openai-auth-state.json',
    )
    expect(await prepare()).toBe('state-home')
    const {
      'openai-auth-sessions.json': s1,
      'openai-auth-sessions-opencode2.json': s2,
      ...kept
    } = files
    expect(present(defaultConfigDir(), kept)).toEqual(kept)
    expect(
      present(stateHomeDir(), {
        'openai-auth-sessions.json': '',
        'openai-auth-sessions-opencode2.json': '',
      }),
    ).toEqual({
      'openai-auth-sessions.json': s1,
      'openai-auth-sessions-opencode2.json': s2,
    })
    expect(existsSync(join(stateHomeDir(), 'openai-auth-state.json'))).toBe(
      false,
    )
    expect(getAccountPaths().statePath).toBe(
      join(defaultConfigDir(), 'openai-auth-state.json'),
    )
  })

  it('a custom OPENCODE_OPENAI_AUTH_FILE keeps its state file beside it', async () => {
    const customDir = join(root, 'custom')
    const custom = join(customDir, 'mine.json')
    writePrivate(custom, '{}\n')
    writePrivate(`${custom}.state.json`, '{"refresh":"custom"}\n')
    process.env.OPENCODE_OPENAI_AUTH_FILE = custom
    expect(await prepare()).toBe('state-home')
    expect(getAccountPaths()).toEqual({
      configPath: custom,
      statePath: `${custom}.state.json`,
    })
    expect(readFileSync(`${custom}.state.json`, 'utf8')).toBe(
      '{"refresh":"custom"}\n',
    )
    expect(vaultStateDir(getAccountPaths().statePath)).toBe(
      join(customDir, 'openai-auth-vault'),
    )
  })

  it('a non-default OPENCODE_CONFIG_DIR gets its own keyed folder, and two folders never share one', async () => {
    const first = join(root, 'first-config')
    const second = join(root, 'second-config')
    seed(first, oldLayout('first'))
    seed(second, oldLayout('second'))

    process.env.OPENCODE_CONFIG_DIR = first
    expect(await prepare()).toBe('state-home')
    const firstState = getAccountPaths().statePath
    const firstDir = runtimeLayoutLocation().stateHomeDir

    resetProcess()
    process.env.OPENCODE_CONFIG_DIR = second
    expect(await prepare()).toBe('state-home')
    const secondState = getAccountPaths().statePath
    const secondDir = runtimeLayoutLocation().stateHomeDir

    expect(firstDir).toMatch(
      new RegExp(
        `^${stateHomeDir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/]config-[0-9a-f]{16}$`,
      ),
    )
    expect(secondDir).not.toBe(firstDir)
    expect(firstState).toBe(join(firstDir, 'openai-auth-state.json'))
    expect(secondState).toBe(join(secondDir, 'openai-auth-state.json'))
    expect(present(firstDir, oldLayout('first'))).toEqual(oldLayout('first'))
    expect(present(secondDir, oldLayout('second'))).toEqual(oldLayout('second'))
    for (const [dir, configDir] of [
      [firstDir, first],
      [secondDir, second],
    ] as const)
      expect(
        JSON.parse(readFileSync(join(dir, 'config-dir.json'), 'utf8')),
      ).toEqual({ configDir })
    // The default folder's own files are untouched by either.
    expect(marker()).toBeUndefined()
  })

  it('OPENCODE_CONFIG_DIR naming the default folder uses the default state folder', async () => {
    process.env.OPENCODE_CONFIG_DIR = defaultConfigDir()
    expect(await prepare()).toBe('state-home')
    expect(runtimeLayoutLocation().stateHomeDir).toBe(stateHomeDir())
  })
})

/** Runs the layout decision in its own process with this test's environment. */
async function spawnLayoutProcess(mode: 'once' | 'hold') {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    RUNTIME_LAYOUT_TEST_VERSION: VERSION,
  }
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
      layout: string
      pid: number
      statePath: string
      sessions: string
    },
  }
}
