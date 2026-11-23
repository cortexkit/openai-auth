// Settings resolution for the openai-auth plugin.
//
// Environment values take precedence over the settings source chosen at startup:
//   1. Environment variables (highest priority)
//   2. The shared snapshot, or the legacy config for a non-shared decision
//   3. Built-in defaults (lowest priority)
//
// Resolution per setting: an explicitly-set env var wins; otherwise the config
// file value; otherwise the default.

import { readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  DEFAULT_DUMP_MAX_BYTES,
  parseBooleanOverride,
  resolveCodexEndpoint,
  resolveResponsesLite,
} from '@cortexkit/openai-auth-core/internal'
import { getSettingsDecision } from '@cortexkit/openai-auth-core/settings-decisions'
import { settingsIdentity } from '@cortexkit/openai-auth-core/settings-install'
import {
  type SettingsSnapshot,
  type SettingsView,
  unreadSettingsView,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import { createLogger } from './logger'

export {
  DEFAULT_CODEX_API_ENDPOINT,
  DEFAULT_DUMP_MAX_BYTES,
} from '@cortexkit/openai-auth-core/internal'

const log = createLogger('config')
let warnedDumpMaxBytes = false

/** Shape of ~/.config/opencode/openai-auth.json (all fields optional). */
export interface OpenAIAuthConfig {
  /** Use the WebSocket transport for /responses instead of plain HTTP. Default false. */
  webSockets?: boolean
  /** Use the hand-rolled raw TCP/TLS WebSocket client (incremental streaming). Default false. */
  rawWebSocket?: boolean
  /** Use Codex's Responses Lite request shape. Default false. */
  responsesLite?: boolean
  /** Dump final Codex request bodies for cache debugging. Default false. */
  dump?: boolean | { enabled?: boolean }
  /** Directory for request dumps. Defaults to the OS temp directory. */
  dumpDir?: string
  /** Retained dump bytes. Default 512 MiB; zero disables the cap. */
  dumpMaxBytes?: number
  /** Codex-compatible Responses endpoint. Defaults to ChatGPT's Codex backend. */
  codexApiEndpoint?: string
}

export interface ResolvedSettings {
  webSockets: boolean
  rawWebSocket: boolean
  responsesLite: boolean
  dump: boolean
  dumpDir: string
  dumpMaxBytes: number
  codexApiEndpoint: string
}

const CONFIG_FILE_NAME = 'openai-auth.json'

const ENV = {
  webSockets: 'CORTEXKIT_OPENAI_AUTH_WEBSOCKETS',
  rawWebSocket: 'CORTEXKIT_OPENAI_AUTH_RAW_WS',
  dump: 'CORTEXKIT_OPENAI_AUTH_DUMP',
  dumpDir: 'OPENCODE_OPENAI_AUTH_DUMP_DIR',
  dumpMaxBytes: 'OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES',
  configFile: 'OPENCODE_OPENAI_AUTH_FILE',
  stateFile: 'OPENCODE_OPENAI_AUTH_STATE_FILE',
  configDir: 'OPENCODE_CONFIG_DIR',
} as const

export function getConfigDir(): string {
  const configured = process.env[ENV.configDir]?.trim()
  if (configured) return configured
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

export function getConfigPath(): string {
  return (
    process.env[ENV.configFile]?.trim() ||
    join(getConfigDir(), CONFIG_FILE_NAME)
  )
}

function readConfigFile(path: string): OpenAIAuthConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as OpenAIAuthConfig)
      : {}
  } catch {
    // Missing / unreadable / malformed config falls back to env + defaults.
    return {}
  }
}

