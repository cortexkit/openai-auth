// Vendored for mixed-version tests: the background refresh of a
// pre-tolerant openai-auth build (0.11.0 and earlier), as it stood at
// e45bdae in packages/core/src/accounts.ts: `FallbackAccountManager`'s
// `refreshDueAccounts` (lines 2596-2635) and the refresh it calls,
// `refreshAccountNow` (lines 2812-2935), with the helpers `refreshEnabled`,
// `refreshBeforeExpiryMs` and `tokenNeedsRefresh` (lines 2110-2132).
//
// The rule that matters here: those builds honour `mainAccountId` only when
// choosing a fallback for a request (`getUsableFallbackAccounts`). Their
// background refresh, their quota loops (which refresh through the same
// `refreshAccountNow`) and `refreshAccountNow` itself refresh every enabled
// OAuth roster row, the migrated `main` row included. The current core no
// longer does (it skips a row shielded by `mainAccountId`), so the old rules
// are kept here rather than imported.
//
// Left out: the custody-manifest checks and the custody-tombstone exception
// in the error bookkeeping (the fixtures have no manifest), the
// join-a-concurrent-refresh wait when the row lock is taken and the
// in-process sharing of one refresh per row (these runs are sequential and
// single-caller), and logging. Loading and saving go through the current
// legacy-format reader and writer.
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type AccountPaths,
  type AccountStorage,
  buildRefreshOperationError,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  fallbackRefreshLockName,
  isOAuthAccount,
  loadAccounts,
  type OAuthAccount,
  refreshBackoffActive,
  saveAccountState,
} from '@cortexkit/openai-auth-core/internal'

export interface PreTolerantRefreshDeps {
  paths: AccountPaths
  now: () => number
  refresh: (token: string) => Promise<{
    access: string
    refresh: string
    expires: number
    expiresIn: number
  }>
}

function refreshEnabled(storage: AccountStorage | null) {
  return storage?.refresh?.enabled !== false
}

function refreshBeforeExpiryMs(storage: AccountStorage | null) {
  return (storage?.refresh?.refreshBeforeExpiryMinutes ?? 240) * 60_000
}

function tokenNeedsRefresh(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  return (
    !account.access ||
    !account.expires ||
    account.expires - now <= refreshBeforeExpiryMs(storage)
  )
}

function updateStoredAccount(storage: AccountStorage, account: OAuthAccount) {
  const idx = storage.accounts.findIndex((a) => a.id === account.id)
  if (idx !== -1) storage.accounts[idx] = account
}

async function refreshAccountNow(
  deps: PreTolerantRefreshDeps,
  account: OAuthAccount,
  storage: AccountStorage,
): Promise<OAuthAccount> {
  let latestStorage = await loadAccounts(deps.paths)
  let latestAccount = latestStorage?.accounts.find(
    (c): c is OAuthAccount => c.id === account.id && isOAuthAccount(c),
  )
  if (
    latestAccount &&
    !tokenNeedsRefresh(latestAccount, latestStorage, deps.now())
  ) {
    updateStoredAccount(storage, latestAccount)
    return latestAccount
  }
  const fileLock = await acquireRefreshFileLock({
    name: fallbackRefreshLockName((latestAccount ?? account).id),
    ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
    path: deps.paths.configPath,
    now: deps.now,
    renew: true,
  })
  if (!fileLock)
    throw new Error('Fallback OAuth refresh is already in progress')
  try {
    latestStorage = await loadAccounts(deps.paths)
    latestAccount = latestStorage?.accounts.find(
      (c): c is OAuthAccount => c.id === account.id && isOAuthAccount(c),
    )
    if (
      latestAccount &&
      !tokenNeedsRefresh(latestAccount, latestStorage, deps.now())
    ) {
      updateStoredAccount(storage, latestAccount)
      return latestAccount
    }
    if (!latestAccount) throw new Error(`account ${account.id} was removed`)
    const source = latestAccount
    const refreshed = await deps.refresh(source.refresh)
    source.access = refreshed.access
    source.refresh = refreshed.refresh
    source.expires = refreshed.expires
    source.lastRefreshedAt = refreshed.expires - refreshed.expiresIn * 1000
    source.lastRefreshError = undefined
    updateStoredAccount(storage, source)
    await saveAccountState(storage, deps.paths, { accounts: true })
    return source
  } finally {
    await fileLock.release()
  }
}

/** One pass of the pre-tolerant build's background refresh. */
export async function preTolerantRefreshDueAccounts(
  deps: PreTolerantRefreshDeps,
): Promise<void> {
  const storage = await loadAccounts(deps.paths)
  if (!storage || !refreshEnabled(storage)) return
  let changed = false
  for (const account of storage.accounts) {
    if (account.enabled === false || !isOAuthAccount(account)) continue
    if (!tokenNeedsRefresh(account, storage, deps.now())) continue
    if (
      refreshBackoffActive(
        account.lastRefreshError,
        account.refresh,
        deps.now(),
      )
    )
      continue
    try {
      await refreshAccountNow(deps, account, storage)
      changed = true
    } catch (error) {
      account.lastRefreshError = buildRefreshOperationError({
        error,
        now: deps.now(),
        refreshToken: account.refresh,
        previous: account.lastRefreshError,
      })
      updateStoredAccount(storage, account)
      changed = true
    }
  }
  if (changed) await saveAccountState(storage, deps.paths, { accounts: true })
}
