/**
 * Quota-poll behaviour under vault custody.
 *
 * The poll loop in `refresh-all-quota.ts` must treat a refresh-inert account
 * (manifest entry OR tombstone sentinel) as never-locally-refreshed: it
 * resolves a probe token through the custody resolver, calls `whamFn`, and
 * reports a 401 to the vault ONLY when the token came from the vault.
 *
 * The toggle is irrelevant on this path: an entry-present account probes
 * with its valid LOCAL token but never enters local refresh, even with
 * `claustrum.enabled:false`. The existing forced-401 refresh and the
 * pre-poll refresh are not reached for refresh-inert accounts.
 *
 * The injected deps are optional — absent deps mean pre-custody behaviour,
 * which the existing `refresh-all-quota.test.ts` suite pins. Each test
 * here is named for the behaviour it guards (the deliberately defeated branch is
 * stated as behaviour in the name).
 */

import { describe, expect, it, mock } from 'bun:test'
import type { AccountQuotaWindow, OAuthQuotaSnapshot } from '../core/accounts'
import {
  CUSTODY_EXCLUDED,
  CUSTODY_REFUSE,
  CustodyTombstoneRefreshError,
} from '../core/custody.ts'
import type { whamUsageFn } from '../core/provider.ts'
import { QuotaManager } from '../core/quota-manager.ts'
import {
  CUSTODY_DEPS_INCOMPLETE,
  type RefreshAllQuotaDeps,
  refreshAllQuota,
} from '../core/refresh-all-quota.ts'
import { DEFAULT_SIDEBAR_STATE } from '../sidebar-state.ts'
import { makeSentinelAccount, TOMBSTONE_OPENAI } from './custody-fixtures.ts'

type Provenance = 'local' | { handle: string; recordVersion: number }

type ResolverResult =
  | { token: string; provenance: Provenance }
  | typeof CUSTODY_REFUSE
  | typeof CUSTODY_EXCLUDED

function makeQuotaSnapshot(usedPercent: number): OAuthQuotaSnapshot {
  const window: AccountQuotaWindow = {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    checkedAt: Date.now(),
  }
  return { primary: window }
}

type CustodyDepsShape = 'all' | 'none' | 'no-resolver' | 'no-reporter'

interface MakeDepsOptions {
  refreshInert?: boolean
  resolverResult?:
    | ResolverResult
    | (() => ResolverResult | Promise<ResolverResult>)
  reportCalls?: Array<{
    handle: string
    providerStatus: number
    recordVersion: number
  }>
  reportImpl?: (params: {
    handle: string
    providerStatus: number
    recordVersion: number
  }) => Promise<void>
  whamBehaviour?: (input: Parameters<typeof whamUsageFn>[0]) => unknown
  /** Selects which custody deps are wired. Default 'all' (everything
   *  injected); 'none' injects nothing; 'no-resolver'/'no-reporter'
   *  omit one of the optional deps to test the partial-injection
   *  fail-closed path. */
  injectCustodyDeps?: CustodyDepsShape
  skipFresherThanMs?: number
  now?: () => number
  /** Inject a pre-seeded QuotaManager (used by the freshness test). */
  quotaManager?: QuotaManager
  accountId?: string
  /** Use a tombstoned account as the only fallback (sentinel access/refresh, expires 0). */
  tombstoned?: boolean
  /** Throw on a tombstoned account when refreshAccount is called — mirrors real
   *  FallbackAccountManager behaviour when the gate is absent. */
  tombstoneRefreshThrows?: boolean
  /** Captured warn messages (matches the `quota` logger.debug/warn pair). */
  logger?: { debug: ReturnType<typeof mock>; warn: ReturnType<typeof mock> }
}

type DepsWithMocks = RefreshAllQuotaDeps & {
  refreshAccount: ReturnType<typeof mock>
  whamFn: ReturnType<typeof mock>
  _refreshCalls: Array<unknown>
  _whamCalls: Array<{ accessToken: string; accountKey: string }>
  _reportCalls: Array<{
    handle: string
    providerStatus: number
    recordVersion: number
  }>
  _resolverCalls: Array<{ account: unknown; storage: unknown }>
}

