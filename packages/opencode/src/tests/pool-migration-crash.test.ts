// Crash and cross-process rows for the account-pool migration: a child
// process runs the migration and dies at every named step (each pool-store
// file write, each of the module's own writes, and both sides of the host
// slot write), and the survivor checks what an older build and a newer build
// can still do before re-running the migration to completion.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
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
  POOL_PLACEHOLDER,
  type PoolTransferOutcome,
  poolPlaceholderWithoutMain,
} from '../core/pool-migration.ts'
import { migrationFenceOpen, rpcStateRoot } from '../core/version-fence.ts'
import { writePortFile } from '../rpc/port-file.ts'
import { createFailurePhaseClock } from './failure-phase-clock.ts'
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
import {
  expireDeadChildLocks,
  type LockTiming,
  observeMigrationLocks,
  readEvictionMarker,
  readLease,
} from './fixtures/pool-migration-lock-clock.ts'

let h: Harness
let cleanupClock: (() => void) | undefined
beforeEach(() => {
  h = harness()
})
afterEach(() => {
  cleanupClock?.()
  cleanupClock = undefined
  h.cleanup()
})

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
    if (run.code !== 0 || run.outcome?.status !== 'completed')
      throw new Error(`probe run did not complete:\n${run.output}`)
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
 *
 * The store's `add` writes the state file (the credential) first and the
 * config (the roster row) second, and a credential no roster row names is
 * loaded by no reader. So the window opens once the config write lands.
 */
