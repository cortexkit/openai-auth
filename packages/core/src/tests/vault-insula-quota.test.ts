import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mutateVaultRoster } from '@cortexkit/common-auth/claustrum'
import { windowsFromQuotaMap } from '../pool-quota'
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
      a: vaultLogin('account-a'),
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
  test('current hit skips wham only for its matched account', async () => {
    const env = await setup()
    env.daemon.insula = { reply: { result: [current(env.now)] } }
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
        missing: { reply: { result: [] } },
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
