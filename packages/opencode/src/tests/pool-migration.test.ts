// In-process rows for the account-pool migration and host-slot adoption:
// the placeholder, custody mode, older builds running against the same files
// (through openai-auth's real legacy functions), adoption of later logins,
// the slot fence and its declared race, and refreshing a pool row while
// older builds may refresh the same token.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore, rowLockKey } from '@cortexkit/common-auth/store'
import {
  buildRefreshOperationError,
  codexRefreshFn,
  fallbackRefreshLockName,
  hashRefreshToken,
  loadAccounts,
  migrateIfNeeded,
  mutateAccounts,
  refreshBackoffActive,
  saveAccountState,
  saveAccounts,
  writeClaustrumModeAndTransition,
} from '@cortexkit/openai-auth-core/internal'
import { classifyMainAuthSlot } from '../core/custody-host-slot.ts'
import { MAIN_REFRESH_LOCK_NAME } from '../core/custody-transition.ts'
import {
  adoptHostSlotLogin,
  type HostSlotAdapter,
  isPoolPlaceholder,
  LegacyMainRefreshInFlightError,
  migrateToPool,
  POOL_MIGRATION_KEY,
  POOL_PLACEHOLDER,
  poolTransferPendingInConfigFile,
  refreshPoolRow,
} from '../core/pool-migration.ts'
import {
  migrationFenceOpen,
  processHeartbeatDir,
} from '../core/version-fence.ts'
import { legacyRefreshMain } from './fixtures/legacy-main-refresh.ts'
import {
  FAR,
  type Harness,
  harness,
  jwt,
  legacyUsableFallbackIds,
  login,
  MAIN_QUOTA,
  poolTokens,
  refreshAsOlderBuild,
  seedLegacyInstall,
} from './fixtures/pool-migration-harness.ts'

let h: Harness
beforeEach(() => {
  h = harness()
})
afterEach(() => h.cleanup())

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function openStore() {
  return openPoolStore({
    provider: 'openai',
    configPath: h.paths.configPath,
    statePath: h.paths.statePath,
    quota: quotaCodec,
    lockOptions: { timeoutMs: 5_000 },
  })
}

async function migrated() {
  await seedLegacyInstall(h)
  expect(await migrateToPool(h.deps())).toMatchObject({
    status: 'completed',
    rowId: 'main',
    placeholder: 'written',
  })
}

describe('the slot placeholder', () => {
  it('only an exact match counts as the placeholder, and it is not the custody tombstone', () => {
    expect(isPoolPlaceholder({ ...POOL_PLACEHOLDER })).toBe(true)
    expect(POOL_PLACEHOLDER.refresh.startsWith('claustrum-tombstone:')).toBe(
      false,
    )
    for (const nearMiss of [
      { ...POOL_PLACEHOLDER, access: 'x' },
      { ...POOL_PLACEHOLDER, expires: 1 },
      { ...POOL_PLACEHOLDER, refresh: `${POOL_PLACEHOLDER.refresh}x` },
      { ...POOL_PLACEHOLDER, refresh: 'common-auth-placeholder:v1:' },
      { ...POOL_PLACEHOLDER, type: 'api' },
      { access: '', refresh: POOL_PLACEHOLDER.refresh, expires: 0 },
    ])
      expect(isPoolPlaceholder(nearMiss)).toBe(false)
  })

  it('an older build reads the placeholder as a real slot, fails one refresh on the network and then backs off on that token', async () => {
    expect(classifyMainAuthSlot({ ...POOL_PLACEHOLDER }).kind).toBe('real')
    const posted: string[] = []
    const failure = await codexRefreshFn({
      refreshToken: POOL_PLACEHOLDER.refresh,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        posted.push(String(init?.body))
        return new Response('{"error":"invalid_grant"}', { status: 400 })
      }) as unknown as typeof fetch,
      now: Date.now,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('common-auth-placeholder')
    const recorded = buildRefreshOperationError({
      error: failure,
      now: Date.now(),
      refreshToken: POOL_PLACEHOLDER.refresh,
    })
    expect(
      refreshBackoffActive(recorded, POOL_PLACEHOLDER.refresh, Date.now()),
    ).toBe(true)
  })
})

