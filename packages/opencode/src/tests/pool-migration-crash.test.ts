// Crash and cross-process rows for the account-pool migration: a child
// process runs the migration and dies at every named step (each pool-store
// file write, each of the module's own writes, and both sides of the host
// slot write), and the survivor checks what an older build and a newer build
// can still do before re-running the migration to completion.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  hashRefreshToken,
  loadAccounts,
} from '@cortexkit/openai-auth-core/internal'
import packageJson from '../../package.json' with { type: 'json' }
import {
  adoptHostSlotLogin,
  isPoolPlaceholder,
  migrateToPool,
  POOL_MIGRATION_KEY,
  type PoolTransferOutcome,
} from '../core/pool-migration.ts'
import { migrationFenceOpen, rpcStateRoot } from '../core/version-fence.ts'
import { writePortFile } from '../rpc/port-file.ts'
import {
  CRASH_EXIT_CODE,
  FAR,
  type Harness,
  harness,
  legacyUsableFallbackIds,
  login,
  MAIN_QUOTA,
  poolTokens,
  refreshAsOlderBuild,
  runChild,
  SHORT_LOCKS,
  seedLegacyInstall,
  T0,
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

/** The recorded steps from `first` through `last`, both included. */
function stepsFrom(first: string, last: string): Set<string> {
  const from = recorded.indexOf(first)
  const to = recorded.indexOf(last)
  if (from < 0 || to < from) throw new Error('unexpected step sequence')
  return new Set(recorded.slice(from, to + 1))
}

/**
 * From the pool row write until the placeholder write, the slot and the
 * `main` row hold the same refresh token. A pre-tolerant build (0.11.0 and
 * earlier) ignores `mainAccountId` in its background refresh (that shield
 * only steers its request routing), so after a crash anywhere in this window
 * it refreshes the token from the row and then again from the slot, and the
 * second refresh fails because the first spent it. The version fence keeps
 * the migration from starting while such a build is alive; what remains is a
 * downgrade to one after the crash, which is unsupported. Crash rows in this
 * window assert exactly that double refresh for the pre-tolerant build, and
 * that the fence is shut while it runs.
 */
const PRE_TOLERANT_DOUBLE = stepsFrom(
  'store:add:after-state-write',
  'before-placeholder-write',
)

/**
 * The declared shield gap. A tolerant build (the current core, which is what
 * runs beside a migration once the fence is open) skips the row that
 * `mainAccountId` names in its background refresh too. The migration drops
 * `mainAccountId` just before it writes the placeholder, so that older builds
 * see the `main` row once the slot no longer serves it. A crash between those
 * two writes leaves the token in both places with no shield, and a tolerant
 * build then refreshes it twice as well; the next migration run clears it by
 * writing the placeholder.
 */
const TOLERANT_SHIELD_GAP = stepsFrom(
  'after-shield-drop',
  'before-placeholder-write',
)

/**
 * The version fence as the crashed migrator would have seen it with a
 * pre-tolerant build running: this test process plays that build and
 * registers the way such builds do (an RPC port file and no heartbeat), and
 * the crashed child is the migrating process.
 */
async function fenceWithPreTolerantBuildRunning(
  migratorPid: number | undefined,
) {
  const stateHome = join(h.dir, 'xdg-state')
  await writePortFile(
    join(rpcStateRoot(stateHome), 'openai-auth-0123456789abcdef'),
    { pid: process.pid, port: 1, token: 'pre-tolerant-build' },
  )
  return migrationFenceOpen({
    stateHome,
    currentVersion: packageJson.version,
    ...(migratorPid !== undefined ? { selfPid: migratorPid } : {}),
  })
}

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
      // A pre-tolerant build refreshes main's token twice only inside
      // PRE_TOLERANT_DOUBLE, and there the fence is shut while it runs.
      const preTolerant = await refreshAsOlderBuild(h, 'pre-tolerant')
      expect(preTolerant.submitted).toContain('r-main')
      if (PRE_TOLERANT_DOUBLE.has(step)) {
        expect(preTolerant.refreshedTwice).toEqual(['r-main'])
        expect(await fenceWithPreTolerantBuildRunning(child.pid)).toMatchObject(
          {
            open: false,
            blockers: [{ pid: process.pid, version: 'unknown' }],
          },
        )
      } else {
        expect(preTolerant.refreshedTwice).toEqual([])
      }
      // A tolerant build refreshes it twice only in the declared shield gap.
      const tolerant = await refreshAsOlderBuild(h, 'tolerant')
      expect(tolerant.submitted).toContain('r-main')
      expect(tolerant.refreshedTwice).toEqual(
        TOLERANT_SHIELD_GAP.has(step) ? ['r-main'] : [],
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
      for (const build of ['pre-tolerant', 'tolerant'] as const)
        expect((await refreshAsOlderBuild(h, build)).refreshedTwice).toEqual([])
      expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'main'])
    }, 30_000)
  }
})

describe('the carry-over of the legacy main state', () => {
  it('a crash after the carry-over and a re-run carry it once: no quota reading or backoff is doubled', async () => {
    await seedLegacyInstall(h)
    const child = await runChild({
      dir: h.dir,
      mode: 'migrate',
      exitAtName: 'after-carry-over',
    })
    expect(child.code).toBe(CRASH_EXIT_CODE)
    const carried = (await h.row('main'))?.quota
    const expectedQuota = {
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
    }
    expect(carried).toEqual(expectedQuota)

    // The re-run resumes the recorded transfer after the `main` row write
    // and carries the legacy quota and backoff over a second time.
    expect(
      await settle(() => migrateToPool(h.deps({ ...SHORT_LOCKS }))),
    ).toMatchObject({ status: 'completed', operation: 'resumed' })
    expect((await h.row('main'))?.quota).toEqual(expectedQuota)
    const legacyMain = (await h.state()).accounts.main
    expect(legacyMain.quota).toEqual(MAIN_QUOTA)
    expect(legacyMain.lastRefreshError).toEqual({
      message: 'Token refresh failed: 500',
      checkedAt: T0,
      nextRetryAt: FAR,
      retryCount: 1,
      tokenHash: hashRefreshToken('r-main'),
    })
  }, 30_000)
})

describe('the shield that keeps older builds off the main row', () => {
  it('an install without mainAccountId is shielded too: after a crash with the row written, an older build routes requests for main only to the slot', async () => {
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
