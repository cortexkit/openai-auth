import { expect, test } from 'bun:test'
import { sameAccountHoldFacts } from '@cortexkit/common-auth/limits'
import {
  createSessionActivityStore,
  recordSessionCompletion,
  type SessionCompletion,
  ttlForModel,
} from '../session-cache-activity'

const now = 1800000000000
const accountKey = { namespace: 'activity', accountId: 'a', incarnation: '1' }
const dispatch = {
  sessionId: 'session',
  accountKey,
  dispatchedAt: now,
  ttlMs: 300000,
}

test.each(['http', 'ws', 'pi'] as const)(
  '%s completion commits dispatch time, never the four-minute stream tail',
  (kind) => {
    const activity = createSessionActivityStore()
    const completion: SessionCompletion =
      kind === 'http'
        ? { kind, completed: true, failed: false, aborted: false }
        : kind === 'ws'
          ? { kind, event: 'response.completed', aborted: false }
          : { kind, stop: 'stop', aborted: false }
    expect(
      recordSessionCompletion(activity, dispatch, accountKey, completion),
    ).toBe(true)
    expect(activity.get('session')).toEqual({
      accountKey,
      lastAcceptedAt: now,
      ttlMs: 300000,
    })
    const hold = sameAccountHoldFacts({
      accountKey,
      activity: activity.get('session'),
    })
    expect(hold?.cacheExpiresAt).toBe(now + 300000)
    expect(hold!.cacheExpiresAt - (now + 240000)).toBe(60000)
  },
)

test('failed, cancelled, synthetic and rejected warm completions commit nothing', () => {
  const activity = createSessionActivityStore()
  const completions: SessionCompletion[] = [
    { kind: 'http', completed: true, failed: true, aborted: false },
    { kind: 'http', completed: false, failed: false, aborted: false },
    { kind: 'http', completed: true, failed: false, aborted: true },
    { kind: 'ws', event: 'response.failed', aborted: false },
    { kind: 'pi', stop: 'error', aborted: false },
    { kind: 'pi', stop: 'stop', aborted: true },
    { kind: 'synthetic' },
    { kind: 'keep-warm', status: 401, aborted: false },
  ]
  for (const completion of completions)
    expect(
      recordSessionCompletion(activity, dispatch, accountKey, completion),
    ).toBe(false)
  expect(activity.size).toBe(0)
})

test('2xx warm uses its scheduled session and rejects old accounts, incarnations and dispatches', () => {
  const activity = createSessionActivityStore()
  const warm = { kind: 'keep-warm' as const, status: 204, aborted: false }
  expect(
    recordSessionCompletion(
      activity,
      { ...dispatch, sessionId: 'scheduled', dispatchedAt: now + 1000 },
      accountKey,
      warm,
    ),
  ).toBe(true)
  expect(activity.get('session')).toBeUndefined()
  expect(
    recordSessionCompletion(
      activity,
      { ...dispatch, sessionId: 'scheduled' },
      accountKey,
      warm,
    ),
  ).toBe(false)
  expect(
    recordSessionCompletion(
      activity,
      dispatch,
      { ...accountKey, accountId: 'b' },
      warm,
    ),
  ).toBe(false)
  expect(
    recordSessionCompletion(
      activity,
      dispatch,
      { ...accountKey, incarnation: '2' },
      warm,
    ),
  ).toBe(false)
  expect(recordSessionCompletion(activity, dispatch, undefined, warm)).toBe(
    false,
  )
  expect(activity.get('scheduled')?.lastAcceptedAt).toBe(now + 1000)
  activity.forgetSession('scheduled')
  expect(activity.size).toBe(0)
})

test('activity bound evicts the oldest dispatch, not the most recently completed stream', () => {
  const activity = createSessionActivityStore()
  for (let index = 256; index >= 0; index--)
    activity.recordAccepted({
      sessionId: String(index),
      accountKey,
      currentAccountKey: accountKey,
      lastAcceptedAt: now + index,
      ttlMs: 300000,
    })
  expect(activity.size).toBe(256)
  expect(activity.get('0')).toBeUndefined()
  expect(activity.get('256')?.lastAcceptedAt).toBe(now + 256)
})

test.each([
  ['gpt-5.5', 300000],
  ['gpt-5.6', 1800000],
  ['gpt-5.6-sol', 1800000],
  ['gpt-5.10', 1800000],
  ['gpt-6', 1800000],
  ['gpt-6.1-terra', 1800000],
  ['gpt-5.60foo', 300000],
  ['gpt-4', 300000],
  ['unknown', 300000],
])('conservative model TTL for %s is %s', (model, expected) => {
  expect(ttlForModel(JSON.stringify({ model }), 300000)).toBe(expected)
})

test('invalid body uses caller default; declared TTL is separate from measured cache tails', () => {
  for (const body of ['invalid', 'null', '{}', '{"model":42}'])
    expect(ttlForModel(body, 300000)).toBe(300000)
  const activity = createSessionActivityStore()
  activity.recordAccepted({
    sessionId: 'synthetic-policy',
    accountKey,
    currentAccountKey: accountKey,
    lastAcceptedAt: now - 70 * 60000,
    ttlMs: 3600000,
  })
  recordSessionCompletion(
    activity,
    {
      ...dispatch,
      sessionId: 'synthetic-policy',
      dispatchedAt: now - 10 * 60000,
      ttlMs: 3600000,
    },
    accountKey,
    { kind: 'keep-warm', status: 200, aborted: false },
  )
  expect(
    sameAccountHoldFacts({
      accountKey,
      activity: activity.get('synthetic-policy'),
      maxSameAccountWait: 'max',
    })?.cacheExpiresAt,
  ).toBe(now + 50 * 60000)
  expect(ttlForModel('{"model":"gpt-6"}')).toBe(1800000)
})
