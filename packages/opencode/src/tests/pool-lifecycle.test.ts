// The background runner of the account-pool migration and of later
// adoptions (`core/pool-lifecycle.ts`), against a real legacy install on disk,
// the file-backed host slot and the real version fence over a temporary state
// home. Timers are fake: each test fires the retry timer itself.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPoolLifecycle,
  POOL_RETRY_MAX_MS,
  type PoolLifecycle,
  type PoolLifecycleDeps,
} from '../core/pool-lifecycle.ts'
import {
  adoptHostSlotLogin,
  isPoolPlaceholder,
  migrateToPool,
  POOL_MIGRATION_KEY,
  POOL_PLACEHOLDER,
} from '../core/pool-migration.ts'
import {
  migrationFenceOpen,
  processHeartbeatDir,
  rpcStateRoot,
} from '../core/version-fence.ts'
import {
  type Harness,
  harness,
  login,
  poolTokens,
  seedLegacyInstall,
} from './fixtures/pool-migration-harness.ts'

const VERSION = '1.0.0'
const OLDER_PID = 424_242

let h: Harness
let stateHome: string
let alive: Set<number>
let lifecycle: PoolLifecycle | undefined

beforeEach(() => {
  h = harness()
  stateHome = mkdtempSync(join(tmpdir(), 'pool-lifecycle-state-'))
  alive = new Set()
  lifecycle = undefined
})
afterEach(() => {
  lifecycle?.dispose()
  h.cleanup()
  rmSync(stateHome, { recursive: true, force: true })
})

/** Timers the test fires by hand; `delays` lists what is pending. */
function fakeTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 0
  return {
    set(run: () => void, ms: number) {
      next++
      pending.set(next, { run, ms })
      return next
    },
    clear(handle: unknown) {
      pending.delete(handle as number)
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire() {
      const due = [...pending.values()]
      pending.clear()
      for (const entry of due) entry.run()
    },
  }
}

function logSink() {
  const info: Array<{ message: string; data?: Record<string, unknown> }> = []
  const warn: Array<{ message: string; data?: Record<string, unknown> }> = []
  return {
    info,
    warn,
    log: {
      info: (message: string, data?: Record<string, unknown>) => {
        info.push({ message, data })
      },
      warn: (message: string, data?: Record<string, unknown>) => {
        warn.push({ message, data })
      },
    },
  }
}

