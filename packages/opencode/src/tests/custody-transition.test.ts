import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import type { AccountStorage } from '../core/accounts.ts'
import { liveAccount } from './custody-fixtures.ts'

describe('custody transition fingerprints', () => {
  it('slot fingerprints preserve the access-refresh boundary', async () => {
    const transition = await import('../core/custody-transition.ts')

    expect('ab' + 'c').toBe('a' + 'bc')
    expect(transition.custodySlotFingerprint('ab', 'c')).not.toBe(
      transition.custodySlotFingerprint('a', 'bc'),
    )
  })

  it('account store generation changes when a new oauth row is added or enabled', async () => {
    const transition = await import('../core/custody-transition.ts')
    const disabled = liveAccount('fallback-1', { enabled: false })
    const enabled = { ...disabled, enabled: true }
    const base: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [disabled],
    }

    expect(transition.accountStoreGeneration(base)).not.toBe(
      transition.accountStoreGeneration({ ...base, accounts: [enabled] }),
    )
    expect(transition.accountStoreGeneration(base)).not.toBe(
      transition.accountStoreGeneration({
        ...base,
        accounts: [disabled, liveAccount('fallback-2')],
      }),
    )
  })

  it('account store generation uses UTF-8 byte ordering for row fences', async () => {
    const transition = await import('../core/custody-transition.ts')
    const z = liveAccount('z')
    const umlaut = liveAccount('ä')
    const rows = [z, umlaut].map((account) => ({
      id: account.id,
      enabled: account.enabled !== false,
      accountId: account.accountId ?? '',
      access: account.access ?? '',
      refresh: account.refresh,
      expires: account.expires ?? null,
    }))
    const byteOrdered = createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')

    expect(
      transition.accountStoreGeneration({
        accounts: [umlaut, z],
      }),
    ).toBe(byteOrdered)
  })

  it('live account expiry is deterministic from injected now unless expires is explicit', () => {
    const now = 12_345

    expect(liveAccount('fallback-1', {}, now).expires).toBe(now + 3_600_000)
    expect(liveAccount('fallback-1', { expires: 99 }, now).expires).toBe(99)
  })
})
