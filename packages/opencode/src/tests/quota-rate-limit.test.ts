import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPoolLimitsAdapter } from '@cortexkit/common-auth/limits'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import * as limitsCore from '@cortexkit/openai-auth-core/internal'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { createLimitsLeaseManager } from '../../../core/src/limit-registry'
import { getAccountStoragePath } from '../core/account-paths'
import { OpenCodeLimitSource } from '../core/limit-source'
import { PoolAccountSource } from '../core/pool-account-source'
import { CodexAuthPlugin } from '../index'
import { flushForTest, setLogLevel } from '../logger'
import { createRequestTestScope } from './request-test-scope'

describe('QuotaManager refresh scheduling', () => {
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    quota: {
      checkIntervalMinutes: 5,
      minimumRemaining: { primary: 15, secondary: 10 },
    },
  }

  it('defers a blocked single-primary snapshot until its future reset', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = Date.UTC(2026, 6, 16, 12, 0, 0)
    const resetAt = now + 60 * 60 * 1000
    const token = 'blocked-single-primary'
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage,
      now: () => now,
      fetchQuotaFn: async () => ({
        primary: {
          usedPercent: 90,
          remainingPercent: 10,
          resetsAt: new Date(resetAt).toISOString(),
          checkedAt: now,
          windowMinutes: 10_080,
        },
      }),
    })

    await qm.refreshMain(token)

    expect(qm.getMain(token)?.refreshAfter).toBe(resetAt + 60_000)
  })

  it('polls a healthy single-primary snapshot at the normal interval', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = Date.UTC(2026, 6, 16, 13, 0, 0)
    const token = 'healthy-single-primary'
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage,
      now: () => now,
      fetchQuotaFn: async () => ({
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: now,
          windowMinutes: 10_080,
        },
      }),
    })

    await qm.refreshMain(token)

    expect(qm.getMain(token)?.refreshAfter).toBe(now + 5 * 60_000)
  })
})

/**
 * Unit tests for QuotaManager's mid-stream rate-limit marks: an in-memory,
 * read-time-expiring flag set from a WS response.failed rate_limit_reached_type
 * signal (never a network call). See quota-rate-limit-reroute for the
 * fetch-override integration that consumes these marks.
 */
