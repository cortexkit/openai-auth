// The Claustrum vault end to end on OpenCode: the real claustrum client over
// a socket to a mock daemon (`mock-claustrum.ts` in the core tests), the
// plugin loaded on a migrated install, and a fake network for OpenAI.
//
// Enrollment through `opencode auth login`, vault accounts routed beside the
// pool rows in each routing mode, a served 401 reported to the vault, the
// declined-account interlock, one owner per ChatGPT account, the host-slot
// guard, and what an install still holds from the removed handle-mode
// custody.
import { afterEach, beforeEach, describe, expect, spyOn } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MenuTerminal } from '@cortexkit/common-auth/auth-menu'
import {
  connectClaustrumScopedClient,
  readClaustrumEnrollmentToken,
} from '@cortexkit/common-auth/claustrum'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  loadAccounts,
  mutateAccounts,
  OpenAiVault,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
import {
  chatgptAccessToken,
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { authDoctorChecks, readStoreIds } from '../auth/doctor'
import { createAuthMethods } from '../auth/methods'
import { applyOpenAiMenu } from '../commands'
import { __menuContextForTest } from '../index.ts'
import {
  HOUR,
  installWire,
  loadPlugin,
  PLACEHOLDER,
  type PoolMode,
  quotaMap,
  readJson,
  seedPool,
  sleep,
  usageBody,
  type Wire,
  waitFor,
} from './fixtures/pool-install'

/** The network, with the main row's quota polls reading it exhausted. */
function wireWithExhaustedMain(): Wire {
  return installWire({
    usage: (bearer) =>
      new Response(usageBody(bearer === 'Bearer main-token' ? 100 : 10), {
        status: 200,
      }),
  })
}

import { createFailurePhaseClock } from './failure-phase-clock.ts'
import { createRequestTestScope } from './request-test-scope.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env'

const ENROLLMENT_TOKEN = '01'.repeat(32)
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')

let dir: string
let files: { configFile: string; stateFile: string }
let stateDir: string
let daemon: MockDaemon | undefined
let hooks: Hooks | undefined
let originalFetch: typeof globalThis.fetch
const scope = createRequestTestScope()
const test = scope.it
const clock = createFailurePhaseClock()
const phaseIt = (name: string, body: () => Promise<void>) =>
  scope.it(name, () => clock.run(name, body))

beforeEach(() => {
  scope.capturePluginWork()
  dir = mkdtempSync(join(tmpdir(), 'openai-vault-'))
  files = {
    configFile: join(dir, 'openai-auth.json'),
    stateFile: join(dir, 'openai-auth-state.json'),
  }
  stateDir = join(dir, 'vault')
  process.env.OPENCODE_OPENAI_AUTH_FILE = files.configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = files.stateFile
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  await scope.teardown(async () => {
    await hooks?.dispose?.()
    hooks = undefined
    await daemon?.stop()
    daemon = undefined
    globalThis.fetch = originalFetch
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    rmSync(dir, { recursive: true, force: true })
  })
})

async function startDaemon(credentials: Record<string, MockCredential> = {}) {
  daemon = await clock.phase('mock daemon listen', () =>
    startMockDaemon({ directory: dir, credentials }),
  )
  return daemon
}

/** An approved enrollment, as Connect leaves it: the token, owner-only. */
function enroll(host: 'opencode' | 'pi' = 'opencode') {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath } = vaultPaths(stateDir, host)
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
}

/** The plugin on a migrated install, its vault pointed at the mock daemon. */
async function plugin(
  slot: Record<string, unknown> = { ...PLACEHOLDER },
  options: Parameters<typeof loadPlugin>[0] = {},
) {
  const running = daemon
  if (!running) throw new Error('start the daemon first')
  hooks = await clock.phase('plugin and auth loader', () =>
    loadPlugin(
      {
        ...options,
        vault: {
          stateDir,
          connectionFile: () => running.connectionFile,
          pollIntervalMs: 0,
        },
      },
      slot,
    ),
  )
  const vault = __menuContextForTest()?.vault
  if (!vault) throw new Error('the loader built no vault')
  // The first roster, and a quota reading for every vault account, so
  // admission has something to judge.
  await clock.phase('vault roster refresh', () => vault.refresh())
  await clock.phase('vault quota poll', () => vault.pollStale(0))
  return { hooks, vault }
}

