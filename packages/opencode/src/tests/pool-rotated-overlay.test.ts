// The pool source keeps the credentials it rotated itself and lays them over
// what it reads from the files, until the files show the rotation (a read can
// race the store's write). That overlay must apply only to the credential it
// was rotated from: once the row's credential is replaced (a re-login bumps
// its `credentialEpoch`), the old rotated token belongs to another login.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source.ts'
import { HOUR, readJson, seedPool } from './fixtures/pool-install.ts'

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-rotated-overlay-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the rotated-credential overlay', () => {
  it('is not laid over a row whose credential was replaced since the rotation', async () => {
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'alpha', expires: Date.now() + 60_000 },
    ])
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async () => ({
        access: 'alpha-rotated',
        refresh: 'alpha-rotated-refresh',
        expires: Date.now() + HOUR,
      }),
      pullQuota: async () => undefined,
    })
    await source.load()
    // The row is due, so this refreshes it and remembers the rotation.
    expect((await source.rowAccess('alpha', null))?.token).toBe('alpha-rotated')

    // Another process replaces the row's credential with a new login: the
    // epoch goes up and the new credential carries no rotation stamp.
    const config = readJson(paths.configPath) as {
      commonAuthPool: { rows: { alpha: { credentialEpoch: number } } }
    }
    config.commonAuthPool.rows.alpha.credentialEpoch = 2
    writeFileSync(paths.configPath, JSON.stringify(config))
    const state = readJson(paths.statePath) as {
      accounts: Record<string, unknown>
    }
    state.accounts.alpha = {
      access: 'alpha-relogin',
      refresh: 'alpha-relogin-refresh',
      expires: Date.now() + HOUR,
    }
    writeFileSync(paths.statePath, JSON.stringify(state))

    await source.load()
    expect((await source.rowAccess('alpha', null))?.token).toBe('alpha-relogin')
    source.dispose()
    await source.settled()
  })
})
