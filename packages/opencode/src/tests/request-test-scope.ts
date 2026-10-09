import { it as bunIt, spyOn } from 'bun:test'
import { OpenAiVault } from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
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
  const plugins = new Set<Hooks>()
  const sources = new Set<PoolAccountSource>()
  const backgroundRuns = new Set<Promise<void>>()
  const restores: Array<() => void> = []

  // Source reads, vault quota passes and background refreshes can outlive the
  // loader. Install their spies only while this fixture owns them, rather than
  // replacing another suite's spies at import time. Loading stays non-blocking.
  function capturePluginWork(options: { vaultPolls?: boolean } = {}) {
    const load = PoolAccountSource.prototype.load
    const loadSpy = spyOn(
      PoolAccountSource.prototype,
      'load',
    ).mockImplementation(function (this: PoolAccountSource) {
      sources.add(this)
      return ownWork(load.call(this))
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
    // Opt in so suites with their own vault-polling spy are not affected.
    if (options.vaultPolls) {
      // pollIntervalMs: 0 stops roster ticks, not the lease's first quota pass.
      const pollStale = OpenAiVault.prototype.pollStale
      const vaultPollSpy = spyOn(
        OpenAiVault.prototype,
        'pollStale',
      ).mockImplementation(function (this: OpenAiVault, maxAgeMs) {
        return ownWork(pollStale.call(this, maxAgeMs))
      })
      restores.push(() => vaultPollSpy.mockRestore())
    }
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

  // Background work is allowed to be active at teardown. Drain it, but only
  // report outliving test bodies or explicit requests as timeout leaks.
  function ownWork<T>(promise: Promise<T>): Promise<T> {
    requests.add(promise)
    void promise.then(
      () => requests.delete(promise),
      () => requests.delete(promise),
    )
    return promise
  }

  function wrap<T extends unknown[], R>(fn: (...args: T) => Promise<R>) {
    return (...args: T) => ownWork(track(fn(...args)))
  }

  /** Keep the plugin's timers inside the fixture that created them. */
  function ownPlugin<T extends Hooks>(hooks: T): T {
    plugins.add(hooks)
    return hooks
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
    for (const plugin of plugins) await plugin.dispose?.()
    plugins.clear()
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
    ownPlugin,
    capturePluginWork,
    settlePluginWork,
  }
}
