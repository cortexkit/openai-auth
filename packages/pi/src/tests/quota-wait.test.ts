import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LimitDecision, PolicyFacts } from '@cortexkit/common-auth/limits'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  mutateAccounts,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { PiOpenAIRuntime, type PiOpenAIRuntimeDeps } from '../runtime.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()

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
const T0 = 1_900_000_000_000
const routingKey = Symbol.for('cortexkit.routing')
const originalRouting = Object.getOwnPropertyDescriptor(globalThis, routingKey)
function jwt(identity: string, nonce = '') {
  return `e30.${Buffer.from(JSON.stringify({ nonce, 'https://api.openai.com/auth': { chatgpt_account_id: identity } })).toString('base64url')}.sig`
}
const MAIN = jwt('main')
const B = jwt('beta')
function ok(tail = '') {
  return new Response(
    [
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m","role":"assistant","status":"in_progress","content":[]}}',
      'data: {"type":"response.output_text.delta","item_id":"m","delta":"hello"}',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello"}]}}',
      tail ||
        'data: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

let dir: string
let paths: AccountPaths
let now: number
let reset: number | undefined
let used: number
let sends: string[]
let reply: (token: string) => Response
let runtime: PiOpenAIRuntime
let messages: Array<string | undefined>
let decisions: Array<{ decision: LimitDecision; facts: PolicyFacts }>
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const token =
    new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '') ??
    ''
  if (url.endsWith('/codex/responses')) {
    sends.push(token)
    return reply(token)
  }
  if (url.endsWith('/wham/usage'))
    return Response.json({
      rate_limit: {
        primary_window: {
          used_percent: used,
          limit_window_seconds: 18_000,
          ...(reset === undefined ? {} : { reset_at: reset / 1000 }),
        },
      },
    })
  throw new Error(`unexpected URL ${url}`)
}) as typeof fetch

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-quota-wait-'))
  paths = {
    configPath: join(dir, 'pool.json'),
    statePath: join(dir, 'state.json'),
  }
  now = T0
  reset = T0 + 60_000
  used = 10
  sends = []
  messages = []
  decisions = []
  reply = () => ok()
  await openPoolStore({
    provider: 'openai',
    ...paths,
    quota: quotaCodec,
  }).initialize()
  await mutateAccounts((storage) => {
    storage.killswitch = { enabled: false }
    storage.routing = { mode: 'main-first', maxSameAccountWait: 15 }
    return storage
  }, paths)
})
afterEach(async () => {
  if (originalRouting)
    Object.defineProperty(globalThis, routingKey, originalRouting)
  else Reflect.deleteProperty(globalThis, routingKey)
  await runtime?.pool.dispose()
  await runtime?.vault.dispose()
  rmSync(dir, { recursive: true, force: true })
})

