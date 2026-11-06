import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountKey, SessionActivity } from '@cortexkit/common-auth/limits'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  decideOpenAiLimit,
  killswitchPassesPolicy,
  QuotaManager,
  resolveMidStreamRateLimitResetAt,
} from '@cortexkit/openai-auth-core/internal'
import { projectOpenCodeMarks } from '../core/limit-source'
import type { PoolAccountSource } from '../core/pool-account-source'
import {
  type PendingPoolHold,
  type PoolRequestContext,
  servePoolRequest,
} from '../core/pool-request'
import { parseRateLimitSignal } from '../ws'

const NOW = 1_800_000_000_000
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
})

function legacy(now: () => number = () => NOW) {
  const home = mkdtempSync(join(tmpdir(), 'oc1-limit-conformance-'))
  homes.push(home)
  return new QuotaManager({
    configPath: join(home, 'accounts.json'),
    storage: null,
    now,
    fetchQuotaFn: async () => {
      throw new Error('mark bookkeeping must not poll')
    },
  })
}

function requestFixture(cache: boolean, secondaryDelay?: number) {
  let now = NOW
  const key = (accountId: string): AccountKey => ({
    namespace: 'oc1-conformance',
    accountId,
    incarnation: '1',
  })
  const rows = ['main', 'b'].map((id) => ({
    id,
    enabled: true,
    candidate: true,
    type: 'oauth',
    identity: `chatgpt-${id}`,
    credentialEpoch: 1,
    credential: {
      type: 'oauth',
      access: `${id}-token`,
      refresh: `${id}-refresh`,
      expires: NOW + 86_400_000,
    },
    quota: {
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          checkedAt: NOW,
          usedPercent: 10,
          resetsAt: new Date(NOW + 60_000).toISOString(),
          windowMinutes: 300,
        },
      ],
    },
  })) as PoolRow[]
  const marks = new Map<string, number>()
  const pending = new Map<string, PendingPoolHold>()
  const sent: string[] = []
  const activity: SessionActivity | undefined = cache
    ? { accountKey: key('main'), lastAcceptedAt: NOW, ttlMs: 300_000 }
    : undefined
  const ctx: PoolRequestContext = {
    source: {
      current: async () => ({ rows }),
      peek: () => ({ rows }),
      prepareTokens: async () => {},
      usableToken: (row: PoolRow) => `${row.id}-token`,
      refreshBackoffFor: () => new Map(),
      requestReading() {},
    } as unknown as PoolAccountSource,
    rateLimitMarks: () =>
      projectOpenCodeMarks(
        {
          marks: [...marks].map(([id, until]) => ({
            key: {
              account: key(id),
              scope: { kind: 'pool' },
              window: 'account',
            },
            entries: [{ until }],
          })),
        } as unknown as Parameters<typeof projectOpenCodeMarks>[0],
        rows.map((row) => ({
          account: key(row.id),
          identity: row.identity,
          credentialEpoch: String(row.credentialEpoch),
        })),
        now,
      ),
    storage: {
      version: 1,
      accounts: [],
      routing: { mode: 'sticky-balanced', maxSameAccountWait: 15 },
    },
    mode: 'sticky-balanced',
    sessionId: 'session',
    body: '{"model":"gpt-5.4"}',
    replayable: true,
    now: () => now,
    send: async (target) => {
      sent.push(target.id)
      return target.id === 'main'
        ? Response.json(
            {
              error: { type: 'usage_limit_reached', resets_at: 1_800_000_060 },
            },
            { status: 429 },
          )
        : new Response('B sentinel')
    },
    recordQuota: () => {
      if (secondaryDelay !== undefined)
        rows[0]!.quota = {
          limits: [
            {
              scope: 'all',
              label: 'primary',
              kind: 'reading',
              checkedAt: NOW,
              usedPercent: 100,
              resetsAt: new Date(NOW + 60_000).toISOString(),
              windowMinutes: 300,
            },
            {
              scope: 'all',
              label: 'secondary',
              kind: 'reading',
              checkedAt: NOW,
              usedPercent: 100,
              resetsAt: new Date(NOW + secondaryDelay).toISOString(),
              windowMinutes: 10080,
            },
          ],
        }
    },
    placePin: (input) =>
      input.validPinnedAccountIds.includes('main') &&
      !input.excludeAccountIds.includes('main')
        ? { accountId: 'main' }
        : input.select(new Map()),
    blocked: (block) =>
      new Response(`blocked:${block.reason}`, { status: 429 }),
    resetCredits: () => undefined,
    isAbort: () => false,
    log: { debug() {} },
    limitPolicy: {
      pending,
      accountKey: key,
      activity: () => activity,
      currentAccountKey: () => key('main'),
      owner: () => undefined,
      decide: decideOpenAiLimit,
    },
  }
  return {
    ctx,
    sent,
    pending,
    marks,
    tick: (at: number) => {
      now = at
    },
    serve: () => servePoolRequest(ctx),
  }
}

