import { it as bunIt, spyOn } from 'bun:test'
import { BackgroundQuotaRefresh } from '../core/background-quota-refresh'
import { PoolAccountSource } from '../core/pool-account-source'
import { __bootQuotaSeedPromiseForTest } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'

type Body = () => unknown | Promise<unknown>

/** Bun's timeout ends the test, not its async callback or a raced request. */
export function createRequestTestScope() {
  const pending = new Map<Promise<unknown>, string>()
  const requests = new Set<Promise<unknown>>()
  let owner = 'unowned request'
  const sources = new Set<PoolAccountSource>()
  const backgroundRuns = new Set<Promise<void>>()
  const restores: Array<() => void> = []

  // PoolAccountSource.load and BackgroundQuotaRefresh.start are shared across
  // suites. Install their spies only while this fixture owns them, rather than
  // replacing another suite's spies at import time. Loading stays non-blocking.
  function capturePluginWork() {
    const load = PoolAccountSource.prototype.load
    const loadSpy = spyOn(
      PoolAccountSource.prototype,
      'load',
    ).mockImplementation(function (this: PoolAccountSource) {
      sources.add(this)
      return load.call(this)
    })
    const start = BackgroundQuotaRefresh.prototype.start
    const startSpy = spyOn(
      BackgroundQuotaRefresh.prototype,
      'start',
    ).mockImplementation(function (this: BackgroundQuotaRefresh, run, onError) {
      start.call(
        this,
        wrap(async () => {
          const promise = run()
          backgroundRuns.add(promise)
          try {
            await promise
          } finally {
            backgroundRuns.delete(promise)
          }
        }),
        onError,
      )
    })
    restores.push(
      () => loadSpy.mockRestore(),
      () => startSpy.mockRestore(),
    )
  }

  async function settlePluginWork() {
    // Test bodies may restore mocked fetch in finally, before afterEach runs.
    // Wait for requests made through wrap too, without waiting for the body.
    while (requests.size) await Promise.allSettled([...requests])
    if (!restores.length) return
    await __bootQuotaSeedPromiseForTest()
    // The stores track quota requests only after they are submitted. A source
    // waiting for the vault to discover its accounts has not submitted them yet
    // and exposes no public drain for that wait. Dispose the plugin before
    // swapping paths or fetch: the delayed callback then sees a disposed source
    // and exits without submitting a quota request.
    for (const source of sources) await source.poolStore().pullsSettled()
    await Promise.all([...backgroundRuns])
    // A background refresh may have discovered another row while draining.
    for (const source of sources) await source.poolStore().pullsSettled()
    await drainSidebarWrites()
  }

  function track<T>(promise: Promise<T>, name = owner): Promise<T> {
    pending.set(promise, name)
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    )
    return promise
  }

  function run(name: string, body: Body) {
    owner = name
    return track(Promise.resolve().then(body).finally(settlePluginWork), name)
  }

  function it(name: string, body: Body, timeout?: number) {
    return bunIt(name, () => run(name, body), timeout)
  }

  function wrap<T extends unknown[], R>(fn: (...args: T) => Promise<R>) {
    return (...args: T) => {
      const promise = track(fn(...args))
      requests.add(promise)
      void promise.then(
        () => requests.delete(promise),
        () => requests.delete(promise),
      )
      return promise
    }
  }

  async function teardown(
    cleanup: () => Promise<void>,
    onLeak: (names: string[]) => void = () => {},
  ) {
    const names = [...new Set(pending.values())]
    if (names.length) onLeak(names)
    // Keep the fixture installed until the entire callback finishes: draining
    // only its current request lets the callback issue its next send too late.
    while (pending.size) await Promise.allSettled([...pending.keys()])
    await settlePluginWork()
    await cleanup()
    for (const restore of restores.splice(0)) restore()
    sources.clear()
    backgroundRuns.clear()
    requests.clear()
    if (names.length) {
      throw new Error(`Request work outlived test: ${names.join(', ')}`)
    }
  }

  const each = ((table: readonly unknown[]) => {
    const register = bunIt.each([...table])
    return (
      name: string,
      body: (...args: unknown[]) => unknown,
      timeout?: number,
    ) =>
      register(
        name,
        (...args: unknown[]) => run(name, () => body(...args)),
        timeout,
      )
  }) as typeof bunIt.each

  return {
    it: Object.assign(it, { each }),
    run,
    wrap,
    teardown,
    capturePluginWork,
    settlePluginWork,
  }
}
