// In-process rows for the account-pool migration and host-slot adoption:
// the placeholder, custody mode, older builds running against the same files
// (through openai-auth's real legacy functions), adoption of later logins,
// the slot fence and its declared race, and refreshing a pool row while
// older builds may refresh the same token.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
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
  isPoolPlaceholder,
  LegacyMainRefreshInFlightError,
  migrateToPool,
  POOL_MIGRATION_KEY,
  POOL_PLACEHOLDER,
  refreshPoolRow,
} from '../core/pool-migration.ts'
import { legacyRefreshMain } from './fixtures/legacy-main-refresh.ts'
import {
  FAR,
  type Harness,
  harness,
  jwt,
  legacyServedTokens,
  legacyUsableFallbackIds,
  login,
  MAIN_QUOTA,
  poolTokens,
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

  it('an active legacy lease on the slot token is waited out and never imported under', async () => {
    await seedLegacyInstall(h)
    await mutateAccounts((current) => {
      current.refresh = {
        ...current.refresh,
        mainRefreshLeaseId: 'crashed-holder',
        mainRefreshLeaseUntil: Date.now() + 60_000,
        mainRefreshLeaseTokenHash: hashRefreshToken('r-main'),
      }
      return current
    }, h.paths)
    expect(await migrateToPool(h.deps())).toEqual({
      status: 'retry',
      reason: 'legacy-refresh-in-progress',
    })
    expect((await h.slotValue())?.refresh).toBe('r-main')
    expect(await h.row('main')).toBeUndefined()
    // Once the legacy lease's end time has passed (a clock two minutes on),
    // the lease no longer counts and the migration proceeds.
    expect(
      await migrateToPool(h.deps({ now: () => Date.now() + 120_000 })),
    ).toMatchObject({ status: 'completed', rowId: 'main' })
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
    expect(await legacyServedTokens(h)).toEqual(['r-fb1', 'r-fb2', 'r-main'])
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

  it('the fence refuses the placeholder when the slot changed after it was read, and the next run adopts the newcomer', async () => {
    await migrated()
    await h.setSlot(login('acct-new', 'r-new'))
    const outcome = await adoptHostSlotLogin(
      h.deps({
        onStep: async (step) => {
          if (step === 'after-shield-drop')
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

  it('waits for an older build refreshing the target row under its fallback lock', async () => {
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

describe('refreshing a pool row while older builds run', () => {
  const rotated = {
    access: 'a-next',
    refresh: 'r-next',
    expires: FAR,
  }
  const quick = { legacyLocks: { timeoutMs: 300 } }

  it('waits on the legacy fallback lock an older build refreshes the row under', async () => {
    await migrated()
    const held = await acquireRefreshFileLock({
      name: fallbackRefreshLockName('main'),
      ttlMs: 60_000,
      path: h.paths.configPath,
    })
    let called = false
    const failure = await refreshPoolRow(
      { paths: h.paths, store: openStore(), ...quick },
      'main',
      async () => {
        called = true
        return rotated
      },
    ).catch((error: unknown) => error)
    await held?.release()
    expect(failure).toMatchObject({ kind: 'lock-contention' })
    expect(called).toBe(false)
  })

  it('waits on the legacy main-refresh lock for any row', async () => {
    await migrated()
    const held = await acquireRefreshFileLock({
      name: MAIN_REFRESH_LOCK_NAME,
      ttlMs: 60_000,
      path: h.paths.configPath,
    })
    let called = false
    const failure = await refreshPoolRow(
      { paths: h.paths, store: openStore(), ...quick },
      'fb1',
      async () => {
        called = true
        return rotated
      },
    ).catch((error: unknown) => error)
    await held?.release()
    expect(failure).toMatchObject({ kind: 'lock-contention' })
    expect(called).toBe(false)
  })

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
