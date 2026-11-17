import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushForTest, setLogLevel } from '../logger'
import { resetNotificationsForTest } from '../rpc/notifications'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import {
  RPC_SERVER_REGISTRY_KEY,
  type RpcServerHandle,
} from '../rpc/rpc-server'
import { setupOpenAIAuth } from '../v2/setup'
import { setupTrace } from '../v2/setup-trace'
import { openCodeHostLogTail } from './fixtures/opencode2-control-plane'
import {
  fakeOpenCode2Host,
  poolFiles,
  seedPool,
} from './fixtures/opencode2-host'
import { restoreEnv, unsetEnv } from './setup-env'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  resetNotificationsForTest()
  setLogLevel(undefined)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

async function blockedLocation() {
  const root = mkdtempSync(join(tmpdir(), 'oc2-rpc-handover-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const oldLog = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
  const logFile = join(root, 'test.log')
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
  setLogLevel('warn')
  cleanups.push(() => restoreEnv('OPENCODE_OPENAI_AUTH_LOG_FILE', oldLog))
  const files = poolFiles(root)
  seedPool(files, 'main-first', [{ id: 'handover-account' }])
  const config = files.readConfig()
  config.accounts[0]!.enabled = false
  writeFileSync(files.configPath, JSON.stringify(config))
  const host = fakeOpenCode2Host({ directory: root })
  const { dir } = await resolveRpcDir(root)
  const key = Symbol.for(RPC_SERVER_REGISTRY_KEY)
  const globals = globalThis as unknown as Record<
    symbol,
    {
      servers: Map<string, RpcServerHandle>
      pending: Map<string, Promise<void>>
    }
  >
  globals[key] ??= { servers: new Map(), pending: new Map() }
  const registry = globals[key]
  const stopped = deferred<void>()
  const entered = deferred<void>()
  const previous: RpcServerHandle = {
    port: 1,
    token: 'fixture',
    stop: () => {
      entered.resolve()
      return stopped.promise
    },
  }
  registry.servers.set(dir, previous)
  let lateServer: RpcServerHandle | undefined
  const originalSet = registry.servers.set.bind(registry.servers)
  const set = spyOn(registry.servers, 'set').mockImplementation(
    (key, server) => {
      if (key === dir) lateServer = server
      return originalSet(key, server)
    },
  )
  const menu = {
    command: 'openai' as const,
    title: 'Late RPC menu',
    sections: [],
  }
  const setup = setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(root, 'sidebar.json'),
    heartbeat: false,
    poolMigration: false,
    vault: { stateDir: join(root, 'vault'), pollIntervalMs: 0 },
    controlPlane: {
      open: async () => ({ command: 'openai', menu }),
      apply: async () => ({
        command: 'openai',
        ok: false,
        code: 'unavailable',
        text: 'Late RPC answered',
        menu,
      }),
    },
  })
  let dispose: Awaited<typeof setup> | undefined
  void setup.then(
    (cleanup) => {
      dispose = cleanup
    },
    () => {},
  )
  cleanups.push(async () => {
    await dispose?.()
    // A rejected predecessor lets even the never-settling test leave no work
    // behind, without ever starting a replacement server during its assertions.
    stopped.reject(new Error('fixture finished'))
    await registry.pending.get(dir)?.catch(() => {})
    await until(
      () =>
        !registry.pending.has(dir) &&
        (registry.servers.get(dir) === previous || !registry.servers.has(dir)),
    )
    registry.servers.delete(dir)
    set.mockRestore()
  })
  await entered.promise
  return {
    root,
    dir,
    host,
    setup,
    stopped,
    logFile,
    registry,
    lateServer: () => lateServer,
  }
}

