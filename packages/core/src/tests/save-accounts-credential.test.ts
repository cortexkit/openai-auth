import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountPaths,
  type AccountStorage,
  loadAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
} from '../internal.ts'

/**
 * saveAccounts writes a whole snapshot the caller loaded earlier. When a
 * refresh has rotated a token on disk since that load, the snapshot's token is
 * already spent at the provider; writing it back would kill the account at its
 * next refresh.
 */

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-save-accounts-credential-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function storageWith(account: OAuthAccount): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts: [account],
  }
}

describe('saveAccounts keeps the newer credential', () => {
  it('a snapshot taken before a rotation leaves the rotated token on disk', async () => {
    const original: OAuthAccount = {
      id: 'main',
      type: 'oauth',
      label: 'before',
      access: 'access-R0',
      refresh: 'refresh-R0',
      expires: Date.now() + 3600_000,
      lastRefreshedAt: Date.now() - 60_000,
    }
    await saveAccounts(storageWith(original), paths)

    // The snapshot an older writer holds in memory.
    const snapshot = (await loadAccounts(paths)) as AccountStorage

    // A refresh rotates the token on disk.
    const rotated: OAuthAccount = {
      ...original,
      access: 'access-R1',
      refresh: 'refresh-R1',
      expires: Date.now() + 7200_000,
      lastRefreshedAt: Date.now(),
    }
    await saveAccountState(storageWith(rotated), paths)

    // The older writer saves its snapshot, with an unrelated edit.
    const edited = snapshot.accounts[0] as OAuthAccount
    edited.label = 'after'
    await saveAccounts(snapshot, paths)

    const stored = (await loadAccounts(paths))?.accounts[0] as OAuthAccount
    expect(stored.refresh).toBe('refresh-R1')
    expect(stored.access).toBe('access-R1')
    expect(stored.expires).toBe(rotated.expires)
    // The rest of the snapshot is still written.
    expect(stored.label).toBe('after')
  })

  it('a snapshot holding a newer token still replaces the older one', async () => {
    const original: OAuthAccount = {
      id: 'fallback-1',
      type: 'oauth',
      access: 'access-old',
      refresh: 'refresh-old',
      expires: Date.now() + 3600_000,
      lastRefreshedAt: Date.now() - 60_000,
    }
    await saveAccounts(storageWith(original), paths)
    await saveAccounts(
      storageWith({
        ...original,
        access: 'access-new',
        refresh: 'refresh-new',
        expires: Date.now() + 7200_000,
        lastRefreshedAt: Date.now(),
      }),
      paths,
    )
    const stored = (await loadAccounts(paths))?.accounts[0] as OAuthAccount
    expect(stored.refresh).toBe('refresh-new')
  })
})
