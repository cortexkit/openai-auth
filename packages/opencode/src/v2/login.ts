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

import {
  connectVaultHost,
  vaultAuthority,
} from '@cortexkit/common-auth/claustrum'
import {
  isPlaceholderCredential,
  type PoolLoginMethod,
  type VaultActivationMethod,
} from '@cortexkit/common-auth/opencode2'
import {
  PoolOperationError,
  type PoolStore,
} from '@cortexkit/common-auth/store'
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
  VAULT_PLUGIN_NAME,
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
  'Vault login requires this OpenCode host to be enrolled in the Claustrum vault. Run /openai → Vault → Connect and approve the request before trying again.'

export async function assertLocalPoolLogin(
  vault: Pick<OpenAiVault, 'authority'>,
): Promise<void> {
  if ((await vault.authority()) !== 'local')
    throw new Error(
      'This host is connected to the credential vault or its enrollment is unreadable; the login was not stored. Disconnect this host from the vault to add a local login.',
    )
}

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
      const authority = await vaultAuthority(vault.paths, vault.name)
      if (authority === 'host') {
        // Proves the host's vault relay (installed by Thalamus, which started
        // this host) is present: this throws when it isn't.
        // Each accessor call returns a new client its caller owns, so the
        // probe closes it; the consumer opens its own for serving.
        const probe = connectVaultHost(VAULT_PLUGIN_NAME)
        await Promise.resolve(probe.close()).catch(() => undefined)
      } else if (authority !== 'vault') {
        throw new Error(VAULT_ACTIVATION_REFUSAL)
      }
    },
  }
}

export function chatgptLoginMethods(input: {
  beginLogin: BeginLogin
  version: string
  vault?: Pick<OpenAiVault, 'authority'>
}): PoolLoginMethod<PoolLoginResult>[] {
  const method = (
    id: string,
    label: string,
    headless: boolean,
  ): PoolLoginMethod<PoolLoginResult> => ({
    method: { id, type: 'oauth', label },
    async authorize() {
      if (input.vault) await assertLocalPoolLogin(input.vault)
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

const LOGIN_WRITE_ATTEMPTS = 3

/**
 * Writes one login into the pool by the rules at the top of this file. Row
 * writes hold the legacy locks an older openai-auth process refreshes a row
 * under (`legacyRefreshLocks`), as the OpenCode 1 account menu's do.
 */
export async function writeLoginToPool(
  pool: PoolStore,
  paths: AccountPaths,
  login: PoolLoginResult,
  options: {
    origin?: 'login' | 'import'
    vault?: Pick<OpenAiVault, 'authority'>
  } = {},
): Promise<PoolLoginOutcome> {
  if (options.vault) await assertLocalPoolLogin(options.vault)
  if (isLeftoverCredential(login))
    throw new Error(
      'the credential is not a ChatGPT login (a placeholder or a tombstone); it was not stored',
    )
  const store = withAccountRules(pool, {
    rowLocks: (id) => legacyRefreshLocks(paths, id),
  })
  const credential = {
    type: 'oauth' as const,
    refresh: login.refresh,
    ...(login.access !== undefined ? { access: login.access } : {}),
    ...(login.expires !== undefined ? { expires: login.expires } : {}),
  }
  const identity = identityOf(login)
  const withIdentity = identity !== undefined ? { identity } : {}
  for (let attempt = 1; ; attempt++) {
    const load = await pool.read()
    if (load.status !== 'ready')
      throw new Error(
        `the account pool cannot be read (${load.status}); the login was not stored`,
      )
    if (options.vault) await assertLocalPoolLogin(options.vault)
    if (options.origin === 'import') {
      const held = load.rows.find(
        (row) =>
          (identity !== undefined && row.identity === identity) ||
          (row.credential?.type === 'oauth' &&
            row.credential.refresh === login.refresh),
      )
      if (held) return { id: held.id, operation: 'kept' }
    }
    const oauth = load.rows.filter(
      (row) => row.type === 'oauth' && !row.invalid,
    )
    const holder = identity
      ? oauth.find((row) => row.identity === identity)
      : undefined
    const main = load.rows.find((row) => row.id === POOL_MAIN_ROW_ID)
    const emptyMain =
      main && !main.invalid && !main.credential ? main : undefined
    // Use the row ID as a fallback only if the login or row lacks an identity.
    const byId =
      main && login.id !== POOL_MAIN_ROW_ID
        ? oauth.find(
            (row) =>
              row.id === login.id &&
              (identity === undefined || row.identity === undefined),
          )
        : undefined
    const target = holder ?? emptyMain ?? byId
    try {
      if (target) {
        // A competing replace advances the epoch. This cannot detect another
        // writer completing an empty row via add at the same epoch and identity.
        const replaced = await store.replace(
          target.id,
          credential,
          withIdentity,
          {
            attribution: {
              credentialEpoch: target.credentialEpoch ?? 1,
              ...(target.identity !== undefined
                ? { identity: target.identity }
                : {}),
            },
          },
        )
        return { id: replaced.id, operation: 'replaced' }
      }
      // The account-rules add can replace a row by ID without checking its
      // epoch and identity. Use the store's own add instead.
      const added = await pool.add(
        {
          id: main ? login.id : POOL_MAIN_ROW_ID,
          credential,
          ...withIdentity,
          ...(login.label !== undefined ? { label: login.label } : {}),
        },
        main
          ? undefined
          : {
              protect: ({ row }) =>
                row ? 'row main already exists' : undefined,
            },
      )
      return {
        id: added.id,
        operation:
          added.outcome === 'added-disabled'
            ? 'added-disabled'
            : main && added.outcome === 'rotated'
              ? 'replaced'
              : 'added',
      }
    } catch (error) {
      if (
        attempt === LOGIN_WRITE_ATTEMPTS ||
        !(error instanceof PoolOperationError) ||
        error.phase !== 'before-first-write' ||
        (error.kind !== 'attribution' &&
          error.kind !== 'unknown-row' &&
          error.kind !== 'row-key-changed' &&
          error.kind !== 'row-protected' &&
          error.kind !== 'id-exists')
      )
        throw error
    }
  }
}
