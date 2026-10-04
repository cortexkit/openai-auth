// A refresh can hand back tokens for a different ChatGPT account than the row
// is recorded as. The store keeps those tokens on the row and disables it
// (the old refresh token is spent, so dropping them would lose the login);
// the pool source must stop serving the row at once, in this process, and not
// treat it as a refresh failure to retry.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source.ts'
import { HOUR, readJson, seedPool } from './fixtures/pool-install.ts'

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-refresh-identity-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sourceRefreshingAs(identity: string): PoolAccountSource {
  return new PoolAccountSource({
    paths: () => paths,
    refreshProvider: async () => ({
      access: 'alpha-rotated',
      refresh: 'alpha-rotated-refresh',
      expires: Date.now() + HOUR,
      identity,
    }),
    pullQuota: async () => undefined,
  })
}

describe('a refresh that returns another account', () => {
  it('takes the row out of routing at once and offers no bearer', async () => {
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'alpha', expires: Date.now() + 60_000 },
    ])
    const source = sourceRefreshingAs('chatgpt-someone-else')
    await source.load()

    // The row is due, so this refreshes it first.
    expect(await source.accessFor('alpha', null)).toBeUndefined()
    const after = await source.rowAccess('alpha', null)
    expect(after?.row?.enabled).toBe(false)
    expect(after?.token).toBeUndefined()

    // The store kept the new tokens on the row, disabled, under the old account.
    const state = readJson(paths.statePath) as {
      accounts: Record<string, { refresh?: string }>
    }
    expect(state.accounts.alpha?.refresh).toBe('alpha-rotated-refresh')
    await source.load()
    expect(await source.accessFor('alpha', null)).toBeUndefined()

    source.dispose()
    await source.settled()
  })

  it('still serves a row whose refresh returns its own account', async () => {
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'alpha', expires: Date.now() + 60_000 },
    ])
    const source = sourceRefreshingAs('chatgpt-alpha')
    await source.load()
    expect((await source.accessFor('alpha', null))?.token).toBe('alpha-rotated')
    source.dispose()
    await source.settled()
  })
})