describe('QuotaManager mid-stream rate-limit marks', () => {
  it('markRateLimited makes isRateLimited true; it clears once now() passes resetAt', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    let now = 1_000_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    expect(qm.isRateLimited('main')).toBe(false)

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // Still within the window.
    now += 30_000
    expect(qm.isRateLimited('main')).toBe(true)

    // Past resetAt — the mark expires by read-time comparison alone, no timer.
    now += 40_000
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('marking one account does not mark another (per-account isolation)', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 2_000_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)
    expect(qm.isRateLimited('fb-1')).toBe(false)

    qm.markRateLimited('fb-1', now + 60_000)
    expect(qm.isRateLimited('fb-1')).toBe(true)
    // Marking fb-1 must not have touched main's mark or any other id.
    expect(qm.isRateLimited('main')).toBe(true)
    expect(qm.isRateLimited('fb-2')).toBe(false)
  })

  it('re-marking the same account keeps the LATER reset', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    let now = 3_000_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 120_000)
    // An earlier estimate must NOT shorten the existing, later mark.
    qm.markRateLimited('main', now + 30_000)
    now += 60_000
    expect(qm.isRateLimited('main')).toBe(true) // still within the original 120s mark

    // A genuinely later signal DOES extend the mark.
    qm.markRateLimited('main', now + 200_000)
    now += 150_000
    expect(qm.isRateLimited('main')).toBe(true)
  })

  it('re-marking the same account with an EQUAL reset is idempotent (not dropped)', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    let now = 3_500_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    // Same reset again — must not be treated as "not later" and dropped;
    // an equal-value re-mark still overwrites (idempotent), so the mark
    // holds exactly through the original window.
    qm.markRateLimited('main', now + 60_000)
    now += 59_000
    expect(qm.isRateLimited('main')).toBe(true)
    now += 2_000
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain clears a mark when the only present window is healthy (single-primary wire)', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_000_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // The current wire sends a single present primary window (secondary is
    // absent, not unhealthy) — a healthy primary alone is positive evidence,
    // since an absent window is not applicable, not uncertain.
    qm.setMain('token-a', {
      quota: {
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          windowMinutes: 10_080,
          checkedAt: now,
        },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    })
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain does not clear the mark when a present window is still exhausted', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_050_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // A present-and-still-exhausted window is not evidence of health, even
    // alongside a healthy sibling — every present window must be under 100%.
    qm.setMain('token-a', {
      quota: {
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        secondary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    })
    expect(qm.isRateLimited('main')).toBe(true)
  })

  it('setMain clears the mark when both present windows are healthy', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_080_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    qm.setMain('token-a', {
      quota: {
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        secondary: { usedPercent: 5, remainingPercent: 95, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    })
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain clears the mark on a genuine main-account SWITCH, even with a non-healthy snapshot', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_500_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    // A still-exhausted snapshot establishes the initial account identity
    // without itself clearing anything (quotaLooksHealthy is false).
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }
    qm.setMain('token-a', exhaustedEntry, 'acct-A')

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // A different accountId is a SWITCH — the old account's mark must not
    // carry over to the new account, even though this snapshot alone isn't
    // healthy evidence.
    qm.setMain('token-b', exhaustedEntry, 'acct-B')
    expect(qm.isRateLimited('main')).toBe(false)
  })

  it('setMain does NOT clear the mark on a same-account token refresh', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_600_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    // Still-exhausted, so the clear-on-refresh assertion below isolates the
    // same-account-refresh behavior from quotaLooksHealthy's own clear.
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }
    qm.setMain('token-a', exhaustedEntry, 'acct-A')

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // Same accountId, new access token — a routine refresh, NOT a switch.
    // The mark must survive.
    qm.setMain('refreshed-token-a', exhaustedEntry, 'acct-A')
    expect(qm.isRateLimited('main')).toBe(true)
  })

  it('setFallback clears a mark on a genuine fallback-account re-login', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_650_000
    const fallbackId = 'fallback-1'
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }

    qm.setFallback(fallbackId, exhaustedEntry, 'token-a', false, 'acct-A')
    qm.markRateLimited(fallbackId, now + 60_000)

    // A different known identity is a re-login, not a routine quota push.
    qm.setFallback(fallbackId, exhaustedEntry, 'token-b', false, 'acct-B')

    expect(qm.isRateLimited(fallbackId)).toBe(false)
  })

  it('setFallback does NOT clear a mark when a quota push has the same identity', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_660_000
    const fallbackId = 'fallback-1'
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }

    qm.setFallback(fallbackId, exhaustedEntry, 'token-a', false, 'acct-A')
    qm.markRateLimited(fallbackId, now + 60_000)
    qm.setFallback(
      fallbackId,
      exhaustedEntry,
      'refreshed-token-a',
      false,
      'acct-A',
    )

    expect(qm.isRateLimited(fallbackId)).toBe(true)
  })

  it('setFallback preserves a mark and prior binding when the incoming identity is unknown', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_670_000
    const fallbackId = 'fallback-1'
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }

    qm.setFallback(fallbackId, exhaustedEntry, 'token-a', false, 'acct-A')
    qm.markRateLimited(fallbackId, now + 60_000)
    qm.setFallback(fallbackId, exhaustedEntry, 'refreshed-token-a')

    expect(qm.isRateLimited(fallbackId)).toBe(true)
    expect(qm.peekFallbackForPolicy(fallbackId, 'acct-A')).not.toBeNull()
    expect(qm.peekFallbackForPolicy(fallbackId, 'acct-B')).toBeNull()
  })

  it('setFallback preserves a mark on first identity binding', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_680_000
    const fallbackId = 'fallback-1'
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })
    const exhaustedEntry = {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: now },
      },
      refreshAfter: now + 60_000,
      checkedAt: now,
    }

    qm.markRateLimited(fallbackId, now + 60_000)
    qm.setFallback(fallbackId, exhaustedEntry, 'token-a', false, 'acct-A')

    expect(qm.isRateLimited(fallbackId)).toBe(true)
  })

  it('refreshMain clears a stale main mark once a healthy quota poll lands (bypasses setMain)', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 4_700_000
    const qm = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
      fetchQuotaFn: async () => ({
        primary: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        secondary: { usedPercent: 5, remainingPercent: 95, checkedAt: now },
      }),
    })

    qm.markRateLimited('main', now + 60_000)
    expect(qm.isRateLimited('main')).toBe(true)

    // _fetchMain assigns this.main directly (not via setMain), so its own
    // healthy-clear must fire independently — otherwise a known-healthy
    // active poll leaves the mark stuck until its own unrelated expiry.
    await qm.refreshMain('token-a')
    expect(qm.isRateLimited('main')).toBe(false)
  })
})

