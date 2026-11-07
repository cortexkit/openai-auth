import { afterEach, expect, test } from 'bun:test'
import {
  reportSessionCacheResponse,
  sessionCacheKeepPlan,
  shouldCaptureSessionCache,
} from '../session-cache-policy'

const routing = globalThis as Record<symbol, unknown>
const key = Symbol.for('cortexkit.routing')
afterEach(() => {
  delete routing[key]
})

test('OC1 and OC2 response reporting preserves the exact input response without an accessor', async () => {
  for (const sessionId of ['opencode-1-session', 'opencode-2-session']) {
    const response = new Response('host reply')
    expect(reportSessionCacheResponse(response, sessionId)).toBe(response)
    expect(response.body!.locked).toBe(false)
    expect(await response.text()).toBe('host reply')
  }
})

test('cache plans read the accessor afresh and never supply TTL or invented prices', () => {
  expect(sessionCacheKeepPlan('ses')).toBeUndefined()
  let policy: unknown = null
  const sessions: string[] = []
  routing[key] = (id: string) => {
    sessions.push(id)
    return { cache: () => policy }
  }
  expect(sessionCacheKeepPlan('ses')).toBeUndefined()
  policy = { ttl: 'long' }
  expect(sessionCacheKeepPlan('ses')).toBeUndefined()
  for (const mode of ['off', 'always', 'auto'] as const) {
    policy = { keep_warm: mode }
    expect(sessionCacheKeepPlan('ses')).toEqual({ mode, hours: undefined })
  }
  const hours = { from: '22:30', to: '06:15', tz: 'Europe/Istanbul' }
  policy = { keep_warm: 'hours', hours, ttl: 'short' }
  expect(sessionCacheKeepPlan('ses')).toEqual({ mode: 'hours', hours })
  expect(sessions).toEqual(Array(6).fill('ses'))
})

test('no accessor and null cache retain both standalone settings; plans override only warming', () => {
  for (const enabled of [false, true]) {
    expect(shouldCaptureSessionCache('ses', enabled)).toBe(enabled)
  }
  let policy: unknown = null
  routing[key] = () => ({ cache: () => policy })
  for (const enabled of [false, true]) {
    expect(shouldCaptureSessionCache('ses', enabled)).toBe(enabled)
  }
  policy = { keep_warm: 'off' }
  expect(shouldCaptureSessionCache('ses', true)).toBe(false)
  policy = { keep_warm: 'always' }
  expect(shouldCaptureSessionCache('ses', false)).toBe(true)
})

test('response touches wait for host consumption and carry the actual implicit lifetime', async () => {
  const reports: unknown[] = []
  routing[key] = (id: string) => ({
    report: (value: unknown) => reports.push([id, value]),
  })
  const response = reportSessionCacheResponse(
    new Response('reply'),
    'ses',
    () => 1234,
  )
  // Let eager stream pulls and timers run before the host reads the reply.
  await Bun.sleep(5)
  expect(reports).toEqual([])
  expect(await response.text()).toBe('reply')
  expect(reports).toEqual([])
  await Bun.sleep(5)
  expect(reports).toEqual([
    [
      'ses',
      {
        kind: 'cache_touch',
        at: 1234,
        ttl_ms: 'implicit',
        source: 'response',
      },
    ],
  ])
})

test('unsuccessful, failed and cancelled replies never report touches', async () => {
  const reports: unknown[] = []
  routing[key] = () => ({ report: (value: unknown) => reports.push(value) })
  await reportSessionCacheResponse(
    new Response('no', { status: 500 }),
    'ses',
  ).text()
  await reportSessionCacheResponse(new Response('not owned'), undefined).text()
  await reportSessionCacheResponse(new Response('cancel'), 'ses').body!.cancel()
  const failed = reportSessionCacheResponse(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('body failed'))
        },
      }),
    ),
    'ses',
  )
  await expect(failed.text()).rejects.toThrow('body failed')
  await Bun.sleep(5)
  expect(reports).toEqual([])
})

test('bodyless successful replies report on a later turn and bridge rejection is harmless', async () => {
  const reports: unknown[] = []
  routing[key] = () => ({
    report: (value: unknown) => {
      reports.push(value)
      return Promise.reject(new Error('bridge unavailable'))
    },
  })
  const response = reportSessionCacheResponse(
    new Response(null, { status: 204 }),
    'ses',
    () => 42,
  )
  expect(response.status).toBe(204)
  expect(reports).toEqual([])
  await Bun.sleep(5)
  expect(reports).toEqual([
    { kind: 'cache_touch', at: 42, ttl_ms: 'implicit', source: 'response' },
  ])
})
