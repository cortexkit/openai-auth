import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { getConfigDir } from '../config'
import {
  FLOOR_ENV,
  FLOOR_ROOTS,
  NETWORK_GUARD_MESSAGE,
  restoreEnv,
  unsetEnv,
} from './setup-env'

// The test preload (setup-env.ts) floors every path variable the plugin reads,
// so a test can never read or write the operator's live files. These tests
// pin the parts of that floor that were missing when the suite was found
// rewriting the live openai-auth-sessions.json and probing chatgpt.com.

const TESTS_DIR = import.meta.dir

function isUnder(child: string, parent: string): boolean {
  return (resolve(child) + sep).startsWith(resolve(parent) + sep)
}

describe('test environment floor', () => {
  it('resolves the plugin config dir under the floor when OPENCODE_CONFIG_DIR is removed', () => {
    // The sessions file lives in getConfigDir(). Removing OPENCODE_CONFIG_DIR
    // falls back to XDG_CONFIG_HOME, which must itself be floored, or the
    // fallback lands in the operator's ~/.config/opencode.
    const floorDir = resolve(FLOOR_ROOTS.OPENCODE_CONFIG_DIR, '..', '..', '..')
    unsetEnv('OPENCODE_CONFIG_DIR')
    try {
      const dir = getConfigDir()
      expect(isUnder(dir, floorDir)).toBe(true)
      expect(isUnder(dir, join(homedir(), '.config'))).toBe(false)
    } finally {
      restoreEnv('OPENCODE_CONFIG_DIR')
    }
  })

  it('restores a floored variable to its floor value, not to unset', () => {
    process.env.OPENCODE_CONFIG_DIR = '/somewhere/else'
    restoreEnv('OPENCODE_CONFIG_DIR')
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(
      FLOOR_ROOTS.OPENCODE_CONFIG_DIR,
    )
  })

  it('refuses non-loopback network requests', async () => {
    await expect(
      fetch('https://chatgpt.com/backend-api/wham/usage'),
    ).rejects.toThrow(NETWORK_GUARD_MESSAGE)
    await expect(
      fetch(new Request('https://auth.openai.com/oauth/token')),
    ).rejects.toThrow(NETWORK_GUARD_MESSAGE)
  })

  it('no test cleans up a floored variable with a bare delete', () => {
    // `delete process.env.X` on a floored variable returns it to the live
    // default rather than to the floor. Cleanup must use restoreEnv(); a test
    // that needs the variable absent inside its body uses unsetEnv().
    const floored = Object.keys(FLOOR_ENV).join('|')
    const bareDelete = new RegExp(`delete process\\.env\\.(${floored})\\b`)
    const offenders: string[] = []
    for (const file of readdirSync(TESTS_DIR)) {
      if (!file.endsWith('.ts') || file === 'setup-env.ts') continue
      readFileSync(join(TESTS_DIR, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (bareDelete.test(line)) offenders.push(`${file}:${index + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })
})