describe('OpenCode 1 vault stream admission', () => {
  for (const signal of ['limit', 'quota'] as const) {
    test(`a vault WebSocket ${signal} signal sends the next request to a healthy account`, async () => {
      await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
      enroll()
      seedPool(files, [{ id: 'main', quota: quotaMap(10) }], {
        routing: { mode: 'fallback-first' },
        killswitch: {
          enabled: true,
          schema: 'floors-v1',
          defaults: { primary: 20 },
        },
      })
      installWire()
      const sent: string[] = []
      const server = Bun.serve<{ bearer: string }>({
        port: 0,
        fetch(req, server) {
          if (
            server.upgrade(req, {
              data: { bearer: req.headers.get('authorization') ?? '' },
            })
          )
            return
          return new Response('websocket required', { status: 400 })
        },
        websocket: {
          message(ws, message) {
            const body = JSON.parse(String(message))
            if (body.generate === false) {
              ws.send(
                JSON.stringify({
                  type: 'response.completed',
                  response: { id: 'prewarm' },
                }),
              )
              return
            }
            sent.push(ws.data.bearer)
            if (ws.data.bearer === `Bearer ${VAULT_ACCESS}`) {
              ws.send(
                JSON.stringify(
                  signal === 'limit'
                    ? {
                        type: 'response.failed',
                        response: {
                          id: 'limited',
                          failed: { rate_limit_reached_type: 'primary' },
                        },
                      }
                    : {
                        type: 'codex.rate_limits',
                        rate_limits: {
                          primary: {
                            used_percent: 90,
                            window_minutes: 300,
                            reset_at: Math.floor((Date.now() + HOUR) / 1000),
                          },
                          secondary: null,
                        },
                      },
                ),
              )
              if (signal === 'limit') return
            }
            ws.send(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'completed' },
              }),
            )
          },
        },
      })
      try {
        const { vault } = await plugin(
          { ...PLACEHOLDER },
          {
            experimentalWebSockets: true,
            codexApiEndpoint: new URL('/responses', server.url).href,
          },
        )
        const writes: Promise<void>[] = []
        const record = vault.recordSnapshot.bind(vault)
        const spy = spyOn(vault, 'recordSnapshot').mockImplementation(
          (...args) => {
            const write = record(...args)
            writes.push(write)
            return write
          },
        )
        const loaded = (await hooks!.auth!.loader!(
          (async () => ({ ...PLACEHOLDER })) as never,
          {} as never,
        )) as { fetch: typeof fetch }
        const first = await request(loaded.fetch, 'vault-stream', true)
        if (signal === 'limit') await expect(first.text()).rejects.toThrow()
        else {
          await first.text()
          // Wait for the receipt-bound roster write, not for a quota poll.
          await Promise.all(writes)
        }
        const second = await request(loaded.fetch, 'vault-stream', true)
        await second.text().catch(() => {})
        expect(sent).toEqual([`Bearer ${VAULT_ACCESS}`, 'Bearer main-token'])
        spy.mockRestore()
      } finally {
        await hooks?.dispose?.()
        hooks = undefined
        await server.stop(true)
      }
    })
  }

  test('a vault WebSocket reading keeps its served receipt across a roster replacement', async () => {
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }], {
      routing: { mode: 'fallback-first' },
    })
    installWire()
    const stream = Promise.withResolvers<{ send(message: string): unknown }>()
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return
        return new Response('websocket required', { status: 400 })
      },
      websocket: {
        message(ws, message) {
          if (JSON.parse(String(message)).generate === false) {
            ws.send(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'prewarm' },
              }),
            )
            return
          }
          ws.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'old-login' },
            }),
          )
          stream.resolve(ws)
        },
      },
    })
    try {
      const { vault } = await plugin(
        { ...PLACEHOLDER },
        {
          experimentalWebSockets: true,
          codexApiEndpoint: new URL('/responses', server.url).href,
        },
      )
      const writes: Promise<void>[] = []
      const record = vault.recordSnapshot.bind(vault)
      const spy = spyOn(vault, 'recordSnapshot').mockImplementation(
        (...args) => {
          const write = record(...args)
          writes.push(write)
          return write
        },
      )
      const response = await request(
        await fetchOverride(),
        'receipt-fence',
        true,
      )
      const socket = await stream.promise
      running.credentials['oauth:openai:vault'] = vaultLogin(
        'chatgpt-replacement',
        { record_version: 2 },
      )
      await vault.refresh()
      await vault.pollStale(0)
      spy.mockClear()
      writes.length = 0
      socket.send(
        JSON.stringify({
          type: 'codex.rate_limits',
          rate_limits: {
            primary: { used_percent: 90, window_minutes: 300 },
            secondary: null,
          },
        }),
      )
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: { id: 'old-login' },
        }),
      )
      await response.text()
      await Promise.all(writes)
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        true,
        expect.objectContaining({ accountIdentity: 'chatgpt-vault' }),
      )
      expect(vault.routes()[0]?.identity).toBe('chatgpt-replacement')
      expect(vault.routes()[0]?.quota?.limits).toContainEqual(
        expect.objectContaining({ usedPercent: 10 }),
      )
      spy.mockRestore()
    } finally {
      await hooks?.dispose?.()
      hooks = undefined
      await server.stop(true)
    }
  })
})

