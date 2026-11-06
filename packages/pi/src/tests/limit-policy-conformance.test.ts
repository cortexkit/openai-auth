import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as limits from '@cortexkit/common-auth/limits'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  mutateAccounts,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import {
  errorEvent,
  PiOpenAIRuntime,
  type PiOpenAIRuntimeDeps,
} from '../runtime.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()
const NOW = 1_800_000_000_000
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
function jwt(identity: string) {
  return `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: identity } })).toString('base64url')}.sig`
}
const MAIN = jwt('main')
const B = jwt('beta')
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  status: number,
  head: 'error' | 'start' | 'throw',
  floors?: {
    primary: number
    secondary: number
    policy?: AccountStorage['killswitch']
  },
  hold?: { cache: boolean; secondary: number },
) {
  const home = mkdtempSync(join(tmpdir(), 'pi-limit-conformance-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const paths = {
    configPath: join(home, 'pool.json'),
    statePath: join(home, 'state.json'),
  }
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
      refresh: 'b-refresh',
      expires: NOW + 86_400_000,
    },
  })
  await mutateAccounts((storage) => {
    storage.killswitch = floors?.policy ?? { enabled: !!floors }
    storage.routing = { mode: 'main-first', maxSameAccountWait: 15 }
    return storage
  }, paths)
  const attempts: string[] = []
  const waits: number[] = []
  let now = NOW
  let recovered = false
  const streamSimple: PiOpenAIRuntimeDeps['streamSimple'] = (
    model,
    _context,
    options,
  ) => {
    const token = options?.apiKey ?? ''
    attempts.push(token)
    if (token === MAIN && head === 'throw')
      throw new Error('setup failed before status')
    const stream = createAssistantMessageEventStream()
    void (async () => {
      const failed =
        token === MAIN &&
        !(hold && (recovered || (hold.cache && attempts.length === 1)))
      await options?.onResponse?.(
        {
          status: failed ? status : 200,
          headers:
            hold && failed
              ? {
                  'x-codex-primary-used-percent': '100',
                  'x-codex-primary-window-minutes': '300',
                  'x-codex-primary-reset-at': String((NOW + 60_000) / 1000),
                  'x-codex-secondary-used-percent': '100',
                  'x-codex-secondary-window-minutes': '10080',
                  'x-codex-secondary-reset-at': String(
                    (NOW + hold.secondary) / 1000,
                  ),
                }
              : {},
        },
        model,
      )
      const event = errorEvent(
        model,
        failed ? 'original A event' : 'selected B event',
      )
      if (event.type !== 'error')
        throw new Error('error fixture must contain an assistant message')
      if (failed && head === 'error') stream.push(event)
      else {
        stream.push({ type: 'start', partial: event.error })
        stream.push({
          type: 'done',
          reason: 'stop',
          message: { ...event.error, stopReason: 'stop' },
        })
      }
      stream.end()
    })().catch((error) => {
      stream.push(errorEvent(model, String(error)))
      stream.end()
    })
    return stream
  }
  const runtime = new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    now: () => now,
    firstReadingWaitMs: 0,
    waitForPi: async (delay) => {
      waits.push(delay)
      now += delay
      recovered = true
      return 'elapsed'
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        rate_limit: {
          primary_window: {
            used_percent:
              new Headers(init?.headers).get('authorization') ===
              `Bearer ${MAIN}`
                ? 100 - (floors?.primary ?? 90)
                : 10,
            limit_window_seconds: 18_000,
            reset_at: (NOW + 7_200_000) / 1000,
          },
          secondary_window: {
            used_percent:
              new Headers(init?.headers).get('authorization') ===
              `Bearer ${MAIN}`
                ? 100 - (floors?.secondary ?? 90)
                : 10,
            limit_window_seconds: 604_800,
            reset_at: (NOW + 7_200_000) / 1000,
          },
        },
      })) as unknown as typeof fetch,
  })
  if (hold) runtime.setWorkingMessage = () => {}
  cleanups.push(async () => {
    await runtime.pool.dispose()
    await runtime.vault.dispose()
  })
  await runtime.start()
  await runtime.pool.settled()
  runtime.main.observeToken(MAIN)
  await runtime.main.pending()
  const send = async (model = MODEL) => {
    const events: AssistantMessageEvent[] = []
    for await (const event of runtime.stream(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey: MAIN, sessionId: 'conformance' },
    ))
      events.push(event)
    return events
  }
  return { runtime, attempts, send, store, waits }
}

