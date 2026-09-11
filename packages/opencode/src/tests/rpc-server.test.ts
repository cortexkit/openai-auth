import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index'
import { flushForTest } from '../logger'
import {
  drainNotifications,
  pushNotification,
  resetNotificationsForTest,
} from '../rpc/notifications'
import { discoverPortFile } from '../rpc/port-file'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { startRpcServer } from '../rpc/rpc-server'

let stop: (() => Promise<void>) | null = null
let dir: string

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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  await stop?.()
  stop = null
  if (dir) await rm(dir, { recursive: true, force: true })
  resetNotificationsForTest()
})

describe('rpc-server', () => {
  test('apply callback receives sessionId unchanged; health is open and pending-notifications drains', async () => {
    resetNotificationsForTest()
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    let receivedApply: unknown
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async (request) => {
        receivedApply = request
        return { text: 'ok', knobs: {} }
      },
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    expect((await fetch(`${base}/health`)).status).toBe(200)

    const noAuth = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastReceivedId: 0 }),
    })
    expect(noAuth.status).toBe(401)

    pushNotification({ command: 'openai-quota', text: 'x', knobs: {} }, 's1')
    const ok = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's1' }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as {
      messages: Array<{ payload: { command: string } }>
    }
    expect(body.messages[0]?.payload.command).toBe('openai-quota')

    const applyNoAuth = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'openai-quota', arguments: '' }),
    })
    expect(applyNoAuth.status).toBe(401)

    const applyOk = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({
        command: 'openai-routing',
        arguments: 'reset',
        sessionId: 'session-a',
      }),
    })
    expect(applyOk.status).toBe(200)
    expect(await applyOk.json()).toEqual({ text: 'ok', knobs: {} })
    expect(receivedApply).toEqual({
      command: 'openai-routing',
      arguments: 'reset',
      sessionId: 'session-a',
    })
  })

  test('a session-less notification drain delivers every notice but cannot prune another session', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`
    pushNotification({ command: 'openai-quota', text: 's1', knobs: {} }, 's1')
    pushNotification({ command: 'openai-account', text: 's2', knobs: {} }, 's2')

    const noSession = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0 }),
    })
    expect(noSession.status).toBe(200)
    const all = (await noSession.json()).messages as Array<{
      id: number
      payload: { command: string }
    }>
    expect(all.map((message) => message.payload.command)).toEqual([
      'openai-quota',
      'openai-account',
    ])

    const noSessionAck = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: all[0]?.id }),
    })
    expect(noSessionAck.status).toBe(200)
    expect((await noSessionAck.json()).messages).toEqual([
      expect.objectContaining({
        payload: { command: 'openai-account', text: 's2', knobs: {} },
      }),
    ])

    const s1 = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's1' }),
    })
    expect(s1.status).toBe(200)
    expect((await s1.json()).messages).toEqual([
      expect.objectContaining({
        payload: { command: 'openai-quota', text: 's1', knobs: {} },
      }),
    ])

    const s1Ack = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: all[0]?.id, sessionId: 's1' }),
    })
    expect(s1Ack.status).toBe(200)

    const s2 = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's2' }),
    })
    expect(s2.status).toBe(200)
    expect((await s2.json()).messages).toEqual([
      expect.objectContaining({
        payload: { command: 'openai-account', text: 's2', knobs: {} },
      }),
    ])
  })

  test('stopping a stale server leaves its successor port file and health endpoint live', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const first = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'first', knobs: {} }),
    })
    const second = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'second', knobs: {} }),
    })
    try {
      await first.stop()
      const entry = await discoverPortFile(dir, process.pid)
      expect(entry?.port).toBe(second.port)
      expect(
        (await fetch(`http://127.0.0.1:${second.port}/health`)).status,
      ).toBe(200)
    } finally {
      await second.stop()
    }
  })

  test('rejects body exceeding 1 MB byte limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    // ASCII body > 1 MB bytes
    const huge = 'x'.repeat(1_000_001)
    let rejected = false
    try {
      await fetch(`${base}/rpc/apply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ command: 'test', arguments: huge }),
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  test('rejects multibyte body where byte length exceeds limit but string length does not', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    // Each CJK char is 3 bytes in UTF-8 but 1 UTF-16 code unit
    const cjk = '好'.repeat(400_000)
    // String length (UTF-16) is ~400k — below the old 1M limit
    expect(cjk.length).toBeLessThan(1_000_000)
    // Byte length (UTF-8) is ~1.2M — above the 1M limit
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(1_000_000)

    const body = JSON.stringify({ command: 'test', arguments: cjk })
    // The full JSON payload byte length must also exceed 1 MB
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1_000_000)

    let rejected = false
    try {
      await fetch(`${base}/rpc/apply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
        body,
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  test('destroys a socket that stalls part-way through sending a request', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
      // The socket inactivity timer is what reclaims a stalled connection.
      // requestTimeout cannot: Node only samples it on the
      // connectionsCheckingInterval tick (30s by default), so it is a coarse
      // ceiling rather than the mechanism that frees this socket.
      timeoutMs: 100,
    })
    stop = server.stop

    const reqPromise = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/rpc/apply',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${server.token}`,
          },
        },
        (res) => {
          res.on('data', () => {})
          res.on('end', () => {
            reject(
              new Error(
                `should have timed out (end), status: ${res.statusCode}`,
              ),
            )
          })
        },
      )
      req.on('error', () => {
        resolve()
      })
      req.write('{"command":')
    })

    await expect(reqPromise).resolves.toBeUndefined()
  })

  test('starts when the state sweep fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const badSweepRoot = join(dir, 'not-a-directory')
    const logFile = join(dir, 'rpc.log')
    const savedLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE

    try {
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
      await writeFile(badSweepRoot, 'x', 'utf8')
      const server = await startRpcServer({
        dir: join(dir, 'rpc'),
        sweepRoot: badSweepRoot,
        drain: drainNotifications,
        apply: async () => ({ text: 'ok', knobs: {} }),
      })
      stop = server.stop

      expect(
        (await fetch(`http://127.0.0.1:${server.port}/health`)).status,
      ).toBe(200)
      await flushForTest()
      const log = await readFile(logFile, 'utf8')
      expect(log).toContain('WARN [rpc] rpc state sweep failed')
      expect(log).toContain(`"pid":${process.pid}`)
    } finally {
      if (savedLogFile === undefined) {
        delete process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
      } else {
        process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = savedLogFile
      }
    }
  })

  test('startup sweeps stale project state outside the active directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const root = join(dir, 'state')
    const staleDir = join(root, 'openai-auth-deadbeefdeadbeef')
    await mkdir(staleDir, { recursive: true })
    await writeFile(
      join(staleDir, 'port-99999999.json'),
      JSON.stringify({ port: 1, token: 'dead', pid: 99999999, startedAt: 1 }),
      { encoding: 'utf8', mode: 0o600 },
    )

    const server = await startRpcServer({
      dir: join(root, 'openai-auth-cafebabecafebabe'),
      sweepRoot: root,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop

    expect(await readdir(root)).toEqual(['openai-auth-cafebabecafebabe'])
  })

  test('creates a managed RPC directory with 0700 permissions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const managedDir = join(dir, 'managed', 'rpc')
    await mkdir(managedDir, { recursive: true, mode: 0o755 })
    await chmod(managedDir, 0o755)

    const server = await startRpcServer({
      dir: managedDir,
      secureDir: true,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop

    expect((await stat(managedDir)).mode & 0o777).toBe(0o700)
  })

  test('does not chmod a foreign RPC override directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    await chmod(dir, 0o755)

    const server = await startRpcServer({
      dir,
      secureDir: false,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop

    expect((await stat(dir)).mode & 0o777).toBe(0o755)
  })

  test('default timeout lets a slow apply handler respond before the socket is destroyed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    // No explicit timeoutMs — the server default is the safety net. A reset
    // apply takes a few seconds (network call to Codex); the default must not
    // destroy the socket before the handler responds.
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => {
        await Bun.sleep(3_000)
        return { text: 'slow-ok', knobs: {} }
      },
    })
    stop = server.stop

    const res = await fetch(`http://127.0.0.1:${server.port}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ command: 'openai-reset', arguments: '' }),
      signal: AbortSignal.timeout(15_000),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'slow-ok', knobs: {} })
  })

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
      await writeAccountStore(
        process.env.OPENCODE_OPENAI_AUTH_FILE,
        'account-a',
      )
      loaded.push(await loadProjectPlugin(projectA))

      process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'project-b.json')
      await writeAccountStore(
        process.env.OPENCODE_OPENAI_AUTH_FILE,
        'account-b',
      )
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
            command: 'openai-account',
            arguments: '',
            sessionId: 'session-a',
          }),
        },
      )
      expect(responseA.status).toBe(200)
      expect((await responseA.json()).text).toContain('account-a')

      const responseB = await originalFetch(
        `http://127.0.0.1:${portB?.port}/rpc/apply`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${portB?.token}`,
          },
          body: JSON.stringify({
            command: 'openai-account',
            arguments: '',
            sessionId: 'session-b',
          }),
        },
      )
      expect(responseB.status).toBe(200)
      expect((await responseB.json()).text).toContain('account-b')
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
        __openaiAuthRpcServers?: Map<string, unknown>
      }
      for (const { rpc } of projects) {
        expect(registries.__openaiAuthRpcServers?.get(rpc.dir)).toBeDefined()
        expect(
          registries.__openaiAuthCacheKeepManagers?.get(rpc.dir),
        ).toBeDefined()
      }

      for (const plugin of loaded) await plugin.dispose?.()
      loaded.length = 0

      for (const { rpc } of projects) {
        expect(registries.__openaiAuthRpcServers?.get(rpc.dir)).toBeUndefined()
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
      const rpcServers = (
        globalThis as typeof globalThis & {
          __openaiAuthRpcServers?: Map<
            string,
            { port: number; stop: () => Promise<void> }
          >
        }
      ).__openaiAuthRpcServers
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
        __openaiAuthRpcServers?: Map<string, { port: number }>
        __openaiAuthCacheKeepManagers?: Map<string, unknown>
      }
      for (const rpc of [firstRpc, secondRpc]) {
        expect(registries.__openaiAuthRpcServers?.get(rpc.dir)).toBeDefined()
        expect(
          registries.__openaiAuthCacheKeepManagers?.get(rpc.dir),
        ).toBeDefined()
      }

      await plugin.dispose?.()

      for (const rpc of [firstRpc, secondRpc]) {
        expect(registries.__openaiAuthRpcServers?.get(rpc.dir)).toBeUndefined()
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
})
