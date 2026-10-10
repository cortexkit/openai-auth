// ChatGPT logins on OpenCode 2, written into the account pool.
//
// OpenCode 2's built-in OpenAI plugin offers two ChatGPT logins on
// integration `openai` (methods `chatgpt-browser` and `chatgpt-headless`) and
// stores the result in its own credential table. openai-auth registers its
// pool methods alongside them under plugin-scoped ids, leaving the built-in
// methods and their refresh handlers intact. A pool login runs openai-auth's
// own OAuth flows (`beginAccountLogin`, the same browser
// and device flows OpenCode 1 uses), the account lands in the pool, and
// OpenCode 2 keeps only a placeholder (`registerOpenCode2AuthMethods`).
//
// Which row a login lands in follows what a login through OpenCode 1's own
// login slot comes to once the install is migrated:
// - the ChatGPT account a row already holds: that row's credential is
//   replaced (signing in again refreshes the account, `main` included);
// - a pool with no `main` row: the login becomes `main`, the account the
//   ordered routing modes put first, as the migration does with the first
//   OpenCode 1 login;
// - anything else: a new row, named by its ChatGPT account id.
//
// The host's existing ChatGPT login is never copied into the pool: OpenAI
// refresh tokens are single-use, so the host and pool must not refresh the
// same token family. Choosing a pool login runs a separate OAuth flow.

import { enrollmentAuthority } from '@cortexkit/common-auth/claustrum'
import {
  isPlaceholderCredential,
  type PoolLoginMethod,
  type VaultActivationMethod,
} from '@cortexkit/common-auth/opencode2'
import type { PoolStore } from '@cortexkit/common-auth/store'
import { withAccountRules } from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  type BeginAccountLoginOptions,
  type BeginAccountLoginResult,
  extractAccountIdFromClaims,
  type IngestAccount,
  isTombstoned,
  type OpenAiVault,
  POOL_MAIN_ROW_ID,
  parseJwtClaims,
} from '@cortexkit/openai-auth-core/internal'
import {
  legacyRefreshLocks,
  POOL_PLACEHOLDER_REFRESH,
} from '../core/pool-migration'

/** A completed login, as `beginAccountLogin` resolves it. */
export type PoolLoginResult = Pick<
  IngestAccount,
  'id' | 'label' | 'access' | 'refresh' | 'expires' | 'accountId'
>

export type BeginLogin = (
  options: BeginAccountLoginOptions,
) => Promise<BeginAccountLoginResult>

/** Pool methods never replace the host's own ChatGPT login or refresh handlers. */
export const POOL_BROWSER_METHOD = 'openai-auth-pool-browser'
export const POOL_HEADLESS_METHOD = 'openai-auth-pool-headless'
export const VAULT_METHOD = 'openai-auth-vault'
export const VAULT_ACTIVATION_REFUSAL =
  'Vault login requires this OpenCode host to be enrolled in the Claustrum vault. Connect to the vault or disconnect this host before trying again.'

export function vaultLoginMethod(
  vault: Pick<OpenAiVault, 'paths' | 'name'>,
): VaultActivationMethod {
  return {
    method: {
      id: VAULT_METHOD,
      type: 'oauth',
      label: 'ChatGPT accounts in the vault',
    },
    async activate() {
      if ((await enrollmentAuthority(vault.paths, vault.name)) !== 'vault')
        throw new Error(VAULT_ACTIVATION_REFUSAL)
    },
  }
}

export function chatgptLoginMethods(input: {
  beginLogin: BeginLogin
  version: string
}): PoolLoginMethod<PoolLoginResult>[] {
  const method = (
    id: string,
    label: string,
    headless: boolean,
  ): PoolLoginMethod<PoolLoginResult> => ({
    method: { id, type: 'oauth', label },
    async authorize() {
      const flow = await input.beginLogin({ version: input.version, headless })
      return {
        url: flow.url,
        instructions: flow.instructions,
        mode: 'auto',
        callback: flow.completion,
      }
    },
  })
  return [
    method(POOL_BROWSER_METHOD, 'ChatGPT (openai-auth pool, browser)', false),
    method(POOL_HEADLESS_METHOD, 'ChatGPT (openai-auth pool, headless)', true),
  ]
}

