import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index'
import { resetNotificationsForTest } from '../rpc/notifications'
import { discoverPortFile } from '../rpc/port-file'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { quotaMap, seedPool } from './fixtures/pool-install'
import { rpcServerRegistry } from './fixtures/rpc-registry'
import { restoreEnv } from './setup-env'

function makePluginInput(directory: string): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory,
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

async function loadProjectPlugin(directory: string) {
  const plugin = await CodexAuthPlugin(makePluginInput(directory), {
    experimentalWebSockets: false,
  })
  await loadAuthPlugin(plugin)
  return plugin
}

async function loadAuthPlugin(
  plugin: Awaited<ReturnType<typeof CodexAuthPlugin>>,
) {
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('missing auth loader')
  const loaded = await loader(
    async () => ({
      type: 'oauth',
      provider: 'openai',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
    }),
    { id: 'openai', label: 'OpenAI', models: [] } as never,
  )
  if (!loaded) throw new Error('missing loader options')
  return loaded
}

async function writeAccountStore(path: string, accountId: string) {
  const now = Date.now()
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [
        {
          id: accountId,
          type: 'oauth',
          provider: 'openai',
          access: 'fallback-access',
          refresh: 'fallback-refresh',
          expires: now + 3600_000,
          enabled: true,
          addedAt: now,
          lastUsed: now,
          lastRefreshedAt: now,
        },
      ],
    }),
  )
}

/** A migrated install whose one row is `accountId`, so `/openai` opens on it. */
function writeMigratedStore(configFile: string, accountId: string) {
  seedPool(
    {
      configFile,
      stateFile: process.env.OPENCODE_OPENAI_AUTH_STATE_FILE ?? '',
    },
    [{ id: accountId, quota: quotaMap(10) }],
  )
}

/** The account ids an apply result's refreshed menu lists. */
function accountIds(result: {
  menu?: { sections: Array<{ id: string; items: Array<{ id: string }> }> }
}): string[] {
  return (
    result.menu?.sections
      .find((section) => section.id === 'accounts')
      ?.items.map((item) => item.id) ?? []
  )
}

afterEach(() => {
  resetNotificationsForTest()
})

