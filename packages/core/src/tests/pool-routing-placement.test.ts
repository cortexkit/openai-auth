// The routing modes as ordered routing places the accounts: the shared
// menu's `ordered` keeps the roster order, the two older modes move row
// `main`, and a request that cannot be replayed goes to row `main` alone.
import { describe, expect, test } from 'bun:test'
import {
  orderedPlacement,
  planOrdered,
  vaultMainRouteId,
} from '../pool-routing'

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
  test('vault main mapping uses only the exact default credential and preserves its route id', () => {
    const routes = [
      { id: 'vault:work~a', credentialId: 'chatgpt:openai:work' },
      { id: 'vault:default~b', credentialId: 'chatgpt:openai' },
    ]
    expect(vaultMainRouteId(routes)).toBe('vault:default~b')
    expect(vaultMainRouteId(routes.slice(0, 1))).toBeNull()
  })

  test('vault main mapping never assigns a local row the main role', () => {
    expect(
      vaultMainRouteId([
        { id: 'main', credentialId: 'chatgpt:openai' },
        { id: 'local', credentialId: 'chatgpt:openai' },
        { id: 'vault:work~a', credentialId: 'chatgpt:openai:work' },
      ]),
    ).toBeNull()
  })

  test('an explicitly absent vault main keeps roster order even beside a local main id', () => {
    const input = {
      rows: [row('alpha'), row('main'), row('beta')],
      now: NOW,
      rateLimitMarks: new Map<string, number>(),
      refreshBackoff: new Map<string, number>(),
      killswitch: new Map<string, boolean>(),
      requestPull: () => {},
      mainId: null,
    }
    for (const mode of ['ordered', 'main-first', 'fallback-first']) {
      expect(
        planOrdered({ ...input, placement: orderedPlacement(mode) }),
      ).toMatchObject({ order: ['alpha', 'main', 'beta'] })
    }
    expect(
      planOrdered({
        ...input,
        mainId: 'beta',
        placement: 'roster',
        replayable: false,
      }),
    ).toMatchObject({ order: ['beta'] })
  })

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
