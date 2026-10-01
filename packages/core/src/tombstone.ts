/**
 * Credentials left behind by the vault custody this plugin used to ship
 * ("handle mode", removed). When it moved an account into the Claustrum vault
 * it replaced the local credential with a tombstone: an OAuth-shaped value
 * whose refresh token is `claustrum-tombstone:v1:openai` and whose access
 * token is empty. Vault accounts are now served through the shared Claustrum
 * consumer (`vault.ts`) and nothing writes tombstones any more, but an
 * existing install can still hold them, in an account row or in OpenCode's
 * own login slot.
 *
 * A tombstone is never a credential: it is never sent, never refreshed, and
 * an account row holding one never routes. The doctor lists such rows with
 * the remedy (connect the vault, or sign in to the account again).
 */
import {
  custodyPlaceholderKey,
  isCustodyPlaceholderValue,
} from '@cortexkit/common-auth/claustrum'

/** The exact refresh value of the tombstone the removed custody wrote into OpenCode's `openai` slot. */
export const HOST_SLOT_TOMBSTONE_REFRESH = custodyPlaceholderKey('openai')

/** Whether a refresh token is a tombstone left by the removed custody. */
export function isTombstoneRefresh(refresh: unknown): boolean {
  return isCustodyPlaceholderValue(refresh)
}

/** Whether a stored credential (an account row or a host slot) is a tombstone. */
export function isTombstoned(
  credential: { refresh?: unknown; corrupt?: unknown } | null | undefined,
): boolean {
  if (!credential || credential.corrupt === true) return false
  return isTombstoneRefresh(credential.refresh)
}

/**
 * Thrown instead of sending a tombstone to OpenAI as a refresh token. Callers
 * that keep a refresh-failure backoff skip it: there is nothing to retry.
 */
export class TombstoneRefreshError extends Error {
  readonly code = 'tombstone-refresh'

  constructor() {
    super(
      'This OpenAI account was moved into the Claustrum vault by an older version of OpenAI auth and holds no local credential. Connect the vault, or sign in to the account again.',
    )
    this.name = 'TombstoneRefreshError'
  }
}

/** Refuses a token refresh whose refresh token is a tombstone. */
export function assertNotTombstoneRefresh(refresh: unknown): void {
  if (isTombstoneRefresh(refresh)) throw new TombstoneRefreshError()
}
