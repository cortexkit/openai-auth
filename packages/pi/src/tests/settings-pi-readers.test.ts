import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { moveSettingsOnce, openSettings } from '@cortexkit/common-auth/settings'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  getKillswitchThresholdsForAccount,
  OpenAiVault,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import {
  mapSettings,
  readSettingsSource,
} from '@cortexkit/openai-auth-core/settings-map'
import { createBuiltinSettingsPort } from '@cortexkit/openai-auth-core/settings-port'
import {
  createSettingsSnapshot,
  type OpenAiSettingsHandle,
  type SettingsSnapshot,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import {
  type Api,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { chatgptAccessToken } from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { createPiOpenAIRuntime } from '../index.ts'
import {
  type RouteAccount,
  routablePoolRows,
  routePiRequest,
} from '../pool-request.ts'
import { PiOpenAIRuntime } from '../runtime.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()

const log = { warn() {}, info() {} }
const model: Model<Api> = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 272000,
  maxTokens: 128000,
}
const mainToken = chatgptAccessToken('settings-main')
const poolToken = chatgptAccessToken('settings-pool')
let root: string
let paths: AccountPaths
let file: string
let snapshots: SettingsSnapshot[]
let runtimes: PiOpenAIRuntime[]
let sends: string[]
let status: (token: string) => number
let onSend: (() => Promise<void>) | undefined
let quotaUsed: number
let refreshes: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-settings-readers-'))
  paths = {
    configPath: join(root, 'pi.json'),
    statePath: join(root, 'pi-state.json'),
  }
  file = join(root, 'settings.jsonc')
  snapshots = []
  runtimes = []
  sends = []
  status = () => 200
  onSend = undefined
  quotaUsed = 10
  refreshes = 0
})
afterEach(async () => {
  for (const snapshot of snapshots) snapshot.dispose()
  for (const runtime of runtimes)
    await Promise.all([runtime.pool.dispose(), runtime.vault.dispose()])
  rmSync(root, { recursive: true, force: true })
})

function write(values: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify({ version: 1, ...values }))
}

async function snapshot(watch = false) {
  const real = openSettings(openaiSettings, {
    file,
    log,
    separateInstall: false,
    createMissing: true,
  })
  let reads = 0
  let watched = () => {}
  const handle: OpenAiSettingsHandle = {
    ...real,
    read: (...args) => {
      reads++
      return real.read(...args)
    },
    get: (...args) => {
      reads++
      return real.get(...args)
    },
    watch: watch
      ? real.watch
      : (callback) => {
          watched = callback
          return () => {}
        },
  }
  const value = await createSettingsSnapshot({ handle, file, host: 'pi' })
  snapshots.push(value)
  return { value, reads: () => reads, fire: () => watched() }
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.endsWith('/oauth/token')) {
    refreshes++
    return Response.json({
      access_token: poolToken,
      refresh_token: 'new-pool-refresh',
      expires_in: 864000,
    })
  }
  if (url.endsWith('/wham/usage'))
    return Response.json({
      rate_limit: {
        primary_window: {
          used_percent: quotaUsed,
          limit_window_seconds: 18000,
          reset_at: Math.floor(Date.now() / 1000) + 7200,
        },
      },
    })
  const token =
    new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ??
    ''
  sends.push(token)
  const next = onSend
  onSend = undefined
  await next?.()
  const code = status(token)
  if (code !== 200)
    return Response.json(
      { error: { message: 'try another account' } },
      { status: code },
    )
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'settings-response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}) as typeof fetch

function runtime(settings?: SettingsSnapshot) {
  const value = new PiOpenAIRuntime({
    paths: () => paths,
    settings,
    streamSimple,
    createStream: createAssistantMessageEventStream,
    fetchImpl: fakeFetch,
    firstReadingWaitMs: 0,
    vault: new OpenAiVault({
      host: 'pi',
      stateDir: vaultStateDir(paths.statePath),
      connectionFile: () => join(root, 'no-vault.json'),
      pollIntervalMs: 0,
    }),
  })
  runtimes.push(value)
  return value
}