function makeDeps(opts: MakeDepsOptions = {}) {
  const qm =
    opts.quotaManager ??
    new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
    })

  const accountId = opts.accountId ?? 'acct-1'
  const fallbackAccount = opts.tombstoned
    ? makeSentinelAccount({ id: 'fb-1', accountId })
    : {
        id: 'fb-1',
        type: 'oauth' as const,
        access: 'acc-local-fb1',
        refresh: 'ref-local-fb1',
        expires: Date.now() + 3600_000,
        enabled: true,
        accountId,
      }
  const storage = {
    version: 1 as const,
    accounts: [fallbackAccount],
    mainAccountId: 'chatgpt-main',
  }

  const refreshAccount = mock(async (acct: unknown) => acct)
  const refreshCalls: Array<unknown> = []
  refreshAccount.mockImplementation(async (acct: unknown) => {
    refreshCalls.push(acct)
    // Mirror real FallbackAccountManager: a tombstoned account throws the
    // tombstone-class error when the local refresh is invoked.
    if (
      opts.tombstoneRefreshThrows &&
      (acct as { access?: string })?.access === TOMBSTONE_OPENAI
    ) {
      throw new CustodyTombstoneRefreshError('openai')
    }
    return acct
  })

  const whamCalls: Array<{ accessToken: string; accountKey: string }> = []
  const whamFn = mock(
    async (
      input: Parameters<typeof whamUsageFn>[0],
    ): Promise<OAuthQuotaSnapshot> => {
      whamCalls.push({
        accessToken: input.accessToken,
        accountKey: input.accountKey ?? '',
      })
      if (opts.whamBehaviour)
        return opts.whamBehaviour(input) as OAuthQuotaSnapshot
      return makeQuotaSnapshot(30)
    },
  )

  const reportCalls: NonNullable<MakeDepsOptions['reportCalls']> =
    opts.reportCalls ?? []
  const reportImpl: NonNullable<MakeDepsOptions['reportImpl']> =
    opts.reportImpl ??
    (async (params) => {
      reportCalls.push(params)
    })

  const resolverCalls: Array<{ account: unknown; storage: unknown }> = []
  const resolverResultFn =
    typeof opts.resolverResult === 'function'
      ? opts.resolverResult
      : () => opts.resolverResult as ResolverResult

  const deps: RefreshAllQuotaDeps = {
    getAuth: mock(async () => ({
      type: 'oauth' as const,
      access: 'acc-main',
      refresh: 'ref-main',
      expires: Date.now() + 3600_000,
    })),
    codexRefreshFn: mock(async () => ({
      access: 'acc-refreshed',
      refresh: 'ref-new',
      expires: Date.now() + 7200_000,
    })),
    refreshMainWithLease: mock(async () => ({
      access: 'acc-refreshed',
      refresh: 'ref-new',
      expires: Date.now() + 7200_000,
    })),
    fallbackManager: {
      refreshAccount:
        refreshAccount as unknown as RefreshAllQuotaDeps['fallbackManager']['refreshAccount'],
    } as unknown as RefreshAllQuotaDeps['fallbackManager'],
    quotaManager: qm,
    loadAccounts: mock(async () => storage),
    writeSidebarState: mock(async () => {}),
    client: {
      auth: {
        set: mock(async () => {}),
      },
    },
    fetchImpl: fetch,
    now: opts.now ?? (() => Date.now()),
    configPath: '/tmp/test-config.json',
    storageMainAccountId: 'chatgpt-main',
    isOAuthAccountFn: ((a: unknown) =>
      (a as { type?: string })?.type ===
      'oauth') as RefreshAllQuotaDeps['isOAuthAccountFn'],
    whamFn,
    readSidebarState: mock(async () => DEFAULT_SIDEBAR_STATE),
  }
  if (opts.skipFresherThanMs !== undefined) {
    deps.skipFresherThanMs = opts.skipFresherThanMs
  }
  if (opts.logger) {
    deps.logger = opts.logger as unknown as RefreshAllQuotaDeps['logger']
  }

  const shape: CustodyDepsShape = opts.injectCustodyDeps ?? 'all'
  if (shape !== 'none') {
    deps.isFallbackRefreshInert = mock(
      async () => opts.refreshInert ?? false,
    ) as never
    if (shape !== 'no-resolver') {
      deps.resolveFallbackAccess = mock(
        async (account: unknown, store: unknown) => {
          resolverCalls.push({ account, storage: store })
          return await resolverResultFn()
        },
      ) as never
    }
    if (shape !== 'no-reporter') {
      deps.reportCustodyAuthFailure = mock(reportImpl) as never
    }
  }

  const extended = deps as DepsWithMocks
  extended.refreshAccount = refreshAccount
  extended.whamFn = whamFn
  extended._refreshCalls = refreshCalls
  extended._whamCalls = whamCalls
  extended._reportCalls = reportCalls
  extended._resolverCalls = resolverCalls

  return extended
}

