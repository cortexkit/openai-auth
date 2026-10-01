// One ChatGPT account has one owner. When the Claustrum vault holds an
// account for this host, a local pool row signing in as the same account is
// skipped by request routing, and the pool source must not keep it alive in
// the background either: no refresh of its token, no quota poll with it.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source.ts'
import { HOUR, seedPool } from './fixtures/pool-install.ts'

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-vault-owner-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a pool row whose account the vault holds', () => {
  it('is never refreshed or polled in the background; the other rows are', async () => {
    // Both rows are due for a refresh and have never been polled.
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'alpha', expires: Date.now() + 60_000 },
      { id: 'beta', expires: Date.now() + 60_000 },
    ])
    const refreshed: string[] = []
    const polled: string[] = []
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async (credential) => {
        refreshed.push(credential.refresh)
        return {
          access: `${credential.refresh}-rotated`,
          refresh: `${credential.refresh}-next`,
          expires: Date.now() + HOUR,
        }
      },
      pullQuota: async (request) => {
        polled.push(request.id)
        return undefined
      },
      vaultIdentities: () => new Set(['chatgpt-alpha']),
    })

    // The first load polls every row it has not seen.
    await source.load()
    await source.poolStore().pullsSettled()
    await source.refreshDueTokens(null)
    const results = await source.pollRows(null)
    source.dispose()
    await source.settled()

    expect(refreshed.some((token) => token.startsWith('alpha'))).toBe(false)
    expect(refreshed).toContain('beta-refresh')
    expect(polled).not.toContain('alpha')
    expect(polled).toContain('beta')
    expect(results.map((result) => result.id)).toEqual(['beta'])
  })
})