describe('resolveMidStreamRateLimitResetAt', () => {
  const now = 5_000_000
  const defaultMs = 60_000

  it('prefers the named window when present and future', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now + 300_000).toISOString(),
        checkedAt: now,
      },
      secondary: {
        usedPercent: 50,
        remainingPercent: 50,
        resetsAt: new Date(now + 30_000).toISOString(),
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + 300_000)
  })

  it('prefers an explicit provider reset over cached quota reset math', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const providerResetAt = now + 900_000
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now + 300_000).toISOString(),
        checkedAt: now,
      },
    }
    const resolveWithExplicitReset = resolveMidStreamRateLimitResetAt as (
      snapshot: typeof quota,
      window: string,
      now: number,
      defaultMs: number,
      explicitResetAt?: number,
    ) => number

    expect(
      resolveWithExplicitReset(
        quota,
        'usage_limit_reached',
        now,
        defaultMs,
        providerResetAt,
      ),
    ).toBe(providerResetAt)
  })

  it('uses the bounded default (NOT the other window) when the named window is absent', async () => {
    // The frame named `primary`, but only `secondary` has a cached reset. We
    // must NOT borrow secondary's reset — an unrelated window can reset far in
    // the future and would blackhole the account long past its real rate-limit.
    // Fall back to the bounded, self-correcting default instead.
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const quota = {
      secondary: {
        usedPercent: 50,
        remainingPercent: 50,
        resetsAt: new Date(now + 3_600_000).toISOString(),
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
  })

  it('falls back to the default when every window is past or absent', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now - 10_000).toISOString(),
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
    expect(
      resolveMidStreamRateLimitResetAt(undefined, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
  })

  it('falls back to the default when resetsAt is unparseable', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: 'not-a-date',
        checkedAt: now,
      },
    }
    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(now + defaultMs)
  })

  it('uses primary from a single-primary snapshot', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const primaryReset = new Date(now + 300_000).toISOString()
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: now,
        resetsAt: primaryReset,
        windowMinutes: 10_080,
      },
    }

    expect(
      resolveMidStreamRateLimitResetAt(quota, 'primary', now, defaultMs),
    ).toBe(Date.parse(primaryReset))
  })

  it('does not borrow primary for a secondary-named frame', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const quota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: now,
        resetsAt: new Date(now + 300_000).toISOString(),
        windowMinutes: 10_080,
      },
    }

    expect(
      resolveMidStreamRateLimitResetAt(quota, 'secondary', now, defaultMs),
    ).toBe(now + defaultMs)
  })
})