describe('migration', () => {
  it('moves the slot credential into row main, keeps every fallback and setting, and carries the legacy main quota and backoff', async () => {
    await migrated()
    const rows = await h.rows()
    expect(rows.map((row) => row.id)).toEqual(['fb1', 'key1', 'main'])
    const main = rows.find((row) => row.id === 'main')
    expect(main).toMatchObject({
      identity: 'acct-main',
      candidate: true,
      credentialEpoch: 1,
      needsFirstReading: false,
    })
    expect(main?.credential).toMatchObject({ refresh: 'r-main' })
    expect(main?.quota).toEqual({
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          checkedAt: MAIN_QUOTA.primary.checkedAt,
          usedPercent: 40,
          resetsAt: MAIN_QUOTA.primary.resetsAt,
          windowMinutes: 300,
        },
        {
          scope: 'all',
          label: 'secondary',
          kind: 'reading',
          checkedAt: MAIN_QUOTA.secondary.checkedAt,
          usedPercent: 10,
          resetsAt: MAIN_QUOTA.secondary.resetsAt,
          windowMinutes: 10_080,
        },
      ],
    })
    const state = await h.state()
    expect(state.accounts.main.lastRefreshError.tokenHash).toBe(
      hashRefreshToken('r-main'),
    )
    expect(state.accounts.main.quota.primary.usedPercent).toBe(40)
    const config = await h.config()
    expect(config.routing).toEqual({ mode: 'fallback-first' })
    expect(config.webSockets).toBe(true)
    expect(config.mainAccountId).toBeUndefined()
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    expect((await h.slot.all()).anthropic).toEqual({
      type: 'api',
      key: 'unrelated',
    })
  })

  it('a re-run after completion does nothing', async () => {
    await migrated()
    const before = await h.bytes()
    expect(await migrateToPool(h.deps())).toEqual({
      status: 'already-migrated',
    })
    expect(await h.bytes()).toEqual(before)
  })

  it('a slot token a fallback row already holds is rotated into that row, never copied into a second row', async () => {
    await seedLegacyInstall(h)
    await h.setSlot(login('acct-fb1', 'r-fb1', 'newer-access'))
    expect(await migrateToPool(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'fb1',
      operation: 'rotate',
    })
    expect(await poolTokens(h)).toEqual(['r-fb1'])
    expect(await h.row('main')).toBeUndefined()
  })

  it('with nothing in the slot it records the migration and writes no placeholder', async () => {
    await seedLegacyInstall(h)
    const map = await h.slot.all()
    delete map.openai
    await Bun.write(h.authPath, JSON.stringify(map))
    expect(await migrateToPool(h.deps())).toEqual({
      status: 'nothing-to-import',
      slot: 'slot-absent',
    })
    expect(await h.slotValue()).toBeUndefined()
    expect(await h.placeholderWrites()).toBe(0)
    expect((await h.config())[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
    expect((await h.config()).mainAccountId).toBeUndefined()
  })

  it('a mainAccountId written back by an older full-store save is removed again by the next run', async () => {
    await migrated()
    const stale = await loadAccounts(h.paths)
    if (!stale) throw new Error('no store')
    stale.mainAccountId = 'acct-main'
    await saveAccounts(stale, h.paths)
    expect((await h.config()).mainAccountId).toBe('acct-main')
    expect(await legacyUsableFallbackIds(h)).toEqual(['fb1'])
    expect((await migrateToPool(h.deps())).status).toBe('already-migrated')
    expect((await h.config()).mainAccountId).toBeUndefined()
    expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'main'])
  })
})

describe('claustrum custody mode', () => {
  it('writes nothing and logs the deferral once; after a switch to local mode it migrates', async () => {
    await seedLegacyInstall(h)
    await writeClaustrumModeAndTransition(h.paths, 'claustrum')
    const before = await h.bytes()
    const info: string[] = []
    const log = {
      info: (message: string) => info.push(message),
      warn: () => {},
    }
    expect(await migrateToPool(h.deps({ log }))).toEqual({
      status: 'deferred-claustrum',
    })
    expect(await adoptHostSlotLogin(h.deps({ log }))).toEqual({
      status: 'deferred-claustrum',
    })
    expect(await h.bytes()).toEqual(before)
    expect(info).toHaveLength(1)

    await writeClaustrumModeAndTransition(h.paths, 'local')
    expect(await migrateToPool(h.deps({ log }))).toMatchObject({
      status: 'completed',
      rowId: 'main',
    })
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main'])
  })
})

