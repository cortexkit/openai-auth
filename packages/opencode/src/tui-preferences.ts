import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createTuiPreferenceWriter,
  readTuiPreferencesFile as readCommonTuiPreferencesFile,
  type TuiPreferenceWriter,
  watchTuiPreferences as watchCommonTuiPreferences,
} from '@cortexkit/common-auth/tui-prefs'

export const TUI_PREFS_FILE_ENV = 'OPENCODE_TUI_PREFERENCES_FILE'
const FILE_NAME = 'tui-preferences.jsonc'

// Shared preferences file for opencode TUI plugins. One top-level key per
// plugin (short name, e.g. "openai-auth"). The file is optional: every
// reader must fall back to defaults when it is missing or malformed.
export function getTuiPreferencesFile(): string {
  const override = process.env[TUI_PREFS_FILE_ENV]
  if (override) return override
  const configDir =
    process.env.OPENCODE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(configDir, FILE_NAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Tolerant read: a missing file, parse errors or a non-object root all resolve
// to {} so the sidebar never crashes on user-edited content.
export function readTuiPreferencesFile(): Promise<Record<string, unknown>> {
  return readCommonTuiPreferencesFile(getTuiPreferencesFile())
}

export const PLUGIN_KEY = 'openai-auth'
export const DEFAULT_SLOT_ORDER = 160

export interface OpenaiAuthTuiPrefs {
  forceToTop: boolean
  order: number
  startCollapsed: boolean
  rememberCollapsed: boolean
  // null = never persisted; seed the UI from startCollapsed instead.
  collapsed: boolean | null
  pollMs: number
  refreshDebounceMs: number
  header: {
    label: string
    showVersion: boolean
  }
  sections: {
    quota: boolean
    fallbackAccounts: boolean
    routing: boolean
    health: boolean
    pacing: boolean
  }
  appearance: {
    barWidth: number
    barFilledChar: string
    barEmptyChar: string
    warnThreshold: number
    errorThreshold: number
  }
}

export type AppearancePrefs = OpenaiAuthTuiPrefs['appearance']

export const DEFAULT_PREFS: OpenaiAuthTuiPrefs = {
  forceToTop: false,
  order: DEFAULT_SLOT_ORDER,
  startCollapsed: false,
  rememberCollapsed: true,
  collapsed: null,
  pollMs: 1500,
  refreshDebounceMs: 200,
  header: { label: 'OPENAI', showVersion: true },
  sections: {
    quota: true,
    fallbackAccounts: true,
    routing: true,
    health: true,
    pacing: true,
  },
  appearance: {
    barWidth: 10,
    barFilledChar: '\u2588',
    barEmptyChar: '\u2591',
    warnThreshold: 50,
    errorThreshold: 80,
  },
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), min), max)
}

function label(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.slice(0, maxLength)
}

function char(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const first = [...value][0]
  return first ?? fallback
}

// Per-key validation: every value is independently clamped/defaulted so one
// bad entry never poisons the rest. Never throws.
export function resolveOpenaiAuthPrefs(
  root: Record<string, unknown>,
): OpenaiAuthTuiPrefs {
  const entry = root[PLUGIN_KEY]
  if (!isRecord(entry)) return structuredClone(DEFAULT_PREFS)

  const d = DEFAULT_PREFS
  const header = isRecord(entry.header) ? entry.header : {}
  const sections = isRecord(entry.sections) ? entry.sections : {}
  const appearance = isRecord(entry.appearance) ? entry.appearance : {}

  const warnThreshold = int(
    appearance.warnThreshold,
    d.appearance.warnThreshold,
    0,
    99,
  )
  const errorThreshold = Math.max(
    int(appearance.errorThreshold, d.appearance.errorThreshold, 0, 100),
    Math.min(warnThreshold + 1, 100),
  )

  return {
    forceToTop: bool(entry.forceToTop, d.forceToTop),
    order: int(entry.order, d.order, -10000, 10000),
    startCollapsed: bool(entry.startCollapsed, d.startCollapsed),
    rememberCollapsed: bool(entry.rememberCollapsed, d.rememberCollapsed),
    collapsed: typeof entry.collapsed === 'boolean' ? entry.collapsed : null,
    pollMs: int(entry.pollMs, d.pollMs, 500, 30000),
    refreshDebounceMs: int(
      entry.refreshDebounceMs,
      d.refreshDebounceMs,
      50,
      5000,
    ),
    header: {
      label: label(header.label, d.header.label, 20),
      showVersion: bool(header.showVersion, d.header.showVersion),
    },
    sections: {
      quota: bool(sections.quota, d.sections.quota),
      fallbackAccounts: bool(
        sections.fallbackAccounts,
        d.sections.fallbackAccounts,
      ),
      routing: bool(sections.routing, d.sections.routing),
      health: bool(sections.health, d.sections.health),
      pacing: bool(sections.pacing, d.sections.pacing),
    },
    appearance: {
      barWidth: int(appearance.barWidth, d.appearance.barWidth, 4, 40),
      barFilledChar: char(appearance.barFilledChar, d.appearance.barFilledChar),
      barEmptyChar: char(appearance.barEmptyChar, d.appearance.barEmptyChar),
      warnThreshold,
      errorThreshold,
    },
  }
}

