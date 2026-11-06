import { afterEach, expect, test } from 'bun:test'
import { readMaxSameAccountWait, routingHoldWaitMaxS } from '../routing-wait'

const symbol = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, symbol, original)
  else Reflect.deleteProperty(globalThis, symbol)
})
const now = 1800000000000
const accountKey = { namespace: 'wait', accountId: 'r1', incarnation: '1' }
const activity = { accountKey, lastAcceptedAt: now, ttlMs: 1800000 }

test('settings normalize without coercion', () => {
  for (const value of [
    undefined,
    null,
    false,
    '0',
    '15',
    'MAX',
    -1,
    1,
    30,
    Infinity,
    {},
  ])
    expect(readMaxSameAccountWait(value)).toBe(15)
  for (const value of [0, 15, 'max'] as const)
    expect(readMaxSameAccountWait(value)).toBe(value)
})

test.each([
  { setting: 0, expected: 0 },
  { setting: 15, expected: 900 },
  { setting: 'max', expected: 1799 },
])(
  'routing accessor caps $setting using remaining activity and floors seconds',
  ({ setting, expected }) => {
    Reflect.set(globalThis, symbol, () => ({ accountFor() {} }))
    expect(
      routingHoldWaitMaxS({
        sessionId: 's',
        accountKey,
        activity,
        now: now + 1,
        maxSameAccountWait: setting,
      }),
    ).toBe(expected)
  },
)

test('missing, expired or replaced activity gives explicit zero with usable accessor', () => {
  Reflect.set(globalThis, symbol, () => ({ accountFor() {} }))
  for (const input of [
    { accountKey },
    { activity },
    {},
    { accountKey: { ...accountKey, incarnation: '2' }, activity },
    { accountKey, activity: { ...activity, ttlMs: 0 } },
    { accountKey, activity: { ...activity, lastAcceptedAt: now - 1800000 } },
  ])
    expect(routingHoldWaitMaxS({ ...input, sessionId: 's', now })).toBe(0)
  expect(
    routingHoldWaitMaxS({
      accountKey,
      activity,
      sessionId: 's',
      now: now + 1799500,
    }),
  ).toBe(0)
})

test('absent and broken accessors leave the cap unset', () => {
  for (const accessor of [
    undefined,
    () => undefined,
    () => ({}),
    () => {
      throw new Error('broken')
    },
  ]) {
    Reflect.set(globalThis, symbol, accessor)
    expect(
      routingHoldWaitMaxS({ sessionId: 's', accountKey, activity, now }),
    ).toBeUndefined()
    expect(routingHoldWaitMaxS({ sessionId: 's', now })).toBeUndefined()
  }
})