describe('migrated credential refusal messages', () => {
  function terminal(message: string) {
    // OpenCode 1 v1.18.30 session/retry.ts: a message match can override the status.
    const patterns = [
      /429|500|502|503|504|524/i,
      /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
      /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
      /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
      /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
      /try your request again|retry your request|resource exhausted|resource_exhausted/i,
      /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
    ]
    expect(patterns.some((pattern) => pattern.test(message))).toBe(false)
  }

  test('an unusable pool credential returns a fixed explanatory local 401', async () => {
    await startDaemon()
    seedPool(files, [
      { id: 'main', expires: Date.now() - HOUR, quota: quotaMap(10) },
    ])
    // Use an explicit refresh refusal without changing any request timeout.
    const network = installWire()
    const send = globalThis.fetch
    globalThis.fetch = (async (url, init) =>
      String(url).includes('/oauth/token')
        ? new Response('{}', { status: 400 })
        : send(url, init)) as typeof fetch
    await plugin()
    const response = await request(await fetchOverride())
    expect(response.status).toBe(401)
    const message = await response.text()
    expect(message).toBe(
      'Request refused locally: no usable account credential. Sign in with opencode auth login.',
    )
    terminal(message)
    expect(network.sends).toEqual([])
  })

  test('a vault refusal returns a distinct fixed explanatory local 401', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', enabled: false, quota: quotaMap(10) }])
    const wire = installWire()
    await plugin()
    const send = await fetchOverride()
    await daemon!.stop()
    daemon = undefined
    const response = await request(send)
    expect(response.status).toBe(401)
    const message = await response.text()
    expect(message).toBe(
      'Request refused locally: the credential vault did not authorize an account. Check the vault and its host enrollment.',
    )
    terminal(message)
    expect(wire.sends).toEqual([])
  })

  test('no eligible accounts returns its own fixed explanatory local 401', async () => {
    await startDaemon()
    seedPool(files, [{ id: 'main', enabled: false, quota: quotaMap(10) }])
    const wire = installWire()
    await plugin()
    const response = await request(await fetchOverride())
    expect(response.status).toBe(401)
    const message = await response.text()
    expect(message).toBe(
      'Request refused locally: no eligible account is configured. Sign in with opencode auth login.',
    )
    terminal(message)
    expect(wire.sends).toEqual([])
  })

  test('a custody tombstone without main returns a distinct explanatory local 401', async () => {
    await startDaemon()
    seedPool(files, [])
    const wire = installWire()
    const tombstone = {
      ...PLACEHOLDER,
      refresh: 'claustrum-tombstone:v1:openai',
    }
    await plugin(tombstone)
    const loaded = (await hooks!.auth!.loader!(
      (async () => ({ ...tombstone })) as never,
      {} as never,
    )) as { fetch: typeof fetch }
    const response = await request(loaded.fetch)
    expect(response.status).toBe(401)
    const message = await response.text()
    expect(message).toBe(
      'Request refused locally: this setup has no main login in its account store. Sign in with opencode auth login.',
    )
    terminal(message)
    expect(wire.sends).toEqual([])
  })
})

async function fetchOverride(): Promise<typeof globalThis.fetch> {
  const loader = hooks?.auth?.loader
  if (!loader) throw new Error('no loader')
  const loaded = (await loader(
    (async () => ({ ...PLACEHOLDER })) as never,
    {} as never,
  )) as { fetch?: typeof globalThis.fetch }
  if (!loaded.fetch) throw new Error('no fetch override')
  return loaded.fetch
}

