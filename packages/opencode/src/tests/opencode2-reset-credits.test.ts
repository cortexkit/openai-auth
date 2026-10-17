// OpenCode 2's Reset credits dependencies over the account pool: which
// account a credit is spent on, the quota re-check after a spend, and the
// quota view the shared section reads (`v2/reset-credits.ts`).
//
// The resolver reads the pool alone. An account the pool does not hold is
// refused as unknown, even when OpenCode 1's `auth.json` holds an OpenAI
// login; OpenCode 1's resolver would fall back to that login, OpenCode 2's
// never does.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  loadAccounts,
} from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source'
import {
  createPoolQuotaPull,
  createPoolResetDeps,
  ResetCreditCounts,
  type ResetPoolAccess,
} from '../v2/reset-credits'
import { type PoolFiles, poolFiles, seedPool } from './fixtures/opencode2-host'
import { type Json, jwt } from './fixtures/pool-migration-harness'
import { FLOOR_ENV } from './setup-env'

const HOUR = 3600_000
// A fixed clock an hour ahead of the real one, so a reading stamped with it
// can only have come from the injected clock.
const NOW = Date.now() + HOUR

const dirs: string[] = []
const sources: PoolAccountSource[] = []
// Each test that points XDG_DATA_HOME elsewhere is returned to the test floor.
const savedDataHome = FLOOR_ENV.XDG_DATA_HOME

afterEach(async () => {
  for (const source of sources.splice(0)) {
    source.dispose()
    await source.settled()
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
  process.env.XDG_DATA_HOME = savedDataHome
})

function files(): PoolFiles {
  const pool = poolFiles()
  dirs.push(pool.dir)
  return pool
}

function editJson(path: string, edit: (json: Json) => void) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  edit(json)
  writeFileSync(path, JSON.stringify(json))
}

type Access = Awaited<ReturnType<ResetPoolAccess['rowAccess']>>

/** A pool source whose `rowAccess` answers `access` and records its calls. */
function standIn(access: Access) {
  const calls: Array<[string, AccountStorage | null]> = []
  const source: ResetPoolAccess = {
    rowAccess: async (id, storage) => {
      calls.push([id, storage])
      return access
    },
    pollRows: async () => {
      throw new Error('no poll expected')
    },
    peek: () => ({ active: true, rows: [] }),
    rateLimitMarks: () => new Map(),
  }
  return { source, calls }
}

const STORAGE = { version: 1, accounts: [] } as unknown as AccountStorage

function depsOver(source: ResetPoolAccess, now: () => number = () => NOW) {
  return createPoolResetDeps({
    source,
    storage: async () => STORAGE,
    counts: new ResetCreditCounts(),
    now,
  })
}

describe('OpenCode 2 reset target resolver', () => {
  it('asks the pool source for the row with the current settings', async () => {
    const { source, calls } = standIn({
      row: { id: 'alpha', type: 'oauth', enabled: true, identity: 'chatgpt-a' },
      token: 'alpha-token',
    })
    const target = await depsOver(source).resolveResetTarget('alpha')
    expect(calls).toEqual([['alpha', STORAGE]])
    expect(target).toEqual({
      accountKey: 'alpha',
      label: 'alpha',
      accessToken: 'alpha-token',
      chatgptAccountId: 'chatgpt-a',
    })
  })

  it('reports row main as the main account and takes the identity from the token when the row has none', async () => {
    const { source } = standIn({
      row: { id: 'main', type: 'oauth', enabled: true, label: 'work' },
      token: jwt('chatgpt-from-token'),
    })
    expect(await depsOver(source).resolveResetTarget('main')).toEqual({
      accountKey: 'main',
      label: 'Main account',
      accessToken: jwt('chatgpt-from-token'),
      chatgptAccountId: 'chatgpt-from-token',
    })
  })

  const refusals: Array<[string, Access, string]> = [
    ['an install not moved into the pool', undefined, 'unknown_account'],
    ['no row with the id', {}, 'unknown_account'],
    [
      'a disabled row',
      {
        row: { id: 'alpha', type: 'oauth', enabled: false },
        token: 'alpha-token',
      },
      'disabled_account',
    ],
    [
      'a non-OAuth row',
      { row: { id: 'alpha', type: 'api', enabled: true }, token: 'key' },
      'non_oauth_account',
    ],
    [
      'a row with no usable token',
      { row: { id: 'alpha', type: 'oauth', enabled: true } },
      'token_unavailable',
    ],
  ]
  for (const [name, access, code] of refusals) {
    for (const key of ['main', 'alpha']) {
      it(`refuses ${name} as ${code} (${key})`, async () => {
        const row = access?.row ? { ...access.row, id: key } : undefined
        const { source } = standIn(
          access === undefined
            ? undefined
            : { ...access, ...(row ? { row } : {}) },
        )
        await expect(
          depsOver(source).resolveResetTarget(key),
        ).rejects.toMatchObject({ code })
      })
    }
  }
})