async function start(overrides: Partial<PiOpenAIRuntimeDeps> = {}, ui = true) {
  runtime = new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    fetchImpl,
    now: () => now,
    firstReadingWaitMs: 0,
    onLimitDecision: (decision, facts) => {
      decisions.push({ decision, facts })
    },
    ...overrides,
  })
  if (ui)
    runtime.setWorkingMessage = (text) => {
      messages.push(text)
    }
  await runtime.start()
  await runtime.pool.settled()
  runtime.main.observeToken(MAIN)
  await runtime.main.pending()
}
async function send(options: SimpleStreamOptions = {}) {
  const events: AssistantMessageEvent[] = []
  for await (const event of runtime.stream(
    MODEL,
    { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
    {
      apiKey: MAIN,
      fetch: fetchImpl,
      transport: 'sse',
      ...options,
    },
  ))
    events.push(event)
  return events
}
function text(events: AssistantMessageEvent[]) {
  return events
    .filter((event) => event.type === 'error')
    .map((event) => event.error.errorMessage)
    .join('\n')
}
function limit() {
  used = 100
  reply = () =>
    Response.json(
      {
        error: {
          type: 'usage_limit_reached',
          ...(reset === undefined ? {} : { resets_at: reset / 1000 }),
        },
      },
      {
        status: 429,
        headers: {
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '300',
          ...(reset === undefined
            ? {}
            : { 'x-codex-primary-reset-at': String(reset / 1000) }),
        },
      },
    )
}
async function addB() {
  const store = openPoolStore({
    provider: 'openai',
    ...paths,
    quota: quotaCodec,
  })
  await store.initialize()
  await store.add({
    id: 'beta',
    identity: 'beta',
    credential: {
      type: 'oauth',
      access: B,
      refresh: 'refresh-b',
      expires: T0 + 86_400_000,
    },
  })
}

describe('Pi bounded quota waits', () => {
  test.each(['no accessor', 'short wait'])(
    'countdown %s creates no wait report id',
    async (scenario) => {
      const reports: Array<{ kind?: string }> = []
      if (scenario === 'no accessor')
        Reflect.deleteProperty(globalThis, routingKey)
      else {
        Reflect.set(globalThis, routingKey, () => ({
          report: (payload: { kind?: string }) => reports.push(payload),
        }))
        reset = T0 + 1999
      }
      used = 100
      await mutateAccounts((storage) => {
        storage.killswitch = { enabled: true }
        return storage
      }, paths)
      await start({
        waitForPi: async (delay) => {
          now += delay
          used = 10
          await runtime.main.pollNow()
          return 'elapsed'
        },
      })
      const uuid = spyOn(crypto, 'randomUUID')
      try {
        await send({ sessionId: 'unreported' })
        expect(reports.filter((report) => report.kind === 'wait')).toEqual([])
        expect(uuid).not.toHaveBeenCalled()
        expect(sends).toEqual([MAIN])
      } finally {
        uuid.mockRestore()
      }
    },
  )

  test.each(['resumed', 'cancelled', 'abandoned'] as const)(
    'countdown wait reports exact start and %s end',
    async (outcome) => {
      const reports: unknown[] = []
      Reflect.set(globalThis, routingKey, (session: string) => ({
        report: (payload: unknown) => reports.push([session, payload]),
      }))
      used = 100
      if (outcome === 'abandoned') reset = T0 + 7_200_000
      await mutateAccounts((storage) => {
        storage.killswitch = { enabled: true }
        return storage
      }, paths)
      const controller = new AbortController()
      await start({
        waitForPi: async (delay) => {
          if (outcome === 'cancelled') {
            controller.abort()
            return 'aborted'
          }
          now += delay
          if (outcome === 'resumed') used = 10
          await runtime.main.pollNow()
          return 'elapsed'
        },
      })
      await send({ sessionId: 'wait-report', signal: controller.signal })
      const waits = reports.filter(
        (row) => (row as [string, { kind: string }])[1].kind === 'wait',
      )
      const first = (waits[0] as [string, { wait_id: string }])?.[1]
      expect(first?.wait_id).toMatch(/^[0-9a-f-]{36}$/)
      const base = {
        kind: 'wait',
        wait_id: first?.wait_id,
        reason: 'account_limit',
        next_ms: T0 + (outcome === 'abandoned' ? 900_000 : 60_000),
        message: 'Waiting for the account limit to reset',
      }
      expect(waits).toEqual([
        ['wait-report', { ...base, phase: 'start' }],
        ['wait-report', { ...base, phase: 'end', outcome }],
      ])
      expect(sends.length).toBe(outcome === 'resumed' ? 1 : 0)
    },
  )

  test('fitting hold lifts only the checkpoint and reuses A rather than ready B', async () => {
    await addB()
    const waits: number[] = []
    await start({
      waitForPi: async (delay) => {
        waits.push(delay)
        now += delay
        reply = () => ok()
        return 'elapsed'
      },
    })
    await send({ sessionId: 'hold' })
    limit()
    const limited = reply
    reply = (token) => (token === B ? ok() : limited(token))
    expect((await send({ sessionId: 'hold' })).at(-1)?.type).toBe('done')
    expect(waits).toEqual([60_000])
    expect(sends).toEqual([MAIN, MAIN, MAIN])
    expect(
      decisions.some(
        ({ decision }) =>
          decision.action === 'retain' && decision.reason === 'wait-elapsed',
      ),
    ).toBe(true)
  })

  test('shared countdown elapses and clears before the wake dispatch', async () => {
    reset = T0 + 1000
    await start()
    runtime.setWorkingMessage = (message) => {
      messages.push(message)
      if (message === undefined) {
        now = T0 + 1000
        reply = () => ok()
      }
    }
    limit()
    const events = await send()
    expect(messages[0]).toBe(
      'Waiting for the account limit to reset · 1s · Esc to cancel',
    )
    expect(messages.at(-1)).toBeUndefined()
    expect(events.at(-1)?.type).toBe('done')
    expect(sends).toEqual([MAIN, MAIN])
  })

  test('OA-61 known 60s terminal wait revalidates then sends once with current credentials', async () => {
    const waits: number[] = []
    const rotated = jwt('main', 'rotated')
    await start({
      waitForPi: async (delay, options) => {
        waits.push(delay)
        expect(options.setWorkingMessage).toBeDefined()
        now += delay
        runtime.main.observeToken(rotated)
        used = 10
        await runtime.main.pollNow()
        reply = () => ok()
        return 'elapsed'
      },
    })
    limit()
    const events = await send()
    expect(waits).toEqual([60_000])
    expect(sends).toEqual([MAIN, rotated])
    expect(events.at(-1)?.type).toBe('done')
    expect(messages.at(-1)).toBeUndefined()
  })

  test('fresh pre-send terminal waits once and rereads admission before its first send', async () => {
    used = 100
    await mutateAccounts((storage) => {
      storage.killswitch = { enabled: true }
      return storage
    }, paths)
    const waits: number[] = []
    await start({
      waitForPi: async (delay) => {
        waits.push(delay)
        expect(sends).toEqual([])
        now += delay
        used = 10
        await runtime.main.pollNow()
        return 'elapsed'
      },
    })
    expect((await send()).at(-1)?.type).toBe('done')
    expect(waits).toEqual([60_000])
    expect(sends).toEqual([MAIN])
  })

  test('OA-61 two-hour reset waits only 15 minutes then gives the exact final text', async () => {
    reset = T0 + 7_200_000
    const waits: number[] = []
    await start({
      waitForPi: async (delay) => {
        waits.push(delay)
        now += delay
        await runtime.main.pollNow()
        return 'elapsed'
      },
    })
    limit()
    const events = await send()
    expect(waits).toEqual([900_000])
    expect(sends).toEqual([MAIN])
    expect(text(events)).toBe(
      'Every OpenAI account has used up its quota. Resets in 1h 45m.',
    )
  })

  for (const setting of [0, 15] as const)
    for (const delay of [60_000, 7_200_000, undefined]) {
      test(`OA-61 ${setting === 0 ? 'setting zero' : 'no UI'} ${delay ?? 'unknown'} reset never waits`, async () => {
        reset = delay === undefined ? undefined : T0 + delay
        await mutateAccounts((storage) => {
          storage.routing = { ...storage.routing, maxSameAccountWait: setting }
          return storage
        }, paths)
        let waits = 0
        await start(
          {
            waitForPi: async () => {
              waits++
              return 'elapsed'
            },
          },
          setting === 0,
        )
        limit()
        expect(text(await send())).toBe(
          delay === 60_000
            ? 'Every OpenAI account has used up its quota. Resets in 1m.'
            : delay === 7_200_000
              ? 'Every OpenAI account has used up its quota. Resets in 2h 0m.'
              : 'Every OpenAI account has used up its quota.',
        )
        expect(waits).toBe(0)
        expect(sends).toEqual([MAIN])
      })
    }

  test('unknown terminal reset never starts a countdown even with UI', async () => {
    reset = undefined
    let waits = 0
    await start({
      waitForPi: async () => {
        waits++
        return 'elapsed'
      },
    })
    limit()
    expect(text(await send())).toBe(
      'Every OpenAI account has used up its quota.',
    )
    expect(waits).toBe(0)
  })

  test('Escape uses the actual request signal, clears the countdown and sends nothing', async () => {
    used = 100
    await mutateAccounts((storage) => {
      storage.killswitch = { enabled: true }
      return storage
    }, paths)
    const controller = new AbortController()
    await start()
    runtime.setWorkingMessage = (message) => {
      messages.push(message)
      if (message) controller.abort()
    }
    const events = await send({
      signal: controller.signal,
      sessionId: 'cancelled',
    })
    expect(messages).toContain(
      'Waiting for the account limit to reset · 1m · Esc to cancel',
    )
    expect(messages.at(-1)).toBeUndefined()
    expect(events).toEqual([])
    expect(sends).toEqual([])
    expect(runtime.activity.get('cancelled')).toBeUndefined()
  })

  test('a failing wait helper clears the spinner and ends the stream without replay', async () => {
    used = 100
    await mutateAccounts((storage) => {
      storage.killswitch = { enabled: true }
      return storage
    }, paths)
    await start({
      waitForPi: async (_delay, options) => {
        options.setWorkingMessage('working')
        throw new Error('wait failed')
      },
    })
    expect(text(await send())).toBe('wait failed')
    expect(messages).toEqual(['working', undefined])
    expect(sends).toEqual([])
  })

  test('presentation failures cannot mask Escape or strand the stream', async () => {
    used = 100
    await mutateAccounts((storage) => {
      storage.killswitch = { enabled: true }
      return storage
    }, paths)
    const controller = new AbortController()
    await start()
    let clears = 0
    runtime.setWorkingMessage = (message) => {
      if (message) controller.abort()
      else clears++
      throw new Error('UI unavailable')
    }
    expect(await send({ signal: controller.signal })).toEqual([])
    expect(clears).toBeGreaterThan(0)
    expect(sends).toEqual([])
  })

  test('case 11 hold wakes into killswitch final with no second wait or send', async () => {
    const waits: number[] = []
    await start({
      waitForPi: async (delay) => {
        waits.push(delay)
        now += delay
        reset = now + 7_200_000
        await runtime.main.pollNow()
        await mutateAccounts((storage) => {
          storage.killswitch = { enabled: true }
          return storage
        }, paths)
        return 'elapsed'
      },
    })
    await send({ sessionId: 'hold' })
    limit()
    expect(text(await send({ sessionId: 'hold' }))).toBe(
      'Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`). Resets in 2h 0m.',
    )
    expect(waits).toEqual([60_000])
    expect(sends).toEqual([MAIN, MAIN])
    expect(messages.at(-1)).toBeUndefined()
  })

  for (const ui of [false, true])
    test(`no-UI hold and setting zero take the same no-hold route (${ui})`, async () => {
      await addB()
      if (ui)
        await mutateAccounts((storage) => {
          storage.routing = { ...storage.routing, maxSameAccountWait: 0 }
          return storage
        }, paths)
      let waits = 0
      await start(
        {
          waitForPi: async () => {
            waits++
            return 'elapsed'
          },
        },
        ui,
      )
      await send({ sessionId: 'hold' })
      limit()
      const limited = reply
      reply = (token) => (token === MAIN ? limited(token) : ok())
      expect((await send({ sessionId: 'hold' })).at(-1)?.type).toBe('done')
      expect(sends).toEqual([MAIN, MAIN, B])
      expect(waits).toBe(0)
      expect(decisions[0]?.facts.hold).toBeUndefined()
    })

  for (const change of [
    'cache deleted',
    'cache expired',
    'new blocker',
    'identity replaced',
    'credential removed',
    'setting zero',
  ] as const) {
    test(`invalid hold checkpoint routes fresh without another wait: ${change}`, async () => {
      await addB()
      const waits: number[] = []
      let restoreCredential: (() => void) | undefined
      await start({
        waitForPi: async (delay) => {
          waits.push(delay)
          now += delay
          if (change === 'cache deleted') runtime.activity.forgetSession('hold')
          if (change === 'cache expired') now += 300_000
          if (change === 'new blocker') {
            reset = now + 120_000
            await runtime.main.pollNow()
          }
          if (change === 'identity replaced') {
            runtime.main.observeToken(jwt('replacement'))
            await runtime.main.pending()
          }
          if (change === 'credential removed') {
            const currentToken = spyOn(
              runtime.main,
              'currentToken',
            ).mockReturnValue(undefined)
            restoreCredential = () => currentToken.mockRestore()
          }
          if (change === 'setting zero')
            await mutateAccounts((storage) => {
              storage.routing = { ...storage.routing, maxSameAccountWait: 0 }
              return storage
            }, paths)
          return 'elapsed'
        },
      })
      await send({ sessionId: 'hold' })
      limit()
      const limited = reply
      reply = (token) => (token === B ? ok() : limited(token))
      const events = await send({ sessionId: 'hold' })
      restoreCredential?.()
      expect(events.at(-1)?.type).toBe('done')
      expect(waits).toEqual([60_000])
      expect(sends).toEqual([MAIN, MAIN, B])
    })
  }

  test('OA-60 published head drains its late quota error without rerouting or waiting', async () => {
    await addB()
    let waits = 0
    await start({
      waitForPi: async () => {
        waits++
        return 'elapsed'
      },
    })
    reply = () =>
      ok(
        'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached","message":"late quota limit"}}}',
      )
    const events = await send({ sessionId: 'published' })
    expect(events[0]?.type).toBe('start')
    expect(events.at(-1)?.type).toBe('error')
    expect(sends).toEqual([MAIN])
    expect(waits).toBe(0)
    expect(decisions).toEqual([])
    expect(runtime.activity.get('published')).toBeUndefined()
  })
})
