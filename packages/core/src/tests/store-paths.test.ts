import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountPaths,
  loadAccounts,
  migrateIfNeeded,
  mutateAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
} from '../internal.ts'

/**
 * The store takes both file paths from its caller and derives neither.
 *
 * These use a config path and a state path in DIFFERENT directories, with a
 * state filename the old derivation would never have produced. If any entry
 * point still worked one out for itself, the file it wrote would land beside
 * the config instead of where the caller asked, and these assertions would see
 * an empty state directory.
 */
let configDir: string
let stateDir: string
let paths: AccountPaths

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'oai-store-config-'))
  stateDir = mkdtempSync(join(tmpdir(), 'oai-store-state-'))
  paths = {
    configPath: join(configDir, 'openai-auth.json'),
    statePath: join(stateDir, 'somewhere-else.json'),
  }
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

function account(id: string): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 3_600_000,
    enabled: true,
  }
}

function derivedStatePathBesideConfig() {
  return join(configDir, 'openai-auth-state.json')
}

describe('store entry points write exactly the two files they were given', () => {
  it('saveAccounts writes the caller-supplied config and state paths', async () => {
    await saveAccounts({ version: 1, accounts: [account('fallback-a')] }, paths)

    expect(existsSync(paths.configPath)).toBe(true)
    expect(existsSync(paths.statePath)).toBe(true)
    expect(existsSync(derivedStatePathBesideConfig())).toBe(false)

    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'))
    expect(config.accounts.map((a: { id: string }) => a.id)).toEqual([
      'fallback-a',
    ])
    // Secrets belong to the state file, never the config roster.
    expect(readFileSync(paths.configPath, 'utf8')).not.toContain(
      'refresh-fallback-a',
    )
    expect(readFileSync(paths.statePath, 'utf8')).toContain(
      'refresh-fallback-a',
    )
  })

  it('mutateAccounts writes the caller-supplied config and state paths', async () => {
    await mutateAccounts((current) => {
      current.accounts.push(account('fallback-b'))
      return current
    }, paths)

    expect(existsSync(paths.configPath)).toBe(true)
    expect(existsSync(paths.statePath)).toBe(true)
    expect(existsSync(derivedStatePathBesideConfig())).toBe(false)
  })

  it('saveAccountState writes only the caller-supplied state path', async () => {
    await saveAccounts({ version: 1, accounts: [account('fallback-c')] }, paths)
    rmSync(paths.statePath)

    await saveAccountState(
      { version: 1, accounts: [account('fallback-c')] },
      paths,
    )

    expect(existsSync(paths.statePath)).toBe(true)
    expect(existsSync(derivedStatePathBesideConfig())).toBe(false)
  })

  it('migrateIfNeeded writes the caller-supplied config and state paths', async () => {
    await migrateIfNeeded(
      {
        type: 'oauth',
        access: 'main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 3_600_000,
      },
      paths,
    )

    expect(existsSync(paths.configPath)).toBe(true)
    expect(existsSync(paths.statePath)).toBe(true)
    expect(existsSync(derivedStatePathBesideConfig())).toBe(false)
  })

  it('loadAccounts reads the runtime state back from the caller-supplied path', async () => {
    await saveAccounts({ version: 1, accounts: [account('fallback-d')] }, paths)

    const loaded = await loadAccounts(paths)

    expect(loaded?.accounts.map((a) => a.id)).toEqual(['fallback-d'])
    expect((loaded?.accounts[0] as OAuthAccount | undefined)?.refresh).toBe(
      'refresh-fallback-d',
    )
  })

  it('exposes no store entry point that can be called without paths', () => {
    // `length` counts parameters before the first optional or defaulted one, so
    // a reintroduced `path = getAccountStoragePath()` default would drop these
    // counts and let a call site silently resolve some other host's store.
    expect(loadAccounts.length).toBe(1)
    expect(saveAccounts.length).toBe(2)
    expect(mutateAccounts.length).toBe(2)
    expect(saveAccountState.length).toBe(2)
    expect(migrateIfNeeded.length).toBe(2)
  })
})
