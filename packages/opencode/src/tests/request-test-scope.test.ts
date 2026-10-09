import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as poolStores from '@cortexkit/common-auth/store'
import type { Hooks } from '@opencode-ai/plugin'
import { BackgroundQuotaRefresh } from '../core/background-quota-refresh'
import {
  installWire,
  loadPlugin,
  quotaMap,
  seedPool,
} from './fixtures/pool-install'
import { createRequestTestScope } from './request-test-scope'
import { restoreEnv } from './setup-env'

let dir: string
let originalFetch: typeof globalThis.fetch
let hooks: Hooks | undefined
let scope: ReturnType<typeof createRequestTestScope>
let release: () => void
const restores: Array<() => void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-request-scope-'))
  process.env.OPENCODE_OPENAI_AUTH_FILE = join(dir, 'openai-auth.json')
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
    dir,
    'openai-auth-state.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    dir,
    'sidebar.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(dir, 'test.log')
  process.env.OPENCODE_CONFIG_DIR = dir
  originalFetch = globalThis.fetch
  hooks = undefined
  release = () => {}
  scope = createRequestTestScope()
  scope.capturePluginWork()
})

afterEach(async () => {
  release()
  await scope.teardown(async () => {
    await hooks?.dispose?.()
    for (const restore of restores.splice(0)) restore()
    globalThis.fetch = originalFetch
    for (const name of [
      'OPENCODE_OPENAI_AUTH_FILE',
      'OPENCODE_OPENAI_AUTH_STATE_FILE',
      'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE',
      'OPENCODE_OPENAI_AUTH_LOG_FILE',
      'OPENCODE_CONFIG_DIR',
    ])
      restoreEnv(name)
    rmSync(dir, { recursive: true, force: true })
  })
})

it('drains a prior loader first-sight pull before the next wire, naming its owner', async () => {
  seedPool(
    {
      configFile: join(dir, 'openai-auth.json'),
      stateFile: join(dir, 'openai-auth-state.json'),
    },
    [{ id: 'prior', quota: quotaMap(10) }],
  )
  const priorWire = installWire({
    usage: () => new Response('', { status: 503 }),
  })
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  release = () => gate.resolve()
  const open = poolStores.openPoolStore
  const stores = new Set<ReturnType<typeof open>>()
  const storeSpy = spyOn(poolStores, 'openPoolStore').mockImplementation(
    (options) => {
      const store = open({
        ...options,
        hold: async (step) => {
          if (step === 'pull-before-request') {
            entered.resolve()
            await gate.promise
          }
        },
      })
      stores.add(store)
      return store
    },
  )
  restores.push(() => storeSpy.mockRestore())
  const owner = 'prior loader with first-sight pool work'
  const body = scope.run(owner, async () => {
    hooks = await loadPlugin({ poolMigration: { enabled: false } })
  })
  await entered.promise
  // Let loadPlugin return from the scope.run callback. The request scope must
  // still own its startup quota pull, parked before selecting global fetch,
  // rather than considering the owner finished as soon as loading returns.
  await new Promise<void>((resolve) => setImmediate(resolve))
  let nextWire: ReturnType<typeof installWire> | undefined
  const error = await scope
    .teardown(async () => {
      nextWire = installWire({ usage: () => new Response('', { status: 503 }) })
    }, release)
    .catch((caught: unknown) => caught)
  release()
  await body
  for (const store of stores) await store.pullsSettled()
  expect(nextWire?.polls).toEqual([])
  expect(priorWire.polls).toEqual(['Bearer prior-token'])
  expect((error as Error)?.message).toBe(`Request work outlived test: ${owner}`)
})

it('drains a started background run before the next wire, naming its owner', async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  release = () => gate.resolve()
  let tick: (() => void) | undefined
  const priorWire = installWire({
    usage: () => new Response('', { status: 503 }),
  })
  const background = new BackgroundQuotaRefresh({
    setIntervalFn: (callback) => {
      tick = callback
      return {} as never
    },
    clearIntervalFn: () => {},
  })
  const owner = 'prior loader with a started background run'
  let run: Promise<void> | undefined
  await scope.run(owner, async () => {
    background.start(() => {
      run = (async () => {
        entered.resolve()
        await gate.promise
        await globalThis.fetch('https://chatgpt.com/backend-api/wham/usage', {
          headers: { authorization: 'Bearer prior-background-token' },
        })
      })()
      return run
    })
  })
  tick?.()
  await entered.promise
  let nextWire: ReturnType<typeof installWire> | undefined
  const error = await scope
    .teardown(async () => {
      nextWire = installWire({ usage: () => new Response('', { status: 503 }) })
    }, release)
    .catch((caught: unknown) => caught)
  release()
  await run
  background.stop()
  expect(nextWire?.polls).toEqual([])
  expect(priorWire.polls).toEqual(['Bearer prior-background-token'])
  expect((error as Error)?.message).toBe(`Request work outlived test: ${owner}`)
})

it('drains an outliving test body before fixture cleanup, naming its owner', async () => {
  const pendingScope = createRequestTestScope()
  const owner = 'timed-out login adoption'
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const order: string[] = []
  const body = pendingScope.run(owner, async () => {
    entered.resolve()
    await gate.promise
    order.push('adoption finished')
  })
  await entered.promise
  setTimeout(() => gate.resolve(), 25)

  const error = await pendingScope
    .teardown(async () => {
      order.push('fixture cleanup')
    })
    .catch((caught: unknown) => caught)
  await body

  expect(order).toEqual(['adoption finished', 'fixture cleanup'])
  expect((error as Error)?.message).toBe(`Request work outlived test: ${owner}`)
})
