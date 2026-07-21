import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireBackgroundRefreshLock,
  BACKGROUND_QUOTA_FRESHNESS_MS,
  BACKGROUND_QUOTA_REFRESH_INTERVAL_MS,
  BACKGROUND_QUOTA_REFRESH_JITTER_MS,
  BACKGROUND_QUOTA_REFRESH_LOCK_NAME,
  BACKGROUND_QUOTA_REFRESH_LOCK_TTL_MS,
  BackgroundQuotaRefresh,
  refreshQuotaInBackground,
} from '../core/background-quota-refresh'
import type {
  RefreshAllQuotaDeps,
  RefreshAllQuotaResult,
} from '../core/refresh-all-quota'
import { acquireRefreshFileLock } from '../core/refresh-file-lock'

function timerHarness() {
  let callback: (() => void) | undefined
  let active = false
  const handle = {
    unref: mock(() => {}),
  } as unknown as ReturnType<typeof setInterval>
  const setIntervalFn = mock((next: () => void, _intervalMs: number) => {
    callback = next
    active = true
    return handle
  })
  const clearIntervalFn = mock((timer: ReturnType<typeof setInterval>) => {
    expect(timer).toBe(handle)
    active = false
  })

  return {
    setIntervalFn,
    clearIntervalFn,
    handle,
    tick: () => {
      if (active) callback?.()
    },
  }
}