function writeOlderHeartbeat(version = '0.11.0') {
  const dir = processHeartbeatDir(stateHome)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${OLDER_PID}.json`),
    JSON.stringify({ pid: OLDER_PID, version, startedAt: 1 }),
  )
  alive.add(OLDER_PID)
}

function writeHeartbeatlessPortFile() {
  const dir = join(rpcStateRoot(stateHome), 'openai-auth-0123456789abcdef')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `port-${OLDER_PID}.json`), '{}')
  alive.add(OLDER_PID)
}

function create(extra: Partial<PoolLifecycleDeps> = {}) {
  const timers = fakeTimers()
  const sink = logSink()
  lifecycle = createPoolLifecycle({
    paths: () => h.paths,
    slot: h.slot,
    version: VERSION,
    log: sink.log,
    fence: () =>
      migrationFenceOpen({
        stateHome,
        currentVersion: VERSION,
        isAlive: (pid) => alive.has(pid),
      }),
    timers,
    random: () => 0,
    runDeps: {
      legacyLocks: { timeoutMs: 10_000 },
      leaseWait: { timeoutMs: 300, pollMs: 20 },
    },
    ...extra,
  })
  return { lifecycle, timers, sink }
}

const deferrals = (sink: ReturnType<typeof logSink>) =>
  sink.info.filter((entry) =>
    entry.message.startsWith('account pool migration deferred'),
  )

describe('the migration in the background', () => {
  it('a shared placeholder cannot migrate an empty separate store', async () => {
    writeFileSync(
      h.paths.configPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      }),
    )
    writeFileSync(h.paths.statePath, '{"version":1,"accounts":{}}')
    await h.setSlot(POOL_PLACEHOLDER)
    const before = await h.bytes()
    const outcomes: unknown[] = []
    const { lifecycle, timers, sink } = create({
      migrate: async (deps) => {
        const outcome = await migrateToPool(deps)
        outcomes.push(outcome)
        return outcome
      },
    })
    lifecycle.start()
    await lifecycle.idle()
    expect(lifecycle.migrated()).toBe(false)
    expect(await h.bytes()).toEqual(before)
    expect(outcomes).toEqual([
      { status: 'refused', reason: 'placeholder-without-main' },
    ])
    expect(sink.warn).toHaveLength(1)
    expect(sink.warn[0]?.message).toContain('opencode auth login')
    expect(sink.warn[0]?.message).toContain('OPENCODE_OPENAI_AUTH_FILE')
    expect(sink.warn[0]?.message).toContain('OPENCODE_OPENAI_AUTH_STATE_FILE')
    timers.fire()
    await lifecycle.idle()
    expect(await h.bytes()).toEqual(before)
    expect(sink.warn).toHaveLength(1)

    // Signing in for this setup must unblock the refused migration, without
    // needing a restart or waiting for its next background timer.
    await h.setSlot(login('acct-separate', 'r-separate'))
    await lifecycle.requestAdoption()
    expect(lifecycle.migrated()).toBe(true)
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-separate',
    })
  })

  it('start runs the migration without being awaited, and completes it', async () => {
    await seedLegacyInstall(h)
    const { lifecycle, timers } = create()
    lifecycle.start()
    // Nothing ran synchronously: start only queued the run.
    expect((await h.slotValue())?.refresh).toBe('r-main')
    await lifecycle.idle()
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main',
    })
    expect(lifecycle.migrated()).toBe(true)
    // Once migrated, the timer only keeps the adoption check going.
    expect(timers.delays()).toEqual([POOL_RETRY_MAX_MS])
  })

  it('an initialized empty pool still cannot claim a shared placeholder', async () => {
    writeFileSync(
      h.paths.configPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        commonAuthPool: { schemaVersion: 1, rows: {} },
      }),
    )
    writeFileSync(h.paths.statePath, '{"version":1,"accounts":{}}')
    await h.setSlot(POOL_PLACEHOLDER)
    const before = await h.bytes()
    const { lifecycle } = create()
    lifecycle.start()
    await lifecycle.idle()
    expect(lifecycle.migrated()).toBe(false)
    expect(await h.bytes()).toEqual(before)
  })

  for (const [what, blocker] of [
    ['an older-version heartbeat', () => writeOlderHeartbeat()],
    ['a heartbeat-less RPC port file', () => writeHeartbeatlessPortFile()],
  ] as const) {
    it(`${what} keeps it deferred, logged once; once gone, the timer completes it without a request`, async () => {
      await seedLegacyInstall(h)
      blocker()
      const { lifecycle, timers, sink } = create()
      lifecycle.start()
      await lifecycle.idle()
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(timers.delays()).toHaveLength(1)
        timers.fire()
        await lifecycle.idle()
      }
      expect((await h.slotValue())?.refresh).toBe('r-main')
      expect((await h.config())[POOL_MIGRATION_KEY]).toBeUndefined()
      expect(lifecycle.migrated()).toBe(false)
      const logged = deferrals(sink)
      expect(logged).toHaveLength(1)
      expect(logged[0]?.data?.blockers).toMatchObject([
        {
          pid: OLDER_PID,
          version: what.includes('heartbeat-less') ? 'unknown' : '0.11.0',
        },
      ])

      alive.delete(OLDER_PID)
      timers.fire()
      await lifecycle.idle()
      expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
      expect(lifecycle.migrated()).toBe(true)
      expect((await h.config())[POOL_MIGRATION_KEY].migratedAt).toBeNumber()
    })
  }

  it('retries back off from one minute to fifteen, jittered down by up to a fifth', async () => {
    await seedLegacyInstall(h)
    writeOlderHeartbeat()
    const seen: number[] = []
    const { lifecycle, timers } = create()
    lifecycle.start()
    await lifecycle.idle()
    for (let attempt = 0; attempt < 6; attempt++) {
      seen.push(...timers.delays())
      timers.fire()
      await lifecycle.idle()
    }
    expect(seen).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000])

    const jittered = create({ random: () => 1 })
    jittered.lifecycle.start()
    await jittered.lifecycle.idle()
    expect(jittered.timers.delays()).toEqual([48_000])
    jittered.lifecycle.dispose()
  })

  it('dispose stops the retry timer', async () => {
    await seedLegacyInstall(h)
    writeOlderHeartbeat()
    let runs = 0
    const { lifecycle, timers } = create({
      migrate: async (deps) => {
        runs++
        return migrateToPool(deps)
      },
    })
    lifecycle.start()
    await lifecycle.idle()
    expect(timers.delays()).toHaveLength(1)
    lifecycle.dispose()
    expect(timers.delays()).toEqual([])
    alive.delete(OLDER_PID)
    timers.fire()
    await lifecycle.idle()
    expect(runs).toBe(1)
    expect((await h.slotValue())?.refresh).toBe('r-main')
  })

  it('a migration that throws is logged and retried, never thrown', async () => {
    await seedLegacyInstall(h)
    let calls = 0
    const { lifecycle, timers, sink } = create({
      migrate: async (deps) => {
        calls++
        if (calls === 1) throw new Error('disk on fire')
        return migrateToPool(deps)
      },
    })
    expect(() => lifecycle.start()).not.toThrow()
    await lifecycle.idle()
    expect(sink.warn.map((entry) => entry.data?.error)).toContain(
      'disk on fire',
    )
    expect(timers.delays()).toEqual([60_000])
    timers.fire()
    await lifecycle.idle()
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })
})

describe('adopting later logins', () => {
  async function migratedLifecycle(extra: Partial<PoolLifecycleDeps> = {}) {
    await seedLegacyInstall(h)
    const created = create(extra)
    created.lifecycle.start()
    await created.lifecycle.idle()
    expect(created.lifecycle.migrated()).toBe(true)
    return created
  }

  it('a new login of the main account goes to row main, and the placeholder is back', async () => {
    const { lifecycle } = await migratedLifecycle()
    await h.setSlot(login('acct-main', 'r-main-2', 'relogin'))
    await lifecycle.requestAdoption()
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-2',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('a login of another account becomes a new row', async () => {
    const { lifecycle } = await migratedLifecycle()
    await h.setSlot(login('acct-new', 'r-new'))
    await lifecycle.requestAdoption()
    expect((await h.row('acct-new'))?.credential).toMatchObject({
      refresh: 'r-new',
    })
    expect(await poolTokens(h)).toEqual(['r-fb1', 'r-main', 'r-new'])
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('an older version started after the migration holds adoption back until it exits', async () => {
    const { lifecycle, timers } = await migratedLifecycle()
    writeOlderHeartbeat()
    await h.setSlot(login('acct-new', 'r-new'))
    await lifecycle.requestAdoption()
    expect(await h.row('acct-new')).toBeUndefined()
    expect(isPoolPlaceholder(await h.slotValue())).toBe(false)
    expect(timers.delays().length).toBeGreaterThan(0)

    alive.delete(OLDER_PID)
    timers.fire()
    await lifecycle.idle()
    expect((await h.row('acct-new'))?.credential).toMatchObject({
      refresh: 'r-new',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('two triggers at once run one adoption', async () => {
    let adoptions = 0
    const { lifecycle } = await migratedLifecycle({
      adopt: async (deps) => {
        adoptions++
        return adoptHostSlotLogin(deps)
      },
    })
    adoptions = 0
    await h.setSlot(login('acct-new', 'r-new'))
    await Promise.all([
      lifecycle.requestAdoption(),
      lifecycle.requestAdoption(),
    ])
    expect(adoptions).toBe(1)
    expect((await h.row('acct-new'))?.credential).toMatchObject({
      refresh: 'r-new',
    })
  })

  it('the request-path notice adopts once per token, and only on a migrated install', async () => {
    let adoptions = 0
    const counting: Partial<PoolLifecycleDeps> = {
      adopt: async (deps) => {
        adoptions++
        return adoptHostSlotLogin(deps)
      },
    }
    await seedLegacyInstall(h)
    writeOlderHeartbeat()
    const pending = create(counting)
    pending.lifecycle.start()
    await pending.lifecycle.idle()
    pending.lifecycle.noticeRealSlot('r-main')
    await pending.lifecycle.idle()
    expect(adoptions).toBe(0)
    pending.lifecycle.dispose()

    alive.delete(OLDER_PID)
    const { lifecycle } = create(counting)
    lifecycle.start()
    await lifecycle.idle()
    adoptions = 0
    await h.setSlot(login('acct-new', 'r-new'))
    lifecycle.noticeRealSlot('r-new')
    lifecycle.noticeRealSlot('r-new')
    await lifecycle.idle()
    lifecycle.noticeRealSlot('r-new')
    await lifecycle.idle()
    expect(adoptions).toBe(1)
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })

  it('the timer adopts a credential the host wrote with no request', async () => {
    const { lifecycle, timers } = await migratedLifecycle()
    await h.setSlot(login('acct-main', 'r-main-host', 'host'))
    expect(timers.delays()).toEqual([POOL_RETRY_MAX_MS])
    timers.fire()
    await lifecycle.idle()
    expect((await h.row('main'))?.credential).toMatchObject({
      refresh: 'r-main-host',
    })
    expect(isPoolPlaceholder(await h.slotValue())).toBe(true)
  })
})
