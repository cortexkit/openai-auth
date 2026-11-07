import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LimitDecision, PolicyFacts } from '@cortexkit/common-auth/limits'
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
import { exerciseCoalescedQuota } from '../../../opencode/src/tests/fixtures/coalesced-quota'
import { createPiMenu, registerCommands } from '../commands.ts'
import cortexKitPiOpenAIAuth from '../index.ts'
import { type RouteAccount, routePiRequest } from '../pool-request.ts'
import { PiPoolSource } from '../pool-source.ts'
import {
  clearPiStickyRouting,
  getPiStickyRouting,
  setPiStickyRouting,
} from '../routing.ts'
import {
  errorEvent,
  FIRST_READING_WAIT_MS,
  PiOpenAIRuntime,
  type PiOpenAIRuntimeDeps,
} from '../runtime.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()

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

function makeRuntime(
  firstReadingWaitMs = FIRST_READING_WAIT_MS,
  overrides: Partial<PiOpenAIRuntimeDeps> = {},
): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    fetchImpl: fakeFetch,
    firstReadingWaitMs,
    ...overrides,
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

describe('Pi pre-publication policy evidence', () => {
  const observations: Array<{ decision: LimitDecision; facts: PolicyFacts }> =
    []
  const observe = (decision: LimitDecision, facts: PolicyFacts) =>
    observations.push({ decision, facts })

  beforeEach(() => {
    observations.length = 0
  })

  test('raw body confirmation and headers take the no-hold fallback without captured UI', async () => {
    const now = Date.now()
    const runtime = makeRuntime(0, { now: () => now, onLimitDecision: observe })
    await ready(runtime)
    await send(runtime, { sessionId: 'session-1' })
    const activity = runtime.activity.get('session-1')
    expect(activity?.accountKey.accountId).toBe('main')
    expect(activity?.accountKey.incarnation).toBe('acct-main')
    expect(activity?.ttlMs).toBe(300_000)
    const reset = Math.floor(now / 1000) + 60
    codexHandler = (call) =>
      call.token === MAIN_TOKEN
        ? Response.json(
            {
              error: {
                type: 'usage_limit_reached',
                resets_at: reset,
              },
            },
            {
              status: 429,
              headers: {
                'x-codex-primary-used-percent': '100.0',
                'x-codex-primary-reset-at': String(reset),
              },
            },
          )
        : sseOk()
    calls = []
    const events = await send(runtime, { sessionId: 'session-1' })
    expect(events.at(-1)?.type).toBe('done')
    expect(codexTokens()).toEqual([MAIN_TOKEN, ALPHA_TOKEN])
    expect(observations).toHaveLength(1)
    expect(observations[0]?.decision.action).toBe('reroute')
    expect(observations[0]?.facts.hold).toBeUndefined()
    expect(observations[0]?.facts.signal?.windows[0]).toMatchObject({
      confirmed: true,
      resetAt: reset * 1000,
      provenance: 'provider',
    })
    expect(runtime.main.quotaSnapshot()?.primary?.usedPercent).toBe(100)
    await runtime.pool.dispose()
  })

  for (const blocker of ['secondary', 'killswitch'] as const) {
    test(`${blocker} blocker prevents a hold despite a fitting confirmed primary reset`, async () => {
      const now = Date.now()
      const runtime = makeRuntime(0, {
        now: () => now,
        onLimitDecision: observe,
      })
      await ready(runtime)
      await send(runtime, { sessionId: 'session-1' })
      if (blocker === 'killswitch')
        await mutateAccounts((storage) => {
          storage.killswitch = { enabled: true }
          return storage
        }, paths)
      const reset = Math.floor(now / 1000) + 60
      codexHandler = (call) =>
        call.token === MAIN_TOKEN
          ? Response.json(
              { error: { type: 'usage_limit_reached', resets_at: reset } },
              {
                status: 429,
                headers: {
                  'x-codex-primary-used-percent': '100',
                  'x-codex-primary-reset-at': String(reset),
                  ...(blocker === 'secondary'
                    ? {
                        'x-codex-secondary-used-percent': '100',
                        'x-codex-secondary-reset-at': String(
                          reset + 4 * 86_400,
                        ),
                      }
                    : {}),
                },
              },
            )
          : sseOk()
      calls = []
      await send(runtime, { sessionId: 'session-1' })
      expect(codexTokens()).toEqual([MAIN_TOKEN, ALPHA_TOKEN])
      expect(observations[0]?.decision.action).not.toBe('hold')
      const candidate = observations[0]?.facts.candidates.find(
        (value) => value.account.accountId === 'main',
      )
      if (blocker === 'secondary')
        expect(candidate?.confirmedBlockers).toContainEqual(
          expect.objectContaining({
            window: 'secondary',
            confirmed: true,
            resetAt: (reset + 4 * 86_400) * 1000,
          }),
        )
      else {
        expect(candidate?.admitted).toBe(false)
        expect(observations[0]?.facts.hold).toBeUndefined()
      }
      await runtime.pool.dispose()
    })
  }

  for (const mode of ['main-first', 'sticky-balanced'] as const) {
    for (const status of [401, 403]) {
      for (const parsed of [false, true]) {
        test(`${mode} ${status} ${parsed ? 'parsed usage body' : 'unparsed body'} never builds hold facts`, async () => {
          const now = Date.now()
          await setMode(mode)
          const runtime = makeRuntime(0, {
            now: () => now,
            onLimitDecision: observe,
          })
          await ready(runtime)
          setPiStickyRouting('session-1', 'main')
          await send(runtime, { sessionId: 'session-1' })
          const reset = Math.floor(now / 1000) + 60
          codexHandler = (call) =>
            call.token === MAIN_TOKEN
              ? new Response(
                  parsed
                    ? JSON.stringify({
                        error: {
                          type: 'usage_limit_reached',
                          resets_at: reset,
                        },
                      })
                    : 'denied',
                  {
                    status,
                    headers: {
                      'x-codex-primary-used-percent': '100',
                      'x-codex-primary-reset-at': String(reset),
                    },
                  },
                )
              : sseOk()
          calls = []
          const events = await send(runtime, { sessionId: 'session-1' })
          expect(events.at(-1)?.type).toBe('done')
          expect(codexTokens()[0]).toBe(MAIN_TOKEN)
          expect(codexTokens()).toHaveLength(2)
          expect(observations).toHaveLength(1)
          expect(observations[0]?.facts.signal).toBeUndefined()
          expect(observations[0]?.facts.hold).toBeUndefined()
          expect(observations[0]?.decision.action).toBe('reroute')
          await runtime.pool.dispose()
        })
      }
    }
  }

  test('ordered out-of-list confirmed 429 bypasses the reducer and preserves the provider error', async () => {
    await mutateAccounts((storage) => {
      storage.fallbackOn = [401]
      return storage
    }, paths)
    const runtime = makeRuntime(0, { onLimitDecision: observe })
    await ready(runtime)
    await send(runtime, { sessionId: 'session-1' })
    codexHandler = () =>
      Response.json(
        {
          error: {
            type: 'usage_limit_reached',
            message: 'original provider refusal',
            resets_in_seconds: 60,
          },
        },
        { status: 429 },
      )
    calls = []
    const events = await send(runtime, { sessionId: 'session-1' })
    expect(codexTokens()).toEqual([MAIN_TOKEN])
    expect(events[0]?.type).toBe('error')
    if (events[0]?.type === 'error')
      expect(events[0].error.errorMessage).toBe(
        'You have hit your ChatGPT usage limit.',
      )
    expect(observations).toEqual([])
    await runtime.pool.dispose()
  })

  test('sticky unknown 429 retains without a timer and raw percentages are not rounded', async () => {
    await setMode('sticky-balanced')
    const runtime = makeRuntime(0, { onLimitDecision: observe })
    await ready(runtime)
    setPiStickyRouting('session-1', 'main')
    await send(runtime, { sessionId: 'session-1' })
    codexHandler = () =>
      Response.json(
        { error: { type: 'rate_limit_exceeded', message: 'unknown limit' } },
        {
          status: 429,
          headers: {
            'retry-after': '60',
            'x-codex-primary-used-percent': '99.999',
          },
        },
      )
    calls = []
    const events = await send(runtime, { sessionId: 'session-1' })
    expect(events[0]?.type).toBe('error')
    expect(codexTokens()).toEqual([MAIN_TOKEN])
    expect(getPiStickyRouting('session-1')).toBe('main')
    expect(observations[0]?.decision).toMatchObject({ action: 'retain' })
    expect(observations[0]?.decision).not.toHaveProperty('retryMs')
    expect(observations[0]?.facts.hold).toBeUndefined()
    expect(runtime.main.quotaSnapshot()?.primary?.usedPercent).toBe(99.999)
    await runtime.pool.dispose()
  })

  test('observing a sticky alternative schedules no additional quota polls', async () => {
    const runtime = makeRuntime(0)
    await ready(runtime)
    const accounts = (
      runtime as unknown as { accounts(storage: null): RouteAccount[] }
    )
      .accounts(null)
      .filter((account) => ['main', 'alpha'].includes(account.id))
      .map((account) =>
        account.id === 'alpha' ? { ...account, quota: undefined } : account,
      )
    let observing = false
    const pulls: string[] = []
    try {
      const result = await routePiRequest({
        accounts: () => accounts,
        storage: null,
        mode: 'sticky-balanced',
        sessionId: 'session-1',
        requestBytes: 1,
        now: Date.now,
        refreshBackoff: () => new Map(),
        firstReadingWaitMs: 0,
        requestPull(id) {
          if (observing) pulls.push(id)
        },
        send: async () => ({ status: 429 }),
        placePin(input) {
          if (input.persist) return { accountId: 'main' }
          observing = true
          try {
            input.select(new Map())
          } finally {
            observing = false
          }
          return undefined
        },
        limitPolicy: { activity: () => undefined, onDecision: observe },
      })
      expect(result).toMatchObject({ kind: 'sent', accountId: 'main' })
      expect(observations).toHaveLength(1)
      expect(pulls).toEqual([])
    } finally {
      await runtime.pool.dispose()
    }
  })

  test('activity samples dispatch time, model TTL and verified identity across token refresh', async () => {
    let now = Date.now()
    const dispatchedAt = now
    const runtime = makeRuntime(0, { now: () => now, onLimitDecision: observe })
    await ready(runtime)
    codexHandler = () => {
      now += 240_000
      return sseOk()
    }
    await send(runtime, { sessionId: 'session-1' })
    const activity = runtime.activity.get('session-1')!
    expect(activity.lastAcceptedAt).toBe(dispatchedAt)
    expect(activity.ttlMs).toBe(300_000)
    runtime.main.observeToken(jwt('acct-main', 'refresh'))
    codexHandler = (call) =>
      call.token !== ALPHA_TOKEN && call.token !== BETA_TOKEN
        ? Response.json(
            { error: { type: 'usage_limit_reached', resets_in_seconds: 60 } },
            { status: 429 },
          )
        : sseOk()
    await send(runtime, {
      sessionId: 'session-1',
      apiKey: jwt('acct-main', 'refresh'),
    })
    expect(observations[0]?.facts.attempted).toEqual(activity.accountKey)
    expect(observations[0]?.decision.action).toBe('reroute')
    now = dispatchedAt + 300_000
    await send(runtime, {
      sessionId: 'session-1',
      apiKey: jwt('acct-main', 'refresh'),
    })
    expect(observations.at(-1)?.decision.action).not.toBe('hold')
    runtime.main.observeToken(jwt('replacement'))
    await send(runtime, { sessionId: 'session-1', apiKey: jwt('replacement') })
    expect(observations.at(-1)?.facts.attempted).not.toEqual(
      activity.accountKey,
    )
    expect(observations.at(-1)?.decision.action).not.toBe('hold')
    await runtime.pool.dispose()
  })

  test('a supported model records its thirty-minute TTL on clean completion', async () => {
    const runtime = makeRuntime(0)
    await ready(runtime)
    const stream = runtime.stream({ ...MODEL, id: 'gpt-5.6' }, CONTEXT, {
      apiKey: MAIN_TOKEN,
      fetch: fakeFetch,
      transport: 'sse',
      sessionId: 'session-1',
    })
    for await (const _event of stream) {
      /* drain the accepted response */
    }
    expect(runtime.activity.get('session-1')?.ttlMs).toBe(1_800_000)
    await runtime.pool.dispose()
  })

  for (const outcome of ['failed', 'aborted', 'replaced'] as const) {
    test(`${outcome} completion earns no activity`, async () => {
      const runtime = makeRuntime(0)
      await ready(runtime)
      const controller = new AbortController()
      if (outcome === 'failed')
        codexHandler = () => new Response('failed', { status: 500 })
      if (outcome === 'aborted') controller.abort()
      if (outcome === 'replaced')
        codexHandler = () => {
          runtime.main.observeToken(jwt('new-identity'))
          return sseOk()
        }
      await send(runtime, { sessionId: 'session-1', signal: controller.signal })
      expect(runtime.activity.get('session-1')).toBeUndefined()
      await runtime.pool.dispose()
    })
  }

  for (const reason of ['usage_limit_reached', 'rate_limit_exceeded']) {
    test(`ordered no-next ${reason} decides once before publication without UI`, async () => {
      const now = Date.now()
      await store().remove('alpha')
      await store().remove('beta')
      const error = errorEvent(MODEL, 'unchanged SDK event')
      if (error.type !== 'error') throw new Error('expected error fixture')
      const head: AssistantMessageEvent = {
        type: 'start',
        partial: error.error,
      }
      const runtime = makeRuntime(0, {
        now: () => now,
        onLimitDecision: observe,
        streamSimple(model, _context, options) {
          const stream = createAssistantMessageEventStream()
          void (async () => {
            const response = await options!.fetch!(CODEX_URL, {
              headers: { authorization: `Bearer ${options?.apiKey}` },
            })
            await options?.onResponse?.(
              {
                status: response.status,
                headers: Object.fromEntries(response.headers),
              },
              model,
            )
            stream.push(head)
            stream.end()
          })()
          return stream
        },
      })
      await ready(runtime)
      // A clean real response establishes the key using the same runtime path.
      const normal = makeRuntime(0, { now: () => now })
      await ready(normal)
      await send(normal, { sessionId: 'session-1' })
      const accepted = normal.activity.get('session-1')!
      expect(accepted.accountKey.accountId).toBe('main')
      runtime.activity.recordAccepted({
        sessionId: 'session-1',
        accountKey: accepted.accountKey,
        currentAccountKey: accepted.accountKey,
        lastAcceptedAt: now,
        ttlMs: 300_000,
      })
      codexHandler = () =>
        Response.json(
          { error: { type: reason, resets_in_seconds: 60 } },
          { status: 429 },
        )
      calls = []
      const stream = runtime.stream(MODEL, CONTEXT, {
        apiKey: MAIN_TOKEN,
        sessionId: 'session-1',
        fetch: fakeFetch,
      })
      const first = await stream[Symbol.asyncIterator]().next()
      expect(observations).toHaveLength(1)
      expect(observations[0]?.facts.selection).toBeUndefined()
      if (reason === 'usage_limit_reached') {
        expect(observations[0]?.decision.action).toBe('refuse')
        expect(first.value?.type).toBe('error')
        expect(
          first.value?.type === 'error' ? first.value.error.errorMessage : '',
        ).toBe('Every OpenAI account has used up its quota. Resets in 1m.')
      } else {
        expect(observations[0]?.decision.action).not.toBe('hold')
        expect(first.value).toEqual(head)
        expect(JSON.stringify(first.value)).toBe(JSON.stringify(head))
      }
      expect(codexTokens()).toEqual([MAIN_TOKEN])
      await runtime.pool.dispose()
      await normal.pool.dispose()
    })
  }

  test('a setup throw supplies no status or decision and unknown identity earns no activity', async () => {
    const runtime = makeRuntime(0, {
      onLimitDecision: observe,
      streamSimple() {
        throw new Error('setup failed')
      },
    })
    await ready(runtime)
    const events = await send(runtime)
    expect(events[0]?.type).toBe('error')
    expect(observations).toEqual([])
    // Only the unverified Pi login may serve; verified pool rows would earn activity.
    await store().disable('alpha', 'fixture')
    await store().disable('beta', 'fixture')
    const sentTokens: Array<string | undefined> = []
    const unknown = makeRuntime(FIRST_READING_WAIT_MS, {
      onLimitDecision: observe,
      // The real SDK rejects opaque tokens before a request or completion.
      streamSimple(model, _context, options) {
        sentTokens.push(options?.apiKey)
        const stream = createAssistantMessageEventStream()
        void (async () => {
          const response = await options!.fetch!(CODEX_URL, {
            headers: { authorization: `Bearer ${options?.apiKey}` },
          })
          await options?.onResponse?.(
            {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            },
            model,
          )
          const error = errorEvent(model, await response.text())
          if (error.type !== 'error') throw new Error('expected error fixture')
          if (response.ok) {
            const message = { ...error.error, stopReason: 'stop' as const }
            stream.push({ type: 'start', partial: message })
            stream.push({ type: 'done', reason: 'stop', message })
          } else {
            stream.push(error)
          }
          stream.end()
        })()
        return stream
      },
    })
    await ready(unknown)
    const accepted = await send(unknown, {
      apiKey: 'opaque-unverified-token',
      sessionId: 'session-1',
    })
    expect(sentTokens).toEqual(['opaque-unverified-token'])
    expect(codexTokens()).toEqual(['opaque-unverified-token'])
    expect(accepted.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
    expect(unknown.activity.get('session-1')).toBeUndefined()
    codexHandler = () =>
      Response.json(
        { error: { type: 'usage_limit_reached', resets_in_seconds: 60 } },
        { status: 429 },
      )
    const refused = await send(unknown, {
      apiKey: 'opaque-unverified-token',
      sessionId: 'session-1',
    })
    expect(refused[0]?.type).toBe('error')
    expect(sentTokens).toEqual([
      'opaque-unverified-token',
      'opaque-unverified-token',
    ])
    expect(codexTokens()).toEqual(sentTokens)
    expect(
      observations.every(
        ({ decision, facts }) =>
          decision.action !== 'hold' && facts.hold === undefined,
      ),
    ).toBe(true)
    await runtime.pool.dispose()
    await unknown.pool.dispose()
  })
})

afterEach(() => {
  clearPiStickyRouting('session-1')
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Pi requests on the account pool', () => {
  test('Pi coalesces a held-lock burst and drains on runtime shutdown', async () => {
    const previousFile = process.env.PI_OPENAI_AUTH_FILE
    const previousState = process.env.PI_OPENAI_AUTH_STATE_FILE
    const previousFetch = globalThis.fetch
    process.env.PI_OPENAI_AUTH_FILE = paths.configPath
    process.env.PI_OPENAI_AUTH_STATE_FILE = paths.statePath
    globalThis.fetch = fakeFetch
    let runtime: PiOpenAIRuntime | undefined
    let shutdown: (() => Promise<void>) | undefined
    const support = PiOpenAIRuntime.prototype.commandSupport
    const capture = spyOn(
      PiOpenAIRuntime.prototype,
      'commandSupport',
    ).mockImplementation(function (this: PiOpenAIRuntime) {
      runtime = this
      return support.call(this)
    })
    try {
      await cortexKitPiOpenAIAuth({
        registerCommand() {},
        registerProvider() {},
        on(name: string, handler: () => Promise<void>) {
          if (name === 'session_shutdown') shutdown = handler
        },
      } as never)
      if (!runtime) throw new Error('extension did not create its runtime')
      await ready(runtime)
      await exerciseCoalescedQuota(
        runtime.pool.poolStore(),
        paths,
        async () => {
          if (!shutdown) throw new Error('Pi did not register session_shutdown')
          await shutdown()
        },
        'alpha',
      )
    } finally {
      await shutdown?.()
      capture.mockRestore()
      globalThis.fetch = previousFetch
      if (previousFile === undefined) delete process.env.PI_OPENAI_AUTH_FILE
      else process.env.PI_OPENAI_AUTH_FILE = previousFile
      if (previousState === undefined)
        delete process.env.PI_OPENAI_AUTH_STATE_FILE
      else process.env.PI_OPENAI_AUTH_STATE_FILE = previousState
    }
  })

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

  test('with every window spent, the account with prepaid credits serves before the one main-first tries first', async () => {
    // Every account reads 100% used; only beta reports usable credits.
    whamHandler = async (call) => {
      const json = (await whamOk(100).json()) as Record<string, unknown>
      return Response.json(
        call.token === BETA_TOKEN
          ? {
              ...json,
              credits: {
                has_credits: true,
                unlimited: false,
                overage_limit_reached: false,
                balance: '30',
              },
            }
          : json,
      )
    }
    const runtime = makeRuntime()
    await ready(runtime)
    await setMode('main-first')

    const events = await send(runtime)

    expect(events[0]?.type).toBe('start')
    expect(codexTokens()).toEqual([BETA_TOKEN])
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
    await runtime.pool.dispose()

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

  test('the original request serves after a pending first reading without a second request', async () => {
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    whamHandler = async () => {
      started.resolve()
      await gate.promise
      return whamOk()
    }
    const runtime = makeRuntime()
    await setMode('main-first')
    try {
      let finished = false
      const serving = send(runtime).then((events) => {
        finished = true
        return events
      })
      await started.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finished).toBe(false)
      expect(codexTokens()).toEqual([])
      gate.resolve()
      const events = await serving
      expect(events[0]?.type).toBe('start')
      expect(codexTokens()).toEqual([MAIN_TOKEN])
    } finally {
      gate.resolve()
    }
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

    await runtime.pool.dispose()
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
    expect(login?.lines.join('\n')).toContain('5h 90% left')
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
    expect(detail('alpha')).toContain('5h 69% left')
    expect(detail('beta')).toContain('5h 48% left')
    const login = result.menu.sections.find(
      (section) => section.id === 'pi-login',
    )
    expect(login?.lines.join('\n')).toContain('5h 93% left')
  })

  test('Quota shows each account its prepaid credits, in the Codex wording', async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    // Each account's workspace reports a different credits state; beta's
    // usage reply carries no credits object at all.
    const credits: Record<string, unknown> = {
      [MAIN_TOKEN]: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: null,
      },
      [ALPHA_TOKEN]: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: '1234.6',
      },
    }
    whamHandler = async (call) => {
      const body = await whamOk(20).json()
      return Response.json(
        call.token !== undefined && call.token in credits
          ? { ...body, credits: credits[call.token] }
          : body,
      )
    }

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
    expect(detail('alpha')).toEndWith(' · prepaid 1235 credits')
    expect(detail('beta')).not.toContain('prepaid')
    const login = result.menu.sections.find(
      (section) => section.id === 'pi-login',
    )
    expect(login?.lines.at(-1)).toBe('prepaid Available')
  })

  test('a per-account quota check polls only the chosen pool row', async () => {
    const runtime = makeRuntime()
    await ready(runtime)
    calls.length = 0
    const result = await createPiMenu(runtime.commandSupport()).apply(
      {
        command: 'openai',
        sectionId: 'quota',
        itemId: 'alpha',
        actionId: 'check',
        values: {},
      },
      { notify() {} },
    )
    expect(result.ok).toBe(true)
    expect(
      calls.filter((call) => call.url === WHAM_URL).map((call) => call.token),
    ).toEqual([ALPHA_TOKEN])
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
