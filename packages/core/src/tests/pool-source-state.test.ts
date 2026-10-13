import { describe, expect, test } from 'bun:test'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  applyPendingPoolObservations,
  nextPoolRefreshBackoff,
  type PoolPendingObservation,
  poolOAuthAccess,
  poolRefreshBackoffFor,
  rememberPoolObservation,
} from '../pool-source-state'

function row(overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    id: 'a',
    type: 'oauth',
    identity: 'account-a',
    enabled: true,
    candidate: true,
    hasEntry: true,
    needsFirstReading: true,
    credentialEpoch: 1,
    credential: { type: 'oauth', refresh: 'refresh-a', access: 'access-a' },
    ...overrides,
  } as PoolRow
}

const now = 2_000_000
const observation = {
  checkedAt: now,
  readings: [{ label: 'primary', usedPercent: 10 }],
}

describe('shared pool source state', () => {
  test('projects OAuth credentials and leaves absent credentials empty', () => {
    expect(poolOAuthAccess(row())).toEqual({
      access: 'access-a',
      refresh: 'refresh-a',
      expires: undefined,
    })
    expect(poolOAuthAccess(row({ credential: undefined }))).toBeUndefined()
  })

  test('bounds the queue and reapplies readings before persistence catches up', () => {
    const pending = new Map<string, PoolPendingObservation[]>()
    for (let i = 0; i < 12; i++)
      rememberPoolObservation(pending, row(), observation)
    expect(pending.get('identity:account-a')).toHaveLength(8)
    expect(
      applyPendingPoolObservations(row(), pending, now).quota,
    ).toBeDefined()
  })

  test('does not replay a reading onto a replaced credential epoch', () => {
    const pending = new Map<string, PoolPendingObservation[]>()
    rememberPoolObservation(pending, row(), observation)
    expect(
      applyPendingPoolObservations(row({ credentialEpoch: 2 }), pending, now)
        .quota,
    ).toBeUndefined()
  })

  test('does not replay a reading onto another identity or after its lifetime', () => {
    const pending = new Map<string, PoolPendingObservation[]>()
    rememberPoolObservation(pending, row(), observation)
    expect(
      applyPendingPoolObservations(row({ identity: 'account-b' }), pending, now)
        .quota,
    ).toBeUndefined()
    expect(
      applyPendingPoolObservations(row(), pending, now + 30 * 60_000).quota,
    ).toBeDefined()
    expect(
      applyPendingPoolObservations(row(), pending, now + 30 * 60_000 + 1).quota,
    ).toBeUndefined()
  })

  test('distinguishes provider backoff from a short local lock retry', () => {
    const rejected = nextPoolRefreshBackoff(
      'refresh-a',
      { status: 400 },
      now,
      undefined,
    )
    expect(rejected.nextRetryAt).toBe(now + 24 * 60 * 60_000)
    expect(rejected.retryCount).toBe(1)
    const local = nextPoolRefreshBackoff(
      'refresh-a',
      new Error('lock busy'),
      now,
      rejected,
    )
    expect(local.nextRetryAt).toBe(now + 30_000)
    expect(local.retryCount).toBe(1)
    expect(
      nextPoolRefreshBackoff('refresh-b', new Error('lock busy'), now, local)
        .retryCount,
    ).toBe(0)
    expect(
      nextPoolRefreshBackoff('refresh-a', { status: 503 }, now, rejected)
        .nextRetryAt,
    ).toBe(now + 10 * 60_000)
  })

  test('reports backoff only for rows the host cannot currently send with', () => {
    const backoff = new Map([
      [
        'a',
        nextPoolRefreshBackoff(
          'refresh-a',
          new Error('lock busy'),
          now,
          undefined,
        ),
      ],
    ])
    expect([
      ...poolRefreshBackoffFor([row()], backoff, now, () => 'access-a'),
    ]).toEqual([])
    expect([
      ...poolRefreshBackoffFor([row()], backoff, now, () => undefined),
    ]).toEqual([['a', now + 30_000]])
    expect([
      ...poolRefreshBackoffFor([row()], backoff, now + 30_000, () => undefined),
    ]).toEqual([['a', now + 60_000]])
  })
})
