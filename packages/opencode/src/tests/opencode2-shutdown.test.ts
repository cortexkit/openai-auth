import { expect, spyOn, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import * as locks from '@cortexkit/common-auth/fs'
import * as config from '../config'
import { OpenCodeLimitSource } from '../core/limit-source'
import * as poolLifecycle from '../core/pool-lifecycle'
import * as heartbeat from '../core/process-heartbeat'
import * as sharedVault from '../core/shared-vault'
import * as cacheKeep from '../v2/cache-keep'
import * as controlPlane from '../v2/control-plane'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import * as sidebar from '../v2/sidebar-publisher'
import {
  fakeOpenCode2Host,
  poolFiles,
  seedPool,
} from './fixtures/opencode2-host'
import { openCode2PhaseClock } from './fixtures/opencode2-phase-clock'
import { restoreEnv } from './setup-env'

test('OpenCode 2 shutdown stops waiting for a contended host-slot transfer lock', async () => {
  const files = poolFiles()
  seedPool(files, 'main-first', [{ id: 'main' }])
  const slotPath = join(files.dir, 'auth.json')
  const held = await locks.acquireRefreshFileLock({
    name: 'pool-slot-transfer',
    path: slotPath,
    ttlMs: 10_000,
  })
  expect(held).not.toBeNull()
  let attempted!: () => void
  const waiting = new Promise<void>((resolve) => {
    attempted = resolve
  })
  const clock = openCode2PhaseClock((options, result) => {
    if (
      options.name === 'pool-slot-transfer' &&
      options.path === slotPath &&
      !result
    )
      attempted()
  })
  let stop: Awaited<ReturnType<typeof setupOpenAIAuth>>
  let stopping: Promise<unknown> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    stop = await clock.time('setup', () =>
      setupOpenAIAuth(fakeOpenCode2Host().ctx, {
        paths: files.paths,
        heartbeat: false,
        poolMigration: true,
        slot: opencode1HostSlot(slotPath),
        fence: async () => ({ open: true, blockers: [] }),
        sidebarStateFile: join(files.dir, 'sidebar.json'),
        fetch: Object.assign(async () => new Response('{}', { status: 503 }), {
          preconnect() {},
        }),
        vault: {
          stateDir: join(files.dir, 'vault'),
          connectionFile: () => join(files.dir, 'no-vault.json'),
          pollIntervalMs: 0,
        },
      }),
    )
    await waiting
    const started = performance.now()
    stopping = clock.time('stop', async () => {
      await stop?.()
    })
    const stopped = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 300)
      }),
    ])
    if (!stopped) clock.report()
    expect(stopped).toBe(true)
    expect(performance.now() - started).toBeLessThan(300)
  } finally {
    clearTimeout(deadline)
    await held?.release()
    await stopping
    clock.dispose()
    rmSync(files.dir, { recursive: true, force: true })
  }
})

function shutdownFixture(promptFailure?: Error) {
  const files = poolFiles()
  seedPool(files, 'main-first', [])
  const host = fakeOpenCode2Host({ directory: files.dir })
  const ctx: Parameters<typeof setupOpenAIAuth>[0] = host.ctx
  const cleanups: Array<() => unknown> = []
  const called: string[] = []
  function track<T>(step: string, release: () => T): () => T {
    let done = false
    cleanups.push(() => {
      if (!done) return release()
    })
    return () => {
      done = true
      called.push(step)
      return release()
    }
  }

  const settingsEnv = 'OPENCODE_OPENAI_AUTH_SETTINGS_FILE'
  const previous = process.env[settingsEnv]
  process.env[settingsEnv] = join(files.dir, 'settings.jsonc')
  const acquireHeartbeat = heartbeat.startProcessHeartbeat
  const heartbeatSpy = spyOn(
    heartbeat,
    'startProcessHeartbeat',
  ).mockImplementation(async (...args) => {
    const handle = await acquireHeartbeat(...args)
    handle.release = track('heartbeat', handle.release)
    return handle
  })
  const createLifecycle = poolLifecycle.createPoolLifecycle
  const lifecycleSpy = spyOn(
    poolLifecycle,
    'createPoolLifecycle',
  ).mockImplementation((...args) => {
    const handle = createLifecycle(...args)
    handle.dispose = track('migration lifecycle', handle.dispose)
    return handle
  })
  const acquireVault = sharedVault.acquireOpenCodeVault
  const vaultSpy = spyOn(
    sharedVault,
    'acquireOpenCodeVault',
  ).mockImplementation((...args) => {
    const handle = acquireVault(...args)
    handle.release = track('vault lease', handle.release)
    return handle
  })
  const acquireSidebar = sidebar.acquireSidebarPublisher
  const sidebarSpy = spyOn(
    sidebar,
    'acquireSidebarPublisher',
  ).mockImplementation((...args) => {
    const handle = acquireSidebar(...args)
    handle.release = track('sidebar', handle.release)
    return handle
  })
  const acquireKeep = cacheKeep.acquireCacheKeep
  const cacheKeepSpy = spyOn(cacheKeep, 'acquireCacheKeep').mockImplementation(
    (...args) => {
      const handle = acquireKeep(...args)
      handle.release = track('cache keep', handle.release)
      return handle
    },
  )
  const register = config.registerSettingsSnapshot
  const settingsSpy = spyOn(
    config,
    'registerSettingsSnapshot',
  ).mockImplementation((path, snapshot) => {
    snapshot.dispose = track(
      'settings snapshot',
      snapshot.dispose.bind(snapshot),
    )
    return track('settings registration', register(path, snapshot))
  })
  const limits = spyOn(OpenCodeLimitSource.prototype, 'dispose')
  const hook = ctx.session.hook
  const hooks = spyOn(ctx.session, 'hook').mockImplementation(
    async (...args) => {
      if (promptFailure && args[0] === 'prompt') throw promptFailure
      const registration = await hook(...args)
      return {
        ...registration,
        dispose: track(`hook ${args[0]}`, registration.dispose),
      }
    },
  )
  const auth = ctx.integration.transform
  const authMethods = spyOn(ctx.integration, 'transform').mockImplementation(
    async (...args) => {
      const registration = await auth(...args)
      return {
        ...registration,
        dispose: track('auth methods', registration.dispose),
      }
    },
  )
  const models = ctx.model.transform
  const modelRules = spyOn(ctx.model, 'transform').mockImplementation(
    async (...args) => {
      const registration = await models(...args)
      return {
        ...registration,
        dispose: track('model rules', registration.dispose),
      }
    },
  )
  const events = spyOn(ctx.event, 'subscribe')

  return {
    host,
    released: () => called.filter((step) => !step.startsWith('hook ')).sort(),
    limits,
    events,
    start: () =>
      setupOpenAIAuth(ctx, {
        paths: files.paths,
        poolMigration: true,
        slot: opencode1HostSlot(join(files.dir, 'auth.json')),
        fence: async () => ({ open: false, blockers: [] }),
        sidebarStateFile: join(files.dir, 'sidebar.json'),
        vault: {
          stateDir: join(files.dir, 'vault'),
          connectionFile: () => join(files.dir, 'no-vault.json'),
          pollIntervalMs: 0,
        },
      }),
    async dispose() {
      for (const restore of [
        heartbeatSpy,
        lifecycleSpy,
        vaultSpy,
        sidebarSpy,
        cacheKeepSpy,
        settingsSpy,
        limits,
        hooks,
        authMethods,
        modelRules,
        events,
      ])
        restore.mockRestore()
      try {
        for (const cleanup of cleanups.reverse()) await cleanup()
      } finally {
        restoreEnv(settingsEnv, previous)
        rmSync(files.dir, { recursive: true, force: true })
      }
    },
  }
}

