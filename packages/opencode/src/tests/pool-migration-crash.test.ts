// Crash and cross-process rows for the account-pool migration: a child
// process runs the migration and dies at every named step (each pool-store
// file write, each of the module's own writes, and both sides of the host
// slot write), and the survivor checks what an older build and a newer build
// can still do before re-running the migration to completion.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import { loadAccounts } from '@cortexkit/openai-auth-core/internal'
import {
  adoptHostSlotLogin,
  isPoolPlaceholder,
  migrateToPool,
  POOL_MIGRATION_KEY,
  type PoolTransferOutcome,
} from '../core/pool-migration.ts'
import {
  CRASH_EXIT_CODE,
  type Harness,
  harness,
  legacyServedTokens,
  legacyUsableFallbackIds,
  login,
  poolTokens,
  runChild,
  SHORT_LOCKS,
  seedLegacyInstall,
} from './fixtures/pool-migration-harness.ts'

let h: Harness
beforeEach(() => {
  h = harness()
})
afterEach(() => h.cleanup())

/** Runs until the outcome is no longer a retry (a crashed child's leases expire). */
async function settle(
  run: () => Promise<PoolTransferOutcome>,
): Promise<PoolTransferOutcome> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const outcome = await run()
    if (outcome.status !== 'retry') return outcome
  }
  throw new Error('still retrying')
}

// One uncrashed run records the full step sequence the crash rows walk.
const recorded = await (async () => {
  const probe = harness()
  try {
    await seedLegacyInstall(probe)
    const run = await runChild({ dir: probe.dir, mode: 'migrate' })
    if (run.code !== 0) throw new Error(`probe run failed:\n${run.output}`)
    return run.steps
  } finally {
    probe.cleanup()
  }
})()

/**
 * Between removing `mainAccountId` from the config (which until then keeps
 * older builds off the `main` row) and writing the placeholder, an older
 * build can serve main's token from both the slot and the row. That gap is
 * a declared boundary of the migration; crashes at these two steps assert
 * that outcome instead of a single copy.
 */
const SHIELD_GAP = new Set(['after-shield-drop', 'before-placeholder-write'])

describe('a crash at every step of the migration', () => {
  it('walks every store write, every module write and both slot-write sides', () => {
    expect(recorded).toEqual(
      expect.arrayContaining([
        'store:initialize:before-config-write',
        'store:initialize:after-config-write',
        'after-pool-key-write',
        'after-record-write',
        'store:add:before-config-write',
        'store:add:after-config-write',
        'store:add:before-state-write',
        'store:add:after-state-write',
        'after-row-write',
        'after-verify',
        'store:pull:after-config-write',
        'after-carry-over',
        'after-shield-drop',
        'before-placeholder-write',
        'after-placeholder-write',
        'after-record-clear',
      ]),
    )
  })

  for (const [index, step] of recorded.entries()) {
    it(`crash at step ${index} (${step}): both builds keep every account and a re-run completes`, async () => {
      await seedLegacyInstall(h)
      const child = await runChild({
        dir: h.dir,
        mode: 'migrate',
        exitAtIndex: index,
      })
      expect(child.code).toBe(CRASH_EXIT_CODE)
      expect(child.steps.at(-1)).toBe(step)

      // An older build still loads every fallback with its credential.
      const legacy = await loadAccounts(h.paths)
      expect(legacy).not.toBeNull()
      const byId = new Map(legacy?.accounts.map((a) => [a.id, a]))
      expect(byId.get('fb1')).toMatchObject({ refresh: 'r-fb1' })
      expect(byId.get('key1')).toMatchObject({ apiKey: 'sk-key1' })
      // ...and serves main from exactly one place (slot or `main` row),
      // except in the declared shield gap, where it can see both.
      const served = await legacyServedTokens(h)
      expect(served).toEqual(
        SHIELD_GAP.has(step)
          ? ['r-fb1', 'r-main', 'r-main']
          : ['r-fb1', 'r-main'],
      )

      // A newer build can read the pool (or sees a legacy roster it will
      // migrate), no two rows share a token, and main's token is reachable.
      const load = await openPoolStore({
        provider: 'openai',
        configPath: h.paths.configPath,
        statePath: h.paths.statePath,
        quota: quotaCodec,
      }).read()
      expect(load.status).not.toBe('error')
      if (load.status === 'ready') {
        const tokens = await poolTokens(h)
        expect(new Set(tokens).size).toBe(tokens.length)
        const slot = await h.slotValue()
        expect(tokens.includes('r-main') || slot?.refresh === 'r-main').toBe(
          true,
        )
      } else {
        expect((await h.slotValue())?.refresh).toBe('r-main')
      }

      // The re-run completes.
      const outcome = await settle(() =>
        migrateToPool(h.deps({ ...SHORT_LOCKS })),
      )
      expect(['completed', 'already-migrated']).toContain(outcome.status)
      expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
      expect(await h.placeholderWrites()).toBe(1)
      expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main'])
      const main = await h.row('main')
      expect(main).toMatchObject({ identity: 'acct-main', candidate: true })
      expect(main?.quota).toBeDefined()
      const config = await h.config()
      expect(config.mainAccountId).toBeUndefined()
      expect(config[POOL_MIGRATION_KEY].pending).toBeUndefined()
      expect(config[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
      expect(config.routing).toEqual({ mode: 'fallback-first' })
      expect(config.webSockets).toBe(true)
      expect(await legacyServedTokens(h)).toEqual(['r-fb1', 'r-main'])
      expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'main'])
    }, 30_000)
  }
})

