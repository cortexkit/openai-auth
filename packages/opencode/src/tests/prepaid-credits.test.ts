// Prepaid workspace credits: the Codex backend reports them in the usage
// poll's `credits` object and in the `x-codex-credits-*` response headers.
// They travel into the pool's quota map (the vault roster in vault mode) with
// the reading's time and from there into sidebar-state.json. A source that
// reports none leaves them absent, never a made-up "no credits". Routing does
// not read them.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainVaultQuota } from '@cortexkit/common-auth/claustrum'
import {
  mergeQuotaObservation,
  type QuotaMap,
} from '@cortexkit/common-auth/quota'
import type { RoutingRow } from '@cortexkit/common-auth/routing'
import {
  normalizeQuotaHeaders,
  normalizeWham,
  OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import {
  planOrdered,
  routePinnedRow,
  selectStickyRow,
} from '@cortexkit/openai-auth-core/pool-routing'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum'
import { observationFromSnapshot } from '../core/pool-quota'
import {
  buildPoolSidebarMachineState,
  buildVaultSidebarMachineState,
} from '../core/pool-sidebar'
import { mergePushedQuotaMetadata } from '../index.ts'
import {
  accountCreditsText,
  normalizeSidebarState,
  type SidebarState,
  setSidebarMachineState,
} from '../sidebar-state'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const HOUR = 60 * 60_000

function whamBody(now: number, credits?: Record<string, unknown>) {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 20,
        reset_at: Math.floor((now + HOUR) / 1000),
        limit_window_seconds: 18000,
      },
    },
    ...(credits ? { credits } : {}),
  }
}

