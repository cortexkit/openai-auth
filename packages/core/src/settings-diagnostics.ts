import type {
  ReportEntry,
  ReportReason,
  SettingsRefusalCode,
} from '@cortexkit/common-auth/settings'
import {
  getSettingsAuthority,
  SettingsAuthorityRefusal,
  type SettingsAuthorityResult,
} from './settings-authority.js'
import {
  inspectSettingsCompletion,
  type SettingsCompletion,
} from './settings-completion.js'
import { canonicalSettingsPath } from './settings-install.js'
import type { SettingsSnapshot } from './settings-snapshot.js'

/** Shared by both hosts so their menus never paraphrase a settings diagnostic. */
export const SETTINGS_DIAGNOSTICS_TEXT = Object.freeze({
  file: (path: string) => `Settings file: ${path}`,
  separate: "Settings stay in this install's account store.",
  legacyProcess:
    'Settings stay in the old account store because another process still uses it.',
  legacyBusy:
    'Settings stay in the old account store because the stores were busy.',
  legacySetting: (setting: string) =>
    `Settings stay in the old account store because ${setting} couldn't be moved.`,
  legacyFailed: (cause: string) =>
    `Settings stay in the old account store because the move failed: ${cause}.`,
  sharedMissing: 'No settings file, so defaults are in use.',
  sharedMoved: 'Settings were moved to the settings file in this process.',
  sharedFound: 'Settings file found.',
  preExistingFile: (path: string) =>
    `Settings come from ${path}. Preferences in the old account store weren't copied, because this file already existed.`,
  removedFile: (path: string) =>
    `The settings file ${path} was removed, so defaults are in use. Old preferences aren't copied again.`,
  refused: (folder: string, cause: string) =>
    `openai-auth didn't start. Process records folder: ${folder}. Cause: ${cause}`,
  report: {
    'unknown-key': (key: string) => `Unknown settings key: ${key}.`,
    'override-not-allowed': (key: string) =>
      `Settings override not allowed: ${key}.`,
    'user-only-in-project': (key: string) =>
      `User-only setting found in a project file: ${key}.`,
    'invalid-value': (key: string) => `Invalid settings value: ${key}.`,
    'invalid-schema-version': (key: string) =>
      `Invalid settings schema version: ${key}.`,
    'newer-version-key-ignored': (key: string) =>
      `Settings key from a newer version ignored: ${key}.`,
    'duplicate-key': (key: string) => `Duplicate settings key: ${key}.`,
    unparseable: (file: string) => `The settings file ${file} can't be parsed.`,
    unreadable: (file: string) => `The settings file ${file} can't be read.`,
  } satisfies Record<ReportReason, (location: string) => string>,
  checks: {
    duplicateFloors:
      'Invalid killswitch_account_floors: duplicate account and host pair.',
    localBoth:
      'Invalid killswitch_account_floors: only vault accounts may use host both.',
    duplicateQuota: 'Invalid quota_minimum_remaining: duplicate quota window.',
    warmWindow:
      'Invalid cache_keep_window: use at most one window with unequal hours.',
  },
  refusal: {
    'settings-unparseable':
      "The settings file can't be read. Fix it or remove it, then try again.",
    'settings-newer-version':
      'The settings file is from a newer openai-auth. Update openai-auth to change settings.',
    'settings-invalid-value': "That value isn't allowed for this setting.",
    'settings-busy': 'The settings file is busy. Try again.',
    'settings-unavailable': "Settings can't be saved for this install.",
  } satisfies Record<SettingsRefusalCode, string>,
})

/** Accept only the code, never the provider's message or the settings path. */
export function settingsRefusalText(code: SettingsRefusalCode): string {
  return SETTINGS_DIAGNOSTICS_TEXT.refusal[code]
}

export function settingsReportLine(entry: ReportEntry): string {
  const text = SETTINGS_DIAGNOSTICS_TEXT
  // Snapshot semantic checks share ReportEntry with descriptor failures. Match
  // both the setting and the fixed check detail, not arbitrary provider text.
  if (entry.reason === 'invalid-value' && entry.keyPath.length === 1) {
    switch (entry.keyPath[0]) {
      case 'killswitch_account_floors':
        if (entry.detail === 'Duplicate account and host pair')
          return text.checks.duplicateFloors
        if (entry.detail === 'Only vault accounts may use host both')
          return text.checks.localBoth
        break
      case 'quota_minimum_remaining':
        if (entry.detail === 'Duplicate quota window')
          return text.checks.duplicateQuota
        break
      case 'cache_keep_window':
        if (entry.detail === 'Use at most one window with unequal hours')
          return text.checks.warmWindow
    }
  }
  const location =
    entry.reason === 'unparseable' || entry.reason === 'unreadable'
      ? entry.file.path
      : entry.keyPath.length
        ? entry.keyPath.join('.')
        : entry.file.path
  return text.report[entry.reason](location)
}

