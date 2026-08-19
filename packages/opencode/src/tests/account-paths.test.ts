import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accountPathsCollide,
  deriveStatePath,
  getAccountStatePath,
} from '../core/account-paths.ts'

describe('account path resolution', () => {
  it('derives distinct state paths for distinct config filenames', () => {
    const directory = '/tmp/account-paths'

    expect(deriveStatePath(join(directory, 'openai-auth.json'))).toBe(
      join(directory, 'openai-auth-state.json'),
    )
    expect(deriveStatePath(join(directory, 'team-openai-auth.json'))).toBe(
      join(directory, 'team-openai-auth.json.state.json'),
    )
  })

  it('refuses an explicit state path that resolves to the config path', () => {
    const previousStatePath = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const configPath = '/tmp/account-paths/roster.json'

    try {
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE =
        '/tmp/account-paths/./nested/../roster.json'

      expect(() => getAccountStatePath(configPath)).toThrow(
        /OPENCODE_OPENAI_AUTH_STATE_FILE.*different file/,
      )

      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE =
        '/tmp/account-paths/roster-state.json'
      expect(getAccountStatePath(configPath)).toBe(
        '/tmp/account-paths/roster-state.json',
      )
    } finally {
      if (previousStatePath === undefined) {
        delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
      } else {
        process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = previousStatePath
      }
    }
  })

  it('treats case-only aliases as equal on common case-insensitive platforms', () => {
    const root = mkdtempSync(join(tmpdir(), 'account-paths-case-'))
    const configPath = join(root, 'auth.json')
    const explicitStatePath = join(root, 'AUTH.JSON')

    expect(accountPathsCollide(configPath, explicitStatePath, 'darwin')).toBe(
      true,
    )
  })

  it('falls back safely when a symlink target is broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'account-paths-broken-link-'))
    const brokenPath = join(root, 'broken.json')
    symlinkSync(join(root, 'missing.json'), brokenPath)

    expect(
      accountPathsCollide(join(root, 'auth.json'), brokenPath, 'linux'),
    ).toBe(false)
  })

  it('wires symlink aliases through the state-path entry point', () => {
    const previousStatePath = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const root = mkdtempSync(join(tmpdir(), 'account-paths-wiring-'))
    const realDirectory = join(root, 'real')
    const aliasDirectory = join(root, 'alias')
    const configPath = join(aliasDirectory, 'auth.json')
    const explicitStatePath = join(realDirectory, 'auth.json')
    mkdirSync(realDirectory)
    symlinkSync(realDirectory, aliasDirectory, 'dir')

    try {
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = explicitStatePath
      expect(() => getAccountStatePath(configPath)).toThrow(
        /OPENCODE_OPENAI_AUTH_STATE_FILE.*different file/,
      )
    } finally {
      if (previousStatePath === undefined) {
        delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
      } else {
        process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = previousStatePath
      }
    }
  })
})