describe('older builds running at the same time', () => {
  it('a legacy main refresh holding the main-refresh lock makes the migration wait and import the rotated token', async () => {
    await seedLegacyInstall(h)
    const locked = deferred()
    const proceed = deferred()
    const legacy = legacyRefreshMain({
      paths: h.paths,
      slot: h.slot,
      hooks: {
        afterLock: async () => {
          locked.resolve()
          await proceed.promise
        },
      },
      refresh: async () => ({
        access: jwt('acct-main', 'rotated'),
        refresh: 'r-main-2',
        expires: FAR,
      }),
    })
    await locked.promise
    const migration = migrateToPool(h.deps())
    await Bun.sleep(300)
    proceed.resolve()
    await legacy
    expect(await migration).toMatchObject({ status: 'completed' })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-2',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  async function leaseSlotToken(holder: string) {
    await mutateAccounts((current) => {
      current.refresh = {
        ...current.refresh,
        mainRefreshLeaseId: holder,
        mainRefreshLeaseUntil: Date.now() + 60_000,
        mainRefreshLeaseTokenHash: hashRefreshToken('r-main'),
      }
      return current
    }, h.paths)
  }

  it('an active legacy lease on the slot token is waited out: the migration imports once the older build releases it', async () => {
    await seedLegacyInstall(h)
    await leaseSlotToken('older-build')
    let rowWhileLeased: unknown = 'not checked'
    const released = (async () => {
      await Bun.sleep(200)
      rowWhileLeased = await h.row('main')
      // The older build's refresh ends and clears its lease, as
      // `refreshMainWithLease` does in its `finally`.
      await mutateAccounts((current) => {
        if (current.refresh) {
          current.refresh.mainRefreshLeaseId = undefined
          current.refresh.mainRefreshLeaseUntil = undefined
          current.refresh.mainRefreshLeaseTokenHash = undefined
        }
        return current
      }, h.paths)
    })()
    const outcome = await migrateToPool(
      h.deps({ leaseWait: { timeoutMs: 5_000, pollMs: 20 } }),
    )
    await released
    expect(rowWhileLeased).toBeUndefined()
    expect(outcome).toMatchObject({ status: 'completed', rowId: 'main' })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('a legacy lease that outlasts the wait ends the run retryably and imports nothing', async () => {
    await seedLegacyInstall(h)
    await leaseSlotToken('crashed-holder')
    expect(await migrateToPool(h.deps())).toEqual({
      status: 'retry',
      reason: 'legacy-refresh-in-progress',
    })
    expect((await h.slotValue())?.refresh).toBe('r-main')
    expect(await h.row('main')).toBeUndefined()
  })

  it('a legacy mutateAccounts adding and removing fallbacks during the migration loses nothing', async () => {
    await seedLegacyInstall(h)
    const outcome = await migrateToPool(
      h.deps({
        onStep: async (step) => {
          if (step !== 'after-row-write') return
          await mutateAccounts((current) => {
            current.accounts = current.accounts.filter((a) => a.id !== 'key1')
            current.accounts.push({
              id: 'fb2',
              type: 'oauth',
              refresh: 'r-fb2',
              access: jwt('acct-fb2'),
              expires: FAR,
              accountId: 'acct-fb2',
              addedAt: 3,
            })
            return current
          }, h.paths)
        },
      }),
    )
    expect(outcome).toMatchObject({ status: 'completed', rowId: 'main' })
    expect((await h.rows()).map((row) => row.id)).toEqual([
      'fb1',
      'main',
      'fb2',
    ])
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-fb2', 'r-main'])
    expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'fb2', 'main'])
    // A pre-tolerant build still tries the slot and submits the placeholder
    // (which fails and is not counted); a tolerant one serves main from row
    // `main` instead.
    const preTolerant = await refreshAsOlderBuild(h, 'pre-tolerant')
    expect(preTolerant.submitted).toEqual(
      ['r-fb1', 'r-fb2', 'r-main', POOL_PLACEHOLDER.refresh].sort(),
    )
    expect(preTolerant.refreshedTwice).toEqual([])
    expect(await refreshAsOlderBuild(h, 'tolerant')).toEqual({
      refreshedTwice: [],
      submitted: ['r-fb1', 'r-fb2', 'r-main'],
      mainServedFrom: 'row main',
    })
  })

  it('a legacy mutateAccounts after the migration keeps the pool and the main row', async () => {
    await migrated()
    await mutateAccounts((current) => {
      current.accounts = current.accounts.filter((a) => a.id !== 'fb1')
      current.accounts.push({
        id: 'fb3',
        type: 'oauth',
        refresh: 'r-fb3',
        access: jwt('acct-fb3'),
        expires: FAR,
        addedAt: 4,
      })
      return current
    }, h.paths)
    expect(await poolTokens(h)).toEqual(['r-fb3', 'r-main'])
    expect((await h.row('main'))?.quota).toBeDefined()
    expect((await h.config())[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
    expect(await adoptHostSlotLogin(h.deps())).toEqual({
      status: 'nothing-to-import',
      slot: 'placeholder',
    })
  })

  it('after the migration an older build serves main as a fallback, and its writers keep every credential', async () => {
    await migrated()
    expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'main'])
    const storage = await loadAccounts(h.paths)
    if (!storage) throw new Error('no store')
    await saveAccounts(storage, h.paths)
    await mutateAccounts(() => undefined, h.paths)
    await saveAccountState(storage, h.paths)
    await migrateIfNeeded(login('acct-main', 'r-other'), h.paths)
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main'])
    expect(
      (await h.rows()).find((row) => row.id === 'key1')?.credential,
    ).toMatchObject({ apiKey: 'sk-key1' })
    expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'main'])
    const config = await h.config()
    expect(config.commonAuthPool.rows.main.credentialEpoch).toBe(1)
    expect(config[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
    expect(config.mainAccountId).toBeUndefined()
  })
})

describe('adoption of a later login in the slot', () => {
  it('does nothing before the migration ran', async () => {
    await seedLegacyInstall(h)
    expect(await adoptHostSlotLogin(h.deps())).toEqual({
      status: 'not-migrated',
    })
  })

  it('a login for a new identity becomes a new row named by that identity', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'acct-new',
      operation: 'add',
      placeholder: 'written',
    })
    expect(await h.row('acct-new')).toMatchObject({
      identity: 'acct-new',
      candidate: true,
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('a re-login with the same token rotates the row and keeps its credential epoch', async () => {
    await migrated()
    await h.setSlot(login('acct-main', 'r-main', 'fresh-access'))
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'rotate',
    })
    const main = await h.row('main')
    expect(main?.credentialEpoch).toBe(1)
    expect(main?.credential).toMatchObject({
      access: jwt('acct-main', 'fresh-access'),
    })
  })

  it('a re-login with a different token replaces the row and bumps its credential epoch', async () => {
    await migrated()
    await h.setSlot(login('acct-main', 'r-main-2'))
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'replace',
    })
    const main = await h.row('main')
    expect(main?.credentialEpoch).toBe(2)
    expect(main?.credential).toMatchObject({ refresh: 'r-main-2' })
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main-2'])
  })

  it('the fence refuses the placeholder when the slot changed after the transfer read it, and the next run adopts the newcomer', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    const outcome = await adoptHostSlotLogin(
      h.deps({
        onStep: async (step) => {
          if (step === 'after-verify')
            await h.setSlot(login('acct-other', 'r-other'))
        },
      }),
    )
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'acct-new',
      placeholder: 'slot-moved-on',
    })
    expect((await h.slotValue())?.refresh).toBe('r-other')
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'acct-other',
    })
  })

  it('declared: a login landing between the fence and the placeholder write is overwritten', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    const outcome = await adoptHostSlotLogin(
      h.deps({
        onStep: async (step) => {
          if (step === 'before-placeholder-write')
            await h.setSlot(login('acct-late', 'r-late'))
        },
      }),
    )
    // Declared race (the host slot has no compare-and-replace): the
    // placeholder overwrites the late login in the slot, the earlier login is
    // in the pool, and the late login is lost until the user logs in again.
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'acct-new',
      placeholder: 'written',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main', 'r-new'])
  })

  it('waits for an older build refreshing the target row under its fallback lock, then adopts', async () => {
    await migrated()
    await h.setSlot(login('acct-main', 'r-main', 'fresh-access'))
    const held = await acquireRefreshFileLock({
      name: fallbackRefreshLockName('main'),
      ttlMs: 60_000,
      path: h.paths.configPath,
    })
    let rowWhileHeld: unknown
    const released = (async () => {
      await Bun.sleep(300)
      rowWhileHeld = (await h.row('main'))?.credential
      await held?.release()
    })()
    const outcome = await adoptHostSlotLogin(h.deps())
    await released
    expect(rowWhileHeld).toMatchObject({ access: jwt('acct-main') })
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'rotate',
      placeholder: 'written',
    })
    expect((await h.row('main'))?.credential).toMatchObject({
      access: jwt('acct-main', 'fresh-access'),
      refresh: 'r-main',
    })
  })

  it('gives up retryably when the target row lock outlasts its bound', async () => {
    await migrated()
    await h.setSlot(login('acct-main', 'r-main', 'fresh-access'))
    const held = await acquireRefreshFileLock({
      name: fallbackRefreshLockName('main'),
      ttlMs: 60_000,
      path: h.paths.configPath,
    })
    const outcome = await adoptHostSlotLogin(
      h.deps({ legacyLocks: { timeoutMs: 300 } }),
    )
    await held?.release()
    expect(outcome).toEqual({ status: 'retry', reason: 'lock-contention' })
    expect((await h.row('main'))?.credential).toMatchObject({
      access: jwt('acct-main'),
    })
    expect((await h.slotValue())?.refresh).toBe('r-main')
  })

  it('refuses the placeholder write when the host auth map reads empty', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    const outcome = await adoptHostSlotLogin(
      h.deps({ slot: { ...h.slot, all: async () => ({}) } }),
    )
    expect(outcome).toEqual({ status: 'retry', reason: 'torn-read' })
    expect((await h.slotValue())?.refresh).toBe('r-new')
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'acct-new',
      operation: 'resumed',
    })
  })

  it('a login landing right after the placeholder write is reported and adopted next', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    const outcome = await adoptHostSlotLogin(
      h.deps({
        onStep: async (step) => {
          if (step === 'after-placeholder-write')
            await h.setSlot(login('acct-late', 'r-late'))
        },
      }),
    )
    expect(outcome).toMatchObject({ placeholder: 'overwritten' })
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'acct-late',
    })
  })
})

