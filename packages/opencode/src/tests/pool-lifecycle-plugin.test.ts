// The plugin running the account-pool migration and later adoptions in the
// background: through its real loader, fetch override and auth methods,
// against a legacy install on disk and a file-backed OpenCode login slot.
import { afterEach, beforeEach, describe, expect, spyOn } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vaultPaths } from '@cortexkit/openai-auth-core/internal'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import {
  chatgptAccessToken,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import type { PoolLifecycleDeps } from '../core/pool-lifecycle.ts'
import * as poolMigrationSteps from '../core/pool-migration.ts'
import {
  type HostSlotAdapter,
  isPoolPlaceholder,
  POOL_MIGRATION_KEY,
  type PoolMigrationStep,
} from '../core/pool-migration.ts'
import { __resetProcessHeartbeatForTest } from '../core/process-heartbeat.ts'
import { __menuContextForTest, CodexAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { FAR, fileSlot, jwt, login } from './fixtures/pool-migration-harness.ts'
import { createRequestTestScope } from './request-test-scope.ts'
import { restoreEnv } from './setup-env'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

// Parsed files are inspected field by field.
type Json = Record<string, any>

let dir: string
let configFile: string
let stateFile: string
let slot: HostSlotAdapter
let originalFetch: typeof globalThis.fetch
let hooks: Hooks | undefined
const scope = createRequestTestScope()
const it = scope.it
const releaseMigrations: Array<() => void> = []

beforeEach(() => {
  scope.capturePluginWork()
  dir = mkdtempSync(join(tmpdir(), 'oai-pool-lifecycle-'))
  configFile = join(dir, 'openai-auth.json')
  stateFile = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    dir,
    'sidebar.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(dir, 'test.log')
  process.env.OPENCODE_CONFIG_DIR = dir
  // A state home of its own: no other plugin process is visible to the
  // version fence, and this one's heartbeat lands here.
  process.env.XDG_STATE_HOME = join(dir, 'state')
  // OpenCode 1's data directory, where the plugin reads the login slot.
  process.env.XDG_DATA_HOME = join(dir, 'data')
  mkdirSync(join(dir, 'data', 'opencode'), { recursive: true })
  process.env.NODE_ENV = 'test'
  __resetProcessHeartbeatForTest()
  // OpenCode 1's own reads and writes of the slot, for the test to use and
  // for the plugin client's `auth.set`.
  slot = fileSlot(join(dir, 'data', 'opencode', 'auth.json'))
  originalFetch = globalThis.fetch
  hooks = undefined
})

afterEach(async () => {
  for (const release of releaseMigrations.splice(0)) release()
  await scope.teardown(async () => {
    await hooks?.dispose?.()
    globalThis.fetch = originalFetch
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    restoreEnv('OPENCODE_CONFIG_DIR')
    restoreEnv('XDG_STATE_HOME')
    restoreEnv('XDG_DATA_HOME')
    delete process.env.NODE_ENV
  })
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const slotValue = async () => slot.get({ path: { id: 'openai' } })
const setSlot = (value: unknown) =>
  slot.set({ path: { id: 'openai' }, body: value })

async function waitFor(check: () => Promise<boolean>, what: string) {
  // Shorter than the default five-second test timeout, so a condition that
  // never holds fails with its own name rather than a bare timeout.
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A legacy install: main in the slot, no fallbacks, no routing mode. */
async function seedLegacy(
  slotCredential: unknown = login('acct-main', 'r-main'),
) {
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
    }),
  )
  await setSlot(slotCredential)
}

interface Wire {
  sends: string[]
  refreshTokens: string[]
}

/**
 * Replace the network. With `usage`, quota polls answer with a reading (a
 * migrated install refuses an account until its first reading lands);
 * otherwise they fail like every other unexpected call.
 */
function installWire(options: { usage?: boolean } = {}): Wire {
  const wire: Wire = { sends: [], refreshTokens: [] }
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    if (options.usage && target.includes('/wham/usage')) {
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18_000,
              reset_at: Math.floor((Date.now() + 3600_000) / 1000),
            },
          },
        }),
        { status: 200 },
      )
    }
    if (target.includes('/oauth/token')) {
      wire.refreshTokens.push(
        new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ??
          '',
      )
      return new Response(
        JSON.stringify({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
          id_token: 'id',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (target.includes('/responses')) {
      wire.sends.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{}', { status: 200 })
    }
    return new Response('unavailable', { status: 503 })
  }) as unknown as typeof globalThis.fetch
  return wire
}

type PoolOptions = Partial<
  Pick<
    PoolLifecycleDeps,
    'fence' | 'migrate' | 'adopt' | 'runDeps' | 'log' | 'timers'
  >
> & { enabled?: boolean }

/**
 * OpenCode 1's plugin client `auth`, shaped exactly as its generated SDK
 * class: it has no way to read a login, only these five methods, and it
 * reports a request's result as `{ data }` or `{ error }` instead of
 * throwing. `set` writes the file the way OpenCode 1's server does.
 */
function opencode1SdkAuth() {
  const envelope = (data: unknown) => ({
    data,
    request: new Request('http://opencode.internal/auth'),
    response: new Response(null, { status: 200 }),
  })
  class Auth {
    async remove() {
      return envelope(true)
    }
    async start() {
      return envelope({})
    }
    async callback() {
      return envelope(true)
    }
    async authenticate() {
      return envelope({})
    }
    async set(options: { path: { id: string }; body: unknown }) {
      await slot.set(options)
      return envelope(true)
    }
  }
  return new Auth()
}

function pluginInput(): PluginInput {
  return {
    client: {
      auth: opencode1SdkAuth(),
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

/** A step hook that parks the migration at `step` until released. */
function parkAt(step: PoolMigrationStep) {
  const reached = deferred()
  const release = deferred()
  releaseMigrations.push(() => release.resolve())
  let parked = false
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    onStep: async (current: PoolMigrationStep) => {
      if (current !== step || parked) return
      parked = true
      reached.resolve()
      await release.promise
    },
  }
}

const quietLog = { info: () => {}, warn: () => {} }

async function loadPlugin(poolMigration: PoolOptions = {}, extra = {}) {
  hooks = await CodexAuthPlugin(pluginInput(), {
    experimentalWebSockets: false,
    poolMigration: {
      log: quietLog,
      ...poolMigration,
      enabled: 'enabled' in poolMigration ? poolMigration.enabled : true,
    },
    ...extra,
  })
  const authHook = hooks.auth
  if (!authHook?.loader) throw new Error('No auth loader')
  const loaded = await authHook.loader(
    (async () => slotValue()) as never,
    { id: 'openai', label: 'OpenAI', models: [] } as never,
  )
  const fetchOverride = (loaded as Record<string, unknown>).fetch as (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>
  if (!fetchOverride) throw new Error('No fetch in loader result')
  return { fetchOverride: scope.wrap(fetchOverride), methods: authHook.methods }
}

function send(
  fetchOverride: (url: string, init: RequestInit) => Promise<Response>,
) {
  return fetchOverride('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }),
  })
}

describe('the migration after the loader starts', () => {
  it('runs by default: with no override the main login moves into the pool', async () => {
    await seedLegacy()
    installWire({ usage: true })
    await loadPlugin({ enabled: undefined })
    await waitFor(
      async () => isPoolPlaceholder(await slotValue()),
      'the placeholder in the slot',
    )
  })

  it('moves nothing while switched off', async () => {
    await seedLegacy()
    const wire = installWire()
    const { fetchOverride } = await loadPlugin({ enabled: false })
    const before = readFileSync(configFile, 'utf8')
    expect((await send(fetchOverride)).status).toBe(200)
    await scope.settlePluginWork()
    expect(isPoolPlaceholder(await slotValue())).toBe(false)
    expect(readFileSync(configFile, 'utf8')).toBe(before)
    expect(wire.sends).toEqual([`Bearer ${jwt('acct-main')}`])
  })

  it('runs in the background: a request meanwhile is served from the slot, and afterwards from row main', async () => {
    await seedLegacy()
    const wire = installWire({ usage: true })
    const park = parkAt('after-record-write')
    // The loader returns while the migration is parked mid-transfer.
    const { fetchOverride } = await loadPlugin({
      runDeps: { onStep: park.onStep },
    })
    await park.reached

    const during = await send(fetchOverride)
    expect(during.status).toBe(200)
    expect(wire.sends).toEqual([`Bearer ${jwt('acct-main')}`])

    park.release()
    await waitFor(
      async () => isPoolPlaceholder(await slotValue()),
      'the placeholder in the slot',
    )
    await waitFor(
      async () => readJson(configFile)[POOL_MIGRATION_KEY]?.migratedAt > 0,
      'the migration marker',
    )
    // Give row main a token of its own, so the next send shows where main
    // was served from.
    const state = readJson(stateFile)
    state.accounts.main = { ...state.accounts.main, access: 'row-main-access' }
    writeFileSync(stateFile, JSON.stringify(state))
    // A migrated install serves from the account pool, which refuses an
    // account whose quota is unknown. The migration itself starts row
    // main's first quota poll; the request goes out once that reading is in.
    await waitFor(
      async () =>
        readJson(configFile).commonAuthPool?.rows?.main?.quota !== undefined,
      "row main's first quota reading",
    )

    const after = await send(fetchOverride)
    expect(after.status).toBe(200)
    expect(wire.sends[1]).toBe('Bearer row-main-access')
    // An unset routing mode was written out as the legacy default.
    expect(readJson(configFile).routing).toEqual({ mode: 'main-first' })
  })

  it('a migration that throws fails neither the loader nor a request', async () => {
    await seedLegacy()
    const wire = installWire()
    const { fetchOverride } = await loadPlugin({
      migrate: async () => {
        throw new Error('migration exploded')
      },
    })
    const response = await send(fetchOverride)
    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([`Bearer ${jwt('acct-main')}`])
    expect((await slotValue()) as Json).toMatchObject({ refresh: 'r-main' })
  })

  it('the slot refresh stands down while a transfer covers its token', async () => {
    // The slot's access token has expired, so a request refreshes main.
    await seedLegacy({ ...login('acct-main', 'r-main'), expires: 1 })
    const wire = installWire()
    const park = parkAt('after-record-write')
    const { fetchOverride } = await loadPlugin({
      runDeps: { onStep: park.onStep },
    })
    await park.reached
    const pendingChecked = deferred()
    const check = poolMigrationSteps.poolTransferPendingInConfigFile
    const checkSpy = spyOn(
      poolMigrationSteps,
      'poolTransferPendingInConfigFile',
    ).mockImplementation((...args) => {
      const result = check(...args)
      if (result) pendingChecked.resolve()
      return result
    })
    const pending = send(fetchOverride)
    try {
      await pendingChecked.promise
    } finally {
      checkSpy.mockRestore()
    }
    // The pending record names the slot's token: nothing refreshed it.
    const refreshedDuringTransfer = [...wire.refreshTokens]
    park.release()
    const response = await pending
    expect(refreshedDuringTransfer).toEqual([])
    expect(response.status).toBe(200)
    // Served from row main once the placeholder was in: the token was
    // refreshed exactly once, there.
    expect(wire.refreshTokens).toEqual(['r-main'])
    expect(wire.sends).toEqual(['Bearer refreshed-access'])
    expect(isPoolPlaceholder(await slotValue())).toBe(true)
  })
})

describe("on OpenCode 1's plugin client", () => {
  it('migrates through a client that can only write the slot', async () => {
    const auth = opencode1SdkAuth()
    // The client the plugin gets: the five methods of OpenCode 1's SDK, and
    // nothing that reads a login.
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(auth))
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual(['authenticate', 'callback', 'remove', 'set', 'start'])
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        mainAccountId: 'acct-main',
      }),
    )
    await setSlot(login('acct-main', 'r-main'))
    installWire({ usage: true })
    await loadPlugin({ enabled: undefined })
    await waitFor(
      async () => readJson(configFile)[POOL_MIGRATION_KEY]?.migratedAt > 0,
      'the migration marker',
    )
    expect(isPoolPlaceholder(await slotValue())).toBe(true)
    const config = readJson(configFile)
    expect(config.commonAuthPool).toBeDefined()
    expect('mainAccountId' in config).toBe(false)
    expect(readJson(stateFile).accounts.main).toMatchObject({
      access: jwt('acct-main'),
      refresh: 'r-main',
    })
  })

  it('says why it runs without the migration when the client cannot write the slot', async () => {
    await seedLegacy()
    installWire()
    const warnings: Array<{ message: string; data: unknown }> = []
    const input = pluginInput()
    ;(input.client as unknown as { auth: unknown }).auth = {}
    hooks = await CodexAuthPlugin(input, {
      experimentalWebSockets: false,
      poolMigration: {
        enabled: true,
        log: {
          info: () => {},
          warn: (message: string, data?: unknown) => {
            warnings.push({ message, data })
          },
        },
      },
    })
    expect(warnings).toEqual([
      {
        message: 'account pool migration is off for this OpenCode client',
        data: {
          reason:
            'the OpenCode client has no auth.set to write its login slot with',
        },
      },
    ])
  })
})