/** A real pool source over seeded files. */
function realSource(
  pool: PoolFiles,
  options: {
    refresh?: () => Promise<{
      access: string
      refresh: string
      expires: number
    }>
    pullQuota?: ConstructorParameters<typeof PoolAccountSource>[0]['pullQuota']
    now?: () => number
  } = {},
) {
  const refreshes: string[] = []
  const source = new PoolAccountSource({
    paths: pool.paths,
    refreshProvider: async (credential) => {
      refreshes.push(credential.refresh)
      if (!options.refresh) throw new Error('no refresh expected')
      return { ...(await options.refresh()), identity: 'chatgpt-alpha' }
    },
    pullQuota: options.pullQuota ?? (async () => undefined),
    ...(options.now ? { now: options.now } : {}),
  })
  sources.push(source)
  return { source, refreshes }
}

function poolDeps(
  pool: PoolFiles,
  source: PoolAccountSource,
  counts = new ResetCreditCounts(),
  now: () => number = () => NOW,
  authority?: () => Promise<'vault' | 'local' | 'unreadable'>,
) {
  return createPoolResetDeps({
    source,
    storage: () => loadAccounts(pool.paths()),
    counts,
    now,
    ...(authority ? { authority } : {}),
  })
}

describe('OpenCode 2 reset target resolver over the pool', () => {
  it('resolves an expired row after refreshing it, not as tokenless', async () => {
    const pool = files()
    seedPool(pool, 'ordered', [{ id: 'main' }, { id: 'alpha' }])
    editJson(pool.statePath, (state) => {
      state.accounts.alpha.expires = Date.now() - 60_000
    })
    const { source, refreshes } = realSource(pool, {
      refresh: async () => ({
        access: 'alpha-fresh',
        refresh: 'alpha-refresh-2',
        expires: Date.now() + HOUR,
      }),
    })
    await source.load()
    const target = await poolDeps(pool, source).resolveResetTarget('alpha')
    expect(refreshes).toEqual(['alpha-refresh'])
    expect(target).toMatchObject({
      accountKey: 'alpha',
      accessToken: 'alpha-fresh',
      chatgptAccountId: 'chatgpt-alpha',
    })
  })

  it('refuses an expired row whose refresh fails as tokenless', async () => {
    const pool = files()
    seedPool(pool, 'ordered', [{ id: 'main' }, { id: 'alpha' }])
    editJson(pool.statePath, (state) => {
      state.accounts.alpha.expires = Date.now() - 60_000
    })
    const { source } = realSource(pool)
    await source.load()
    await expect(
      poolDeps(pool, source).resolveResetTarget('alpha'),
    ).rejects.toMatchObject({ code: 'token_unavailable' })
  })

  it('refuses a disabled row and a missing one, and resolves main from row main', async () => {
    const pool = files()
    seedPool(pool, 'ordered', [{ id: 'main' }, { id: 'off' }])
    editJson(pool.configPath, (config) => {
      for (const account of config.accounts)
        if (account.id === 'off') account.enabled = false
    })
    const { source } = realSource(pool)
    await source.load()
    const deps = poolDeps(pool, source)
    expect(await deps.resolveResetTarget('main')).toMatchObject({
      accountKey: 'main',
      label: 'Main account',
      accessToken: 'main-token',
      chatgptAccountId: 'chatgpt-main',
    })
    await expect(deps.resolveResetTarget('off')).rejects.toMatchObject({
      code: 'disabled_account',
    })
    await expect(deps.resolveResetTarget('missing')).rejects.toMatchObject({
      code: 'unknown_account',
    })
  })

  it('a pool miss resolves no host login, even when OpenCode 1 holds one', async () => {
    // OpenCode 1's `auth.json` holds a real OpenAI login under its `openai`
    // key: the login OpenCode 1's resolver would fall back to for `main`.
    const dataHome = mkdtempSync(join(tmpdir(), 'oai-oc2-data-'))
    dirs.push(dataHome)
    process.env.XDG_DATA_HOME = dataHome
    mkdirSync(join(dataHome, 'opencode'), { recursive: true })
    writeFileSync(
      join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({
        openai: {
          type: 'oauth',
          access: jwt('chatgpt-host-login'),
          refresh: 'host-refresh',
          expires: Date.now() + 24 * HOUR,
        },
      }),
    )
    // Two misses: a migrated pool holding only row `alpha`, and an install
    // whose config has no `openaiAuthPool` record, so the pool serves nothing.
    const migrated = files()
    seedPool(migrated, 'ordered', [{ id: 'alpha' }])
    const unmigrated = files()
    seedPool(unmigrated, 'ordered', [{ id: 'main' }])
    editJson(unmigrated.configPath, (config) => {
      delete config.openaiAuthPool
    })
    for (const pool of [migrated, unmigrated]) {
      const { source } = realSource(pool)
      await source.load()
      for (const key of ['main', 'ghost'])
        await expect(
          poolDeps(pool, source).resolveResetTarget(key),
        ).rejects.toMatchObject({ code: 'unknown_account' })
    }
  })
})

