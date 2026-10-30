import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mutateVaultRoster } from '@cortexkit/common-auth/claustrum'
import { quotaCreditsText } from '@cortexkit/common-auth/quota'

import { flushForTest, initLogger, resetLoggerForTest } from '../logger'
import { windowsFromQuotaMap } from '../pool-quota'
import {
  FIRST_QUOTA_READING_WAIT_MS,
  planOrdered,
  waitForFirstQuotaReading,
} from '../pool-routing'
import { OpenAiVault } from '../vault'
import {
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from './fixtures/mock-claustrum'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(enroll = true) {
  const dir = await mkdtemp(join(tmpdir(), 'openai-insula-'))
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: {
      a: vaultLogin('account-a', {
        wire: { email: 'account-a@example.com' },
      }),
      b: vaultLogin('account-b'),
    },
  })
  let now = Date.now()
  const wham: string[] = []
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'vault'),
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    now: () => now,
    fetchImpl: () =>
      (async (_input, init) => {
        const account =
          new Headers(init?.headers).get('ChatGPT-Account-Id') ?? 'unknown'
        wham.push(account)
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: Math.floor((now + 3600000) / 1000),
              limit_window_seconds: 18000,
            },
          },
          spend_control: null,
        })
      }) as typeof fetch,
  })
  cleanups.push(async () => {
    vault.close()
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  })
  if (enroll) {
    await mkdir(join(dir, 'vault'), { mode: 0o700 })
    await writeFile(
      vault.paths.tokenPath,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await vault.refresh()
  }
  return {
    dir,
    vault,
    daemon,
    wham,
    get now() {
      return now
    },
    advance(ms: number) {
      now += ms
    },
  }
}

function current(now: number, account = 'account-a') {
  return {
    provider: 'codex',
    account,
    fetchedAt: new Date(now - 60_000).toISOString(),
    source: 'vault',
    usage: {
      primary: { usedPercent: 0, rawUsedPercent: 100, windowMinutes: 300 },
      secondary: { usedPercent: 35, windowMinutes: 10080 },
    },
  }
}

function route(vault: OpenAiVault, identity = 'account-a') {
  const found = vault.routes().find((row) => row.identity === identity)
  if (!found) throw new Error(`missing route ${identity}`)
  return found.id
}

