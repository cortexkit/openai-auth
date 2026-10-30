// Rate-limit marks shared by every OpenCode 2 location in this process.
//
// OpenCode 2 runs setup once per location (project directory) in one server
// process. A 429 seen in one location must keep every location using the same
// accounts off the refused account until the mark expires, so a mark is kept
// per server process and per account source, not per location: every
// location's pool source and adapter read and write the same map, as they
// share session pins and session accounts.
//
// Pool rows are keyed by the account store; vault accounts by the vault's
// roster file. Two vault consumers can reuse a route id for different
// accounts, so each roster gets its own map rather than one process-wide map
// keyed by route id.

import { resolve } from 'node:path'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'

// A new name, so a map an older version left on the process (a plugin
// reloaded in place) is never read with this version's expectations.
const registryKey = Symbol.for(
  '@cortexkit/openai-auth/opencode2-rate-limits/v1',
)
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, Map<string, number>>
}
const entries =
  processState[registryKey] ?? new Map<string, Map<string, number>>()
processState[registryKey] = entries

/**
 * Account key to mark expiry (epoch ms), shared by every location in the
 * process. Never released, like the session pins: there is one entry per
 * account at most, and an expired mark is ignored by whoever reads it.
 */
function acquire(key: string): Map<string, number> {
  let marks = entries.get(key)
  if (!marks) {
    marks = new Map()
    entries.set(key, marks)
  }
  return marks
}

/** The marks of one account store's pool rows. */
export function acquirePoolRateLimitMarks(
  paths: AccountPaths,
): Map<string, number> {
  // Relative and absolute paths to the same store give the same key.
  return acquire(
    JSON.stringify([
      'pool',
      resolve(paths.configPath),
      resolve(paths.statePath),
    ]),
  )
}

/** The marks of the accounts one vault roster lists. */
export function acquireVaultRateLimitMarks(
  rosterPath: string,
): Map<string, number> {
  return acquire(JSON.stringify(['vault', resolve(rosterPath)]))
}
