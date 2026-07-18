import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  loadAccounts,
  mutateAccounts,
  type OAuthQuotaSnapshot,
  type ResetInFlight,
} from '../core/accounts.ts'
import {
  claimResetAttempt,
  consumeResetCredit,
  evaluateResetPrecondition,
  listResetCredits,
  type ResetConsumeKind,
  type ResetCredit,
  type ResetCreditList,
  ResetRedemptionError,
  type RunResetCreditDeps,
  runResetCreditRedemption,
  selectCreditToSpend,
} from '../core/reset-credits.ts'

function fetchStub(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, {
    preconnect: (
      ..._args: Parameters<typeof globalThis.fetch.preconnect>
    ) => {},
  })
}

function credit(overrides: Partial<ResetCredit> = {}): ResetCredit {
  return {
    id: 'credit-1',
    status: 'available',
    expiresAt: '2026-08-01T00:00:00.000Z',
    resetType: 'codex_rate_limits',
    isSupportedByPlan: true,
    ...overrides,
  }
}

describe('reset credits list', () => {
  it('selects the eligible credit with the earliest expiry', () => {
    const late = credit({
      id: 'late',
      expiresAt: '2026-08-02T00:00:00.000Z',
    })
    const eligible = credit({
      id: 'eligible',
      expiresAt: '2026-08-01T00:00:00.000Z',
    })
    const credits = [late, eligible]

    expect(selectCreditToSpend(credits)).toBe(eligible)
    expect(credits).toEqual([late, eligible])
  })

  it('returns undefined when no credit is eligible', () => {
    const redeemed = credit({ id: 'redeemed', status: 'redeemed' })
    const unsupported = credit({
      id: 'unsupported',
      isSupportedByPlan: false,
    })
    const wrongType = credit({ id: 'wrong-type', resetType: 'other' })

    expect(
      selectCreditToSpend([redeemed, unsupported, wrongType]),
    ).toBeUndefined()
    expect(selectCreditToSpend([])).toBeUndefined()
  })

  it('normalizes missing arrays and counts', async () => {
    const result = await listResetCredits(
      fetchStub(async () => Response.json({})),
      'target-token',
    )

    expect(result).toEqual({
      credits: [],
      availableCount: undefined,
    })
  })

  it('parses the live credit-list shape and tolerates nullable optional fields', async () => {
    const result = await listResetCredits(
      fetchStub(async () =>
        Response.json({
          credits: [
            {
              id: 'credit-1',
              status: 'available',
              granted_at: '2026-07-01T00:00:00.000Z',
              expires_at: '2026-08-01T00:00:00.000Z',
              reset_type: 'codex_rate_limits',
              is_supported_by_plan: true,
              redeem_started_at: null,
              redeemed_at: null,
            },
            {
              id: 'credit-2',
              status: 'available',
              granted_at: '2026-07-02T00:00:00.000Z',
              expires_at: '2026-08-02T00:00:00.000Z',
              reset_type: 'codex_rate_limits',
              is_supported_by_plan: true,
              redeem_started_at: null,
              redeemed_at: null,
            },
            {
              id: 'credit-3',
              status: 'available',
              granted_at: null,
              expires_at: '2026-08-03T00:00:00.000Z',
              reset_type: null,
              is_supported_by_plan: true,
              redeem_started_at: null,
              redeemed_at: null,
            },
          ],
          available_count: 3,
          total_earned_count: 0,
        }),
      ),
      'target-token',
    )

    expect(result).toEqual({
      credits: [
        {
          id: 'credit-1',
          status: 'available',
          grantedAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-08-01T00:00:00.000Z',
          resetType: 'codex_rate_limits',
          isSupportedByPlan: true,
        },
        {
          id: 'credit-2',
          status: 'available',
          grantedAt: '2026-07-02T00:00:00.000Z',
          expiresAt: '2026-08-02T00:00:00.000Z',
          resetType: 'codex_rate_limits',
          isSupportedByPlan: true,
        },
        {
          id: 'credit-3',
          status: 'available',
          expiresAt: '2026-08-03T00:00:00.000Z',
          isSupportedByPlan: true,
        },
      ],
      availableCount: 3,
    })
  })

  it('ignores the obsolete nested credit-list key', async () => {
    const result = await listResetCredits(
      fetchStub(async () =>
        Response.json({
          rate_limit_reset_credits: [
            {
              id: 'obsolete-shape',
              status: 'available',
              expires_at: '2026-08-01T00:00:00.000Z',
              reset_type: 'codex_rate_limits',
              is_supported_by_plan: true,
            },
          ],
          available_count: 1,
          applicable_available_count: 1,
        }),
      ),
      'target-token',
    )

    expect(result.credits).toEqual([])
    expect(result.availableCount).toBe(1)
  })

  it('uses target authorization and omits the account header for main', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = fetchStub(async (input, init) => {
      capturedUrl = input.toString()
      capturedInit = init
      return Response.json({})
    })

    await listResetCredits(fetchImpl, 'target-token')

    const headers = new Headers(capturedInit?.headers)
    expect(capturedUrl).toBe(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    )
    expect(headers.get('authorization')).toBe('Bearer target-token')
    expect(headers.has('chatgpt-account-id')).toBe(false)
    expect(headers.get('oai-client-platform')).toBe('web')
    expect(headers.get('oai-client-version')).toBe('0')
    expect(headers.get('x-openai-target-path')).toBe(
      '/backend-api/wham/rate-limit-reset-credits',
    )
  })

  it('includes the fallback account header when supplied', async () => {
    let capturedInit: RequestInit | undefined
    const fetchImpl = fetchStub(async (_input, init) => {
      capturedInit = init
      return Response.json({})
    })

    await listResetCredits(fetchImpl, 'fallback-token', 'account-1')

    expect(new Headers(capturedInit?.headers).get('chatgpt-account-id')).toBe(
      'account-1',
    )
  })

  it('does not send an empty account header', async () => {
    let capturedInit: RequestInit | undefined
    const fetchImpl = fetchStub(async (_input, init) => {
      capturedInit = init
      return Response.json({})
    })

    await listResetCredits(fetchImpl, 'target-token', '')

    expect(new Headers(capturedInit?.headers).has('chatgpt-account-id')).toBe(
      false,
    )
  })

  it('aborts a hanging list fetch after 15 seconds and maps it to http_error', async () => {
    jest.useFakeTimers()
    try {
      let capturedSignal: AbortSignal | null | undefined
      const fetchImpl = fetchStub(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            capturedSignal = init?.signal
            capturedSignal?.addEventListener('abort', () => {
              reject(capturedSignal?.reason)
            })
          }),
      )

      const pending = listResetCredits(fetchImpl, 'target-token')

      expect(capturedSignal).toBeInstanceOf(AbortSignal)
      jest.advanceTimersByTime(14_999)
      await Promise.resolve()
      expect(capturedSignal?.aborted).toBe(false)

      jest.advanceTimersByTime(1)
      await expect(pending).rejects.toMatchObject({
        name: 'ResetCreditError',
        kind: 'http_error',
      })
      expect(capturedSignal?.aborted).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('reset credit consumption', () => {
  it('sends the exact request identity and retains the reset response', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const raw = { code: 'reset', reset_at: '2026-07-17T00:00:00.000Z' }
    const fetchImpl = fetchStub(async (input, init) => {
      capturedUrl = input.toString()
      capturedInit = init
      return Response.json(raw)
    })

    const outcome = await consumeResetCredit(
      fetchImpl,
      'target-token',
      'account-1',
      'credit-1',
      'redeem-request-1',
    )

    expect(capturedUrl).toBe(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
    )
    expect(capturedInit?.method).toBe('POST')
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      redeem_request_id: 'redeem-request-1',
      credit_id: 'credit-1',
    })
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer target-token')
    expect(headers.get('chatgpt-account-id')).toBe('account-1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-openai-target-path')).toBe(
      '/backend-api/wham/rate-limit-reset-credits/consume',
    )
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal)
    expect(capturedInit?.signal?.aborted).toBe(false)
    expect(outcome).toEqual({ kind: 'reset', raw })
  })

  for (const code of [
    'reset',
    'already_redeemed',
    'nothing_to_reset',
    'no_credit',
  ] as const satisfies readonly ResetConsumeKind[]) {
    it(`maps ${code} as a terminal outcome and retains raw`, async () => {
      const raw = { code, detail: `${code}-detail` }

      const outcome = await consumeResetCredit(
        fetchStub(async () => Response.json(raw)),
        'target-token',
        undefined,
        'credit-1',
        'redeem-request-1',
      )

      expect(outcome).toEqual({ kind: code, raw })
    })
  }

  it('maps non-2xx responses to http_error with status and raw', async () => {
    const raw = { error: 'unavailable' }

    const outcome = await consumeResetCredit(
      fetchStub(async () => Response.json(raw, { status: 503 })),
      'target-token',
      undefined,
      'credit-1',
      'redeem-request-1',
    )

    expect(outcome).toEqual({ kind: 'http_error', raw, status: 503 })
  })

  it('maps a rejected fetch to ambiguous and retains the error', async () => {
    const error = new TypeError('connection lost')

    const outcome = await consumeResetCredit(
      fetchStub(async () => {
        throw error
      }),
      'target-token',
      undefined,
      'credit-1',
      'redeem-request-1',
    )

    expect(outcome).toEqual({ kind: 'ambiguous', raw: error })
  })

  it('maps malformed JSON on 200 to ambiguous and retains the raw body', async () => {
    const outcome = await consumeResetCredit(
      fetchStub(async () => new Response('{not-json', { status: 200 })),
      'target-token',
      undefined,
      'credit-1',
      'redeem-request-1',
    )

    expect(outcome).toEqual({ kind: 'ambiguous', raw: '{not-json' })
  })

  it('maps an unknown success code to ambiguous and retains raw', async () => {
    const raw = { code: 'future_server_code', detail: 'unknown' }

    const outcome = await consumeResetCredit(
      fetchStub(async () => Response.json(raw)),
      'target-token',
      undefined,
      'credit-1',
      'redeem-request-1',
    )

    expect(outcome).toEqual({ kind: 'ambiguous', raw })
  })

  it('aborts a hanging fetch after 60 seconds and maps it to ambiguous', async () => {
    jest.useFakeTimers()
    try {
      let capturedSignal: AbortSignal | null | undefined
      const fetchImpl = fetchStub(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            capturedSignal = init?.signal
            capturedSignal?.addEventListener('abort', () => {
              reject(capturedSignal?.reason)
            })
          }),
      )

      let settled = false
      const pending = consumeResetCredit(
        fetchImpl,
        'target-token',
        undefined,
        'credit-1',
        'redeem-request-1',
      ).then((outcome) => {
        settled = true
        return outcome
      })

      expect(capturedSignal).toBeInstanceOf(AbortSignal)
      jest.advanceTimersByTime(59_999)
      await Promise.resolve()
      expect(capturedSignal?.aborted).toBe(false)
      expect(settled).toBe(false)

      jest.advanceTimersByTime(1)
      const outcome = await pending

      expect(capturedSignal?.aborted).toBe(true)
      expect(outcome.kind).toBe('ambiguous')
      expect(outcome.raw).toBe(capturedSignal?.reason)
    } finally {
      jest.useRealTimers()
    }
  })
})

