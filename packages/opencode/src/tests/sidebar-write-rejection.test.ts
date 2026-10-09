import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LockOwnershipError, lockPathFor } from '@cortexkit/common-auth/fs'
import { removeSidebarActiveRouting } from '../sidebar-state.ts'

test('session deletion contains a real expired sidebar lease without an unhandled rejection', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures/sidebar-deletion-harness.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 8_000 },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  expect(result.failures).toEqual([
    { realOwnershipError: true, name: 'LockOwnershipError' },
  ])
  expect(result.unhandled).toEqual([])
  expect(result.removed).toBe(true)
  expect(result.warned).toBe(true)
  expect(result.recovered).toBe(true)
}, 10_000)

test('awaiting sidebar persistence still rejects with the real expired lease error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidebar-await-'))
  const file = join(dir, 'sidebar.json')
  let ownerId: string | undefined
  try {
    const write = removeSidebarActiveRouting(
      'deleted-session',
      undefined,
      file,
      {
        beforeRecheck: async () => {
          const path = lockPathFor(file, 'sidebar-write')
          const owner = JSON.parse(readFileSync(path, 'utf8'))
          ownerId = owner.ownerId
          writeFileSync(path, JSON.stringify({ ...owner, expiresAt: 0 }))
        },
      },
    )
    const error = await write.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(LockOwnershipError)
    expect(ownerId).toBeString()
    expect((error as LockOwnershipError).details).toMatchObject({
      target: file,
      name: 'sidebar-write',
      expectedOwnerId: ownerId,
      observedOwnerId: ownerId,
      observedExpiresAt: 0,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
