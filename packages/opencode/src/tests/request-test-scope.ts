import { it as bunIt } from 'bun:test'

type Body = () => unknown | Promise<unknown>

/** Bun's timeout ends the test, not its async callback or a raced request. */
export function createRequestTestScope() {
  const pending = new Map<Promise<unknown>, string>()
  let owner = 'unowned request'

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
    return track(Promise.resolve().then(body), name)
  }

  function it(name: string, body: Body, timeout?: number) {
    return bunIt(name, () => run(name, body), timeout)
  }

  function wrap<T extends unknown[], R>(fn: (...args: T) => Promise<R>) {
    return (...args: T) => track(fn(...args))
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
    await cleanup()
    if (names.length) {
      throw new Error(`Request work outlived test: ${names.join(', ')}`)
    }
  }

  return { it, run, wrap, teardown }
}