function quotaWindow(
  usedPercent: number,
  resetsAt: string | undefined = '2026-07-18T00:00:00.000Z',
) {
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    checkedAt: Date.parse('2026-07-17T00:00:00.000Z'),
  }
}

describe('reset redemption precondition', () => {
  const now = Date.parse('2026-07-17T12:00:00.000Z')

  it('accepts an exhausted live window with an applicable credit', () => {
    expect(
      evaluateResetPrecondition({ primary: quotaWindow(100) }, false, 1, now),
    ).toEqual({ ok: true })
  })

  it('refuses healthy quota', () => {
    expect(
      evaluateResetPrecondition({ primary: quotaWindow(20) }, false, 1, now),
    ).toEqual({ ok: false, reason: 'not exhausted' })
  })

  it('refuses exhausted quota without applicable credits', () => {
    expect(
      evaluateResetPrecondition({ primary: quotaWindow(100) }, false, 0, now),
    ).toEqual({ ok: false, reason: 'no applicable credits' })
  })

  it('treats a 100%-used expired window as stale rather than exhausted', () => {
    expect(
      evaluateResetPrecondition(
        {
          primary: quotaWindow(100, '2026-07-17T11:59:59.999Z'),
        },
        false,
        1,
        now,
      ),
    ).toEqual({ ok: false, reason: 'not exhausted' })
  })

  it('accepts an exhausted live secondary window when primary is healthy', () => {
    expect(
      evaluateResetPrecondition(
        {
          primary: quotaWindow(20),
          secondary: quotaWindow(100),
        },
        false,
        1,
        now,
      ),
    ).toEqual({ ok: true })
  })

  it('treats an exhausted but expired secondary window as stale', () => {
    expect(
      evaluateResetPrecondition(
        {
          primary: quotaWindow(20),
          secondary: quotaWindow(100, '2026-07-17T11:59:59.999Z'),
        },
        false,
        1,
        now,
      ),
    ).toEqual({ ok: false, reason: 'not exhausted' })
  })

  it('preserves exhaustion for absent or unparseable reset times', () => {
    expect(
      evaluateResetPrecondition(
        { primary: quotaWindow(100, undefined) },
        false,
        1,
        now,
      ),
    ).toEqual({ ok: true })
    expect(
      evaluateResetPrecondition(
        { primary: quotaWindow(100, 'not-a-date') },
        false,
        1,
        now,
      ),
    ).toEqual({ ok: true })
  })

  it('lets a live rate-limit mark satisfy only exhaustion', () => {
    expect(evaluateResetPrecondition({}, true, 1, now)).toEqual({ ok: true })
    expect(evaluateResetPrecondition({}, true, 0, now)).toEqual({
      ok: false,
      reason: 'no applicable credits',
    })
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let redemptionDir: string
let redemptionConfigPath: string

beforeEach(() => {
  redemptionDir = mkdtempSync(join(tmpdir(), 'oai-reset-redemption-'))
  redemptionConfigPath = join(redemptionDir, 'openai-auth.json')
  writeFileSync(
    redemptionConfigPath,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
    }),
  )
})

afterEach(() => {
  jest.useRealTimers()
  rmSync(redemptionDir, { recursive: true, force: true })
})

function creditList(...credits: ResetCredit[]): ResetCreditList {
  return {
    credits,
    availableCount: credits.length,
  }
}

function listResponse(list = creditList(credit())): Response {
  return Response.json({
    credits: list.credits.map((item) => ({
      id: item.id,
      status: item.status,
      granted_at: item.grantedAt,
      expires_at: item.expiresAt,
      reset_type: item.resetType,
      is_supported_by_plan: item.isSupportedByPlan,
    })),
    available_count: list.availableCount,
  })
}

function requestBody(init?: RequestInit): {
  redeem_request_id: string
  credit_id: string
} {
  return JSON.parse(String(init?.body))
}

function redemptionDeps(
  options: {
    fetchImpl?: typeof fetch
    fetchUsage?: (target: {
      accountKey: string
      label: string
      accessToken: string
      chatgptAccountId?: string
    }) => Promise<OAuthQuotaSnapshot>
    now?: () => number
    randomUUID?: () => string
    hasActiveRateLimitMark?: (accountKey: string) => boolean
  } = {},
): RunResetCreditDeps {
  return {
    configPath: redemptionConfigPath,
    mutateAccountsFn: mutateAccounts,
    loadAccountsFn: loadAccounts,
    now: options.now ?? (() => Date.parse('2026-07-17T12:00:00.000Z')),
    randomUUID: options.randomUUID ?? (() => 'uuid-new'),
    fetchImpl:
      options.fetchImpl ??
      fetchStub(async (input) =>
        input.toString().endsWith('/consume')
          ? Response.json({ code: 'reset' })
          : listResponse(),
      ),
    resolveTarget: async (accountKey) => ({
      accountKey,
      label: accountKey === 'main' ? 'Main' : accountKey,
      accessToken: `${accountKey}-token`,
      chatgptAccountId: `${accountKey}-account-id`,
    }),
    fetchUsage:
      options.fetchUsage ??
      (async () => ({
        primary: quotaWindow(100),
        resetCreditsApplicable: 1,
      })),
    hasActiveRateLimitMark: options.hasActiveRateLimitMark ?? (() => false),
  }
}

function redemptionInput(accountKey = 'main', retry = false) {
  return {
    accountKey,
    expectedChatgptAccountId: `${accountKey}-account-id`,
    retry,
  }
}

async function seedResetState(
  accountKey: string,
  state: NonNullable<AccountStorage['reset']>[string],
): Promise<void> {
  await mutateAccounts((current) => {
    current.reset ??= {}
    current.reset[accountKey] = state
    return current
  }, redemptionConfigPath)
}

async function persistedResetState(accountKey = 'main') {
  return (await loadAccounts(redemptionConfigPath))?.reset?.[accountKey]
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('condition was not reached')
}

describe('atomic reset credit redemption', () => {
  it('binds main identity without sending it as a wire header', async () => {
    const requestHeaders: Headers[] = []
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async (input, init) => {
        requestHeaders.push(new Headers(init?.headers))
        return input.toString().endsWith('/consume')
          ? Response.json({ code: 'reset' })
          : listResponse()
      }),
    })
    deps.resolveTarget = async () => ({
      accountKey: 'main',
      label: 'Main account',
      accessToken: 'main-token',
      chatgptAccountId: 'chatgpt-main',
    })

    await runResetCreditRedemption(deps, {
      accountKey: 'main',
      expectedChatgptAccountId: 'chatgpt-main',
      retry: false,
    })

    expect(requestHeaders).toHaveLength(2)
    for (const headers of requestHeaders) {
      expect(headers.get('authorization')).toBe('Bearer main-token')
      expect(headers.has('chatgpt-account-id')).toBe(false)
    }
  })

  it('reuses one request and credit across genuinely overlapping confirms', async () => {
    const usageGate = deferred<void>()
    const listGate = deferred<void>()
    const pendingPosts: Deferred<Response>[] = []
    const postBodies: ReturnType<typeof requestBody>[] = []
    let usageCalls = 0
    let listCalls = 0
    let uuidCount = 0
    const fetchImpl = fetchStub(async (input, init) => {
      if (!input.toString().endsWith('/consume')) {
        listCalls += 1
        await listGate.promise
        return listResponse()
      }
      postBodies.push(requestBody(init))
      const pending = deferred<Response>()
      pendingPosts.push(pending)
      return pending.promise
    })
    const deps = redemptionDeps({
      fetchImpl,
      fetchUsage: async () => {
        usageCalls += 1
        await usageGate.promise
        return {
          primary: quotaWindow(100),
          resetCreditsApplicable: 1,
        }
      },
      randomUUID: () => `uuid-${++uuidCount}`,
    })

    const first = runResetCreditRedemption(deps, redemptionInput())
    const second = runResetCreditRedemption(deps, redemptionInput())
    await waitFor(() => usageCalls === 2 && listCalls === 2)
    usageGate.resolve()
    listGate.resolve()
    await waitFor(() => postBodies.length === 2)

    expect(pendingPosts).toHaveLength(2)
    expect(new Set(postBodies.map((body) => body.redeem_request_id))).toEqual(
      new Set(['uuid-1']),
    )
    expect(new Set(postBodies.map((body) => body.credit_id))).toEqual(
      new Set(['credit-1']),
    )
    expect(uuidCount).toBe(1)

    for (const pending of pendingPosts) {
      pending.resolve(Response.json({ code: 'reset' }))
    }
    await Promise.all([first, second])
  })

  it('atomically reuses one claim across two direct claimants', async () => {
    let uuidCount = 0
    const deps = redemptionDeps({
      randomUUID: () => `direct-uuid-${++uuidCount}`,
    })

    const [first, second] = await Promise.all([
      claimResetAttempt(deps, 'main', [credit()]),
      claimResetAttempt(deps, 'main', [credit()]),
    ])

    expect(first.kind).toBe('claim')
    expect(second.kind).toBe('claim')
    if (first.kind !== 'claim' || second.kind !== 'claim') {
      throw new Error('both direct claimants must return a persisted claim')
    }
    expect(first.claim.inFlight).toEqual(second.claim.inFlight)
    expect(first.claim.inFlight.redeemRequestId).toBe('direct-uuid-1')
    expect(uuidCount).toBe(1)
  })

  // Server-side dedup of a replayed (redeemRequestId, creditId) pair is
  // external behavior a unit suite cannot exercise; the live check is tracked
  // as verification debt in ARCHITECTURE.md. The replay tests pin the client
  // half of the contract instead — the exact persisted identity is re-sent,
  // which is what any server-side dedup keys on.
  it('replays both IDs from a younger-than-TTL in-flight attempt', async () => {
    const inFlight: ResetInFlight = {
      redeemRequestId: 'persisted-request',
      creditId: 'persisted-credit',
      startedAt: Date.parse('2026-07-17T11:58:00.000Z'),
    }
    await seedResetState('main', { inFlight })
    const postBodies: ReturnType<typeof requestBody>[] = []
    let usageCalls = 0
    const deps = redemptionDeps({
      fetchUsage: async () => {
        usageCalls += 1
        return { primary: quotaWindow(100) }
      },
      fetchImpl: fetchStub(async (input, init) => {
        expect(input.toString().endsWith('/consume')).toBe(true)
        postBodies.push(requestBody(init))
        return Response.json({ code: 'already_redeemed' })
      }),
    })

    await runResetCreditRedemption(deps, redemptionInput())

    expect(postBodies).toEqual([
      {
        redeem_request_id: 'persisted-request',
        credit_id: 'persisted-credit',
      },
    ])
    expect(usageCalls).toBe(0)
  })

  it('replays valid in-flight state even when fresh eligibility would fail', async () => {
    const inFlight: ResetInFlight = {
      redeemRequestId: 'rule-3a-request',
      creditId: 'rule-3a-credit',
      startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
    }
    await seedResetState('main', { inFlight })
    const postBodies: ReturnType<typeof requestBody>[] = []
    let usageCalls = 0
    const deps = redemptionDeps({
      fetchUsage: async () => {
        usageCalls += 1
        return { primary: quotaWindow(10) }
      },
      fetchImpl: fetchStub(async (input, init) => {
        expect(input.toString().endsWith('/consume')).toBe(true)
        postBodies.push(requestBody(init))
        return Response.json({ code: 'already_redeemed' })
      }),
    })

    await runResetCreditRedemption(deps, redemptionInput())

    expect(postBodies).toEqual([
      {
        redeem_request_id: 'rule-3a-request',
        credit_id: 'rule-3a-credit',
      },
    ])
    expect(usageCalls).toBe(0)
  })

  it('refuses confirm for an expired unreconciled pair without a wire call', async () => {
    const inFlight: ResetInFlight = {
      redeemRequestId: 'expired-request',
      creditId: 'expired-credit',
      startedAt: Date.parse('2026-07-17T11:54:59.999Z'),
    }
    await seedResetState('main', { inFlight })
    let wireCalls = 0
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async () => {
        wireCalls += 1
        return Response.json({ code: 'reset' })
      }),
    })

    await expect(
      runResetCreditRedemption(deps, redemptionInput()),
    ).rejects.toMatchObject({ kind: 'expired_unreconciled' })
    expect(wireCalls).toBe(0)
    expect(await persistedResetState()).toEqual({ inFlight })
  })

  it('retries an expired unreconciled pair with its exact persisted identifiers', async () => {
    const inFlight: ResetInFlight = {
      redeemRequestId: 'expired-request',
      creditId: 'expired-credit',
      startedAt: Date.parse('2026-07-17T11:54:59.999Z'),
    }
    await seedResetState('main', { inFlight })
    const postBodies: ReturnType<typeof requestBody>[] = []
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async (input, init) => {
        expect(input.toString().endsWith('/consume')).toBe(true)
        postBodies.push(requestBody(init))
        return Response.json({ code: 'already_redeemed' })
      }),
    })

    await runResetCreditRedemption(deps, redemptionInput('main', true))

    expect(postBodies).toEqual([
      {
        redeem_request_id: 'expired-request',
        credit_id: 'expired-credit',
      },
    ])
  })

  it('reopens the fresh path after an expired retry reconciles to no_credit', async () => {
    await seedResetState('main', {
      inFlight: {
        redeemRequestId: 'expired-request',
        creditId: 'expired-credit',
        startedAt: Date.parse('2026-07-17T11:54:59.999Z'),
      },
    })
    const postBodies: ReturnType<typeof requestBody>[] = []
    const deps = redemptionDeps({
      randomUUID: () => 'fresh-request',
      fetchImpl: fetchStub(async (input, init) => {
        if (!input.toString().endsWith('/consume')) return listResponse()
        postBodies.push(requestBody(init))
        return Response.json({
          code: postBodies.length === 1 ? 'no_credit' : 'reset',
        })
      }),
    })

    await runResetCreditRedemption(deps, redemptionInput('main', true))
    expect((await persistedResetState())?.inFlight).toBeUndefined()
    await runResetCreditRedemption(deps, redemptionInput())

    expect(postBodies).toEqual([
      {
        redeem_request_id: 'expired-request',
        credit_id: 'expired-credit',
      },
      { redeem_request_id: 'fresh-request', credit_id: 'credit-1' },
    ])
  })

  it('blocks an active cooldown without a consume request', async () => {
    await seedResetState('main', {
      cooldownUntil: Date.parse('2026-07-17T12:00:30.000Z'),
    })
    let fetchCalls = 0
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async () => {
        fetchCalls += 1
        return Response.json({ code: 'reset' })
      }),
    })

    await expect(
      runResetCreditRedemption(deps, redemptionInput()),
    ).rejects.toMatchObject({
      name: 'ResetRedemptionError',
      kind: 'cooldown_active',
    })
    expect(fetchCalls).toBe(0)
  })

  it('uses a read-only inspection before the atomic claim and finalize writes', async () => {
    let mutationCount = 0
    const deps = redemptionDeps()
    deps.mutateAccountsFn = async (mutator, configPath) => {
      mutationCount += 1
      return mutateAccounts(mutator, configPath)
    }

    await runResetCreditRedemption(deps, redemptionInput())

    expect(mutationCount).toBe(2)
  })

  for (const code of [
    'reset',
    'already_redeemed',
    'nothing_to_reset',
    'no_credit',
  ] as const) {
    it(`${code} clears in-flight state and applies only a spend cooldown`, async () => {
      await seedResetState('main', {
        inFlight: {
          redeemRequestId: `${code}-request`,
          creditId: `${code}-credit`,
          startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
        },
      })
      const deps = redemptionDeps({
        fetchImpl: fetchStub(async () => Response.json({ code })),
      })

      const result = await runResetCreditRedemption(deps, redemptionInput())

      const expected = {
        lastOutcome: {
          code,
          at: Date.parse('2026-07-17T12:00:00.000Z'),
        },
        ...(code === 'reset' || code === 'already_redeemed'
          ? { cooldownUntil: Date.parse('2026-07-17T12:01:00.000Z') }
          : {}),
      }
      expect(await persistedResetState()).toEqual(expected)
      if (code === 'nothing_to_reset' || code === 'no_credit') {
        expect(result.retrySafety).toContain('No cooldown was set')
        expect(result.retrySafety).toContain('gated by fresh preconditions')
        expect(result.retrySafety).not.toContain('cooldown blocks')
      }
    })
  }

  it('preserves the exact in-flight object after an ambiguous outcome', async () => {
    const inFlight: ResetInFlight = {
      redeemRequestId: 'ambiguous-request',
      creditId: 'ambiguous-credit',
      startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
    }
    await seedResetState('main', { inFlight })
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async () => new Response('{bad-json')),
    })

    await runResetCreditRedemption(deps, redemptionInput())

    expect(await persistedResetState()).toEqual({ inFlight })
  })

  it('preserves the exact in-flight object and skips cooldown on http_error', async () => {
    const inFlight: ResetInFlight = {
      redeemRequestId: 'http-request',
      creditId: 'http-credit',
      startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
    }
    await seedResetState('main', { inFlight })
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async () =>
        Response.json({ error: 'down' }, { status: 503 }),
      ),
    })

    await runResetCreditRedemption(deps, redemptionInput())

    expect(await persistedResetState()).toEqual({ inFlight })
  })

  it('times out a hanging consume without allowing a second UUID before TTL', async () => {
    jest.useFakeTimers()
    let current: AccountStorage = { version: 1, accounts: [] }
    const mutateAccountsFn: typeof mutateAccounts = async (mutator) => {
      current = mutator(current) ?? current
      return current
    }
    let uuidCount = 0
    const postBodies: ReturnType<typeof requestBody>[] = []
    let postCount = 0
    const fetchImpl = fetchStub(async (input, init) => {
      if (!input.toString().endsWith('/consume')) return listResponse()
      postBodies.push(requestBody(init))
      postCount += 1
      if (postCount === 2) return Response.json({ code: 'already_redeemed' })
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        )
      })
    })
    const deps = redemptionDeps({
      fetchImpl,
      randomUUID: () => `hang-uuid-${++uuidCount}`,
    })
    deps.mutateAccountsFn = mutateAccountsFn
    deps.loadAccountsFn = async () => current

    const first = runResetCreditRedemption(deps, redemptionInput())
    for (let turns = 0; turns < 20 && postCount === 0; turns += 1) {
      await Promise.resolve()
    }
    expect(postCount).toBe(1)
    jest.advanceTimersByTime(60_000)
    const firstResult = await first
    expect(firstResult.outcome.kind).toBe('ambiguous')

    await runResetCreditRedemption(deps, redemptionInput())

    expect(uuidCount).toBe(1)
    expect(postBodies).toHaveLength(2)
    expect(new Set(postBodies.map((body) => body.redeem_request_id))).toEqual(
      new Set(['hang-uuid-1']),
    )
  })

  it('resolves a corrupt in-flight record locally without list or consume', async () => {
    let current = {
      version: 1,
      accounts: [],
      reset: {
        main: {
          inFlight: {
            redeemRequestId: 'present',
            startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
          },
        },
      },
    } as unknown as AccountStorage
    const mutateAccountsFn: typeof mutateAccounts = async (mutator) => {
      current = mutator(current) ?? current
      return current
    }
    let wireCalls = 0
    const deps = {
      ...redemptionDeps(),
      mutateAccountsFn,
      loadAccountsFn: async () => current,
      fetchImpl: fetchStub(async () => {
        wireCalls += 1
        return Response.json({ code: 'reset' })
      }),
    }

    const result = await runResetCreditRedemption(deps, redemptionInput())

    expect(wireCalls).toBe(0)
    expect(result.outcome.kind).toBe('ambiguous_local')
    expect(current.reset?.main).toEqual({
      lastOutcome: {
        code: 'ambiguous_local',
        at: Date.parse('2026-07-17T12:00:00.000Z'),
      },
    })
  })

  it('round-trips a partial in-flight record and preserves the previous outcome when resolving it locally', async () => {
    writeFileSync(
      redemptionConfigPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        reset: {
          main: {
            inFlight: {
              redeemRequestId: 'partial-request',
              startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
            },
            lastOutcome: { code: 'reset', at: 123 },
          },
        },
      }),
    )
    expect(
      (await loadAccounts(redemptionConfigPath))?.reset?.main?.inFlight,
    ).toEqual({
      redeemRequestId: 'partial-request',
      startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
    })
    let wireCalls = 0
    const result = await runResetCreditRedemption(
      redemptionDeps({
        fetchImpl: fetchStub(async () => {
          wireCalls += 1
          return Response.json({ code: 'reset' })
        }),
      }),
      redemptionInput(),
    )

    expect(wireCalls).toBe(0)
    expect(result.outcome.kind).toBe('ambiguous_local')
    expect(await persistedResetState()).toEqual({
      lastOutcome: {
        code: 'ambiguous_local',
        at: Date.parse('2026-07-17T12:00:00.000Z'),
        previousOutcome: { code: 'reset', at: 123 },
      },
    })
  })

  it('returns a known terminal outcome when the finalize state write fails', async () => {
    const deps = redemptionDeps()
    deps.mutateAccountsFn = async (mutator, configPath) => {
      const state = (await loadAccounts(configPath))?.reset?.main
      if (state?.inFlight) throw new Error('finalize write failed')
      return mutateAccounts(mutator, configPath)
    }

    const result = await runResetCreditRedemption(deps, redemptionInput())

    expect(result.outcome.kind).toBe('reset')
    expect(result.finalizeStateWriteFailed).toBe(true)
    expect((await persistedResetState())?.inFlight).toMatchObject({
      redeemRequestId: 'uuid-new',
      creditId: 'credit-1',
    })
  })

  it('refuses prototype-sensitive account keys without mutating reset state', async () => {
    let mutationCount = 0
    const deps = redemptionDeps()
    deps.mutateAccountsFn = async (mutator, configPath) => {
      mutationCount += 1
      return mutateAccounts(mutator, configPath)
    }

    const decision = await claimResetAttempt(deps, '__proto__', [credit()])

    expect(decision.kind).toBe('fresh')
    expect(mutationCount).toBe(0)
    expect((await loadAccounts(redemptionConfigPath))?.reset).toBeUndefined()
  })

  it('observes persisted in-flight state from a new coordinator invocation', async () => {
    const firstBodies: ReturnType<typeof requestBody>[] = []
    await runResetCreditRedemption(
      redemptionDeps({
        randomUUID: () => 'persisted-across-invocations',
        fetchImpl: fetchStub(async (input, init) => {
          if (!input.toString().endsWith('/consume')) return listResponse()
          firstBodies.push(requestBody(init))
          return new Response('{ambiguous')
        }),
      }),
      redemptionInput(),
    )

    const secondBodies: ReturnType<typeof requestBody>[] = []
    await runResetCreditRedemption(
      redemptionDeps({
        randomUUID: () => 'must-not-be-used',
        fetchImpl: fetchStub(async (_input, init) => {
          secondBodies.push(requestBody(init))
          return Response.json({ code: 'already_redeemed' })
        }),
      }),
      redemptionInput('main', true),
    )

    expect(firstBodies).toEqual(secondBodies)
    expect(secondBodies[0]?.redeem_request_id).toBe(
      'persisted-across-invocations',
    )
  })

  it('isolates cooldown and transitions by exact account key', async () => {
    const mainState = {
      inFlight: {
        redeemRequestId: 'main-request',
        creditId: 'main-credit',
        startedAt: Date.parse('2026-07-17T11:59:00.000Z'),
      },
      cooldownUntil: Date.parse('2026-07-17T12:00:30.000Z'),
    }
    await seedResetState('main', mainState)

    await runResetCreditRedemption(
      redemptionDeps({ randomUUID: () => 'fallback-request' }),
      redemptionInput('fallback-a'),
    )

    expect(await persistedResetState('main')).toEqual(mainState)
    expect(await persistedResetState('fallback-a')).toEqual({
      lastOutcome: {
        code: 'reset',
        at: Date.parse('2026-07-17T12:00:00.000Z'),
      },
      cooldownUntil: Date.parse('2026-07-17T12:01:00.000Z'),
    })
  })

  it('rejects retry without valid in-flight state before any wire call', async () => {
    let wireCalls = 0
    const deps = redemptionDeps({
      fetchImpl: fetchStub(async () => {
        wireCalls += 1
        return Response.json({ code: 'reset' })
      }),
    })

    const rejection = runResetCreditRedemption(
      deps,
      redemptionInput('main', true),
    )
    await expect(rejection).rejects.toBeInstanceOf(ResetRedemptionError)
    await expect(rejection).rejects.toMatchObject({
      kind: 'retry_without_inflight',
    })
    expect(wireCalls).toBe(0)
  })

  it('replays the winner when a second confirm loses the claim race', async () => {
    const pendingPosts: Deferred<Response>[] = []
    const postBodies: ReturnType<typeof requestBody>[] = []
    let uuidCount = 0
    const deps = redemptionDeps({
      randomUUID: () => `race-uuid-${++uuidCount}`,
      fetchImpl: fetchStub(async (input, init) => {
        if (!input.toString().endsWith('/consume')) return listResponse()
        postBodies.push(requestBody(init))
        const pending = deferred<Response>()
        pendingPosts.push(pending)
        return pending.promise
      }),
    })

    const winner = runResetCreditRedemption(deps, redemptionInput())
    const loser = runResetCreditRedemption(deps, redemptionInput())
    await waitFor(() => postBodies.length === 2)

    expect(uuidCount).toBe(1)
    expect(postBodies[1]).toEqual(postBodies[0])

    for (const pending of pendingPosts) {
      pending.resolve(Response.json({ code: 'reset' }))
    }
    await Promise.all([winner, loser])
  })
})
