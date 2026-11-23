// The Claustrum vault end to end on Pi: the real claustrum client over a
// socket to the mock daemon, Pi's `/openai` Vault section, and Pi requests
// routed to a vault account.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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
import {
  ClaustrumConsumer,
  readClaustrumEnrollmentToken,
} from '@cortexkit/common-auth/claustrum'
import type { PolicyFacts } from '@cortexkit/common-auth/limits'
import { projectQuota } from '@cortexkit/common-auth/quota'
import {
  type AccountPaths,
  mutateAccounts,
  OpenAiVault,
  type RoutingMode,
  VAULT_ROUTING_REFUSAL_MESSAGE,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import {
  chatgptAccessToken,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import * as vaultRouting from '../../../core/src/vault-routing.ts'
import { createPiMenu } from '../commands.ts'
import { installRawCodexWebSocket } from '../index.ts'
import { RawWebSocket } from '../raw-ws-node.ts'
import { clearPiStickyRouting } from '../routing.ts'
import { PiOpenAIRuntime, type PiOpenAIRuntimeDeps } from '../runtime.ts'
import { VAULT_PLACEHOLDER_KEY } from '../vault-slot.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')

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

function sseOk(): Response {
  const body = [
    'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","status":"in_progress","content":[]}}',
    'data: {"type":"response.output_text.delta","item_id":"m1","delta":"hi"}',
    'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi"}]}}',
    'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    '',
  ].join('\n\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function whamOk(): Response {
  const resetAt = Math.floor((Date.now() + 7_200_000) / 1000)
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 18_000,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 604_800,
        reset_at: resetAt + 86_400,
      },
    },
  })
}

let dir: string
let paths: AccountPaths
let stateDir: string
let daemon: MockDaemon
let codexTokens: string[]
let codexStatus: (token: string) => number
let codexReplyHeaders: Record<string, string>
let codexErrorBody: string
const routingKey = Symbol.for('cortexkit.routing')
const originalRouting = Object.getOwnPropertyDescriptor(globalThis, routingKey)

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const token =
    new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '') ??
    ''
  if (url === CODEX_URL) {
    codexTokens.push(token)
    const status = codexStatus(token)
    const response =
      status === 200 ? sseOk() : new Response(codexErrorBody, { status })
    for (const [name, value] of Object.entries(codexReplyHeaders))
      response.headers.set(name, value)
    return response
  }
  if (url === WHAM_URL) return whamOk()
  return new Response('unexpected', { status: 500 })
}) as typeof fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-openai-vault-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
  stateDir = join(dir, 'vault')
  codexTokens = []
  codexStatus = () => 200
  codexReplyHeaders = {}
  codexErrorBody = '{}'
})

afterEach(async () => {
  if (originalRouting)
    Object.defineProperty(globalThis, routingKey, originalRouting)
  else Reflect.deleteProperty(globalThis, routingKey)
  clearPiStickyRouting('session-1')
  await daemon?.stop()
  rmSync(dir, { recursive: true, force: true })
})

function vault(): OpenAiVault {
  return new OpenAiVault({
    host: 'pi',
    stateDir,
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    fetchImpl: () => fakeFetch,
  })
}

function runtimeWith(
  target: OpenAiVault,
  webSocket = false,
  deps: Partial<PiOpenAIRuntimeDeps> = {},
): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    ...(webSocket && { installWebSocket: installRawCodexWebSocket }),
    paths: () => paths,
    fetchImpl: fakeFetch,
    firstReadingWaitMs: 0,
    vault: target,
    ...deps,
  })
}

async function send(
  runtime: PiOpenAIRuntime,
  options: SimpleStreamOptions = {},
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  const stream = runtime.stream(MODEL, CONTEXT, {
    transport: 'sse',
    fetch: fakeFetch,
    apiKey: VAULT_PLACEHOLDER_KEY,
    ...options,
  })
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>)
    events.push(event)
  return events
}

async function setMode(mode: RoutingMode): Promise<void> {
  await mutateAccounts((current) => {
    current.routing = { mode }
    return current
  }, paths)
}

function enroll() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath } = vaultPaths(stateDir, 'pi')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
}

function observeRouting(
  accountFor?: (ask: Record<string, unknown>) => unknown,
) {
  const reports: Record<string, unknown>[] = []
  Reflect.set(globalThis, routingKey, () => ({
    ...(accountFor && {
      accountFor: async (ask: Record<string, unknown>) => accountFor(ask),
    }),
    report: (payload: Record<string, unknown>) => {
      reports.push(payload)
    },
  }))
  return reports
}

function errorMessage(events: AssistantMessageEvent[]) {
  const event = events.at(-1)
  return event?.type === 'error' ? event.error.errorMessage : undefined
}

