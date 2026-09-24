import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writePortFile } from '../rpc/port-file'
import { getRpcDir, resolveRpcDir } from '../rpc/rpc-dir'
import { restoreEnv } from './setup-env'

const ENV_KEY = 'OPENCODE_OPENAI_AUTH_RPC_DIR'

let savedEnv: string | undefined
let savedStateHome: string | undefined
let tempDir: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  savedStateHome = process.env.XDG_STATE_HOME
  delete process.env[ENV_KEY]
})

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
  if (savedStateHome === undefined) {
    restoreEnv('XDG_STATE_HOME')
  } else {
    process.env.XDG_STATE_HOME = savedStateHome
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('getRpcDir', () => {
  test('relative override is anchored to projectDirectory, not cwd', () => {
    process.env[ENV_KEY] = '.myrpc'
    const projectDirectory = '/tmp/projA'

    const result = getRpcDir(projectDirectory)

    // Must equal projectDirectory-anchored path
    const expected = resolve(projectDirectory, '.myrpc')
    expect(result).toBe(expected)

    // Must NOT equal cwd-anchored path when cwd differs from projectDirectory
    // (process.cwd() will not be '/tmp/projA' in a test runner)
    const cwdAnchored = resolve(process.cwd(), '.myrpc')
    if (process.cwd() !== projectDirectory) {
      expect(result).not.toBe(cwdAnchored)
    }
  })

  test('relative override with subdirectory path is anchored to projectDirectory', () => {
    process.env[ENV_KEY] = 'sub/rpc'
    const projectDirectory = '/tmp/projA'

    const result = getRpcDir(projectDirectory)

    expect(result).toBe(resolve(projectDirectory, 'sub/rpc'))
  })

  test('absolute override passes through unchanged regardless of projectDirectory', () => {
    process.env[ENV_KEY] = '/var/custom/rpc'

    const result = getRpcDir('/tmp/projA')

    expect(result).toBe('/var/custom/rpc')
  })

  test('no override falls back to an openai-auth-prefixed XDG hashed path', () => {
    // env already deleted in beforeEach
    const result = getRpcDir('/tmp/projA')

    expect(result).toContain('cortexkit/openai-auth/rpc')
    // 16-char hex hash with a greppable plugin prefix
    const parts = result.split('/')
    const name = parts[parts.length - 1]
    expect(name).toMatch(/^openai-auth-[0-9a-f]{16}$/)
  })

  test('same projectDirectory always produces same no-override path', () => {
    const a = getRpcDir('/tmp/projA')
    const b = getRpcDir('/tmp/projA')
    expect(a).toBe(b)
  })

  test('different projectDirectories produce different no-override paths', () => {
    const a = getRpcDir('/tmp/projA')
    const b = getRpcDir('/tmp/projB')
    expect(a).not.toBe(b)
  })

  test('server and TUI resolution return the identical managed path', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oa-rpc-dir-'))
    process.env.XDG_STATE_HOME = tempDir

    const server = await resolveRpcDir('/tmp/project')
    const tui = await resolveRpcDir('/tmp/project')

    expect(server.dir).toBe(tui.dir)
    expect(server.secureDir).toBe(true)
    expect(server.sweepRoot).toBe(tui.sweepRoot)
  })

  test('override remains anchored but is never treated as a managed directory', async () => {
    process.env[ENV_KEY] = '.custom-rpc'

    const resolved = await resolveRpcDir('/tmp/project')

    expect(resolved.dir).toBe(resolve('/tmp/project', '.custom-rpc'))
    expect(resolved.secureDir).toBe(false)
    expect(resolved.sweepRoot).toBeUndefined()
  })

  test('resolution uses the new directory even when a legacy entry is live', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oa-rpc-dir-'))
    process.env.XDG_STATE_HOME = tempDir
    const projectDirectory = '/tmp/project'
    const legacyDir = getRpcDir(projectDirectory).replace(
      /openai-auth-([0-9a-f]{16})$/,
      '$1',
    )
    await writePortFile(legacyDir, {
      port: 1,
      token: 'live',
      pid: process.pid,
    })

    const resolved = await resolveRpcDir(projectDirectory)

    expect(resolved.dir).toBe(getRpcDir(projectDirectory))
    expect(resolved.secureDir).toBe(true)
    expect(await stat(legacyDir)).toBeDefined()
  })

  test('resolution stays stable when legacy liveness changes between calls', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oa-rpc-dir-'))
    process.env.XDG_STATE_HOME = tempDir
    const projectDirectory = '/tmp/project'
    const legacyDir = getRpcDir(projectDirectory).replace(
      /openai-auth-([0-9a-f]{16})$/,
      '$1',
    )
    await writePortFile(legacyDir, {
      port: 1,
      token: 'live',
      pid: process.pid,
    })

    const beforeExit = await resolveRpcDir(projectDirectory)
    await unlink(join(legacyDir, `port-${process.pid}.json`))
    const afterExit = await resolveRpcDir(projectDirectory)

    expect(afterExit.dir).toBe(beforeExit.dir)
  })
})
