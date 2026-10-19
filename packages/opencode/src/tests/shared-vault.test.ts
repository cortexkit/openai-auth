import { afterEach, beforeEach, describe, expect, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectClaustrumEnrollmentClient,
  connectClaustrumScopedClient,
} from '@cortexkit/common-auth/claustrum'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { OpenAiVault, vaultPaths } from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
import {
  chatgptAccessToken,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { __menuContextForTest, CodexAuthPlugin } from '../index'
import { flushForTest } from '../logger'
import { getSidebarState } from '../sidebar-state'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  scope as requestScope,
} from './fixtures/opencode2-host'
import {
  installWire,
  mockPluginInput,
  PLACEHOLDER,
  seedPool,
  usageBody,
  waitFor,
} from './fixtures/pool-install'
import { createRequestTestScope } from './request-test-scope'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env'

const scope = createRequestTestScope()
const test = scope.it
const cleanups: Array<() => Promise<void> | void> = []
let dir: string
let stateDir: string
let daemon: MockDaemon
let vaults: Set<OpenAiVault>
let vaultPolls: Set<Promise<unknown>>
let wire: ReturnType<typeof installWire>
let originalFetch: typeof fetch
let quotaPasses: number

beforeEach(async () => {
  await flushForTest()
  scope.capturePluginWork()
  dir = mkdtempSync(join(tmpdir(), 'openai-shared-vault-'))
  stateDir = join(dir, 'vault')
  process.env.OPENCODE_OPENAI_AUTH_FILE = join(dir, 'openai-auth.json')
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
    dir,
    'openai-auth-state.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(dir, 'test.log')
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    dir,
    'sidebar-state.json',
  )
  seedPool(
    {
      configFile: process.env.OPENCODE_OPENAI_AUTH_FILE,
      stateFile: process.env.OPENCODE_OPENAI_AUTH_STATE_FILE,
    },
    [{ id: 'main' }],
    { routing: { mode: 'fallback-first' } },
  )
  mkdirSync(stateDir, { mode: 0o700 })
  writeFileSync(
    vaultPaths(stateDir, 'opencode').tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  daemon = await startMockDaemon({
    directory: dir,
    credentials: { 'oauth:openai:shared': vaultLogin('chatgpt-shared') },
  })
  originalFetch = globalThis.fetch
  wire = installWire()
  vaults = new Set()
  vaultPolls = new Set()
  quotaPasses = 0
  const pollStale = OpenAiVault.prototype.pollStale
  const pollSpy = spyOn(OpenAiVault.prototype, 'pollStale').mockImplementation(
    function (this: OpenAiVault, maxAgeMs) {
      quotaPasses++
      const poll = pollStale.call(this, maxAgeMs)
      vaultPolls.add(poll)
      void poll.then(
        () => vaultPolls.delete(poll),
        () => vaultPolls.delete(poll),
      )
      return poll
    },
  )
  cleanups.push(() => pollSpy.mockRestore())
  const start = OpenAiVault.prototype.start
  const spy = spyOn(OpenAiVault.prototype, 'start').mockImplementation(
    function (this: OpenAiVault) {
      vaults.add(this)
      start.call(this)
    },
  )
  cleanups.push(() => spy.mockRestore())
})

afterEach(async () => {
  await scope.teardown(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    await Promise.allSettled([...vaultPolls])
    await daemon.stop()
    await flushForTest()
    globalThis.fetch = originalFetch
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    rmSync(dir, { recursive: true, force: true })
  })
})

async function plugin(
  vaultOptions: NonNullable<
    Parameters<typeof CodexAuthPlugin>[1]
  >['vault'] = {},
  project = '',
) {
  const input = mockPluginInput()
  input.directory = project
  const hooks: Hooks = await CodexAuthPlugin(input, {
    experimentalWebSockets: false,
    vault: {
      stateDir,
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
      ...vaultOptions,
    },
  })
  cleanups.push(async () => {
    await hooks.dispose?.()
  })
  const loaded = (await hooks.auth!.loader!(
    (async () => ({ ...PLACEHOLDER })) as never,
    {} as never,
  )) as { fetch: typeof fetch }
  return { hooks, fetch: loaded.fetch }
}

