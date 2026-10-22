// Prepaid credits as a fallback tier. A ChatGPT workspace can hold prepaid
// credits, and the Codex backend keeps serving an account from them after
// its rate-limit windows are used up. Credits cost money, so an account with
// free quota always serves first; an account whose windows are spent but
// whose credits are usable serves only when no account has free quota, and
// before the last path. These tests run the shared routing rule every host
// uses (`pool-routing.ts`).
import { describe, expect, test } from 'bun:test'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import type { RoutingRow } from '@cortexkit/common-auth/routing'
import type { AccountStorage } from '../accounts'
import {
  CreditsServing,
  creditsFallbackIds,
  creditsUsable,
  orderedPlacement,
  type PoolRoutingInput,
  planOrdered,
  poolKillswitchVerdicts,
  routePinnedRow,
  selectStickyRow,
} from '../pool-routing'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const HOUR = 3600_000
const MINUTE = 60_000
const MODES = ['ordered', 'main-first', 'fallback-first'] as const

type Credits = NonNullable<QuotaMap['credits']>

const usable: Credits = {
  hasCredits: true,
  unlimited: false,
  balance: 50,
  checkedAt: NOW,
}

/** One primary reading, optionally with credits and a reached spending cap. */
function quota(
  usedPercent: number,
  options: { credits?: Credits; budgetReached?: boolean } = {},
): QuotaMap {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt: NOW,
        usedPercent,
        resetsAt: new Date(NOW + HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
    ...(options.credits ? { credits: options.credits } : {}),
    ...(options.budgetReached
      ? {
          budget: {
            kind: 'reading',
            checkedAt: NOW,
            reached: true,
            remainingPercent: 0,
            resetsAt: new Date(NOW + 24 * HOUR).toISOString(),
          },
        }
      : {}),
  }
}

const free = () => quota(20)
const spent = () => quota(100)
const onCredits = (credits: Credits = usable) => quota(100, { credits })

function row(id: string, map: QuotaMap): RoutingRow {
  return { id, kind: 'oauth', quota: map }
}

function input(
  rows: RoutingRow[],
  killswitch = new Map<string, boolean>(),
): PoolRoutingInput {
  return {
    rows,
    now: NOW,
    rateLimitMarks: new Map(),
    refreshBackoff: new Map(),
    killswitch,
    requestPull: () => {},
  }
}

const sticky = {
  requestBytes: 1,
  reservePercent: () => ({}),
  resetCredits: () => undefined,
}

function place(routing: PoolRoutingInput, exclude: string[] = []) {
  return selectStickyRow(routing, sticky, new Set(exclude), new Map())
    ?.accountId
}

