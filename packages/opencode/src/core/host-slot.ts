// Reading OpenCode's own `openai` login slot.
//
// The slot holds the main account's login on an install that has not moved
// into the account pool, the pool placeholder on one that has, or, on an
// install that used the removed vault custody, a tombstone (see
// `tombstone.ts` in the core package). The account-pool migration and the
// adoption of later logins read it through these helpers.

import { createHash } from 'node:crypto'
import { isTombstoned } from '@cortexkit/openai-auth-core/internal'

const MAIN_PROVIDER = 'openai'
const SLOT_ABSENT_CONFIRMATION_MS = 250

/**
 * The file lock (at the config path) every refresh of the slot's own token
 * takes, in this build and in older ones; the migration takes it before it
 * copies the slot's token.
 */
export const MAIN_REFRESH_LOCK_NAME = 'main-refresh'

export type MainOauthSlot = {
  type: 'oauth'
  access?: string
  refresh?: string
  expires?: number
}

/** A fingerprint of the slot's token pair, so a later read can tell it is the same login. */
export function mainSlotFamilyFingerprint(
  slot: MainOauthSlot,
): string | undefined {
  if (typeof slot.access !== 'string' || typeof slot.refresh !== 'string') {
    return undefined
  }
  const access = Buffer.from(slot.access)
  const refresh = Buffer.from(slot.refresh)
  const length = (value: Buffer) => {
    const encoded = Buffer.alloc(4)
    encoded.writeUInt32BE(value.length)
    return encoded
  }
  return createHash('sha256')
    .update(length(access))
    .update(access)
    .update(length(refresh))
    .update(refresh)
    .digest('hex')
}

/**
 * - `real`: an OAuth value that is not a tombstone (the pool placeholder is
 *   told apart by the caller);
 * - `tombstone`: the value the removed vault custody left in the slot;
 * - `slot-absent`: confirmed missing;
 * - `indeterminate`: not an OAuth value, or a missing read that could not be
 *   confirmed.
 */
export type MainAuthSlot =
  | { kind: 'real'; oauth: MainOauthSlot }
  | { kind: 'tombstone'; oauth: MainOauthSlot }
  | { kind: 'slot-absent' }
  | { kind: 'indeterminate' }

type HostAuthClient = {
  auth: {
    get?: (input: { path: { id: string } }) => Promise<unknown>
    all?: () => Promise<Record<string, unknown>>
  }
}

function asOauthSlot(value: unknown): MainOauthSlot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'oauth') return undefined
  return {
    type: 'oauth',
    ...(typeof candidate.access === 'string'
      ? { access: candidate.access }
      : {}),
    ...(typeof candidate.refresh === 'string'
      ? { refresh: candidate.refresh }
      : {}),
    ...(typeof candidate.expires === 'number'
      ? { expires: candidate.expires }
      : {}),
  }
}

/** The slot's OAuth value when it carries both tokens. */
export function asCompleteMainOauthSlot(
  value: unknown,
): { access: string; refresh: string; expires?: number } | undefined {
  const oauth = asOauthSlot(value)
  if (typeof oauth?.access !== 'string' || typeof oauth.refresh !== 'string') {
    return undefined
  }
  return {
    access: oauth.access,
    refresh: oauth.refresh,
    ...(typeof oauth.expires === 'number' ? { expires: oauth.expires } : {}),
  }
}

export function classifyMainAuthSlot(value: unknown): MainAuthSlot {
  const oauth = asOauthSlot(value)
  if (!oauth) return { kind: 'indeterminate' }
  return isTombstoned(oauth)
    ? { kind: 'tombstone', oauth }
    : { kind: 'real', oauth }
}

async function getMainSlot(client: HostAuthClient): Promise<unknown> {
  if (!client.auth.get) return undefined
  return client.auth.get({ path: { id: MAIN_PROVIDER } })
}

async function nonEmptyAuthMap(client: HostAuthClient): Promise<boolean> {
  if (!client.auth.all) return false
  return Object.keys(await client.auth.all()).length > 0
}

/**
 * Reads the slot. A single missing read is not trusted (the host may be in
 * the middle of writing it), so absence needs two reads apart with a
 * non-empty auth map both times.
 */
export async function confirmMainAuthSlot(deps: {
  client: HostAuthClient
  now: () => number
  sleep: (ms: number) => Promise<void>
}): Promise<MainAuthSlot> {
  const first = await getMainSlot(deps.client)
  if (first !== undefined) return classifyMainAuthSlot(first)

  const firstMapNonEmpty = await nonEmptyAuthMap(deps.client)
  const beforeSleep = deps.now()
  await deps.sleep(SLOT_ABSENT_CONFIRMATION_MS)
  if (deps.now() - beforeSleep < SLOT_ABSENT_CONFIRMATION_MS) {
    return { kind: 'indeterminate' }
  }

  const second = await getMainSlot(deps.client)
  if (second !== undefined) return classifyMainAuthSlot(second)
  const secondMapNonEmpty = await nonEmptyAuthMap(deps.client)
  return firstMapNonEmpty && secondMapNonEmpty
    ? { kind: 'slot-absent' }
    : { kind: 'indeterminate' }
}
