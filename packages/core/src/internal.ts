/**
 * Host support.
 *
 * Everything a host still needs directly once its own `core/` directory is
 * gone: the account store, the OAuth primitives, the reset path, the quota
 * bookkeeping, the logger and the RPC payload types. Importing from here is a
 * host visibly reaching past the command seam on `.`, which is the point of
 * keeping the two apart — the package is private, so this split is
 * documentation rather than a compatibility promise.
 *
 * `src/tests/export-manifest.ts` is the authoritative list of what this file
 * and `./index.ts` expose, and a test fails when the two disagree.
 */

// Named rather than `export *`: the client carries transport internals (the
// subc wire types, its error classes) that are not part of this package's
// surface, and a blanket re-export puts them in it. The host needs exactly
// these three to locate the vault socket.
export {
  ClaustrumClient,
  detectClaustrumConnection,
  getDefaultClaustrumConnectionPath,
} from '@cortexkit/claustrum-client'
export * from './accounts'
export * from './atomic-write'
export * from './backoff'
export {
  type CacheKeepManager,
  type ResetTargetIdentity,
  renderResetCoordinatorResult,
} from './commands'
export * from './custody'
export * from './custody-manifest'
export * from './logger'
export * from './oauth'
export * from './paths'
export * from './protocol'
export * from './provider'
export * from './quota-manager'
export * from './quota-normalize'
export * from './refresh-all-quota'
export * from './refresh-file-lock'
export * from './reset-credits'
export * from './util/error'
export * from './util/open-url'
export * from './util/record'