describe('OC1 mark authority selection', () => {
  for (const supplied of [false, true]) {
    it(`${supplied ? 'uses supplied registry projection without reading' : 'defaults to'} the source compatibility map`, async () => {
      const { servePoolRequest } = await import('../core/pool-request')
      const now = Date.now()
      let sourceReads = 0
      const source = {
        current: async () => {},
        prepareTokens: async () => {},
        peek: () => ({
          rows: [
            {
              id: 'main',
              type: 'oauth',
              enabled: true,
              candidate: true,
              credential: {
                type: 'oauth',
                access: 'test-token',
                refresh: 'refresh',
                expires: now + 3600_000,
              },
              quota: {
                limits: [
                  {
                    scope: 'all',
                    label: 'primary',
                    kind: 'reading',
                    checkedAt: now,
                    usedPercent: 10,
                    resetsAt: new Date(now + 120_000).toISOString(),
                    windowMinutes: 300,
                  },
                ],
              },
            },
          ],
        }),
        rateLimitMarks: () => {
          sourceReads++
          return new Map([['main', now + 60_000]])
        },
        refreshBackoffFor: () => new Map(),
        usableToken: () => 'test-token',
        requestReading: () => undefined,
      }
      const result = await servePoolRequest({
        source:
          source as unknown as import('../core/pool-account-source').PoolAccountSource,
        ...(supplied
          ? { rateLimitMarks: () => new Map<string, number>() }
          : {}),
        storage: { version: 1, accounts: [], killswitch: { enabled: false } },
        mode: 'main-first',
        sessionId: undefined,
        body: '{}',
        replayable: true,
        now: () => now,
        send: async () => new Response('sentinel'),
        recordQuota: () => {},
        placePin: () => undefined,
        blocked: (block) => new Response(block.reason, { status: 429 }),
        resetCredits: () => undefined,
        isAbort: () => false,
        log: { debug: () => {} },
      })
      expect(sourceReads === 0).toBe(supplied)
      expect(await result.response.text()).toBe(
        supplied ? 'sentinel' : 'mid-stream-rate-limit',
      )
    })
  }
})