describe('prepaid credits as a fallback tier', () => {
  test('free quota on another account serves before an exhausted account with credits, in every routing mode', () => {
    // The credits account is first in the roster and is `main`, so every
    // mode would try it first if credits counted as free quota.
    for (const order of [
      ['main', 'b'],
      ['b', 'main'],
    ]) {
      const rows = order.map((id) =>
        row(id, id === 'main' ? onCredits() : free()),
      )
      for (const mode of MODES)
        expect(
          planOrdered({ ...input(rows), placement: orderedPlacement(mode) }),
        ).toEqual({ kind: 'send', order: ['b'], lastPath: false })
      expect(place(input(rows))).toBe('b')
      expect(creditsFallbackIds(input(rows))).toEqual(['main'])
    }
  })

  test('with every window spent, an account with credits serves before one without, whatever the configured order', () => {
    // `main` holds no credits and is tried first or last by mode; `a` holds
    // credits and sits first or second in the roster.
    for (const order of [
      ['main', 'a'],
      ['a', 'main'],
    ]) {
      const rows = order.map((id) =>
        row(id, id === 'a' ? onCredits() : spent()),
      )
      for (const mode of MODES)
        expect(
          planOrdered({ ...input(rows), placement: orderedPlacement(mode) }),
        ).toEqual({ kind: 'send', order: ['a', 'main'], lastPath: false })
      expect(place(input(rows))).toBe('a')
    }
    // A request that cannot be replayed and has no main goes to credits too.
    expect(
      planOrdered({
        ...input([row('x', spent()), row('a', onCredits())]),
        placement: 'roster',
        replayable: false,
      }),
    ).toEqual({ kind: 'send', order: ['a'], lastPath: false })
  })

  test('credits serve before the last path the library keeps for spent credit budgets', () => {
    const rows = [
      row('main', quota(20, { budgetReached: true })),
      row('a', onCredits()),
    ]
    expect(
      planOrdered({ ...input(rows), placement: 'main-first' }),
    ).toMatchObject({ kind: 'send', order: ['a', 'main'] })
    expect(place(input(rows))).toBe('a')
  })

  test('stale credits, a reached overage limit, a zero balance and no record are not usable', () => {
    const stale = { ...usable, checkedAt: NOW - 16 * MINUTE }
    const overage = { ...usable, overageLimitReached: true }
    const zero = { ...usable, balance: 0 }
    const none = { hasCredits: false, unlimited: false, checkedAt: NOW }
    const malformed = { hasCredits: 'yes', unlimited: false, checkedAt: NOW }
    for (const credits of [stale, overage, zero, none, malformed, undefined])
      expect(creditsUsable(credits, NOW)).toBe(false)
    // Usable: a balance above zero, unlimited credits, and credits reported
    // without a balance. A reading just inside the staleness bound counts.
    for (const credits of [
      usable,
      { hasCredits: false, unlimited: true, checkedAt: NOW },
      { hasCredits: true, unlimited: false, checkedAt: NOW },
      { ...usable, checkedAt: NOW - 15 * MINUTE },
    ])
      expect(creditsUsable(credits, NOW)).toBe(true)

    // An account whose credits are not usable is not a credits fallback: with
    // every window spent, routing keeps today's last path in placement order.
    for (const credits of [stale, overage, zero]) {
      const rows = [row('main', spent()), row('a', onCredits(credits))]
      expect(creditsFallbackIds(input(rows))).toEqual([])
      expect(planOrdered({ ...input(rows), placement: 'main-first' })).toEqual({
        kind: 'send',
        order: ['main', 'a'],
        lastPath: true,
      })
      expect(place(input(rows))).toBeUndefined()
    }
    const unrecorded = [row('main', spent()), row('a', spent())]
    expect(
      planOrdered({ ...input(unrecorded), placement: 'main-first' }),
    ).toEqual({ kind: 'send', order: ['main', 'a'], lastPath: true })
  })

  test('a killswitch floor and a reached spending cap still block an account with credits', () => {
    const killswitchOn: AccountStorage = {
      version: 1,
      accounts: [],
      killswitch: { enabled: true },
    } as AccountStorage
    const killedRows = [row('a', onCredits())]
    const verdicts = poolKillswitchVerdicts(
      killedRows.map((entry) => ({ id: entry.id, quota: entry.quota })),
      killswitchOn,
      NOW,
    )
    expect(verdicts.get('a')).toBe(false)
    const killed = input(killedRows, verdicts)
    expect(creditsFallbackIds(killed)).toEqual([])
    expect(planOrdered({ ...killed, placement: 'main-first' })).toEqual({
      kind: 'block',
      block: { reason: 'killswitch' },
    })
    expect(place(killed)).toBeUndefined()

    // The spending cap: `a` holds credits, but its workspace budget is spent.
    const capped = input([
      row('main', spent()),
      row('a', quota(100, { credits: usable, budgetReached: true })),
    ])
    expect(creditsFallbackIds(capped)).toEqual([])
    expect(planOrdered({ ...capped, placement: 'main-first' })).toEqual({
      kind: 'send',
      order: ['main', 'a'],
      lastPath: true,
    })
    expect(place(capped)).toBeUndefined()
  })

  test('an exhausted pin moves to free quota when an account has it, otherwise to credits', () => {
    const withFree = input([
      row('p', spent()),
      row('c', onCredits()),
      row('f', free()),
    ])
    expect(routePinnedRow(withFree, sticky, 'p')).toEqual({
      kind: 'move',
      reason: 'exhausted',
    })
    expect(place(withFree, ['p'])).toBe('f')

    const creditsOnly = input([row('p', spent()), row('c', onCredits())])
    expect(routePinnedRow(creditsOnly, sticky, 'p')).toEqual({
      kind: 'move',
      reason: 'exhausted',
    })
    expect(place(creditsOnly, ['p'])).toBe('c')
  })

  test('a credits pin serves while no account has free quota, and moves back to free quota at the next check', () => {
    expect(
      routePinnedRow(
        input([row('p', spent()), row('c', onCredits())]),
        sticky,
        'c',
      ),
    ).toEqual({ kind: 'serve' })
    // Another account's window has reset: the credits pin moves to it.
    const recovered = input([row('f', free()), row('c', onCredits())])
    expect(routePinnedRow(recovered, sticky, 'c')).toEqual({
      kind: 'move',
      reason: 'exhausted',
    })
    expect(place(recovered, ['c'])).toBe('f')
  })

  test('a pin waiting for its first reading keeps its pin while this request goes to credits', () => {
    const routing = input([{ id: 'p', kind: 'oauth' }, row('c', onCredits())])
    expect(routePinnedRow(routing, sticky, 'p')).toEqual({ kind: 'detour' })
    expect(place(routing, ['p'])).toBe('c')
  })

  test('serving on credits is logged once per account each time it starts', () => {
    const lines: Array<{ message: string; data?: Record<string, unknown> }> = []
    const log = {
      info: (message: string, data?: Record<string, unknown>) =>
        lines.push({ message, ...(data ? { data } : {}) }),
    }
    const serving = new CreditsServing()
    const noFree = input([row('main', spent()), row('a', onCredits())])
    serving.served(noFree, 'a', log)
    serving.served(noFree, 'a', log)
    expect(serving.has('a')).toBe(true)
    expect(lines).toEqual([
      {
        message: 'serving requests on prepaid credits',
        data: { accountId: 'a', reason: 'free quota used up' },
      },
    ])
    // Free quota serves again: the mark clears, and the next credits request
    // is a new transition.
    const recovered = input([row('main', free()), row('a', onCredits())])
    serving.served(recovered, 'main', log)
    expect(serving.ids()).toEqual(new Set())
    serving.served(noFree, 'a', log)
    expect(lines).toHaveLength(2)
    // A last-path send is not a credits send.
    serving.served(input([row('main', spent())]), 'main', log)
    expect(lines).toHaveLength(2)
    expect(serving.has('a')).toBe(false)
  })
})
