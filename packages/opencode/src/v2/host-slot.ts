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

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HostSlotAdapter } from '../core/pool-migration'

/**
 * Stands in for the entries of an `auth.json` that does not exist or holds
 * none. The migration trusts an absent `openai` slot only when the host's
 * auth map reads non-empty (an empty map from OpenCode 1's API can be a torn
 * read mid-write); a file read here is either parsed whole or refused, so an
 * absent or empty file is a definite "no OpenCode 1 login on this machine".
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

/** OpenCode 1's `auth.json` as the migration's host slot. */
export function opencode1HostSlot(
  path: string = opencode1AuthPath(),
): HostSlotAdapter {
  return {
    async get(input) {
      return (await readAuthMap(path))?.[input.path.id]
    },
    async set(input) {
      const map = (await readAuthMap(path)) ?? {}
      map[input.path.id] = input.body
      await mkdir(dirname(path), { recursive: true })
      // Written to a temporary name and renamed into place, so OpenCode 1
      // never reads a half-written file.
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`, {
          mode: 0o600,
        })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
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