describe('the shield that keeps older builds off the main row', () => {
  it('an install without mainAccountId is shielded too: after a crash with the row written, an older build serves main only from the slot', async () => {
    await seedLegacyInstall(h)
    const config = await h.config()
    delete config.mainAccountId
    await Bun.write(h.paths.configPath, JSON.stringify(config))
    const child = await runChild({
      dir: h.dir,
      mode: 'migrate',
      exitAtName: 'after-row-write',
    })
    expect(child.code).toBe(CRASH_EXIT_CODE)
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main'])
    expect((await h.slotValue())?.refresh).toBe('r-main')
    expect(await legacyServedTokens(h)).toEqual(['r-fb1', 'r-main'])
    expect(await legacyUsableFallbackIds(h)).toEqual(['fb1'])
  }, 30_000)
})

describe('two migrators at once', () => {
  it('two processes migrating together make one pool, one main row and one placeholder write', async () => {
    await seedLegacyInstall(h)
    const [a, b] = await Promise.all([
      runChild({ dir: h.dir, mode: 'migrate' }),
      runChild({ dir: h.dir, mode: 'migrate' }),
    ])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    const statuses = [a.outcome?.status, b.outcome?.status].sort()
    expect(statuses).toEqual(['already-migrated', 'completed'])
    expect(await h.placeholderWrites()).toBe(1)
    const rows = await h.rows()
    expect(rows.map((row) => row.id).sort()).toEqual(['fb1', 'key1', 'main'])
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main'])
  }, 30_000)
})

describe('a crash while adopting a later login', () => {
  async function migratedWithRelogin() {
    await seedLegacyInstall(h)
    expect((await migrateToPool(h.deps())).status).toBe('completed')
    // The user logs in again as the main account: a different login.
    await h.setSlot(login('acct-main', 'r-main-2', 'relogin'))
  }

  it('a crash after the record, before the row, redoes the transfer', async () => {
    await migratedWithRelogin()
    const child = await runChild({
      dir: h.dir,
      mode: 'adopt',
      exitAtName: 'after-record-write',
    })
    expect(child.code).toBe(CRASH_EXIT_CODE)
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main',
    })
    const outcome = await settle(() =>
      adoptHostSlotLogin(h.deps({ ...SHORT_LOCKS })),
    )
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'resumed',
      placeholder: 'written',
    })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-2',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  }, 30_000)

  it('a crash after the row took the slot credential finishes with the placeholder', async () => {
    await migratedWithRelogin()
    const child = await runChild({
      dir: h.dir,
      mode: 'adopt',
      exitAtName: 'store:replace:after-state-write',
    })
    expect(child.code).toBe(CRASH_EXIT_CODE)
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-2',
    })
    expect((await h.slotValue())?.refresh).toBe('r-main-2')
    const outcome = await settle(() =>
      adoptHostSlotLogin(h.deps({ ...SHORT_LOCKS })),
    )
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'resumed',
      placeholder: 'written',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main-2'])
  }, 30_000)

  it('a crash followed by a rotation of the row leaves the slot alone and declines that slot value until the next login', async () => {
    await migratedWithRelogin()
    const child = await runChild({
      dir: h.dir,
      mode: 'adopt',
      exitAtName: 'after-row-write',
    })
    expect(child.code).toBe(CRASH_EXIT_CODE)
    // Someone refreshes the row after the crash: it now holds neither its
    // old credential nor the slot's.
    const store = openPoolStore({
      provider: 'openai',
      configPath: h.paths.configPath,
      statePath: h.paths.statePath,
      quota: quotaCodec,
      lockOptions: { timeoutMs: 10_000 },
    })
    await store.refresh('main', async () => ({
      access: 'a-3',
      refresh: 'r-main-3',
      expires: 4_000_000_000_000,
    }))
    const logged: string[] = []
    const outcome = await settle(() =>
      adoptHostSlotLogin(
        h.deps({
          ...SHORT_LOCKS,
          log: { info: () => {}, warn: (message) => logged.push(message) },
        }),
      ),
    )
    expect(outcome).toEqual({ status: 'ambiguous', rowId: 'main' })
    expect(logged).toHaveLength(1)
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-3',
    })
    expect((await h.slotValue())?.refresh).toBe('r-main-2')
    expect((await h.config())[POOL_MIGRATION_KEY].pending).toBeUndefined()
    // A later adoption run must not write the older token still in the slot
    // over the rotated row credential.
    expect(await adoptHostSlotLogin(h.deps({ ...SHORT_LOCKS }))).toEqual({
      status: 'nothing-to-import',
      slot: 'declined',
    })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-3',
    })
    // A new login puts a fresh credential into the slot, which is adopted.
    await h.setSlot(login('acct-main', 'r-main-4', 'again'))
    expect(await adoptHostSlotLogin(h.deps({ ...SHORT_LOCKS }))).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'replace',
    })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-4',
    })
  }, 30_000)
})
