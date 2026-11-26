import { expect, test } from 'bun:test'
import { mergeQuotaObservation } from '@cortexkit/common-auth/quota'
import { observationFromSnapshot } from '../pool-quota'
import { planOrdered } from '../pool-routing'
import { normalizeWham } from '../quota-normalize'

test('wham preserves an explicit spend-control verdict even when a display number is missing', () => {
  const individualLimit = {
    limit: '100',
    used: '25',
    used_percent: '25',
    remaining_percent: '75',
  }
  const snapshot = normalizeWham({
    rate_limit: {},
    spend_control: { reached: false, individual_limit: individualLimit },
  })
  expect(snapshot.spendControl).toEqual({
    limit: 100,
    used: 25,
    usedPercent: 25,
    remainingPercent: 75,
    reached: false,
  })
  const budgetOnly = observationFromSnapshot(snapshot, 1, false)
  expect(budgetOnly?.budget).toEqual({
    kind: 'reading',
    limit: 100,
    used: 25,
    usedPercent: 25,
    remainingPercent: 75,
    reached: false,
  })
  const unknown = normalizeWham({
    rate_limit: {},
    spend_control: { individual_limit: { ...individualLimit, remaining: 75 } },
  })
  expect(unknown.spendControl).toBeUndefined()
  const noVerdict = observationFromSnapshot(unknown, 1, false)
  expect(noVerdict?.budget).toBeUndefined()

  for (const observed of [budgetOnly, noVerdict]) {
    expect(
      planOrdered({
        rows: [
          {
            id: 'main',
            kind: 'oauth',
            quota: observed && mergeQuotaObservation({ limits: [] }, observed),
          },
        ],
        placement: 'roster',
        now: 1,
        rateLimitMarks: new Map(),
        killswitch: new Map(),
        refreshBackoff: new Map(),
        requestPull() {},
      }),
    ).toEqual({ kind: 'block', block: { reason: 'quota-unknown' } })
  }
})