async function ready(
  value: PiOpenAIRuntime,
  pool = true,
  expires = Date.now() + 864000000,
) {
  if (pool)
    await openPoolStore({
      provider: 'openai',
      ...paths,
      quota: quotaCodec,
    }).add({
      id: 'work',
      identity: 'settings-pool',
      credential: {
        type: 'oauth',
        access: poolToken,
        refresh: 'pool-refresh',
        expires,
      },
    })
  await value.start()
  await value.pool.settled()
  value.main.observeToken(mainToken)
  await value.main.pending()
}

async function send(value: PiOpenAIRuntime) {
  const events: AssistantMessageEvent[] = []
  for await (const event of value.stream(
    model,
    { messages: [] },
    { apiKey: mainToken, fetch: fakeFetch, transport: 'sse' },
  ))
    events.push(event)
  return events
}

// Inspect the two distinct boundaries without using the resolved view as a store probe.
function readers(value: PiOpenAIRuntime) {
  return value as unknown as {
    storage(): Promise<AccountStorage | null>
    settings(store: AccountStorage | null): AccountStorage
    accounts(settings: AccountStorage): RouteAccount[]
  }
}

async function move(
  stores: Partial<Record<'opencode' | 'pi', Record<string, unknown>>>,
) {
  const sources = (['opencode', 'pi'] as const).map((host) => {
    const path = host === 'pi' ? paths.configPath : join(root, 'opencode.json')
    if (stores[host])
      writeFileSync(
        path,
        JSON.stringify({ version: 1, accounts: [], ...stores[host] }),
      )
    return { host, path, locks: [], read: readSettingsSource }
  })
  const result = await moveSettingsOnce({
    definition: openaiSettings,
    target: file,
    separateInstall: false,
    sources,
    map: mapSettings,
    fence: () => true,
    log,
  })
  expect(result.outcome).toBe('moved')
  expect(result.differing).toEqual([])
}

test('shared Pi uses its menu snapshot on the next request without settings I/O or a watcher', async () => {
  write({ routing_mode: 'fallback-first' })
  const state = await snapshot()
  const value = runtime(state.value)
  await ready(value)
  await value.pool.poolStore().updateSettings((settings) => {
    settings.routing = { mode: 'main-first' }
  })
  const reads = state.reads()
  await send(value)
  expect(sends).toEqual([poolToken])
  expect(state.reads()).toBe(reads)
  const port = createBuiltinSettingsPort({
    file,
    host: 'pi',
    snapshot: state.value,
    log,
  })
  await port.update((settings) => {
    settings.routing = { mode: 'main-first', maxSameAccountWait: 0 }
  })
  const afterMenu = state.reads()
  sends = []
  await send(value)
  expect(sends).toEqual([mainToken])
  expect(state.reads()).toBe(afterMenu)
  expect(
    readers(value).settings(await readers(value).storage()).routing
      ?.maxSameAccountWait,
  ).toBe(0)
})

test('Pi extension factory threads the startup snapshot into the runtime', async () => {
  write({ routing_mode: 'fallback-first' })
  const state = await snapshot()
  const value = createPiOpenAIRuntime(paths, state.value)
  runtimes.push(value)
  expect(readers(value).settings(null).routing?.mode).toBe('fallback-first')
})

test('request captures fallback statuses until its next route, even when the snapshot changes mid-attempt', async () => {
  write({ routing_mode: 'main-first', fallback_on: [500] })
  const state = await snapshot()
  const value = runtime(state.value)
  await ready(value)
  status = (token) => (token === mainToken ? 500 : 200)
  onSend = async () => {
    write({ routing_mode: 'main-first', fallback_on: [403] })
    await state.value.refresh()
  }
  await send(value)
  expect(sends).toEqual([mainToken, poolToken])
  sends = []
  await send(value)
  expect(sends).toEqual([mainToken])
})

