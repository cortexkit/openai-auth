// The Claustrum vault end to end on OpenCode: the real claustrum client over
// a socket to a mock daemon (`mock-claustrum.ts` in the core tests), the
// plugin loaded on a migrated install, and a fake network for OpenAI.
//
// Enrollment through `opencode auth login`, vault mode (only the vault's
// accounts serve, in each routing mode; no local account is used, refreshed,
// polled or warmed, and the local files stay as they are), a served 401
// reported to the vault, the declined-account interlock, the vault-mode
// sidebar, and what an install still holds from the removed handle-mode
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
  VAULT_MODE_REFUSALS,
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
import type { OpenAICacheKeepManager } from '../core/cachekeep'
import { PoolAccountSource } from '../core/pool-account-source'
import { __menuContextForTest } from '../index.ts'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarState,
  hashSidebarSessionId,
  resolveSessionSidebarRouting,
  setSidebarState,
} from '../sidebar-state'
import {
  HOUR,
  installWire,
  loadPlugin,
  PLACEHOLDER,
  type PoolMode,
  quotaMap,
  readJson,
  seedPool,
  usageBody,
  type Wire,
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
import {
  FLOOR_AUTH_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env'

const ENROLLMENT_TOKEN = '01'.repeat(32)
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')

let dir: string
let files: { configFile: string; stateFile: string }
let stateDir: string
let daemon: MockDaemon | undefined
let hooks: Hooks | undefined
let originalFetch: typeof globalThis.fetch
let stopWarmCodex: (() => Promise<void>) | undefined
const scope = createRequestTestScope()
const test = scope.it
const clock = createFailurePhaseClock()
const phaseIt = (name: string, body: () => Promise<void>) =>
  scope.it(name, () => clock.run(name, body))

beforeEach(() => {
  scope.capturePluginWork({ vaultPolls: true })
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
    await stopWarmCodex?.()
    stopWarmCodex = undefined
    globalThis.fetch = originalFetch
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
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
    // In vault mode the healthy account is the other vault account; the
    // local row `main` never serves.
    test(`a vault WebSocket ${signal} signal sends the next request to a healthy account`, async () => {
      await startDaemon({
        'oauth:openai:vault': vaultLogin('chatgpt-vault'),
        'oauth:openai:other': vaultLogin('chatgpt-other'),
      })
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
            // The first account asked gets the signal.
            if (ws.data.bearer === sent[0]) {
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
        const vaultBearers: Array<string | undefined> = [
          `Bearer ${VAULT_ACCESS}`,
          `Bearer ${chatgptAccessToken('chatgpt-other')}`,
        ]
        expect(sent).toHaveLength(2)
        expect(vaultBearers).toContain(sent[0])
        expect(vaultBearers).toContain(sent[1])
        expect(sent[1]).not.toBe(sent[0])
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
    expect(message).toBe(VAULT_MODE_REFUSALS['vault-refused'])
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

describe('vault cachekeep', () => {
  async function trackedWarm(recordVersion = 7, local = false) {
    const sidebarFile = join(dir, 'sidebar.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    writeFileSync(sidebarFile, JSON.stringify(DEFAULT_SIDEBAR_STATE))
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault', {
        record_version: recordVersion,
      }),
    })
    // A local warm is captured before this host connects to the vault: in
    // vault mode no local account serves, so none is captured.
    if (!local) enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(local ? 10 : 100) }], {
      routing: { mode: local ? 'main-first' : 'sticky-balanced' },
      cachekeep: { enabled: true },
    })
    const wire = local ? installWire() : wireWithExhaustedMain()
    const network = globalThis.fetch
    const sends: Array<{ headers: Headers; body: Record<string, unknown> }> = []
    let status = 200
    let onSend: (() => void) | undefined
    const codex = Bun.serve({
      port: 0,
      async fetch(req) {
        sends.push({ headers: req.headers, body: await req.json() })
        onSend?.()
        return new Response('{}', { status })
      },
    })
    stopWarmCodex = async () => {
      await codex.stop(true)
    }
    globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
      String(url).startsWith(codex.url.origin)
        ? originalFetch(url as string, init)
        : network(url as string, init)) as typeof globalThis.fetch
    const { vault } = await plugin(PLACEHOLDER, {
      codexApiEndpoint: new URL('/responses', codex.url).href,
    })
    const send = await fetchOverride()
    const routeId = local ? 'main' : vault.routes()[0]?.id
    if (!routeId) throw new Error('no route for warm')
    const pinSession = () =>
      setSidebarState({
        ...DEFAULT_SIDEBAR_STATE,
        route: 'sticky-balanced',
        stickyAssignments: {
          [hashSidebarSessionId('vault-warm')]: {
            accountId: routeId,
            wireAccountId: 'chatgpt-vault',
            assignedAt: Date.now(),
            lastSeenAt: Date.now(),
            inputBytes: 0,
          },
        },
      })
    if (!local) await pinSession()
    const manager = __menuContextForTest()?.cacheKeepManager as
      | OpenAICacheKeepManager
      | undefined
    if (!manager) throw new Error('no cachekeep manager')
    const body = {
      model: 'gpt-5.6',
      input: [{ role: 'user', content: 'hi' }],
      store: true,
      stream: false,
      prompt_cache_key: 'vault-warm',
    }
    const response = await scope.wrap(send)(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': 'vault-warm',
        },
        body: JSON.stringify(body),
      },
    )
    await response.text()
    expect(response.status).toBe(200)
    if (!local) {
      await scope.settlePluginWork()
      // Establish the persisted binding after request bookkeeping, so these
      // tests exercise keep-warm independently of sidebar pin persistence.
      await pinSession()
      expect(
        (await getSidebarState()).stickyAssignments?.[
          hashSidebarSessionId('vault-warm')
        ]?.accountId,
      ).toBe(routeId)
    }
    expect(manager.status().targets).toHaveLength(1)
    expect(manager.status().targets[0]?.accountId).toBe(routeId)
    const target = (
      manager as unknown as {
        targets: Map<string, { cacheExpiresAt: number; ttlMs: number }>
      }
    ).targets
      .values()
      .next().value
    if (!target) throw new Error('turn was not tracked')
    expect(target.ttlMs).toBe(30 * 60 * 1000)
    const makeDue = () => {
      // Keep the real captured target and pin; only advance its deadline into
      // the lead window so the test need not wait thirty minutes.
      target.cacheExpiresAt = Date.now() + 1_000
    }
    return {
      running,
      vault,
      manager,
      wire,
      sends,
      routeId,
      makeDue,
      setStatus: (next: number) => {
        status = next
      },
      onSend: (next: () => void) => {
        onSend = next
      },
    }
  }

  test('a pinned vault warm authorizes each replay and reaches Codex with the served token', async () => {
    const { running, manager, sends, makeDue } = await trackedWarm()
    const gets = running.gets.length
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(2)
    expect(running.gets.length - gets).toBe(1)
    expect(sends[1]?.headers.get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    expect(sends[1]?.headers.get('session-id')).toBe(
      sends[0]?.headers.get('session-id'),
    )
    expect(sends[1]?.headers.get('chatgpt-account-id')).toBe('chatgpt-vault')
    expect(sends[1]?.body).toEqual({ ...sends[0]?.body, store: false })
    expect(manager.status().targets[0]?.lastWarmedAt).toBeNumber()

    const newer = chatgptAccessToken('chatgpt-vault', 'new-warm')
    running.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-vault', {
      payload: JSON.stringify({ access_token: newer }),
      record_version: 8,
    })
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(3)
    expect(running.gets.length - gets).toBe(2)
    expect(sends[2]?.headers.get('authorization')).toBe(`Bearer ${newer}`)
    expect(running.reports).toEqual([])
  })

  for (const refusal of [
    'cold',
    'declined',
    'refused',
    'unreachable',
  ] as const) {
    test(`a ${refusal} vault warm backs off without a provider report`, async () => {
      const { running, vault, manager, sends, makeDue, routeId } =
        await trackedWarm()
      if (refusal === 'cold') {
        running.credentials['oauth:openai:vault']!.state = 'needs_reauth'
        await vault.refresh()
      } else if (refusal === 'declined') {
        if (!routeId) throw new Error('no vault route')
        await vault.decline(routeId)
      } else if (refusal === 'refused') {
        running.credentials['oauth:openai:vault']!.refuse =
          'credential_unavailable'
      } else {
        await running.stop()
      }
      const gets = running.gets.length
      makeDue()
      await manager.tick()
      expect(sends).toHaveLength(1)
      expect(running.reports).toEqual([])
      const target = manager.status().targets[0]
      expect(target?.lastWarmedAt).toBeUndefined()
      expect(target?.backoffUntil).toBeGreaterThan(Date.now())
      if (refusal === 'cold' || refusal === 'declined')
        expect(running.gets.length).toBe(gets)
      const backedOffGets = running.gets.length
      await manager.tick()
      expect(running.gets.length).toBe(backedOffGets)
      expect(sends).toHaveLength(1)
    })
  }

  test('a warm 401 reports the served record version once and backs off', async () => {
    const { running, manager, sends, makeDue, setStatus } = await trackedWarm(7)
    const gets = running.gets.length
    setStatus(401)
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(2)
    expect(running.reports).toEqual([
      {
        credential_id: 'oauth:openai:vault',
        enrollment_token: ENROLLMENT_TOKEN,
        provider_status: 401,
        record_version: 7,
        reporter_source: 'direct',
      },
    ])
    expect(running.gets.length - gets).toBe(2)
    expect(manager.status().targets[0]?.backoffUntil).toBeGreaterThan(
      Date.now(),
    )
  })

  test('a refused newer credential reports only the version actually served to the warm', async () => {
    const { running, manager, sends, makeDue, setStatus, onSend } =
      await trackedWarm(7)
    onSend(() => {
      running.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-vault', {
        record_version: 8,
        refuse: 'credential_unavailable',
      })
    })
    setStatus(401)
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(2)
    expect(running.reports.map((report) => report.record_version)).toEqual([7])
    expect(manager.status().targets[0]?.backoffUntil).toBeGreaterThan(
      Date.now(),
    )
  })

  for (const status of [403, 429, 500]) {
    test(`a vault warm ${status} backs off without a provider report`, async () => {
      const { running, manager, sends, makeDue, setStatus } =
        await trackedWarm()
      const gets = running.gets.length
      setStatus(status)
      makeDue()
      await manager.tick()
      expect(sends).toHaveLength(2)
      expect(running.gets.length - gets).toBe(1)
      expect(running.reports).toEqual([])
      expect(manager.status().targets[0]?.backoffUntil).toBeGreaterThan(
        Date.now(),
      )
    })
  }

  test('a warm 401 retries a newer served version and reports only the final credential', async () => {
    const { running, manager, sends, makeDue, setStatus, onSend } =
      await trackedWarm(7)
    const gets = running.gets.length
    const newer = chatgptAccessToken('chatgpt-vault', 'retry-warm')
    onSend(() => {
      running.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-vault', {
        payload: JSON.stringify({ access_token: newer }),
        record_version: 8,
      })
    })
    setStatus(401)
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(3)
    expect(running.gets.length - gets).toBe(2)
    expect(sends[1]?.headers.get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    expect(sends[2]?.headers.get('authorization')).toBe(`Bearer ${newer}`)
    expect(sends[2]?.body).toEqual(sends[1]?.body)
    expect(sends[2]?.headers.get('session-id')).toBe(
      sends[1]?.headers.get('session-id'),
    )
    expect(running.reports.map((report) => report.record_version)).toEqual([8])
    expect(manager.status().targets[0]?.backoffUntil).toBeGreaterThan(
      Date.now(),
    )
  })

  test('a warm 401 recovered by a newer served version sends no failure report', async () => {
    const { running, manager, sends, makeDue, setStatus, onSend } =
      await trackedWarm(7)
    setStatus(401)
    onSend(() => {
      if (sends.length === 3) setStatus(200)
      running.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-vault', {
        record_version: 8,
      })
    })
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(3)
    expect(running.reports).toEqual([])
    expect(manager.status().targets[0]?.lastWarmedAt).toBeNumber()
    expect(manager.status().targets[0]?.backoffUntil).toBeUndefined()
  })

  test('a moved vault pin drops the target without authorizing a warm', async () => {
    const { running, manager, sends, makeDue } = await trackedWarm()
    const gets = running.gets.length
    await scope.settlePluginWork()
    const state = await getSidebarState()
    const hash = hashSidebarSessionId('vault-warm')
    const pin = state.stickyAssignments?.[hash]
    if (!pin) throw new Error('no sticky pin')
    await setSidebarState({
      ...state,
      stickyAssignments: {
        ...state.stickyAssignments,
        [hash]: { ...pin, accountId: 'main' },
      },
    })
    await Bun.sleep(5)
    makeDue()
    await manager.tick()
    expect(manager.status().tracked).toBe(0)
    expect(sends).toHaveLength(1)
    expect(running.gets.length).toBe(gets)
    expect(running.reports).toEqual([])
  })

  test('a local pool warm keeps its bearer and never reports its 401 to the vault', async () => {
    const { running, manager, sends, makeDue, setStatus, wire } =
      await trackedWarm(7, true)
    const gets = running.gets.length
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(2)
    expect(sends[1]?.headers.get('authorization')).toBe('Bearer main-token')
    expect(sends[1]?.headers.get('chatgpt-account-id')).toBe('chatgpt-main')
    expect(sends[1]?.body).toEqual({ ...sends[0]?.body, store: false })
    setStatus(401)
    makeDue()
    await manager.tick()
    expect(sends).toHaveLength(3)
    expect(running.gets.length).toBe(gets)
    expect(running.reports).toEqual([])
    expect(wire.refreshTokens).toEqual([])
    expect(manager.status().targets[0]?.backoffUntil).toBeGreaterThan(
      Date.now(),
    )
  })

  test('in vault mode a local target captured before connecting is never warmed: nothing is sent or refreshed', async () => {
    const { running, manager, sends, makeDue, wire } = await trackedWarm(
      7,
      true,
    )
    enroll()
    const gets = running.gets.length
    // No local token is even looked up for the warm.
    const access = spyOn(PoolAccountSource.prototype, 'accessFor')
    makeDue()
    try {
      await manager.tick()
      expect(access).not.toHaveBeenCalled()
    } finally {
      access.mockRestore()
    }
    expect(sends).toHaveLength(1)
    expect(wire.refreshTokens).toEqual([])
    expect(running.gets.length).toBe(gets)
    expect(running.reports).toEqual([])
    expect(manager.status().targets[0]?.backoffUntil).toBeGreaterThan(
      Date.now(),
    )
  })
})

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
const LOCAL_NOTE =
  'Local accounts are not used while this host is connected to the vault.'
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
  test('reset preview spend and retry refuse shadowed live and expired local credentials without refreshing or sending', async () => {
    await startDaemon({
      'oauth:openai:main': vaultLogin('chatgpt-main'),
      'oauth:openai:ufuk': vaultLogin('chatgpt-ufuk'),
    })
    seedPool(files, [
      { id: 'main', expires: Date.now() - 1 },
      { id: 'ufuk', expires: Date.now() + 3600_000 },
    ])
    enroll()
    const wire = installWire()
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const startupFinished = Promise.withResolvers<void>()
    const pollQuota = OpenAiVault.prototype.pollQuota
    let calls = 0
    // The lease's startup quota pass has polled one vault route and is about
    // to poll the second. Hold that poll until loader setup finishes.
    const pollSpy = spyOn(
      OpenAiVault.prototype,
      'pollQuota',
    ).mockImplementation(async function (this: OpenAiVault, routeId) {
      if (++calls !== 2) return pollQuota.call(this, routeId)
      held.resolve()
      await release.promise
      try {
        return await pollQuota.call(this, routeId)
      } finally {
        startupFinished.resolve()
      }
    })
    try {
      hooks = await loadPlugin({
        vault: {
          stateDir,
          connectionFile: () => daemon!.connectionFile,
          pollIntervalMs: 0,
        },
      })
      await held.promise
      const vault = __menuContextForTest()!.vault!
      await vault.refresh()
      await vault.pollStale(0)
      setImmediate(() => release.resolve())
      // Reset refusal is not a test of the lease's automatic startup quota pass.
      // Drain it before recording the no-network baseline, not after actions.
      await scope.settlePluginWork()
      const polls = wire.polls.length
      const state = readFileSync(files.stateFile, 'utf8')
      for (const id of ['main', 'ufuk']) {
        for (const actionId of ['preview', 'spend', 'retry']) {
          const result = await applyOpenAiMenu(__menuContextForTest()!, {
            command: 'openai',
            sectionId: 'reset',
            itemId: id,
            actionId,
            confirmed: true,
          })
          expect(result.ok).toBe(false)
          expect(result.text).toMatch(
            /no usable access token|token is unavailable/,
          )
        }
      }
      await startupFinished.promise
      expect(wire.refreshTokens).toEqual([])
      expect(wire.polls.length).toBe(polls)
      expect(readFileSync(files.stateFile, 'utf8')).toBe(state)
      vault.close()
    } finally {
      release.resolve()
      await scope.settlePluginWork()
      pollSpy.mockRestore()
    }
  })

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

  test('auth menu header in vault mode lists only vault accounts, with no local row', async () => {
    const { vault } = await setup()
    try {
      const printed = await menu(['\u001b'], vault)
      for (const row of vault.snapshot()?.rows ?? []) {
        expect(printed).toContain(
          `Vault ${row.label}: ${row.enabled ? 'enabled' : 'declined'}`,
        )
      }
      expect(printed).toContain(LOCAL_NOTE)
      expect(printed).not.toContain('main: main')
      expect(printed).not.toContain('ufuk: ufuk')
      expect(printed).not.toContain('local: local')
      expect(printed).not.toContain('set aside')
    } finally {
      vault.close()
    }
  })

  test('auth menu Check quotas in vault mode polls only vault accounts and no local row', async () => {
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
          `Bearer ${chatgptAccessToken('chatgpt-main')}`,
          `Bearer ${chatgptAccessToken('chatgpt-work')}`,
        ].sort(),
      )
      expect(printed).not.toContain('local: local')
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
      // Still vault mode: the local rows are neither listed nor polled.
      expect(printed).toContain(LOCAL_NOTE)
      expect(printed).not.toContain('local: local')
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

    // The vault account answered 401. In vault mode no local row is tried
    // after it, so its answer is the request's.
    expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])
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

  test('a vault account disabled in the Vault section never routes, and is never read from the vault; no local row serves in its place', async () => {
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
    expect(response.status).toBe(401)
    expect(await response.text()).toBe(VAULT_MODE_REFUSALS['vault-empty'])
    expect(wire.sends).toEqual([])
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

  // The pool source polls every row once when it first reads the pool. In
  // vault mode it polls none, not even while the vault's first account list
  // is still on its way.
  test('in vault mode no pool row is polled at startup, whether or not the vault holds its account', async () => {
    const running = await startDaemon({
      'oauth:openai:alpha': vaultLogin('chatgpt-alpha'),
    })
    const priorDir = join(dir, 'prior-loader')
    mkdirSync(priorDir)
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(priorDir, 'auth.json')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(priorDir, 'state.json')
    writeFileSync(
      process.env.OPENCODE_OPENAI_AUTH_FILE,
      JSON.stringify({ version: 1, accounts: [] }),
    )
    const retry = Promise.withResolvers<() => void>()
    const priorScope = createRequestTestScope()
    const prior = priorScope.ownPlugin(
      await loadPlugin({
        vault: { stateDir: join(priorDir, 'vault'), pollIntervalMs: 0 },
        poolMigration: {
          fence: async () => ({ open: true }),
          migrate: async () => ({ status: 'retry', reason: 'lock-contention' }),
          timers: {
            set: (run) => {
              retry.resolve(run)
              return run
            },
            clear: () => {},
          },
        },
      }),
    )
    const retryPrior = await retry.promise
    await scope.settlePluginWork()
    // A loader left alive by another fixture follows the next fixture's paths
    // on its migration retry. Stop it before changing either paths or fetch.
    await priorScope.teardown(async () => {})
    process.env.OPENCODE_OPENAI_AUTH_FILE = files.configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = files.stateFile
    const roster = Promise.withResolvers<void>()
    enroll()
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'alpha', quota: quotaMap(5) },
    ])
    const wire = installWire()
    // Keep this loader's roster pending while the saved predecessor retry fires.
    // A disposed predecessor must ignore even a callback queued before disposal.
    hooks = await loadPlugin({
      vault: {
        stateDir,
        connectionFile: () => running.connectionFile,
        connectScoped: async () => {
          await roster.promise
          return connectClaustrumScopedClient({
            connectionFile: running.connectionFile,
            projectRoot: dir,
            storagePath: vaultPaths(stateDir, 'opencode').tokenPath,
          })
        },
        pollIntervalMs: 0,
      },
    })

    retryPrior()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await scope.settlePluginWork()
    roster.resolve()
    await __menuContextForTest()?.vault?.firstRoster()
    await scope.settlePluginWork()
    await prior.dispose?.()
    expect(wire.polls).not.toContain('Bearer alpha-token')
    expect(wire.polls).not.toContain('Bearer main-token')
  })

  test('a vault daemon that never answers holds neither the loader nor, past a bounded wait, a request, which is refused with nothing sent or refreshed', async () => {
    await startDaemon({ 'oauth:openai:alpha': vaultLogin('chatgpt-alpha') })
    enroll()
    // The local main row's token has run out: a local refresh would show.
    seedPool(files, [
      { id: 'main', quota: quotaMap(10), expires: Date.now() - HOUR },
    ])
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

    expect(response.status).toBe(401)
    expect(await response.text()).toBe(VAULT_MODE_REFUSALS['vault-unreachable'])
    expect(wire.sends).toEqual([])
    // Only this test's local row is checked: a loader another test left
    // running may still poll its own accounts through the shared fetch.
    expect(wire.refreshTokens).not.toContain('main-refresh')
    expect(wire.polls).not.toContain('Bearer main-token')
    // The request waited for the vault's first account list, but only up to
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

  test('in vault mode a vault account the vault will not serve is not replaced by a local row: the request is refused', async () => {
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

    expect(response.status).toBe(401)
    expect(await response.text()).toBe(VAULT_MODE_REFUSALS['vault-refused'])
    expect(running.gets.slice(gets).map((get) => get.credential_id)).toContain(
      'oauth:openai:vault',
    )
    expect(wire.sends).toEqual([])
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

describe('vault mode', () => {
  test('a vault-mode session makes no local refresh or poll, serves only from the vault, and leaves the local files byte-identical', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    // Two local rows the vault does not hold, both with run-out tokens: a
    // local refresh or poll would show on the wire. Fallback-first would put
    // `spare` first if it could route.
    seedPool(
      files,
      [
        { id: 'main', quota: quotaMap(10), expires: Date.now() - HOUR },
        { id: 'spare', quota: quotaMap(5), expires: Date.now() - HOUR },
      ],
      { routing: { mode: 'fallback-first' } },
    )
    const config = readFileSync(files.configFile, 'utf8')
    const state = readFileSync(files.stateFile, 'utf8')
    const wire = installWire()
    await plugin()
    const send = await fetchOverride()

    for (const session of ['vault-mode', undefined, 'vault-mode']) {
      const response = await request(send, session)
      expect(response.status).toBe(200)
    }
    const ctx = __menuContextForTest()
    if (!ctx) throw new Error('no menu context')
    const checked = await applyOpenAiMenu(ctx, {
      command: 'openai',
      sectionId: 'quota',
      actionId: 'check',
      values: { account: '*' },
    })
    expect(checked.ok).toBe(true)
    await scope.settlePluginWork()

    expect(wire.sends).toEqual(Array(3).fill(`Bearer ${VAULT_ACCESS}`))
    expect(wire.refreshTokens).toEqual([])
    // The quota check polled the vault account, and no local row.
    expect(wire.polls).toContain(`Bearer ${VAULT_ACCESS}`)
    expect(wire.polls).not.toContain('Bearer main-token')
    expect(wire.polls).not.toContain('Bearer spare-token')
    expect(readFileSync(files.configFile, 'utf8')).toBe(config)
    expect(readFileSync(files.stateFile, 'utf8')).toBe(state)
  })

  test('the sidebar file in vault mode lists the vault accounts and no local row, with the serving one active', async () => {
    const sidebarFile = join(dir, 'sidebar.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'spare', quota: quotaMap(5) },
    ])
    installWire()
    const { vault } = await plugin()
    const send = await fetchOverride()
    expect((await request(send, 'sidebar-session')).status).toBe(200)
    await scope.settlePluginWork()
    const route = vault.routes()[0]
    const row = vault.snapshot()?.rows[0]
    if (!route || !row) throw new Error('no vault account')

    const stateNow = await getSidebarState(sidebarFile)

    expect(stateNow.vaultAccounts?.map((account) => account.id)).toEqual([
      route.id,
    ])
    expect(stateNow.vaultAccounts?.[0]?.label).toBe(row.email || row.label)
    expect(stateNow.vaultAccounts?.[0]?.quota).not.toBeNull()
    // The fields an older sidebar reads carry no local account.
    expect(stateNow.fallbacks).toEqual([])
    expect(stateNow.main.quota).toBeNull()
    expect(stateNow.main.mainAccountId).toBeUndefined()
    expect(JSON.stringify(stateNow)).not.toContain('chatgpt-spare')
    expect(
      resolveSessionSidebarRouting(stateNow, 'sidebar-session').activeId,
    ).toBe(route.id)
  })

  test('disconnecting from the vault restores local routing at once', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    const { vault } = await plugin()
    const send = await fetchOverride()
    await request(send)
    expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])

    await vault.disconnect()
    const response = await request(send)

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`, 'Bearer main-token'])
  })
})

describe('the host slot', () => {
  // OpenCode's slot is not a candidate in vault mode: a real login there is
  // neither sent with, refreshed nor allowed to refuse the request.
  test('in vault mode a real login in the slot is ignored and the vault serves', async () => {
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

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])
    expect(wire.refreshTokens).toEqual([])
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
    // In vault mode only the vault's accounts serve.
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