describe('OC1 limit-policy conformance', () => {
  test('OA-43 pool admission honors equality and the whole account override', async () => {
    const f = requestFixture(false)
    f.ctx.storage!.killswitch = { enabled: true }
    const rows = (await f.ctx.source.current()).rows
    const quota = (primary: number, secondary: number) => ({
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          checkedAt: NOW,
          usedPercent: 100 - primary,
          resetsAt: new Date(NOW + 7_200_000).toISOString(),
          windowMinutes: 300,
        },
        {
          scope: 'all',
          label: 'secondary',
          kind: 'reading',
          checkedAt: NOW,
          usedPercent: 100 - secondary,
          resetsAt: new Date(NOW + 7_200_000).toISOString(),
          windowMinutes: 10080,
        },
      ],
    })
    f.ctx.send = async (target) => {
      f.sent.push(target.id)
      return new Response(target.id)
    }
    rows[0]!.quota = quota(5, 10)
    expect(await (await f.serve()).response.text()).toBe('main')
    rows[0]!.quota = quota(4.999, 10)
    expect(await (await f.serve()).response.text()).toBe('b')
    rows[0]!.quota = quota(5, 9.999)
    expect(await (await f.serve()).response.text()).toBe('b')
    f.ctx.storage!.killswitch = {
      enabled: true,
      schema: 'floors-v1',
      defaults: { primary: 5, secondary: 10 },
      accounts: { main: { primary: 1 } },
    }
    rows[0]!.quota = quota(1, 1)
    expect(await (await f.serve()).response.text()).toBe('main')
  })

  test('OA-17 a model switch cannot bypass the account mark; equality admits A', async () => {
    const f = requestFixture(false)
    f.marks.set('main', NOW + 60_000)
    f.ctx.send = async (target) => {
      f.sent.push(target.id)
      return new Response(target.id)
    }
    expect(await (await f.serve()).response.text()).toBe('b')
    f.ctx.body = '{"model":"gpt-5.6"}'
    f.tick(NOW + 59_999)
    expect(await (await f.serve()).response.text()).toBe('b')
    f.tick(NOW + 60_000)
    expect(await (await f.serve()).response.text()).toBe('main')
    expect(f.sent).toEqual(['b', 'b', 'main'])
  })

  test('OA-32 original confirmed reset without cache still migrates', async () => {
    const f = requestFixture(false)
    expect(await (await f.serve()).response.text()).toBe('B sentinel')
    expect(f.sent).toEqual(['main', 'b'])
    expect(f.pending.size).toBe(0)
  })

  test('OA-32 fitting-cache companion holds only when every blocker fits', async () => {
    const f = requestFixture(true, 120_000)
    const result = await f.serve()
    expect(result.response.headers.get('retry-after')).toBe('120')
    expect(await result.response.text()).toBe(
      '{"error":{"message":"OpenAI usage limit reached on this account. Waiting for it keeps the conversation\'s prompt cache. Retry in 2m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
    expect(f.sent).toEqual(['main'])
    expect(f.pending.get('session')?.target).toBe(1_800_000_120_000)
  })

  test('OA-32 four-day secondary companion cannot hold despite a fitting primary and cache', async () => {
    const f = requestFixture(true, 345_600_000)
    expect(await (await f.serve()).response.text()).toBe('B sentinel')
    expect(f.sent).toEqual(['main', 'b'])
    expect(f.pending.size).toBe(0)
  })

  test('OA-12 equal named reset and invalid explicit resets never borrow the sibling', () => {
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: NOW,
        resetsAt: new Date(NOW).toISOString(),
      },
      secondary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: NOW,
        resetsAt: new Date(NOW + 7_200_000).toISOString(),
      },
    }
    for (const explicit of [
      undefined,
      NOW,
      NOW - 1,
      0,
      -1,
      NaN,
      Infinity,
      -Infinity,
    ]) {
      expect(
        resolveMidStreamRateLimitResetAt(
          quota,
          'primary',
          NOW,
          60_000,
          explicit,
        ),
      ).toBe(1_800_000_060_000)
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'secondary', NOW, 60_000, NaN),
    ).toBe(1_800_007_200_000)
  })

  test('OA-17/18 legacy whole-account deadline expires at equality and keeps max-until', () => {
    let now = NOW
    const manager = legacy(() => now)
    manager.markRateLimited('main', NOW + 120_000)
    manager.markRateLimited('main', NOW + 30_000)
    manager.markRateLimited('main', NOW + 120_000)
    now = NOW + 119_999
    expect(manager.isRateLimited('main')).toBe(true)
    expect(manager.isRateLimited('other')).toBe(false)
    now = NOW + 120_000
    expect(manager.isRateLimited('main')).toBe(false)
    expect(manager.isRateLimited('other')).toBe(false)
  })

  test('OA-19 legacy empty windows are not health and an exhausted sibling prevents clear', () => {
    const manager = legacy()
    const entry = (quota: Parameters<QuotaManager['setMain']>[1]['quota']) => ({
      quota,
      checkedAt: NOW,
      refreshAfter: NOW + 60_000,
    })
    manager.markRateLimited('main', NOW + 60_000)
    manager.setMain('a', entry({}))
    expect(manager.isRateLimited('main')).toBe(true)
    manager.setMain(
      'a',
      entry({
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: NOW },
        secondary: { usedPercent: 100, remainingPercent: 0, checkedAt: NOW },
      }),
    )
    expect(manager.isRateLimited('main')).toBe(true)
    manager.setMain(
      'a',
      entry({
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: NOW },
      }),
    )
    expect(manager.isRateLimited('main')).toBe(false)
  })

  test('OA-20 legacy same refresh and unknown identity retain; verified replacement clears', () => {
    const manager = legacy()
    const entry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: NOW },
      },
      checkedAt: NOW,
      refreshAfter: NOW + 60_000,
    }
    manager.setMain('a', entry, 'account-a')
    manager.markRateLimited('main', NOW + 60_000)
    manager.setMain('refreshed-a', entry, 'account-a')
    expect(manager.isRateLimited('main')).toBe(true)
    manager.setMain('unknown', entry)
    expect(manager.isRateLimited('main')).toBe(true)
    manager.setMain('b', entry, 'account-b')
    expect(manager.isRateLimited('main')).toBe(false)
  })

  test('OA-21/23 legacy managers are process-local, not a durable registry', () => {
    const one = legacy()
    const two = legacy()
    one.markRateLimited('main', NOW + 60_000)
    expect(one.isRateLimited('main')).toBe(true)
    expect(two.isRateLimited('main')).toBe(false)
  })

  test('OA-43 legacy floor equality passes and a strictly lower remaining value blocks', () => {
    const storage: AccountStorage = {
      version: 1,
      accounts: [],
      killswitch: { enabled: true },
    }
    const quota = (primary: number, secondary: number) => ({
      primary: {
        usedPercent: 100 - primary,
        remainingPercent: primary,
        checkedAt: NOW,
      },
      secondary: {
        usedPercent: 100 - secondary,
        remainingPercent: secondary,
        checkedAt: NOW,
      },
    })
    expect(killswitchPassesPolicy(quota(5, 10), storage, 'main', NOW)).toBe(
      true,
    )
    expect(killswitchPassesPolicy(quota(4.999, 10), storage, 'main', NOW)).toBe(
      false,
    )
    expect(killswitchPassesPolicy(quota(5, 9.999), storage, 'main', NOW)).toBe(
      false,
    )
  })

  test('OA-1-9/15 OC1 raw admission does not parse Retry-After headers', () => {
    const signal = parseRateLimitSignal(
      {
        status: 429,
        headers: { 'retry-after': '1.5', 'retry-after-ms': '1500' },
      },
      NOW,
    )
    expect(signal).toEqual({ window: 'rate_limit' })
  })
})
