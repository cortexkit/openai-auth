import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAiVault } from '@cortexkit/openai-auth-core/internal'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum'
import { buildVaultSidebarMachineState } from '../core/pool-sidebar'
import { type SidebarState, setSidebarMachineState } from '../sidebar-state'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'openai-vault-credits-'))
  const stateDir = join(dir, 'vault')
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: { a: vaultLogin('account-a') },
  })
  let now = Date.now()
  let whamReads = 0
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir,
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    now: () => now,
    fetchImpl: () =>
      (async (_input, _init) => {
        whamReads++
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: Math.floor((now + 3600000) / 1000),
              limit_window_seconds: 18000,
            },
          },
          rate_limit_reset_credits: { available_count: 3 },
        })
      }) as typeof fetch,
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
  return {
    dir,
    stateDir,
    daemon,
    vault,
    id,
    get now() {
      return now
    },
    get whamReads() {
      return whamReads
    },
    advance(ms: number) {
      now += ms
    },
  }
}

function insulaReading(fetchedAt: number, availableCount: number) {
  return {
    provider: 'codex',
    account: 'account-a',
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: 'vault',
    usage: { primary: { usedPercent: 25, windowMinutes: 300 } },
    savedResets: { availableCount },
  }
}

async function sidebar(vault: OpenAiVault, file: string, now: number) {
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

describe('vault reset credits', () => {
  test.each(['wham', 'insula'] as const)(
    '%s reading reaches both processes sidebar files',
    async (source) => {
      const env = await setup()
      const credits = source === 'wham' ? 3 : 0
      const checkedAt = source === 'wham' ? env.now : env.now - 60_000
      if (source === 'insula') {
        env.daemon.insula = {
          reply: { result: [insulaReading(checkedAt, credits)] },
        }
      }
      expect(await env.vault.pollQuota(env.id)).toEqual({ ok: true })
      expect(env.whamReads).toBe(source === 'wham' ? 1 : 0)
      expect(env.vault.snapshot()?.rows[0]?.quota?.counters).toEqual({
        resetCredits: { value: credits, checkedAt },
      })
      const first = await sidebar(
        env.vault,
        join(env.dir, 'sidebar-state.json'),
        env.now,
      )
      const secondFile = join(env.dir, 'second-sidebar-state.json')
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'fixtures/vault-credit-reader.ts'),
          env.stateDir,
          env.daemon.connectionFile,
          secondFile,
          String(env.now),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const stderr = new Response(child.stderr).text()
      try {
        expect(await child.exited).toBe(0)
        expect(await stderr).toBe('')
        const second = JSON.parse(
          await readFile(secondFile, 'utf8'),
        ) as SidebarState
        expect(second.vaultAccounts).toEqual(first.vaultAccounts)
        for (const state of [first, second]) {
          expect(state.vaultAccounts?.[0]?.resetCredits).toBe(credits)
          expect(state.vaultAccounts?.[0]?.quota?.resetCreditsAvailable).toBe(
            credits,
          )
        }
      } finally {
        child.kill()
        await child.exited
      }
    },
  )

  test('newer reset count beats an older insula reading', async () => {
    const env = await setup()
    const receipt = await env.vault.authorize(env.id)
    if (!receipt) throw new Error('vault refused receipt')
    await env.vault.recordSnapshot(
      env.id,
      { resetCreditsAvailable: 4 },
      false,
      receipt,
    )
    env.daemon.insula = {
      reply: { result: [insulaReading(env.now - 60_000, 9)] },
    }
    expect(await env.vault.pollQuota(env.id)).toEqual({ ok: true })
    expect(env.whamReads).toBe(0)
    expect(
      env.vault.snapshot()?.rows[0]?.quota?.counters?.resetCredits,
    ).toEqual({
      value: 4,
      checkedAt: env.now,
    })
    const state = await sidebar(
      env.vault,
      join(env.dir, 'sidebar-state.json'),
      env.now,
    )
    expect(state.vaultAccounts?.[0]?.resetCredits).toBe(4)
  })

  test('a complete reading without a count leaves the stored reset count', async () => {
    const env = await setup()
    expect(await env.vault.pollQuota(env.id)).toEqual({ ok: true })
    const checkedAt = env.now
    env.advance(1_000)
    const receipt = await env.vault.authorize(env.id)
    if (!receipt) throw new Error('vault refused receipt')
    await env.vault.recordSnapshot(
      env.id,
      { primary: { usedPercent: 30 } },
      true,
      receipt,
    )
    expect(
      env.vault.snapshot()?.rows[0]?.quota?.counters?.resetCredits,
    ).toEqual({
      value: 3,
      checkedAt,
    })
    const state = await sidebar(
      env.vault,
      join(env.dir, 'sidebar-state.json'),
      env.now,
    )
    expect(state.vaultAccounts?.[0]?.resetCredits).toBe(3)
  })
})
