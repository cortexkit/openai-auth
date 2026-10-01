import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountPaths,
  type AccountStorage,
  FallbackAccountManager,
  loadAccounts,
  type OAuthAccount,
  ShieldedMainRowRefreshError,
  saveAccounts,
} from '../internal.ts'

/**
 * A roster row whose ChatGPT account equals `mainAccountId` is a second copy of
 * the main slot's credential (the account-pool migration creates one while the
 * slot copy is still live). Refreshing it spends the refresh token the slot is
 * still using, so no background loop and no direct refresh may touch it.
 *
 * Every row here expires INSIDE the refresh-before-expiry window (10 minutes
 * against the 240-minute default). A far expiry would make every loop skip the
 * row for being fresh, and these tests would pass with the shield removed.
 */

const MAIN_IDENTITY = 'chatgpt-main'

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-main-row-shield-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function dueRow(id: string, accountId: string): OAuthAccount {
  return {
    id,
    type: 'oauth',
    enabled: true,
    accountId,
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 10 * 60_000,
  }
}

async function seed(): Promise<void> {
  const storage: AccountStorage = {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    mainAccountId: MAIN_IDENTITY,
    quota: { enabled: true },
    accounts: [
      dueRow('shadow', MAIN_IDENTITY),
      dueRow('other', 'chatgpt-other'),
    ],
  }
  await saveAccounts(storage, paths)
}

function managerRecording(refreshed: string[], polled: string[]) {
  return new FallbackAccountManager({
    paths,
    refreshFn: async ({ refreshToken }) => {
      refreshed.push(refreshToken)
      return {
        access: `${refreshToken}-access-next`,
        refresh: `${refreshToken}-next`,
        expires: Date.now() + 3600_000,
        expiresIn: 3600,
      }
    },
    fetchQuotaFn: async ({ accessToken }) => {
      polled.push(accessToken)
      return {
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: Date.now(),
        },
      }
    },
  })
}

describe('background refresh honours the main-row shield', () => {
  it('refreshDueAccounts skips the row holding the main account', async () => {
    await seed()
    const refreshed: string[] = []
    await managerRecording(refreshed, []).refreshDueAccounts()
    expect(refreshed).toEqual(['refresh-other'])
    const stored = await loadAccounts(paths)
    const shadow = stored?.accounts.find(
      (a) => a.id === 'shadow',
    ) as OAuthAccount
    expect(shadow.refresh).toBe('refresh-shadow')
    // Not even attempted: an attempt refused further down would still arm a
    // refresh backoff on the row.
    expect(shadow.lastRefreshError).toBeUndefined()
  })

  it('refreshQuotaForDueAccounts skips the row holding the main account', async () => {
    await seed()
    const refreshed: string[] = []
    const polled: string[] = []
    await managerRecording(refreshed, polled).refreshQuotaForDueAccounts()
    expect(refreshed).toEqual(['refresh-other'])
    expect(polled).not.toContain('access-shadow')
    const shadow = (await loadAccounts(paths))?.accounts.find(
      (a) => a.id === 'shadow',
    ) as OAuthAccount
    expect(shadow.lastQuotaRefreshError).toBeUndefined()
  })

  it('refreshQuotaForAllAccounts skips the row holding the main account', async () => {
    await seed()
    const refreshed: string[] = []
    const polled: string[] = []
    const { errors } = await managerRecording(
      refreshed,
      polled,
    ).refreshQuotaForAllAccounts({ force: true })
    expect(refreshed).toEqual(['refresh-other'])
    expect(polled).not.toContain('access-shadow')
    expect(errors).toEqual([])
  })

  it('refreshAccount refuses the row holding the main account', async () => {
    await seed()
    const refreshed: string[] = []
    const manager = managerRecording(refreshed, [])
    const storage = (await loadAccounts(paths)) as AccountStorage
    const shadow = storage.accounts.find(
      (a) => a.id === 'shadow',
    ) as OAuthAccount
    await expect(
      manager.refreshAccount(shadow, storage),
    ).rejects.toBeInstanceOf(ShieldedMainRowRefreshError)
    expect(refreshed).toEqual([])
  })

  it('refreshAccount serves the row as the pool main when asked to', async () => {
    await seed()
    const refreshed: string[] = []
    const manager = managerRecording(refreshed, [])
    const storage = (await loadAccounts(paths)) as AccountStorage
    const shadow = storage.accounts.find(
      (a) => a.id === 'shadow',
    ) as OAuthAccount
    const next = await manager.refreshAccount(shadow, storage, {
      asPoolMain: true,
    })
    expect(refreshed).toEqual(['refresh-shadow'])
    expect(next.refresh).toBe('refresh-shadow-next')
  })
})