const FORCE_TOP_BASE = -100000

// Shared forceToTop convention: forced plugins sort below FORCE_TOP_BASE,
// ordered among themselves by their top-level key's position in the file, so
// users reprioritize by reordering keys. The user-facing `order` knob clamps
// to -10000..10000, strictly above the forced band, so a manual order can
// never beat forceToTop. Host slots render ascending by order; opencode's
// built-ins occupy 100-500.
//
// Key-naming requirement: plugin keys must be non-integer-like short names
// (e.g. "openai-auth"). JavaScript object key iteration order hoists
// integer-like keys ("0", "1", "42") ahead of any string keys, which would
// skew the indexOf-based ordering of forced plugins. The shared
// `tui-preferences.jsonc` convention requires non-numeric names, so this
// implementation does not paper over the JS quirk.
export function computeEffectiveOrder(
  root: Record<string, unknown>,
  pluginKey: string,
  defaultOrder: number,
): number {
  const entry = root[pluginKey]
  if (!isRecord(entry)) return defaultOrder
  if (entry.forceToTop === true) {
    return FORCE_TOP_BASE + Object.keys(root).indexOf(pluginKey)
  }
  return int(entry.order, defaultOrder, -10000, 10000)
}

const TEMPLATE = `// Shared preferences for opencode TUI plugins.
// One top-level key per plugin (short name). See each plugin's README for
// its supported settings. This file is safe to hand-edit; plugins update
// individual keys in place and preserve comments.
{}
`

type JsonValue = string | number | boolean | null

// One writer per file and plugin key. The file is resolved on every call, as
// it always has been, so a changed environment variable takes effect on the
// next update.
const writers = new Map<string, TuiPreferenceWriter>()

function writerFor(file: string, pluginKey: string): TuiPreferenceWriter {
  const key = JSON.stringify([file, pluginKey])
  let writer = writers.get(key)
  if (!writer) {
    writer = createTuiPreferenceWriter({ file, pluginKey })
    writers.set(key, writer)
  }
  return writer
}

// The shared writer starts a missing file from its own generic header. Create
// the file with this plugin's header first, so a file it creates reads the same
// as before. 'wx' only creates: an existing file, or one another process
// creates first, is left alone.
async function seedPreferencesFile(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, TEMPLATE, { encoding: 'utf8', flag: 'wx' }).catch(
    () => {},
  )
}

let writeChain: Promise<void> = Promise.resolve()

// Updates run one after another in call order, so the last call wins. Each
// re-reads the file, applies a minimal comment-preserving edit to one property
// and replaces the file atomically, under the shared preferences lock so other
// plugins' writers cannot interleave. Best-effort by design: preferences are
// never worth crashing the TUI over, so failures resolve.
export function queueTuiPreferenceUpdate(
  pluginKey: string,
  path: string[],
  value: JsonValue,
): Promise<void> {
  const file = getTuiPreferencesFile()
  const writer = writerFor(file, pluginKey)
  writeChain = writeChain
    .then(() => seedPreferencesFile(file))
    .then(() => writer.queueTuiPreferenceUpdate(path, value))
    .catch(() => {})
  return writeChain
}

// Fires `onChange` when the preferences file's content changes. Returns a
// disposer; never throws.
export function watchTuiPreferences(onChange: () => void): () => void {
  return watchCommonTuiPreferences(getTuiPreferencesFile(), onChange)
}
