import { resolve } from 'node:path'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { SessionPins } from './pins'

// OpenCode 2 runs setup once per location, and separate plugin bundle copies
// must see the same ledger for pending-byte accounting across projects.
const registryKey = Symbol.for('@cortexkit/openai-auth/opencode2-pins')
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, SessionPins>
}
const entries = processState[registryKey] ?? new Map<string, SessionPins>()
processState[registryKey] = entries

export function acquireSessionPins(paths: AccountPaths): SessionPins {
  const key = JSON.stringify([
    resolve(paths.configPath),
    resolve(paths.statePath),
  ])
  let pins = entries.get(key)
  if (!pins) {
    pins = new SessionPins()
    entries.set(key, pins)
  }
  // No release: a location's eviction or /reload must not lose live session
  // pins, even when no locations remain. Each ledger stays bounded by
  // MAX_SESSION_PINS and lives until the server process exits.
  return pins
}