async function ready() {
  // Startup owns the first quota pass. Repeated readiness checks must only
  // observe its live result, not force more writes to the shared roster file.
  await waitFor(
    () =>
      vaults.size > 0 &&
      [...vaults].every((vault) => {
        const rows = vault.snapshot()?.rows
        return rows?.length === 1 && rows[0]?.quota !== undefined
      })
        ? true
        : undefined,
    'first roster and quota',
  )
}

async function send(fetchImpl: typeof fetch) {
  return scope.wrap(fetchImpl)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }),
  })
}

describe('one host vault per process', () => {
  test('readiness of a warm consumer starts no extra quota pass', async () => {
    await plugin()
    await waitFor(
      () =>
        [...vaults].every(
          (vault) => vault.snapshot()?.rows[0]?.quota !== undefined,
        )
          ? true
          : undefined,
      'startup quota',
    )
    await Promise.all([...vaultPolls])
    expect(quotaPasses).toBeGreaterThan(0)
    const before = quotaPasses
    await ready()
    await ready()
    expect(quotaPasses).toBe(before)
  })

  test('readiness waits for quota in the live consumer snapshot', async () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const fetchImpl = globalThis.fetch
    const gatedFetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/wham/usage')) {
        entered.resolve()
        await resume.promise
      }
      return fetchImpl(input, init)
    }) as typeof fetch
    const lease = acquireOpenCodeVault(
      {
        host: 'opencode',
        stateDir,
        connectionFile: () => daemon.connectionFile,
        pollIntervalMs: 0,
        fetchImpl: () => gatedFetch,
      },
      {
        configPath: process.env.OPENCODE_OPENAI_AUTH_FILE!,
        statePath: process.env.OPENCODE_OPENAI_AUTH_STATE_FILE!,
      },
    )
    cleanups.push(() => lease.release())
    lease.start()
    let waiting: Promise<void> | undefined
    try {
      await entered.promise
      expect(lease.vault.snapshot()?.rows).toHaveLength(1)
      expect(lease.vault.snapshot()?.rows[0]?.quota).toBeUndefined()
      let returned = false
      waiting = ready().then(() => {
        returned = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(returned).toBe(false)
      resume.resolve()
      await waiting
      expect(lease.vault.snapshot()?.rows[0]?.quota).toBeDefined()
    } finally {
      resume.resolve()
      await waiting
      await Promise.allSettled([...vaultPolls])
    }
  })

  test('an idle OpenCode 1 loader publishes the current route with a quota reading', async () => {
    const sidebarFile = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    const configFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    if (!sidebarFile || !configFile) throw new Error('test paths are missing')

    await plugin()
    await plugin()
    await ready()
    const menu = __menuContextForTest()
    if (!menu?.refreshSidebar || !menu.refreshAllQuota)
      throw new Error('sidebar refresh is unavailable')
    await menu.refreshSidebar()
    const before = await getSidebarState(sidebarFile)
    expect(before.route).toBe('fallback-first')

    const pollsBefore = wire.polls.length
    const sendsBefore = wire.sends.length
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      routing: { mode: string }
    }
    config.routing.mode = 'main-first'
    writeFileSync(configFile, JSON.stringify(config))

    await menu.refreshAllQuota()

    const after = await getSidebarState(sidebarFile)
    expect(wire.polls.length).toBeGreaterThan(pollsBefore)
    expect(wire.sends).toHaveLength(sendsBefore)
    expect(after.route).toBe('main-first')
    expect(after.vaultAccounts?.[0]?.quota?.primary?.usedPercent).toBe(10)
  })

  test('two projects share one roster poll stream', async () => {
    // Drive only the vault's roster timers: wall-clock sleeps would count
    // extra polls if a busy host took longer than one interval to load a project.
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const pending = new Set<{ run: () => void; unref(): void }>()
    globalThis.setTimeout = ((
      callback: TimerHandler,
      delay: number,
      ...args: unknown[]
    ) => {
      const creator =
        (new Error().stack ?? '')
          .split('\n')
          .slice(1)
          .find((frame) => !frame.includes('shared-vault.test.ts')) ?? ''
      if (!creator.includes('/claustrum/consumer.js'))
        return originalSetTimeout(callback, delay, ...args)
      const timer = {
        run: () => {
          if (typeof callback === 'function') callback()
        },
        unref() {},
      }
      pending.add(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      const owned = timer as unknown as { run: () => void; unref(): void }
      if (!pending.delete(owned)) originalClearTimeout(timer)
    }) as typeof clearTimeout
    cleanups.push(() => {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    })
    const projects = [join(dir, 'a'), join(dir, 'b')]
    for (const project of projects) mkdirSync(project)
    for (const project of projects) {
      await plugin({ pollIntervalMs: 500 }, project)
      await ready()
    }
    await ready()
    await waitFor(
      () => (pending.size === vaults.size ? true : undefined),
      'initial roster timers',
    )
    const initial = daemon.lists
    for (const timer of [...pending]) {
      const count = pending.size
      pending.delete(timer)
      timer.run()
      await waitFor(
        () => (pending.size === count ? true : undefined),
        'next roster timer',
      )
    }
    const afterPoll = daemon.lists
    console.info(
      `shared vault list_scoped: initial=${initial}, after one interval=${afterPoll}`,
    )
    expect(initial).toBe(1)
    expect(afterPoll).toBe(2)
    expect(vaults.size).toBe(1)
    expect(daemon.connections).toBe(1)
  })

  test('disposing one holder leaves the other serving until the last release', async () => {
    const first = await plugin()
    const second = await plugin()
    await ready()
    await first.hooks.dispose?.()
    const gets = daemon.gets.length
    expect((await send(second.fetch)).status).toBe(200)
    expect(wire.sends.at(-1)).toBe(
      `Bearer ${chatgptAccessToken('chatgpt-shared')}`,
    )
    expect(daemon.gets.slice(gets)).toEqual([
      expect.objectContaining({ credential_id: 'oauth:openai:shared' }),
    ])
    expect(daemon.connections).toBe(1)
    await second.hooks.dispose?.()
    await waitFor(
      () => (daemon.connections === 0 ? true : undefined),
      'last holder closes connection',
    )
    expect(daemon.connections).toBe(0)
  })

  test('injected connectors remain isolated', async () => {
    const connectScoped = () =>
      connectClaustrumScopedClient({
        connectionFile: daemon.connectionFile,
        storagePath: vaultPaths(stateDir, 'opencode').tokenPath,
      })
    await plugin({ connectScoped })
    await ready()
    await plugin({ connectScoped })
    await ready()
    await ready()
    expect(vaults.size).toBe(2)
    expect(daemon.lists).toBe(2)
    expect(daemon.connections).toBe(2)
  })

  test('injected enrollment connectors also remain isolated', async () => {
    const connectEnrollment = () =>
      connectClaustrumEnrollmentClient({
        connectionFile: daemon.connectionFile,
      })
    await plugin({ connectEnrollment })
    await ready()
    await plugin({ connectEnrollment })
    await ready()
    expect(vaults.size).toBe(2)
    expect(daemon.connections).toBe(2)
  })

  test('leases share the first roster and never consult a released source', async () => {
    let firstReads = 0
    let secondReads = 0
    const options = {
      host: 'opencode' as const,
      stateDir,
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
    }
    const paths = {
      configPath: join(dir, 'openai-auth.json'),
      statePath: join(dir, 'openai-auth-state.json'),
    }
    const first = acquireOpenCodeVault(
      {
        ...options,
        reservedRouteIds: () => {
          firstReads++
          return ['main']
        },
      },
      paths,
    )
    const second = acquireOpenCodeVault(
      {
        ...options,
        stateDir: join(stateDir, '.'),
        reservedRouteIds: () => {
          secondReads++
          return ['main']
        },
      },
      paths,
    )
    cleanups.push(
      () => second.release(),
      () => first.release(),
    )
    expect(first.vault).toBe(second.vault)
    expect(first.firstRoster).toBe(second.firstRoster)
    first.start()
    second.start()
    await first.firstRoster
    expect(daemon.lists).toBe(1)
    const before = firstReads
    const liveBefore = secondReads
    first.release()
    first.release()
    await second.vault.refresh()
    expect(firstReads).toBe(before)
    expect(secondReads).toBeGreaterThan(liveBefore)
  })

  test('fourteen concurrent loaders have one consumer and no roster lock warning', async () => {
    await Promise.all(Array.from({ length: 14 }, () => plugin()))
    await ready()
    expect(vaults.size).toBe(1)
    expect(daemon.lists).toBe(1)
    await flushForTest()
    const log = readFileSync(join(dir, 'test.log'), 'utf8')
    expect(log).toContain('codex auth loader ready')
    expect(log).not.toMatch(
      /(?:Timed out acquiring|Lost) claustrum-roster|vault (?:roster refresh|quota write) failed/,
    )
  }, 20_000)

  test('OpenCode 2 setups on the same pool store share a consumer', async () => {
    const paths = () => ({
      configPath: join(dir, 'openai-auth.json'),
      statePath: join(dir, 'openai-auth-state.json'),
    })
    const hosts = [fakeOpenCode2Host(), fakeOpenCode2Host()]
    const stops: Array<() => Promise<void> | void> = []
    for (const host of hosts) {
      const stop = await setupOpenAIAuth(host.ctx, {
        paths,
        sidebarStateFile: join(dir, 'sidebar.json'),
        heartbeat: false,
        fetch: (async () =>
          new Response(usageBody(10))) as unknown as typeof fetch,
        vault: {
          stateDir,
          connectionFile: () => daemon.connectionFile,
          pollIntervalMs: 0,
        },
      })
      if (stop) stops.push(stop)
      cleanups.push(async () => {
        await stop?.()
      })
      await ready()
    }
    await ready()
    expect(vaults.size).toBe(1)
    expect(daemon.lists).toBe(1)
    await stops[0]?.()
    const draftScope = requestScope('ses_shared', 'primary')
    const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
    await hosts[1]!.fire('model.request', { ...draftScope, headers })
    const draft = {
      ...draftScope,
      request: new Request('https://codex.test/v1/responses', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    }
    await hosts[1]!.fire('http.request', draft)
    expect(draft.request.headers.get('authorization')).toBe(
      `Bearer ${chatgptAccessToken('chatgpt-shared')}`,
    )
    await hosts[1]!.fire('http.response', {
      ...draftScope,
      request: draft.request,
      response: new Response('{}'),
    })
    await stops[1]?.()
    await waitFor(
      () => (daemon.connections === 0 ? true : undefined),
      'OpenCode 2 last release',
    )
    expect(daemon.connections).toBe(0)
  })

  test('OpenCode 2 setups on different pool stores do not share a consumer', async () => {
    for (const name of ['one', 'two']) {
      const configPath = join(dir, `${name}.json`)
      const statePath = join(dir, `${name}-state.json`)
      seedPool(
        { configFile: configPath, stateFile: statePath },
        [{ id: 'main' }],
        { routing: { mode: 'fallback-first' } },
      )
      const stop = await setupOpenAIAuth(fakeOpenCode2Host().ctx, {
        paths: () => ({ configPath, statePath }),
        sidebarStateFile: join(dir, `${name}-sidebar.json`),
        heartbeat: false,
        fetch: (async () =>
          new Response(usageBody(10))) as unknown as typeof fetch,
        vault: {
          stateDir,
          connectionFile: () => daemon.connectionFile,
          pollIntervalMs: 0,
        },
      })
      cleanups.push(async () => {
        await stop?.()
      })
      await ready()
    }
    await ready()
    expect(vaults.size).toBe(2)
    expect(daemon.lists).toBe(2)
  })
})
