import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  ACCOUNT_FILE_NAME,
  ACCOUNT_STATE_FILE_NAME,
  type AccountPaths,
  deriveStatePath,
} from '@cortexkit/openai-auth-core/tui-support'
import { defaultStateHome } from './version-fence'

/**
 * Where OpenCode's account store and the plugin's other runtime files live.
 *
 * This is the ONLY definition of this host's resolution rules. The store code
 * itself takes both paths as arguments and resolves nothing, so the lock and
 * the write it guards can never disagree about which file they mean — a
 * disagreement would lose mutual exclusion on a file holding credentials while
 * every test still passed, since each side works on its own.
 *
 * The file names come from the core so the two hosts cannot drift apart on what
 * the store is called.
 *
 * Runtime files (the account state file, the vault folder derived from it and
 * the Codex sessions files) live in one of two places, the "runtime folder":
 * - the legacy layout: OpenCode's config folder itself, where versions before
 *   the move kept them;
 * - the state-home layout: `<state home>/cortexkit/openai-auth/`, or a
 *   `config-<hash>/` folder inside it when OPENCODE_CONFIG_DIR names a folder
 *   other than the default, so two config folders never share a file.
 * `runtime-layout.ts` decides which one at plugin start and moves the files
 * once; until a process has decided, the layout marker alone tells. The
 * settings file `openai-auth.json` stays in OpenCode's config folder either way.
 */

export type { AccountPaths }
export { ACCOUNT_FILE_NAME, ACCOUNT_STATE_FILE_NAME, deriveStatePath }

/** OpenCode 1's Codex sessions file. */
export const OPENCODE1_CODEX_SESSIONS_FILE = 'openai-auth-sessions.json'
/** OpenCode 2's Codex sessions file. */
export const OPENCODE2_CODEX_SESSIONS_FILE =
  'openai-auth-sessions-opencode2.json'
/** In the state-home folder: present once that folder is authoritative. */
export const RUNTIME_LAYOUT_MARKER_FILE = 'layout.json'
/** In a keyed state-home folder: names the config folder it belongs to. */
export const RUNTIME_CONFIG_DIR_NOTE_FILE = 'config-dir.json'

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  return defaultConfigDir()
}

function defaultConfigDir() {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_OPENAI_AUTH_FILE?.trim() ||
    join(getConfigDir(), ACCOUNT_FILE_NAME)
  )
}

function normalizePathForComparison(path: string, platform: NodeJS.Platform) {
  const resolved = resolve(path)
  return platform === 'win32' || platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}

function realpathForComparison(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return join(realpathSync.native(dirname(path)), basename(path))
    } catch {
      return undefined
    }
  }
}

/**
 * Detect path aliases without requiring either file to exist. This is defense
 * in depth: hardlinks and bind mounts can still make distinct paths share a
 * file, because neither is distinguishable through pathname identity.
 */
export function accountPathsCollide(
  configPath: string,
  statePath: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (
    normalizePathForComparison(configPath, platform) ===
    normalizePathForComparison(statePath, platform)
  ) {
    return true
  }

  const configIdentity = realpathForComparison(configPath)
  const stateIdentity = realpathForComparison(statePath)
  return (
    configIdentity !== undefined &&
    stateIdentity !== undefined &&
    normalizePathForComparison(configIdentity, platform) ===
      normalizePathForComparison(stateIdentity, platform)
  )
}

/**
 * A config folder as one comparable string: symlinks resolved where the
 * folder (or its parent) exists, and case folded where the file system
 * usually ignores case. Two spellings of one folder must map to one
 * state-home folder, or a process using the other spelling would find an
 * empty one.
 */
function comparableDir(path: string): string {
  return normalizePathForComparison(
    realpathForComparison(resolve(path)) ?? resolve(path),
    process.platform,
  )
}

/** Both folders a config folder's runtime files can live in. */
export interface RuntimeLayoutLocation {
  /** Identifies the config folder in the layout records of heartbeats. */
  key: string
  /** OpenCode's config folder: the legacy runtime folder. */
  configDir: string
  /** The state-home runtime folder for this config folder. */
  stateHomeDir: string
  /** True when the config folder is OpenCode's default one. */
  isDefaultConfigDir: boolean
}

const locationCache = new Map<string, RuntimeLayoutLocation>()

