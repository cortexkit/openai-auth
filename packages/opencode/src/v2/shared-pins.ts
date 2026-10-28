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

function compatiblePins(value: unknown): value is SessionPins {
  if (!value || typeof value !== 'object') return false
  const pins = value as Partial<SessionPins>
  return (
    typeof pins.get === 'function' &&
    typeof pins.forget === 'function' &&
    typeof pins.subscribe === 'function' &&
    typeof pins.snapshot === 'function' &&
    typeof pins.place === 'function' &&
    typeof pins.placementSnapshot === 'function' &&
    typeof pins.reserve === 'function' &&
    typeof pins.rollback === 'function' &&
    typeof pins.finish === 'function'
  )
}

export function acquireSessionPins(paths: AccountPaths): SessionPins {
  const key = JSON.stringify([
    resolve(paths.configPath),
    resolve(paths.statePath),
  ])
  let registry = entries
  const candidate = entries.get(key)
  if (candidate !== undefined && !compatiblePins(candidate)) {
    // Earlier ledgers have no provisional reservations. Leave their live pins
    // alone; new locations must not call reservation methods on those ledgers.
    const shared = entries as typeof entries & {
      compatibleV1?: Map<string, SessionPins>
    }
    shared.compatibleV1 ??= new Map()
    registry = shared.compatibleV1
  }
  let pins = registry.get(key)
  if (!pins) {
    pins = new SessionPins()
    registry.set(key, pins)
  }
  // No release: a location's eviction or /reload must not lose live session
  // pins, even when no locations remain. Each ledger stays bounded by
  // MAX_SESSION_PINS and lives until the server process exits.
  return pins
}
