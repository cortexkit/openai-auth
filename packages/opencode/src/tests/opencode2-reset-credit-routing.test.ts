// Sticky-balanced placement on OpenCode 2 uses the reset credits each
// account's saved quota reading records, the way OpenCode 1 does. Credits
// play no part while any account has a fresh reading with room to weigh: the
// weighing alone places the session, and credits never reorder it. Only when
// no account can be weighed (every reading stale or out of room) does the
// fallback run, and there a new session goes to the first account in roster
// order holding at least one credit, else to the first account. Pool rows
// keep their balance in `row.quota`, vault accounts in `route.quota`, both at
// `counters.resetCredits.value`.
//
// The adapter runs behind the real installer on a fake OpenCode 2 host, over
// a stand-in pool source and vault that record every token and authorize
// call.

import { describe, expect, it } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import {
  createOpenAIAdapter,
  type PoolAccess,
  resetCreditsOfQuota,
  type VaultAccess,
} from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const HOUR = 3600_000
// Older than the fifteen minutes after which a reading no longer weighs an
// account, so no account has a weight and placement falls back.
const STALE_MS = 20 * 60_000

type Credits = number | 'missing'

/** A quota map with one primary reading and, unless missing, a credit count. */
function quota(
  options: { usedPercent?: number; stale?: boolean; credits?: Credits } = {},
) {
  const checkedAt = Date.now() - (options.stale ? STALE_MS : 0)
  const credits = options.credits ?? 'missing'
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent: options.usedPercent ?? 10,
        resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
    ...(credits === 'missing'
      ? {}
      : { counters: { resetCredits: { value: credits, checkedAt } } }),
  }
}

function poolRow(
  id: string,
  rowQuota: ReturnType<typeof quota>,
  enabled = true,
): PoolRow {
  return {
    id,
    type: 'oauth',
    enabled,
    candidate: true,
    hasEntry: true,
    needsFirstReading: false,
    credentialEpoch: 1,
    identity: `chatgpt-${id}`,
    credential: {
      type: 'oauth',
      access: `${id}-token`,
      refresh: `${id}-refresh`,
      expires: Date.now() + 24 * HOUR,
    },
    quota: rowQuota,
  } as PoolRow
}

/** A pool source over fixed rows that records each row it is asked a token for. */
function stubSource(rows: PoolRow[], tokenCalls: string[]): PoolAccess {
  const view = { active: true, rows }
  return {
    current: async () => view,
    peek: () => view,
    prepareTokens: async () => {},
    usableToken: (row: PoolRow) => {
      tokenCalls.push(row.id)
      return `${row.id}-token`
    },
    rateLimitMarks: () => new Map(),
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: () => {},
  } as unknown as PoolAccess
}

type StubRoute = {
  id: string
  kind: 'oauth' | 'api-key'
  identity: string
  quota: ReturnType<typeof quota>
}

/** A vault that serves `routes` and records each route it is asked to authorize. */
function stubVault(
  routes: StubRoute[],
  authorizeCalls: string[],
  mode: 'vault' | 'local',
): VaultAccess {
  return {
    routes: () => routes,
    identities: () => new Set(routes.map((route) => route.identity)),
    enrolled: () => mode === 'vault',
    authority: async () => mode,
    snapshot: () => undefined,
    authorize: async (id: string): Promise<ClaustrumScopedAttempt> => {
      authorizeCalls.push(id)
      return {
        credentialId: id,
        credentialType: 'oauth',
        accountIdentity: `chatgpt-${id}`,
        accountIdentitySource: 'asserted',
        accessToken: `${id}-token`,
        recordVersion: 1,
        expiresAtMs: null,
      }
    },
    reportFailure: async () => {},
    recordSnapshot: async () => {},
    requestReading: () => {},
  } as unknown as VaultAccess
}

const stickyStorage = async (): Promise<AccountStorage> => ({
  version: 1,
  accounts: [],
  routing: { mode: 'sticky-balanced' },
})

async function place(
  openai: ReturnType<typeof createOpenAIAdapter>,
  sessionID = 'ses_1',
): Promise<string | undefined> {
  const host = fakeOpenCode2Host()
  await installOpenCode2Auth(host.ctx, openai.adapter)
  const draft = {
    ...scope(sessionID, 'primary'),
    headers: { Authorization: `Bearer ${PLACEHOLDER}` } as Record<
      string,
      string
    >,
  }
  await host.fire('model.request', draft)
  return new Headers(draft.headers).get('authorization') ?? undefined
}