// Separate plugin bundles share registrations, just as core shares decisions.
const snapshotsKey = Symbol.for(
  '@cortexkit/openai-auth/opencode-settings-snapshots',
)
const retiredSnapshotsKey = Symbol.for(
  '@cortexkit/openai-auth/opencode-retired-settings-snapshots',
)
const warningsKey = Symbol.for(
  '@cortexkit/openai-auth/opencode-settings-snapshot-warnings',
)
const processState = globalThis as typeof globalThis & {
  [snapshotsKey]?: Map<string, Set<SettingsSnapshot>>
  [retiredSnapshotsKey]?: Map<string, SettingsSnapshot>
  [warningsKey]?: Set<string>
}
processState[snapshotsKey] ??= new Map()
processState[retiredSnapshotsKey] ??= new Map()
processState[warningsKey] ??= new Set()
const snapshots = processState[snapshotsKey]
const retiredSnapshots = processState[retiredSnapshotsKey]
const warnedMissingSnapshot = processState[warningsKey]

/** Register after startup; unregister before disposing this instance's snapshot. */
export function registerSettingsSnapshot(
  configPath: string,
  snapshot: SettingsSnapshot,
): () => void {
  const identity = settingsIdentity(configPath)
  const live = snapshots.get(identity) ?? new Set<SettingsSnapshot>()
  if (live.size === 0) cached.delete(identity)
  retiredSnapshots.delete(identity)
  snapshots.set(identity, live)
  live.add(snapshot)
  // A menu refresh of one instance must win over another instance's older view.
  const unsubscribe = snapshot.onChange(() => {
    live.delete(snapshot)
    live.add(snapshot)
  })
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    unsubscribe()
    live.delete(snapshot)
    if (live.size === 0) {
      snapshots.delete(identity)
      // The disposed snapshot has no watcher, but its last view can bridge a reload.
      retiredSnapshots.set(identity, snapshot)
      cached.delete(identity)
    }
  }
}

function sharedSnapshot(configPath: string): SettingsSnapshot | undefined {
  const identity = settingsIdentity(configPath)
  const live = snapshots.get(identity)
  let latest = retiredSnapshots.get(identity)
  for (const snapshot of live ?? []) latest = snapshot
  if (!latest && !warnedMissingSnapshot.has(identity)) {
    warnedMissingSnapshot.add(identity)
    log.warn(
      'Holding protection values strict until the shared settings file is read',
      {
        configPath: identity,
      },
    )
  }
  return latest
}

/** Memory only for shared installs. A non-null view is not proof a store exists. */
export function getResolvedSettingsView(
  store: AccountStorage | null,
  configPath = getConfigPath(),
): AccountStorage & Partial<Pick<SettingsView, 'waitForReset'>> {
  if (getSettingsDecision(configPath) !== 'shared')
    return store ?? { version: 1, accounts: [] }
  return (
    sharedSnapshot(configPath)?.view(store) ??
    unreadSettingsView('opencode', store)
  )
}

function settingsConfig(configPath: string): OpenAIAuthConfig {
  if (getSettingsDecision(configPath) !== 'shared')
    return readConfigFile(configPath)
  return sharedSnapshot(configPath)?.view() ?? unreadSettingsView('opencode')
}

/** env (if explicitly set) overrides config (if set) overrides default. */
function resolveBool(
  envName: string,
  configValue: boolean | undefined,
  def: boolean,
): boolean {
  const fromEnv = parseBooleanOverride(process.env[envName])
  if (fromEnv !== undefined) return fromEnv
  if (typeof configValue === 'boolean') return configValue
  return def
}

function resolveDumpMaxBytes(configValue: unknown): number {
  const env = process.env[ENV.dumpMaxBytes]
  const raw = env ?? configValue
  if (raw === undefined) return DEFAULT_DUMP_MAX_BYTES
  const value = env?.trim() ? Number(env) : raw
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  if (!warnedDumpMaxBytes) {
    warnedDumpMaxBytes = true
    log.warn('Invalid dumpMaxBytes; using the default 512 MiB cap', {
      env: ENV.dumpMaxBytes,
    })
  }
  return DEFAULT_DUMP_MAX_BYTES
}

