import { spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import type * as files from '@cortexkit/common-auth/fs'
import { PoolAccountSource } from '../../core/pool-account-source'
import * as lifecycle from '../../core/pool-lifecycle'
import * as vault from '../../core/shared-vault'
import * as cacheKeep from '../../v2/cache-keep'
import * as sessions from '../../v2/codex-sessions'
import * as controlPlane from '../../v2/control-plane'
import * as sidebar from '../../v2/sidebar-publisher'

const lockModule = (await import(
  new URL(
    'refresh-file-lock.js',
    import.meta.resolve('@cortexkit/common-auth/fs'),
  ).href
)) as Pick<typeof files, 'acquireRefreshFileLock'>

/** Record setup/shutdown work without writing anything on a passing fixture. */
export function openCode2PhaseClock(
  onLock?: (
    options: Parameters<typeof files.acquireRefreshFileLock>[0],
    result: Awaited<ReturnType<typeof files.acquireRefreshFileLock>>,
  ) => void,
) {
  const phases: Array<{ name: string; start: number; end?: number }> = []
  const restores: Array<() => void> = []
  const measured = new WeakMap<object, Set<PropertyKey>>()
  let failed = false
  function report() {
    const grouped = new Map<
      string,
      { count: number; duration: number; pending: number }
    >()
    for (const { name, start, end } of phases) {
      const item = grouped.get(name) ?? { count: 0, duration: 0, pending: 0 }
      item.count++
      item.duration += (end ?? performance.now()) - start
      if (end === undefined) item.pending++
      grouped.set(name, item)
    }
    console.error(
      '[OpenCode 2 dump fixture phases]\n' +
        [...grouped]
          .map(
            ([name, item]) =>
              `${name}: ${item.duration.toFixed(1)}ms (${item.count} calls, ${item.pending} pending)`,
          )
          .join('\n') +
        '\n' +
        JSON.stringify(lockDetails),
    )
  }
  function time<T>(name: string, action: () => T): T {
    const phase = {
      name,
      start: performance.now(),
      end: undefined as number | undefined,
    }
    phases.push(phase)
    const finish = () => {
      phase.end = performance.now()
    }
    try {
      const result = action()
      if (result instanceof Promise)
        void result.then(finish, () => {
          failed = true
          finish()
        })
      else finish()
      return result
    } catch (error) {
      failed = true
      finish()
      throw error
    }
  }
  function method<T extends object, K extends keyof T>(
    object: T,
    key: K,
    name: string,
  ) {
    const keys = measured.get(object) ?? new Set<PropertyKey>()
    if (keys.has(key)) return
    keys.add(key)
    measured.set(object, keys)
    const original = object[key] as (...args: unknown[]) => unknown
    const spy = spyOn(object, key as never).mockImplementation(function (
      this: T,
      ...args: unknown[]
    ) {
      return time(name, () => original.apply(this, args))
    } as never)
    restores.push(() => spy.mockRestore())
  }
  method(PoolAccountSource.prototype, 'load', 'source.load')
  method(PoolAccountSource.prototype, 'settled', 'source.settled')
  const acquireLock = lockModule.acquireRefreshFileLock
  const lockDetails: Record<string, unknown> = {}
  const lockSpy = spyOn(
    lockModule,
    'acquireRefreshFileLock',
  ).mockImplementation((options) => {
    const stack =
      !lockDetails[options.path] && options.name === 'pool-slot-transfer'
        ? new Error().stack
        : undefined
    return time(`lock ${options.name} ${options.path}`, async () => {
      const result = await acquireLock(options)
      onLock?.(options, result)
      if (
        !result &&
        options.name === 'pool-slot-transfer' &&
        !lockDetails[options.path]
      ) {
        let holder: unknown
        try {
          holder = JSON.parse(
            readFileSync(`${options.path}.${options.name}.lock`, 'utf8'),
          )
        } catch {}
        lockDetails[options.path] = { holder, stack }
      }
      return result
    })
  })
  restores.push(() => lockSpy.mockRestore())
  const createLifecycle = lifecycle.createPoolLifecycle
  const lifecycleSpy = spyOn(
    lifecycle,
    'createPoolLifecycle',
  ).mockImplementation((...args) => {
    const result = createLifecycle(...args)
    method(result, 'idle', 'lifecycle.idle')
    return result
  })
  const acquireVault = vault.acquireOpenCodeVault
  const vaultSpy = spyOn(vault, 'acquireOpenCodeVault').mockImplementation(
    (...args) => {
      const result = acquireVault(...args)
      method(result.vault, 'authority', 'vault.authority')
      method(result, 'release', 'vault.release')
      return result
    },
  )
  const acquireKeep = cacheKeep.acquireCacheKeep
  const keepSpy = spyOn(cacheKeep, 'acquireCacheKeep').mockImplementation(
    (...args) => {
      const result = acquireKeep(...args)
      method(result, 'release', 'cacheKeepReleased')
      return result
    },
  )
  const acquireSessions = sessions.acquireCodexSessions
  const sessionsSpy = spyOn(
    sessions,
    'acquireCodexSessions',
  ).mockImplementation((...args) => {
    const result = acquireSessions(...args)
    method(result, 'settled', 'codex.store.settled')
    return result
  })
  const acquireSidebar = sidebar.acquireSidebarPublisher
  const sidebarSpy = spyOn(
    sidebar,
    'acquireSidebarPublisher',
  ).mockImplementation((...args) => {
    const result = acquireSidebar(...args)
    method(result, 'release', 'sidebar.release')
    return result
  })
  const installControl = controlPlane.installControlPlane
  const controlSpy = spyOn(
    controlPlane,
    'installControlPlane',
  ).mockImplementation(async (...args) => {
    const result = await installControl(...args)
    return () => time('controlPlane', result)
  })
  restores.push(
    () => lifecycleSpy.mockRestore(),
    () => vaultSpy.mockRestore(),
    () => keepSpy.mockRestore(),
    () => sessionsSpy.mockRestore(),
    () => sidebarSpy.mockRestore(),
    () => controlSpy.mockRestore(),
  )
  const watchdog = setTimeout(() => {
    failed = true
    report()
  }, 5_000)
  watchdog.unref()
  return {
    time,
    report,
    dispose() {
      clearTimeout(watchdog)
      for (const restore of restores.reverse()) restore()
      if (failed) report()
    },
  }
}
