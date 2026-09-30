// The plugin running the account-pool migration and later adoptions in the
// background: through its real loader, fetch override and auth methods,
// against a legacy install on disk and a file-backed OpenCode login slot.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { PoolLifecycleDeps } from '../core/pool-lifecycle.ts'
import {
  type HostSlotAdapter,
  isPoolPlaceholder,
  POOL_MIGRATION_KEY,
  type PoolMigrationStep,
} from '../core/pool-migration.ts'
import { __resetProcessHeartbeatForTest } from '../core/process-heartbeat.ts'
import { CodexAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { FAR, fileSlot, jwt, login } from './fixtures/pool-migration-harness.ts'
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

beforeEach(() => {
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
  process.env.NODE_ENV = 'test'
  __resetProcessHeartbeatForTest()
  slot = fileSlot(join(dir, 'auth.json'))
  originalFetch = globalThis.fetch
  hooks = undefined
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await hooks?.dispose?.()
  await drainSidebarWrites()
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = FLOOR_SIDEBAR_STATE_FILE
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
  restoreEnv('OPENCODE_CONFIG_DIR')
  restoreEnv('XDG_STATE_HOME')
  delete process.env.NODE_ENV
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

function installWire(): Wire {
  const wire: Wire = { sends: [], refreshTokens: [] }
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
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
  Pick<PoolLifecycleDeps, 'fence' | 'migrate' | 'adopt' | 'runDeps' | 'log'>
> & { enabled?: boolean }

function pluginInput(): PluginInput {
  return {
    client: {
      auth: {
        get: slot.get,
        set: slot.set,
        all: slot.all,
      },
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
  return { fetchOverride, methods: authHook.methods }
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
  it('is switched off by default in this release: nothing moves', async () => {
    await seedLegacy()
    const wire = installWire()
    const { fetchOverride } = await loadPlugin({ enabled: undefined })
    const before = readFileSync(configFile, 'utf8')
    expect((await send(fetchOverride)).status).toBe(200)
    // Long enough for a background run to have written its record.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(isPoolPlaceholder(await slotValue())).toBe(false)
    expect(readFileSync(configFile, 'utf8')).toBe(before)
    expect(wire.sends).toEqual([`Bearer ${jwt('acct-main')}`])
  })

  it('runs in the background: a request meanwhile is served from the slot, and afterwards from row main', async () => {
    await seedLegacy()
    const wire = installWire()
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
    const pending = send(fetchOverride)
    await Bun.sleep(400)
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
      custody: {
        transport: {
          getCredential: async () => {
            throw new Error('not used')
          },
          statusCredential: async () => ({
            ready: false,
            lastErrorCode: null,
            leaseHeld: false,
            recordVersion: 0,
          }),
          reportAuthFailure: async () => {},
          close: () => {},
        },
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
