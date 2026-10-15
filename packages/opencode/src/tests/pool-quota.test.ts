import { describe, expect, it } from 'bun:test'
import { mergeQuotaObservation } from '@cortexkit/common-auth/quota'
import {
  observationFromSnapshot,
  windowsFromQuotaMap,
} from '../core/pool-quota.ts'

const reset = '2030-01-01T00:00:00.000Z'

describe('pool quota conversion', () => {
  it('carries a counter-only reading including zero and ignores invalid counts', () => {
    for (const value of [0, 3]) {
      expect(
        observationFromSnapshot({ resetCreditsAvailable: value }, 1_000, false),
      ).toEqual({
        checkedAt: 1_000,
        counters: { resetCredits: { value, checkedAt: 1_000 } },
      })
    }
    for (const value of [
      undefined,
      null,
      '3',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        observationFromSnapshot({ resetCreditsAvailable: value }, 1_000, false),
      ).toBeUndefined()
    }
  })

  it('keeps window readings when the reset count is not a non-negative safe integer', () => {
    for (const value of [1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const quota = mergeQuotaObservation(
        undefined,
        observationFromSnapshot(
          {
            primary: { usedPercent: 40, resetsAt: reset, windowMinutes: 300 },
            secondary: { usedPercent: 70, windowMinutes: 10_080 },
            resetCreditsAvailable: value,
          },
          1_000,
          false,
        ),
      )
      expect(windowsFromQuotaMap(quota)).toEqual({
        primary: {
          usedPercent: 40,
          remainingPercent: 60,
          resetsAt: reset,
          windowMinutes: 300,
          checkedAt: 1_000,
        },
        secondary: {
          usedPercent: 70,
          remainingPercent: 30,
          windowMinutes: 10_080,
          checkedAt: 1_000,
        },
      })
      expect(quota.counters).toBeUndefined()
    }
  })

  it('turns both windows and the credit budget into one observation', () => {
    expect(
      observationFromSnapshot(
        {
          primary: { usedPercent: 40, resetsAt: reset, windowMinutes: 300 },
          secondary: { usedPercent: 70, windowMinutes: 10_080 },
          spendControl: {
            reached: true,
            remainingPercent: 0,
            usedPercent: 100,
            limit: 10,
            used: 10,
            remaining: 0,
            resetsAt: reset,
          },
        },
        1_000,
        false,
      ),
    ).toEqual({
      checkedAt: 1_000,
      readings: [
        {
          label: 'primary',
          usedPercent: 40,
          resetsAt: reset,
          windowMinutes: 300,
        },
        { label: 'secondary', usedPercent: 70, windowMinutes: 10_080 },
      ],
      budget: {
        kind: 'reading',
        reached: true,
        remainingPercent: 0,
        usedPercent: 100,
        limit: 10,
        used: 10,
        remaining: 0,
        resetsAt: reset,
      },
    })
  })

  it('a complete snapshot retires a window it leaves out; a partial one leaves it alone', () => {
    const stored = mergeQuotaObservation(
      undefined,
      observationFromSnapshot(
        { primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } },
        1_000,
        true,
      ),
    )
    const partial = mergeQuotaObservation(
      stored,
      observationFromSnapshot({ primary: { usedPercent: 30 } }, 2_000, false),
    )
    expect(windowsFromQuotaMap(partial)?.secondary?.usedPercent).toBe(20)
    const complete = mergeQuotaObservation(
      stored,
      observationFromSnapshot({ primary: { usedPercent: 30 } }, 2_000, true),
    )
    expect(windowsFromQuotaMap(complete)?.secondary).toBeUndefined()
    expect(windowsFromQuotaMap(complete)?.primary).toEqual({
      usedPercent: 30,
      remainingPercent: 70,
      checkedAt: 2_000,
    })
  })

  it('a cleared budget and an empty snapshot', () => {
    expect(
      observationFromSnapshot({ spendControlCleared: true }, 5, false),
    ).toEqual({ checkedAt: 5, budget: { kind: 'cleared' } })
    expect(observationFromSnapshot({}, 5, false)).toBeUndefined()
    expect(windowsFromQuotaMap(undefined)).toBeUndefined()
    expect(windowsFromQuotaMap({ limits: [] })).toBeUndefined()
  })
})