describe('verification of the row write', () => {
  it('a row write that lands wrong stops the transfer before the slot is touched', async () => {
    await seedLegacyInstall(h)
    const outcome = await migrateToPool(
      h.deps({
        store: {
          // Right after the store writes the new row's credential, something
          // rewrites it: the row no longer holds the slot's token.
          onStep: async (step, info) => {
            if (info.operation !== 'add' || step !== 'after-state-write') return
            const state = await h.state()
            state.accounts.main = { ...state.accounts.main, refresh: 'r-wrong' }
            await Bun.write(h.paths.statePath, JSON.stringify(state))
          },
        },
      }),
    )
    expect(outcome).toEqual({ status: 'retry', reason: 'verify-failed' })
    expect(await h.slotValue()).toEqual(login('acct-main', 'r-main'))
    expect(await h.placeholderWrites()).toBe(0)
    const config = await h.config()
    expect(config[POOL_MIGRATION_KEY].pending).toMatchObject({ rowId: 'main' })
    expect(config[POOL_MIGRATION_KEY].migratedAt).toBeUndefined()
    expect(config.mainAccountId).toBe('acct-main')
  })
})

// The transfer no longer holds a row's legacy fallback lock while it plans:
// the store takes that lock (as an extra lock, after the row's pool lock) for
// the row write itself. A slot that changes while the write waits for the
// lock is caught afterwards, at the placeholder fence.
describe('a slot that changes while the row write waits for its legacy lock', () => {
  function holdRowLock(rowId: string) {
    return acquireRefreshFileLock({
      name: fallbackRefreshLockName(rowId),
      ttlMs: 60_000,
      path: h.paths.configPath,
    })
  }

  it('a new login of the same account: the newer login wins in the same run', async () => {
    await migrated()
    await h.setSlot(login('acct-main', 'r-main-2'))
    const held = await holdRowLock('main')
    let rowWhileHeld: unknown
    const change = (async () => {
      await Bun.sleep(300)
      rowWhileHeld = (await h.row('main'))?.credential
      await h.setSlot(login('acct-main', 'r-main-3', 'third'))
      await held?.release()
    })()
    const outcome = await adoptHostSlotLogin(h.deps())
    await change
    // Nothing was written to the row while its legacy lock was held.
    expect(rowWhileHeld).toMatchObject({ refresh: 'r-main' })
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'main',
      operation: 'replace',
      placeholder: 'written',
    })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-3',
    })
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main-3'])
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('a new login for another row: that row is written only under its own lock', async () => {
    await migrated()
    await h.setSlot(login('acct-main', 'r-main-2'))
    const mainHeld = await holdRowLock('main')
    // An older build holds the fb1 row's fallback refresh lock throughout,
    // as it does while it refreshes that row.
    const fb1Held = await holdRowLock('fb1')
    const change = (async () => {
      await Bun.sleep(300)
      await h.setSlot(login('acct-fb1', 'r-fb1-2'))
      await mainHeld?.release()
    })()
    // The main row's write waited out its lock and landed; the slot had
    // moved on to another account's login, which is left for the next run.
    const outcome = await adoptHostSlotLogin(h.deps())
    await change
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'main',
      placeholder: 'slot-moved-on',
    })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-2',
    })
    expect(
      await adoptHostSlotLogin(h.deps({ legacyLocks: { timeoutMs: 1_000 } })),
    ).toEqual({ status: 'retry', reason: 'lock-contention' })
    await fb1Held?.release()
    expect((await h.row('fb1'))?.credential).toMatchObject({ refresh: 'r-fb1' })
    expect((await h.slotValue())?.refresh).toBe('r-fb1-2')
    // Once the older build has released the fb1 lock, the next run resumes
    // the transfer the contended run recorded, into the fb1 row.
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'fb1',
      operation: 'resumed',
    })
    expect((await h.row('fb1'))?.credential).toMatchObject({
      refresh: 'r-fb1-2',
    })
    // Two lock waits (one of them to its one-second bound) plus three full
    // runs: more than the default five seconds on a loaded machine.
  }, 15_000)
})