export function runtimeLayoutLocation(
  configDir = getConfigDir(),
): RuntimeLayoutLocation {
  const stateHome = defaultStateHome()
  const fallback = defaultConfigDir()
  const cacheKey = `${configDir}\0${fallback}\0${stateHome}`
  const cached = locationCache.get(cacheKey)
  if (cached) return cached
  const key = comparableDir(configDir)
  const isDefaultConfigDir = key === comparableDir(fallback)
  const root = join(stateHome, 'cortexkit', 'openai-auth')
  const location: RuntimeLayoutLocation = {
    key,
    configDir,
    stateHomeDir: isDefaultConfigDir
      ? root
      : join(
          root,
          `config-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        ),
    isDefaultConfigDir,
  }
  locationCache.set(cacheKey, location)
  return location
}

export type RuntimeLayout = 'legacy' | 'state-home'

// The layout each config folder got in this process, once decided. Kept on
// the global object because OpenCode 2 may load more than one copy of this
// bundle into one process, and every copy must resolve the same files.
const decisionsKey = Symbol.for('@cortexkit/openai-auth/runtime-layouts')
const decisionState = globalThis as typeof globalThis & {
  [decisionsKey]?: Map<string, RuntimeLayout>
}
const decisions = decisionState[decisionsKey] ?? new Map()
decisionState[decisionsKey] = decisions

function decisionKey(location: RuntimeLayoutLocation): string {
  return `${location.stateHomeDir}\0${location.key}`
}

/**
 * Fix this process's layout for a config folder. Only `runtime-layout.ts`
 * calls this, once per folder, while it holds the layout lock.
 */
export function setRuntimeLayout(
  location: RuntimeLayoutLocation,
  layout: RuntimeLayout,
): void {
  decisions.set(decisionKey(location), layout)
}

/** The layout this process fixed for a config folder, if any. */
export function decidedRuntimeLayout(
  location: RuntimeLayoutLocation,
): RuntimeLayout | undefined {
  return decisions.get(decisionKey(location))
}

/** Test seam: forget every decided layout and cached location. */
export function __resetRuntimeLayoutsForTest(): void {
  decisions.clear()
  locationCache.clear()
}

/**
 * The folder that holds this config folder's runtime files. A process that
 * has not decided its layout (a tool that never started the plugin) follows
 * the marker, read-only: the state-home folder once it holds the marker,
 * OpenCode's config folder until then.
 */
export function getRuntimeDir(configDir = getConfigDir()): string {
  const location = runtimeLayoutLocation(configDir)
  const layout =
    decidedRuntimeLayout(location) ??
    (existsSync(join(location.stateHomeDir, RUNTIME_LAYOUT_MARKER_FILE))
      ? 'state-home'
      : 'legacy')
  return layout === 'state-home' ? location.stateHomeDir : configDir
}

/** A host's Codex sessions file, in the runtime folder. */
export function getCodexSessionsPath(host: 'opencode1' | 'opencode2'): string {
  return join(
    getRuntimeDir(),
    host === 'opencode1'
      ? OPENCODE1_CODEX_SESSIONS_FILE
      : OPENCODE2_CODEX_SESSIONS_FILE,
  )
}

/** True when `configPath` is `openai-auth.json` in OpenCode's config folder. */
function isDefaultConfigPath(configPath: string): boolean {
  const standard = join(getConfigDir(), ACCOUNT_FILE_NAME)
  return (
    configPath === standard ||
    normalizePathForComparison(configPath, process.platform) ===
      normalizePathForComparison(standard, process.platform)
  )
}

/**
 * The state file a user chose rather than the runtime folder: the
 * OPENCODE_OPENAI_AUTH_STATE_FILE override, or the file beside a custom
 * config file. Undefined when the state file follows the runtime folder.
 */
export function chosenAccountStatePath(
  configPath = getAccountStoragePath(),
): string | undefined {
  const explicit = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE?.trim()
  if (explicit) return explicit
  return isDefaultConfigPath(configPath)
    ? undefined
    : deriveStatePath(configPath)
}

export function getAccountStatePath(configPath = getAccountStoragePath()) {
  const explicit = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE?.trim()
  if (explicit) {
    if (accountPathsCollide(configPath, explicit)) {
      throw new Error(
        `OPENCODE_OPENAI_AUTH_STATE_FILE resolves to the config path (${resolve(configPath)}). Set OPENCODE_OPENAI_AUTH_STATE_FILE to a different file.`,
      )
    }
    return explicit
  }
  // A custom config file keeps its state file beside it, as before the move.
  if (!isDefaultConfigPath(configPath)) return deriveStatePath(configPath)
  return join(getRuntimeDir(), ACCOUNT_STATE_FILE_NAME)
}

/**
 * Both file paths a store call needs, resolved the way this host resolves them.
 *
 * Every call site that used to pass a single config path and let the store
 * derive the state path now passes this pair instead, so the state-file
 * override keeps being honoured in exactly the places it was before.
 */
export function getAccountPaths(
  configPath = getAccountStoragePath(),
): AccountPaths {
  return { configPath, statePath: getAccountStatePath(configPath) }
}