describe('Pi limit-policy conformance', () => {
  test('OA-58 original confirmed refusal without cache migrates without waiting', async () => {
    const f = await fixture(429, 'error', undefined, {
      cache: false,
      secondary: 120_000,
    })
    await f.send()
    expect(f.attempts).toEqual([MAIN, B])
    expect(f.waits).toEqual([])
  })

  test('OA-58 fitting-cache companion waits for every blocker then retries A before publication', async () => {
    const f = await fixture(429, 'error', undefined, {
      cache: true,
      secondary: 120_000,
    })
    await f.send()
    const events = await f.send()
    expect(f.attempts).toEqual([MAIN, MAIN, MAIN])
    expect(f.waits).toEqual([120_000])
    expect(events.map((event) => event.type)).toEqual(['start', 'done'])
  })

  test('OA-58 four-day blocker companion cannot wait despite fitting primary and cache', async () => {
    const f = await fixture(429, 'error', undefined, {
      cache: true,
      secondary: 345_600_000,
    })
    await f.send()
    await f.send()
    expect(f.attempts).toEqual([MAIN, MAIN, B])
    expect(f.waits).toEqual([])
  })

  for (const [primary, secondary, expected] of [
    [5, 10, MAIN],
    [4.999, 10, B],
    [5, 9.999, B],
  ] as const) {
    test(`OA-43 floor boundary ${primary}/${secondary} selects the admitted account`, async () => {
      const f = await fixture(200, 'start', { primary, secondary })
      await f.send()
      expect(f.attempts).toEqual([expected])
    })
  }

  test('OA-43 account-specific floor replaces the defaults whole', async () => {
    const f = await fixture(200, 'start', {
      primary: 1,
      secondary: 1,
      policy: {
        enabled: true,
        schema: 'floors-v1',
        defaults: { primary: 5, secondary: 10 },
        accounts: { main: { primary: 1 } },
      },
    })
    await f.send()
    expect(f.attempts).toEqual([MAIN])
  })

  for (const status of [401, 403, 429]) {
    for (const head of ['error', 'start'] as const) {
      test(`OA-57 ordered captured ${status} with ${head} head routes before publication`, async () => {
        const f = await fixture(status, head)
        const events = await f.send()
        expect(f.attempts).toEqual([MAIN, B])
        expect(events.map((event) => event.type)).toEqual(['start', 'done'])
        expect(JSON.stringify(events)).not.toContain('original A event')
        expect(JSON.stringify(events)).toContain('selected B event')
      })
    }
  }

  test('OA-57 synchronous setup throw has no captured status and cannot advance', async () => {
    const f = await fixture(429, 'throw')
    const events = await f.send()
    expect(f.attempts).toEqual([MAIN])
    expect(events.map((event) => event.type)).toEqual(['error'])
    expect(JSON.stringify(events)).toContain('setup failed before status')
  })

  test('OA-1-26 Pi never acquires a mark registry on first request or projection change', async () => {
    const acquire = spyOn(limits, 'acquireLimitsRegistry').mockImplementation(
      () => {
        throw new Error('Pi cannot own timed marks')
      },
    )
    cleanups.push(() => acquire.mockRestore())
    const f = await fixture(429, 'start')
    await f.send()
    await f.store.add({
      id: 'gamma',
      identity: 'gamma',
      credential: {
        type: 'oauth',
        access: jwt('gamma'),
        refresh: 'gamma-refresh',
        expires: NOW + 86_400_000,
      },
    })
    await f.send({ ...MODEL, id: 'gpt-5.6' })
    expect(acquire).not.toHaveBeenCalled()
    expect(f.attempts).toEqual([MAIN, B, MAIN, B])
  })
})