describe('the slot reads at the placeholder fence', () => {
  /** The file slot, with reads that can be made to fail on demand. */
  function unreliableSlot() {
    let missing = 0
    let missed = 0
    let torn: 'no' | 'absent' | 'partial' = 'no'
    const slot: HostSlotAdapter = {
      get: async (input) => {
        if (torn === 'absent') return undefined
        if (torn === 'partial') return { type: 'oauth' }
        if (missing > 0) {
          missing--
          missed++
          return undefined
        }
        return h.slot.get(input)
      },
      set: (input) => h.slot.set(input),
      all: async () => (torn === 'no' ? h.slot.all() : {}),
    }
    return {
      slot,
      missed: () => missed,
      missOnce: () => {
        missing = 1
      },
      tear: (how: 'absent' | 'partial') => {
        torn = how
      },
    }
  }

  it('one missing read of the slot at the fence is not taken for a slot that moved on', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    const host = unreliableSlot()
    const outcome = await adoptHostSlotLogin(
      h.deps({
        slot: host.slot,
        onStep: async (reached) => {
          if (reached === 'after-verify') host.missOnce()
        },
      }),
    )
    expect(host.missed()).toBe(1)
    expect(outcome).toMatchObject({
      status: 'completed',
      rowId: 'acct-new',
      placeholder: 'written',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    expect((await h.config())[POOL_MIGRATION_KEY].pending).toBeUndefined()
  })

  for (const [how, reason] of [
    ['absent', 'host-slot-indeterminate'],
    ['partial', 'torn-read'],
  ] as const) {
    it(`a torn host read at the fence (slot ${how}, auth map empty) ends the run retryably and keeps the record`, async () => {
      await migrated()
      await h.setSlot(login('acct-new', 'r-new'))
      const host = unreliableSlot()
      const outcome = await adoptHostSlotLogin(
        h.deps({
          slot: host.slot,
          onStep: async (reached) => {
            if (reached === 'after-verify') host.tear(how)
          },
        }),
      )
      expect(outcome).toEqual({ status: 'retry', reason })
      expect((await h.slotValue())?.refresh).toBe('r-new')
      expect(await h.placeholderWrites()).toBe(1)
      expect((await h.config())[POOL_MIGRATION_KEY].pending).toMatchObject({
        rowId: 'acct-new',
      })
      // Once the host slot reads normally again, the next run resumes the
      // recorded transfer and writes the placeholder.
      expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
        status: 'completed',
        rowId: 'acct-new',
        operation: 'resumed',
        placeholder: 'written',
      })
    })
  }
})

