import { expect, test } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import type { ChooseAccountInput } from '@cortexkit/common-auth/opencode2'
import {
  createOpenAIAdapter,
  type PoolAccess,
  type VaultAccess,
} from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { quotaMap, scope } from './fixtures/opencode2-host'

function receipt(id: string): ClaustrumScopedAttempt {
  return {
    credentialId: id,
    credentialType: 'oauth',
    accountIdentity: id,
    accountIdentitySource: 'asserted',
    accessToken: `${id}-token`,
    recordVersion: 1,
    expiresAtMs: null,
  }
}

function fixture(
  authorize: (id: string) => Promise<ClaustrumScopedAttempt | undefined>,
  pins = new SessionPins(),
) {
  const quota = quotaMap(10)
  const routes = ['a', 'b'].map((id) => ({
    id: `vault:${id}`,
    kind: 'oauth' as const,
    identity: `chatgpt-${id}`,
    quota,
  }))
  const vault = {
    authority: async () => 'vault',
    routes: () => routes,
    identities: () => new Set(routes.map((route) => route.identity)),
    authorize,
  } as unknown as VaultAccess
  const source = {
    rateLimitMarks: () => new Map(),
    refreshBackoffFor: () => new Map(),
  } as unknown as PoolAccess
  // Two project adapters share the process's one ledger for this account store.
  const adapters = Array.from(
    { length: 2 },
    () =>
      createOpenAIAdapter({
        source,
        vault,
        pins,
        storage: async () => ({
          version: 1,
          accounts: [],
          routing: { mode: 'sticky-balanced' },
        }),
      }).adapter,
  )
  return { pins, adapters }
}

function input(
  sessionID: string,
  phase: 'request' | 'retry' = 'request',
): ChooseAccountInput {
  return {
    ...scope(sessionID),
    providerID: 'openai',
    modelID: 'gpt-5.5',
    phase,
    ...(phase === 'retry'
      ? {
          previousAccountId: 'vault:refused',
          rerouteFrom: {
            accountId: 'vault:refused',
            limit: { reason: 'usage_limit' },
          },
        }
      : {}),
  }
}

async function measure(phase: 'request' | 'retry') {
  const release = Promise.withResolvers<void>()
  const arrived = Promise.withResolvers<void>()
  const authorizations: string[] = []
  const { pins, adapters } = fixture(async (id) => {
    authorizations.push(id)
    if (authorizations.length === 4) arrived.resolve()
    await release.promise
    return receipt(id)
  })
  const inputs = Array.from({ length: 4 }, (_, index) =>
    input(`cold-${index}`, phase),
  )
  const pending = inputs.map((request, index) =>
    adapters[index % 2]!.chooseAccount(request),
  )
  try {
    await arrived.promise
    const counts = Object.fromEntries(
      ['vault:a', 'vault:b'].map((id) => [
        id,
        authorizations.filter((accountId) => accountId === id).length,
      ]),
    )
    // Older ledgers expose pending-byte accounting through their committed pins.
    const accountingPins = pins.placementSnapshot?.() ?? pins.snapshot()
    console.log(
      'cold spread measurement',
      JSON.stringify({
        phase,
        authorizations,
        counts,
        pinsWhileAuthorizationPending: pins.size,
        accountingPinsWhileAuthorizationPending: accountingPins.size,
      }),
    )
    expect(counts).toEqual({ 'vault:a': 2, 'vault:b': 2 })
    expect(accountingPins.size).toBe(4)
  } finally {
    release.resolve()
    const chosen = await Promise.all(pending)
    if (phase === 'retry') {
      expect(pins.size).toBe(0)
      expect(pins.placementSnapshot().size).toBe(4)
      for (let index = 0; index < inputs.length; index++)
        await adapters[index % 2]!.dropChoice!({
          ...inputs[index]!,
          accountId: chosen[index]!,
        })
      expect(pins.placementSnapshot().size).toBe(0)
    }
  }
  expect(pins.size).toBe(phase === 'request' ? 4 : 0)
}

test('overlapping cold sessions reserve pending bytes across project adapters', () =>
  measure('request'))
test('overlapping retry choices reserve pending bytes until use or discard', () =>
  measure('retry'))

test('authorization refusal releases the candidate reservation before selecting another account', async () => {
  let pins: SessionPins
  const calls: string[] = []
  const f = fixture(async (id) => {
    calls.push(id)
    if (id === 'vault:a') return undefined
    expect(pins.placementSnapshot().get('session')?.accountId).toBe('vault:b')
    return receipt(id)
  })
  pins = f.pins
  expect(await f.adapters[0]!.chooseAccount(input('session'))).toBe('vault:b')
  expect(calls).toEqual(['vault:a', 'vault:b'])
  expect(pins.placementSnapshot()).toEqual(pins.snapshot())
})

test('a thrown authorization rolls back only its reservation without evicting a committed session', async () => {
  const pins = new SessionPins(1)
  const other = { accountId: 'vault:a', inputBytes: 1 }
  pins.finish(pins.reserve('other', other), other)
  const before = pins.snapshot()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = fixture(async () => {
    entered.resolve()
    await release.promise
    throw new Error('authorization failed')
  }, pins)
  const choice = f.adapters[0]!.chooseAccount(input('session'))
  const refused = Promise.resolve(choice).then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    await entered.promise
    expect(pins.snapshot()).toEqual(before)
    expect(pins.placementSnapshot().size).toBe(2)
  } finally {
    release.resolve()
  }
  const error = await refused
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('authorization failed')
  expect(pins.snapshot()).toEqual(before)
  expect(pins.placementSnapshot()).toEqual(before)
})

test('stale reservation completion and rollback never overwrite a newer same-session choice', () => {
  const pins = new SessionPins()
  const oldPin = { accountId: 'vault:a', inputBytes: 1 }
  const newPin = { accountId: 'vault:b', inputBytes: 1 }
  const old = pins.reserve('session', oldPin)
  const current = pins.reserve('session', newPin)
  pins.rollback(old)
  pins.finish(old, oldPin)
  expect(pins.placementSnapshot().get('session')).toBe(newPin)
  pins.finish(current, newPin)
  expect(pins.snapshot().get('session')).toBe(newPin)
  const forgotten = pins.reserve('session', oldPin)
  pins.forget('session')
  pins.finish(forgotten, oldPin)
  expect(pins.snapshot().size).toBe(0)
  expect(pins.placementSnapshot().size).toBe(0)
})

test('auxiliary work follows the committed pin while a retry reserves another account', async () => {
  const f = fixture(async (id) => receipt(id))
  const request = input('session')
  expect(await f.adapters[0]!.chooseAccount(request)).toBe('vault:a')
  const retry: ChooseAccountInput = {
    ...request,
    phase: 'retry',
    previousAccountId: 'vault:a',
    rerouteFrom: { accountId: 'vault:a', limit: { reason: 'usage_limit' } },
  }
  expect(await f.adapters[0]!.chooseAccount(retry)).toBe('vault:b')
  expect(f.pins.get('session')).toBe('vault:a')
  expect(f.pins.placementSnapshot().get('session')?.accountId).toBe('vault:b')
  expect(
    await f.adapters[1]!.chooseAccount({ ...request, kind: 'title' }),
  ).toBe('vault:a')
  expect(f.pins.get('session')).toBe('vault:a')
  expect(f.pins.placementSnapshot().get('session')?.accountId).toBe('vault:b')
  await f.adapters[0]!.dropChoice!({ ...retry, accountId: 'vault:b' })
  expect(f.pins.placementSnapshot()).toEqual(f.pins.snapshot())
})