function configDumpEnabled(config: OpenAIAuthConfig): boolean | undefined {
  if (typeof config.dump === 'boolean') return config.dump
  if (config.dump && typeof config.dump === 'object') return config.dump.enabled
  return undefined
}

let dumpCache:
  | {
      path: string
      mtimeMs?: number
      ctimeMs?: number
      size?: number
      enabled: boolean
    }
  | undefined

/** Observe other processes' dump toggles without rereading unchanged config files. */
export function isRequestDumpEnabled(configPath = getConfigPath()): boolean {
  const override = parseBooleanOverride(process.env[ENV.dump])
  if (override !== undefined) return override
  if (getSettingsDecision(configPath) === 'shared')
    return resolveBool(
      ENV.dump,
      configDumpEnabled(settingsConfig(configPath)),
      false,
    )
  const path = configPath
  let stamp: { mtimeMs: number; ctimeMs: number; size: number } | undefined
  try {
    stamp = statSync(path)
  } catch {
    // Missing or unreadable config uses the default until its file stamp changes.
  }
  if (
    dumpCache?.path === path &&
    dumpCache.mtimeMs === stamp?.mtimeMs &&
    dumpCache.ctimeMs === stamp?.ctimeMs &&
    dumpCache.size === stamp?.size
  )
    return dumpCache.enabled
  const enabled = resolveBool(
    ENV.dump,
    configDumpEnabled(readConfigFile(path)),
    false,
  )
  dumpCache = {
    path,
    mtimeMs: stamp?.mtimeMs,
    ctimeMs: stamp?.ctimeMs,
    size: stamp?.size,
    enabled,
  }
  return enabled
}

function resolve(configPath: string): ResolvedSettings {
  const config = settingsConfig(configPath)

  return {
    webSockets: resolveBool(ENV.webSockets, config.webSockets, false),
    rawWebSocket: resolveBool(ENV.rawWebSocket, config.rawWebSocket, false),
    responsesLite: resolveResponsesLite(config.responsesLite),
    dump: resolveBool(ENV.dump, configDumpEnabled(config), false),
    dumpDir:
      process.env[ENV.dumpDir]?.trim() ||
      (typeof config.dumpDir === 'string' && config.dumpDir.trim()
        ? config.dumpDir.trim()
        : join(tmpdir(), 'opencode-openai-auth-dumps')),
    dumpMaxBytes: resolveDumpMaxBytes(config.dumpMaxBytes),
    codexApiEndpoint: resolveCodexEndpoint(config.codexApiEndpoint),
  }
}

const cached = new Map<
  string,
  { shared: boolean; settings: ResolvedSettings }
>()

/**
 * Resolved settings, memoized per process.
 *
 * Commands that write settings must call `refreshSettings()` to update this
 * process's snapshot. Request dump on/off decisions use `isRequestDumpEnabled()`
 * instead, so another process's toggle is observed without refreshing unrelated
 * settings on every request.
 */
export function getSettings(configPath = getConfigPath()): ResolvedSettings {
  const identity = settingsIdentity(configPath)
  const shared = getSettingsDecision(configPath) === 'shared'
  let entry = cached.get(identity)
  if (!entry || entry.shared !== shared) {
    entry = { shared, settings: resolve(configPath) }
    cached.set(identity, entry)
  }
  return entry.settings
}

/**
 * Drop the memoized settings after a command writes the config file, so the
 * running process picks the change up without a restart.
 * Shared menus await their snapshot.refresh() before calling this synchronous
 * resolver; request readers never refresh the file themselves.
 */
export function refreshSettings(
  configPath = getConfigPath(),
): ResolvedSettings {
  cached.delete(settingsIdentity(configPath))
  dumpCache = undefined
  return getSettings(configPath)
}

/** Test-only: drop the memoized settings so a later getSettings() re-reads env + config. */
export function resetSettingsForTest(): void {
  cached.clear()
  dumpCache = undefined
  warnedDumpMaxBytes = false
}