describe('the version fence', () => {
  const blockers = [{ pid: 4242, version: 'unknown', detail: 'port-4242.json' }]
  const shut = async () => ({ open: false as const, blockers })

  it('while an older version runs, the migration writes nothing and names it', async () => {
    await seedLegacyInstall(h)
    const before = await h.bytes()
    expect(await migrateToPool(h.deps({ fence: shut }))).toEqual({
      status: 'deferred',
      reason: 'older-version-running',
      blockers,
    })
    expect(await h.bytes()).toEqual(before)
    expect(await h.placeholderWrites()).toBe(0)
    // Once the fence opens (no older process left), the migration runs.
    expect(await migrateToPool(h.deps())).toMatchObject({
      status: 'completed',
      rowId: 'main',
    })
  })

  it('reads the processes on disk: a live older version defers the migration', async () => {
    await seedLegacyInstall(h)
    const stateHome = join(h.dir, 'xdg-state')
    mkdirSync(processHeartbeatDir(stateHome), { recursive: true })
    writeFileSync(
      join(processHeartbeatDir(stateHome), '4242.json'),
      JSON.stringify({ pid: 4242, version: '0.11.0', startedAt: 1 }),
    )
    const live = new Set([4242])
    const fence = () =>
      migrationFenceOpen({
        stateHome,
        currentVersion: '0.12.0',
        isAlive: (pid) => live.has(pid),
      })
    const before = await h.bytes()
    expect(await migrateToPool(h.deps({ fence }))).toMatchObject({
      status: 'deferred',
      blockers: [{ pid: 4242, version: '0.11.0' }],
    })
    expect(await h.bytes()).toEqual(before)
    live.delete(4242)
    expect(await migrateToPool(h.deps({ fence }))).toMatchObject({
      status: 'completed',
    })
  })

  it('a fence that fails keeps the migration deferred', async () => {
    await seedLegacyInstall(h)
    const before = await h.bytes()
    expect(
      await migrateToPool(
        h.deps({
          fence: async () => {
            throw new Error('no state directory')
          },
        }),
      ),
    ).toEqual({
      status: 'deferred',
      reason: 'older-version-running',
      blockers: [
        { pid: 'unknown', version: 'unknown', detail: 'no state directory' },
      ],
    })
    expect(await h.bytes()).toEqual(before)
  })

  it('an interrupted transfer is not resumed while the fence is shut', async () => {
    await seedLegacyInstall(h)
    const crash = new Error('crash after the row write')
    await expect(
      migrateToPool(
        h.deps({
          onStep: async (step) => {
            if (step === 'after-row-write') throw crash
          },
        }),
      ),
    ).rejects.toBe(crash)
    const before = await h.bytes()
    expect((await h.config())[POOL_MIGRATION_KEY].pending).toBeDefined()
    expect(await migrateToPool(h.deps({ fence: shut }))).toMatchObject({
      status: 'deferred',
    })
    expect(await h.bytes()).toEqual(before)
    expect(await migrateToPool(h.deps())).toMatchObject({
      status: 'completed',
      operation: 'resumed',
    })
  })

  it('adoptHostSlotLogin itself ignores the fence; the background runner applies it', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    expect(await adoptHostSlotLogin(h.deps({ fence: shut }))).toMatchObject({
      status: 'completed',
      rowId: 'acct-new',
    })
  })
})