const PRE_TOLERANT_DOUBLE = stepsFrom(
  'store:add:after-config-write',
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
  it('expires only confirmed-dead child locks and their renewal markers', async () => {
    const dead = `${h.paths.configPath}.pool-migration.lock`
    const replaced = `${h.paths.configPath}.main-refresh.lock`
    for (const [path, ownerId] of [
      [dead, 'dead-holder'],
      [replaced, 'successor'],
    ] as const) {
      writeFileSync(path, JSON.stringify({ ownerId, expiresAt: FAR }))
      mkdirSync(`${path}.evicting`)
      writeFileSync(
        `${path}.evicting/owner.json`,
        JSON.stringify({ ownerId: `${ownerId}-marker` }),
      )
    }
    const replacementMtime = statSync(`${replaced}.evicting`).mtimeMs
    const child = {
      pid: undefined,
      code: CRASH_EXIT_CODE,
      steps: [],
      output: '',
      stderr: '',
      locks: [],
    }
    const timings: LockTiming[] = [
      {
        path: dead,
        name: 'pool-migration',
        ownerId: 'dead-holder',
        offsetMs: 0,
        attempts: 1,
        contended: false,
      },
      {
        path: replaced,
        name: 'main-refresh',
        ownerId: 'previous-holder',
        offsetMs: 0,
        attempts: 1,
        contended: false,
      },
    ]
    expect(() =>
      expireDeadChildLocks({ ...child, code: null }, timings),
    ).toThrow('cannot expire locks before the expected crash exit')
    expect(readLease(dead)).toEqual({ ownerId: 'dead-holder', expiresAt: FAR })
    expireDeadChildLocks(child, timings)
    expect(readLease(dead)).toEqual({ ownerId: 'dead-holder', expiresAt: 0 })
    expect(statSync(`${dead}.evicting`).mtimeMs).toBe(0)
    expect(readLease(replaced)).toEqual({
      ownerId: 'successor',
      expiresAt: FAR,
    })
    expect(statSync(`${replaced}.evicting`).mtimeMs).toBe(replacementMtime)
    const lock = await acquireRefreshFileLock({
      path: h.paths.configPath,
      name: 'pool-migration',
      ttlMs: 10_000,
    })
    expect(lock).not.toBeNull()
    await lock?.assertOwned()
    await lock?.release()
  })

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
        'before-placeholder-write',
        'after-placeholder-write',
        'after-record-clear',
      ]),
    )
    // Nothing is written between the fence read and the placeholder, and
    // the shield goes in the same write that clears the record.
    expect(recorded.slice(-4)).toEqual([
      'after-carry-over',
      'before-placeholder-write',
      'after-placeholder-write',
      'after-record-clear',
    ])
  })

  it('a crash at step 1 expires its dead lease and a fresh renewal marker', async () => {
    await seedLegacyInstall(h)
    let deadPath = ''
    const child = await runChild(
      { dir: h.dir, mode: 'migrate', exitAtIndex: 1 },
      {
        start: () => () => {},
        step: () => {},
        locks: () => {},
        beforeDeadLockExpiry: (exited) => {
          const held = exited.locks.find(
            (entry) => entry.name === 'pool-migration',
          )
          expect(held?.ownerId).toBeDefined()
          if (!held) throw new Error('crash child did not report its held lock')
          deadPath = held.path
          expect(readLease(deadPath)?.ownerId).toBe(held.ownerId)
          // Put the confirmed-dead child's marker in the fresh state a crash
          // during renewal can leave, without relying on timer scheduling.
          mkdirSync(`${deadPath}.evicting`, { recursive: true })
          writeFileSync(
            `${deadPath}.evicting/owner.json`,
            JSON.stringify({ ownerId: 'dead-renewal' }),
          )
          const fresh = new Date()
          utimesSync(`${deadPath}.evicting`, fresh, fresh)
          expect(readEvictionMarker(deadPath)?.remainingMs).toBeGreaterThan(0)
        },
      },
    )
    expect(child.code, child.output).toBe(CRASH_EXIT_CODE)
    expect(child.steps.at(-1)).toBe('store:initialize:after-config-write')
    expect(readLease(deadPath)?.expiresAt).toBe(0)
    expect(statSync(`${deadPath}.evicting`).mtimeMs).toBe(0)
  }, 30_000)

  for (const [index, step] of recorded.entries()) {
    it(`crash at step ${index} (${step}): both builds keep every account and a re-run completes`, async () => {
      const traced = index === 16
      let stopChild: (() => void) | undefined
      let locks: ReturnType<typeof observeMigrationLocks> | undefined
      let childLocks: LockTiming[] = []
      const childSteps: string[] = []
      const deadLeases: Array<{
        path: string
        ownerId: string
        remainingMs: number
      }> = []
      const deadMarkers: Array<{
        path: string
        ownerId?: string
        remainingMs: number
      }> = []
      const clock = createFailurePhaseClock(() => ({
        childSteps,
        childLocks,
        deadLeases,
        deadMarkers,
        locks: locks?.snapshot().map((entry) => ({
          ...entry,
          waitedForDeadHolderLease:
            entry.contended &&
            (entry.holderRemainingMs ?? 0) > 0 &&
            deadLeases.some((lease) => lease.ownerId === entry.holder?.ownerId),
          waitedForDeadHolderMarker:
            entry.contended &&
            (entry.marker?.remainingMs ?? 0) > 0 &&
            deadMarkers.some(
              (marker) =>
                marker.path === entry.path &&
                marker.ownerId === entry.marker?.ownerId,
            ),
        })),
      }))
      const run = async () => {
        await clock.phase('seed legacy install', () => seedLegacyInstall(h))
        const child = await runChild(
          {
            dir: h.dir,
            mode: 'migrate',
            exitAtIndex: index,
            ...(traced ? { traceLocks: true } : {}),
          },
          traced
            ? {
                start: clock.start,
                step: (name) => childSteps.push(name),
                locks: (timings) => {
                  childLocks = timings
                },
                registerCleanup: (stop) => {
                  stopChild = stop
                },
                beforeDeadLockExpiry: (child) => {
                  // Capture residual leases before the harness expires them.
                  for (const entry of child.locks) {
                    const lease = readLease(entry.path)
                    if (lease && lease.ownerId === entry.ownerId)
                      deadLeases.push({
                        path: entry.path,
                        ownerId: lease.ownerId,
                        remainingMs: lease.expiresAt - Date.now(),
                      })
                  }
                  for (const path of new Set(
                    child.locks.map((entry) => entry.path),
                  )) {
                    const marker = readEvictionMarker(path)
                    if (marker) deadMarkers.push({ path, ...marker })
                  }
                },
              }
            : undefined,
        )
        expect(child.code, child.output).toBe(CRASH_EXIT_CODE)
        expect(child.steps.at(-1)).toBe(step)

        // An older build still loads every fallback with its credential.
        const legacy = await clock.phase('older build load', () =>
          loadAccounts(h.paths),
        )
        expect(legacy).not.toBeNull()
        const byId = new Map(legacy?.accounts.map((a) => [a.id, a]))
        expect(byId.get('fb1')).toMatchObject({ refresh: 'r-fb1' })
        expect(byId.get('key1')).toMatchObject({ apiKey: 'sk-key1' })
        // A pre-tolerant build refreshes main's token twice only inside
        // PRE_TOLERANT_DOUBLE, and there the fence is shut while it runs.
        const preTolerant = await clock.phase(
          'older build pre-tolerant refresh',
          () => refreshAsOlderBuild(h, 'pre-tolerant'),
        )
        expect(preTolerant.submitted).toContain('r-main')
        if (PRE_TOLERANT_DOUBLE.has(step)) {
          expect(preTolerant.refreshedTwice).toEqual(['r-main'])
          expect(
            await fenceWithPreTolerantBuildRunning(child.pid),
          ).toMatchObject({
            open: false,
            blockers: [{ pid: process.pid, version: 'unknown' }],
          })
        } else {
          expect(preTolerant.refreshedTwice).toEqual([])
        }
        // A tolerant build (the current core, which is what runs beside a
        // migration once the fence is open) never refreshes a token twice:
        // the shield stays up until the placeholder is in the slot, and from
        // then on it serves main from row `main`.
        const tolerant = await clock.phase('older build tolerant refresh', () =>
          refreshAsOlderBuild(h, 'tolerant'),
        )
        expect(tolerant.submitted).toContain('r-main')
        expect(tolerant.refreshedTwice).toEqual([])
        expect(tolerant.mainServedFrom).toBe(
          isPoolPlaceholder(await h.slotValue()) ? 'row main' : 'slot',
        )

        // A newer build can read the pool (or sees a legacy roster it will
        // migrate), no two rows share a token, and main's token is reachable.
        const load = await clock.phase('newer build read', () =>
          openPoolStore({
            provider: 'openai',
            configPath: h.paths.configPath,
            statePath: h.paths.statePath,
            quota: quotaCodec,
          }).read(),
        )
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
        const outcome = await clock.phase('migration re-run', () =>
          settle(() => migrateToPool(h.deps({ ...SHORT_LOCKS }))),
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
          expect(
            (
              await clock.phase(`completed older build ${build} refresh`, () =>
                refreshAsOlderBuild(h, build),
              )
            ).refreshedTwice,
          ).toEqual([])
        expect(await legacyUsableFallbackIds(h)).toEqual(['fb1', 'main'])
      }
      if (!traced) return run()
      locks = observeMigrationLocks()
      let finished = false
      // Bun's timeout rejects the test, not its still-running async body. Keep
      // reporting later phases and restore the observer in teardown as well.
      const deadline = setInterval(
        () => clock.report('body still running past 10000 ms'),
        10_000,
      )
      cleanupClock = () => {
        if (!finished) clock.report('test teardown before body completed')
        stopChild?.()
        clearInterval(deadline)
        locks?.restore()
      }
      try {
        await clock.run(`crash at step ${index} (${step})`, run)
      } finally {
        finished = true
        cleanupClock?.()
        cleanupClock = undefined
      }
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

describe('the shield lasts until the placeholder is in the slot', () => {
  for (const step of [
    'after-record-write',
    'before-placeholder-write',
    'after-placeholder-write',
    'after-record-clear',
  ] as const) {
    it(`an own migration at ${step} cannot be refused as a foreign placeholder`, async () => {
      // Every crash row starts in a new directory with a real slot login.
      // The child has no competing writer; older builds are run only after
      // it exits. Before the placeholder write there is no placeholder to
      // refuse. Afterwards the already-verified row is durable, and until
      // completion its pending record is durable as well.
      await seedLegacyInstall(h)
      expect(isPoolPlaceholder(await h.slotValue())).toBe(false)
      const child = await runChild({
        dir: h.dir,
        mode: 'migrate',
        exitAtName: step,
      })
      expect(child.code, child.output).toBe(CRASH_EXIT_CODE)
      expect(child.steps.at(-1)).toBe(step)
      const placeholderWritten =
        step === 'after-placeholder-write' || step === 'after-record-clear'
      expect(isPoolPlaceholder(await h.slotValue())).toBe(placeholderWritten)
      const config = await h.config()
      if (step === 'after-record-clear') {
        expect(config[POOL_MIGRATION_KEY].pending).toBeUndefined()
        expect(config[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
      } else {
        expect(config[POOL_MIGRATION_KEY].pending.rowId).toBe('main')
        expect(config.mainAccountId).toBe('acct-main')
      }
      const main = await h.row('main')
      if (step === 'after-record-write') {
        expect(main).toBeUndefined()
        // Even if a reader already saw the newer placeholder, the pending
        // record alone keeps the store from being mistaken for another setup.
        expect(
          await poolPlaceholderWithoutMain(h.paths, POOL_PLACEHOLDER),
        ).toBe(false)
      } else
        expect(main?.credential).toMatchObject({
          type: 'oauth',
          refresh: 'r-main',
        })

      const before = await h.bytes()
      expect(
        await poolPlaceholderWithoutMain(h.paths, await h.slotValue()),
      ).toBe(false)
      expect(await h.bytes()).toEqual(before)
      const outcome = await settle(() =>
        migrateToPool(h.deps({ ...SHORT_LOCKS })),
      )
      expect(['completed', 'already-migrated']).toContain(outcome.status)
      expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main'])
    }, 30_000)
  }

  it('a crash between the placeholder write and the shield drop: a tolerant build serves main from row main with no double refresh, and a re-run drops the shield', async () => {
    await seedLegacyInstall(h)
    const child = await runChild({
      dir: h.dir,
      mode: 'migrate',
      exitAtName: 'after-placeholder-write',
    })
    expect(
      child.code,
      `child steps: ${JSON.stringify(child.steps)}\nchild stderr:\n${child.stderr}\nchild output:\n${child.output}`,
    ).toBe(CRASH_EXIT_CODE)
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    const crashed = await h.config()
    expect(crashed.mainAccountId).toBe('acct-main')
    expect(crashed[POOL_MIGRATION_KEY].pending).toMatchObject({
      rowId: 'main',
    })

    // The tolerant build's background refresh skips the shielded row and its
    // main path refreshes row `main` once, as the main account.
    expect(await refreshAsOlderBuild(h, 'tolerant')).toEqual({
      refreshedTwice: [],
      submitted: ['r-fb1', 'r-main'],
      mainServedFrom: 'row main',
    })

    expect(
      await settle(() => migrateToPool(h.deps({ ...SHORT_LOCKS }))),
    ).toMatchObject({
      status: 'completed',
      operation: 'resumed',
      placeholder: 'already-present',
    })
    const config = await h.config()
    expect(config.mainAccountId).toBeUndefined()
    expect(config[POOL_MIGRATION_KEY].pending).toBeUndefined()
    expect(config[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
    expect(await h.placeholderWrites()).toBe(1)
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