export type PoolLoginOutcome = {
  id: string
  /** `kept`: an imported login whose account the pool already holds. */
  operation: 'replaced' | 'added' | 'added-disabled' | 'kept'
}

/**
 * Whether an OAuth value is something left in a login slot that holds no
 * credential: a common-auth placeholder (for any integration), OpenCode 1's
 * pool placeholder, or a tombstone the removed vault custody wrote. None of
 * them may ever become a pool row.
 */
export function isLeftoverCredential(value: {
  access?: unknown
  refresh?: unknown
}): boolean {
  const text = (secret: unknown) => (typeof secret === 'string' ? secret : '')
  return (
    // The predicate reads only the type and the two tokens.
    isPlaceholderCredential({
      type: 'oauth',
      access: text(value.access),
      refresh: text(value.refresh),
    } as Parameters<typeof isPlaceholderCredential>[0]) ||
    value.refresh === POOL_PLACEHOLDER_REFRESH ||
    isTombstoned(value)
  )
}

function identityOf(login: PoolLoginResult): string | undefined {
  if (login.accountId) return login.accountId
  const claims = login.access ? parseJwtClaims(login.access) : undefined
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

/**
 * Writes one login into the pool by the rules at the top of this file. Row
 * writes hold the legacy locks an older openai-auth process refreshes a row
 * under (`legacyRefreshLocks`), as the OpenCode 1 account menu's do.
 */
export async function writeLoginToPool(
  pool: PoolStore,
  paths: AccountPaths,
  login: PoolLoginResult,
  options: { origin?: 'login' | 'import' } = {},
): Promise<PoolLoginOutcome> {
  if (isLeftoverCredential(login))
    throw new Error(
      'the credential is not a ChatGPT login (a placeholder or a tombstone); it was not stored',
    )
  const store = withAccountRules(pool, {
    rowLocks: (id) => legacyRefreshLocks(paths, id),
  })
  const load = await store.read()
  if (load.status !== 'ready')
    throw new Error(
      `the account pool cannot be read (${load.status}); the login was not stored`,
    )
  const credential = {
    type: 'oauth' as const,
    refresh: login.refresh,
    ...(login.access !== undefined ? { access: login.access } : {}),
    ...(login.expires !== undefined ? { expires: login.expires } : {}),
  }
  const identity = identityOf(login)
  const withIdentity = identity !== undefined ? { identity } : {}
  if (options.origin === 'import') {
    const held = load.rows.find(
      (row) =>
        (identity !== undefined && row.identity === identity) ||
        (row.credential?.type === 'oauth' &&
          row.credential.refresh === login.refresh),
    )
    if (held) return { id: held.id, operation: 'kept' }
  }
  const oauth = load.rows.filter((row) => row.type === 'oauth' && !row.invalid)
  const holder = identity
    ? oauth.find((row) => row.identity === identity)
    : undefined
  const main = load.rows.find((row) => row.id === POOL_MAIN_ROW_ID)
  if (holder) {
    const replaced = await store.replace(holder.id, credential, withIdentity)
    return { id: replaced.id, operation: 'replaced' }
  }
  if (!main) {
    const added = await store.add({
      id: POOL_MAIN_ROW_ID,
      credential,
      ...withIdentity,
      ...(login.label !== undefined ? { label: login.label } : {}),
    })
    return {
      id: added.id,
      operation:
        added.outcome === 'added-disabled' ? 'added-disabled' : 'added',
    }
  }
  if (!main.invalid && !main.credential) {
    const replaced = await store.replace(
      POOL_MAIN_ROW_ID,
      credential,
      withIdentity,
    )
    return { id: replaced.id, operation: 'replaced' }
  }
  const added = await store.add({
    id: login.id,
    credential,
    ...withIdentity,
    ...(login.label !== undefined ? { label: login.label } : {}),
  })
  return {
    id: added.id,
    operation:
      added.outcome === 'added-disabled'
        ? 'added-disabled'
        : added.outcome === 'rotated'
          ? 'replaced'
          : 'added',
  }
}