describe('lock order of a transfer', () => {
  // A pool refresh (`refreshPoolRow`) holds the row's pool lock and the
  // provider-wide lock, then waits for `main-refresh` and the row's fallback
  // lock. A transfer that held either legacy lock while it waited for the
  // row's pool lock would wait on that refresh while the refresh waits on it.
  it('a row write waiting for the row pool lock holds neither legacy lock', async () => {
    await seedLegacyInstall(h)
    const poolRowLock = await acquireRefreshFileLock({
      name: `row-${encodeURIComponent(rowLockKey({ id: 'main', identity: 'acct-main' }))}`,
      ttlMs: 60_000,
      path: h.paths.statePath,
    })
    expect(poolRowLock).not.toBeNull()
    const running = migrateToPool(h.deps())
    // Long enough for the run to reach the row write and wait there.
    await Bun.sleep(400)
    const free: Record<string, boolean> = {}
    for (const name of [
      MAIN_REFRESH_LOCK_NAME,
      fallbackRefreshLockName('main'),
    ]) {
      const probe = await acquireRefreshFileLock({
        name,
        ttlMs: 60_000,
        path: h.paths.configPath,
      })
      free[name] = probe !== null
      await probe?.release()
    }
    const stillWaiting = (await h.row('main'))?.credential === undefined
    await poolRowLock?.release()
    expect(await running).toMatchObject({
      status: 'completed',
      rowId: 'main',
      placeholder: 'written',
    })
    expect(stillWaiting).toBe(true)
    expect(free).toEqual({
      [MAIN_REFRESH_LOCK_NAME]: true,
      [fallbackRefreshLockName('main')]: true,
    })
  })
})

describe('the pending record and the slot refresh', () => {
  it('names the token being moved, and only that token', async () => {
    await seedLegacyInstall(h)
    let during: [boolean, boolean] | undefined
    const outcome = await migrateToPool(
      h.deps({
        onStep: async (step) => {
          if (step !== 'after-record-write') return
          during = [
            poolTransferPendingInConfigFile(h.paths.configPath, 'r-main'),
            poolTransferPendingInConfigFile(h.paths.configPath, 'r-other'),
          ]
        },
      }),
    )
    expect(outcome).toMatchObject({ status: 'completed' })
    expect(during).toEqual([true, false])
    expect(poolTransferPendingInConfigFile(h.paths.configPath, 'r-main')).toBe(
      false,
    )
  })

  it('a slot refresh leased before the record lands makes the run plan again, never copy the spent token', async () => {
    await seedLegacyInstall(h)
    let leased = false
    const written: unknown[] = []
    const outcome = await migrateToPool(
      h.deps({
        onStep: async (step) => {
          if (step === 'after-row-write') {
            const credential = (await h.row('main'))?.credential
            written.push(
              credential?.type === 'oauth' ? credential.refresh : undefined,
            )
          }
          // A refresh that took its lease between the run's slot read and
          // its record write, and has since rotated the slot and cleared
          // its lease: the token the run read is spent.
          if (step !== 'after-record-write' || leased) return
          leased = true
          await h.setSlot(login('acct-main', 'r-main-rotated', 'rotated'))
        },
      }),
    )
    expect(leased).toBe(true)
    expect(written).toEqual(['r-main-rotated'])
    expect(outcome).toMatchObject({ status: 'completed', rowId: 'main' })
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main-rotated'])
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })
})

describe('a slot refresh still leased after the record lands', () => {
  it('the row is not written while the lease covers the token', async () => {
    await seedLegacyInstall(h)
    let leased = false
    const outcome = await migrateToPool(
      h.deps({
        onStep: async (step) => {
          if (step !== 'after-record-write' || leased) return
          leased = true
          await mutateAccounts((current) => {
            current.refresh = {
              ...current.refresh,
              mainRefreshLeaseId: 'refresh-in-flight',
              mainRefreshLeaseUntil: Date.now() + 60_000,
              mainRefreshLeaseTokenHash: hashRefreshToken('r-main'),
            }
            return current
          }, h.paths)
        },
      }),
    )
    expect(leased).toBe(true)
    expect(outcome).toEqual({
      status: 'retry',
      reason: 'legacy-refresh-in-progress',
    })
    expect((await h.row('main'))?.credential).toBeUndefined()
    expect(await h.slotValue()).toEqual(login('acct-main', 'r-main'))
  })
})