for (const owner of ['opencode', 'pi'] as const) {
  test(`both stores present: preferences set only in ${owner} preserve Pi's own effective values`, async () => {
    const preferences = {
      routing: { mode: 'sticky-balanced', maxSameAccountWait: 'max' },
      fallbackOn: [500],
      refresh: { refreshBeforeExpiryMinutes: 300 },
      quota: {
        enabled: false,
        checkIntervalMinutes: 7,
        minimumRemaining: { primary: 33 },
        failClosedOnUnknownQuota: true,
      },
      killswitch: {
        schema: 'floors-v1',
        enabled: true,
        defaults: { primary: 12, secondary: 23 },
      },
    }
    await move({
      opencode: owner === 'opencode' ? preferences : {},
      pi: owner === 'pi' ? preferences : {},
    })
    const state = await snapshot()
    const value = runtime(state.value)
    const settings = readers(value).settings(await readers(value).storage())
    expect(settings.routing).toEqual(
      owner === 'pi'
        ? { mode: 'sticky-balanced', maxSameAccountWait: 'max' }
        : { mode: 'main-first', maxSameAccountWait: 15 },
    )
    expect(settings.fallbackOn).toEqual(
      owner === 'pi' ? [500] : [401, 403, 429],
    )
    expect(settings.refresh?.refreshBeforeExpiryMinutes).toBe(
      owner === 'pi' ? 300 : 240,
    )
    expect(settings.quota?.enabled).toBe(owner !== 'pi')
    expect(settings.quota?.minimumRemaining).toEqual(
      owner === 'pi' ? { primary: 33 } : {},
    )
    expect(settings.quota?.failClosedOnUnknownQuota).toBe(owner === 'pi')
    expect(settings.killswitch?.enabled).toBe(owner === 'pi')
    expect(getKillswitchThresholdsForAccount(settings)).toEqual(
      owner === 'pi'
        ? { primary: 12, secondary: 23 }
        : { primary: 5, secondary: 10 },
    )
  })
}

test('vault-only Pi inherits shared routing and killswitch, but no other-host account floor', async () => {
  await move({
    opencode: {
      routing: { mode: 'sticky-balanced' },
      killswitch: {
        schema: 'floors-v1',
        enabled: true,
        defaults: { primary: 5, secondary: 10 },
        accounts: {
          main: { primary: 80, secondary: 90 },
          local: { primary: 70, secondary: 80 },
          'vault:one': { primary: 60, secondary: 70 },
        },
      },
    },
  })
  const state = await snapshot()
  const value = runtime(state.value)
  expect(await readers(value).storage()).toBeNull()
  const settings = readers(value).settings(null)
  expect(settings).not.toBeNull()
  expect(settings.routing?.mode).toBe('sticky-balanced')
  expect(settings.killswitch?.enabled).toBe(true)
  expect(settings.killswitch?.accounts).toEqual({})
  for (const id of [undefined, 'local', 'vault:one'])
    expect(getKillswitchThresholdsForAccount(settings, id)).toEqual({
      primary: 5,
      secondary: 10,
    })
  let placements = 0
  const account = {
    id: 'vault:one',
    token: undefined,
    vault: true as const,
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          usedPercent: 10,
          windowMinutes: 300,
          checkedAt: Date.now(),
          resetsAt: new Date(Date.now() + 7200000).toISOString(),
        },
      ],
    },
  }
  const result = await routePiRequest({
    storage: settings,
    mode: 'sticky-balanced',
    accounts: () => [account],
    now: Date.now,
    sessionId: 'vault-only',
    requestBytes: 1,
    refreshBackoff: () => new Map(),
    requestPull() {},
    firstReadingWaitMs: 0,
    placePin: () => {
      placements++
      return { accountId: account.id }
    },
    send: async () => ({ status: 200 }),
  })
  expect(result.kind).toBe('sent')
  expect(placements).toBeGreaterThan(0)
  expect(existsSync(paths.configPath)).toBe(false)
  expect(existsSync(paths.statePath)).toBe(false)
})