describe('OC1 shared limit transport lifecycle', () => {
  const scope = createRequestTestScope()
  let cleanup = async () => {}
  afterEach(async () => {
    await scope.teardown(cleanup)
    cleanup = async () => {}
  })

  async function fixture(
    options: { ws?: boolean; unsupported?: boolean } = {},
  ) {
    await flushForTest()
    const dir = mkdtempSync(join(tmpdir(), 'oc1-limit-transport-'))
    const config = join(dir, 'accounts.json')
    const state = join(dir, 'state.json')
    const vars: Record<string, string> = {
      OPENCODE_OPENAI_AUTH_FILE: config,
      OPENCODE_OPENAI_AUTH_STATE_FILE: state,
      OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE: join(dir, 'sidebar.json'),
      OPENCODE_OPENAI_AUTH_LOG_FILE: join(dir, 'plugin.log'),
      OPENCODE_CONFIG_DIR: dir,
    }
    const env = Object.fromEntries(
      Object.keys(vars).map((key) => [key, process.env[key]]),
    )
    Object.assign(process.env, vars)
    const originalFetch = globalThis.fetch
    const originalSocket = globalThis.WebSocket
    let now = 1_800_000_000_000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const rows = ['main', 'b']
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: rows.map((id) => ({
          id,
          type: 'oauth',
          enabled: true,
          accountId: `identity-${id}`,
          addedAt: 1,
        })),
        routing: { mode: 'main-first' },
        commonAuthPool: {
          schemaVersion: 1,
          rows: Object.fromEntries(
            rows.map((id) => [
              id,
              {
                credentialEpoch: 1,
                needsFirstReading: false,
                quota: {
                  limits: [
                    {
                      scope: 'all',
                      label: 'primary',
                      kind: 'reading',
                      checkedAt: now,
                      usedPercent: 10,
                      resetsAt: new Date(now + 60_000).toISOString(),
                      windowMinutes: 300,
                    },
                  ],
                },
              },
            ]),
          ),
        },
        openaiAuthPool: { migratedAt: now - 60_000 },
        ...(options.unsupported
          ? { commonAuthLimits: { schemaVersion: 2 } }
          : {}),
      }),
    )
    writeFileSync(
      state,
      JSON.stringify({
        version: 1,
        accounts: Object.fromEntries(
          rows.map((id) => [
            id,
            {
              access: `${id}-token`,
              refresh: `${id}-refresh`,
              expires: now + 3600_000,
            },
          ]),
        ),
      }),
    )
    const wire: string[] = []
    let failWs = true
    let httpStatus = 200
    let httpBody: BodyInit = 'data: {"type":"response.completed"}\n\n'
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/responses')) {
          wire.push(new Headers(init?.headers).get('authorization') ?? '')
          return new Response(httpBody, {
            status: httpStatus,
            headers: { 'content-type': 'text/event-stream' },
          })
        }
        return Response.json({})
      },
      { preconnect() {} },
    ) as typeof fetch
    class Socket extends EventTarget {
      readyState = 0
      constructor(
        _url: string,
        private options?: { headers?: Record<string, string> },
      ) {
        super()
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
        })
      }
      send() {
        const token = this.options?.headers?.authorization ?? ''
        wire.push(token)
        const event =
          failWs && token === 'Bearer main-token'
            ? {
                type: 'response.failed',
                response: {
                  id: 'failed',
                  failed: { rate_limit_reached_type: 'primary' },
                },
              }
            : {
                type: 'response.completed',
                response: { id: 'completed', output: [] },
              }
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(event) }),
        )
      }
      close() {
        this.readyState = 3
      }
    }
    globalThis.WebSocket = Socket as unknown as typeof WebSocket
    let source: OpenCodeLimitSource | undefined
    const forRequest = OpenCodeLimitSource.prototype.forRequest
    const sourceSpy = spyOn(
      OpenCodeLimitSource.prototype,
      'forRequest',
    ).mockImplementation(async function (this: OpenCodeLimitSource) {
      source = this
      return forRequest.call(this)
    })
    const mapSpy = spyOn(
      PoolAccountSource.prototype,
      'rateLimitMarks',
    ).mockImplementation(() => {
      throw new Error('OC1 read the compatibility map')
    })
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const legacySpy = spyOn(QuotaManager.prototype, 'markRateLimited')
    const isolatedManager = createLimitsLeaseManager(undefined, {
      droppedSignalLog: { logged: false },
    })
    const acquireSpy = options.unsupported
      ? spyOn(limitsCore, 'acquireOpenAiLimits').mockImplementation((input) => {
          const { source } = input
          if (source.kind !== 'pool')
            throw new Error('unexpected vault limits acquisition')
          const namespace = limitsCore.poolLimitsNamespace(
            source.configPath,
            source.statePath,
          )
          const log = input.log ?? (() => {})
          return isolatedManager.acquire({
            namespace,
            adapter: () =>
              createPoolLimitsAdapter({
                namespace,
                store: source.store,
                logger: { warn: log },
              }),
            log,
            isAccessRestrictive: input.isAccessRestrictive ?? (() => false),
          })
        })
      : undefined
    scope.capturePluginWork()
    let hooks: Hooks | undefined
    cleanup = async () => {
      await hooks?.dispose?.()
      await flushForTest()
      setLogLevel(undefined)
      sourceSpy.mockRestore()
      mapSpy.mockRestore()
      legacySpy.mockRestore()
      acquireSpy?.mockRestore()
      clock.mockRestore()
      globalThis.fetch = originalFetch
      globalThis.WebSocket = originalSocket
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
    mkdirSync(join(dir, 'vault'), { mode: 0o700 })
    hooks = scope.ownPlugin(
      await CodexAuthPlugin(
        {
          client: {
            auth: { set: async () => {} },
            session: { promptAsync: async () => {} },
          },
          project: { id: 'limits' },
          directory: '',
          worktree: dir,
          experimental_workspace: { register() {} },
          serverUrl: new URL('http://localhost:0'),
          $: {},
        } as unknown as PluginInput,
        {
          experimentalWebSockets: options.ws ?? true,
          poolMigration: { enabled: false },
          vault: {
            stateDir: join(dir, 'vault'),
            connectionFile: () => join(dir, 'absent-daemon'),
            pollIntervalMs: 0,
          },
        },
      ),
    )
    const loader = hooks.auth?.loader
    if (!loader) throw new Error('missing loader')
    const loaded = await loader(
      async () => ({
        type: 'oauth',
        refresh: 'common-auth-placeholder:v1:openai',
        access: '',
        expires: 0,
      }),
      { id: 'openai', models: [] } as never,
    )
    setLogLevel('warn')
    const send = (
      loaded as { fetch: (url: string, init: RequestInit) => Promise<Response> }
    ).fetch
    return {
      wire,
      legacySpy,
      mapSpy,
      limits: () => {
        if (!source) throw new Error('missing limits source')
        return source
      },
      advance: (ms: number) => {
        now += ms
      },
      now: () => now,
      succeedWs: () => {
        failWs = false
      },
      http: (status: number, body: BodyInit) => {
        httpStatus = status
        httpBody = body
      },
      log: async () => {
        await flushForTest()
        return readFileSync(join(dir, 'plugin.log'), 'utf8')
      },
      request: (session = 'limit-session') =>
        scope.wrap(send)('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'session-id': session,
          },
          body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
        }),
    }
  }

  it('publishes one account-wide WS mark and routes the reissue without touching legacy maps', async () => {
    const f = await fixture()
    const first = await f.request()
    await expect(first.text()).rejects.toMatchObject({ isRetryable: true })
    const owner = f.limits().owner()
    await owner?.flush()
    const snapshot = owner?.snapshot()
    expect(snapshot?.marks).toHaveLength(1)
    expect(snapshot?.operationIds).toHaveLength(1)
    expect(snapshot?.marks[0]).toMatchObject({
      key: {
        account: { accountId: 'main' },
        window: 'account',
        scope: { kind: 'pool' },
      },
      entries: [{ cause: 'rate-limit', until: 1_800_000_060_000 }],
    })
    expect(await (await f.request()).text()).toContain('response.completed')
    expect(f.wire).toEqual(['Bearer main-token', 'Bearer b-token'])
    await owner?.flush()
    expect(owner?.snapshot()?.marks).toHaveLength(1)
    expect(owner?.snapshot()?.operationIds).toHaveLength(1)
    expect(f.legacySpy).not.toHaveBeenCalled()
    expect(f.mapSpy).not.toHaveBeenCalled()
  })

  it('no-registry fallback drops a WS mark and the next request still sends main', async () => {
    // The log level may already be set to error. The fixture selects warning
    // after initialization so saved settings cannot suppress its log assertion.
    setLogLevel('error')
    const f = await fixture({ unsupported: true })
    await expect((await f.request()).text()).rejects.toMatchObject({
      isRetryable: true,
    })
    expect(f.limits().owner()?.registry).toBeUndefined()
    f.limits().owner()?.dropSignal()
    expect((await f.log()).match(/OpenAI limit signal dropped/g)).toHaveLength(
      1,
    )
    expect(f.limits().marks().size).toBe(0)
    f.succeedWs()
    await (await f.request()).text()
    expect(f.wire).toEqual(['Bearer main-token', 'Bearer main-token'])
    expect(f.legacySpy).not.toHaveBeenCalled()
    expect(f.mapSpy).not.toHaveBeenCalled()
  })

  it('HTTP 429 records no mark and a clean HTTP completion accepts dispatch time, not EOF', async () => {
    const f = await fixture({ ws: false })
    f.http(429, '{"error":{"type":"usage_limit_reached"}}')
    await (await f.request()).text()
    expect(f.limits().owner()?.snapshot()?.operationIds).toHaveLength(0)
    expect(f.limits().activity.get('limit-session')).toBeUndefined()
    let complete = () => {}
    f.http(
      200,
      new ReadableStream<Uint8Array>({
        start(controller) {
          complete = () => {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.completed"}\n\n',
              ),
            )
            controller.close()
          }
        },
      }),
    )
    const dispatchedAt = f.now()
    const response = await f.request()
    f.advance(240_000)
    complete()
    await response.text()
    expect(f.limits().activity.get('limit-session')).toMatchObject({
      accountKey: f.limits().accountKey('main'),
      lastAcceptedAt: dispatchedAt,
      ttlMs: 300_000,
    })
    expect(f.wire).toEqual([
      'Bearer main-token',
      'Bearer b-token',
      'Bearer main-token',
    ])
    expect(f.legacySpy).not.toHaveBeenCalled()
    expect(f.limits().owner()?.snapshot()?.operationIds).toHaveLength(0)
  })

  it('clean HTTP completion cannot clear a live mark published during the request', async () => {
    const f = await fixture({ ws: false })
    let complete = () => {}
    f.http(
      200,
      new ReadableStream<Uint8Array>({
        start(controller) {
          complete = () => {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.completed"}\n\n',
              ),
            )
            controller.close()
          }
        },
      }),
    )
    const response = await f.request()
    const owner = f.limits().owner()
    const binding = f
      .limits()
      .bindings()
      .find((binding) => binding.account.accountId === 'main')
    const observed = owner?.observe(binding)
    if (!owner || !observed) throw new Error('missing dispatch binding')
    owner.enqueue({
      type: 'mark',
      binding: observed.binding,
      baseRevision: observed.baseRevision,
      producerId: 'other-owner',
      operationId: 'live-mark',
      scope: { kind: 'pool' },
      window: 'account',
      cause: 'rate-limit',
      until: f.now() + 120_000,
      evidenceAt: f.now(),
      mergeLaw: 'max-until',
    })
    await owner.flush()
    complete()
    await response.text()
    await owner.flush()
    expect(owner.snapshot()?.marks).toHaveLength(1)
    expect(owner.snapshot()?.operationIds).toHaveLength(1)
  })

  it('WS completion earns one expired-probe clear and ordinary healthy turns add no writes', async () => {
    const f = await fixture()
    await expect((await f.request()).text()).rejects.toMatchObject({
      isRetryable: true,
    })
    const owner = f.limits().owner()
    await owner?.flush()
    f.advance(60_000)
    f.succeedWs()
    const dispatchedAt = f.now()
    await (await f.request()).text()
    await owner?.flush()
    expect(owner?.snapshot()?.marks).toEqual([])
    expect(owner?.snapshot()?.operationIds).toHaveLength(2)
    expect(f.limits().activity.get('limit-session')).toMatchObject({
      accountKey: f.limits().accountKey('main'),
      lastAcceptedAt: dispatchedAt,
      ttlMs: 300_000,
    })
    for (let n = 0; n < 20; n++) await (await f.request()).text()
    await owner?.flush()
    expect(owner?.snapshot()?.operationIds).toHaveLength(2)
    expect(f.legacySpy).not.toHaveBeenCalled()
  })
})