/** The bearer a new sticky session gets over pool rows `a` then `b`. */
async function placePool(
  a: ReturnType<typeof quota>,
  b: ReturnType<typeof quota>,
) {
  const tokenCalls: string[] = []
  const openai = createOpenAIAdapter({
    source: stubSource([poolRow('a', a), poolRow('b', b)], tokenCalls),
    storage: stickyStorage,
    pins: new SessionPins(),
  })
  return place(openai)
}

describe('reset-credit balance read from a quota map', () => {
  it('keeps a finite count, including an explicit 0, and nothing else', () => {
    expect(resetCreditsOfQuota(quota({ credits: 0 }))).toBe(0)
    expect(resetCreditsOfQuota(quota({ credits: 3 }))).toBe(3)
    expect(resetCreditsOfQuota(quota())).toBeUndefined()
    expect(resetCreditsOfQuota(undefined)).toBeUndefined()
    expect(resetCreditsOfQuota({ counters: {} })).toBeUndefined()
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '4', null])
      expect(
        resetCreditsOfQuota({ counters: { resetCredits: { value } } }),
      ).toBeUndefined()
  })
})

describe('OpenCode 2 sticky placement by reset credits', () => {
  // Each case: credits on a, credits on b, and the row OpenCode 1 places a
  // new session on when neither row has a fresh reading to weigh.
  const cases: Array<[string, Credits, Credits, 'a' | 'b']> = [
    ['missing vs missing keeps roster order', 'missing', 'missing', 'a'],
    ['missing vs 0 keeps roster order', 'missing', 0, 'a'],
    ['0 vs missing keeps roster order', 0, 'missing', 'a'],
    ['0 vs positive prefers the positive balance', 0, 2, 'b'],
    ['missing vs positive prefers the positive balance', 'missing', 2, 'b'],
    ['positive vs higher positive keeps roster order', 2, 5, 'a'],
    ['higher positive vs positive keeps roster order', 5, 2, 'a'],
  ]
  for (const [name, a, b, expected] of cases) {
    it(`an empty-weight placement: ${name}`, async () => {
      expect(
        await placePool(
          quota({ stale: true, credits: a }),
          quota({ stale: true, credits: b }),
        ),
      ).toBe(`Bearer ${expected}-token`)
    })
  }

  it('credits never reorder accounts with unequal fresh weights', async () => {
    expect(
      await placePool(
        quota({ usedPercent: 10, credits: 0 }),
        quota({ usedPercent: 50, credits: 9 }),
      ),
    ).toBe('Bearer a-token')
    expect(
      await placePool(
        quota({ usedPercent: 50, credits: 9 }),
        quota({ usedPercent: 10 }),
      ),
    ).toBe('Bearer b-token')
  })

  it('reads a vault account balance from its route quota', async () => {
    const authorizeCalls: string[] = []
    const openai = createOpenAIAdapter({
      source: stubSource([], []),
      storage: stickyStorage,
      pins: new SessionPins(),
      vault: stubVault(
        [
          {
            id: 'oauth:openai:one',
            kind: 'oauth',
            identity: 'chatgpt-one',
            quota: quota({ stale: true, credits: 0 }),
          },
          {
            id: 'oauth:openai:two',
            kind: 'oauth',
            identity: 'chatgpt-two',
            quota: quota({ stale: true, credits: 3 }),
          },
        ],
        authorizeCalls,
        'vault',
      ),
    })
    expect(await place(openai)).toBe('Bearer oauth:openai:two-token')
    expect(authorizeCalls).toEqual(['oauth:openai:two'])
  })

  it('scoring asks no token or vault authorization for disabled or ineligible accounts', async () => {
    const tokenCalls: string[] = []
    const authorizeCalls: string[] = []
    // The disabled row and the API-key vault account hold the largest
    // balances; neither can serve, so neither is scored, and nothing asks for
    // a credential for them.
    const openai = createOpenAIAdapter({
      source: stubSource(
        [
          poolRow('off', quota({ stale: true, credits: 9 }), false),
          poolRow('a', quota({ stale: true })),
          poolRow('b', quota({ stale: true, credits: 1 })),
        ],
        tokenCalls,
      ),
      storage: stickyStorage,
      pins: new SessionPins(),
      vault: stubVault(
        [
          {
            id: 'api-key:openai:spare',
            kind: 'api-key',
            identity: 'chatgpt-spare',
            quota: quota({ stale: true, credits: 9 }),
          },
        ],
        authorizeCalls,
        'local',
      ),
    })
    expect(await place(openai)).toBe('Bearer b-token')
    expect(tokenCalls.length).toBeGreaterThan(0)
    expect(tokenCalls.every((id) => id === 'b')).toBe(true)
    expect(authorizeCalls).toEqual([])
  })
})