test('Pi floors keep separate main entries, accept both, and prefer pi regardless of list order', async () => {
  write({
    killswitch_enabled: true,
    killswitch_account_floors: [
      { account: 'main', host: 'opencode', primary: 90, secondary: 91 },
      { account: 'main', host: 'pi', primary: 20, secondary: 21 },
      { account: 'vault:one', host: 'pi', primary: 30, secondary: 31 },
      { account: 'vault:one', host: 'both', primary: 40, secondary: 41 },
      { account: 'vault:two', host: 'both', primary: 50, secondary: 51 },
      { account: 'vault:other', host: 'opencode', primary: 60, secondary: 61 },
    ],
  })
  const state = await snapshot()
  const settings = readers(runtime(state.value)).settings(null)
  expect(getKillswitchThresholdsForAccount(settings)).toEqual({
    primary: 20,
    secondary: 21,
  })
  expect(getKillswitchThresholdsForAccount(settings, 'vault:one')).toEqual({
    primary: 30,
    secondary: 31,
  })
  expect(getKillswitchThresholdsForAccount(settings, 'vault:two')).toEqual({
    primary: 50,
    secondary: 51,
  })
  expect(getKillswitchThresholdsForAccount(settings, 'vault:other')).toEqual({
    primary: 5,
    secondary: 10,
  })
})

for (const broken of ['schema', 'duplicate', 'unreadable'] as const) {
  test(`Pi retains applied floors across a ${broken} refresh and later requests`, async () => {
    write({
      killswitch_enabled: true,
      killswitch_account_floors: [
        { account: 'main', host: 'pi', primary: 95, secondary: 0 },
      ],
    })
    const state = await snapshot()
    const value = runtime(state.value)
    await ready(value, false)
    await send(value)
    expect(sends).toEqual([])
    const entry = { account: 'main', host: 'pi', primary: 0, secondary: 0 }
    if (broken === 'unreadable') writeFileSync(file, '{ broken')
    else
      write({
        killswitch_enabled: true,
        killswitch_account_floors:
          broken === 'duplicate'
            ? [entry, { ...entry, primary: 10 }]
            : [{ account: 'main', host: 'pi', primary: 0 }],
      })
    await state.value.refresh()
    await send(value)
    await state.value.refresh()
    await send(value)
    expect(sends).toEqual([])
    expect(
      getKillswitchThresholdsForAccount(readers(value).settings(null)).primary,
    ).toBe(95)
    expect(state.value.report().length).toBeGreaterThan(0)
  })
}

test('Pi starts an unusable floors list on defaults for every account, never its valid entries alone', async () => {
  write({
    killswitch_enabled: true,
    killswitch_account_floors: [
      { account: 'main', host: 'pi', primary: 95, secondary: 0 },
      { account: 'work', host: 'pi', primary: 95 },
    ],
  })
  const state = await snapshot()
  const value = runtime(state.value)
  await ready(value)
  const settings = readers(value).settings(await readers(value).storage())
  for (const id of [undefined, 'work', 'vault:one'])
    expect(getKillswitchThresholdsForAccount(settings, id)).toEqual({
      primary: 5,
      secondary: 10,
    })
  await send(value)
  expect(sends).toEqual([mainToken])
})

