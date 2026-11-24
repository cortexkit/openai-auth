import { expect, test } from 'bun:test'
import {
  CacheKeepManager,
  createCacheKeepManager,
  createOpenAICacheKeepAdapter,
  type OpenAICacheKeepMeta,
} from '../cachekeep'
import { createSessionActivityStore } from '../session-cache-activity'

const endpoint = 'https://codex.invalid/responses'
const sessionKey = 'warm-transformation'
const ttlMs = 300_000
const leadMs = 75_000

function completed(transformed: boolean) {
  const body = `event: response.completed\r\ndata: ${JSON.stringify({
    response: {
      model: 'gpt-5.4',
      ...(transformed && {
        input_transformations: [
          { action: 'removed', type: 'reasoning', reason: 'prefix_mismatch' },
        ],
      }),
    },
  })}\r\n\r\n`
  const encoder = new TextEncoder()
  const split = body.indexOf('\n')
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, split)))
        controller.enqueue(encoder.encode(body.slice(split)))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

for (const hadWarm of [false, true]) {
  test(`transformed warm drops the target ${hadWarm ? 'after a clean warm' : 'on its first send'}`, async () => {
    const routing = Symbol.for('cortexkit.routing')
    const original = Object.getOwnPropertyDescriptor(globalThis, routing)
    const reports: unknown[] = []
    Reflect.set(globalThis, routing, (sessionId: string) => ({
      report(value: unknown) {
        if (sessionId === sessionKey) reports.push(value)
      },
    }))
    let now = 1_800_000_000_000
    let sends = 0
    const activity = createSessionActivityStore()
    const accountKey = {
      namespace: 'pool-test',
      accountId: 'main',
      incarnation: '1',
    }
    const manager = createCacheKeepManager({
      codexResponsesUrl: endpoint,
      getMainToken: async () => 'token',
      refreshFallback: async () => {
        throw new Error('Unexpected account')
      },
      fetchImpl: Object.assign(
        async () => {
          sends++
          return completed(!hadWarm || sends > 1)
        },
        {
          preconnect: () => {},
        },
      ),
      now: () => now,
      activity: { store: activity, accountKey: () => accountKey },
      ttlMs,
      leadMs,
    })
    const tick = () => {
      now += ttlMs - leadMs + 1
      return manager.tick()
    }
    try {
      manager.track({
        sessionKey,
        accountId: 'main',
        bodyText: '{"model":"gpt-5.4"}',
        meta: { replayHeaders: {} },
      })
      if (hadWarm) {
        await tick()
        expect(manager.status().targets[0]?.warmCount).toBe(1)
        expect(reports).toEqual([
          { kind: 'cache_touch', at: now, ttl_ms: 'implicit', source: 'warm' },
        ])
        reports.length = 0
      }
      const priorActivity = activity.get(sessionKey)
      expect(priorActivity?.lastAcceptedAt).toBe(hadWarm ? now : undefined)
      await tick()
      expect(manager.status().tracked).toBe(0)
      expect(reports).toEqual(
        hadWarm
          ? [{ kind: 'cache_warm_stopped', at: now, reason: 'session-ended' }]
          : [],
      )
      expect(activity.get(sessionKey)).toEqual(priorActivity)
      await tick()
      expect(sends).toBe(hadWarm ? 2 : 1)
    } finally {
      manager.stop()
      if (original) Object.defineProperty(globalThis, routing, original)
      else Reflect.deleteProperty(globalThis, routing)
    }
  })
}

test('one tick touches only the clean session when warm reports arrive later', async () => {
  const routing = Symbol.for('cortexkit.routing')
  const original = Object.getOwnPropertyDescriptor(globalThis, routing)
  const touched: string[] = []
  Reflect.set(globalThis, routing, (sessionId: string) => ({
    report(value: { kind: string; source?: string }) {
      if (value.kind === 'cache_touch' && value.source === 'warm')
        touched.push(sessionId)
    },
  }))
  let now = 1_800_000_000_000
  const sent: (string | null)[] = []
  const clean = 'warm-clean'
  const report = Promise.withResolvers<void>()
  const reports: Promise<unknown>[] = []
  const adapter = createOpenAICacheKeepAdapter(
    {
      codexResponsesUrl: endpoint,
      getMainToken: async () => 'token',
      refreshFallback: async () => 'token',
      fetchImpl: Object.assign(
        async (_url: unknown, init?: RequestInit) => {
          const sessionId = new Headers(init?.headers).get('session-id')
          sent.push(sessionId)
          return completed(sessionId === sessionKey)
        },
        { preconnect: () => {} },
      ),
    },
    (key) => manager.remove(key),
  )
  const manager: CacheKeepManager<OpenAICacheKeepMeta> = new CacheKeepManager({
    adapter: {
      ...adapter,
      onWarmed(key, input) {
        const pending = report.promise.then(() =>
          adapter.onWarmed?.(key, input),
        )
        reports.push(pending)
        return pending
      },
    },
    now: () => now,
    ttlMs,
    leadMs,
  })
  try {
    for (const key of [sessionKey, clean])
      manager.track({
        sessionKey: key,
        accountId: 'main',
        bodyText: '{"model":"gpt-5.4"}',
        meta: { replayHeaders: { 'session-id': key } },
      })
    now += ttlMs - leadMs + 1
    await manager.tick()
    expect(sent).toEqual([sessionKey, clean])
    expect(touched).toEqual([])
    report.resolve()
    await Promise.all(reports)
    expect(touched).toEqual([clean])
    expect(manager.status().targets.map((target) => target.sessionKey)).toEqual(
      [clean],
    )
  } finally {
    report.resolve()
    await Promise.all(reports)
    manager.stop()
    if (original) Object.defineProperty(globalThis, routing, original)
    else Reflect.deleteProperty(globalThis, routing)
  }
})