describe('rpc-server', () => {
  test('keeps RPC ports discoverable and applies with each project captured context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-rpc-projects-'))
    const originalFetch = globalThis.fetch
    const originalStateHome = process.env.XDG_STATE_HOME
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const loaded: Array<Awaited<ReturnType<typeof loadProjectPlugin>>> = []
    try {
      process.env.XDG_STATE_HOME = join(root, 'state')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        root,
        'auth-state.json',
      )
      globalThis.fetch = (async () =>
        new Response('{}')) as unknown as typeof globalThis.fetch

      const projectA = join(root, 'project-a')
      const projectB = join(root, 'project-b')
      await mkdir(projectA)
      await mkdir(projectB)

      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'project-a.json')
      writeMigratedStore(process.env.OPENCODE_OPENAI_AUTH_FILE, 'account-a')
      loaded.push(await loadProjectPlugin(projectA))

      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'project-b.json')
      writeMigratedStore(process.env.OPENCODE_OPENAI_AUTH_FILE, 'account-b')
      loaded.push(await loadProjectPlugin(projectB))

      const rpcA = await resolveRpcDir(projectA)
      const rpcB = await resolveRpcDir(projectB)
      const portA = await discoverPortFile(rpcA.dir, process.pid)
      const portB = await discoverPortFile(rpcB.dir, process.pid)

      expect(portA).not.toBeNull()
      expect(portB).not.toBeNull()
      expect(portA?.port).not.toBe(portB?.port)

      const responseA = await originalFetch(
        `http://127.0.0.1:${portA?.port}/rpc/apply`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${portA?.token}`,
          },
          body: JSON.stringify({
            command: 'openai',
            sectionId: 'routing',
            actionId: 'mode',
            values: { mode: 'fallback-first' },
            sessionId: 'session-a',
          }),
        },
      )
      expect(responseA.status).toBe(200)
      expect(accountIds(await responseA.json())).toEqual(['account-a'])

      const responseB = await originalFetch(
        `http://127.0.0.1:${portB?.port}/rpc/apply`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${portB?.token}`,
          },
          body: JSON.stringify({
            command: 'openai',
            sectionId: 'routing',
            actionId: 'mode',
            values: { mode: 'fallback-first' },
            sessionId: 'session-b',
          }),
        },
      )
      expect(responseB.status).toBe(200)
      expect(accountIds(await responseB.json())).toEqual(['account-b'])
    } finally {
      for (const plugin of loaded) await plugin.dispose?.()
      globalThis.fetch = originalFetch
      restoreEnv('XDG_STATE_HOME', originalStateHome)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_STATE_FILE', originalStateFile)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('disposal removes this test projects from the RPC and cachekeep registries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-rpc-dispose-'))
    const originalFetch = globalThis.fetch
    const originalStateHome = process.env.XDG_STATE_HOME
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const loaded: Array<Awaited<ReturnType<typeof loadProjectPlugin>>> = []
    try {
      process.env.XDG_STATE_HOME = join(root, 'state')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        root,
        'auth-state.json',
      )
      globalThis.fetch = (async () =>
        new Response('{}')) as unknown as typeof globalThis.fetch

      const projects: Array<{
        project: string
        rpc: Awaited<ReturnType<typeof resolveRpcDir>>
      }> = []
      for (const suffix of ['a', 'b', 'c']) {
        const project = join(root, `project-${suffix}`)
        await mkdir(project)
        process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, `${suffix}.json`)
        await writeAccountStore(
          process.env.OPENCODE_OPENAI_AUTH_FILE,
          `account-${suffix}`,
        )
        loaded.push(await loadProjectPlugin(project))
        projects.push({ project, rpc: await resolveRpcDir(project) })
      }

      const registries = globalThis as typeof globalThis & {
        __openaiAuthCacheKeepManagers?: Map<string, unknown>
      }
      for (const { rpc } of projects) {
        expect(rpcServerRegistry()?.get(rpc.dir)).toBeDefined()
        expect(
          registries.__openaiAuthCacheKeepManagers?.get(rpc.dir),
        ).toBeDefined()
      }

      for (const plugin of loaded) await plugin.dispose?.()
      loaded.length = 0

      for (const { rpc } of projects) {
        expect(rpcServerRegistry()?.get(rpc.dir)).toBeUndefined()
        expect(
          registries.__openaiAuthCacheKeepManagers?.get(rpc.dir),
        ).toBeUndefined()
        expect(await discoverPortFile(rpc.dir, process.pid)).toBeNull()
      }
    } finally {
      for (const plugin of loaded) await plugin.dispose?.()
      globalThis.fetch = originalFetch
      restoreEnv('XDG_STATE_HOME', originalStateHome)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_STATE_FILE', originalStateFile)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('disposing a replaced plugin instance does not stop its stale RPC handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-rpc-replace-'))
    const originalFetch = globalThis.fetch
    const originalStateHome = process.env.XDG_STATE_HOME
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    let first: Awaited<ReturnType<typeof loadProjectPlugin>> | undefined
    let second: Awaited<ReturnType<typeof loadProjectPlugin>> | undefined
    try {
      process.env.XDG_STATE_HOME = join(root, 'state')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        root,
        'auth-state.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
      globalThis.fetch = (async () =>
        new Response('{}')) as unknown as typeof globalThis.fetch

      const project = join(root, 'project')
      await mkdir(project)
      await writeAccountStore(
        process.env.OPENCODE_OPENAI_AUTH_FILE,
        'account-replace',
      )
      first = await loadProjectPlugin(project)
      const rpc = await resolveRpcDir(project)
      const rpcServers = rpcServerRegistry<{
        port: number
        stop: () => Promise<void>
      }>()
      const firstRpcServer = rpcServers?.get(rpc.dir)
      if (!firstRpcServer) throw new Error('missing first RPC server')
      second = await loadProjectPlugin(project)

      const successor = await discoverPortFile(rpc.dir, process.pid)
      expect(successor).not.toBeNull()
      let staleStopCalls = 0
      const stop = firstRpcServer.stop
      firstRpcServer.stop = async () => {
        staleStopCalls += 1
        await stop()
      }

      await first.dispose?.()
      expect(staleStopCalls).toBe(0)
    } finally {
      await second?.dispose?.()
      await first?.dispose?.()
      globalThis.fetch = originalFetch
      restoreEnv('XDG_STATE_HOME', originalStateHome)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_STATE_FILE', originalStateFile)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Hooks dispose clears every registry entry started by its loader runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-rpc-hooks-dispose-'))
    const originalFetch = globalThis.fetch
    const originalStateHome = process.env.XDG_STATE_HOME
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const originalRpcDir = process.env.OPENCODE_OPENAI_AUTH_RPC_DIR
    let plugin: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
    try {
      process.env.XDG_STATE_HOME = join(root, 'state')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        root,
        'auth-state.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
      globalThis.fetch = (async () =>
        new Response('{}')) as unknown as typeof globalThis.fetch

      const project = join(root, 'project')
      await mkdir(project)
      await writeAccountStore(
        process.env.OPENCODE_OPENAI_AUTH_FILE,
        'account-replace',
      )
      plugin = await CodexAuthPlugin(makePluginInput(project), {
        experimentalWebSockets: false,
      })
      delete process.env.OPENCODE_OPENAI_AUTH_RPC_DIR
      await loadAuthPlugin(plugin)
      const firstRpc = await resolveRpcDir(project)

      process.env.OPENCODE_OPENAI_AUTH_RPC_DIR = join(root, 'alternate-rpc')
      await loadAuthPlugin(plugin)
      const secondRpc = await resolveRpcDir(project)

      const registries = globalThis as typeof globalThis & {
        __openaiAuthCacheKeepManagers?: Map<string, unknown>
      }
      for (const rpc of [firstRpc, secondRpc]) {
        expect(rpcServerRegistry()?.get(rpc.dir)).toBeDefined()
        expect(
          registries.__openaiAuthCacheKeepManagers?.get(rpc.dir),
        ).toBeDefined()
      }

      await plugin.dispose?.()

      for (const rpc of [firstRpc, secondRpc]) {
        expect(rpcServerRegistry()?.get(rpc.dir)).toBeUndefined()
        expect(
          registries.__openaiAuthCacheKeepManagers?.get(rpc.dir),
        ).toBeUndefined()
        expect(await discoverPortFile(rpc.dir, process.pid)).toBeNull()
      }
    } finally {
      await plugin?.dispose?.()
      globalThis.fetch = originalFetch
      restoreEnv('XDG_STATE_HOME', originalStateHome)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_STATE_FILE', originalStateFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_RPC_DIR', originalRpcDir)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Hooks dispose stops every fallback manager it owns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-fallback-dispose-'))
    const originalFetch = globalThis.fetch
    const originalStateHome = process.env.XDG_STATE_HOME
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const timers: Array<{
      active: boolean
      pluginOwned: boolean
      sharedVault: boolean
      unref(): void
    }> = []
    let plugin: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
    try {
      process.env.XDG_STATE_HOME = join(root, 'state')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        root,
        'auth-state.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
      globalThis.fetch = (async () =>
        new Response('{}', {
          status: 500,
        })) as unknown as typeof globalThis.fetch
      globalThis.setInterval = ((callback: TimerHandler) => {
        // Attribute the timer to its immediate creator. `startRpcServer` makes
        // Node arm its own connection-tracking interval, so counting every
        // timer raised during the window measures the host's build rather than
        // the plugin's teardown: the count differs between machines for
        // reasons this test is not about.
        const createdBy =
          (new Error().stack ?? '')
            .split('\n')
            .slice(1)
            .find((frame) => !frame.includes('rpc-server.test.ts')) ?? ''
        const timer = {
          active: true,
          pluginOwned: !createdBy.includes('node:'),
          sharedVault: createdBy.includes('/shared-vault.ts'),
          unref() {},
        }
        timers.push(timer)
        return timer as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof globalThis.setInterval
      globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
        ;(timer as unknown as { active: boolean }).active = false
      }) as typeof globalThis.clearInterval

      const project = join(root, 'project')
      await mkdir(project)
      await writeAccountStore(
        process.env.OPENCODE_OPENAI_AUTH_FILE,
        'account-refresh',
      )
      plugin = await CodexAuthPlugin(makePluginInput(project), {
        experimentalWebSockets: false,
      })
      await loadAuthPlugin(plugin)
      await loadAuthPlugin(plugin)

      const pluginTimers = timers.filter((timer) => timer.pluginOwned)
      // Re-loading still leaves exactly two per-loader fallback timers.
      // The host now owns one additional shared vault quota timer, not one
      // per loader; disposing the only lease must stop all three.
      expect(
        pluginTimers.filter((timer) => timer.active && !timer.sharedVault),
      ).toHaveLength(2)
      expect(
        pluginTimers.filter((timer) => timer.active && timer.sharedVault),
      ).toHaveLength(1)
      await plugin.dispose?.()
      expect(pluginTimers.every((timer) => !timer.active)).toBe(true)
    } finally {
      await plugin?.dispose?.()
      globalThis.fetch = originalFetch
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
      restoreEnv('XDG_STATE_HOME', originalStateHome)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_STATE_FILE', originalStateFile)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('each loader run seeds persisted fallback quota before routing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-loader-quota-seed-'))
    const originalFetch = globalThis.fetch
    const originalStateHome = process.env.XDG_STATE_HOME
    const originalConfigFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const originalSidebarFile =
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    let plugin: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
    try {
      process.env.XDG_STATE_HOME = join(root, 'state')
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        root,
        'auth-state.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
        root,
        'first-sidebar.json',
      )
      const now = Date.now()
      await writeFile(
        process.env.OPENCODE_OPENAI_AUTH_FILE,
        JSON.stringify({
          version: 1,
          main: { type: 'opencode', provider: 'openai' },
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'exhausted-fallback',
              type: 'oauth',
              provider: 'openai',
              access: 'fallback-access',
              refresh: 'fallback-refresh',
              expires: now + 3600_000,
              enabled: true,
              addedAt: now,
              lastUsed: now,
              lastRefreshedAt: now,
              quota: {
                primary: {
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: now,
                  resetsAt: new Date(now + 3600_000).toISOString(),
                },
              },
            },
          ],
        }),
      )
      const responseAuthorizations: string[] = []
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes('/responses')) {
          responseAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return new Response('{}', {
          status: String(url).includes('/responses') ? 200 : 500,
        })
      }) as typeof globalThis.fetch

      const isolated = await import(
        `../index.ts?loader-quota-seed-${crypto.randomUUID()}`
      )
      plugin = await isolated.CodexAuthPlugin(
        makePluginInput(join(root, 'project')),
        {
          experimentalWebSockets: false,
        },
      )
      if (!plugin) throw new Error('missing plugin')
      await mkdir(join(root, 'project'))
      await loadAuthPlugin(plugin)

      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
        root,
        'second-sidebar.json',
      )
      const loaderResult = await loadAuthPlugin(plugin)
      const fetchOverride = (loaderResult as Record<string, unknown>).fetch as
        | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
        | undefined
      if (!fetchOverride) throw new Error('missing loader fetch override')

      const response = await fetchOverride(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: false }),
        },
      )
      expect(response.status).toBe(200)
      expect(responseAuthorizations).toEqual(['Bearer access-token'])
    } finally {
      await plugin?.dispose?.()
      globalThis.fetch = originalFetch
      restoreEnv('XDG_STATE_HOME', originalStateHome)
      restoreEnv('OPENCODE_OPENAI_AUTH_FILE', originalConfigFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_STATE_FILE', originalStateFile)
      restoreEnv('OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE', originalSidebarFile)
      await rm(root, { recursive: true, force: true })
    }
  })
})
