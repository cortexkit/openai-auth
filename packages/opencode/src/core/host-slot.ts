// Reading OpenCode's own `openai` login slot.
//
// The slot holds the main account's login on an install that has not moved
// into the account pool, the pool placeholder on one that has, or, on an
// install that used the removed vault custody, a tombstone (see
// `tombstone.ts` in the core package). The account-pool migration and the
// adoption of later logins read it through these helpers.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isTombstoned } from '@cortexkit/openai-auth-core/internal'
import type { HostSlotAdapter } from './pool-migration.ts'

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
    get: (input: { path: { id: string } }) => Promise<unknown>
    all: () => Promise<Record<string, unknown>>
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
  return client.auth.get({ path: { id: MAIN_PROVIDER } })
}

async function nonEmptyAuthMap(client: HostAuthClient): Promise<boolean> {
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

// ---------------------------------------------------------------------------
// OpenCode 1's login slot, as the plugin running inside OpenCode 1 reads it.
//
// The client OpenCode 1 hands its plugins (its generated SDK) can write a
// login (`client.auth.set`) but has no way to read one: there is no
// `client.auth.get` or `client.auth.all`. The migration and the adoption of
// later logins need both, so they read OpenCode 1's `auth.json` directly,
// exactly as OpenCode 1's own auth service does, and write through
// `client.auth.set`, so OpenCode 1 stays the only writer of its file.
// ---------------------------------------------------------------------------

/**
 * Where OpenCode 1 keeps its logins: `auth.json` in its data directory,
 * `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode` when
 * `XDG_DATA_HOME` is unset or empty. OpenCode 1 resolves the directory
 * through the `xdg-basedir` package, which treats an empty value as unset
 * and takes the home directory from `os.homedir()`; this does the same.
 */
export function opencodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return join(dataHome, 'opencode', 'auth.json')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const optionalString = (value: unknown) =>
  value === undefined || typeof value === 'string'

/**
 * Whether OpenCode 1 accepts an `auth.json` entry as a login. OpenCode 1
 * decodes each entry against its login schema and silently drops the ones
 * that do not fit, so such an entry does not exist as far as it is
 * concerned; it does not exist here either.
 */
function isOpencodeLogin(value: unknown): boolean {
  if (!isPlainRecord(value)) return false
  switch (value.type) {
    case 'oauth':
      return (
        typeof value.refresh === 'string' &&
        typeof value.access === 'string' &&
        typeof value.expires === 'number' &&
        Number.isSafeInteger(value.expires) &&
        value.expires >= 0 &&
        optionalString(value.accountId) &&
        optionalString(value.enterpriseUrl)
      )
    case 'api':
      return (
        typeof value.key === 'string' &&
        (value.metadata === undefined ||
          (isPlainRecord(value.metadata) &&
            Object.values(value.metadata).every(
              (entry) => typeof entry === 'string',
            )))
      )
    case 'wellknown':
      return typeof value.key === 'string' && typeof value.token === 'string'
    default:
      return false
  }
}

/**
 * OpenCode 1's logins, read fresh from the file on every call as OpenCode 1
 * reads them:
 * - `OPENCODE_AUTH_CONTENT`, when set and valid JSON, replaces the file;
 * - a file that is missing, unreadable or not valid JSON (for instance one
 *   caught halfway through a rewrite) reads as no logins at all. The
 *   migration does not trust an empty map: it takes it for a torn read and
 *   tries again later rather than conclude the slot is empty;
 * - an entry OpenCode 1 would not decode as a login is left out.
 */
export async function readOpencodeAuthMap(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const content = env.OPENCODE_AUTH_CONTENT
  if (content) {
    try {
      const parsed: unknown = JSON.parse(content)
      // OpenCode 1 returns this value unchecked; a value that is not an
      // object holds no login it could find either.
      return isPlainRecord(parsed) ? parsed : {}
    } catch {
      // Invalid JSON is ignored and the file is read, as OpenCode 1 does.
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
  if (!isPlainRecord(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => isOpencodeLogin(value)),
  )
}

/** OpenCode 1's own login writer, `client.auth.set` of its plugin client. */
export type OpencodeAuthSet = (input: {
  path: { id: string }
  body: unknown
}) => Promise<unknown>

/**
 * OpenCode 1's login slot for a plugin running inside OpenCode 1: reads
 * `auth.json` itself (see `readOpencodeAuthMap`), writes through OpenCode 1's
 * own `client.auth.set`.
 */
export function opencode1ClientSlot(options: {
  set: OpencodeAuthSet
  path?: string
  env?: NodeJS.ProcessEnv
}): HostSlotAdapter {
  const env = options.env ?? process.env
  const path = options.path ?? opencodeAuthPath(env)
  return {
    async get(input) {
      return (await readOpencodeAuthMap(path, env))[input.path.id]
    },
    async all() {
      return readOpencodeAuthMap(path, env)
    },
    async set(input) {
      const result = await options.set(input)
      // The generated client reports a refused request in its result
      // (`{ error, response }`) instead of throwing; a write that did not
      // happen must not pass for one that did.
      if (
        isPlainRecord(result) &&
        'error' in result &&
        result.error !== undefined
      )
        throw new Error(
          `OpenCode refused the write of its ${input.path.id} login: ${JSON.stringify(result.error)}`,
        )
      return result
    },
  }
}

/**
 * The login slot of the OpenCode 1 plugin client, or why there is none: the
 * client cannot write a login without `auth.set`.
 */
export function opencode1SlotForClient(
  client: unknown,
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): { slot: HostSlotAdapter } | { reason: string } {
  const auth = isPlainRecord(client) ? client.auth : undefined
  const set =
    auth && typeof auth === 'object'
      ? (auth as { set?: unknown }).set
      : undefined
  if (typeof set !== 'function')
    return {
      reason:
        'the OpenCode client has no auth.set to write its login slot with',
    }
  return {
    slot: opencode1ClientSlot({
      ...options,
      // Called as a method: the generated client's methods use `this`.
      set: (input) => (set as OpencodeAuthSet).call(auth, input),
    }),
  }
}
