import { statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  type AccountKey,
  canonicalLimitsPath,
  type IdentityBinding,
} from '@cortexkit/common-auth/limits'

/**
 * common-auth 0.38.0 canonicalizes only the immediate parent. Walk missing
 * parents so aliases share even before the store directory exists. Once the
 * dependency ships that ancestor walk, this can be a plain canonicalLimitsPath.
 */
export function canonicalStorePath(path: string): string {
  const absolute = resolve(path)
  let ancestor = dirname(absolute)
  const missing = [basename(absolute)]
  for (;;) {
    try {
      statSync(ancestor)
      return join(dirname(canonicalLimitsPath(join(ancestor, '_'))), ...missing)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return canonicalLimitsPath(path)
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

export function poolLimitsNamespace(
  configPath: string,
  statePath: string,
): string {
  return JSON.stringify([
    'openai',
    'pool',
    canonicalStorePath(configPath),
    canonicalStorePath(statePath),
  ])
}

export function vaultLimitsNamespace(rosterPath: string): string {
  return JSON.stringify(['openai', 'vault', canonicalStorePath(rosterPath)])
}

export type LimitAccount =
  | { kind: 'pool'; id: string; credentialEpoch?: number }
  | { kind: 'vault'; routeId: string; addedAt: number }
  | { kind: 'legacy'; id: string; verifiedIdentity?: string }

/** Tokens and provider identities do not partition managed rows or routes. */
export function limitAccountKey(
  namespace: string,
  account: LimitAccount,
): AccountKey | undefined {
  const accountId = account.kind === 'vault' ? account.routeId : account.id
  const incarnation =
    account.kind === 'pool'
      ? account.credentialEpoch
      : account.kind === 'vault'
        ? account.addedAt
        : account.verifiedIdentity
  if (incarnation === undefined || incarnation === '') return undefined
  return { namespace, accountId, incarnation: String(incarnation) }
}

export function poolLimitsBinding(
  namespace: string,
  row: { id: string; credentialEpoch?: number; identity?: string },
): IdentityBinding | undefined {
  const account = limitAccountKey(namespace, { kind: 'pool', ...row })
  return account
    ? { account, credentialEpoch: account.incarnation, identity: row.identity }
    : undefined
}

export function vaultLimitsBinding(
  namespace: string,
  row: { routeId: string; addedAt: number; accountIdentity?: string },
): IdentityBinding {
  return {
    account: {
      namespace,
      accountId: row.routeId,
      incarnation: String(row.addedAt),
    },
    credentialEpoch: String(row.addedAt),
    identity: row.accountIdentity,
  }
}

export function limitAccountId(account: AccountKey): string {
  return JSON.stringify([
    account.namespace,
    account.accountId,
    account.incarnation,
  ])
}

/** A projection includes binding changes, not quota, labels or limits revisions. */
export function limitsBindingProjection(
  bindings: readonly IdentityBinding[],
): string {
  return JSON.stringify(
    bindings
      .map((binding) => [
        limitAccountId(binding.account),
        binding.credentialEpoch,
        binding.identity ?? null,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  )
}
