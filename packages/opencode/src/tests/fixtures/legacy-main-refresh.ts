// Vendored for mixed-version tests: the older build's refresh of the main
// (host-slot) credential, `refreshMainWithLease` in
// packages/opencode/src/index.ts (lines 2001-2137 at main 5809e38c), which is
// a closure inside the plugin loader and cannot be imported. It keeps the
// same order: read the slot, honour an active lease on that token, take the
// `main-refresh` file lock at the config path, write the lease fields through
// the legacy `mutateAccounts`, re-read and fence on the lease, refresh,
// write the rotated tokens into the slot, clear the lease, release. The
// backoff bookkeeping and the join-by-polling path are left out; `hooks`
// adds pause points for the race rows.
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type AccountPaths,
  hashRefreshToken,
  loadAccounts,
  mutateAccounts,
} from '@cortexkit/openai-auth-core/internal'
import { MAIN_REFRESH_LOCK_NAME } from '../../core/custody-transition.ts'
import type { HostSlotAdapter } from '../../core/pool-migration.ts'

const MAIN_REFRESH_LOCK_TTL_MS = 2 * 60_000
const MAIN_REFRESH_LEASE_TTL_MS = 90_000

export async function legacyRefreshMain(input: {
  paths: AccountPaths
  slot: HostSlotAdapter
  refresh: (
    token: string,
  ) => Promise<{ access: string; refresh: string; expires: number }>
  hooks?: { afterLock?: () => Promise<void> }
}): Promise<{ access: string; refresh: string; expires: number }> {
  const fresh = (await input.slot.get({ path: { id: 'openai' } })) as {
    refresh?: string
  }
  if (!fresh?.refresh) throw new Error('Token refresh failed: missing refresh')
  const refreshTokenHash = hashRefreshToken(fresh.refresh)
  const latest = await loadAccounts(input.paths)
  if (
    latest?.refresh?.mainRefreshLeaseUntil &&
    latest.refresh.mainRefreshLeaseUntil > Date.now() &&
    latest.refresh.mainRefreshLeaseTokenHash === refreshTokenHash
  )
    throw new Error('Codex OAuth refresh is already in progress')
  const fileLock = await acquireRefreshFileLock({
    name: MAIN_REFRESH_LOCK_NAME,
    ttlMs: MAIN_REFRESH_LOCK_TTL_MS,
    path: input.paths.configPath,
    renew: true,
  })
  if (!fileLock) throw new Error('Codex OAuth refresh is already in progress')
  const leaseId = crypto.randomUUID()
  try {
    await input.hooks?.afterLock?.()
    await mutateAccounts((current) => {
      current.refresh = {
        ...current.refresh,
        mainRefreshLeaseId: leaseId,
        mainRefreshLeaseUntil: Date.now() + MAIN_REFRESH_LEASE_TTL_MS,
        mainRefreshLeaseTokenHash: refreshTokenHash,
      }
      return current
    }, input.paths)
    const leased = await loadAccounts(input.paths)
    if (leased?.refresh?.mainRefreshLeaseId !== leaseId)
      throw new Error('Codex OAuth refresh is already in progress')
    const tokens = await input.refresh(fresh.refresh)
    await input.slot.set({
      path: { id: 'openai' },
      body: { type: 'oauth', ...tokens },
    })
    return tokens
  } finally {
    await mutateAccounts((current) => {
      if (current.refresh?.mainRefreshLeaseId === leaseId) {
        current.refresh.mainRefreshLeaseId = undefined
        current.refresh.mainRefreshLeaseUntil = undefined
        current.refresh.mainRefreshLeaseTokenHash = undefined
      }
      return current
    }, input.paths).catch(() => {})
    await fileLock.release().catch(() => {})
  }
}