const rollbackSteps = [
  'cache keep',
  'heartbeat',
  'migration lifecycle',
  'settings registration',
  'settings snapshot',
  'sidebar',
  'vault lease',
]

test('OpenCode 2 releases acquired resources when the prompt hook rejects', async () => {
  const error = new Error('prompt hook rejected')
  const fixture = shutdownFixture(error)
  try {
    const rejection = await fixture.start().catch((reason: unknown) => reason)
    expect(rejection).toBe(error)
    expect(fixture.host.hooks.length).toBeGreaterThan(0)
    expect({
      liveHooks: fixture.host.hooks
        .filter(({ disposed }) => !disposed)
        .map(({ name }) => name),
      released: fixture.released(),
    }).toEqual({ liveHooks: [], released: rollbackSteps })
    expect(fixture.limits).toHaveBeenCalledTimes(1)
  } finally {
    await fixture.dispose()
  }
})

for (const failure of ['rejects', 'never settles'] as const) {
  test(`OpenCode 2 finishes teardown when control-plane cleanup ${failure}`, async () => {
    const fixture = shutdownFixture()
    const blocked = Promise.withResolvers<void>()
    let controlStarted = false
    const controlCleanup = spyOn(
      controlPlane,
      'installControlPlane',
    ).mockResolvedValue(async () => {
      controlStarted = true
      if (failure === 'rejects') throw new Error('control-plane cleanup failed')
      await blocked.promise
    })
    const realTimer = globalThis.setTimeout
    let accelerated = false
    let restoreTimer: (() => void) | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let stopping: Promise<string> | undefined
    try {
      const stop = await fixture.start()
      expect(fixture.host.hooks.some(({ name }) => name === 'prompt')).toBe(
        true,
      )
      const signals = fixture.events.mock.calls.map(
        ([options]) => options?.signal,
      )
      expect(signals).toEqual([
        expect.any(AbortSignal),
        expect.any(AbortSignal),
      ])
      expect(signals.every((signal) => signal?.aborted === false)).toBe(true)
      if (failure === 'never settles') {
        // Advance the control plane's deadline without rushing other releases.
        const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: () => void,
          delay?: number,
          ...args: unknown[]
        ) => {
          if (controlStarted && !accelerated && delay === 5_000) {
            accelerated = true
            return realTimer(callback, 1, ...args)
          }
          return realTimer(callback, delay, ...args)
        }) as typeof setTimeout)
        restoreTimer = () => clock.mockRestore()
      }
      stopping = Promise.resolve(stop?.()).then(
        () => 'finished',
        () => 'rejected',
      )
      const outcome = await Promise.race([
        stopping,
        new Promise<string>((resolve) => {
          watchdog = realTimer(() => resolve('still pending'), 1_000)
        }),
      ])
      expect({
        controlStarted,
        outcome,
        liveHooks: fixture.host.hooks
          .filter(({ disposed }) => !disposed)
          .map(({ name }) => name),
        released: fixture.released(),
        limits: fixture.limits.mock.calls.length,
        eventsAborted: signals.every((signal) => signal?.aborted),
      }).toEqual({
        controlStarted: true,
        outcome: 'finished',
        liveHooks: [],
        released: [...rollbackSteps, 'auth methods', 'model rules'].sort(),
        limits: 1,
        eventsAborted: true,
      })
      if (failure === 'never settles') expect(accelerated).toBe(true)
    } finally {
      clearTimeout(watchdog)
      restoreTimer?.()
      blocked.resolve()
      await stopping
      controlCleanup.mockRestore()
      await fixture.dispose()
    }
  })
}
