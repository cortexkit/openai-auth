// ChatGPT logins on OpenCode 2, written into the account pool.
//
// OpenCode 2's built-in OpenAI plugin offers two ChatGPT logins on
// integration `openai` (methods `chatgpt-browser` and `chatgpt-headless`) and
// stores the result in its own credential table. openai-auth registers its
// own methods under the same ids, so they replace the built-in ones: the login
// runs openai-auth's own OAuth flows (`beginAccountLogin`, the same browser
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

import type { PoolLoginMethod } from '@cortexkit/common-auth/opencode2'
import type { PoolStore } from '@cortexkit/common-auth/store'
import { withAccountRules } from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  type BeginAccountLoginOptions,
  type BeginAccountLoginResult,
  extractAccountIdFromClaims,
  type IngestAccount,
  POOL_MAIN_ROW_ID,
  parseJwtClaims,
} from '@cortexkit/openai-auth-core/internal'
import { legacyRefreshLocks } from '../core/pool-migration'

/** A completed login, as `beginAccountLogin` resolves it. */
export type PoolLoginResult = Pick<
  IngestAccount,
  'id' | 'label' | 'access' | 'refresh' | 'expires' | 'accountId'
>

export type BeginLogin = (
  options: BeginAccountLoginOptions,
) => Promise<BeginAccountLoginResult>

/** The method ids OpenCode 2's built-in OpenAI plugin uses for ChatGPT logins. */
export const CHATGPT_BROWSER_METHOD = 'chatgpt-browser'
export const CHATGPT_HEADLESS_METHOD = 'chatgpt-headless'

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
    method(CHATGPT_BROWSER_METHOD, 'ChatGPT Pro/Plus (browser)', false),
    method(CHATGPT_HEADLESS_METHOD, 'ChatGPT Pro/Plus (headless)', true),
  ]
}

export type PoolLoginOutcome = {
  id: string
  operation: 'replaced' | 'added' | 'added-disabled'
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
): Promise<PoolLoginOutcome> {
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