export function settingsDecisionLine(
  authority: SettingsAuthorityResult,
  completion: SettingsCompletion | undefined,
  sawTargetMissing = false,
): string {
  const text = SETTINGS_DIAGNOSTICS_TEXT
  if (authority.decision === 'separate') return text.separate
  if (authority.decision === 'shared') {
    if (!completion?.targetExists) return text.sharedMissing
    return authority.ranMove &&
      authority.move?.outcome === 'moved' &&
      !sawTargetMissing
      ? text.sharedMoved
      : text.sharedFound
  }
  if (authority.move?.outcome === 'busy') return text.legacyBusy
  if (
    authority.move?.outcome === 'fence-closed' ||
    authority.fence?.open === false
  )
    return text.legacyProcess
  const failure = authority.move?.failure
  if (failure?.kind === 'setting') return text.legacySetting(failure.setting)
  // Move exceptions may include stored values. Only the runner's classified
  // metadata is safe to show, including the source file for a read failure.
  const cause =
    failure?.kind === 'cause'
      ? 'path' in failure
        ? `${failure.host} ${failure.path}: ${failure.code}`
        : failure.code
      : 'SETTINGS_MOVE_FAILED'
  return text.legacyFailed(cause)
}

export interface SettingsDiagnosticsOptions {
  configPath: string
  snapshot?: Pick<SettingsSnapshot, 'refresh' | 'report'>
  log: { warn(message: string): unknown }
}

interface DiagnosticsState {
  logged: Set<string>
  sawTargetMissing: Set<string>
}

// Different plugin generations can load separate copies of core in one process.
// Share notice deduplication and removal history just as authority decisions do.
const stateKey = Symbol.for('@cortexkit/openai-auth/settings-diagnostics')
const processState = globalThis as typeof globalThis & {
  [stateKey]?: DiagnosticsState
}
const state = processState[stateKey] ?? {
  logged: new Set(),
  sawTargetMissing: new Set(),
}
processState[stateKey] = state

/** Call at startup to log notices, and again at each Diagnostics open. */
export async function buildSettingsDiagnostics({
  configPath,
  snapshot,
  log,
}: SettingsDiagnosticsOptions): Promise<{ lines: string[] }> {
  const pending = getSettingsAuthority(configPath)
  if (!pending) throw new Error('Settings authority has not been decided')
  let authority: SettingsAuthorityResult
  try {
    authority = await pending
  } catch (error) {
    // A rejection can originate from another loaded copy of core.
    if (
      error instanceof SettingsAuthorityRefusal ||
      (error instanceof Error &&
        error.name === 'SettingsAuthorityRefusal' &&
        'folder' in error &&
        typeof error.folder === 'string')
    ) {
      const cause = error.cause
      return {
        lines: [
          SETTINGS_DIAGNOSTICS_TEXT.refused(
            String(error.folder),
            cause instanceof Error ? cause.message : String(cause),
          ),
        ],
      }
    }
    throw error
  }
  if (authority.decision === 'separate')
    return { lines: [SETTINGS_DIAGNOSTICS_TEXT.separate] }

  const completion =
    authority.decision === 'shared'
      ? inspectSettingsCompletion(authority.install)
      : authority.completion
  const identity = canonicalSettingsPath(authority.install.target)
  if (authority.decision === 'shared' && !completion?.targetExists)
    state.sawTargetMissing.add(identity)
  const lines = [
    SETTINGS_DIAGNOSTICS_TEXT.file(authority.install.target),
    settingsDecisionLine(
      authority,
      completion,
      state.sawTargetMissing.has(identity),
    ),
  ]
  if (authority.decision === 'shared' && completion) {
    for (const kind of ['preExistingFile', 'removedFile'] as const) {
      if (!completion[kind]) continue
      const line = SETTINGS_DIAGNOSTICS_TEXT[kind](authority.install.target)
      lines.push(line)
      const key = `${kind}:${canonicalSettingsPath(authority.install.target)}`
      if (!state.logged.has(key)) {
        state.logged.add(key)
        log.warn(line)
      }
    }
    await snapshot?.refresh()
    lines.push(...(snapshot?.report().map(settingsReportLine) ?? []))
  }
  return { lines }
}

/** Read-only plugin slot; hosts with other diagnostics can append build().lines. */
export function settingsDiagnosticsSection(
  options: SettingsDiagnosticsOptions,
) {
  return {
    title: 'Diagnostics',
    build: () => buildSettingsDiagnostics(options),
  }
}