describe('legacy expiry and resolver boundaries', () => {
  it('expires exactly at the deadline in both account buckets and empty quota is not health', async () => {
    const { QuotaManager } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    let now = 7_000_000
    const manager = new QuotaManager({
      configPath: getAccountStoragePath(),
      storage: null,
      now: () => now,
    })
    for (const id of ['main', 'fallback']) {
      manager.markRateLimited(id, now + 60_000)
      if (id === 'main')
        manager.setMain(
          'token',
          { quota: {}, checkedAt: now, refreshAfter: now + 60_000 },
          'identity',
          true,
        )
      else
        manager.setFallback(
          id,
          { quota: {}, checkedAt: now, refreshAfter: now + 60_000 },
          'token',
          true,
          'identity',
        )
      expect(manager.isRateLimited(id)).toBe(true)
    }
    now += 60_000
    expect(manager.isRateLimited('main')).toBe(false)
    expect(manager.isRateLimited('fallback')).toBe(false)
  })

  it('invalid and equal explicit resets fall through to the exact named cache, never a sibling', async () => {
    const { resolveMidStreamRateLimitResetAt } = await import(
      '@cortexkit/openai-auth-core/internal'
    )
    const now = 7_000_000
    const reading = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: 1,
        resetsAt: new Date(now + 120_000).toISOString(),
      },
      secondary: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: now,
        resetsAt: new Date(now + 900_000).toISOString(),
      },
    }
    for (const reset of [
      now,
      now - 1,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        resolveMidStreamRateLimitResetAt(
          reading,
          'primary',
          now,
          60_000,
          reset,
        ),
      ).toBe(7_120_000)
      expect(
        resolveMidStreamRateLimitResetAt(
          reading,
          'capacity',
          now,
          60_000,
          reset,
        ),
      ).toBe(7_060_000)
    }
    reading.primary.resetsAt = new Date(now).toISOString()
    expect(
      resolveMidStreamRateLimitResetAt(reading, 'primary', now, 60_000),
    ).toBe(7_060_000)
  })
})