function request(
  fetchImpl: typeof globalThis.fetch,
  sessionId?: string,
  stream?: boolean,
): Promise<Response> {
  return scope.wrap(fetchImpl)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { 'x-session-id': sessionId } : {}),
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      ...(stream ? { stream: true } : {}),
      input: [{ role: 'user', content: 'hi' }],
    }),
  })
}

async function setMode(mode: PoolMode) {
  // Through the pool store's locked settings write: the plugin writes the
  // same file in the background (a row's quota reading, for one), and a
  // plain read-modify-write here could be overwritten by one of those that
  // read the file before it, putting the old mode back.
  await openPoolStore({
    provider: 'openai',
    configPath: files.configFile,
    statePath: files.stateFile,
    quota: quotaCodec,
  }).updateSettings((settings) => {
    settings.routing = { mode }
  })
  // The request path re-reads the config only when its modification time
  // changes; a short pause makes sure the next request sees the new mode.
  await Bun.sleep(5)
}

/** A terminal that types `keys` into the menu and records what it prints. */
function scriptedTerminal(keys: string[]) {
  const queue = [...keys]
  let listener: ((data: string) => void) | undefined
  let written = ''
  const feed = () => {
    setTimeout(() => {
      if (!listener || queue.length === 0) return
      listener(queue.shift() as string)
      feed()
    }, 5)
  }
  const terminal = {
    input: {
      isTTY: true,
      isRaw: false,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (_event: 'data', handler: (data: string) => void) => {
        listener = handler
        feed()
        return undefined
      },
      removeListener: () => {
        listener = undefined
        return undefined
      },
    },
    output: {
      write: (text: string) => {
        written += text
        return true
      },
      columns: 160,
      rows: 60,
    },
  } as unknown as MenuTerminal
  return { terminal, written: () => written }
}

const DOWN = '\u001b[B'
const ENTER = '\r'

describe('enrollment', () => {
  test('Connect in `opencode auth login` proposes this host, tells the operator the ck commands, and stores the token owner-only', async () => {
    const running = await startDaemon({
      'oauth:openai:work': vaultLogin('chatgpt-work'),
    })
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const vault = new OpenAiVault({
      host: 'opencode',
      stateDir,
      connectionFile: () => running.connectionFile,
      pollIntervalMs: 0,
    })
    // Add, re-authenticate, remove, enable/disable, quotas, doctor, then
    // Connect: six steps down.
    const scripted = scriptedTerminal([...Array(6).fill(DOWN), ENTER])
    const methods = createAuthMethods({
      client: { auth: { set: async () => {} } } as never,
      getAuth: async () => ({ ...PLACEHOLDER }),
      getPaths: () => ({
        configPath: files.configFile,
        statePath: files.stateFile,
      }),
      vault,
      dependencies: {
        terminal: scripted.terminal,
        migrationBlockers: async () => [],
        // The operator approves while Connect waits.
        vaultWait: {
          pollIntervalMs: 1,
          sleep: async () => running.approve('request-1'),
        },
      },
    })
    const browser = methods[0] as {
      authorize: (inputs: Record<string, string>) => Promise<unknown>
    }
    await browser.authorize({})

    expect(running.proposals.map((proposal) => proposal.name)).toEqual([
      'openai-auth-opencode',
    ])
    const printed = scripted.written()
    expect(printed).toContain('Connect to the Claustrum vault')
    expect(printed).toContain('ck auth enroll approve --request-id request-1')
    expect(printed).toContain(
      'ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read',
    )
    expect(printed).toContain(
      'Connected: the vault approved openai-auth-opencode',
    )
    const { tokenPath } = vaultPaths(stateDir, 'opencode')
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    expect(await readClaustrumEnrollmentToken(tokenPath)).toEqual({
      token: 'ab'.repeat(32),
      token_generation: 1,
    })
    // Pi's token is its own, never written by this host.
    expect(() => statSync(vaultPaths(stateDir, 'pi').tokenPath)).toThrow()
    expect(vault.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
      'oauth:openai:work',
    ])
    vault.close()
  })
})