async function vaultSetup(credits?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'openai-prepaid-credits-'))
  const stateDir = join(dir, 'vault')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: { a: vaultLogin('account-a') },
  })
  const now = Date.now()
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir,
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    now: () => now,
    fetchImpl: () =>
      (async () =>
        Response.json(whamBody(now, credits))) as unknown as typeof fetch,
  })
  cleanups.push(async () => {
    vault.close()
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(stateDir, { mode: 0o700 })
  await writeFile(
    vault.paths.tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await vault.refresh()
  const id = vault.routes()[0]?.id
  if (!id) throw new Error('missing vault account')
  return { dir, vault, id, now }
}

/** The sidebar file the plugin writes for the vault's rows, read back raw. */
async function vaultSidebarFile(vault: OpenAiVault, dir: string, now: number) {
  const file = join(dir, 'sidebar-state.json')
  await setSidebarMachineState(
    buildVaultSidebarMachineState(
      vault.snapshot()?.rows ?? [],
      new Set(vault.routes().map((row) => row.id)),
      null,
      now,
    ),
    file,
  )
  return JSON.parse(await readFile(file, 'utf8')) as SidebarState
}

/** The roster file itself, as another process reads it. */
async function rosterRow(vault: OpenAiVault) {
  await drainVaultQuota(vault.paths.rosterPath)
  const roster = JSON.parse(await readFile(vault.paths.rosterPath, 'utf8'))
  return roster.rows[0] as { quota?: QuotaMap }
}

describe('prepaid credits from the Codex backend', () => {
  test('the response headers are read as the Codex client reads them', () => {
    const headers = (entries: Record<string, string>) =>
      normalizeQuotaHeaders(
        new Headers({ 'x-codex-primary-used-percent': '10', ...entries }),
      )
    expect(
      headers({
        'x-codex-credits-has-credits': 'True',
        'x-codex-credits-unlimited': '0',
        'x-codex-credits-balance': ' 87.5 ',
      }).credits,
    ).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 87.5,
      checkedAt: expect.any(Number),
    })
    expect(
      headers({
        'x-codex-credits-has-credits': '1',
        'x-codex-credits-unlimited': 'true',
      }).credits,
    ).toEqual({
      hasCredits: true,
      unlimited: true,
      checkedAt: expect.any(Number),
    })
    // Both flags are required; a missing or unreadable one says nothing.
    for (const partial of <Array<Record<string, string>>>[
      {},
      { 'x-codex-credits-has-credits': 'true' },
      { 'x-codex-credits-unlimited': 'false' },
      {
        'x-codex-credits-has-credits': 'yes',
        'x-codex-credits-unlimited': 'false',
      },
    ])
      expect(headers(partial)).not.toHaveProperty('credits')
  })

  test('an observation carries credits with its own time, and omits them when none were reported', () => {
    const credits = { hasCredits: true, unlimited: false, balance: 12 }
    expect(
      observationFromSnapshot(
        { primary: { usedPercent: 10 }, credits: { ...credits, checkedAt: 1 } },
        5_000,
        true,
      )?.credits,
    ).toEqual({ ...credits, checkedAt: 5_000 })
    // Credits alone are a reading worth recording.
    expect(observationFromSnapshot({ credits }, 5_000, false)).toEqual({
      checkedAt: 5_000,
      credits: { ...credits, checkedAt: 5_000 },
    })
    expect(
      observationFromSnapshot({ primary: { usedPercent: 10 } }, 5_000, true),
    ).not.toHaveProperty('credits')
    expect(
      observationFromSnapshot(
        { primary: { usedPercent: 10 }, credits: { hasCredits: true } },
        5_000,
        true,
      ),
    ).not.toHaveProperty('credits')
  })

  test('vault mode: usage-poll credits reach the vault roster and sidebar-state.json with the poll time', async () => {
    const env = await vaultSetup({
      has_credits: true,
      unlimited: false,
      overage_limit_reached: false,
      balance: '1234.6',
    })
    expect(await env.vault.pollQuota(env.id)).toEqual({ ok: true })
    const credits = {
      hasCredits: true,
      unlimited: false,
      balance: 1234.6,
      overageLimitReached: false,
      checkedAt: env.now,
    }
    expect((await rosterRow(env.vault)).quota?.credits).toEqual(credits)
    const state = await vaultSidebarFile(env.vault, env.dir, env.now)
    expect(state.vaultAccounts?.[0]?.quota?.credits).toEqual(credits)
    expect(accountCreditsText(state.vaultAccounts?.[0]?.quota)).toBe(
      '1235 credits',
    )
  })

  test('vault mode: a usage poll without credits leaves them absent in the roster and the sidebar file', async () => {
    const env = await vaultSetup()
    expect(await env.vault.pollQuota(env.id)).toEqual({ ok: true })
    expect((await rosterRow(env.vault)).quota).not.toHaveProperty('credits')
    const state = await vaultSidebarFile(env.vault, env.dir, env.now)
    expect(state.vaultAccounts?.[0]?.quota?.primary?.usedPercent).toBe(20)
    expect(state.vaultAccounts?.[0]?.quota).not.toHaveProperty('credits')
  })

  test('vault mode: response-header credits reach the vault roster and sidebar-state.json', async () => {
    const env = await vaultSetup()
    const receipt = await env.vault.authorize(env.id)
    if (!receipt) throw new Error('vault refused receipt')
    const headers = new Headers({
      'x-codex-primary-used-percent': '30',
      'x-codex-credits-has-credits': 'false',
      'x-codex-credits-unlimited': 'true',
    })
    await env.vault.recordSnapshot(
      env.id,
      normalizeQuotaHeaders(headers),
      false,
      receipt,
    )
    const credits = { hasCredits: false, unlimited: true, checkedAt: env.now }
    expect((await rosterRow(env.vault)).quota?.credits).toEqual(credits)
    const state = await vaultSidebarFile(env.vault, env.dir, env.now)
    expect(state.vaultAccounts?.[0]?.quota?.credits).toEqual(credits)
    expect(accountCreditsText(state.vaultAccounts?.[0]?.quota)).toBe(
      'Unlimited',
    )
  })

  test('local pool mode: usage-poll credits reach the row quota map and sidebar-state.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openai-prepaid-local-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const now = 1_800_000_000_000
    // The pool records a usage poll as this observation; mergeQuotaObservation
    // is the merge the pool store applies to the row's stored map.
    const quotaFor = (body: Parameters<typeof normalizeWham>[0]) =>
      mergeQuotaObservation(
        undefined,
        observationFromSnapshot(normalizeWham(body), now, true),
      )
    const withCredits = quotaFor(
      whamBody(now, {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: null,
      }) as Parameters<typeof normalizeWham>[0],
    )
    const without = quotaFor(
      whamBody(now) as Parameters<typeof normalizeWham>[0],
    )
    const credits = {
      hasCredits: true,
      unlimited: false,
      overageLimitReached: false,
      checkedAt: now,
    }
    expect(withCredits.credits).toEqual(credits)
    expect(without).not.toHaveProperty('credits')
    const row = (id: string, quota: QuotaMap) => ({
      id,
      type: 'oauth' as const,
      enabled: true,
      needsFirstReading: false,
      hasEntry: true,
      candidate: true,
      quota,
    })
    const file = join(dir, 'sidebar-state.json')
    await setSidebarMachineState(
      buildPoolSidebarMachineState(
        [row('main', withCredits), row('fallback-1', without)],
        null,
        now,
      ),
      file,
    )
    const state = normalizeSidebarState(
      JSON.parse(await readFile(file, 'utf8')),
    )
    expect(state.main.quota?.credits).toEqual(credits)
    expect(accountCreditsText(state.main.quota)).toBe('Available')
    expect(state.fallbacks[0]?.quota?.primary?.usedPercent).toBe(20)
    expect(state.fallbacks[0]?.quota).not.toHaveProperty('credits')
  })

  test('a sidebar write without credits keeps the last reading of them for the same account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openai-prepaid-merge-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'sidebar-state.json')
    const window = (checkedAt: number) => ({
      usedPercent: 10,
      remainingPercent: 90,
      checkedAt,
    })
    const write = (quota: SidebarState['main']['quota']) =>
      setSidebarMachineState(
        {
          main: { quota, killed: false, mainAccountId: 'chatgpt-main' },
          fallbacks: [],
          route: 'main-first',
          lastUpdated: 1,
        },
        file,
      )
    const credits = { hasCredits: true, unlimited: true, checkedAt: 1_000 }
    await write({ primary: window(1_000), credits })
    await write({ primary: window(2_000) })
    const read = async () =>
      normalizeSidebarState(JSON.parse(await readFile(file, 'utf8')))
    expect((await read()).main.quota?.credits).toEqual(credits)
    // A later reading replaces an earlier one.
    const later = { hasCredits: false, unlimited: false, checkedAt: 3_000 }
    await write({ primary: window(3_000), credits: later })
    expect((await read()).main.quota?.credits).toEqual(later)
  })

  test('a header or WebSocket push without credits keeps the last usage-poll credits in the quota cache', () => {
    const credits = {
      hasCredits: true,
      unlimited: false,
      overageLimitReached: false,
      balance: 5,
      checkedAt: 1_000,
    }
    const pushed = { primary: { ...pushWindow(), checkedAt: 2_000 } }
    expect(mergePushedQuotaMetadata(pushed, { credits }).credits).toEqual(
      credits,
    )
    const fresh = { hasCredits: false, unlimited: true, checkedAt: 2_000 }
    expect(
      mergePushedQuotaMetadata({ ...pushed, credits: fresh }, { credits })
        .credits,
    ).toEqual(fresh)
  })
})

