import { existsSync, readFileSync } from 'node:fs'
import { openaiSettings } from './settings-definition.js'
import type {
  SettingsHost,
  SettingsInstall,
  SettingsStoreSource,
} from './settings-install.js'
import { settingsNoteNamesTarget } from './settings-note.js'

export interface SettingsCompletion {
  kind: 'target-exists' | 'target-removed' | 'no-source' | 'move-needed'
  completed: boolean
  targetExists: boolean
  noteNamesTarget: boolean
  sourcePresent: boolean
  preExistingFile: boolean
  removedFile: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwnPath(value: unknown, path: readonly string[]): boolean {
  let parent = value
  for (const [index, key] of path.entries()) {
    if (!isRecord(parent) || !Object.hasOwn(parent, key)) return false
    // Only containers are inspected. A saved value, even invalid or null, is
    // still a preference key and must never be resolved by this probe.
    if (index === path.length - 1) return true
    parent = parent[key]
  }
  return false
}

/** Check declared legacy key names, without reading or validating their values. */
export function hasMappedPreferenceKeys(
  value: unknown,
  host: SettingsHost,
): boolean {
  return Object.values(openaiSettings.settings).some((setting) =>
    setting.legacy.some(
      (legacy) =>
        legacy.source === `${host}-store` && hasOwnPath(value, legacy.path),
    ),
  )
}

function sourceHasMappedPreferenceKeys(source: SettingsStoreSource): boolean {
  try {
    // This read is only for the notice. Keep it out of the legacy preference
    // readers and mapper so no saved value can enter the resolved settings.
    return hasMappedPreferenceKeys(
      JSON.parse(readFileSync(source.configPath, 'utf8')),
      source.host,
    )
  } catch {
    // An unreadable old store cannot supply key names. It must not prevent an
    // existing shared file from remaining authoritative.
    return false
  }
}

/**
 * At startup, hold settings-authority so publication and startup records stay
 * ordered. Diagnostics can inspect again to refresh notices; request paths must
 * not call this filesystem probe or use it to change a process decision.
 */
export function inspectSettingsCompletion(
  install: Pick<SettingsInstall, 'target' | 'sources'>,
): SettingsCompletion {
  const targetExists = existsSync(install.target)
  const noteNamesTarget = install.sources.some((source) =>
    settingsNoteNamesTarget(source.configPath, install.target),
  )
  const present = install.sources.filter((source) =>
    existsSync(source.configPath),
  )
  const sourcePresent = present.length > 0
  const removedFile = noteNamesTarget && !targetExists
  const preExistingFile =
    targetExists &&
    !noteNamesTarget &&
    present.some(sourceHasMappedPreferenceKeys)
  return {
    kind: targetExists
      ? 'target-exists'
      : noteNamesTarget
        ? 'target-removed'
        : sourcePresent
          ? 'move-needed'
          : 'no-source',
    completed: targetExists || noteNamesTarget,
    targetExists,
    noteNamesTarget,
    sourcePresent,
    preExistingFile,
    removedFile,
  }
}
