// Each scenario starts before importing plugin code: module initialization is
// part of the reload boundary, not just the setup function's body.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const mode = process.argv[2]
const globals = globalThis as unknown as Record<PropertyKey, unknown>
const version = '1.8.2'
const messages: string[] = []
const log = {
  info: (message: string) => messages.push(message),
  warn: (message: string) => messages.push(message),
}

if (mode?.startsWith('legacy-')) {
  if (mode === 'legacy-vault')
    globals[Symbol.for('@cortexkit/openai-auth/opencode-vaults')] = new Map()
  if (mode === 'legacy-rpc-symbol')
    globals[Symbol.for('__openaiAuthRpcServers')] = { servers: new Map() }
  if (mode === 'legacy-rpc-string') globals.__openaiAuthRpcServers = new Map()

  const paths = await import('../../core/account-paths')
  const heartbeat = await import('../../core/process-heartbeat')
  const runtime = await import('../../core/runtime-layout')
  const { migrationFenceOpen } = await import('../../core/version-fence')
  const config = process.env.OPENCODE_CONFIG_DIR as string
  mkdirSync(config, { recursive: true })
  const oldState = join(config, 'openai-auth-state.json')
  writeFileSync(oldState, 'old generation still owns this file')
  const location = paths.runtimeLayoutLocation()
  mkdirSync(location.stateHomeDir, { recursive: true })
  // Even an existing marker must not redirect an old generation's writers.
  writeFileSync(join(location.stateHomeDir, 'layout.json'), '{"version":1}')
  const handle = await heartbeat.startProcessHeartbeat({ version, logger: log })
  const before = JSON.parse(readFileSync(handle.path as string, 'utf8'))
  const layout = await runtime.prepareRuntimeLayout({ version, log })
  const statePath = paths.getAccountPaths().statePath
  await runtime.prepareRuntimeLayout({ version, log })
  await heartbeat.recordProcessLayout({
    key: location.key,
    layout: 'state-home',
    version,
  })
  const after = JSON.parse(readFileSync(handle.path as string, 'utf8'))
  await handle.release()
  const selfFence = await migrationFenceOpen({
    currentVersion: version,
    layoutMove: true,
  })
  const otherFence = await migrationFenceOpen({
    currentVersion: version,
    layoutMove: true,
    selfPid: process.pid + 1,
    isAlive: (pid) => pid === process.pid,
  })
  // An old generation's last owner can unlink the canonical heartbeat later.
  rmSync(handle.path as string)
  const afterOldReleaseFence = await migrationFenceOpen({
    currentVersion: version,
    layoutMove: true,
    selfPid: process.pid + 1,
    isAlive: (pid) => pid === process.pid,
  })
  // An unwritable canonical file on the next location remains best-effort.
  mkdirSync(handle.path as string)
  process.env.OPENCODE_CONFIG_DIR = join(config, 'another-location')
  const unwritable = await runtime.prepareRuntimeLayout({ version, log })
  console.log(
    JSON.stringify({
      layout,
      unwritable,
      before: before.layouts,
      after: after.layouts,
      key: location.key,
      statePath,
      oldState: readFileSync(oldState, 'utf8'),
      selfFence,
      otherFence,
      afterOldReleaseFence,
      messages,
    }),
  )
} else if (mode === 'old-vault' || mode === 'old-vault-status') {
  const { OpenAiVault } = await import('@cortexkit/openai-auth-core/internal')
  const config = process.env.OPENCODE_CONFIG_DIR as string
  const paths = {
    configPath: join(config, 'pool.json'),
    statePath: join(config, 'state.json'),
  }
  const stateDir = join(config, 'openai-auth-vault')
  const connectionFile = join(config, 'claustrum.json')
  let foreignCalls = 0
  const foreign = () => {
    foreignCalls++
  }
  const vault: Record<string, unknown> = {
    authority: foreign,
    pollStale: foreign,
    start: foreign,
    firstRoster: foreign,
    close: foreign,
  }
  if (mode === 'old-vault-status') {
    // v1.8.0 had the current methods but status lacked discovered.
    for (const method of Object.getOwnPropertyNames(OpenAiVault.prototype))
      if (method !== 'constructor') vault[method] = foreign
  }
  vault.status = async () => {
    foreignCalls++
    return { accounts: [] }
  }
  const entry = {
    vault,
    holders: new Set(),
    firstRoster: Promise.withResolvers<void>(),
    started: false,
  }
  const key = JSON.stringify([
    'opencode',
    stateDir,
    connectionFile,
    paths.configPath,
    paths.statePath,
  ])
  const registry = new Map([[key, entry]])
  globals[Symbol.for('@cortexkit/openai-auth/opencode-vaults')] = registry
  const { acquireOpenCodeVault } = await import('../../core/shared-vault')
  const options = {
    host: 'opencode' as const,
    stateDir,
    connectionFile: () => connectionFile,
  }
  const first = acquireOpenCodeVault(options, paths)
  const second = acquireOpenCodeVault(options, paths)
  const status = await first.vault.status()
  first.release()
  second.release()
  console.log(
    JSON.stringify({
      foreignCalls,
      ignored: first.vault !== (vault as unknown),
      shared: first.vault === second.vault,
      retained: registry.get(key) === entry,
      holders: entry.holders.size,
      discovered: typeof status.discovered === 'boolean',
      methods: [
        first.vault.awaitRequestRoster,
        first.vault.grantReach,
        first.vault.reorder,
      ].every((method) => typeof method === 'function'),
    }),
  )
} else if (mode === 'old-pins') {
  const config = process.env.OPENCODE_CONFIG_DIR as string
  const paths = {
    configPath: join(config, 'pool.json'),
    statePath: join(config, 'state.json'),
  }
  let foreignCalls = 0
  const foreign = () => {
    foreignCalls++
    throw new Error('old ledger called')
  }
  const old = {
    get: foreign,
    forget: foreign,
    subscribe: foreign,
    snapshot: foreign,
    place: foreign,
  }
  const key = JSON.stringify([paths.configPath, paths.statePath])
  const registry = new Map([[key, old]])
  globals[Symbol.for('@cortexkit/openai-auth/opencode2-pins')] = registry
  const { acquireSessionPins } = await import('../../v2/shared-pins')
  const pins = acquireSessionPins(paths)
  console.log(
    JSON.stringify({
      foreignCalls,
      ignored: pins !== (old as unknown),
      retained: registry.get(key) === old,
      shared: pins === acquireSessionPins(paths),
      pending: pins.placementSnapshot().size,
      reservations: [pins.reserve, pins.rollback, pins.finish].every(
        (method) => typeof method === 'function',
      ),
    }),
  )
} else if (mode === 'old-control-plane') {
  const { fakeOpenCode2Host } = await import('./opencode2-host')
  const directory = process.env.OPENCODE_CONFIG_DIR as string
  const host = fakeOpenCode2Host({ directory })
  let foreignCalls = 0
  const foreign = () => {
    foreignCalls++
    throw new Error('foreign location called')
  }
  // v1.1.0 through v1.6.1 locations had no closed AbortController.
  const previous = {
    menu: { open: foreign, apply: foreign },
    session: { get: foreign },
    registration: { dispose: foreign },
  }
  const command = {
    name: 'openai',
    description: 'OpenAI account menu',
    execute: foreign,
  }
  const nullRegistration = {
    ...previous,
    closed: new AbortController(),
    registration: null,
  }
  const state = {
    locations: new Map<string, unknown>([
      [`${directory}-foreign`, previous],
      [`${directory}-null-registration`, nullRegistration],
      [directory, previous],
    ]),
    command,
  }
  globals[Symbol.for('cortexkit.openai-auth.v2.commands')] = state
  const { installControlPlane } = await import('../../v2/control-plane')
  const { resolveRpcDir } = await import('../../rpc/rpc-dir')
  const { createRpcClient } = await import('../../rpc/rpc-client')
  const opened: string[] = []
  const dispose = await installControlPlane(host.ctx, {
    async open(sessionId) {
      opened.push(sessionId)
      return {
        command: 'openai',
        menu: { command: 'openai', title: 'OpenAI accounts', sections: [] },
      }
    },
    async apply() {
      throw new Error('not used')
    },
  })
  try {
    const client = createRpcClient(
      (await resolveRpcDir(directory)).dir,
      process.pid,
    )
    await client.pending(0, 'active')
    const registered = host.commands[0]
    if (!registered) throw new Error('OpenAI command was not registered')
    await registered.execute({ sessionID: 'active' })
    console.log(
      JSON.stringify({
        opened,
        foreignCalls,
        sameState:
          globals[Symbol.for('cortexkit.openai-auth.v2.commands')] === state,
        sameCommand: state.command === command,
        foreignRetained:
          state.locations.get(`${directory}-foreign`) === previous &&
          state.locations.get(`${directory}-null-registration`) ===
            nullRegistration,
        oldLocationUnchanged: !('closed' in previous),
      }),
    )
  } finally {
    await dispose()
  }
} else if (mode === 'foreign-codex-store') {
  const path = join(process.env.OPENCODE_CONFIG_DIR as string, 'sessions.json')
  const foreign = {
    get() {
      throw new Error('foreign store called')
    },
  }
  const registry = new Map([[path, foreign]])
  const nullFrameTurns = {
    sessions: new Map(),
    get: foreign.get,
    delete: foreign.get,
    save: foreign.get,
    settled: foreign.get,
    frameTurns: null,
  }
  registry.set(`${path}-null`, nullFrameTurns)
  globals[Symbol.for('@cortexkit/openai-auth/opencode2-codex-sessions')] =
    registry
  const { acquireCodexSessions } = await import('../../v2/codex-sessions')
  const store = acquireCodexSessions(path)
  console.log(
    JSON.stringify({
      ignored: store !== (foreign as unknown),
      retained: registry.get(path) === foreign,
      ignoredNull:
        acquireCodexSessions(`${path}-null`) !== (nullFrameTurns as unknown),
      retainedNull: registry.get(`${path}-null`) === nullFrameTurns,
      shared: store === acquireCodexSessions(path),
      sessions: store.sessions.size,
    }),
  )
} else if (mode === 'old-codex-store') {
  const path = join(process.env.OPENCODE_CONFIG_DIR as string, 'sessions.json')
  const sessions = new Map([
    [
      'active',
      { threadID: 'old-thread', turnID: 'old-turn', windowID: 'old-thread:0' },
    ],
  ])
  const store = {
    path,
    sessions,
    get: (id: string) => sessions.get(id),
    delete: (id: string) => {
      sessions.delete(id)
    },
    save: async () => {},
    settled: async () => {},
  }
  globals[Symbol.for('@cortexkit/openai-auth/opencode2-codex-sessions')] =
    new Map([[path, store]])
  const { acquireCodexSessions } = await import('../../v2/codex-sessions')
  const { CodexHttpState } = await import('../../v2/codex-wire')
  const acquired = acquireCodexSessions(path)
  const first = new CodexHttpState(undefined, 'installation', acquired)
  const second = new CodexHttpState(
    undefined,
    'installation',
    acquireCodexSessions(path),
  )
  first.frameTurns.advance('active', {
    input: [{ role: 'user', content: 'hello' }],
  })
  const sharedTurn = second.frameTurns.get('active')?.turnID
  first.forget('active')
  console.log(
    JSON.stringify({
      sameStore: acquired === (store as unknown),
      thread: acquired.sessions === sessions,
      sharedFrameTurns: first.frameTurns === second.frameTurns,
      sharedTurn: typeof sharedTurn === 'string',
      forgotten: second.frameTurns.get('active') === undefined,
      sessionDeleted: !sessions.has('active'),
    }),
  )
} else if (mode === 'fresh-vault-import') {
  await import('../../core/shared-vault')
  const paths = await import('../../core/account-paths')
  const heartbeat = await import('../../core/process-heartbeat')
  const runtime = await import('../../core/runtime-layout')
  const layout = await runtime.prepareRuntimeLayout({
    version,
    log,
    fence: async () => ({ open: true }),
  })
  const dir = heartbeat.processHeartbeatDir()
  mkdirSync(dir, { recursive: true })
  const oldWitness = join(dir, `0${process.pid}.json`)
  writeFileSync(
    oldWitness,
    'stale witness from a previous process with this pid',
  )
  const handle = await heartbeat.startProcessHeartbeat({ version, logger: log })
  const record = JSON.parse(readFileSync(handle.path as string, 'utf8'))
  const staleWitnessRemoved = !existsSync(oldWitness)
  await handle.release()
  console.log(
    JSON.stringify({
      layout,
      layouts: record.layouts,
      key: paths.runtimeLayoutLocation().key,
      staleWitnessRemoved,
    }),
  )
} else if (mode === 'partial-layout-state') {
  const state = { runs: new Map() }
  globals[Symbol.for('@cortexkit/openai-auth/runtime-layout-runs')] = state
  const runtime = await import('../../core/runtime-layout')
  const layout = await runtime.prepareRuntimeLayout({
    version,
    log,
    fence: async () => ({ open: true }),
  })
  console.log(
    JSON.stringify({
      layout,
      same:
        globals[Symbol.for('@cortexkit/openai-auth/runtime-layout-runs')] ===
        state,
      logged: (state as { logged?: unknown }).logged instanceof Set,
    }),
  )
} else {
  throw new Error(`Unknown reload scenario: ${mode}`)
}
