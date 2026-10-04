import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  projectQuota,
  type QuotaMap,
  quotaCodec,
} from '@cortexkit/common-auth/quota'
import { openPoolStore, type PoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  mutateAccounts,
  type RoutingMode,
  saveAccounts,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'

import { createPiMenu, registerCommands } from '../commands.ts'
import { PiPoolSource } from '../pool-source.ts'
import {
  clearPiStickyRouting,
  getPiStickyRouting,
  setPiStickyRouting,
} from '../routing.ts'
import { PiOpenAIRuntime } from '../runtime.ts'

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'
const HOUR_MS = 60 * 60 * 1000

const MODEL: Model<Api> = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
}

const CONTEXT: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
}

/** An access token whose JWT claims name `identity`, as Codex tokens do. */
function jwt(identity: string, nonce = 'a'): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    nonce,
    'https://api.openai.com/auth': { chatgpt_account_id: identity },
  })}.sig`
}

const MAIN_TOKEN = jwt('acct-main')
const ALPHA_TOKEN = jwt('acct-alpha')
const BETA_TOKEN = jwt('acct-beta')

type Call = { url: string; token: string | undefined; accountId?: string }

type Handler = (call: Call) => Response | Promise<Response>

function sseOk(headers: Record<string, string> = {}): Response {
  const body = [
    'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","status":"in_progress","content":[]}}',
    'data: {"type":"response.output_text.delta","item_id":"m1","delta":"hi"}',
    'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi"}]}}',
    'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    '',
  ].join('\n\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

function whamOk(usedPercent = 10): Response {
  const resetAt = Math.floor((Date.now() + 2 * HOUR_MS) / 1000)
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18_000,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 604_800,
        reset_at: resetAt + 86_400,
      },
    },
  })
}

let tempDir: string
let paths: AccountPaths
let calls: Call[]
let codexHandler: Handler
let whamHandler: Handler
let tokenHandler: Handler

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const headers = new Headers(init?.headers)
  const authorization = headers.get('authorization') ?? undefined
  const call: Call = {
    url,
    token: authorization?.replace(/^Bearer /i, ''),
    accountId: headers.get('chatgpt-account-id') ?? undefined,
  }
  calls.push(call)
  if (url === CODEX_URL) return codexHandler(call)
  if (url === WHAM_URL) return whamHandler(call)
  if (url.endsWith('/oauth/token')) return tokenHandler(call)
  return new Response('unexpected', { status: 500 })
}) as typeof fetch

function store(): PoolStore {
  return openPoolStore({
    provider: 'openai',
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: quotaCodec,
  })
}

async function addRow(
  id: string,
  token: string,
  identity: string,
  expires = Date.now() + 10 * 24 * HOUR_MS,
): Promise<void> {
  await store().add({
    id,
    identity,
    credential: {
      type: 'oauth',
      access: token,
      refresh: `refresh-${id}`,
      expires,
    },
  })
}

async function setMode(mode: RoutingMode): Promise<void> {
  await mutateAccounts((current) => {
    current.routing = { mode }
    return current
  }, paths)
}

function makeRuntime(firstReadingWaitMs = 2_000): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    fetchImpl: fakeFetch,
    firstReadingWaitMs,
  })
}

/** Starts the runtime and waits for every account's first quota reading. */
async function ready(runtime: PiOpenAIRuntime): Promise<void> {
  await runtime.start()
  await runtime.pool.settled()
  runtime.main.observeToken(MAIN_TOKEN)
  await runtime.main.pending()
}

async function send(
  runtime: PiOpenAIRuntime,
  options: SimpleStreamOptions = {},
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  const stream = runtime.stream(MODEL, CONTEXT, {
    apiKey: MAIN_TOKEN,
    transport: 'sse',
    fetch: fakeFetch,
    ...options,
  })
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>)
    events.push(event)
  return events
}

function codexTokens(): Array<string | undefined> {
  return calls.filter((call) => call.url === CODEX_URL).map((c) => c.token)
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-openai-pool-'))
  paths = {
    configPath: join(tempDir, 'openai-auth.json'),
    statePath: join(tempDir, 'openai-auth-state.json'),
  }
  calls = []
  codexHandler = () => sseOk()
  whamHandler = () => whamOk()
  tokenHandler = () => new Response('unexpected refresh', { status: 500 })
  await addRow('alpha', ALPHA_TOKEN, 'acct-alpha')
  await addRow('beta', BETA_TOKEN, 'acct-beta')
})

afterEach(() => {
  clearPiStickyRouting('session-1')
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Pi requests on the account pool', () => {
  test('sends with the chosen account token in each routing mode, and a mode switch moves traffic', async () => {
    const runtime = makeRuntime()
    await ready(runtime)

    await setMode('main-first')
    const mainFirst = await send(runtime)
    await setMode('fallback-first')
    const fallbackFirst = await send(runtime)
    await setMode('sticky-balanced')
    const stickyFirst = await send(runtime, { sessionId: 'session-1' })
    const pinned = getPiStickyRouting('session-1')
    const stickySecond = await send(runtime, { sessionId: 'session-1' })

    for (const events of [mainFirst, fallbackFirst, stickyFirst, stickySecond])
      expect(events[0]?.type).toBe('start')
    const tokenOf: Record<string, string> = {
      main: MAIN_TOKEN,
      alpha: ALPHA_TOKEN,
      beta: BETA_TOKEN,
    }
    expect(pinned).toBeDefined()
    expect(codexTokens()).toEqual([
      MAIN_TOKEN,
      ALPHA_TOKEN,
      tokenOf[pinned as string],
      tokenOf[pinned as string],
    ])
    // pi-ai derives the account header from the chosen token.
    expect(calls.filter((c) => c.url === CODEX_URL)[1]?.accountId).toBe(
      'acct-alpha',
    )
  })

  test('a 429 with confirmed exhaustion moves a sticky pin to another account', async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    await setMode('sticky-balanced')
    setPiStickyRouting('session-1', 'alpha')
    const resetAt = String(Math.floor((Date.now() + HOUR_MS) / 1000))
    codexHandler = (call) =>
      call.token === ALPHA_TOKEN
        ? new Response(
            JSON.stringify({
              error: { code: 'usage_limit_reached', message: 'limit' },
            }),
            {
              status: 429,
              headers: {
                'x-codex-primary-used-percent': '100',
                'x-codex-primary-window-minutes': '300',
                'x-codex-primary-reset-at': resetAt,
              },
            },
          )
        : sseOk()

    const events = await send(runtime, { sessionId: 'session-1' })

    expect(events[0]?.type).toBe('start')
    const tokens = codexTokens()
    expect(tokens[0]).toBe(ALPHA_TOKEN)
    expect(tokens).toHaveLength(2)
    expect(tokens[1]).not.toBe(ALPHA_TOKEN)
    expect(getPiStickyRouting('session-1')).not.toBe('alpha')
    expect(getPiStickyRouting('session-1')).toBeDefined()
  })

  test('an expired pool token is refreshed through the store, and the request never waits for it', async () => {
    const expired = jwt('acct-alpha', 'old')
    const fresh = jwt('acct-alpha', 'new')
    rmSync(paths.configPath)
    rmSync(paths.statePath)
    await addRow('alpha', expired, 'acct-alpha', Date.now() - 1_000)
    await addRow('beta', BETA_TOKEN, 'acct-beta')
    let refreshes = 0
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    tokenHandler = async () => {
      refreshes++
      await refreshGate
      return Response.json({
        access_token: fresh,
        refresh_token: 'refresh-alpha-2',
        expires_in: 864_000,
      })
    }
    const runtime = makeRuntime()
    // Every account's first quota reading lands before the first request;
    // that request is what starts alpha's refresh.
    await ready(runtime)
    await setMode('fallback-first')

    // Alpha's refresh is held at the token endpoint, so this request is
    // served by beta without waiting for it.
    const first = await send(runtime)
    expect(first[0]?.type).toBe('start')
    expect(codexTokens()).toEqual([BETA_TOKEN])

    releaseRefresh()
    await runtime.pool.settled()
    expect(refreshes).toBe(1)
    const load = await store().read()
    const alpha =
      load.status === 'ready'
        ? load.rows.find((row) => row.id === 'alpha')
        : undefined
    expect(alpha?.credential).toMatchObject({
      type: 'oauth',
      access: fresh,
      refresh: 'refresh-alpha-2',
    })

    await send(runtime)
    expect(codexTokens()).toEqual([BETA_TOKEN, fresh])
  })

  test('quota from a response lands on the row that served it', async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    await setMode('fallback-first')
    codexHandler = () =>
      sseOk({
        'x-codex-primary-used-percent': '42',
        'x-codex-primary-window-minutes': '300',
      })

    await send(runtime)
    await runtime.pool.settled()

    const load = await store().read()
    const rows = load.status === 'ready' ? load.rows : []
    const used = (id: string) =>
      projectQuota(
        rows.find((row) => row.id === id)?.quota as QuotaMap | undefined,
      ).limits.find(
        (limit) => limit.label === 'primary' && limit.kind === 'reading',
      )?.usedPercent
    expect(codexTokens()).toEqual([ALPHA_TOKEN])
    expect(used('alpha')).toBe(42)
    expect(used('beta')).toBe(10)
    expect(
      projectQuota(runtime.main.quotaMap()).limits.find(
        (limit) => limit.label === 'primary',
      )?.usedPercent,
    ).toBe(10)
  })

  test('a codex.rate_limits WebSocket frame lands on the account whose token opened the socket', async () => {
    const runtime = makeRuntime()
    await ready(runtime)

    runtime.observeWebSocketMessage(
      { Authorization: `Bearer ${BETA_TOKEN}` },
      JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: {
          primary: { used_percent: 77, window_minutes: 300 },
          secondary: { used_percent: 5, window_minutes: 10_080 },
        },
      }),
    )

    // Routing reads the in-memory rows, which take the frame's quota at once.
    const rows = runtime.pool.peek().rows
    const used = (id: string) =>
      projectQuota(
        rows.find((row) => row.id === id)?.quota as QuotaMap | undefined,
      ).limits.find(
        (limit) => limit.label === 'primary' && limit.kind === 'reading',
      )?.usedPercent
    expect(used('beta')).toBe(77)
    expect(used('alpha')).toBe(10)
    await runtime.pool.settled()
  })

  test('a legacy Pi account list becomes the pool, keeping its accounts', async () => {
    rmSync(paths.configPath)
    rmSync(paths.statePath)
    await saveAccounts(
      {
        version: 1,
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'legacy',
            type: 'oauth',
            access: ALPHA_TOKEN,
            refresh: 'refresh-legacy',
            expires: Date.now() + 10 * 24 * HOUR_MS,
            enabled: true,
            addedAt: Date.now() - 1_000,
            accountId: 'acct-alpha',
          },
        ],
      },
      paths,
    )
    expect((await store().read()).status).toBe('pending-migration')
    const runtime = makeRuntime()
    await ready(runtime)
    expect((await store().read()).status).toBe('ready')
    await runtime.pool.load()
    await runtime.pool.settled()

    await send(runtime)

    expect(codexTokens()).toEqual([ALPHA_TOKEN])
  })

  test('unknown quota blocks until the first quota check lands', async () => {
    let releaseWham!: () => void
    const whamGate = new Promise<void>((resolve) => {
      releaseWham = resolve
    })
    whamHandler = async () => {
      await whamGate
      return whamOk()
    }
    const runtime = makeRuntime(20)
    await setMode('main-first')

    const blocked = await send(runtime)
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.type).toBe('error')
    expect(
      blocked[0]?.type === 'error' ? blocked[0].error.errorMessage : '',
    ).toContain('No OpenAI account has a quota reading yet')
    expect(codexTokens()).toEqual([])
    // Refusing the request asked for every account's first quota check.
    expect(calls.some((call) => call.url === WHAM_URL)).toBe(true)

    releaseWham()
    await runtime.main.pending()
    await runtime.pool.settled()
    const served = await send(runtime)
    expect(served[0]?.type).toBe('start')
    expect(codexTokens()).toEqual([MAIN_TOKEN])
  })

  test('every account gets a quota check as soon as it is seen, before any request', async () => {
    const runtime = makeRuntime()

    await runtime.start()
    await runtime.pool.settled()
    runtime.main.observeToken(MAIN_TOKEN)
    await runtime.main.pending()

    const polled = calls
      .filter((call) => call.url === WHAM_URL)
      .map((call) => call.token)
    expect(polled.sort()).toEqual([ALPHA_TOKEN, BETA_TOKEN, MAIN_TOKEN].sort())
    expect(codexTokens()).toEqual([])
  })

  test('a pool row holding the account Pi signs in with is never sent with', async () => {
    rmSync(paths.configPath)
    rmSync(paths.statePath)
    await addRow('twin', jwt('acct-main', 'twin'), 'acct-main')
    const runtime = makeRuntime()
    await ready(runtime)
    await setMode('fallback-first')

    await send(runtime)

    expect(codexTokens()).toEqual([MAIN_TOKEN])
  })
})

describe('a Pi pool row whose replace stopped between its two writes', () => {
  test('is completed by its first poll, which reads with the new login', async () => {
    const BETA_NEW_TOKEN = jwt('acct-beta-new')
    // A replace that wrote the new login's credential (state file) and died
    // before the config write that records its account and epoch.
    const crashing = openPoolStore({
      provider: 'openai',
      configPath: paths.configPath,
      statePath: paths.statePath,
      quota: quotaCodec,
      onStep: (step, { operation }) => {
        if (operation === 'replace' && step === 'before-config-write')
          throw new Error('crash between the writes')
      },
    })
    await expect(
      crashing.replace(
        'beta',
        {
          type: 'oauth',
          access: BETA_NEW_TOKEN,
          refresh: 'refresh-beta-new',
          expires: Date.now() + 10 * 24 * HOUR_MS,
        },
        { identity: 'acct-beta-new' },
      ),
    ).rejects.toThrow()
    const beta = async () => {
      const load = await store().read()
      return load.status === 'ready'
        ? load.rows.find((row) => row.id === 'beta')
        : undefined
    }
    expect(await beta()).toMatchObject({ torn: true, candidate: false })

    // A torn row is never a candidate, so only its own poll makes it whole:
    // the pull completes the replace from the stamp beside the credential,
    // then polls with the new login.
    const runtime = makeRuntime()
    await ready(runtime)

    const completed = await beta()
    expect(completed).toMatchObject({
      candidate: true,
      credentialEpoch: 2,
      identity: 'acct-beta-new',
      needsFirstReading: false,
    })
    expect(completed?.torn).toBeUndefined()
    const polledWith = calls
      .filter((call) => call.url === WHAM_URL)
      .map((call) => call.token)
    expect(polledWith).toContain(BETA_NEW_TOKEN)
    expect(polledWith).not.toContain(BETA_TOKEN)
  })
})

describe('Pi /openai on the account pool', () => {
  test('lists the pool rows, and Pi login with its quota in a section of its own', async () => {
    const runtime = makeRuntime()
    await ready(runtime)

    const { menu } = await createPiMenu(runtime.commandSupport()).open({
      sessionId: 'session-1',
      notify: () => {},
    })

    const accounts = menu.sections.find((section) => section.id === 'accounts')
    expect(accounts?.items.map((item) => item.id)).toEqual(['alpha', 'beta'])
    const login = menu.sections.find((section) => section.id === 'pi-login')
    expect(login?.lines.join('\n')).toContain('primary: 10% used')
    expect(JSON.stringify(menu)).not.toContain(MAIN_TOKEN)
    expect(JSON.stringify(menu)).not.toContain(ALPHA_TOKEN)
  })

  test('a quota check polls Pi login and every pool row', async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    whamHandler = (call) =>
      whamOk(
        call.token === ALPHA_TOKEN ? 31 : call.token === BETA_TOKEN ? 52 : 7,
      )

    const result = await createPiMenu(runtime.commandSupport()).apply(
      {
        command: 'openai',
        sectionId: 'quota',
        actionId: 'check',
        values: { account: '*' },
      },
      { notify: () => {} },
    )

    expect(result.ok).toBe(true)
    const quota = result.menu.sections.find((section) => section.id === 'quota')
    const detail = (id: string) =>
      quota?.items.find((item) => item.id === id)?.detail
    expect(detail('alpha')).toContain('primary 69% left')
    expect(detail('beta')).toContain('primary 48% left')
    const login = result.menu.sections.find(
      (section) => section.id === 'pi-login',
    )
    expect(login?.lines.join('\n')).toContain('primary: 7% used')
  })

  test('a failed quota check names the account that failed', async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    whamHandler = (call) =>
      call.token === BETA_TOKEN
        ? new Response('{}', { status: 500 })
        : whamOk(10)

    const result = await createPiMenu(runtime.commandSupport()).apply(
      {
        command: 'openai',
        sectionId: 'quota',
        actionId: 'check',
        values: { account: '*' },
      },
      { notify: () => {} },
    )

    // The menu shows only a generic line for an error it cannot vouch for;
    // this failure is written for the user, so its text and code reach them.
    expect(result).toMatchObject({ ok: false, code: 'quota-check-failed' })
    expect(result.text).toContain('beta: ')
    expect(result.text).not.toContain('alpha')
  })

  test("the one registered command drives the menu with Pi's UI", async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    const handlers = new Map<
      string,
      (args: string, ctx: ExtensionCommandContext) => Promise<void>
    >()
    registerCommands(
      {
        registerCommand(
          name: string,
          registration: {
            handler: (
              args: string,
              ctx: ExtensionCommandContext,
            ) => Promise<void>
          },
        ) {
          handlers.set(name, registration.handler)
        },
      } as unknown as ExtensionAPI,
      { pool: runtime.commandSupport() },
    )
    expect([...handlers.keys()]).toEqual(['openai'])

    // Routing, its mode action, then Fallback first; then back out twice.
    const picks = ['Routing', 'Change mode', 'Fallback first']
    const notified: string[] = []
    await handlers.get('openai')?.('', {
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = picks.shift()
          return next && options.find((option) => option.startsWith(next))
        },
        confirm: async () => true,
        input: async () => undefined,
        notify: (message: string) => notified.push(message),
      },
      sessionManager: { getSessionId: () => 'session-1' },
      modelRegistry: { getApiKeyForProvider: async () => MAIN_TOKEN },
    } as unknown as ExtensionCommandContext)

    expect(notified).toContain('Routing mode set to Fallback first.')
    const load = await store().readSettings()
    expect(
      load.status === 'ready'
        ? (load.settings.routing as { mode?: string }).mode
        : undefined,
    ).toBe('fallback-first')
  })
})

describe('a Pi pool refresh that returns another account', () => {
  // The store keeps the new tokens on the row and disables it (the spent
  // refresh token makes dropping them lose the login); the source must stop
  // serving the row at once rather than back off and retry it.
  test('takes the row out of routing in this process and on disk', async () => {
    await addRow('gamma', jwt('acct-gamma'), 'acct-gamma', Date.now() + 60_000)
    const source = new PiPoolSource({
      paths: () => paths,
      refreshProvider: async () => ({
        access: jwt('acct-other', 'b'),
        refresh: 'refresh-gamma-rotated',
        expires: Date.now() + HOUR_MS,
        identity: 'acct-other',
      }),
      pullQuota: async () => {
        throw new Error('no quota poll in this test')
      },
    })
    const view = await source.load()
    await source.refreshDueTokens(view.rows, null)
    const gamma = source.peek().rows.find((row) => row.id === 'gamma')
    expect(gamma?.candidate).toBe(false)
    expect(gamma?.enabled).toBe(false)
    const reread = (await source.load()).rows.find((row) => row.id === 'gamma')
    expect(reread?.candidate).toBe(false)
    expect(reread?.identity).toBe('acct-gamma')
    source.dispose()
    await source.settled()
  })
})
