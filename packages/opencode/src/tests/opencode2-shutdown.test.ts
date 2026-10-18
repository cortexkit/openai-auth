import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import * as locks from '@cortexkit/common-auth/fs'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  seedPool,
} from './fixtures/opencode2-host'
import { openCode2PhaseClock } from './fixtures/opencode2-phase-clock'

test('OpenCode 2 shutdown stops waiting for a contended host-slot transfer lock', async () => {
  const files = poolFiles()
  seedPool(files, 'main-first', [{ id: 'main' }])
  const slotPath = join(files.dir, 'auth.json')
  const held = await locks.acquireRefreshFileLock({
    name: 'pool-slot-transfer',
    path: slotPath,
    ttlMs: 10_000,
  })
  expect(held).not.toBeNull()
  let attempted!: () => void
  const waiting = new Promise<void>((resolve) => {
    attempted = resolve
  })
  const clock = openCode2PhaseClock((options, result) => {
    if (
      options.name === 'pool-slot-transfer' &&
      options.path === slotPath &&
      !result
    )
      attempted()
  })
  let stop: Awaited<ReturnType<typeof setupOpenAIAuth>>
  let stopping: Promise<unknown> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    stop = await clock.time('setup', () =>
      setupOpenAIAuth(fakeOpenCode2Host().ctx, {
        paths: files.paths,
        heartbeat: false,
        poolMigration: true,
        slot: opencode1HostSlot(slotPath),
        fence: async () => ({ open: true, blockers: [] }),
        sidebarStateFile: join(files.dir, 'sidebar.json'),
        fetch: Object.assign(async () => new Response('{}', { status: 503 }), {
          preconnect() {},
        }),
        vault: {
          stateDir: join(files.dir, 'vault'),
          connectionFile: () => join(files.dir, 'no-vault.json'),
          pollIntervalMs: 0,
        },
      }),
    )
    await waiting
    const started = performance.now()
    stopping = clock.time('stop', async () => {
      await stop?.()
    })
    const stopped = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 300)
      }),
    ])
    if (!stopped) clock.report()
    expect(stopped).toBe(true)
    expect(performance.now() - started).toBeLessThan(300)
  } finally {
    clearTimeout(deadline)
    await held?.release()
    await stopping
    clock.dispose()
    rmSync(files.dir, { recursive: true, force: true })
  }
})
