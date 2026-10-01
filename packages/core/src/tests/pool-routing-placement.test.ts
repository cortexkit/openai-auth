// The routing modes as ordered routing places the accounts: the shared
// menu's `ordered` keeps the roster order, the two older modes move row
// `main`, and a request that cannot be replayed goes to row `main` alone.
import { describe, expect, test } from 'bun:test'
import { orderedPlacement, planOrdered } from '../pool-routing'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')

function row(id: string) {
  return {
    id,
    kind: 'oauth' as const,
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading' as const,
          checkedAt: NOW,
          usedPercent: 10,
          resetsAt: new Date(NOW + 3600_000).toISOString(),
          windowMinutes: 300,
        },
      ],
    },
  }
}

function plan(mode: string, replayable?: boolean) {
  return planOrdered({
    rows: [row('alpha'), row('main'), row('beta')],
    now: NOW,
    rateLimitMarks: new Map(),
    refreshBackoff: new Map(),
    killswitch: new Map(),
    requestPull: () => {},
    placement: orderedPlacement(mode),
    ...(replayable !== undefined ? { replayable } : {}),
  })
}

describe('ordered routing placement', () => {
  test('ordered keeps the roster order', () => {
    expect(plan('ordered')).toEqual({
      kind: 'send',
      order: ['alpha', 'main', 'beta'],
      lastPath: false,
    })
  })

  test('main-first and fallback-first move row main; an unknown mode is main-first', () => {
    expect(plan('main-first')).toMatchObject({
      order: ['main', 'alpha', 'beta'],
    })
    expect(plan('fallback-first')).toMatchObject({
      order: ['alpha', 'beta', 'main'],
    })
    expect(plan('something-older')).toMatchObject({
      order: ['main', 'alpha', 'beta'],
    })
  })

  test('a request that cannot be replayed goes to row main alone, in any mode', () => {
    expect(plan('ordered', false)).toMatchObject({ order: ['main'] })
    expect(plan('fallback-first', false)).toMatchObject({ order: ['main'] })
  })
})
