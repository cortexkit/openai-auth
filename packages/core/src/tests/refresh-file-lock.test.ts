import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-refresh-file-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireRefreshFileLock', () => {
  it('elects one owner across 128 plain stale-lock contentions', async () => {
    // Deterministic seam tests cover the race proofs; this is ordinary contention smoke.
    // Each round is filesystem-bound, so the round count sets how long the test
    // takes on a busy machine: 512 rounds overran the 5 s test timeout at a load
    // average of 30. 128 keeps the smoke check with room to spare.
    const path = join(dir, 'plain-contention.json')
    const name = 'plain-contention'
    const lockPath = `${path}.${name}.lock`

    for (let round = 0; round < 128; round++) {
      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: 0 })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      const contenders = await Promise.all([
        acquireRefreshFileLock({ name, path, ttlMs: 1_000 }),
        acquireRefreshFileLock({ name, path, ttlMs: 1_000 }),
      ])
      const winners = contenders.filter((lock) => lock !== null)

      expect(winners).toHaveLength(1)
      await winners[0]?.release()
    }
  })
})