function pushWindow() {
  return { usedPercent: 10, remainingPercent: 90 }
}

describe('routing with prepaid credits', () => {
  // `main` has spent its window but holds unlimited credits; `spare` has
  // quota. Credits change nothing: main is still skipped while spare can serve.
  const now = 1_800_000_000_000
  const spent = mergeQuotaObservation(
    undefined,
    observationFromSnapshot(
      {
        primary: {
          usedPercent: 100,
          resetsAt: new Date(now + HOUR).toISOString(),
          windowMinutes: 300,
        },
        credits: { hasCredits: true, unlimited: true, balance: 500 },
      },
      now,
      true,
    ),
  )
  const spare = mergeQuotaObservation(
    undefined,
    observationFromSnapshot(
      {
        primary: {
          usedPercent: 20,
          resetsAt: new Date(now + HOUR).toISOString(),
          windowMinutes: 300,
        },
      },
      now,
      true,
    ),
  )
  const rows: RoutingRow[] = [
    { id: 'main', kind: 'oauth', quota: spent },
    { id: 'spare', kind: 'oauth', quota: spare },
  ]
  const input = {
    rows,
    now,
    rateLimitMarks: new Map<string, number>(),
    refreshBackoff: new Map<string, number>(),
    killswitch: new Map<string, boolean>(),
    requestPull: () => {},
  }
  const sticky = {
    requestBytes: 1,
    reservePercent: () => ({}),
    resetCredits: () => undefined,
  }

  test('the stored map holds the credits routing is given', () => {
    expect(spent.credits).toEqual({
      hasCredits: true,
      unlimited: true,
      balance: 500,
      checkedAt: now,
    })
  })

  test('an exhausted account with credits is still skipped while another has quota', () => {
    expect(planOrdered({ ...input, placement: 'main-first' })).toEqual({
      kind: 'send',
      order: ['spare'],
      lastPath: false,
    })
    expect(
      selectStickyRow(input, sticky, new Set(), new Map())?.accountId,
    ).toBe('spare')
    expect(routePinnedRow(input, sticky, 'main')).toEqual({
      kind: 'move',
      reason: 'exhausted',
    })
  })
})
