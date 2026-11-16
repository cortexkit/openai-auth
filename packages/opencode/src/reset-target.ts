import type { ResetTargetIdentity } from '@cortexkit/openai-auth-core'
import {
  type AccountStorage,
  extractAccountIdFromClaims,
  isOAuthAccount,
  isTombstoned,
  type loadAccounts,
  type OAuthAccount,
  parseJwtClaims,
} from '@cortexkit/openai-auth-core/internal'
import { getResolvedSettingsView } from './config'
import {
  findPoolMainRow,
  isPoolMainPlaceholder,
  MainAccountInPoolError,
} from './core/pool-main'

export class AuthPersistError extends Error {
  readonly code = 'OPENAI_AUTH_PERSIST_FAILED'

  constructor(cause: unknown) {
    super(
      'OpenAI OAuth token refreshed but could not be persisted; re-login required',
      { cause },
    )
    this.name = 'AuthPersistError'
  }
}

export type ResetTargetResolutionErrorKind =
  | 'unknown_account'
  | 'disabled_account'
  | 'non_oauth_account'
  | 'token_unavailable'

export class ResetTargetResolutionError extends Error {
  readonly code: ResetTargetResolutionErrorKind

  constructor(code: ResetTargetResolutionErrorKind, message: string) {
    super(message)
    this.name = 'ResetTargetResolutionError'
    this.code = code
  }
}

interface ResetTargetResolverDeps {
  getAuth: () => Promise<{
    type: string
    access?: string
    refresh?: string
    expires?: number
  }>
  refreshMainWithLease: () => Promise<{
    access: string
    refresh: string
    expires: number
  }>
  refreshFallbackAccount: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<OAuthAccount>
  /**
   * Refresh the pool row `main` while it serves as the main account. Defaults
   * to refreshFallbackAccount.
   */
  refreshPoolMainRow?: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<OAuthAccount>
  /**
   * On a migrated install, the pool row behind an account key (`main` is row
   * `main`) and its usable bearer, refreshed through the pool. Undefined when
   * the install is not migrated; the legacy slot and roster then apply.
   */
  poolAccess?: (accountKey: string) => Promise<PoolResetAccess | undefined>
  loadAccounts: typeof loadAccounts
  accountStoragePath: string
  accountStatePath: string
  now: () => number
}

function resetTargetNeedsRefresh(
  access: string | undefined,
  expires: number | undefined,
  storage: AccountStorage | null,
  now: number,
  configPath: string,
) {
  const refreshBeforeExpiryMs =
    (getResolvedSettingsView(storage, configPath).refresh
      ?.refreshBeforeExpiryMinutes ?? 240) * 60_000
  return !access || !expires || expires - now <= refreshBeforeExpiryMs
}

/** A pool row as the reset-credit resolver sees it; `row` is absent when no row has the id. */
export interface PoolResetAccess {
  row?: {
    id: string
    type: 'oauth' | 'api'
    enabled: boolean
    label?: string
    identity?: string
  }
  token?: string
}

/** The reset target for a pool row, or the refusal the legacy resolver gives. */
export function poolResetTarget(
  accountKey: string,
  pooled: PoolResetAccess,
): ResetTargetIdentity {
  const isMain = accountKey === 'main'
  const row = pooled.row
  const noToken = () =>
    new ResetTargetResolutionError(
      'token_unavailable',
      isMain
        ? 'Main OpenAI account has no usable access token.'
        : `Fallback account ${accountKey} has no usable access token.`,
    )
  if (!row) {
    if (isMain) throw noToken()
    throw new ResetTargetResolutionError(
      'unknown_account',
      `Fallback account ${accountKey} was not found.`,
    )
  }
  if (!row.enabled) {
    throw new ResetTargetResolutionError(
      'disabled_account',
      `${isMain ? 'Main' : 'Fallback'} account ${accountKey} is disabled.`,
    )
  }
  if (row.type !== 'oauth') {
    throw new ResetTargetResolutionError(
      'non_oauth_account',
      `${isMain ? 'Main' : 'Fallback'} account ${accountKey} is not an OAuth account.`,
    )
  }
  if (!pooled.token) throw noToken()
  const claims = parseJwtClaims(pooled.token)
  return {
    accountKey,
    label: isMain ? 'Main account' : (row.label ?? accountKey),
    accessToken: pooled.token,
    chatgptAccountId:
      row.identity ?? (claims ? extractAccountIdFromClaims(claims) : undefined),
  }
}