for (const decision of ['legacy', 'separate'] as const) {
  test(`${decision} Pi keeps its old preferences and whole-store writer`, async () => {
    write({ routing_mode: 'main-first' })
    const value = runtime()
    await ready(value)
    await value.pool.poolStore().updateSettings((settings) => {
      settings.routing = { mode: 'fallback-first' }
    })
    const before = readFileSync(file, 'utf8')
    await send(value)
    expect(sends).toEqual([poolToken])
    expect((await readers(value).storage())?.routing?.mode).toBe(
      'fallback-first',
    )
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
}

test('missing store remains absent for runtime, routing and pool readers with a non-null settings view', async () => {
  write({
    routing_mode: 'fallback-first',
    refresh_before_expiry_minutes: 300,
    quota_fail_closed_on_unknown: true,
    killswitch_enabled: true,
  })
  const state = await snapshot()
  const value = runtime(state.value)
  await ready(value, false)
  expect(await readers(value).storage()).toBeNull()
  const settings = readers(value).settings(null)
  expect(settings).not.toBeNull()
  expect(value.pool.peek()).toEqual({ active: true, rows: [] })
  expect(await value.pool.pollRows(settings)).toEqual([])
  await send(value)
  expect(sends).toEqual([mainToken])
  expect(await readers(value).storage()).toBeNull()
  expect(existsSync(paths.configPath)).toBe(false)
  expect(existsSync(paths.statePath)).toBe(false)
})

test('watch callback publishes live Pi preferences; refresh window is checked at request and quota-command time', async () => {
  write({ routing_mode: 'fallback-first', refresh_before_expiry_minutes: 60 })
  const state = await snapshot(true)
  const value = runtime(state.value)
  await ready(value, true, Date.now() + 120 * 60000)
  await send(value)
  await value.pool.settled()
  expect(refreshes).toBe(0)
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout>
  const changed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('settings watcher did not publish the edit')),
      3000,
    )
    unsubscribe = state.value.onChange(() => {
      if (state.value.view().routing?.maxSameAccountWait === 'max') resolve()
    })
  })
  write({
    routing_mode: 'fallback-first',
    max_same_account_wait: 'cache',
    fallback_on: [500],
    refresh_before_expiry_minutes: 300,
    quota_enabled: true,
    quota_check_interval_minutes: 3,
    quota_minimum_remaining: [{ window: 'primary', floor: 95 }],
    quota_fail_closed_on_unknown: true,
    killswitch_enabled: true,
    killswitch_default_primary: 12,
    killswitch_default_secondary: 23,
    killswitch_account_floors: [
      { account: 'main', host: 'pi', primary: 20, secondary: 21 },
    ],
  })
  try {
    await changed
  } finally {
    clearTimeout(timer!)
    unsubscribe()
  }
  const settings = readers(value).settings(await readers(value).storage())
  expect(settings.routing).toEqual({
    mode: 'fallback-first',
    maxSameAccountWait: 'max',
  })
  expect(settings.fallbackOn).toEqual([500])
  expect(settings.refresh?.refreshBeforeExpiryMinutes).toBe(300)
  expect(settings.quota).toMatchObject({
    enabled: true,
    checkIntervalMinutes: 3,
    minimumRemaining: { primary: 95 },
    failClosedOnUnknownQuota: true,
  })
  expect(settings.killswitch).toMatchObject({
    enabled: true,
    defaults: { primary: 12, secondary: 23 },
    accounts: { main: { primary: 20, secondary: 21 } },
  })
  sends = []
  const reads = state.reads()
  await send(value)
  await value.pool.settled()
  // Quota eligibility filters the pool even though fallback-first would prefer it.
  expect(sends).toEqual([mainToken])
  expect(refreshes).toBe(1)
  expect(state.reads()).toBe(reads)
  await value.commandSupport().refreshAllQuota()
  expect(refreshes).toBe(1)
})

test('quota command resolves the refresh window without an intervening request', async () => {
  write({ refresh_before_expiry_minutes: 300 })
  const state = await snapshot()
  const value = runtime(state.value)
  await ready(value, true, Date.now() + 120 * 60000)
  expect(refreshes).toBe(0)
  await value.commandSupport().refreshAllQuota()
  expect(refreshes).toBe(1)
})

