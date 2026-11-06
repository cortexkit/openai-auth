import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '@cortexkit/common-auth/fs'
import { OpenAiVault } from '../vault'
import { startMockDaemon, vaultLogin } from './fixtures/mock-claustrum'

const locks = (await import(
  new URL(
    'refresh-file-lock.js',
    import.meta.resolve('@cortexkit/common-auth/fs'),
  ).href
)) as Pick<typeof files, 'acquireRefreshFileLock'>

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vault-dispose-'))
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: { first: vaultLogin('first') },
  })
  const vault = new OpenAiVault({
    host: 'pi',
    stateDir: join(dir, 'vault'),
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
  })
  cleanups.push(async () => {
    await vault.dispose()
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'vault'), { mode: 0o700 })
  await writeFile(
    vault.paths.tokenPath,
    JSON.stringify({
      token: '01'.repeat(32),
      token_generation: 1,
    }),
    { mode: 0o600 },
  )
  return { vault, daemon }
}

test('dispose drains a pending roster quota write and releases its lease', async () => {
  const { vault } = await setup()
  await vault.refresh()
  const id = vault.routes()[0]!.id
  const receipt = await vault.authorize(id)
  expect(receipt).toBeDefined()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const acquire = locks.acquireRefreshFileLock
  const spy = spyOn(locks, 'acquireRefreshFileLock').mockImplementation(
    async (options) => {
      const lease = await acquire(options)
      if (lease && options.name === 'claustrum-roster-write') {
        const original = lease.release.bind(lease)
        lease.release = async () => {
          entered.resolve()
          await release.promise
          await original()
        }
      }
      return lease
    },
  )
  const write = vault.recordSnapshot(
    id,
    {
      primary: { usedPercent: 37 },
      credits: { hasCredits: true, unlimited: false, balance: 17 },
    },
    false,
    receipt!,
  )
  const path = files.lockPathFor(
    vault.paths.rosterPath,
    'claustrum-roster-write',
  )
  try {
    await entered.promise
    expect(existsSync(path)).toBe(true)
    let disposed = false
    const disposing = vault.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    await Promise.all([disposing, write])
    expect(existsSync(path)).toBe(false)
    const roster = JSON.parse(await readFile(vault.paths.rosterPath, 'utf8'))
    expect(roster.rows[0].quota.credits.balance).toBe(17)
  } finally {
    release.resolve()
    await write
    spy.mockRestore()
  }
})

test('dispose with nothing pending resolves without waiting for a drain deadline', async () => {
  const { vault, daemon } = await setup()
  const started = performance.now()
  await vault.dispose()
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(daemon.lists).toBe(0)
  expect(daemon.connections).toBe(0)
  expect(
    existsSync(
      files.lockPathFor(vault.paths.rosterPath, 'claustrum-roster-write'),
    ),
  ).toBe(false)
  // Legacy callers may close first and later join disposal during shutdown.
  vault.close()
  await vault.dispose()
})
