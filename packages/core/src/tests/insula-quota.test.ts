import { describe, expect, test } from 'bun:test'
import type { InsulaUsageEntry } from '@cortexkit/common-auth/claustrum'
import { normalizeInsulaCodexQuota } from '../insula-quota'

const fetchedAt = 1_700_000_000_000
const context = { fetchedAt }
const entry: InsulaUsageEntry = {
  provider: 'codex',
  usage: {
    primary: {
      usedPercent: 0,
      rawUsedPercent: 100,
      windowMinutes: 300,
      resetsAt: '2026-10-15T00:00:00Z',
    },
    secondary: { usedPercent: 12, windowMinutes: 10080 },
  },
  savedResets: { availableCount: 2 },
}

describe('insula codex normalization', () => {
  test('credits pools carry only published balance and blocking overage facts at fetch time', () => {
    const reading = (pool: Record<string, unknown>) =>
      normalizeInsulaCodexQuota(
        {
          ...entry,
          spend: [
            {
              id: 'credits',
              label: 'Prepaid credits',
              funding: 'unknown',
              basis: 'reported',
              ...pool,
            },
          ],
        },
        context,
      )?.credits
    expect(
      reading({ remaining: { minor: 125, exponent: 1, unit: 'credit' } }),
    ).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 12.5,
      checkedAt: fetchedAt,
    })
    expect(reading({ basis: 'unstated' })).toEqual({
      hasCredits: true,
      unlimited: false,
      checkedAt: fetchedAt,
    })
    expect(
      reading({
        spendable: false,
        remaining: { minor: 0, exponent: 1, unit: 'credit' },
      }),
    ).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 0,
      overageLimitReached: true,
      checkedAt: fetchedAt,
    })
    expect(reading({ spendable: true })?.overageLimitReached).toBeUndefined()
    expect(
      reading({ remaining: { minor: -1, exponent: 1 } })?.balance,
    ).toBeUndefined()
  })

  test('raw usage beats the saved-reset published zero', () => {
    const reading = normalizeInsulaCodexQuota(entry, context)
    expect(reading?.primary.usedPercent).toBe(100)
    expect(reading?.primary.remainingPercent).toBe(0)
    expect(reading?.secondary?.usedPercent).toBe(12)
    expect(reading?.resetCreditsAvailable).toBe(2)
    expect(reading?.credits).toBeUndefined()
  })

  test('every reading time equals fetchedAt', () => {
    const reading = normalizeInsulaCodexQuota(entry, context)
    expect(reading?.primary.checkedAt).toBe(fetchedAt)
    expect(reading?.secondary?.checkedAt).toBe(fetchedAt)
    expect(reading?.primary.resetsAt).toBe('2026-10-15T00:00:00Z')
    expect(reading?.primary.windowMinutes).toBe(300)
  })

  test.each([undefined, true, false])(
    'maps the individual spend pool with spendable %s',
    (spendable) => {
      const reading = normalizeInsulaCodexQuota(
        {
          ...entry,
          spend: [
            {
              id: 'credits',
              remaining: { minor: 99999, exponent: 2, unit: 'credit' },
            },
            {
              id: 'individual_limit',
              total: { minor: 10000, exponent: 1, unit: 'credit' },
              remaining: { minor: 7495, exponent: 1, unit: 'credit' },
              resetsAt: '2026-11-01T00:00:00Z',
              ...(spendable !== undefined && { spendable }),
            },
          ],
        },
        context,
      )
      expect(reading?.spendControl).toEqual({
        limit: 1000,
        used: 250.5,
        remaining: 749.5,
        usedPercent: 25.05,
        remainingPercent: 74.95,
        unit: 'credit',
        resetsAt: '2026-11-01T00:00:00Z',
        reached: spendable === false,
      })
      expect(reading?.spendControlCleared).toBeUndefined()
    },
  )

  test('absence of an individual pool explicitly clears spend control', () => {
    expect(normalizeInsulaCodexQuota(entry, context)?.spendControlCleared).toBe(
      true,
    )
    expect(
      normalizeInsulaCodexQuota({ ...entry, spend: [] }, context)
        ?.spendControlCleared,
    ).toBe(true)
  })

  test('a reached zero spend limit is still a budget reading', () => {
    const reading = normalizeInsulaCodexQuota(
      {
        ...entry,
        spend: [
          {
            id: 'individual_limit',
            spendable: false,
            total: { minor: 0, exponent: 1, unit: 'credit' },
            remaining: { minor: 0, exponent: 1, unit: 'credit' },
          },
        ],
      },
      context,
    )
    expect(reading?.spendControl).toMatchObject({
      limit: 0,
      remaining: 0,
      used: 0,
      reached: true,
      usedPercent: 100,
    })
    expect(reading?.spendControlCleared).toBeUndefined()
  })

  test('unusable primary falls back without inventing a window', () => {
    expect(
      normalizeInsulaCodexQuota({ provider: 'codex', usage: {} }, context),
    ).toBeUndefined()
    for (const usedPercent of [Number.NaN, -1, 101]) {
      expect(
        normalizeInsulaCodexQuota(
          { ...entry, usage: { primary: { usedPercent } } },
          context,
        ),
      ).toBeUndefined()
    }
    expect(
      normalizeInsulaCodexQuota(
        {
          ...entry,
          usage: { primary: { usedPercent: 0, rawUsedPercent: Number.NaN } },
        },
        context,
      ),
    ).toBeUndefined()
  })
})
