import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-refresh-file-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireRefreshFileLock', () => {
  it('creates a missing parent directory before acquiring the lock', async () => {
    const path = join(dir, 'missing-sub', 'state.json')
    const lockPath = `${path}.missing-parent.lock`

    const lock = await acquireRefreshFileLock({
      name: 'missing-parent',
      path,
      ttlMs: 5_000,
    })

    expect(lock).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)

    await lock?.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('allows only one contender when the parent directory is missing', async () => {
    const path = join(dir, 'missing-race', 'state.json')
    const options = {
      name: 'missing-parent-contention',
      path,
      ttlMs: 5_000,
    }

    const contenders = await Promise.all([
      acquireRefreshFileLock(options),
      acquireRefreshFileLock(options),
    ])
    const winners = contenders.filter((lock) => lock !== null)

    expect(winners).toHaveLength(1)

    await winners[0]?.release()
    const retry = await acquireRefreshFileLock(options)
    expect(retry).not.toBeNull()
    await retry?.release()
  })
})
