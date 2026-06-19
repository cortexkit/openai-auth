import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { getRpcDir } from '../rpc/rpc-dir'

const ENV_KEY = 'OPENCODE_OPENAI_AUTH_RPC_DIR'

let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
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

  test('no override falls back to XDG hashed path', () => {
    // env already deleted in beforeEach
    const result = getRpcDir('/tmp/projA')

    expect(result).toContain('cortexkit/openai-auth/rpc')
    // 16-char hex hash
    const parts = result.split('/')
    const hash = parts[parts.length - 1]
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
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
})