describe('auth account menu with vault accounts', () => {
  async function menu(keys: string[], vault: OpenAiVault) {
    const scripted = scriptedTerminal(keys)
    const methods = createAuthMethods({
      client: { auth: { set: async () => {} } } as never,
      getAuth: async () => ({ ...PLACEHOLDER }),
      getPaths: () => ({
        configPath: files.configFile,
        statePath: files.stateFile,
      }),
      vault,
      dependencies: {
        terminal: scripted.terminal,
        migrationBlockers: async () => [],
      },
    })
    await (
      methods[0] as {
        authorize: (inputs: Record<string, string>) => Promise<unknown>
      }
    ).authorize({})
    return scripted.written()
  }

  async function setup() {
    const running = await startDaemon({
      'oauth:openai:main': vaultLogin('chatgpt-main'),
      'oauth:openai:ufuk': vaultLogin('chatgpt-ufuk'),
      'oauth:openai:work': vaultLogin('chatgpt-work'),
    })
    seedPool(files, [{ id: 'main' }, { id: 'ufuk' }, { id: 'local' }])
    enroll()
    const vault = new OpenAiVault({
      host: 'opencode',
      stateDir,
      connectionFile: () => running.connectionFile,
      pollIntervalMs: 0,
    })
    await vault.refresh()
    const ufuk = vault
      .snapshot()
      ?.rows.find((row) => row.accountIdentity === 'chatgpt-ufuk')
    if (!ufuk) throw new Error('missing vault ufuk account')
    await vault.decline(ufuk.routeId)
    return { vault, running }
  }

  test('auth menu header lists vault accounts and marks shadowed local rows', async () => {
    const { vault } = await setup()
    try {
      const printed = await menu(['\u001b'], vault)
      for (const row of vault.snapshot()?.rows ?? []) {
        expect(printed).toContain(
          `Vault ${row.label}: ${row.enabled ? 'enabled' : 'declined'}`,
        )
      }
      expect(printed).toContain(
        'main: main, enabled, set aside (the vault serves this account)',
      )
      expect(printed).toContain(
        'ufuk: ufuk, enabled, set aside (the vault serves this account)',
      )
      expect(printed).toContain('local: local, enabled')
    } finally {
      vault.close()
    }
  })

  test('auth menu Check quotas polls vault accounts into roster and skips shadowed locals', async () => {
    const wire = installWire({
      usage: () => new Response(usageBody(37), { status: 200 }),
    })
    const { vault, running } = await setup()
    try {
      const gets = running.gets.length
      const beforeConfig = readJson(files.configFile)
      const beforeState = readFileSync(files.stateFile, 'utf8')
      const printed = await menu([...Array(4).fill(DOWN), ENTER], vault)
      expect(wire.polls.sort()).toEqual(
        [
          'Bearer local-token',
          `Bearer ${chatgptAccessToken('chatgpt-main')}`,
          `Bearer ${chatgptAccessToken('chatgpt-work')}`,
        ].sort(),
      )
      expect(running.gets.length - gets).toBe(2)
      for (const row of vault.snapshot()?.rows ?? []) {
        expect(printed).toContain(`Vault ${row.label}:`)
        if (row.enabled) {
          expect(row.quota?.limits).toContainEqual(
            expect.objectContaining({ usedPercent: 37 }),
          )
        } else expect(row.quota).toBeUndefined()
      }
      expect(printed).toContain('63% left')
      expect(printed).toContain(
        'quota check skipped: account is not enabled and active',
      )
      expect(readJson(files.configFile).accounts).toEqual(beforeConfig.accounts)
      expect(readFileSync(files.stateFile, 'utf8')).toBe(beforeState)
      expect(wire.refreshTokens).toEqual([])
    } finally {
      vault.close()
    }
  })

  test('auth menu Check quotas reports an unreachable vault without crashing', async () => {
    installWire()
    const { vault, running } = await setup()
    try {
      await running.stop()
      daemon = undefined
      rmSync(running.connectionFile)
      vault.close()
      const offline = new OpenAiVault({
        host: 'opencode',
        stateDir,
        connectionFile: () => running.connectionFile,
        pollIntervalMs: 0,
      })
      const printed = await menu([...Array(4).fill(DOWN), ENTER], offline)
      offline.close()
      expect(printed).toContain('Claustrum vault unreachable:')
      expect(printed).toContain('local: local, enabled')
    } finally {
      vault.close()
    }
  })
})

describe('refresh', () => {
  test('waits out a discovery already in flight and runs one that sees what changed since', async () => {
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    const vault = new OpenAiVault({
      host: 'opencode',
      stateDir,
      connectionFile: () => running.connectionFile,
      pollIntervalMs: 0,
    })
    // The poll's first roster discovery starts before this host is enrolled
    // (so it finds no accounts) and is still in flight when the enrollment
    // lands and refresh is called. Refresh must not hand back that empty
    // result.
    vault.start()
    enroll()
    await vault.refresh()

    expect(vault.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
      'oauth:openai:vault',
    ])
    expect(vault.routes()).toHaveLength(1)
    vault.close()
  })
})

