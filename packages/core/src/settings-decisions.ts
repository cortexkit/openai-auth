import { settingsIdentity } from './settings-install.ts'

export type SettingsDecision = 'shared' | 'legacy' | 'separate'

// Plugin generations can load separate copies of core in the same process.
// Keeping the map on globalThis makes them share one choice per config file.
const decisionsKey = Symbol.for('@cortexkit/openai-auth/settings-decisions')
const processState = globalThis as typeof globalThis & {
  [decisionsKey]?: Map<string, SettingsDecision>
}
const decisions = processState[decisionsKey] ?? new Map()
processState[decisionsKey] = decisions

export function getSettingsDecision(
  configPath: string,
): SettingsDecision | undefined {
  // Every request reads this; settingsIdentity resolves the path only once.
  return decisions.get(settingsIdentity(configPath))
}

/** The first startup choice lasts for this config file's process lifetime. */
export function recordSettingsDecision(
  configPath: string,
  decision: SettingsDecision,
): SettingsDecision {
  const identity = settingsIdentity(configPath)
  const existing = decisions.get(identity)
  if (existing !== undefined) return existing
  decisions.set(identity, decision)
  return decision
}