describe('vault insula quota', () => {
  for (const unlimited of [true, false]) {
    test(`explicit insula unlimited ${unlimited} replaces the previous verdict`, async () => {
      const env = await setup()
      const id = route(env.vault)
      const receipt = await env.vault.authorize(id)
      await env.vault.recordSnapshot(
        id,
        {
          primary: { usedPercent: 10 },
          credits: { hasCredits: true, unlimited: !unlimited },
        },
        false,
        receipt!,
      )
      env.advance(120_000)
      env.daemon.insula = {
        reply: {
          result: [
            {
              ...current(env.now),
              spend: [
                {
                  id: 'credits',
                  label: 'Prepaid credits',
                  funding: 'unknown',
                  basis: 'unstated',
                  unlimited,
                },
              ],
            },
          ],
        },
      }
      expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
      const credits = env.vault.routes().find((row) => row.id === id)
        ?.quota?.credits
      expect(credits).toEqual({
        hasCredits: true,
        unlimited,
        checkedAt: env.now - 60_000,
      })
      expect(quotaCreditsText(credits)).toBe(
        unlimited ? 'Unlimited' : 'Available',
      )
      expect(env.wham).toEqual([])
    })
  }

  test('background credits use the insula fetch time and route before exhausted accounts without credits', async () => {
    const env = await setup()
    const a = route(env.vault)
    const b = route(env.vault, 'account-b')
    const entry = (account: string) => {
      const value = current(env.now, account)
      return {
        ...value,
        usage: {
          primary: {
            ...value.usage.primary,
            resetsAt: new Date(env.now + 3600_000).toISOString(),
          },
          secondary: {
            ...value.usage.secondary,
            resetsAt: new Date(env.now + 86_400_000).toISOString(),
          },
        },
      }
    }
    env.daemon.insula = {
      reply: {
        result: [
          entry('account-a'),
          {
            ...entry('account-b'),
            spend: [
              {
                id: 'credits',
                label: 'Prepaid credits',
                funding: 'unknown',
                basis: 'reported',
                remaining: { minor: 125, exponent: 1, unit: 'credit' },
              },
            ],
          },
        ],
      },
    }
    expect(await env.vault.pollStale(0)).toEqual([
      { id: a, ok: true },
      { id: b, ok: true },
    ])
    expect(
      env.vault.routes().find((row) => row.id === b)?.quota?.credits,
    ).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 12.5,
      checkedAt: env.now - 60_000,
    })
    const input = () => ({
      rows: env.vault.routes(),
      now: env.now,
      placement: 'roster' as const,
      mainId: null,
      killswitch: new Map([
        [a, true],
        [b, true],
      ]),
      rateLimitMarks: new Map<string, number>(),
      refreshBackoff: new Map<string, number>(),
      requestPull: () => {},
    })
    expect(planOrdered(input())).toMatchObject({
      kind: 'send',
      order: [b, a],
      lastPath: false,
    })
    env.advance(15 * 60_000)
    expect(planOrdered(input())).not.toMatchObject({
      kind: 'send',
      order: [b, a],
      lastPath: false,
    })
    expect(env.wham).toEqual([])
    expect(env.daemon.gets).toEqual([])
  })

  test('an absent insula credits pool preserves the previous reading without refreshing its time', async () => {
    const env = await setup()
    const id = route(env.vault)
    const receipt = await env.vault.authorize(id)
    const credits = {
      hasCredits: true,
      unlimited: false,
      balance: 42,
      checkedAt: env.now,
    }
    await env.vault.recordSnapshot(
      id,
      { primary: { usedPercent: 10 }, credits },
      false,
      receipt!,
    )
    env.advance(60_000)
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
    expect(
      env.vault.routes().find((row) => row.id === id)?.quota?.credits,
    ).toEqual(credits)
  })

  test('a balance-less insula pool refreshes but never downgrades explicit unlimited credits', async () => {
    const env = await setup()
    const id = route(env.vault)
    const receipt = await env.vault.authorize(id)
    await env.vault.recordSnapshot(
      id,
      {
        primary: { usedPercent: 10 },
        credits: { hasCredits: true, unlimited: true },
      },
      false,
      receipt!,
    )
    env.advance(120_000)
    env.daemon.insula = {
      reply: {
        result: [
          {
            ...current(env.now),
            spend: [
              {
                id: 'credits',
                label: 'Prepaid credits',
                funding: 'unknown',
                basis: 'unstated',
              },
            ],
          },
        ],
      },
    }
    expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
    expect(
      env.vault.routes().find((row) => row.id === id)?.quota?.credits,
    ).toEqual({
      hasCredits: true,
      unlimited: true,
      checkedAt: env.now - 60_000,
    })
    env.advance(60_000)
    await env.vault.pollQuota(id, false)
    expect(
      env.vault.routes().find((row) => row.id === id)?.quota?.credits
        ?.unlimited,
    ).toBe(true)
  })

  test('three matched accounts add no discovery to a background tick', async () => {
    const env = await setup()
    env.daemon.credentials.c = vaultLogin('account-c')
    await env.vault.refresh()
    env.daemon.insula = {
      reply: {
        result: ['account-a', 'account-b', 'account-c'].map((account) =>
          current(env.now, account),
        ),
      },
    }
    const listsBefore = env.daemon.lists
    // A metadata tick already discovers the roster once. Its quota pass must
    // consume cached readings without adding per-account inventory requests.
    await env.vault.refresh()
    expect(await env.vault.pollStale(0)).toHaveLength(3)
    expect(env.daemon.lists - listsBefore).toBe(1)
    expect(env.daemon.gets).toEqual([])
    expect(env.wham).toEqual([])
    expect(env.daemon.insulaReads).toBe(1)
    for (const row of env.vault.routes()) {
      expect(windowsFromQuotaMap(row.quota)?.primary).toMatchObject({
        usedPercent: 100,
        checkedAt: env.now - 60_000,
      })
    }
  })

  test('current hit skips wham only for its matched account', async () => {
    const env = await setup()
    env.daemon.insula = {
      reply: { result: [current(env.now)], completeProviders: ['codex'] },
    }
    const a = route(env.vault)
    const b = route(env.vault, 'account-b')
    expect(await env.vault.pollQuota(a)).toEqual({ ok: true })
    expect(env.wham).toEqual([])
    expect(env.daemon.gets).toEqual([])
    expect(
      windowsFromQuotaMap(env.vault.routes().find((row) => row.id === a)?.quota)
        ?.primary,
    ).toMatchObject({
      usedPercent: 100,
      checkedAt: env.now - 60_000,
    })
    expect(await env.vault.pollQuota(b)).toEqual({ ok: true })
    expect(env.wham).toEqual(['account-b'])
    expect(env.daemon.insulaReads).toBe(1)
    expect(env.daemon.insulaOpens).toBe(1)
  })

  test('background quota source logs only changes and never exposes account identity', async () => {
    const env = await setup()
    const id = route(env.vault)
    const requestId = route(env.vault, 'account-b')
    const logFile = join(env.dir, 'vault.log')
    resetLoggerForTest()
    initLogger({ file: logFile, level: 'info' })
    const readLog = async () => {
      await flushForTest()
      return existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    }
    try {
      env.daemon.insula = {
        reply: {
          result: [current(env.now), current(env.now, 'account-b')],
        },
      }
      expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
      const firstLog = await readLog()
      const sourceLines = () =>
        readLog().then((text) =>
          text
            .split('\n')
            .filter((line) =>
              line.includes('vault background quota source changed'),
            ),
        )
      const firstTransitions = await sourceLines()
      expect(firstTransitions).toHaveLength(1)
      expect(firstTransitions[0]).toContain(`"routeId":"${id}"`)
      expect(firstTransitions[0]).toContain('"source":"insula"')
      expect(firstTransitions[0]).toContain('"reason":null')

      expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
      expect(await readLog()).toBe(firstLog)

      // This request-time poll may use the Insula cache, but source transitions
      // are tracked only by background polls, not by admission-time reads.
      expect(await env.vault.pollQuota(requestId, false)).toEqual({ ok: true })
      expect(await readLog()).toBe(firstLog)

      env.advance(60_000)
      env.daemon.insula = { refusal: 'module_warming' }
      expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
      const fallbackLog = await readLog()
      const fallbackTransitions = await sourceLines()
      expect(fallbackTransitions).toHaveLength(2)
      expect(fallbackTransitions[1]).toContain('"source":"fallback"')
      expect(fallbackTransitions[1]).toContain('"reason":"no-insula-reading"')

      expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
      expect(await readLog()).toBe(fallbackLog)
      expect(fallbackLog).not.toContain('account-a')
      expect(fallbackLog).not.toContain('account-a@example.com')
    } finally {
      resetLoggerForTest()
    }
  })

  test.each([
    'stale',
    'missing',
    'refused',
    'hung',
    'malformed',
    'error',
    'unusable',
  ] as const)(
    '%s source falls back to wham',
    async (kind) => {
      const env = await setup()
      const entry = current(env.now)
      const states: Record<typeof kind, NonNullable<MockDaemon['insula']>> = {
        stale: {
          reply: {
            result: [
              { ...entry, fetchedAt: new Date(env.now - 240000).toISOString() },
            ],
          },
        },
        missing: { reply: { result: [], completeProviders: ['codex'] } },
        refused: { refusal: 'capability_denied' },
        hung: { hung: true },
        malformed: { reply: { result: {} } },
        error: {
          reply: { result: [{ ...entry, errorClass: 'auth_required' }] },
        },
        unusable: { reply: { result: [{ ...entry, usage: {} }] } },
      }
      env.daemon.insula = states[kind]
      expect(await env.vault.pollQuota(route(env.vault))).toEqual({ ok: true })
      expect(env.daemon.insulaOpens).toBe(1)
      expect(env.wham).toEqual(['account-a'])
    },
    10_000,
  )

  test('cold background polls defer wham within the provider bound', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [], pending: true } }
    const results = await env.vault.pollStale(0)
    expect(results).toHaveLength(2)
    env.advance(119_999)
    await env.vault.pollQuota(route(env.vault))
    expect(env.wham).toEqual([])
    expect(results.every((result) => !result.ok)).toBe(true)
    expect(env.daemon.gets).toEqual([])
    expect(env.vault.routes().every((row) => row.quota === undefined)).toBe(
      true,
    )
  })

  test('upstream-failed background polls defer wham', async () => {
    const env = await setup()
    env.daemon.insula = {
      reply: {
        result: [{ ...current(env.now), errorClass: 'upstream_failed' }],
      },
    }
    const id = route(env.vault)
    const result = await env.vault.pollQuota(id)
    await env.vault.pollQuota(id)
    expect(env.wham).toEqual([])
    expect(result.ok).toBe(false)
    expect(env.daemon.gets).toEqual([])
    expect(
      env.vault.routes().find((row) => row.id === id)?.quota,
    ).toBeUndefined()
  })

  test('kept upstream-failed reading suppresses direct background polling', async () => {
    const env = await setup()
    env.daemon.insula = {
      reply: {
        result: [
          {
            ...current(env.now),
            fetchedAt: new Date(env.now - 600_000).toISOString(),
            stale: {
              since: new Date(env.now - 300_000).toISOString(),
              class: 'upstream_failed',
            },
          },
        ],
      },
    }
    const id = route(env.vault)
    expect(await env.vault.pollQuota(id)).toEqual({
      ok: false,
      error: 'insula upstream-failed',
    })
    expect(env.wham).toEqual([])
    expect(env.daemon.gets).toEqual([])
    expect(
      env.vault.routes().find((row) => row.id === id)?.quota,
    ).toBeUndefined()
  })

  test('kept local-source-unavailable reading makes exactly one direct background poll', async () => {
    const env = await setup()
    env.daemon.insula = {
      reply: {
        result: [
          {
            ...current(env.now),
            stale: {
              since: new Date(env.now - 30_000).toISOString(),
              class: 'local_source_unavailable',
            },
          },
        ],
      },
    }
    const id = route(env.vault)
    const poll = env.vault.pollQuota(id)
    expect(env.vault.pollQuota(id)).toBe(poll)
    expect(await poll).toEqual({ ok: true })
    expect(env.wham).toEqual(['account-a'])
    expect(env.daemon.gets).toHaveLength(1)
    expect(
      windowsFromQuotaMap(
        env.vault.routes().find((row) => row.id === id)?.quota,
      )?.primary?.usedPercent,
    ).toBe(20)
  })

  test('skip source transitions include reasons without duplicate consumer logs', async () => {
    const env = await setup()
    const id = route(env.vault)
    const logFile = join(env.dir, 'vault.log')
    resetLoggerForTest()
    initLogger({ file: logFile, level: 'info' })
    try {
      const replies = [
        { result: [] },
        { result: [{ provider: 'codex', errorClass: 'upstream_failed' }] },
        { result: [current(env.now + 120_000)] },
      ]
      for (const reply of replies) {
        env.daemon.insula = { reply }
        await env.vault.pollQuota(id)
        await env.vault.pollQuota(id)
        env.advance(60_000)
      }
      await flushForTest()
      const text = readFileSync(logFile, 'utf8')
      const transitions = text
        .split('\n')
        .filter((line) =>
          line.includes('vault background quota source changed'),
        )
      expect(transitions).toHaveLength(3)
      for (const [i, reason] of [
        '"cold"',
        '"upstream-failed"',
        'null',
      ].entries()) {
        expect(transitions[i]).toContain(`"routeId":"${id}"`)
        expect(transitions[i]).toContain('"source":"insula"')
        expect(transitions[i]).toContain(`"reason":${reason}`)
      }
      expect(text).not.toContain('skipped insula provider poll')
      expect(text).not.toContain('account-a')
      expect(env.wham).toEqual([])
    } finally {
      resetLoggerForTest()
    }
  })

  test.each(['stale', 'credential', 'absent', 'unreachable'] as const)(
    '%s miss invokes exactly one account-bound fallback',
    async (miss) => {
      const env = await setup()
      const entry = current(env.now)
      const replies = {
        stale: {
          result: [
            { ...entry, fetchedAt: new Date(env.now - 240_000).toISOString() },
          ],
        },
        credential: {
          result: [{ provider: 'codex', errorClass: 'credential_rejected' }],
        },
        absent: { result: [], completeProviders: ['codex'] },
        unreachable: { result: {} },
      }
      env.daemon.insula = { reply: replies[miss] }
      const id = route(env.vault)
      const poll = env.vault.pollQuota(id)
      expect(env.vault.pollQuota(id)).toBe(poll)
      expect(await poll).toEqual({ ok: true })
      expect(env.wham).toEqual(['account-a'])
      expect(env.daemon.gets).toHaveLength(1)
      expect(
        windowsFromQuotaMap(
          env.vault.routes().find((row) => row.id === id)?.quota,
        )?.primary?.usedPercent,
      ).toBe(20)
    },
  )

  test('cold provider bound expires across accounts after two minutes', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [] } }
    await env.vault.pollQuota(route(env.vault))
    env.advance(119_999)
    const b = route(env.vault, 'account-b')
    await env.vault.pollQuota(b)
    expect(env.wham).toEqual([])
    env.advance(1)
    expect(await env.vault.pollQuota(b)).toEqual({ ok: true })
    expect(env.wham).toEqual(['account-b'])
  })

  test('first quota wait settles on a skipped background poll within its bound', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [] } }
    const id = route(env.vault)
    const poll = env.vault.pollQuota(id)
    const start = Date.now()
    const waiting = waitForFirstQuotaReading({
      rows: [{ id, kind: 'oauth' }],
      now: env.now,
      rateLimitMarks: new Map(),
      refreshBackoff: new Map(),
      killswitch: new Map(),
      requestPull: (routeId) => env.vault.requestReading(routeId),
    })
    expect(waiting).toBeDefined()
    await waiting
    expect(Date.now() - start).toBeLessThan(FIRST_QUOTA_READING_WAIT_MS)
    expect((await poll).ok).toBe(false)
    expect(env.wham).toEqual([])
    // A later request-time read is separate from the background poll and still fetches quota.
    await env.vault.requestReading(id)
    expect(env.wham).toEqual(['account-a'])
  })

  test('refused next tick invalidates a previously current hit', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    const id = route(env.vault)
    await env.vault.pollQuota(id)
    env.advance(60_000)
    env.daemon.insula = { refusal: 'module_warming' }
    expect(await env.vault.pollQuota(id)).toEqual({ ok: true })
    expect(env.wham).toEqual(['account-a'])
  })

  test('standalone never opens insula', async () => {
    const env = await setup(false)
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    env.vault.start()
    await env.vault.firstRoster()
    await env.vault.pollQuota('vault:a')
    expect(env.daemon.insulaOpens).toBe(0)
    expect(env.daemon.insulaReads).toBe(0)
    expect(env.daemon.gets).toEqual([])
    expect(env.wham).toEqual([])
  })

  test('background hit retains a known binding when the vault omits identity', async () => {
    const env = await setup()
    delete env.daemon.credentials.a?.account_id
    await env.vault.refresh()
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    expect(await env.vault.pollQuota(route(env.vault))).toEqual({ ok: true })
    expect(env.wham).toEqual([])
    expect(env.daemon.gets).toEqual([])
    expect(
      env.vault
        .snapshot()
        ?.rows.find((row) => row.accountIdentity === 'account-a')?.unclaimed,
    ).toBe(true)
  })

  test('newer in-band windows and budget beat an older insula hit', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    const id = route(env.vault)
    const receipt = await env.vault.authorize(id)
    if (!receipt) throw new Error('vault refused receipt')
    await env.vault.recordSnapshot(
      id,
      {
        primary: { usedPercent: 9 },
        secondary: { usedPercent: 15 },
        spendControl: { reached: true, limit: 100, used: 100, remaining: 0 },
      },
      true,
      receipt,
    )
    await env.vault.pollQuota(id)
    const quota = env.vault.routes().find((row) => row.id === id)?.quota
    expect(windowsFromQuotaMap(quota)?.primary).toMatchObject({
      usedPercent: 9,
      checkedAt: env.now,
    })
    expect(windowsFromQuotaMap(quota)?.secondary).toMatchObject({
      usedPercent: 15,
      checkedAt: env.now,
    })
    expect(quota?.budget).toMatchObject({ reached: true, checkedAt: env.now })
    expect(env.wham).toEqual([])
  })

  test('admission uses a receipt cache hit without refreshing insula', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    const id = route(env.vault)
    await env.vault.pollQuota(id)
    await mutateVaultRoster(env.vault.paths.rosterPath, (roster) => {
      if (!roster) throw new Error('missing roster')
      for (const row of roster.rows) delete row.quota
      return { next: roster, result: undefined }
    })
    await env.vault.refresh()
    env.advance(60_000)
    env.daemon.insula = { hung: true }
    await env.vault.requestReading(id)
    expect(env.daemon.insulaReads).toBe(1)
    expect(env.daemon.gets).toHaveLength(1)
    expect(env.wham).toEqual([])
    expect(
      windowsFromQuotaMap(
        env.vault.routes().find((row) => row.id === id)?.quota,
      )?.primary?.usedPercent,
    ).toBe(100)
  })

  test('admission cache miss polls wham without calling insula', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [current(env.now)] } }
    await env.vault.requestReading(route(env.vault))
    expect(env.daemon.insulaReads).toBe(0)
    expect(env.daemon.insulaOpens).toBe(0)
    expect(env.wham).toEqual(['account-a'])
  })
})