describe('routing', () => {
  async function vaultServesBesideAnExhaustedMain(): Promise<Wire> {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    // The main row is exhausted, so admission sends every request to the
    // vault account whichever way the modes order the two.
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    await plugin()
    return wire
  }

  for (const mode of [
    'main-first',
    'fallback-first',
    'sticky-balanced',
  ] as const) {
    test(`a vault account serves a request in ${mode}, with one vault read per send`, async () => {
      const wire = await vaultServesBesideAnExhaustedMain()
      await setMode(mode)
      const send = await fetchOverride()
      const gets = daemon?.gets.length ?? 0

      const response = await request(send, 'session-vault')

      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])
      expect((daemon?.gets.length ?? 0) - gets).toBe(1)
    })
  }

  test('a served 401 is reported with the exact record version, and the account goes cold', async () => {
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault', { record_version: 7 }),
    })
    running.onReport = (report) => {
      const target = running.credentials[report.credential_id ?? '']
      if (target && target.record_version === report.record_version)
        target.state = 'needs_reauth'
    }
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    const unauthorized = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get('authorization')
      if (
        String(url).includes('/responses') &&
        bearer === `Bearer ${VAULT_ACCESS}`
      ) {
        wire.sends.push(bearer)
        return new Response('{}', { status: 401 })
      }
      return unauthorized(url as string, init)
    }) as typeof globalThis.fetch
    const { vault } = await plugin()
    await setMode('fallback-first')
    const send = await fetchOverride()

    await request(send)

    // The vault account was tried first and answered 401 (fallback-first
    // then tries main, whose answer the request returns).
    expect(wire.sends[0]).toBe(`Bearer ${VAULT_ACCESS}`)
    expect(running.reports).toEqual([
      {
        credential_id: 'oauth:openai:vault',
        enrollment_token: ENROLLMENT_TOKEN,
        provider_status: 401,
        record_version: 7,
        reporter_source: 'direct',
      },
    ])
    await vault.refresh()
    expect(vault.routes()).toEqual([])
    expect(vault.snapshot()?.rows[0]?.state).toBe('needs_reauth')
    const sent = wire.sends.length
    await request(send)
    expect(wire.sends.slice(sent)).not.toContain(`Bearer ${VAULT_ACCESS}`)
  })

  test('a vault account disabled in the Vault section never routes, and is never read from the vault', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    const { vault } = await plugin()
    const routeId = vault.routes()[0]?.id
    if (!routeId) throw new Error('no vault route')
    const ctx = __menuContextForTest()
    if (!ctx) throw new Error('no menu context')

    const result = await applyOpenAiMenu(ctx, {
      command: 'openai',
      sectionId: 'vault',
      itemId: routeId,
      actionId: 'disable',
    })

    expect(result.ok).toBe(true)
    expect(vault.routes()).toEqual([])
    await setMode('fallback-first')
    const send = await fetchOverride()
    const gets = daemon?.gets.length ?? 0
    const response = await request(send)
    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    expect(daemon?.gets.length).toBe(gets)
    // Still listed, and disabled.
    expect(vault.snapshot()?.rows.map((row) => row.enabled)).toEqual([false])
  })

  test('a pool row signing in as an account the vault holds is skipped: one account, one owner', async () => {
    await startDaemon({ 'oauth:openai:alpha': vaultLogin('chatgpt-alpha') })
    enroll()
    seedPool(files, [
      { id: 'main', quota: quotaMap(100) },
      { id: 'alpha', quota: quotaMap(5) },
    ])
    const wire = wireWithExhaustedMain()
    await plugin()
    await setMode('fallback-first')
    const send = await fetchOverride()

    await request(send)
    await request(send)

    expect(wire.sends).toEqual([
      `Bearer ${chatgptAccessToken('chatgpt-alpha')}`,
      `Bearer ${chatgptAccessToken('chatgpt-alpha')}`,
    ])
    expect(wire.sends).not.toContain('Bearer alpha-token')
  })

  // The pool source polls every row once when it first reads the pool. Those
  // polls must wait until the vault has read which accounts it holds, or the
  // local copy of a vault account is polled with its own token at startup.
  test('a pool row signing in as an account the vault holds is not polled at startup', async () => {
    const running = await startDaemon({
      'oauth:openai:alpha': vaultLogin('chatgpt-alpha'),
    })
    enroll()
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'alpha', quota: quotaMap(5) },
    ])
    const wire = installWire()
    // The vault's connection opens 150 ms late, so its first roster read ends
    // well after the loader's first pool read. A pool source whose first
    // polls do not wait for the roster then polls row alpha on every run,
    // instead of only on runs where its pool read happens to come first.
    hooks = await loadPlugin({
      vault: {
        stateDir,
        connectionFile: () => running.connectionFile,
        connectScoped: async () => {
          await sleep(150)
          return connectClaustrumScopedClient({
            connectionFile: running.connectionFile,
            projectRoot: dir,
            storagePath: vaultPaths(stateDir, 'opencode').tokenPath,
          })
        },
        pollIntervalMs: 0,
      },
    })

    await waitFor(
      () => (wire.polls.includes('Bearer main-token') ? true : undefined),
      'the first quota poll of row main',
    )
    // Row main reaching the wire does not prove another row's queued pull
    // finished. Drain the actual stores before asserting alpha was not polled.
    await scope.settlePluginWork()
    expect(wire.polls).not.toContain('Bearer alpha-token')
  })

  test('a vault daemon that never answers holds neither the loader nor, past a bounded wait, a pool request', async () => {
    await startDaemon({ 'oauth:openai:alpha': vaultLogin('chatgpt-alpha') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    const loading = Date.now()
    hooks = await loadPlugin({
      vault: {
        stateDir,
        // The connection is never made, so the first roster read never ends.
        connectScoped: () => new Promise(() => {}),
        pollIntervalMs: 0,
      },
    })
    const send = await fetchOverride()
    expect(Date.now() - loading).toBeLessThan(1_000)

    const sending = Date.now()
    const response = await request(send)

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    // The request's token step waited for the roster, but only up to
    // VAULT_FIRST_ROSTER_WAIT_MS (2 s).
    expect(Date.now() - sending).toBeGreaterThanOrEqual(1_900)
    expect(Date.now() - sending).toBeLessThan(4_000)
  }, 10_000)

  phaseIt(
    'a static OpenAI API key in the vault is never listed, read, routed or reported',
    async () => {
      const running = await startDaemon({
        'apikey:openai:platform': {
          payload: JSON.stringify({ access_token: 'sk-vault-platform-key' }),
          record_version: 3,
          expires_at_ms: null,
          type: 'api_key',
          refresh_adapter: null,
        },
        'oauth:openai:vault': vaultLogin('chatgpt-vault'),
      })
      enroll()
      seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
      const wire = wireWithExhaustedMain()
      // Every model request answers 401, so a key that was sent would be
      // reported to the vault.
      const recorded = globalThis.fetch
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (!String(url).includes('/responses'))
          return recorded(url as string, init)
        wire.sends.push(new Headers(init?.headers).get('authorization') ?? '')
        return new Response('{}', { status: 401 })
      }) as typeof globalThis.fetch
      const { vault } = await plugin()
      await clock.phase('routing settings lock and mtime pause', () =>
        setMode('fallback-first'),
      )
      const send = await clock.phase('second auth loader', () =>
        fetchOverride(),
      )

      await clock.phase('request including vault dispatch and 401 report', () =>
        request(send),
      )

      expect(vault.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
        'oauth:openai:vault',
      ])
      expect(vault.routes().map((route) => route.kind)).not.toContain('api-key')
      expect(running.gets.map((get) => get.credential_id)).not.toContain(
        'apikey:openai:platform',
      )
      expect(wire.sends).not.toContain('Bearer sk-vault-platform-key')
      expect(
        running.reports.map((report) => report.credential_id),
      ).not.toContain('apikey:openai:platform')
    },
  )

  test('in an ordered mode, a vault account the vault will not serve passes the request to the next account', async () => {
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    await plugin()
    await setMode('fallback-first')
    // The vault account has a quota reading, so admission puts it first; the
    // vault then refuses to serve it.
    const credential = running.credentials['oauth:openai:vault']
    if (!credential) throw new Error('no credential')
    credential.refuse = 'credential_unavailable'
    const send = await fetchOverride()
    const gets = running.gets.length

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(running.gets.slice(gets).map((get) => get.credential_id)).toContain(
      'oauth:openai:vault',
    )
    expect(wire.sends).toEqual(['Bearer main-token'])
  })

  test('in an ordered mode, a refused vault account passes the request to another vault account', async () => {
    const running = await startDaemon({
      'oauth:openai:a': vaultLogin('chatgpt-a'),
      'oauth:openai:b': vaultLogin('chatgpt-b'),
    })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    await plugin()
    await setMode('fallback-first')
    const credential = running.credentials['oauth:openai:a']
    if (!credential) throw new Error('no credential')
    credential.refuse = 'credential_unavailable'
    const send = await fetchOverride()
    const gets = running.gets.length

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(running.gets.slice(gets).map((get) => get.credential_id)).toEqual([
      'oauth:openai:a',
      'oauth:openai:b',
    ])
    expect(wire.sends).toEqual([`Bearer ${chatgptAccessToken('chatgpt-b')}`])
  })
})

