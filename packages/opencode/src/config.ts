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
  KILLSWITCH_FLOORS_SCHEMA,
} from '@cortexkit/openai-auth-core/internal'
import { getSettingsDecision } from '@cortexkit/openai-auth-core/settings-decisions'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import { canonicalSettingsPath } from '@cortexkit/openai-auth-core/settings-install'
import type {
  SettingsSnapshot,
  SettingsView,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import { createLogger } from './logger'

export const DEFAULT_CODEX_API_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'
export const DEFAULT_DUMP_MAX_BYTES = 512 * 1024 * 1024

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
  responsesLite: 'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
  dump: 'CORTEXKIT_OPENAI_AUTH_DUMP',
  dumpDir: 'OPENCODE_OPENAI_AUTH_DUMP_DIR',
  dumpMaxBytes: 'OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES',
  codexApiEndpoint: 'CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT',
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
const warningsKey = Symbol.for(
  '@cortexkit/openai-auth/opencode-settings-snapshot-warnings',
)
const processState = globalThis as typeof globalThis & {
  [snapshotsKey]?: Map<string, Set<SettingsSnapshot>>
  [warningsKey]?: Set<string>
}
const snapshots =
  processState[snapshotsKey] ?? new Map<string, Set<SettingsSnapshot>>()
processState[snapshotsKey] = snapshots
const warnedMissingSnapshot = processState[warningsKey] ?? new Set<string>()
processState[warningsKey] = warnedMissingSnapshot

/** Register after startup; unregister before disposing this instance's snapshot. */
export function registerSettingsSnapshot(
  configPath: string,
  snapshot: SettingsSnapshot,
): () => void {
  const identity = canonicalSettingsPath(configPath)
  const live = snapshots.get(identity) ?? new Set<SettingsSnapshot>()
  if (live.size === 0) cached.delete(identity)
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
      cached.delete(identity)
    }
  }
}

function sharedSnapshot(configPath: string): SettingsSnapshot | undefined {
  const identity = canonicalSettingsPath(configPath)
  const live = snapshots.get(identity)
  let latest: SettingsSnapshot | undefined
  for (const snapshot of live ?? []) latest = snapshot
  if (!latest && !warnedMissingSnapshot.has(identity)) {
    warnedMissingSnapshot.add(identity)
    log.warn(
      'Shared settings snapshot is not registered; using declared defaults',
      {
        configPath: identity,
      },
    )
  }
  return latest
}

/** Without a registered shared snapshot, ignore the account store's obsolete preferences. */
function defaultSettingsView(store: AccountStorage | null): SettingsView {
  const d = openaiSettings.settings
  return {
    version: 1,
    accounts: store?.accounts ?? [],
    main: store?.main,
    routing: {
      mode: d.routing_mode.default,
      maxSameAccountWait: ({ off: 0, '15m': 15, cache: 'max' } as const)[
        d.max_same_account_wait.default
      ],
    },
    fallbackOn: [...d.fallback_on.default],
    refresh: {
      enabled: d.refresh_enabled.default,
      refreshBeforeExpiryMinutes: d.refresh_before_expiry_minutes.default,
      mainLastRefreshError: store?.refresh?.mainLastRefreshError,
      mainRefreshLeaseId: store?.refresh?.mainRefreshLeaseId,
      mainRefreshLeaseUntil: store?.refresh?.mainRefreshLeaseUntil,
      mainRefreshLeaseTokenHash: store?.refresh?.mainRefreshLeaseTokenHash,
    },
    quota: {
      enabled: d.quota_enabled.default,
      checkIntervalMinutes: d.quota_check_interval_minutes.default,
      minimumRemaining: {},
      failClosedOnUnknownQuota: d.quota_fail_closed_on_unknown.default,
      mainQuota: store?.quota?.mainQuota,
      mainQuotaCheckedAt: store?.quota?.mainQuotaCheckedAt,
      mainQuotaToken: store?.quota?.mainQuotaToken,
      mainLastQuotaApiError: store?.quota?.mainLastQuotaApiError,
    },
    killswitch: {
      schema: KILLSWITCH_FLOORS_SCHEMA,
      enabled: d.killswitch_enabled.default,
      defaults: {
        primary: d.killswitch_default_primary.default,
        secondary: d.killswitch_default_secondary.default,
      },
      accounts: {},
    },
    costZeroing: { enabled: d.cost_zeroing.default },
    logging: {},
    cacheKeep: {
      enabled: d.cache_keep_enabled.default,
      subagents: d.cache_keep_subagents.default,
      sustain: d.cache_keep_sustain.default,
    },
    dump: { enabled: d.request_dumps.default },
    dumpDir: d.dump_dir.default,
    dumpMaxBytes: d.dump_max_bytes.default,
    webSockets: d.web_sockets.default,
    rawWebSocket: d.raw_web_socket.default,
    responsesLite: d.responses_lite.default,
    codexApiEndpoint: d.codex_api_endpoint.default,
  }
}

/** Memory only for shared installs. A non-null view is not proof a store exists. */
export function getResolvedSettingsView(
  store: AccountStorage | null,
  configPath = getConfigPath(),
): AccountStorage {
  if (getSettingsDecision(configPath) !== 'shared')
    return store ?? { version: 1, accounts: [] }
  return sharedSnapshot(configPath)?.view(store) ?? defaultSettingsView(store)
}

function settingsConfig(configPath: string): OpenAIAuthConfig {
  if (getSettingsDecision(configPath) !== 'shared')
    return readConfigFile(configPath)
  return sharedSnapshot(configPath)?.view() ?? defaultSettingsView(null)
}

/** Parse an env var as a boolean. undefined => not set (defer to config). */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
    return true
  }
  if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') {
    return false
  }
  return undefined
}

/** env (if explicitly set) overrides config (if set) overrides default. */
function resolveBool(
  envName: string,
  configValue: boolean | undefined,
  def: boolean,
): boolean {
  const fromEnv = envBool(envName)
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
  const override = envBool(ENV.dump)
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
    responsesLite: resolveBool(ENV.responsesLite, config.responsesLite, false),
    dump: resolveBool(ENV.dump, configDumpEnabled(config), false),
    dumpDir:
      process.env[ENV.dumpDir]?.trim() ||
      (typeof config.dumpDir === 'string' && config.dumpDir.trim()
        ? config.dumpDir.trim()
        : join(tmpdir(), 'opencode-openai-auth-dumps')),
    dumpMaxBytes: resolveDumpMaxBytes(config.dumpMaxBytes),
    codexApiEndpoint:
      process.env[ENV.codexApiEndpoint]?.trim() ||
      (typeof config.codexApiEndpoint === 'string' &&
      config.codexApiEndpoint.trim()
        ? config.codexApiEndpoint.trim()
        : DEFAULT_CODEX_API_ENDPOINT),
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
  const identity = canonicalSettingsPath(configPath)
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
  cached.delete(canonicalSettingsPath(configPath))
  dumpCache = undefined
  return getSettings(configPath)
}

/** Test-only: drop the memoized settings so a later getSettings() re-reads env + config. */
export function resetSettingsForTest(): void {
  cached.clear()
  dumpCache = undefined
  warnedDumpMaxBytes = false
}
