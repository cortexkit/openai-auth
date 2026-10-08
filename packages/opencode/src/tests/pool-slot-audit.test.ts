import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { opencode1ClientSlot } from '../core/host-slot'
import { PoolAccountSource } from '../core/pool-account-source'
import { createPoolLifecycle } from '../core/pool-lifecycle'
import {
  adoptHostSlotLogin,
  isPoolPlaceholder,
  migrateToPool,
  POOL_PLACEHOLDER,
} from '../core/pool-migration'
import { routableRows } from '../core/pool-request'
import { opencode1HostSlot } from '../v2/host-slot'
import {
  type Harness,
  harness,
  login,
  poolTokens,
  seedLegacyInstall,
} from './fixtures/pool-migration-harness'

const fixtures: Harness[] = []
const fresh = () => {
  const h = harness()
  fixtures.push(h)
  return h
}
afterEach(() => {
  for (const h of fixtures.splice(0)) h.cleanup()
})

describe('login slot audit', () => {
  test('two config roots sharing auth.json have only one refresh-token owner', async () => {
    const a = fresh()
    const b = fresh()
    await seedLegacyInstall(a)
    await seedLegacyInstall(b)
    let release!: () => void
    let copied!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      copied = resolve
    })
    const shared = opencode1HostSlot(a.authPath)
    const first = migrateToPool(
      a.deps({
        slot: shared,
        onStep: async (step) => {
          if (step === 'after-row-write') {
            copied()
            await hold
          }
        },
      }),
    )
    await ready
    let competing: Awaited<ReturnType<typeof migrateToPool>>
    try {
      competing = await migrateToPool(
        b.deps({
          slot: opencode1HostSlot(a.authPath),
          legacyLocks: { timeoutMs: 30, retryMs: 5 },
        }),
      )
    } finally {
      release()
    }
    await first
    await migrateToPool(b.deps({ slot: opencode1HostSlot(a.authPath) }))
    const owners = [
      ...(await poolTokens(a)),
      (await b.state()).accounts?.main?.refresh,
    ].filter((token) => token === 'r-main')
    expect(owners).toHaveLength(1)
    expect(competing.status).toBe('retry')
    expect(competing).toMatchObject({ reason: 'lock-contention' })
  })

  test('a foreign placeholder cannot complete an interrupted transfer', async () => {
    const a = fresh()
    const b = fresh()
    await seedLegacyInstall(a)
    await seedLegacyInstall(b)
    await migrateToPool(b.deps())
    const foreign = await b.slotValue()
    const outcome = await migrateToPool(
      a.deps({
        onStep: async (step) => {
          if (step === 'after-row-write') await a.setSlot(foreign)
        },
      }),
    )
    expect(outcome.status).toBe('refused')
    expect(await poolTokens(a)).not.toContain('r-main')
    expect(await a.slotValue()).toEqual(foreign)
  })

  test('a foreign placeholder in readback cannot complete custody', async () => {
    const a = fresh()
    const b = fresh()
    await seedLegacyInstall(a)
    await seedLegacyInstall(b)
    await migrateToPool(b.deps())
    const foreign = await b.slotValue()
    const outcome = await migrateToPool(
      a.deps({
        onStep: async (step) => {
          if (step === 'after-placeholder-write') await a.setSlot(foreign)
        },
      }),
    )
    expect(outcome.status).toBe('refused')
    expect(await poolTokens(a)).not.toContain('r-main')
    expect(await a.slotValue()).toEqual(foreign)
  })

  test('environment-backed auth never migrates or overwrites a disk login', async () => {
    const h = fresh()
    await seedLegacyInstall(h)
    await h.setSlot(login('disk-account', 'disk-refresh'))
    const before = await h.bytes()
    const warned: string[] = []
    const slot = opencode1ClientSlot({
      path: h.authPath,
      env: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          openai: login('env-account', 'env-refresh'),
        }),
      },
      set: (input) => h.slot.set(input),
    })
    const deps = h.deps({
      slot,
      log: {
        info: (message, data) => warned.push(`${message}: ${data?.reason}`),
        warn: (message) => warned.push(message),
      },
    })
    await migrateToPool(deps)
    await migrateToPool(deps)
    await adoptHostSlotLogin(deps)
    expect(await h.bytes()).toEqual(before)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('OPENCODE_AUTH_CONTENT')
    expect(await slot.get({ path: { id: 'openai' } })).toEqual(
      login('env-account', 'env-refresh'),
    )
  })

  test('an API-key slot does not block the OAuth pool migration', async () => {
    const h = fresh()
    await seedLegacyInstall(h)
    const api = { type: 'api', key: 'platform-key' }
    await h.setSlot(api)
    expect(
      await migrateToPool(h.deps({ slot: opencode1HostSlot(h.authPath) })),
    ).toEqual({ status: 'nothing-to-import', slot: 'api' })
    expect((await h.config()).openaiAuthPool.migratedAt).toBeNumber()
    expect(await h.slotValue()).toEqual(api)
    expect(await poolTokens(h)).not.toContain('r-main')
  })

  test('the OpenCode 1 writer refuses a login changed since its fence read', async () => {
    const h = fresh()
    await seedLegacyInstall(h)
    let writes = 0
    const slot = opencode1ClientSlot({
      path: h.authPath,
      env: {},
      set: async (input) => {
        writes++
        return h.slot.set(input)
      },
    })
    await slot.get({ path: { id: 'openai' } })
    const newer = login('new-account', 'new-refresh')
    await h.setSlot(newer)
    await expect(
      slot.set({ path: { id: 'openai' }, body: POOL_PLACEHOLDER }),
    ).rejects.toThrow('changed')
    expect(writes).toBe(0)
    expect(await h.slotValue()).toEqual(newer)
  })

  test('the lifecycle restores the placeholder while the vault serves', async () => {
    const h = fresh()
    await seedLegacyInstall(h)
    await migrateToPool(h.deps())
    await h.setSlot({ ...login('stray-account', 'stray-refresh'), expires: 0 })
    const lifecycle = createPoolLifecycle({
      paths: () => h.paths,
      slot: h.slot,
      version: '1.0.0',
      fence: async () => ({ open: true }),
      runDeps: { vaultServes: () => true },
      timers: { set: () => 1, clear: () => {} },
    })
    try {
      lifecycle.start()
      await lifecycle.idle()
      expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
      expect(await poolTokens(h)).toContain('stray-refresh')
      // The imported copy cannot compete with the vault's owner for refresh
      // or routing, even when the newly signed-in token is already expired.
      const identities = new Set(['stray-account'])
      const refreshed: string[] = []
      const polled: string[] = []
      const source = new PoolAccountSource({
        paths: () => h.paths,
        vaultIdentities: () => identities,
        refreshProvider: async (credential) => {
          refreshed.push(credential.refresh)
          return {
            access: credential.access ?? 'rotated',
            refresh: `${credential.refresh}-next`,
            expires: Date.now() + 3600_000,
          }
        },
        pullQuota: async (request) => {
          polled.push(request.id)
          return undefined
        },
      })
      try {
        await source.load()
        await source.poolStore().pullsSettled()
        await source.prepareTokens(await h.rows(), null, { waitForAll: true })
        expect(polled).not.toContain('stray-account')
        expect(refreshed).not.toContain('stray-refresh')
        expect(
          routableRows(await h.rows(), null, Date.now(), identities).some(
            (row) => row.identity === 'stray-account',
          ),
        ).toBe(false)
      } finally {
        source.dispose()
        await source.settled()
      }
    } finally {
      lifecycle.dispose()
    }
  })

  test('an interrupted adoption resumes when the vault starts serving', async () => {
    const h = fresh()
    await seedLegacyInstall(h)
    await migrateToPool(h.deps())
    await h.setSlot(login('stray-account', 'stray-refresh'))
    await expect(
      adoptHostSlotLogin(
        h.deps({
          onStep: (step) => {
            if (step === 'after-row-write')
              throw new Error('interrupted adoption')
          },
        }),
      ),
    ).rejects.toThrow('interrupted adoption')
    expect(
      await adoptHostSlotLogin(h.deps({ vaultServes: () => true })),
    ).toMatchObject({ status: 'completed', operation: 'resumed' })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    expect((await h.config()).openaiAuthPool.pending).toBeUndefined()
  })

  test('the downgrade warning explains the empty bearer', async () => {
    const readme = await readFile(
      new URL('../../../../README.md', import.meta.url),
      'utf8',
    )
    expect(readme).toContain(
      'Downgrading after the account-pool migration is unsupported',
    )
    expect(readme).toContain('empty bearer')
  })
})