test('Pi does not consume OpenCode-only knobs from the resolved view', async () => {
  write({
    routing_mode: 'fallback-first',
    cache_keep_enabled: true,
    log_level: 'trace',
    request_dumps: true,
    web_sockets: true,
    raw_web_socket: true,
    responses_lite: true,
    codex_api_endpoint: 'https://not-a-provider.invalid',
    cost_zeroing: true,
  })
  const state = await snapshot()
  const ignored = new Set([
    'cacheKeep',
    'cachekeep',
    'logging',
    'dump',
    'dumpDir',
    'dumpMaxBytes',
    'webSockets',
    'rawWebSocket',
    'responsesLite',
    'codexApiEndpoint',
    'costZeroing',
  ])
  const guarded: SettingsSnapshot = {
    ...state.value,
    view: (store) =>
      new Proxy(state.value.view(store), {
        get(target, key, receiver) {
          if (typeof key === 'string' && ignored.has(key))
            throw new Error(`Pi read ignored setting ${key}`)
          return Reflect.get(target, key, receiver)
        },
      }),
  }
  const value = runtime(guarded)
  await ready(value)
  await send(value)
  expect(sends).toEqual([poolToken])
})

test('same-account wait is captured anew by the terminal-policy reader on each route', async () => {
  write({ max_same_account_wait: 'off' })
  const state = await snapshot()
  const bounds: unknown[] = []
  const value = runtime(state.value)
  quotaUsed = 100
  await ready(value, false)
  for (const word of ['off', '15m', 'cache'] as const) {
    write({ max_same_account_wait: word })
    await state.value.refresh()
    const settings = readers(value).settings(null)
    const result = await routePiRequest({
      storage: settings,
      mode: 'main-first',
      accounts: () => readers(value).accounts(settings),
      now: Date.now,
      sessionId: 'same-account',
      requestBytes: 1,
      refreshBackoff: () => new Map(),
      requestPull() {},
      placePin: () => undefined,
      firstReadingWaitMs: 0,
      send: async () => ({ status: 429 }),
      limitPolicy: {
        execute: true,
        canWait: true,
        effectiveModel: model.id,
        activity: () => undefined,
        decide(facts) {
          bounds.push(facts.terminal?.scan?.maxSameAccountWait)
          return undefined
        },
      },
    })
    expect(result.kind).toBe('sent')
  }
  expect(bounds).toEqual([0, 15, 'max'])
})

test('Pi applies shared enabled and unknown-quota policy at fallback eligibility', async () => {
  const row = {
    id: 'work',
    candidate: true,
    type: 'oauth' as const,
    credential: { type: 'oauth' as const, refresh: 'refresh' },
  }
  for (const [enabled, failClosed, admitted] of [
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ]) {
    write({ quota_enabled: enabled, quota_fail_closed_on_unknown: failClosed })
    const state = await snapshot()
    const settings = readers(runtime(state.value)).settings(null)
    expect(routablePoolRows([row], settings, Date.now(), undefined)).toEqual(
      admitted ? [row] : [],
    )
  }
})

test('both stores main floors survive the move and Pi applies only its main', async () => {
  await move({
    opencode: {
      killswitch: {
        schema: 'floors-v1',
        enabled: true,
        accounts: { main: { primary: 90, secondary: 91 } },
      },
    },
    pi: {
      killswitch: {
        schema: 'floors-v1',
        enabled: true,
        accounts: { main: { primary: 20, secondary: 21 } },
      },
    },
  })
  const state = await snapshot()
  expect(state.value.get('killswitch_account_floors')).toEqual([
    { account: 'main', host: 'opencode', primary: 90, secondary: 91 },
    { account: 'main', host: 'pi', primary: 20, secondary: 21 },
  ])
  expect(
    getKillswitchThresholdsForAccount(
      readers(runtime(state.value)).settings(null),
    ),
  ).toEqual({ primary: 20, secondary: 21 })
})

test('unparseable settings at Pi start fail closed with default floors', async () => {
  writeFileSync(file, '{ broken')
  const state = await snapshot()
  const value = runtime(state.value)
  const settings = readers(value).settings(null)
  expect(settings.killswitch?.enabled).toBe(true)
  for (const id of [undefined, 'work', 'vault:one'])
    expect(getKillswitchThresholdsForAccount(settings, id)).toEqual({
      primary: 5,
      secondary: 10,
    })
})
