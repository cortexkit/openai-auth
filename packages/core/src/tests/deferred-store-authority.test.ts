import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  FallbackAccountManager,
  mutateAccounts,
  saveAccountState,
  saveAccounts,
} from '../accounts'

for (const operation of ['save', 'quota', 'identity', 'refresh'] as const) {
  test(`deferred legacy ${operation} leaves store bytes unchanged after authority closes`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-write-authority-'))
    const paths = {
      configPath: join(dir, 'config.json'),
      statePath: join(dir, 'state.json'),
    }
    const storage = {
      version: 1 as const,
      accounts: [
        {
          id: 'work',
          type: 'oauth' as const,
          access: 'old-access',
          refresh: 'old-refresh',
          expires: Date.now() + 3600_000,
          addedAt: 1,
        },
      ],
    }
    let local = true
    let lock: Awaited<ReturnType<typeof acquireRefreshFileLock>> = null
    try {
      await saveAccounts(storage, paths)
      const bytes = () =>
        [paths.configPath, paths.statePath].map((path) =>
          readFileSync(path, 'utf8'),
        )
      const before = bytes()
      lock = await acquireRefreshFileLock({
        name: 'save',
        path:
          operation === 'quota' || operation === 'refresh'
            ? paths.statePath
            : paths.configPath,
        ttlMs: 30_000,
      })
      if (!lock) throw new Error('lock unavailable')
      storage.accounts[0]!.access = 'new-access'
      const guard = () => local
      const pending =
        operation === 'save'
          ? saveAccounts(storage, paths, guard)
          : operation === 'quota'
            ? saveAccountState(
                { ...storage, quota: { mainQuotaCheckedAt: Date.now() } },
                paths,
                { mainQuota: true },
                guard,
              )
            : operation === 'identity'
              ? mutateAccounts(
                  (current) => ({ ...current, mainAccountId: 'new-identity' }),
                  paths,
                  { canWrite: guard },
                )
              : new FallbackAccountManager({ paths, canWrite: guard }).save(
                  storage,
                )
      local = false
      await lock.release()
      lock = null
      await pending
      expect(bytes()).toEqual(before)
    } finally {
      await lock?.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