test('OpenCode 2 setup returns within the 5 second bound and warns once when RPC hand-over never settles', async () => {
  const f = await blockedLocation()
  let guard: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  try {
    const returned = await Promise.race([
      f.setup.then(() => true),
      new Promise<false>((resolve) => {
        guard = setTimeout(() => resolve(false), 6_000)
      }),
    ])
    expect(returned).toBe(true)
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(f.host.commands).toHaveLength(1)
    flushForTest()
    const log = readFileSync(f.logFile, 'utf8')
    expect(
      log.match(/OpenAI menu RPC hand-over is still pending after 5 seconds/g),
    ).toHaveLength(1)
    expect(log).toContain(f.root)
    expect(f.lateServer()).toBeUndefined()
  } finally {
    clearTimeout(guard)
  }
}, 10_000)

test('OpenCode 2 late RPC hand-over serves the dialog after setup has returned', async () => {
  const f = await blockedLocation()
  await f.setup
  expect(f.lateServer()).toBeUndefined()
  f.stopped.resolve()
  await until(() => f.lateServer() !== undefined)
  const client = createRpcClient(f.dir, process.pid)
  await client.pending(0, 'late')
  await f.host.commands[0]!.execute({ sessionID: 'late' })
  const pending = await client.pending(0, 'late')
  expect(pending).toHaveLength(1)
  expect(JSON.stringify(pending[0]!.payload)).toContain('Late RPC menu')
  const result = await client.apply({
    command: 'openai',
    sectionId: 'connection',
    actionId: 'check',
    sessionId: 'late',
  })
  expect(result.text).toBe('Late RPC answered')
}, 10_000)

test('OpenCode 2 dispose before late RPC hand-over leaves no live server or port file', async () => {
  const f = await blockedLocation()
  const dispose = await f.setup
  await dispose()
  expect(f.host.commands).toHaveLength(0)
  f.stopped.resolve()
  await until(
    () => f.lateServer() !== undefined && !f.registry.servers.has(f.dir),
  )
  const server = f.lateServer()!
  expect(existsSync(join(f.dir, `port-${process.pid}.json`))).toBe(false)
  await expect(
    fetch(`http://127.0.0.1:${server.port}/health`),
  ).rejects.toThrow()
}, 10_000)

test('OpenCode 2 late rejected RPC hand-over logs only the folder and leaves setup registered', async () => {
  const f = await blockedLocation()
  await f.setup
  f.stopped.reject(new Error('secret-from-a-server-error'))
  await f.registry.pending.get(f.dir)?.catch(() => {})
  expect(f.host.commands).toHaveLength(1)
  expect(f.lateServer()).toBeUndefined()
  flushForTest()
  const log = readFileSync(f.logFile, 'utf8')
  expect(log).toContain('OpenAI menu RPC hand-over failed')
  expect(log).toContain(f.root)
  expect(log).not.toContain('secret-from-a-server-error')
}, 10_000)

test('setup tracing is opt-in and host-log diagnostics use only the isolated data folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc2-setup-trace-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const trace = join(root, 'trace.jsonl')
  const old = process.env.OPENAI_AUTH_E2E_RELOAD_TRACE
  cleanups.push(() => restoreEnv('OPENAI_AUTH_E2E_RELOAD_TRACE', old))
  unsetEnv('OPENAI_AUTH_E2E_RELOAD_TRACE')
  setupTrace('disabled', root)
  expect(existsSync(trace)).toBe(false)
  process.env.OPENAI_AUTH_E2E_RELOAD_TRACE = trace
  setupTrace('before test await', root)
  setupTrace('after test await', root)
  expect(
    readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).step),
  ).toEqual(['before test await', 'after test await'])
  process.env.OPENAI_AUTH_E2E_RELOAD_TRACE = join(
    root,
    'missing',
    'trace.jsonl',
  )
  expect(() => setupTrace('missing destination', root)).not.toThrow()
  const logDir = join(root, 'opencode', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'opencode.log'),
    `not-in-tail${'x'.repeat(6000)}tail`,
  )
  expect(openCodeHostLogTail({ XDG_DATA_HOME: root })).toHaveLength(6000)
  expect(openCodeHostLogTail({ XDG_DATA_HOME: root })).toEndWith('tail')
  expect(openCodeHostLogTail({})).toBe('(isolated data folder unavailable)')
})