// Vault mode (this host enrolled with the Claustrum vault) writes no local
// account file: neither the migration nor an adoption of a slot login runs,
// and the slot login is not used. Both run once the host disconnects.
describe('the pool lifecycle in vault mode', () => {
  const VAULT_BEARER = `Bearer ${chatgptAccessToken('chatgpt-vault')}`

  /** An approved enrollment, as Connect leaves it; returns the token path. */
  function enroll(stateDir: string): string {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const { tokenPath } = vaultPaths(stateDir, 'opencode')
    writeFileSync(
      tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    chmodSync(tokenPath, 0o600)
    return tokenPath
  }

  /** Timers the test fires by hand. */
  function fakeTimers() {
    const pending = new Map<number, () => void>()
    let next = 0
    return {
      set(run: () => void) {
        pending.set(++next, run)
        return next
      },
      clear(handle: unknown) {
        pending.delete(handle as number)
      },
      fire() {
        const due = [...pending.values()]
        pending.clear()
        for (const run of due) run()
      },
    }
  }

  /** The local account files and OpenCode's slot file, byte for byte. */
  const localFiles = () =>
    [configFile, stateFile, join(dir, 'data', 'opencode', 'auth.json')].map(
      (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    )

  async function readyVault() {
    const vault = __menuContextForTest()?.vault
    if (!vault) throw new Error('the loader built no vault')
    await vault.refresh()
    await vault.pollStale(0)
  }

  it('a never-migrated install is served from the vault without migrating, and migrates once the host disconnects', async () => {
    const daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    try {
      const stateDir = join(dir, 'vault')
      const tokenPath = enroll(stateDir)
      await seedLegacy()
      const before = localFiles()
      const wire = installWire({ usage: true })
      const timers = fakeTimers()
      const { fetchOverride } = await loadPlugin(
        { timers },
        {
          vault: {
            stateDir,
            connectionFile: () => daemon.connectionFile,
            pollIntervalMs: 0,
          },
        },
      )
      await readyVault()

      const response = await send(fetchOverride)
      timers.fire()
      await scope.settlePluginWork()

      expect(response.status).toBe(200)
      // The vault served; the login in the slot was neither sent nor
      // refreshed, and nothing was migrated or written.
      expect(wire.sends).toEqual([VAULT_BEARER])
      expect(wire.refreshTokens).toEqual([])
      expect(localFiles()).toEqual(before)
      expect(readJson(configFile)[POOL_MIGRATION_KEY]).toBeUndefined()

      // Disconnect: the next lifecycle check migrates the install.
      rmSync(tokenPath)
      timers.fire()
      await waitFor(
        async () => isPoolPlaceholder(await slotValue()),
        'the migration after disconnect',
      )
      expect(readJson(configFile)[POOL_MIGRATION_KEY]?.migratedAt).toBeNumber()
    } finally {
      await hooks?.dispose?.()
      hooks = undefined
      await daemon.stop()
    }
  })

  it('a slot login landing in vault mode is neither used nor adopted, the local files stay byte-identical, and it is adopted after disconnect', async () => {
    const daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    try {
      const stateDir = join(dir, 'vault')
      await seedLegacy()
      const wire = installWire({ usage: true })
      const timers = fakeTimers()
      const { fetchOverride } = await loadPlugin(
        { timers },
        {
          vault: {
            stateDir,
            connectionFile: () => daemon.connectionFile,
            pollIntervalMs: 0,
          },
        },
      )
      await waitFor(
        async () => isPoolPlaceholder(await slotValue()),
        'the migration',
      )
      await scope.settlePluginWork()
      const tokenPath = enroll(stateDir)
      await readyVault()
      // A new login lands in OpenCode's slot (`opencode auth login`).
      await setSlot(login('acct-new', 'r-new'))
      await scope.settlePluginWork()
      const before = localFiles()

      // A request, and the lifecycle's own adoption tick.
      const response = await send(fetchOverride)
      timers.fire()
      await scope.settlePluginWork()

      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([VAULT_BEARER])
      expect(localFiles()).toEqual(before)
      expect(Object.keys(readJson(stateFile).accounts)).not.toContain(
        'acct-new',
      )

      // Disconnect: a request finds the real login in the slot, serves it,
      // and adopts it into the pool.
      rmSync(tokenPath)
      const after = await send(fetchOverride)
      expect(after.status).toBe(200)
      expect(wire.sends.at(-1)).toBe(`Bearer ${jwt('acct-new')}`)
      await waitFor(
        async () => isPoolPlaceholder(await slotValue()),
        'the adoption after disconnect',
      )
      expect(Object.keys(readJson(stateFile).accounts)).toContain('acct-new')
    } finally {
      await hooks?.dispose?.()
      hooks = undefined
      await daemon.stop()
    }
  })
})

describe('later logins on a migrated install', () => {
  async function migratedPlugin(extra = {}) {
    await seedLegacy()
    const loaded = await loadPlugin({}, extra)
    await waitFor(
      async () => isPoolPlaceholder(await slotValue()),
      'the migration',
    )
    return loaded
  }

  const rowIds = () => Object.keys(readJson(stateFile).accounts ?? {}).sort()

  it('a request finding a real login serves it and adopts it in the background', async () => {
    const wire = installWire()
    const { fetchOverride } = await migratedPlugin()
    await setSlot(login('acct-new', 'r-new'))
    const response = await send(fetchOverride)
    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([`Bearer ${jwt('acct-new')}`])
    await waitFor(
      async () => isPoolPlaceholder(await slotValue()),
      'the placeholder back in the slot',
    )
    expect(rowIds()).toEqual(['acct-new', 'main'])
  })

  it('a login through the plugin auth methods is adopted once the host writes it', async () => {
    installWire()
    const tokens = deferred<{
      access_token: string
      refresh_token: string
      id_token: string
      expires_in: number
    }>()
    const { methods } = await migratedPlugin({
      login: {
        authorize: {
          browser: async () => ({ url: 'about:blank', tokens: tokens.promise }),
        },
      },
    })
    const browser = methods[0] as {
      authorize: () => Promise<{ callback: () => Promise<Json> }>
    }
    const flow = await browser.authorize()
    tokens.resolve({
      access_token: jwt('acct-login'),
      refresh_token: 'r-login',
      id_token: 'id',
      expires_in: 3600,
    })
    const result = await flow.callback()
    expect(result).toMatchObject({ type: 'success', refresh: 'r-login' })
    // OpenCode writes the login into its slot after the callback returns.
    await setSlot({
      type: 'oauth',
      access: result.access,
      refresh: result.refresh,
      expires: FAR,
    })
    await waitFor(
      async () => isPoolPlaceholder(await slotValue()),
      'the placeholder back in the slot',
    )
    expect(rowIds()).toEqual(['acct-login', 'main'])
  })
})