/** A `wham/usage` reply with both windows and the given credit counts. */
function usageReply(credits: { available?: number; applicable?: number }) {
  const resetAt = Math.floor((NOW + 2 * HOUR) / 1000)
  return {
    rate_limit: {
      primary_window: {
        used_percent: 30,
        limit_window_seconds: 18_000,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: 40,
        limit_window_seconds: 604_800,
        reset_at: resetAt,
      },
    },
    rate_limit_reset_credits: {
      ...(credits.available !== undefined
        ? { available_count: credits.available }
        : {}),
      ...(credits.applicable !== undefined
        ? { applicable_available_count: credits.applicable }
        : {}),
    },
  }
}

/** Answers every usage poll with `reply` and records each poll's bearer. */
function usageServer() {
  const server = {
    reply: usageReply({}) as unknown,
    bearers: [] as string[],
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      server.bearers.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(JSON.stringify(server.reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  }
  return server
}

function savedQuota(pool: PoolFiles, id: string) {
  return pool.readConfig().commonAuthPool.rows[id]?.quota as
    | {
        limits?: Array<{
          label: string
          checkedAt: number
          usedPercent: number
        }>
        counters?: { resetCredits?: { value: number; checkedAt: number } }
      }
    | undefined
}

describe('OpenCode 2 reset quota re-check and quota view', () => {
  async function polledPool() {
    const pool = files()
    seedPool(pool, 'ordered', [{ id: 'main' }, { id: 'alpha' }])
    const server = usageServer()
    const counts = new ResetCreditCounts()
    let clock = NOW
    const now = () => clock
    const { source } = realSource(pool, {
      pullQuota: createPoolQuotaPull({
        fetchImpl: server.fetchImpl,
        now,
        counts,
      }),
      now,
    })
    await source.load()
    // Loading may start the source's own background polls; let them end so
    // each test sees only the polls it asks for.
    await source.settled()
    server.bearers.length = 0
    const deps = poolDeps(pool, source, counts, now)
    return {
      pool,
      server,
      source,
      deps,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  it('writes the pool quota map at the injected time and keeps the applicable count apart: available 5, applicable 2', async () => {
    const { pool, server, deps } = await polledPool()
    server.reply = usageReply({ available: 5, applicable: 2 })
    expect(await deps.refreshResetTargetQuota('alpha')).toEqual({
      account: 'alpha',
      ok: true,
    })
    expect(server.bearers).toEqual(['Bearer alpha-token'])

    const saved = savedQuota(pool, 'alpha')
    expect(saved?.counters?.resetCredits).toEqual({ value: 5, checkedAt: NOW })
    expect(
      saved?.limits?.map(({ label, checkedAt, usedPercent }) => ({
        label,
        checkedAt,
        usedPercent,
      })),
    ).toEqual([
      { label: 'primary', checkedAt: NOW, usedPercent: 30 },
      { label: 'secondary', checkedAt: NOW, usedPercent: 40 },
    ])

    const entry = deps.quotaManager.getFallback('alpha')
    expect(entry?.quota.primary?.usedPercent).toBe(30)
    expect(entry?.quota.secondary?.usedPercent).toBe(40)
    expect(entry?.quota.resetCreditsApplicable).toBe(2)
    expect(entry?.accountId).toBe('chatgpt-alpha')
  })

  it('omits the applicable count when the last poll carried none, and never shows the available count in its place', async () => {
    const { pool, server, deps } = await polledPool()
    server.reply = usageReply({ available: 5, applicable: 2 })
    await deps.refreshResetTargetQuota('main')
    expect(deps.quotaManager.getMain()?.quota.resetCreditsApplicable).toBe(2)

    server.reply = usageReply({ available: 0 })
    expect(await deps.refreshResetTargetQuota('main')).toEqual({
      account: 'main',
      ok: true,
    })
    expect(savedQuota(pool, 'main')?.counters?.resetCredits).toEqual({
      value: 0,
      checkedAt: NOW,
    })
    const quota = deps.quotaManager.getMain()?.quota
    expect(quota?.primary?.usedPercent).toBe(30)
    expect(quota && 'resetCreditsApplicable' in quota).toBe(false)

    server.reply = usageReply({ available: 5 })
    await deps.refreshResetTargetQuota('main')
    expect(
      deps.quotaManager.getMain()?.quota.resetCreditsApplicable,
    ).toBeUndefined()
  })

  it('reports an unknown account and a vault-mode host without polling', async () => {
    const { pool, server, source, deps } = await polledPool()
    expect(await deps.refreshResetTargetQuota('ghost')).toEqual({
      account: 'ghost',
      ok: false,
      error: 'targeted quota refresh returned no result',
    })
    const vaultDeps = poolDeps(
      pool,
      source,
      new ResetCreditCounts(),
      () => NOW,
      async () => 'vault',
    )
    expect(await vaultDeps.refreshResetTargetQuota('alpha')).toEqual({
      account: 'alpha',
      ok: false,
      error:
        'local accounts are not polled while this host is connected to the vault',
    })
    expect(server.bearers).toEqual([])
    expect(deps.quotaManager.getFallback('ghost')).toBeNull()
  })

  it('is rate limited while the pool mark runs past now', async () => {
    const { source, deps, advance } = await polledPool()
    expect(deps.quotaManager.isRateLimited('alpha')).toBe(false)
    source.markRateLimited('alpha', NOW + 1_000)
    expect(deps.quotaManager.isRateLimited('alpha')).toBe(true)
    expect(deps.quotaManager.isRateLimited('main')).toBe(false)
    expect(deps.quotaManager.isRateLimited('ghost')).toBe(false)
    advance(999)
    expect(deps.quotaManager.isRateLimited('alpha')).toBe(true)
    advance(1)
    expect(deps.quotaManager.isRateLimited('alpha')).toBe(false)
  })
})

describe('OpenCode 2 reset credit counts', () => {
  it('drops a count polled under a credential the row no longer holds', () => {
    const counts = new ResetCreditCounts()
    counts.record(
      { id: 'alpha', credentialEpoch: 1, identity: 'chatgpt-a' },
      { resetCreditsApplicable: 2 },
    )
    const row = { id: 'alpha', credentialEpoch: 1, identity: 'chatgpt-a' }
    expect(counts.applicable(row)).toBe(2)
    expect(counts.applicable({ ...row, credentialEpoch: 2 })).toBeUndefined()
    expect(
      counts.applicable({ ...row, identity: 'chatgpt-b' } as Pick<
        PoolRow,
        'id' | 'credentialEpoch' | 'identity'
      >),
    ).toBeUndefined()
  })
})
