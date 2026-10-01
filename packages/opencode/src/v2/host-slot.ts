// OpenCode 1's login slot, read from OpenCode 2.
//
// The account-pool migration (`core/pool-migration.ts`) moves the credential
// in OpenCode 1's `openai` login slot into pool row `main` and leaves the
// slot a placeholder. OpenCode 2 keeps its own credentials in its database,
// so under OpenCode 2 the slot the migration reads is OpenCode 1's
// `auth.json` itself, through the same `get`/`set`/`all` shape as OpenCode
// 1's `client.auth`. That keeps one migration path, one fence and one pool
// for both hosts: an install that runs OpenCode 1 again afterwards finds the
// placeholder and the migrated pool, exactly as if OpenCode 1 had migrated.
//
// OpenCode 1 rewrites `auth.json` whole, from its own read, without a lock
// this process could take. So the placeholder write here narrows what it can
// lose as far as the file allows: it re-reads the file at once before
// writing, refuses to write when the `openai` login is no longer the one the
// migration last read (the migration ends retryably and plans again later),
// changes only the `openai` key, and renames a complete file into place with
// the mode the file already has. What stays open is the few milliseconds
// between that re-read and the rename: a whole-file write by OpenCode 1 that
// lands inside them is either overwritten by the rename (its change is lost)
// or overwrites the placeholder (the migration's read-back then reports the
// placeholder overwritten, and the slot still holds a real login).

import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HostSlotAdapter } from '../core/pool-migration'

/**
 * Stands in for the entries of an `auth.json` that does not exist or holds
 * none. The migration trusts an absent `openai` slot only when the host's
 * auth map reads non-empty (an empty map from OpenCode 1's API can be a torn
 * read mid-write); a file read here is either parsed whole or refused, so an
 * absent or empty file is a definite "no OpenCode 1 login on this machine".
 *
 * A write in progress cannot pass for that: OpenCode 1 either truncates and
 * rewrites the file, where a read in between sees no text or a cut-off
 * object, which fails to parse and is refused; or it renames a complete file
 * into place, which never leaves the path missing. An `auth.json` holding
 * exactly `{}` is a finished write of no logins.
 */
export const NO_OPENCODE1_LOGINS = '(no OpenCode 1 logins on this machine)'

/** Where OpenCode 1 keeps its logins: `$XDG_DATA_HOME/opencode/auth.json`. */
export function opencode1AuthPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'auth.json')
}

async function readAuthMap(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // A parse failure throws: the migration then ends retryably rather than
  // reading a half-written file as an empty slot.
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${path} does not hold a JSON object`)
  return parsed as Record<string, unknown>
}

/** Thrown by a slot write whose login changed after the read it was decided on. */
export class HostSlotChangedError extends Error {
  constructor() {
    super(
      "OpenCode 1's openai login changed after the account-pool migration read it; nothing was written, and the migration tries again later",
    )
    this.name = 'HostSlotChangedError'
  }
}

/** A comparable form of one entry; `undefined` for an absent one. */
function entryKey(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value)
}

/** The permission bits of the file, or undefined when it does not exist. */
async function modeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** OpenCode 1's `auth.json` as the migration's host slot. */
export function opencode1HostSlot(
  path: string = opencode1AuthPath(),
): HostSlotAdapter {
  // What the latest `get` of each entry saw. The migration reads the slot
  // through `get` (its fence) right before it writes; a write is allowed only
  // while the entry still holds what that read saw. `all` does not count: the
  // migration uses it only to tell a torn read from an empty file.
  const seen = new Map<string, string | undefined>()
  return {
    async get(input) {
      const value = (await readAuthMap(path))?.[input.path.id]
      seen.set(input.path.id, entryKey(value))
      return value
    },
    async set(input) {
      const id = input.path.id
      const mode = await modeOf(path)
      const map = (await readAuthMap(path)) ?? {}
      if (!seen.has(id) || seen.get(id) !== entryKey(map[id]))
        throw new HostSlotChangedError()
      map[id] = input.body
      await mkdir(dirname(path), { recursive: true })
      // Written to a temporary name and renamed into place, so OpenCode 1
      // never reads a half-written file.
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`, {
          mode: mode ?? 0o600,
        })
        // The process umask may have narrowed the mode given at creation.
        await chmod(temporary, mode ?? 0o600)
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      seen.set(id, entryKey(input.body))
      return true
    },
    async all() {
      const map = await readAuthMap(path)
      if (!map || Object.keys(map).length === 0)
        return { [NO_OPENCODE1_LOGINS]: true }
      return map
    },
  }
}