async function drainMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BackgroundQuotaRefresh', () => {
  test('background ticks force backoff respect and the freshness gate', async () => {
    const deps = {} as RefreshAllQuotaDeps
    const refreshFn = mock(async () => [])

    await refreshQuotaInBackground(deps, refreshFn, async () => ({
      release: async () => {},
    }))

    expect(refreshFn).toHaveBeenCalledWith({
      respectBackoff: true,
      skipFresherThanMs: BACKGROUND_QUOTA_FRESHNESS_MS,
    })
  })

  test('concurrent background ticks claim a lock so only one refreshes', async () => {
    const deps = { configPath: '/tmp/test-config.json' } as RefreshAllQuotaDeps
    let held = false
    const release = mock(async () => {
      held = false
    })
    const acquireLock = mock(async () => {
      if (held) return null
      held = true
      return { release }
    })
    let resolveRefresh!: () => void
    const refreshFn = mock(
      () =>
        new Promise<RefreshAllQuotaResult[]>((resolve) => {
          resolveRefresh = () => resolve([])
        }),
    )

    const first = refreshQuotaInBackground(deps, refreshFn, acquireLock)
    const second = refreshQuotaInBackground(deps, refreshFn, acquireLock)
    await drainMicrotasks()

    // The first tick holds the lock and refreshes; the second skips this tick.
    expect(refreshFn).toHaveBeenCalledTimes(1)

    resolveRefresh()
    const [firstResults, secondResults] = await Promise.all([first, second])

    expect(firstResults).toEqual([])
    expect(secondResults).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('a lock-mechanism failure fails open and still refreshes', async () => {
    const deps = { configPath: '/tmp/test-config.json' } as RefreshAllQuotaDeps
    const acquireLock = mock(async () => {
      throw new Error('lock filesystem unavailable')
    })
    const refreshFn = mock(async () => [])

    await refreshQuotaInBackground(deps, refreshFn, acquireLock)

    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  test('two concurrent ticks against a real lock file refresh only once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oai-bg-lock-'))
    const configPath = join(dir, 'config.json')
    try {
      const deps = { configPath } as RefreshAllQuotaDeps
      let resolveRefresh!: () => void
      const refreshFn = mock(
        () =>
          new Promise<RefreshAllQuotaResult[]>((resolve) => {
            resolveRefresh = () => resolve([])
          }),
      )

      const first = refreshQuotaInBackground(deps, refreshFn)
      const second = refreshQuotaInBackground(deps, refreshFn)
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(refreshFn).toHaveBeenCalledTimes(1)

      resolveRefresh()
      await Promise.all([first, second])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('timer runs the registered quota refresh with the fixed cadence', async () => {
    const timer = timerHarness()
    const run = mock(async () => {})
    const poller = new BackgroundQuotaRefresh({
      ...timer,
      random: () => 0.5,
    })

    poller.start(run)
    timer.tick()
    await drainMicrotasks()

    expect(timer.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      BACKGROUND_QUOTA_REFRESH_INTERVAL_MS,
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(
      (timer.handle as unknown as { unref: ReturnType<typeof mock> }).unref,
    ).toHaveBeenCalledTimes(1)
  })

  test('jitter shifts the cadence within the +/- bound', () => {
    const low = timerHarness()
    new BackgroundQuotaRefresh({ ...low, random: () => 0 }).start(
      mock(async () => {}),
    )
    expect(low.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      BACKGROUND_QUOTA_REFRESH_INTERVAL_MS - BACKGROUND_QUOTA_REFRESH_JITTER_MS,
    )

    const high = timerHarness()
    new BackgroundQuotaRefresh({ ...high, random: () => 1 }).start(
      mock(async () => {}),
    )
    expect(high.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      BACKGROUND_QUOTA_REFRESH_INTERVAL_MS + BACKGROUND_QUOTA_REFRESH_JITTER_MS,
    )
  })

  test('double start keeps one timer and uses the latest loader callback', async () => {
    const timer = timerHarness()
    const firstRun = mock(async () => {})
    const secondRun = mock(async () => {})
    const poller = new BackgroundQuotaRefresh({
      ...timer,
      random: () => 0.5,
    })

    poller.start(firstRun)
    poller.start(secondRun)
    timer.tick()
    await drainMicrotasks()

    expect(timer.setIntervalFn).toHaveBeenCalledTimes(1)
    expect(firstRun).not.toHaveBeenCalled()
    expect(secondRun).toHaveBeenCalledTimes(1)
  })

  test('stop clears the timer and prevents later ticks', async () => {
    const timer = timerHarness()
    const run = mock(async () => {})
    const poller = new BackgroundQuotaRefresh({
      ...timer,
      random: () => 0.5,
    })

    poller.start(run)
    poller.stop()
    timer.tick()
    await drainMicrotasks()

    expect(timer.clearIntervalFn).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })

  test('a failed poll is contained and the next tick still runs', async () => {
    const timer = timerHarness()
    const onError = mock(() => {})
    let attempts = 0
    const run = mock(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('wham unavailable')
    })
    const poller = new BackgroundQuotaRefresh({
      ...timer,
      random: () => 0.5,
      onError,
    })

    poller.start(run)
    timer.tick()
    await drainMicrotasks()
    timer.tick()
    await drainMicrotasks()

    expect(run).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  test('a tick is skipped while the previous refresh is still in flight', async () => {
    const timer = timerHarness()
    const resolvers: Array<() => void> = []
    const run = mock(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const poller = new BackgroundQuotaRefresh({
      ...timer,
      random: () => 0.5,
    })

    poller.start(run)
    timer.tick()
    timer.tick()
    expect(run).toHaveBeenCalledTimes(1)

    resolvers[0]?.()
    await drainMicrotasks()
    timer.tick()
    expect(run).toHaveBeenCalledTimes(2)
    resolvers[1]?.()
    await drainMicrotasks()
  })

  test('stop during an in-flight run lets it finish but fires no further ticks', async () => {
    const timer = timerHarness()
    let resolveRun!: () => void
    let completed = false
    const run = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = () => {
            completed = true
            resolve()
          }
        }),
    )
    const poller = new BackgroundQuotaRefresh({ ...timer, random: () => 0.5 })

    poller.start(run)
    expect(poller.isStopped()).toBe(false)
    timer.tick()
    expect(run).toHaveBeenCalledTimes(1)

    poller.stop()
    expect(poller.isStopped()).toBe(true)
    // The in-flight run is not cancelled...
    expect(completed).toBe(false)
    // ...and no further tick starts a new run.
    timer.tick()
    expect(run).toHaveBeenCalledTimes(1)

    resolveRun()
    await drainMicrotasks()
    expect(completed).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('the stopped flag blocks a stray tick even if the timer fires once more', async () => {
    let callback: (() => void) | undefined
    const handle = {
      unref: () => {},
    } as unknown as ReturnType<typeof setInterval>
    const setIntervalFn = mock((next: () => void) => {
      callback = next
      return handle
    })
    const clearIntervalFn = mock(() => {})
    const run = mock(async () => {})
    const poller = new BackgroundQuotaRefresh({
      setIntervalFn,
      clearIntervalFn,
      random: () => 0.5,
    })

    poller.start(run)
    poller.stop()
    callback?.()
    await drainMicrotasks()

    expect(run).not.toHaveBeenCalled()
    expect(clearIntervalFn).toHaveBeenCalledTimes(1)
  })

  test('the lock TTL outlasts a slow multi-account refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oai-bg-ttl-'))
    const configPath = join(dir, 'config.json')
    try {
      let nowMs = 1_000_000
      const opts = {
        name: BACKGROUND_QUOTA_REFRESH_LOCK_NAME,
        ttlMs: BACKGROUND_QUOTA_REFRESH_LOCK_TTL_MS,
        path: configPath,
        now: () => nowMs,
      }

      // The first acquirer holds the lock for the whole (slow) refresh.
      const holder = await acquireRefreshFileLock(opts)
      expect(holder).not.toBeNull()

      // A serial pass over many accounts can run 35s; a contender arriving then
      // must still be locked out rather than start a concurrent refresh.
      nowMs += 35_000
      const contender = await acquireRefreshFileLock(opts)
      expect(contender).toBeNull()

      // Discriminator: the null above means "held", not a broken acquirer — once
      // the holder releases, acquisition succeeds again.
      await holder?.release()
      const afterRelease = await acquireRefreshFileLock(opts)
      expect(afterRelease).not.toBeNull()
      await afterRelease?.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('lock renewal keeps the background lock held across a refresh that outlasts the TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oai-bg-renew-'))
    const configPath = join(dir, 'config.json')
    try {
      let nowMs = 1_000_000
      // A small real-time renewal interval so ticks fire quickly while the mock
      // clock simulates a refresh longer than the TTL.
      const lockOpts = { now: () => nowMs, renewIntervalMs: 5 }

      const holder = await acquireBackgroundRefreshLock(configPath, lockOpts)
      expect(holder).not.toBeNull()

      // Simulate a 125s refresh (past the 120s TTL) in steps smaller than the
      // TTL, letting a real renewal tick fire between steps so the lock never
      // appears expired to the renewal guard. Each renewal re-arms the TTL.
      for (let elapsed = 0; elapsed < 125_000; elapsed += 25_000) {
        nowMs += 25_000
        await new Promise((resolve) => setTimeout(resolve, 30))
      }

      // At simulated 125s — 5s past the TTL — a contender must still be locked
      // out, because renewal kept the lock alive for the whole run.
      const contender = await acquireBackgroundRefreshLock(configPath, lockOpts)
      expect(contender).toBeNull()

      await holder?.release()

      // Discriminator: without renewal the same elapsed time expires the lock at
      // the TTL, so a contender acquires it (a concurrent refresh would start).
      let bareNowMs = 2_000_000
      const bareAcquire = () =>
        acquireRefreshFileLock({
          name: BACKGROUND_QUOTA_REFRESH_LOCK_NAME,
          ttlMs: BACKGROUND_QUOTA_REFRESH_LOCK_TTL_MS,
          path: configPath,
          now: () => bareNowMs,
        })
      const bareHolder = await bareAcquire()
      expect(bareHolder).not.toBeNull()
      bareNowMs += 125_000
      const bareContender = await bareAcquire()
      expect(bareContender).not.toBeNull()
      await bareContender?.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('separate poller instances run and dispose independently', async () => {
    const timer1 = timerHarness()
    const timer2 = timerHarness()
    const run1 = mock(async () => {})
    const run2 = mock(async () => {})
    const loader1 = new BackgroundQuotaRefresh({ ...timer1, random: () => 0.5 })
    const loader2 = new BackgroundQuotaRefresh({ ...timer2, random: () => 0.5 })

    // Two loaders start → two independent timers.
    loader1.start(run1)
    loader2.start(run2)
    expect(timer1.setIntervalFn).toHaveBeenCalledTimes(1)
    expect(timer2.setIntervalFn).toHaveBeenCalledTimes(1)

    // Dispose loader 1 → loader 2's timer still fires.
    loader1.stop()
    timer1.tick()
    timer2.tick()
    await drainMicrotasks()
    expect(run1).not.toHaveBeenCalled()
    expect(run2).toHaveBeenCalledTimes(1)

    // Dispose loader 2 → no further tick fires.
    loader2.stop()
    timer2.tick()
    await drainMicrotasks()
    expect(run2).toHaveBeenCalledTimes(1)
  })
})