function flushCacheTouches() {
  // Cache touches use a deferred timer; queue another timer behind them.
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const provedLimit = {
  type: 'usage_limit_reached',
  window: '5h',
  resets_in_seconds: 60,
}

describe('Pi and the Claustrum vault', () => {
  test('Thalamus reports clean HTTP finishes once, bills helpers as generate and only touches the primary cache', async () => {
    const reports = observeRouting()
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const now = Date.now()
    const runtime = runtimeWith(target, false, { now: () => now })
    try {
      await target.refresh()
      await target.pollStale(0)
      const primary = await send(runtime, { sessionId: 'primary' })
      const helper = await send(runtime, {
        sessionId: 'helper',
        cacheRetention: 'none',
      })
      expect([primary.at(-1)?.type, helper.at(-1)?.type]).toEqual([
        'done',
        'done',
      ])
      expect(runtime.activity.get('primary')).toMatchObject({
        lastAcceptedAt: now,
      })
      expect(runtime.activity.get('helper')).toBeUndefined()
      await flushCacheTouches()
      expect(reports.filter((report) => report.outcome === 'served')).toEqual(
        Array.from({ length: 2 }, () => ({
          outcome: 'served',
          account_id: 'chatgpt-vault',
          credential_id: 'oauth:openai:vault',
          headers: {},
        })),
      )
      expect(
        reports
          .filter((report) => report.kind === 'billing')
          .map((report) => report.request_kind),
      ).toEqual(['primary', 'generate'])
      expect(reports.filter((report) => report.kind === 'cache_touch')).toEqual(
        [
          {
            kind: 'cache_touch',
            at: now,
            ttl_ms: 'implicit',
            source: 'response',
          },
        ],
      )
    } finally {
      await target.dispose()
      await runtime.pool.dispose()
    }
  })

  test('Thalamus does not report served for a 200 HTTP stream whose body fails', async () => {
    const reports = observeRouting()
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    let read = false
    try {
      await target.refresh()
      await target.pollStale(0)
      const events = await send(runtime, {
        sessionId: 'session-1',
        maxRetries: 0,
        fetch: (async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (read) controller.error(new Error('sentinel broken stream'))
                else
                  controller.enqueue(new TextEncoder().encode('data: {}\n\n'))
                read = true
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )) as unknown as typeof fetch,
      })
      expect(errorMessage(events)).toContain('sentinel broken stream')
      expect(read).toBe(true)
      await flushCacheTouches()
      expect(reports.filter((report) => report.kind !== 'billing')).toEqual([])
      expect(runtime.activity.get('session-1')).toBeUndefined()
    } finally {
      await target.dispose()
      await runtime.pool.dispose()
    }
  })

  for (const scenario of [
    {
      name: '403 holds the same route',
      status: 403,
      delay: 3000,
      ui: true,
      sends: 2,
    },
    {
      name: 'unproven 429 holds the same route',
      status: 429,
      delay: 3000,
      ui: true,
      sends: 2,
    },
    { name: 'headless refuses', status: 403, delay: 3000, ui: false, sends: 1 },
    {
      name: 'over-cap refuses',
      status: 429,
      delay: 7_200_000,
      ui: true,
      sends: 1,
    },
    {
      name: 'changed account identity refuses',
      status: 403,
      delay: 3000,
      ui: true,
      sends: 1,
      replace: true,
    },
    {
      name: 'withdrawn vault custody refuses',
      status: 403,
      delay: 3000,
      ui: true,
      sends: 1,
      withdraw: true,
    },
  ]) {
    test(`Thalamus transient backoff: ${scenario.name}`, async () => {
      const asks: unknown[] = []
      const reports = observeRouting((ask) => asks.push(ask))
      const credential = 'oauth:openai:a'
      daemon = await startMockDaemon({
        directory: dir,
        credentials: {
          [credential]: vaultLogin('chatgpt-a'),
          'oauth:openai:b': vaultLogin('chatgpt-b'),
        },
      })
      enroll()
      const target = vault()
      let now = Date.now()
      const start = now
      const waits: number[] = []
      const runtime = runtimeWith(target, false, {
        now: () => now,
        waitForPi: async (delay) => {
          waits.push(delay)
          expect(codexTokens).toEqual([chatgptAccessToken('chatgpt-a')])
          if (scenario.replace) {
            daemon.credentials[credential] = vaultLogin('chatgpt-other')
            await target.refresh()
          }
          if (scenario.withdraw) rmSync(vaultPaths(stateDir, 'pi').tokenPath)
          now += delay
          return 'elapsed'
        },
      })
      if (scenario.ui) runtime.setWorkingMessage = () => {}
      try {
        await target.refresh()
        await target.pollStale(0)
        codexStatus = () => (codexTokens.length === 1 ? scenario.status : 200)
        codexReplyHeaders = { 'retry-after': String(scenario.delay / 1000) }
        codexErrorBody =
          '{"error":{"type":"rate_limit_exceeded","window":"5h"}}'
        const events = await send(runtime, {
          sessionId: 'session-1',
          maxRetries: 0,
        })
        const done = scenario.sends === 2
        expect(codexTokens).toEqual(
          Array(scenario.sends).fill(chatgptAccessToken('chatgpt-a')),
        )
        expect(waits).toEqual(
          done || scenario.replace || scenario.withdraw ? [scenario.delay] : [],
        )
        expect(events.at(-1)?.type).toBe(done ? 'done' : 'error')
        if (!done)
          expect(errorMessage(events)).toBe(VAULT_ROUTING_REFUSAL_MESSAGE)
        expect(asks).toEqual([])
        expect(
          reports.filter((report) => report.kind === 'transient_backoff'),
        ).toEqual([
          expect.objectContaining({
            kind: 'transient_backoff',
            account_id: 'chatgpt-a',
            credential_id: credential,
            retry_at_ms: start + scenario.delay,
          }),
        ])
        expect(
          reports.filter((report) => report.outcome === 'served'),
        ).toHaveLength(done ? 1 : 0)
        const waitReports = reports.filter((report) => report.kind === 'wait')
        if (waits.length)
          expect(waitReports).toEqual([
            expect.objectContaining({
              phase: 'start',
              wait_id: expect.any(String),
            }),
            expect.objectContaining({
              phase: 'end',
              wait_id: waitReports[0]?.wait_id,
              outcome: done ? 'resumed' : 'abandoned',
            }),
          ])
        else expect(waitReports).toEqual([])
      } finally {
        await target.dispose()
        await runtime.pool.dispose()
      }
    })
  }

  for (const scenario of [
    {
      name: 'uses the named alternative',
      answer: { account_id: 'chatgpt-c' },
      next: 'chatgpt-c',
    },
    {
      name: 'missing answer uses subscription order',
      answer: undefined,
      next: 'chatgpt-b',
    },
    {
      name: 'denial does not try the next route',
      answer: { refused: { code: 'account_selection_refused' } },
    },
    {
      name: 'holds the exhausted route when the cache cap fits',
      answer: { account_id: 'chatgpt-a', hold: { retry_after_ms: 3000 } },
      next: 'chatgpt-a',
      delay: 3000,
    },
    {
      name: 'refuses an exhausted hold beyond the cache cap',
      answer: { account_id: 'chatgpt-a', hold: { retry_after_ms: 301_000 } },
      delay: 301_000,
    },
  ]) {
    test(`Thalamus continue: ${scenario.name}`, async () => {
      const asks: Record<string, unknown>[] = []
      const reports = observeRouting((ask) => {
        expect(codexTokens).toEqual([chatgptAccessToken('chatgpt-a')])
        expect(
          reports.filter((report) => report.outcome === 'exhausted'),
        ).toHaveLength(1)
        asks.push(ask)
        return scenario.answer
      })
      daemon = await startMockDaemon({
        directory: dir,
        credentials: {
          'oauth:openai:a': vaultLogin('chatgpt-a'),
          'oauth:openai:b': vaultLogin('chatgpt-b'),
          'oauth:openai:c': vaultLogin('chatgpt-c'),
        },
      })
      enroll()
      let now = Date.now()
      const target = vault()
      const waits: number[] = []
      const runtime = runtimeWith(target, false, {
        now: () => now,
        waitForPi: async (delay) => {
          waits.push(delay)
          now += delay
          return 'elapsed'
        },
      })
      if (scenario.delay !== undefined) runtime.setWorkingMessage = () => {}
      try {
        await target.refresh()
        await target.pollStale(0)
        const options = { sessionId: 'session-1', maxRetries: 0 }
        if (scenario.delay !== undefined) {
          expect((await send(runtime, options)).at(-1)?.type).toBe('done')
          codexTokens = []
        }
        codexStatus = () => (codexTokens.length === 1 ? 429 : 200)
        codexErrorBody = JSON.stringify({ error: provedLimit })
        const events = await send(runtime, options)
        expect(asks).toEqual([
          expect.objectContaining({
            mode: 'continue',
            exhausted: expect.objectContaining({
              account: 'chatgpt-a',
              credential_id: 'oauth:openai:a',
              limit_window: 'five_hour',
            }),
            candidates: expect.objectContaining({
              accounts: expect.arrayContaining([
                expect.objectContaining({ account_id: 'chatgpt-b' }),
                expect.objectContaining({ account_id: 'chatgpt-c' }),
              ]),
            }),
          }),
        ])
        expect(codexTokens).toEqual(
          ['chatgpt-a', ...(scenario.next ? [scenario.next] : [])].map((id) =>
            chatgptAccessToken(id),
          ),
        )
        expect(waits).toEqual(scenario.next === 'chatgpt-a' ? [3000] : [])
        if (scenario.next) expect(events.at(-1)?.type).toBe('done')
        else expect(errorMessage(events)).toBe(VAULT_ROUTING_REFUSAL_MESSAGE)
      } finally {
        await target.dispose()
        await runtime.pool.dispose()
      }
    })
  }

  for (const start of ['toolcall_start', 'text_delta'] as const) {
    test(`Thalamus reports a limit after ${start} without another routing action`, async () => {
      const asks: unknown[] = []
      const reports = observeRouting((ask) => asks.push(ask))
      daemon = await startMockDaemon({
        directory: dir,
        credentials: {
          'oauth:openai:a': vaultLogin('chatgpt-a'),
          'oauth:openai:b': vaultLogin('chatgpt-b'),
        },
      })
      enroll()
      const target = vault()
      const waits: number[] = []
      const now = Date.now()
      const runtime = runtimeWith(target, false, {
        now: () => now,
        waitForPi: async (delay) => {
          waits.push(delay)
          return 'elapsed'
        },
      })
      runtime.setWorkingMessage = () => {}
      try {
        await target.refresh()
        await target.pollStale(0)
        const tool = start === 'toolcall_start'
        const output = tool
          ? [
              'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"c1","name":"helper","arguments":""}}',
            ]
          : [
              'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","status":"in_progress","content":[]}}',
              'data: {"type":"response.output_text.delta","item_id":"m1","delta":"partial"}',
            ]
        const error = tool
          ? { code: 'rate_limit_exceeded' }
          : { ...provedLimit, code: 'usage_limit_reached' }
        const events = await send(runtime, {
          sessionId: 'session-1',
          maxRetries: 0,
          fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
            codexTokens.push(
              new Headers(init?.headers).get('authorization') ?? '',
            )
            return new Response(
              [
                ...output,
                `data: ${JSON.stringify({ type: 'response.failed', response: { error } })}`,
                '',
              ].join('\n\n'),
              { headers: { 'content-type': 'text/event-stream' } },
            )
          }) as typeof fetch,
        })
        expect(events.map((event) => event.type)).toContain(start)
        expect(errorMessage(events)).toContain('already been shown')
        expect(codexTokens).toEqual([
          `Bearer ${chatgptAccessToken('chatgpt-a')}`,
        ])
        expect(asks).toEqual([])
        expect(waits).toEqual([])
        await flushCacheTouches()
        expect(reports.filter((report) => report.kind !== 'billing')).toEqual([
          {
            account_id: 'chatgpt-a',
            credential_id: 'oauth:openai:a',
            ...(tool
              ? {
                  kind: 'transient_backoff',
                  retry_at_ms: now + 5000,
                  provider_code: 'http_429',
                }
              : {
                  outcome: 'exhausted',
                  window: '5h',
                  resets_at: now + 60_000,
                }),
          },
        ])
        expect(runtime.activity.get('session-1')).toBeUndefined()
      } finally {
        await target.dispose()
        await runtime.pool.dispose()
      }
    })
  }

  test('vault slow and oversized diagnostics are bounded for pi-ai without rewriting an ordinary refusal', async () => {
    Reflect.set(globalThis, routingKey, () => ({}))
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    const encoder = new TextEncoder()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    let sentAt = 0
    const slow = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('partial provider text'))
            timer = setTimeout(() => controller.close(), 3000)
          },
          cancel() {
            cancelled = true
            clearTimeout(timer)
          },
        }),
        { status: 403 },
      )
    let sentBytes = 0
    let overflowCancelled = false
    const oversized = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65_536).fill(120))
            controller.enqueue(encoder.encode('x'))
            sentBytes = 65_537
            timer = setTimeout(() => controller.close(), 100)
          },
          cancel() {
            overflowCancelled = true
            clearTimeout(timer)
          },
        }),
        { status: 429 },
      )
    const refusal = async (body: () => Response) => {
      const options = {
        maxRetries: 0,
        fetch: (async () => {
          sentAt = performance.now()
          return body()
        }) as unknown as typeof fetch,
      }
      const event = (await send(runtime, options)).at(-1)
      expect(event?.type).toBe('error')
      return event?.type === 'error' ? event.error.errorMessage : undefined
    }
    try {
      await target.refresh()
      await target.pollStale(0)
      expect(await refusal(slow)).toBe('No diagnostic was received.')
      const elapsed = performance.now() - sentAt
      expect(elapsed).toBeGreaterThanOrEqual(1900)
      expect(elapsed).toBeLessThan(3000)
      expect(cancelled).toBe(true)
      expect(await refusal(oversized)).toBe('No diagnostic was received.')
      expect(sentBytes).toBe(65_537)
      expect(overflowCancelled).toBe(true)
      expect(
        await refusal(
          () => new Response('ordinary provider refusal', { status: 403 }),
        ),
      ).toBe('ordinary provider refusal')
    } finally {
      clearTimeout(timer)
      await target.dispose()
      await runtime.pool.dispose()
    }
  })

  test('OA-57 a successful pi-ai HTTP retry does not report or act on the first limit', async () => {
    const reports: Record<string, unknown>[] = []
    let asks = 0
    Reflect.set(globalThis, routingKey, () => ({
      report(payload: Record<string, unknown>) {
        reports.push(payload)
      },
      accountFor() {
        asks++
      },
    }))
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const decisions: PolicyFacts[] = []
    const waits: number[] = []
    const runtime = new PiOpenAIRuntime({
      streamSimple,
      createStream: createAssistantMessageEventStream,
      paths: () => paths,
      vault: target,
      fetchImpl: fakeFetch,
      firstReadingWaitMs: 0,
      onLimitDecision: (_decision, facts) => decisions.push(facts),
      waitForPi: async (delay) => {
        waits.push(delay)
        return 'elapsed'
      },
    })
    runtime.setWorkingMessage = () => {}
    try {
      await target.refresh()
      await target.pollStale(0)
      codexStatus = () => (codexTokens.length === 1 ? 429 : 200)
      codexErrorBody =
        '{"error":{"type":"usage_limit_reached","rate_limit_reached_type":"primary","resets_in_seconds":60}}'
      codexReplyHeaders = { 'retry-after': '0' }
      const events = await send(runtime, {
        maxRetries: 1,
        sessionId: 'session-1',
      })
      expect(events.at(-1)?.type).toBe('done')
      expect(codexTokens).toEqual([VAULT_ACCESS, VAULT_ACCESS])
      expect(waits).toEqual([])
      expect(asks).toBe(0)
      expect(decisions).toEqual([])
      expect(reports.filter((report) => report.kind !== 'cache_touch')).toEqual(
        [
          {
            account_id: 'chatgpt-vault',
            credential_id: 'oauth:openai:vault',
            outcome: 'served',
            headers: { 'retry-after': '0' },
          },
          expect.objectContaining({
            kind: 'billing',
            attempt: 1,
            outcome: 'completed',
            status: 200,
            credential_id: 'oauth:openai:vault',
          }),
        ],
      )
    } finally {
      await target.dispose()
      await runtime.pool.dispose()
    }
  })

  test('Pi attributes SSE-only codex.rate_limits to the receipt that sent the request', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        'oauth:openai:vault': vaultLogin('chatgpt-vault', {
          record_version: 3,
        }),
      },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    const usage = spyOn(target, 'reportUsage')
    const quota = {
      type: 'codex.rate_limits',
      rate_limits: { primary: { used_percent: 77, window_minutes: 300 } },
    }
    try {
      await target.refresh()
      await target.pollStale(0)
      usage.mockClear()
      const events = await send(runtime, {
        fetch: (async () =>
          new Response(
            `data: ${JSON.stringify(quota)}\n\n${await sseOk().text()}`,
            { headers: { 'content-type': 'text/event-stream' } },
          )) as unknown as typeof fetch,
      })
      expect(events.at(-1)?.type).toBe('done')
      const accountId = target.routes()[0]?.id
      if (!accountId) throw new Error('Expected a served vault route')
      expect(
        usage.mock.calls.filter(([, reading]) => 'frame' in reading),
      ).toEqual([
        [
          accountId,
          { frame: quota },
          expect.objectContaining({
            credentialId: 'oauth:openai:vault',
            recordVersion: 3,
            accountIdentity: 'chatgpt-vault',
          }),
        ],
      ])
    } finally {
      usage.mockRestore()
      await target.dispose()
      await runtime.pool.dispose()
    }
  })
  for (const scenario of [
    { name: 'usage-limit refusal', accessor: true, wait: false, usage: true },
    {
      name: 'same-account usage-limit wait',
      accessor: true,
      wait: true,
      usage: true,
    },
    {
      name: 'usage limit without routing',
      accessor: false,
      wait: false,
      usage: true,
    },
    { name: 'short rate limit', accessor: true, wait: false, usage: false },
  ]) {
    test(`vault routing exhaustion: ${scenario.name}`, async () => {
      const reports: Record<string, unknown>[] = []
      let asks = 0
      if (scenario.accessor)
        Reflect.set(globalThis, routingKey, () => ({
          accountFor: () => {
            asks++
            return undefined
          },
          report: (payload: Record<string, unknown>) => {
            if (payload.outcome === 'exhausted') reports.push(payload)
            return new Promise(() => {})
          },
        }))
      else Reflect.deleteProperty(globalThis, routingKey)
      daemon = await startMockDaemon({
        directory: dir,
        credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      })
      enroll()
      const target = vault()
      let now = Date.now()
      const reset = Math.floor(now / 1000) * 1000 + 60_000
      const expected = [
        {
          account_id: 'chatgpt-vault',
          credential_id: 'oauth:openai:vault',
          outcome: 'exhausted',
          window: '5h',
          resets_at: reset,
        },
      ]
      const waits: number[] = []
      const runtime = new PiOpenAIRuntime({
        streamSimple,
        createStream: createAssistantMessageEventStream,
        paths: () => paths,
        vault: target,
        fetchImpl: fakeFetch,
        firstReadingWaitMs: 0,
        now: () => now,
        waitForPi: async (delay) => {
          expect(reports).toEqual(expected)
          waits.push(delay)
          now += delay
          codexStatus = () => 200
          codexReplyHeaders = {}
          return 'elapsed'
        },
      })
      if (scenario.wait) runtime.setWorkingMessage = () => {}
      const report = spyOn(vaultRouting, 'reportVaultRoutingLimit')
      try {
        await target.refresh()
        await target.pollStale(0)
        await send(runtime, { sessionId: 'session-1' })
        codexTokens = []
        codexStatus = () => 429
        codexErrorBody = JSON.stringify({
          error: {
            type: scenario.usage
              ? 'usage_limit_reached'
              : 'rate_limit_exceeded',
            rate_limit_reached_type: 'primary',
            resets_at: reset / 1000,
          },
        })
        codexReplyHeaders = {
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(reset / 1000),
        }
        const events = await send(runtime, { sessionId: 'session-1' })
        expect(reports).toEqual(
          scenario.accessor && scenario.usage ? expected : [],
        )
        expect(waits).toHaveLength(scenario.wait ? 1 : 0)
        expect(codexTokens).toHaveLength(scenario.wait ? 2 : 1)
        expect(events.at(-1)?.type).toBe(scenario.wait ? 'done' : 'error')
        expect(asks).toBe(scenario.accessor && scenario.usage ? 1 : 0)
        if (!scenario.accessor || !scenario.usage)
          expect(report).not.toHaveBeenCalled()
      } finally {
        report.mockRestore()
        await target.dispose()
        await runtime.pool.dispose()
      }
    })
  }

  test('quota hold wake rereads withdrawn vault custody without another wait or local send', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    let now = Date.now()
    const waits: number[] = []
    const messages: Array<string | undefined> = []
    await mutateAccounts((storage) => {
      storage.killswitch = { enabled: false }
      return storage
    }, paths)
    const runtime = new PiOpenAIRuntime({
      streamSimple,
      createStream: createAssistantMessageEventStream,
      paths: () => paths,
      vault: target,
      fetchImpl: fakeFetch,
      firstReadingWaitMs: 0,
      now: () => now,
      waitForPi: async (delay) => {
        waits.push(delay)
        now += delay
        delete daemon.credentials['oauth:openai:vault']
        await target.refresh()
        return 'elapsed'
      },
    })
    runtime.setWorkingMessage = (message) => {
      messages.push(message)
    }
    try {
      await target.refresh()
      await target.pollStale(0)
      await send(runtime, { sessionId: 'session-1' })
      codexTokens = []
      codexStatus = () => 429
      const reset = Math.floor(now / 1000) + 60
      codexReplyHeaders = {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-reset-at': String(reset),
      }
      const events = await send(runtime, { sessionId: 'session-1' })
      expect(waits).toHaveLength(1)
      expect(waits[0]).toBeGreaterThan(59_000)
      expect(codexTokens).toHaveLength(1)
      const last = events.at(-1)
      expect(last?.type).toBe('error')
      const message = last?.type === 'error' ? last.error.errorMessage : ''
      expect(message).toContain('vault')
      expect(message).not.toContain('Retry in')
      expect(messages.at(-1)).toBeUndefined()
    } finally {
      await target.dispose()
      await runtime.pool.dispose()
    }
  })
  test('vault activity and response evidence share the core route incarnation', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const facts: PolicyFacts[] = []
    const runtime = new PiOpenAIRuntime({
      streamSimple,
      createStream: createAssistantMessageEventStream,
      paths: () => paths,
      vault: target,
      fetchImpl: fakeFetch,
      firstReadingWaitMs: 0,
      onLimitDecision(_decision, value) {
        facts.push(value)
      },
    })
    try {
      await target.refresh()
      await target.pollStale(0)
      await send(runtime, { sessionId: 'session-1' })
      const route = target.snapshot()!.rows[0]!
      const activity = runtime.activity.get('session-1')!
      expect(activity.accountKey.accountId).toBe(route.routeId)
      expect(activity.accountKey.incarnation).toBe(String(route.addedAt))
      codexStatus = () => 429
      codexReplyHeaders = { 'x-codex-primary-used-percent': '99.999' }
      await send(runtime, { sessionId: 'session-1' })
      expect(facts).toHaveLength(1)
      expect(facts[0]?.attempted).toEqual(activity.accountKey)
      expect(facts[0]?.signal?.windows[0]?.confirmed).toBe(false)
      expect(facts[0]?.hold).toBeUndefined()
      expect(facts[0]?.candidates[0]?.confirmedBlockers).toEqual([])
    } finally {
      target.close()
      await runtime.pool.dispose()
    }
  })
  for (const throws of [false, true]) {
    test(`vault HTTP reply usage preserves the Pi response when reporter throws ${throws}`, async () => {
      daemon = await startMockDaemon({
        directory: dir,
        credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      })
      enroll()
      const target = vault()
      const runtime = runtimeWith(target)
      await target.refresh()
      await target.pollStale(0)
      codexReplyHeaders = {
        'x-codex-primary-used-percent': '42',
        authorization: 'secret',
        'set-cookie': 'secret',
      }
      const report = spyOn(
        ClaustrumConsumer.prototype,
        'reportUsage',
      ).mockImplementation(() => {
        if (throws) throw new Error('reporter failed')
      })
      try {
        const events = await send(runtime)
        expect(events.at(-1)?.type).toBe('done')
        expect(report.mock.calls).toEqual([
          [
            {
              routeId: target.routes()[0]!.id,
              credentialId: 'oauth:openai:vault',
              reading: {
                provider: 'codex',
                observedAtMs: expect.any(Number),
                account: 'chatgpt-vault',
                headers: { 'x-codex-primary-used-percent': '42' },
              },
            },
          ],
        ])
      } finally {
        report.mockRestore()
        target.close()
      }
    })
  }

  test('local Pi reply quota never reports usage to the vault', async () => {
    daemon = await startMockDaemon({ directory: dir })
    const target = vault()
    const runtime = runtimeWith(target)
    const localAccess = chatgptAccessToken('chatgpt-local')
    const report = spyOn(
      ClaustrumConsumer.prototype,
      'reportUsage',
    ).mockImplementation(() => {})
    try {
      await runtime
        .commandSupport()
        .store()
        .add({
          id: 'local',
          identity: 'chatgpt-local',
          credential: {
            type: 'oauth',
            access: localAccess,
            refresh: 'local-refresh',
            expires: Date.now() + 3600_000,
          },
        })
      await runtime.commandSupport().refreshAllQuota()
      codexReplyHeaders = { 'x-codex-primary-used-percent': '42' }
      // No Pi main login is present: only the local pool row should serve.
      // Local routing treats apiKey as Pi's login; the vault marker is not a JWT.
      const events = await send(runtime, { apiKey: undefined })
      expect(runtime.main.currentToken()).toBeUndefined()
      expect(events.at(-1)).toMatchObject({ type: 'done' })
      expect(codexTokens).toEqual([localAccess])
      runtime.observeWebSocketMessage(
        { accountId: 'local', token: localAccess },
        JSON.stringify({
          type: 'codex.rate_limits',
          rate_limits: { primary: { used_percent: 43 } },
        }),
      )
      expect(report).not.toHaveBeenCalled()
    } finally {
      report.mockRestore()
      target.close()
    }
  })

  test('Routing sets vault order by email and the next Pi request uses that order', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        a: vaultLogin('chatgpt-a', { wire: { email: 'alice@example.com' } }),
        b: vaultLogin('chatgpt-b', { wire: { email: 'bob@example.com' } }),
      },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await target.refresh()
      await target.pollStale(0)
      await setMode('ordered')
      const command = createPiMenu(runtime.commandSupport())
      const invocation = { notify() {} }
      const opened = await command.open(invocation)
      expect(
        opened.menu.sections.find((section) => section.id === 'routing')!.lines,
      ).toContain('Vault account order: alice@example.com, bob@example.com')
      const applied = await command.apply(
        {
          command: 'openai',
          sectionId: 'routing',
          actionId: 'order',
          values: { order: 'bob@example.com, alice@example.com' },
        },
        invocation,
      )
      expect(applied.ok).toBe(true)
      expect(
        JSON.parse(readFileSync(target.paths.rosterPath, 'utf8')).rows.map(
          (row: { email: string }) => row.email,
        ),
      ).toEqual(['bob@example.com', 'alice@example.com'])
      expect((await send(runtime, { sessionId: 'session-1' }))[0]?.type).toBe(
        'start',
      )
      expect(codexTokens).toEqual([chatgptAccessToken('chatgpt-b')])
    } finally {
      target.close()
    }
  })

  test('vault Routing offers same-account wait choices and saves them without changing state bytes', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:work': vaultLogin('chatgpt-work') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      const support = runtime.commandSupport()
      await support.store().add({
        id: 'local',
        credential: {
          type: 'oauth',
          access: 'local-access',
          refresh: 'local-refresh',
          expires: Date.now() + 3600_000,
        },
      })
      await support.store().pullsSettled()
      enroll()
      await target.refresh()
      const command = createPiMenu(support)
      const invocation = { notify() {} }
      const opened = await command.open(invocation)
      const wait = opened.menu.sections
        .find((section) => section.id === 'routing')!
        .actions.find((action) => action.id === 'maxSameAccountWait')
      expect(wait).toBeDefined()
      expect({ label: wait!.label, knobs: wait!.knobs }).toEqual({
        label: 'Longest wait on the same account',
        knobs: [
          {
            kind: 'choice',
            id: 'maxSameAccountWait',
            label: 'Longest wait on the same account',
            choices: [
              { value: '0', label: "Don't wait" },
              { value: '15', label: '15 minutes' },
              { value: 'max', label: 'Until the cache expires' },
            ],
            value: '15',
          },
        ],
      })
      const before = readFileSync(paths.statePath)
      for (const value of [0, 15, 'max'] as const) {
        const result = await command.apply(
          {
            command: 'openai',
            sectionId: 'routing',
            actionId: 'maxSameAccountWait',
            values: { maxSameAccountWait: String(value) },
          },
          invocation,
        )
        expect(result.ok).toBe(true)
        expect(
          JSON.parse(readFileSync(paths.configPath, 'utf8')).routing
            .maxSameAccountWait,
        ).toBe(value)
        expect(
          result.menu.sections
            .find((section) => section.id === 'routing')!
            .actions.find((action) => action.id === 'maxSameAccountWait')!
            .knobs?.[0]?.value,
        ).toBe(String(value))
        expect(readFileSync(paths.statePath)).toEqual(before)
      }
    } finally {
      target.close()
    }
  })

  test('vault mode hides local-writing Pi dialog actions and a stale add refuses without changing pool bytes', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:work': vaultLogin('chatgpt-work') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    let logins = 0
    try {
      const support = runtime.commandSupport()
      for (const id of ['local', 'spare'])
        await support.store().add({
          id,
          credential: {
            type: 'oauth',
            access: `${id}-access`,
            refresh: `${id}-refresh`,
            expires: Date.now() + 3600_000,
          },
        })
      const command = createPiMenu(support, {
        beginAccountLogin: async () => {
          logins++
          throw new Error('OAuth must not start in vault mode')
        },
      })
      const local = (await command.open({ notify() {} })).menu.sections
      expect(
        local
          .find((section) => section.id === 'accounts')!
          .actions.map((action) => action.id),
      ).toEqual(['add'])
      const localRouting = local.find((section) => section.id === 'routing')!
      expect(localRouting.actions.map((action) => action.id)).toEqual([
        'mode',
        'order',
        'maxSameAccountWait',
      ])
      const wait = localRouting.actions.find(
        (action) => action.id === 'maxSameAccountWait',
      )!
      expect({ label: wait.label, knobs: wait.knobs }).toEqual({
        label: 'Longest wait on the same account',
        knobs: [
          {
            kind: 'choice',
            id: 'maxSameAccountWait',
            label: 'Longest wait on the same account',
            choices: [
              { value: '0', label: "Don't wait" },
              { value: '15', label: '15 minutes' },
              { value: 'max', label: 'Until the cache expires' },
            ],
            value: '15',
          },
        ],
      })
      // Finish quota writes started in local mode before measuring whether
      // vault-mode menu actions leave the pool files unchanged.
      await support.store().pullsSettled()
      enroll()
      await target.refresh()
      const before = [paths.configPath, paths.statePath].map((path) =>
        readFileSync(path),
      )
      const connected = (await command.open({ notify() {} })).menu.sections
      const accounts = connected.find((section) => section.id === 'accounts')!
      expect(accounts.actions).toEqual([])
      expect(accounts.items.every((item) => item.actions.length === 0)).toBe(
        true,
      )
      expect(accounts.lines).toContain(
        'Accounts are managed in the vault with ck. Disconnect to use local accounts.',
      )
      expect(
        connected
          .find((section) => section.id === 'routing')!
          .actions.map((action) => action.id),
      ).toEqual(['mode', 'maxSameAccountWait'])
      expect(
        connected
          .find((section) => section.id === 'vault')!
          .actions.map((action) => action.id),
      ).toEqual(['disconnect'])
      const result = await command.apply(
        { command: 'openai', sectionId: 'accounts', actionId: 'add' },
        { notify() {} },
      )
      expect(result.ok).toBe(false)
      expect(result.text).toBe(
        'Nothing was changed: accounts are managed in the vault with ck. Disconnect to use local accounts.',
      )
      expect(logins).toBe(0)
      expect(
        [paths.configPath, paths.statePath].map((path) => readFileSync(path)),
      ).toEqual(before)
      await target.disconnect()
      const disconnected = (await command.open({ notify() {} })).menu.sections
      for (const id of ['accounts', 'routing'])
        expect(disconnected.find((section) => section.id === id)).toEqual(
          local.find((section) => section.id === id),
        )
    } finally {
      target.close()
    }
  })
  test('a disconnected menu names an unlabelled local row by id and keeps its identity detail', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime
        .commandSupport()
        .store()
        .add({
          id: 'local',
          identity: 'chatgpt-work',
          credential: {
            type: 'oauth',
            access: 'local-token',
            refresh: 'local-refresh',
            expires: Date.now() + 3600_000,
          },
        })
      const { menu } = await createPiMenu(runtime.commandSupport()).open({
        notify() {},
      })
      for (const id of ['accounts', 'quota', 'limits']) {
        expect(
          menu.sections.find((section) => section.id === id)?.items[0]?.label,
        ).toBe('local')
      }
      expect(
        menu.sections.find((section) => section.id === 'accounts')?.items[0]
          ?.detail,
      ).toContain('chatgpt-work')
    } finally {
      target.close()
    }
  })

  // Vault mode is exclusive: the vault's accounts replace the local rows in
  // the menu, so the local copy of a vault account is not listed at all.
  test('in vault mode the shared Accounts Quota and Limits slots list only the vault accounts', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:work': vaultLogin('chatgpt-work') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      const support = runtime.commandSupport()
      await support.store().add({
        id: 'local',
        identity: 'chatgpt-work',
        credential: {
          type: 'oauth',
          access: 'local-token',
          refresh: 'local-refresh',
          expires: Date.now() + 3600_000,
        },
      })
      enroll()
      await target.refresh()
      await target.pollStale(0)
      const command = createPiMenu(support)
      const { menu } = await command.open({ notify() {} })
      const route = target.routes()[0]!.id
      expect(menu.sections.slice(0, 4).map((section) => section.id)).toEqual([
        'accounts',
        'quota',
        'routing',
        'limits',
      ])
      for (const id of ['accounts', 'quota', 'limits']) {
        const section = menu.sections.find((section) => section.id === id)!
        expect(section.items.map((item) => item.id)).toEqual([route])
      }
      const applied = await command.apply(
        {
          command: 'openai',
          sectionId: 'limits',
          itemId: route,
          actionId: 'floors',
          values: { primary: 22, secondary: 11 },
        },
        { notify() {} },
      )
      expect(applied.ok).toBe(true)
      expect(
        applied.menu.sections
          .find((section) => section.id === 'limits')
          ?.items.find((item) => item.id === route)?.status,
      ).toBe('5h ≥22% · 7d ≥11%')
      expect(menu.sections.some((section) => section.id === 'reset')).toBe(
        false,
      )
    } finally {
      target.close()
    }
  })

  test("Connect in the Vault section enrolls Pi under its own name and stores Pi's token owner-only", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:work': vaultLogin('chatgpt-work') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    const notices: string[] = []
    const menu = createPiMenu(runtime.commandSupport(), {
      vaultWait: {
        pollIntervalMs: 1,
        sleep: async () => daemon.approve('request-1'),
      },
    })

    const started = await menu.apply(
      { command: 'openai', sectionId: 'vault', actionId: 'connect' },
      { notify: (message) => notices.push(message) },
    )

    expect(started.ok).toBe(true)
    expect(started.text).toContain(
      'ck auth enroll approve --request-id request-1',
    )
    for (let i = 0; i < 200 && notices.length === 0; i++) await Bun.sleep(10)
    expect(notices.at(-1)).toContain(
      'Connected: the vault approved openai-auth-pi',
    )
    expect(daemon.proposals.map((proposal) => proposal.name)).toEqual([
      'openai-auth-pi',
    ])
    const { tokenPath } = vaultPaths(stateDir, 'pi')
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect((await readClaustrumEnrollmentToken(tokenPath)).token).toBe(
      'ab'.repeat(32),
    )
    expect(() => statSync(vaultPaths(stateDir, 'opencode').tokenPath)).toThrow()
    target.close()
  })

  for (const mode of [
    'main-first',
    'fallback-first',
    'sticky-balanced',
  ] as const) {
    test(`a Pi request in ${mode} is sent with the token the vault serves`, async () => {
      daemon = await startMockDaemon({
        directory: dir,
        credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      })
      enroll()
      const target = vault()
      const runtime = runtimeWith(target)
      await target.refresh()
      await target.pollStale(0)
      await setMode(mode)

      const events = await send(runtime, { sessionId: 'session-1' })

      expect(events[0]?.type).toBe('start')
      expect(codexTokens).toEqual([VAULT_ACCESS])
      expect(daemon.gets.map((get) => get.credential_id)).toContain(
        'oauth:openai:vault',
      )
      target.close()
    })
  }

  test('in an ordered mode, a vault account the vault will not serve passes the request to the next account', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        'oauth:openai:a': vaultLogin('chatgpt-a'),
        'oauth:openai:b': vaultLogin('chatgpt-b'),
      },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    await target.refresh()
    await target.pollStale(0)
    await setMode('fallback-first')
    // Both accounts have a quota reading, so admission orders them; the vault
    // then refuses to serve the first.
    const credential = daemon.credentials['oauth:openai:a']
    if (!credential) throw new Error('no credential')
    credential.refuse = 'credential_unavailable'
    const gets = daemon.gets.length

    const events = await send(runtime)

    expect(events[0]?.type).toBe('start')
    expect(daemon.gets.slice(gets).map((get) => get.credential_id)).toEqual([
      'oauth:openai:a',
      'oauth:openai:b',
    ])
    expect(codexTokens).toEqual([chatgptAccessToken('chatgpt-b')])
    target.close()
  })

  test('the Vault section says when the vault listed records it could not read', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        'oauth:openai:work': vaultLogin('chatgpt-work'),
        // A record with no state is skipped as unusable, which makes the
        // whole list incomplete.
        'oauth:openai:broken': { ...vaultLogin('chatgpt-broken'), state: '' },
      },
    })
    enroll()
    const target = vault()
    await target.refresh()
    const vaultLines = async () => {
      const { menu } = await createPiMenu(
        runtimeWith(target).commandSupport(),
      ).open({ notify: () => {} })
      return (
        menu.sections.find((section) => section.id === 'vault')?.lines ?? []
      ).join('\n')
    }

    expect(target.snapshot()?.complete).toBe(false)
    expect(await vaultLines()).toContain(
      'accounts it did not list are kept as they were',
    )
    expect(target.routes()).toHaveLength(1)

    // Once the vault lists every record usably, the note goes.
    daemon.credentials['oauth:openai:broken'] = vaultLogin('chatgpt-broken')
    await target.refresh()
    expect(target.snapshot()?.complete).toBe(true)
    expect(await vaultLines()).not.toContain('could not read')
    target.close()
  })

  test('Connect names the vault it could not reach', async () => {
    daemon = await startMockDaemon({ directory: dir, credentials: {} })
    const unreachable = new OpenAiVault({
      host: 'pi',
      stateDir,
      connectionFile: () => join(dir, 'no-vault-here.json'),
      pollIntervalMs: 0,
      fetchImpl: () => fakeFetch,
    })
    const menu = createPiMenu(runtimeWith(unreachable).commandSupport())

    const result = await menu.apply(
      { command: 'openai', sectionId: 'vault', actionId: 'connect' },
      { notify: () => {} },
    )

    // The menu shows a generic line for an error it cannot vouch for; this
    // one is written for the user, so its text and code reach them.
    expect(result).toMatchObject({ ok: false, code: 'vault-unreachable' })
    expect(result.text).toContain('Could not reach the Claustrum vault')
    expect(result.text).toContain('Is the vault running?')
    unreachable.close()
  })

  describe('a rate-limit frame on a socket opened with a vault token', () => {
    const frame = JSON.stringify({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 77, window_minutes: 300 },
        secondary: { used_percent: 5, window_minutes: 10_080 },
      },
    })
    const primaryUsed = (target: OpenAiVault) =>
      target
        .routes()
        .map(
          (route) =>
            projectQuota(route.quota).limits.find(
              (limit) => limit.label === 'primary' && limit.kind === 'reading',
            )?.usedPercent,
        )

    async function served(): Promise<{
      target: OpenAiVault
      runtime: PiOpenAIRuntime
      dispatch: Parameters<PiOpenAIRuntime['observeWebSocketMessage']>[0]
    }> {
      daemon = await startMockDaemon({
        directory: dir,
        credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      })
      enroll()
      const target = vault()
      const runtime = runtimeWith(target)
      await target.refresh()
      await target.pollStale(0)
      await send(runtime)
      expect(codexTokens).toEqual([VAULT_ACCESS])
      expect(primaryUsed(target)).toEqual([10])
      const accountId = target.routes()[0]!.id
      const receipt = await target.authorize(accountId)
      if (!receipt)
        throw new Error('Expected a quota receipt for the vault route')
      return {
        target,
        runtime,
        dispatch: { accountId, token: VAULT_ACCESS, receipt },
      }
    }

    test('is recorded on the vault account with the receipt the token was served under', async () => {
      const { target, runtime, dispatch } = await served()
      const report = spyOn(
        ClaustrumConsumer.prototype,
        'reportUsage',
      ).mockImplementation(() => {})
      try {
        runtime.observeWebSocketMessage(dispatch, frame)

        for (let i = 0; i < 200 && primaryUsed(target)[0] !== 77; i++)
          await Bun.sleep(5)
        expect(primaryUsed(target)).toEqual([77])
        expect(report.mock.calls).toEqual([
          [
            {
              routeId: target.routes()[0]!.id,
              credentialId: 'oauth:openai:vault',
              reading: {
                provider: 'codex',
                observedAtMs: expect.any(Number),
                account: 'chatgpt-vault',
                frame: JSON.parse(frame),
              },
            },
          ],
        ])
      } finally {
        report.mockRestore()
        target.close()
      }
    })

    test('is dropped once the vault credential signs in as another account', async () => {
      const { target, runtime, dispatch } = await served()
      // The vault now serves the same credential for a different ChatGPT
      // account: a frame from the socket the old account's token opened
      // describes the old account and must not land on the new one.
      daemon.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-other')
      await target.refresh()

      runtime.observeWebSocketMessage(dispatch, frame)

      await Bun.sleep(50)
      expect(primaryUsed(target)).not.toContain(77)
      target.close()
    })
  })

  test('Pi attributes quota and billing to each turn on a reused vault WebSocket', async () => {
    const credential = 'oauth:openai:vault'
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        [credential]: vaultLogin('chatgpt-vault', { record_version: 1 }),
      },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target, true)
    const sessionId = 'pi-vault-reused-socket'
    const reports: { session: string; payload: Record<string, unknown> }[] = []
    const outcomes: Record<string, unknown>[] = []
    Reflect.set(globalThis, routingKey, (session: string) => ({
      report(payload: Record<string, unknown>) {
        if (payload.kind === 'billing') reports.push({ session, payload })
        else outcomes.push(payload)
      },
    }))
    const rawSend = RawWebSocket.prototype.send
    const rawFrames: string[] = []
    const seam = spyOn(RawWebSocket.prototype, 'send').mockImplementation(
      function (this: RawWebSocket, data: string) {
        expect(globalThis.WebSocket.name).toBe('PiRawCodexWebSocket')
        expect(this).toBeInstanceOf(globalThis.WebSocket)
        rawFrames.push(data)
        rawSend.call(this, data)
      },
    )
    const usage = spyOn(target, 'reportUsage')
    const wireFrames: string[] = []
    const upgrades: (string | null)[] = []
    const firstResponse = (await sseOk().text())
      .trim()
      .split('\n\n')
      .map((line) => line.slice('data: '.length))
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        const authorization = request.headers.get('authorization')
        if (server.upgrade(request)) {
          upgrades.push(authorization)
          return
        }
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(socket, frame) {
          wireFrames.push(frame.toString())
          const turn = wireFrames.length
          socket.send(
            JSON.stringify({
              type: 'codex.rate_limits',
              rate_limits: {
                primary: { used_percent: turn * 10 + 5, window_minutes: 300 },
              },
            }),
          )
          for (const event of firstResponse)
            socket.send(event.replace('"id":"r1"', `"id":"r${turn}"`))
        },
      },
    })
    try {
      await target.refresh()
      await target.pollStale(0)
      const model = { ...MODEL, baseUrl: server.url.href }
      const options = {
        transport: 'websocket-cached',
        sessionId,
        apiKey: VAULT_PLACEHOLDER_KEY,
        fetch: fakeFetch,
      } as const
      const firstStream = runtime.stream(model, CONTEXT, options)
      await Array.fromAsync(firstStream)
      const first = await firstStream.result()
      expect(first.responseId).toBe('r1')
      daemon.credentials[credential] = vaultLogin('chatgpt-vault', {
        record_version: 2,
      })
      await target.refresh()
      const secondStream = runtime.stream(
        model,
        {
          messages: [
            ...CONTEXT.messages,
            first,
            { role: 'user', content: 'next', timestamp: 2 },
          ],
        },
        options,
      )
      await Array.fromAsync(secondStream)
      const second = await secondStream.result()
      expect(second.responseId).toBe('r2')
      expect(upgrades).toEqual([`Bearer ${VAULT_ACCESS}`])
      expect(wireFrames).toEqual(rawFrames)
      expect(
        wireFrames.map((frame) => JSON.parse(frame).previous_response_id),
      ).toEqual([undefined, 'r1'])
      expect(
        usage.mock.calls.map(([id, reply, receipt]) => ({
          id,
          frame: 'frame' in reply ? reply.frame : null,
          version: (receipt as { recordVersion?: number }).recordVersion,
        })),
      ).toEqual(
        [15, 25].map((used_percent, i) => ({
          id: target.routes()[0]!.id,
          frame: {
            type: 'codex.rate_limits',
            rate_limits: { primary: { used_percent, window_minutes: 300 } },
          },
          version: i + 1,
        })),
      )
      expect(
        reports.map(({ session, payload }) => [
          session,
          payload.credential_id,
          payload.provider_response_id,
          payload.outcome,
        ]),
      ).toEqual([
        [sessionId, credential, 'r1', 'completed'],
        [sessionId, credential, 'r2', 'completed'],
      ])
      expect(reports[0]!.payload.attempt_id).not.toBe(
        reports[1]!.payload.attempt_id,
      )
      await flushCacheTouches()
      expect(outcomes.filter((report) => report.outcome === 'served')).toEqual(
        Array.from({ length: 2 }, () => ({
          account_id: 'chatgpt-vault',
          credential_id: credential,
          outcome: 'served',
          headers: {},
        })),
      )
      expect(
        outcomes.filter((report) => report.kind === 'cache_touch'),
      ).toHaveLength(2)
      expect(codexTokens).toEqual([])
    } finally {
      usage.mockRestore()
      seam.mockRestore()
      closeOpenAICodexWebSocketSessions(sessionId)
      await Promise.all([
        server.stop(true),
        runtime.pool.dispose(),
        target.dispose(),
      ])
    }
  })

  test('a 401 on a vault account is reported to the vault with the version it was served', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        'oauth:openai:vault': vaultLogin('chatgpt-vault', {
          record_version: 4,
        }),
      },
    })
    enroll()
    codexStatus = (token) => (token === VAULT_ACCESS ? 401 : 200)
    const target = vault()
    const runtime = runtimeWith(target)
    await target.refresh()
    await target.pollStale(0)

    await send(runtime)

    expect(codexTokens).toEqual([VAULT_ACCESS])
    expect(daemon.reports).toEqual([
      {
        credential_id: 'oauth:openai:vault',
        enrollment_token: '01'.repeat(32),
        provider_status: 401,
        record_version: 4,
        reporter_source: 'direct',
      },
    ])
    target.close()
  })
})