describe('routing mode on completion', () => {
  async function seedWithRouting(routing: unknown) {
    await seedLegacyInstall(h)
    const config = await h.config()
    if (routing === undefined) delete config.routing
    else config.routing = routing
    writeFileSync(h.paths.configPath, JSON.stringify(config))
  }

  it('an unset mode becomes main-first in the write that marks the migration done', async () => {
    await seedWithRouting(undefined)
    let routingBeforeMarker: unknown = 'unread'
    const outcome = await migrateToPool(
      h.deps({
        onStep: async (step) => {
          if (step === 'after-placeholder-write')
            routingBeforeMarker = (await h.config()).routing
        },
      }),
    )
    expect(outcome).toMatchObject({ status: 'completed', rowId: 'main' })
    expect(routingBeforeMarker).toBeUndefined()
    const config = await h.config()
    expect(config.routing).toEqual({ mode: 'main-first' })
    expect(config[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
  })

  it('a routing object without a mode keeps its other settings', async () => {
    await seedWithRouting({ stickyBreakMinutes: 7 })
    await migrateToPool(h.deps())
    expect((await h.config()).routing).toEqual({
      stickyBreakMinutes: 7,
      mode: 'main-first',
    })
  })

  for (const mode of ['fallback-first', 'sticky-balanced', 'main-first']) {
    it(`an explicit ${mode} is left alone`, async () => {
      await seedWithRouting({ mode })
      await migrateToPool(h.deps())
      expect((await h.config()).routing).toEqual({ mode })
    })
  }

  it('an adoption never writes the mode', async () => {
    await migrated()
    const config = await h.config()
    delete config.routing
    writeFileSync(h.paths.configPath, JSON.stringify(config))
    await h.setSlot(login('acct-new', 'r-new'))
    expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
      status: 'completed',
    })
    expect((await h.config()).routing).toBeUndefined()
  })
})

describe('refreshing a pool row while older builds run', () => {
  const rotated = {
    access: 'a-next',
    refresh: 'r-next',
    expires: FAR,
  }
  const quick = { legacyLocks: { timeoutMs: 300 } }

  for (const [lock, rowId] of [
    ['the legacy fallback lock an older build refreshes the row under', 'main'],
    ['the legacy main-refresh lock, for any row', 'fb1'],
  ] as const) {
    const name = () =>
      rowId === 'main'
        ? fallbackRefreshLockName('main')
        : MAIN_REFRESH_LOCK_NAME

    it(`waits on ${lock}, and refreshes once it is released`, async () => {
      await migrated()
      const held = await acquireRefreshFileLock({
        name: name(),
        ttlMs: 60_000,
        path: h.paths.configPath,
      })
      let calledWhileHeld: boolean | undefined
      let called = false
      const released = (async () => {
        await Bun.sleep(300)
        calledWhileHeld = called
        await held?.release()
      })()
      const outcome = await refreshPoolRow(
        {
          paths: h.paths,
          store: openStore(),
          legacyLocks: { timeoutMs: 5_000 },
        },
        rowId,
        async () => {
          called = true
          return rotated
        },
      )
      await released
      expect(calledWhileHeld).toBe(false)
      expect(outcome).toMatchObject({ status: 'rotated', rowId })
      expect((await h.row(rowId))?.credential).toMatchObject({
        refresh: 'r-next',
      })
    })

    it(`gives up on ${lock} after its bound without calling the provider`, async () => {
      await migrated()
      const held = await acquireRefreshFileLock({
        name: name(),
        ttlMs: 60_000,
        path: h.paths.configPath,
      })
      let called = false
      const failure = await refreshPoolRow(
        { paths: h.paths, store: openStore(), ...quick },
        rowId,
        async () => {
          called = true
          return rotated
        },
      ).catch((error: unknown) => error)
      await held?.release()
      expect(failure).toMatchObject({ kind: 'lock-contention' })
      expect(called).toBe(false)
    })
  }

  it('never refreshes a token covered by an active legacy main lease', async () => {
    await migrated()
    await mutateAccounts((current) => {
      current.refresh = {
        ...current.refresh,
        mainRefreshLeaseId: 'older-build',
        mainRefreshLeaseUntil: Date.now() + 60_000,
        mainRefreshLeaseTokenHash: hashRefreshToken('r-main'),
      }
      return current
    }, h.paths)
    let called = false
    const failure = await refreshPoolRow(
      {
        paths: h.paths,
        store: openStore(),
        leaseWait: { timeoutMs: 100, pollMs: 20 },
      },
      'main',
      async () => {
        called = true
        return rotated
      },
    ).catch((error: unknown) => error)
    expect(called).toBe(false)
    expect(failure).toMatchObject({ kind: 'provider', retryable: true })
    expect((failure as { cause?: unknown }).cause).toBeInstanceOf(
      LegacyMainRefreshInFlightError,
    )
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main',
    })
  })

  it('rotates the row when no older build holds anything', async () => {
    await migrated()
    const outcome = await refreshPoolRow(
      { paths: h.paths, store: openStore() },
      'main',
      async () => rotated,
    )
    expect(outcome).toMatchObject({ status: 'rotated', rowId: 'main' })
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-next',
    })
  })
})
