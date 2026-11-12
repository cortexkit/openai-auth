import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { resolveDefaultSettingsStores } from '@cortexkit/openai-auth-core/settings-install'
import { FLOOR_DIR, REAL_HOME } from './setup-env'

// Pi's settings startup finds both hosts' default stores from the home folder
// and the XDG roots. These tests fail if any of those defaults leaves the
// preload's floor, which is how a test run once wrote ~/.pi/agent files.

function isUnder(child: string, parent: string): boolean {
  return (resolve(child) + sep).startsWith(resolve(parent) + sep)
}

describe('Pi test environment floor', () => {
  it('homedir() follows the floored HOME', () => {
    expect(isUnder(homedir(), FLOOR_DIR)).toBe(true)
  })

  it('both default settings stores resolve under the floor, never the real home', () => {
    for (const store of resolveDefaultSettingsStores()) {
      expect(isUnder(store.configPath, FLOOR_DIR)).toBe(true)
      expect(isUnder(store.statePath, FLOOR_DIR)).toBe(true)
      expect(isUnder(store.configPath, REAL_HOME)).toBe(false)
    }
  })
})
