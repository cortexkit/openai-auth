import { describe, expect, test } from 'bun:test'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import {
  type PoolRoutingInput,
  planOrdered,
  waitForFirstQuotaReading,
} from '../pool-routing'
import { VAULT_REQUEST_ROSTER_WAIT_MS } from '../vault'

const quota = (checkedAt = Date.now()): QuotaMap => ({
  limits: [
    {
      scope: 'all',
      label: 'primary',
      kind: 'reading',
      checkedAt,
      usedPercent: 5,
      resetsAt: new Date(Date.now() + 3600_000).toISOString(),
      windowMinutes: 300,
    },
  ],
})

function input(
  requestPull: PoolRoutingInput['requestPull'],
  reading?: QuotaMap,
): PoolRoutingInput {
  return {
    rows: [{ id: 'vault-work', kind: 'oauth', quota: reading }],
    now: Date.now(),
    rateLimitMarks: new Map(),
    refreshBackoff: new Map(),
    killswitch: new Map(),
    requestPull,
  }
}

const plan = (routing: PoolRoutingInput) =>
  planOrdered({ ...routing, placement: 'roster' })

describe('first quota reading admission', () => {
  test('unknown quota waits for an in-flight first reading and serves with its result', async () => {
    let complete!: () => void
    const inFlight = new Promise<void>((resolve) => {
      complete = resolve
    })
    let pulls = 0
    const routing = input(() => {
      pulls++
      return inFlight
    })
    const waiting = waitForFirstQuotaReading(routing)
    expect(waiting).toBeDefined()
    let settled = false
    void waiting?.then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(pulls).toBe(1)
    routing.rows = [{ id: 'vault-work', kind: 'oauth', quota: quota() }]
    complete()
    await waiting
    expect(plan(routing)).toEqual({
      kind: 'send',
      order: ['vault-work'],
      lastPath: false,
    })
  })

  test('unknown quota requests a first reading and serves when it lands', async () => {
    let pulls = 0
    const routing = input(async () => {
      pulls++
      await Promise.resolve()
      routing.rows = [{ id: 'vault-work', kind: 'oauth', quota: quota() }]
    })
    await waitForFirstQuotaReading(routing)
    expect(pulls).toBe(1)
    expect(plan(routing).kind).toBe('send')
  })

  test('unknown quota still refuses when no first reading arrives within the bound', async () => {
    const routing = input(() => new Promise<void>(() => {}))
    const start = Date.now()
    await waitForFirstQuotaReading(routing)
    expect(Date.now() - start).toBeGreaterThanOrEqual(
      VAULT_REQUEST_ROSTER_WAIT_MS - 100,
    )
    expect(plan(routing)).toEqual({
      kind: 'block',
      block: { reason: 'quota-unknown' },
    })
  }, 5_000)

  test('an unreadable first reading still refuses without trusting pull completion', async () => {
    const failed = Promise.reject(new Error('unreadable'))
    void failed.catch(() => {})
    const routing = input(() => failed)
    await waitForFirstQuotaReading(routing)
    expect(plan(routing).kind).toBe('block')
  })

  test('known quota incurs no wait or first-reading pull', () => {
    let pulls = 0
    const routing = input(() => {
      pulls++
      return new Promise<void>(() => {})
    }, quota())
    expect(waitForFirstQuotaReading(routing)).toBeUndefined()
    expect(pulls).toBe(0)
    expect(plan(routing).kind).toBe('send')
  })

  test('stale but present quota stays on the normal admission path', () => {
    let pulls = 0
    const routing = input(
      () => {
        pulls++
        return new Promise<void>(() => {})
      },
      quota(Date.now() - 24 * 3600_000),
    )
    expect(waitForFirstQuotaReading(routing)).toBeUndefined()
    expect(pulls).toBe(0)
  })

  test('a healthy alternative serves without waiting for another account first reading', () => {
    let pulls = 0
    const routing = input(() => {
      pulls++
      return new Promise<void>(() => {})
    })
    routing.rows = [
      ...routing.rows,
      { id: 'ready', kind: 'oauth', quota: quota() },
    ]
    expect(waitForFirstQuotaReading(routing)).toBeUndefined()
    expect(pulls).toBe(0)
    expect(plan(routing)).toEqual({
      kind: 'send',
      order: ['ready'],
      lastPath: false,
    })
  })

  test('rate-limited, backed-off and killswitched candidates do not wait', () => {
    for (const block of ['rate', 'refresh', 'killswitch']) {
      let pulls = 0
      const routing = input(() => {
        pulls++
        return new Promise<void>(() => {})
      })
      if (block === 'rate')
        routing.rateLimitMarks = new Map([['vault-work', Date.now() + 10_000]])
      if (block === 'refresh')
        routing.refreshBackoff = new Map([['vault-work', Date.now() + 10_000]])
      if (block === 'killswitch')
        routing.killswitch = new Map([['vault-work', false]])
      expect(waitForFirstQuotaReading(routing)).toBeUndefined()
      expect(pulls).toBe(0)
    }
  })
})
