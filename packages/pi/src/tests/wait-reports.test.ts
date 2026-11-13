import { afterEach, expect, spyOn, test } from 'bun:test'
import { type RouteAccount, routePiRequest } from '../pool-request'

const key = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, key)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, key, original)
  else Reflect.deleteProperty(globalThis, key)
})
const now = 1_900_000_000_000

for (const arrives of [true, false]) {
  test(`Pi first quota reading reports exact start and ${arrives ? 'resumed' : 'abandoned'} end`, async () => {
    const reports: unknown[] = []
    Reflect.set(globalThis, key, (sessionId: string) => ({
      report: (payload: unknown) => reports.push([sessionId, payload]),
    }))
    const account: RouteAccount = { id: 'main', token: 'token' }
    let sends = 0
    let pulls = 0
    const result = await routePiRequest({
      accounts: () => [account],
      storage: null,
      mode: 'main-first',
      sessionId: 'quota-session',
      requestBytes: 10,
      now: () => now,
      refreshBackoff: () => new Map(),
      requestPull: async () => {
        pulls++
        if (arrives)
          account.quota = {
            limits: [
              {
                scope: 'all',
                label: 'primary',
                kind: 'reading',
                usedPercent: 10,
                checkedAt: now,
              },
            ],
          }
      },
      send: async () => {
        sends++
        return { status: 200 }
      },
      placePin: () => undefined,
    })
    const first = (reports[0] as [string, { wait_id: string }])?.[1]
    expect(first?.wait_id).toMatch(/^[0-9a-f-]{36}$/)
    const base = {
      kind: 'wait',
      wait_id: first?.wait_id,
      reason: 'quota_reading',
      message: 'Checking account quota',
    }
    expect(reports).toEqual([
      ['quota-session', { ...base, phase: 'start' }],
      [
        'quota-session',
        { ...base, phase: 'end', outcome: arrives ? 'resumed' : 'abandoned' },
      ],
    ])
    expect(result.kind).toBe(arrives ? 'sent' : 'blocked')
    expect(sends).toBe(arrives ? 1 : 0)
    expect(pulls).toBe(arrives ? 1 : 2)
  })
}

test('Pi quota wait with a custom bound below two seconds does not report', async () => {
  const reports: unknown[] = []
  Reflect.set(globalThis, key, () => ({
    report: (payload: unknown) => reports.push(payload),
  }))
  const result = await routePiRequest({
    accounts: () => [{ id: 'main', token: 'token' }],
    storage: null,
    mode: 'main-first',
    sessionId: 'quota-session',
    requestBytes: 10,
    now: () => now,
    firstReadingWaitMs: 1999,
    refreshBackoff: () => new Map(),
    requestPull: async () => {},
    send: async () => ({ status: 200 }),
    placePin: () => undefined,
  })
  expect(result.kind).toBe('blocked')
  expect(reports).toEqual([])
})

test('Pi quota wait without an accessor creates no report id', async () => {
  Reflect.deleteProperty(globalThis, key)
  const uuid = spyOn(crypto, 'randomUUID')
  try {
    await routePiRequest({
      accounts: () => [{ id: 'main', token: 'token' }],
      storage: null,
      mode: 'main-first',
      sessionId: 'quota-session',
      requestBytes: 10,
      now: () => now,
      refreshBackoff: () => new Map(),
      requestPull: async () => {},
      send: async () => ({ status: 200 }),
      placePin: () => undefined,
    })
    expect(uuid).not.toHaveBeenCalled()
  } finally {
    uuid.mockRestore()
  }
})