export function createResetTargetResolver(deps: ResetTargetResolverDeps) {
  // The main account while the slot holds the pool placeholder: the pool row
  // `main`, refreshed and resolved the way a fallback row is, but reported as
  // the main account.
  async function resolvePoolMainTarget(): Promise<ResetTargetIdentity> {
    const storage = await deps.loadAccounts({
      configPath: deps.accountStoragePath,
      statePath: deps.accountStatePath,
    })
    const row = findPoolMainRow(storage)
    if (!storage || !row || isTombstoned(row)) {
      throw new ResetTargetResolutionError(
        'token_unavailable',
        'Main OpenAI account has no usable access token.',
      )
    }
    let resolved = row
    if (
      resetTargetNeedsRefresh(
        resolved.access,
        resolved.expires,
        storage,
        deps.now(),
        deps.accountStoragePath,
      )
    ) {
      resolved = await (deps.refreshPoolMainRow ?? deps.refreshFallbackAccount)(
        resolved,
        storage,
      )
    }
    if (!resolved.access) {
      throw new ResetTargetResolutionError(
        'token_unavailable',
        'Main OpenAI account has no usable access token.',
      )
    }
    const claims = parseJwtClaims(resolved.access)
    return {
      accountKey: 'main',
      label: 'Main account',
      accessToken: resolved.access,
      chatgptAccountId:
        resolved.accountId ??
        (claims ? extractAccountIdFromClaims(claims) : undefined),
    }
  }

  return async (accountKey: string): Promise<ResetTargetIdentity> => {
    const pooled = await deps.poolAccess?.(accountKey)
    if (pooled) return poolResetTarget(accountKey, pooled)
    if (accountKey === 'main') {
      const storage = await deps.loadAccounts({
        configPath: deps.accountStoragePath,
        statePath: deps.accountStatePath,
      })
      let auth = await deps.getAuth()
      if (isPoolMainPlaceholder(auth)) return resolvePoolMainTarget()
      if (auth.type !== 'oauth') {
        throw new ResetTargetResolutionError(
          'non_oauth_account',
          'Main OpenAI account is not authenticated with OAuth.',
        )
      }
      if (
        resetTargetNeedsRefresh(
          auth.access,
          auth.expires,
          storage,
          deps.now(),
          deps.accountStoragePath,
        )
      ) {
        try {
          auth = { type: 'oauth', ...(await deps.refreshMainWithLease()) }
        } catch (error) {
          // The slot became the placeholder while this refresh waited.
          if (error instanceof MainAccountInPoolError) {
            return resolvePoolMainTarget()
          }
          throw error
        }
      }
      if (!auth.access) {
        throw new ResetTargetResolutionError(
          'token_unavailable',
          'Main OpenAI account has no usable access token.',
        )
      }
      // The access token's claims reflect the account authenticated right
      // now; the persisted mainAccountId lags a re-login until the next
      // storage write. Prefer the live identity, falling back to storage for
      // token shapes that carry no account claim.
      const claims = parseJwtClaims(auth.access)
      const liveAccountId = claims
        ? extractAccountIdFromClaims(claims)
        : undefined
      const freshStorage = await deps.loadAccounts({
        configPath: deps.accountStoragePath,
        statePath: deps.accountStatePath,
      })
      return {
        accountKey,
        label: 'Main account',
        accessToken: auth.access,
        chatgptAccountId: liveAccountId ?? freshStorage?.mainAccountId,
      }
    }

    const storage = await deps.loadAccounts({
      configPath: deps.accountStoragePath,
      statePath: deps.accountStatePath,
    })
    const account = storage?.accounts.find(
      (candidate) => candidate.id === accountKey,
    )
    if (!storage || !account) {
      throw new ResetTargetResolutionError(
        'unknown_account',
        `Fallback account ${accountKey} was not found.`,
      )
    }
    if (account.enabled === false) {
      throw new ResetTargetResolutionError(
        'disabled_account',
        `Fallback account ${accountKey} is disabled.`,
      )
    }
    if (!isOAuthAccount(account)) {
      throw new ResetTargetResolutionError(
        'non_oauth_account',
        `Fallback account ${accountKey} is not an OAuth account.`,
      )
    }

    const noToken = () =>
      new ResetTargetResolutionError(
        'token_unavailable',
        `Fallback account ${accountKey} has no usable access token.`,
      )
    if (isTombstoned(account)) throw noToken()
    let resolved = account
    if (
      resetTargetNeedsRefresh(
        resolved.access,
        resolved.expires,
        storage,
        deps.now(),
        deps.accountStoragePath,
      )
    ) {
      resolved = await deps.refreshFallbackAccount(resolved, storage)
    }
    if (!resolved.access) throw noToken()

    const freshStorage = await deps.loadAccounts({
      configPath: deps.accountStoragePath,
      statePath: deps.accountStatePath,
    })
    const freshAccount = freshStorage?.accounts.find(
      (candidate) => candidate.id === accountKey,
    )
    if (!freshStorage || !freshAccount) {
      throw new ResetTargetResolutionError(
        'unknown_account',
        `Fallback account ${accountKey} was not found.`,
      )
    }
    if (freshAccount.enabled === false) {
      throw new ResetTargetResolutionError(
        'disabled_account',
        `Fallback account ${accountKey} is disabled.`,
      )
    }
    if (!isOAuthAccount(freshAccount)) {
      throw new ResetTargetResolutionError(
        'non_oauth_account',
        `Fallback account ${accountKey} is not an OAuth account.`,
      )
    }
    return {
      accountKey,
      label: resolved.label ?? accountKey,
      accessToken: resolved.access,
      chatgptAccountId: freshAccount.accountId,
    }
  }
}

export function buildResetRedemptionDeps() {
  return {
    fetchImpl: fetch,
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
  }
}

export function isAuthPersistError(error: unknown): error is AuthPersistError {
  return error instanceof AuthPersistError
}