describe('the host slot', () => {
  test('a real login in the slot is refused while the vault serves this host its accounts', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    const login = {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-login'),
      refresh: 'login-refresh',
      expires: Date.now() + HOUR,
    }
    await plugin(login)
    const loader = hooks?.auth?.loader
    if (!loader) throw new Error('no loader')
    const { fetch: send } = (await loader(
      (async () => ({ ...login })) as never,
      {} as never,
    )) as { fetch: typeof globalThis.fetch }

    await expect(request(send)).rejects.toThrow(
      'refusing to serve until one is removed',
    )
    expect(wire.sends).toEqual([])
  })
})

describe('what the handle-mode custody left behind', () => {
  test('tombstones and the old mode are shown by the doctor, and a tombstone is never sent or refreshed', async () => {
    await startDaemon()
    seedPool(
      files,
      [
        { id: 'main', quota: quotaMap(10) },
        { id: 'retired', quota: quotaMap(5) },
      ],
      { claustrum: { mode: 'claustrum' }, routing: { mode: 'fallback-first' } },
    )
    const state = readJson(files.stateFile) as {
      accounts: Record<string, Record<string, unknown>>
    }
    state.accounts.retired = {
      access: '',
      refresh: 'claustrum-tombstone:v1:openai',
      expires: 0,
    }
    writeFileSync(files.stateFile, JSON.stringify(state))
    const wire = installWire()
    const tombstone = {
      ...PLACEHOLDER,
      refresh: 'claustrum-tombstone:v1:openai',
    }
    await plugin(tombstone)
    const send = await fetchOverride()

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    expect(wire.refreshTokens).not.toContain('claustrum-tombstone:v1:openai')
    expect(wire.polls).not.toContain('Bearer ')

    const paths = { configPath: files.configFile, statePath: files.stateFile }
    const [check] = authDoctorChecks({
      paths,
      migrated: true,
      readAuth: async () => tombstone,
      loadAccounts,
      readStoreIds,
      mutateAccounts,
      setMainAuth: async () => {},
      now: Date.now,
    })
    const findings = (await check?.run()) ?? []
    expect(findings.map((finding) => finding.code).sort()).toEqual([
      'retired-custody-mode',
      'tombstoned-account',
      'tombstoned-host-slot',
    ])
    expect(
      findings.find((finding) => finding.code === 'tombstoned-account')
        ?.accountId,
    ).toBe('retired')
    expect(
      findings.every((finding) =>
        finding.message.includes('Connect this host to the Claustrum vault')
          ? true
          : finding.code === 'retired-custody-mode',
      ),
    ).toBe(true)
  })

  test('a tombstone in the slot is taken like the pool placeholder: the pool and the vault serve', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    const tombstone = {
      ...PLACEHOLDER,
      refresh: 'claustrum-tombstone:v1:openai',
    }
    await plugin(tombstone)
    const loader = hooks?.auth?.loader
    if (!loader) throw new Error('no loader')
    const { fetch: send } = (await loader(
      (async () => ({ ...tombstone })) as never,
      {} as never,
    )) as { fetch: typeof globalThis.fetch }

    const response = await request(send)

    expect(response.status).toBe(200)
    // Vault accounts are routed only by the request path of a migrated
    // install (the pool path); the path for a real login in the slot never
    // sends with them.
    expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])
  })

  test('a settings write drops the old custody mode from the config', async () => {
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }], {
      claustrum: { mode: 'claustrum', rowHistory: ['gone'] },
    })
    await mutateAccounts((current) => current, {
      configPath: files.configFile,
      statePath: files.stateFile,
    })
    expect(readFileSync(files.configFile, 'utf8')).not.toContain('claustrum')
  })
})
