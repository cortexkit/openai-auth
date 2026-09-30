// Serving the main account from the account pool.
//
// After the account-pool migration, OpenCode's `openai` slot holds a
// placeholder (see POOL_MAIN_PLACEHOLDER_REFRESH) and the main account's real
// credential lives in the roster row `main`. Everything that used to read the
// main token from the slot asks this module instead: the row's token is kept
// fresh through the ordinary per-row refresh path, and the placeholder itself
// is never refreshed or sent.

import {
  type AccountStorage,
  CUSTODY_EXCLUDED,
  CUSTODY_REFUSE,
  type FallbackAccessResolution,
  findPoolMainRow,
  type OAuthAccount,
  refreshBackoffActive,
} from '@cortexkit/openai-auth-core/internal'

export {
  findPoolMainRow,
  isPoolMainPlaceholder,
  POOL_MAIN_PLACEHOLDER_REFRESH,
  POOL_MAIN_ROW_ID,
  withoutPoolMainRow,
} from '@cortexkit/openai-auth-core/internal'

/**
 * The main slot turned out to hold the pool placeholder, so there is no slot
 * token to refresh: the main account is served from the pool row `main`.
 */
export class MainAccountInPoolError extends Error {
  constructor() {
    super('The main OpenAI account lives in the account pool')
    this.name = 'MainAccountInPoolError'
  }
}

export interface PoolMainAccess {
  /** The row as it stands after any refresh. */
  account: OAuthAccount
  token: string
  provenance: FallbackAccessResolution['provenance']
}

export interface PoolMainAccessDeps {
  storage: AccountStorage | null | undefined
  now: () => number
  isRefreshInert: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<boolean>
  /** Refresh the row through the per-row refresh path, as the main account. */
  refreshAccount: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<OAuthAccount>
  resolveAccess: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<
    FallbackAccessResolution | typeof CUSTODY_REFUSE | typeof CUSTODY_EXCLUDED
  >
  warn?: (message: string, meta: Record<string, unknown>) => void
}

/**
 * The access token for the main account while it lives in the pool row `main`,
 * or undefined when that row is missing or has no usable token (the caller then
 * treats main as unavailable and lets the fallbacks serve).
 *
 * The row is refreshed on the same terms a fallback is: when its token is
 * inside the refresh-before-expiry window, unless a refresh backoff is armed
 * or custody owns the credential. A failed refresh still serves a token that
 * has not expired.
 *
 * The refresh goes through `FallbackAccountManager.refreshAccount` (the
 * legacy per-row path), not through `refreshPoolRow` in `pool-migration.ts`,
 * and that is deliberate:
 * - It already takes the row's legacy fallback lock, the lock every older
 *   build refreshes that row under, so an older build and this path never
 *   refresh the row at once. The migration's own writes to the row take the
 *   same lock (through the store), so they serialise with it too.
 * - What `refreshPoolRow` adds is `main-refresh` and the legacy main lease,
 *   which matter only while the row and the slot hold the same token. That
 *   is only while a transfer is in flight, and then the row is shielded
 *   (`mainAccountId`) and this path is not reached: it runs only once the
 *   slot holds the placeholder, i.e. once the slot's copy is gone. An older
 *   build that could still refresh the slot copy after that is exactly the
 *   pre-tolerant build the version fence keeps away; downgrading to one is
 *   unsupported.
 * - Moving this one path onto the pool store alone would leave two writers
 *   of one row with different lock sets (the background refresh and
 *   fallback selection still use the legacy path). The request path moves
 *   onto the pool as a whole, together with routing and quota.
 */
export async function resolvePoolMainAccess(
  deps: PoolMainAccessDeps,
): Promise<PoolMainAccess | undefined> {
  const storage = deps.storage
  const row = findPoolMainRow(storage)
  if (!storage || !row) return undefined

  let account = row
  const now = deps.now()
  const refreshWindowMs =
    (storage.refresh?.refreshBeforeExpiryMinutes ?? 240) * 60_000
  const due =
    !account.access ||
    !account.expires ||
    account.expires - now <= refreshWindowMs
  if (
    due &&
    !refreshBackoffActive(account.lastRefreshError, account.refresh, now) &&
    !(await deps.isRefreshInert(account, storage))
  ) {
    try {
      account = await deps.refreshAccount(account, storage)
    } catch (error) {
      deps.warn?.('pool main row refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const access = await deps.resolveAccess(account, storage)
  if (access === CUSTODY_REFUSE || access === CUSTODY_EXCLUDED) return undefined
  if (!access.token.trim()) return undefined
  if (
    access.provenance === 'local' &&
    (typeof account.expires !== 'number' || account.expires <= deps.now())
  ) {
    return undefined
  }
  return { account, token: access.token, provenance: access.provenance }
}