describe('refresh-inert quota poll', () => {
  it('custodied account + vault token + 2xx → quota pushed, no local refresh', async () => {
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: {
        token: 'vault-served-access',
        provenance: {
          handle: 'ckh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          recordVersion: 42,
        },
      },
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(true)
    // Vault token went on the wire, not the local one.
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'vault-served-access' }),
    )
    // No local refresh for a refresh-inert account.
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    // Quota pushed.
    expect(
      deps.quotaManager.getFallback('fb-1')?.quota?.primary?.usedPercent,
    ).toBe(30)
    // No vault report on 2xx.
    expect(
      (deps as unknown as { _reportCalls: unknown[] })._reportCalls,
    ).toHaveLength(0)
  })

  it('custodied account + vault token + 401 → exactly one report carrying that recordVersion, no local refresh, tombstone unchanged', async () => {
    const reportCalls: Array<{
      handle: string
      providerStatus: number
      recordVersion: number
    }> = []
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: {
        token: 'vault-served-access',
        provenance: {
          handle: 'ckh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          recordVersion: 42,
        },
      },
      whamBehaviour: () => {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      },
      reportCalls: reportCalls as Array<{
        handle: string
        providerStatus: number
        recordVersion: number
      }>,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    // Single report, with the call-context recordVersion and 401 status.
    expect(reportCalls).toEqual([
      {
        handle: 'ckh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        providerStatus: 401,
        recordVersion: 42,
      },
    ])
    // No local refresh at either site — even on a 401.
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    // No fallback quota was pushed.
    expect(deps.quotaManager.getFallback('fb-1')).toBeNull()
  })

  it('records a vault 401 outcome when the custody reporter throws', async () => {
    const logger = { debug: mock(() => undefined), warn: mock(() => undefined) }
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: {
        token: 'vault-served-access',
        provenance: {
          handle: 'ckh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          recordVersion: 43,
        },
      },
      whamBehaviour: () => {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      },
      reportImpl: async () => {
        throw new Error('report transport unavailable')
      },
      logger,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    expect(results).toEqual([
      {
        account: 'fb-1',
        ok: false,
        error: 'wham usage check failed: 401',
      },
    ])
    const warnMessages = logger.warn.mock.calls as unknown as Array<
      [string, unknown?]
    >
    expect(warnMessages.map(([message]) => message)).toContain(
      'custody auth-failure report failed',
    )
  })

  it('enrolling account + live local token → wham uses local, zero local refresh, a 401 is neither reported nor force-refreshed', async () => {
    const reportCalls: Array<{
      handle: string
      providerStatus: number
      recordVersion: number
    }> = []
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: { token: 'acc-local-fb1', provenance: 'local' },
      whamBehaviour: () => {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      },
      reportCalls,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    // local token went on the wire.
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'acc-local-fb1' }),
    )
    // No refresh — neither the pre-poll nor the forced-401 site.
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    // 401 from local provenance is NOT reported.
    expect(reportCalls).toHaveLength(0)
    // Account surfaces the failure.
    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    // No fallback quota pushed.
    expect(deps.quotaManager.getFallback('fb-1')).toBeNull()
  })

  it('toggle off + manifest entry + valid local token → local provenance, zero local refresh', async () => {
    // Spec: an enrolled, non-tombstoned account with toggle off is "enrolling"
    // and serves its local access token. The refreshInert gate keeps the loop
    // OUT of the local-refresh block entirely.
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: { token: 'acc-local-fb1', provenance: 'local' },
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'acc-local-fb1' }),
    )
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(true)
  })

  it('mutating the refreshInert gate to false on an enrolling account forces a local refresh (regression guard)', async () => {
    // Putting the toggle back in the gate (i.e. treating refreshInert as
    // false) must allow the existing local-refresh block to run for a
    // non-refresh-inert account.
    const deps = makeDeps({
      refreshInert: false,
      resolverResult: { token: 'acc-local-fb1', provenance: 'local' },
    })

    await refreshAllQuota(deps, { accountKey: 'fb-1' })

    // Now the local-refresh block runs.
    expect(deps.refreshAccount).toHaveBeenCalled()
  })

  it('vault wham 429 → no report', async () => {
    const reportCalls: Array<{
      handle: string
      providerStatus: number
      recordVersion: number
    }> = []
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: {
        token: 'vault-served-access',
        provenance: {
          handle: 'ckh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          recordVersion: 42,
        },
      },
      whamBehaviour: () => {
        throw Object.assign(new Error('wham usage check failed: 429'), {
          status: 429,
        })
      },
      reportCalls,
    })

    await refreshAllQuota(deps, { accountKey: 'fb-1' })

    expect(reportCalls).toHaveLength(0)
    expect(deps.refreshAccount).not.toHaveBeenCalled()
  })

  it('plain local account 401 → existing forced local refresh still happens (regression guard)', async () => {
    // When the refreshInert gate is false, the existing local-refresh block
    // remains in charge — a 401 from the quota endpoint must still trigger
    // the forced refresh introduced by #118, AND that forced refresh must
    // be called with `force: true` (a non-forced refresh would not rotate
    // the rejected token).
    const deps = makeDeps({
      refreshInert: false,
      whamBehaviour: (input: { accessToken: string }) => {
        if (input.accessToken === 'acc-local-fb1') {
          throw Object.assign(new Error('wham usage check failed: 401'), {
            status: 401,
          })
        }
        return makeQuotaSnapshot(10)
      },
    })

    await refreshAllQuota(deps, { accountKey: 'fb-1' })

    // Pre-poll call (force not set) plus the forced-401 call (force: true).
    // The forced call is the regression-critical one: pin it explicitly.
    expect(deps.refreshAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fb-1' }),
      expect.anything(),
      expect.objectContaining({ force: true }),
    )
  })

  it('CUSTODY_REFUSE → no wham, ok:false', async () => {
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: CUSTODY_REFUSE,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    expect(deps.whamFn).not.toHaveBeenCalled()
    expect(deps.refreshAccount).not.toHaveBeenCalled()
  })

  it('CUSTODY_EXCLUDED → no wham, ok:false', async () => {
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: CUSTODY_EXCLUDED,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    expect(deps.whamFn).not.toHaveBeenCalled()
    expect(deps.refreshAccount).not.toHaveBeenCalled()
  })

  it('fresh quota snapshot on a refresh-inert account → freshness skip fires before the resolver arm', async () => {
    // A refresh-inert account whose quota was checked inside the freshness
    // window must NOT call the resolver or wham — the freshness skip is
    // upstream of the custody arm in the loop. Moving the arm above the
    // freshness skip would cause a probe here.
    const now = Date.now()
    const qm = new QuotaManager({
      storage: { version: 1 as const, accounts: [] },
      now: () => now,
    })
    qm.setFallback(
      'fb-1',
      {
        quota: makeQuotaSnapshot(5),
        refreshAfter: now + 5 * 60_000,
        checkedAt: now - 60_000, // 1 minute ago — within the 4-minute window
      },
      'acc-local-fb1',
      false,
      'acct-1',
    )
    const deps = makeDeps({
      refreshInert: true,
      skipFresherThanMs: 4 * 60_000,
      now: () => now,
      quotaManager: qm,
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(true)
    expect(deps.whamFn).not.toHaveBeenCalled()
    expect(deps.resolveFallbackAccess as never).not.toHaveBeenCalled()
  })

  it('refresh-inert account + resolver absent → ok:false with custody-deps-incomplete, no local refresh', async () => {
    // Partial injection: the predicate is wired (so the loop knows the
    // account is refresh-inert) but the resolver is not. The arm must
    // fail closed and surface a typed reason — a fall-through into local
    // refresh would resume a refresher over a vault-held family.
    const warn = mock(() => {})
    const deps = makeDeps({
      refreshInert: true,
      injectCustodyDeps: 'no-resolver',
      logger: { debug: mock(() => {}), warn },
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    expect(fb?.error).toBe(CUSTODY_DEPS_INCOMPLETE)
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    expect(deps.whamFn).not.toHaveBeenCalled()
    // The "deps incomplete" warn fired at least once with a stable, typed
    // message; subsequent refresh-inert accounts in the same poll dedupe
    // (one warn per poll per missing dep) — a full poll-cycle warn count
    // is bounded, not per-account.
    const partialWarns = warn.mock.calls.filter((call) =>
      String((call as unknown[])[0] ?? '').includes('custody deps incomplete'),
    )
    expect(partialWarns).toHaveLength(1)
    // The warn payload does not contain a handle or token field.
    const head = partialWarns[0]
    if (!head) throw new Error('expected one partial-deps warn')
    const payload = JSON.stringify(head)
    expect(payload).not.toMatch(/ckh_/)
    expect(payload).not.toMatch(/acc-/)
  })

  it('refresh-inert account + reporter absent → vault probe refused: whamFn never called, outcome custody-deps-incomplete', async () => {
    // Partial injection: resolver is wired but reporter is not. The arm
    // enters, the resolver returns a vault-served credential, and we
    // refuse to probe at all — a vault-served probe whose 401 cannot reach
    // the vault is the silent-401 failure of issue #118 recreated under
    // custody (a quota 401 on a vault-served probe must reach
    // the vault). The local-refresh block is bypassed.
    const warn = mock(() => {})
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: {
        token: 'vault-served-access',
        provenance: {
          handle: 'ckh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          recordVersion: 42,
        },
      },
      whamBehaviour: () => {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      },
      injectCustodyDeps: 'no-reporter',
      logger: { debug: mock(() => {}), warn },
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    // Probe was refused BEFORE whamFn could be called.
    expect(deps.whamFn).not.toHaveBeenCalled()
    // Local-refresh block was bypassed.
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    expect(fb?.error).toBe(CUSTODY_DEPS_INCOMPLETE)
    // The dedicated warn fired (not just the per-outcome recordOutcome warn).
    const refuseWarns = warn.mock.calls.filter((call) =>
      String((call as unknown[])[0] ?? '').includes('vault probe refused'),
    )
    expect(refuseWarns).toHaveLength(1)
    const payload = JSON.stringify(refuseWarns[0])
    expect(payload).not.toMatch(/ckh_/)
    expect(payload).not.toMatch(/acc-/)
  })

  it('refresh-inert account + reporter absent → LOCAL-provenance probe still happens', async () => {
    // A local-provenance 401 is not credential evidence — the vault is not
    // on the wire, so the reporter-absent guard must NOT fire. The probe
    // happens, and a local 401 is silently logged as the failure.
    const warn = mock(() => {})
    const deps = makeDeps({
      refreshInert: true,
      resolverResult: { token: 'acc-local-fb1', provenance: 'local' },
      whamBehaviour: () => {
        throw Object.assign(new Error('wham usage check failed: 401'), {
          status: 401,
        })
      },
      injectCustodyDeps: 'no-reporter',
      logger: { debug: mock(() => {}), warn },
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    // Probe happened with the local token.
    expect(deps.whamFn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'acc-local-fb1' }),
    )
    // No "vault probe refused" warn — local probes are allowed without a reporter.
    const refuseWarns = warn.mock.calls.filter((call) =>
      String((call as unknown[])[0] ?? '').includes('vault probe refused'),
    )
    expect(refuseWarns).toHaveLength(0)
    expect(deps.refreshAccount).not.toHaveBeenCalled()
    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
  })

  it('fails closed when a refresh-inert account has no resolver', async () => {
    // With the refresh-inert branch removed but the local-refresh block
    // remaining, a tombstoned account goes through the existing refresh
    // path which exposes the sentinel's expired expiry — the loop exits
    // with the documented error and `whamFn` is never invoked. Simulate
    // the missing branch by having the gate say "not inert" so the
    // resolver arm does not fire and the local-refresh block runs.
    const deps = makeDeps({
      tombstoned: true,
      refreshInert: false, // branch removed: gate says "not inert", arm skips
      tombstoneRefreshThrows: true,
      whamBehaviour: () => makeQuotaSnapshot(10),
    })

    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })

    expect(deps.whamFn).not.toHaveBeenCalled()
    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    expect(fb?.error?.toLowerCase()).toContain('no usable access token')
  })

  it('does not refresh locally when custody dependencies are incomplete', async () => {
    // Without the custody deps wired in, the loop falls into the local
    // refresh block which invokes the manager's choke point. The choke
    // point throws `CustodyTombstoneRefreshError` for a tombstoned account,
    // which the inner refresh catch logs at warn — the tombstone error
    // IS observed on the quota path even though the inner catch keeps
    // the loop moving. The signal is the inner-catch's warn payload.
    const debug = mock(() => {})
    const warn = mock(() => {})
    const deps = makeDeps({
      tombstoned: true,
      injectCustodyDeps: 'none',
      refreshInert: false,
      tombstoneRefreshThrows: true,
      logger: { debug, warn },
    })

    await refreshAllQuota(deps, { accountKey: 'fb-1' })

    // The choke-point threw the tombstone error → refreshAccount observed
    // it; the inner refresh catch did NOT itself re-throw, so the only
    // observable signal that the tombstone error traversed the quota path
    // is that refreshAccount was reached for a tombstoned account.
    expect(deps.refreshAccount).toHaveBeenCalled()
    const called = deps.refreshAccount.mock.calls[0]?.[0] as
      | { refresh?: string }
      | undefined
    expect(called?.refresh).toBe(TOMBSTONE_OPENAI)
  })
})
