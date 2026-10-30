/**
 * Host support.
 *
 * Everything a host still needs directly once its own `core/` directory is
 * gone: the account store, the OAuth primitives, the reset path, the quota
 * bookkeeping, the logger and the RPC payload types. Importing from here is a
 * host visibly reaching past the command seam on `.`, which is the point of
 * keeping the two apart — the package is private, so this split is
 * documentation rather than a compatibility promise.
 */

export {
  acquireRefreshFileLock,
  isLostMarkerRaceError,
  writeJsonAtomic,
} from '@cortexkit/common-auth/fs'
export * from './accounts'
export * from './backoff'
export {
  type CacheKeepManager,
  type ResetTargetIdentity,
  renderResetCoordinatorResult,
} from './commands'
export * from './logger'
export * from './oauth'
export * from './paths'
export * from './pool-session-pins'
export * from './pool-source-state'
export * from './protocol'
export * from './provider'
export * from './quota-manager'
export * from './quota-normalize'
export * from './refresh-all-quota'
export * from './reset-credits'
export * from './tombstone'
export * from './util/credential-redaction'
export * from './util/error'
export * from './util/open-url'
export * from './util/record'
export * from './vault'
export {
  runVaultAccountMenu,
  VAULT_LOCAL_ACTION_REFUSAL,
} from './vault-account-menu'
export * from './vault-routing'
