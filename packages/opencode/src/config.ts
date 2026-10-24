// Settings resolution for the openai-auth plugin.
//
// Two sources, env takes precedence over the config file:
//   1. Environment variables (highest priority)
//   2. Config file: ~/.config/opencode/openai-auth.json
//      (path overridable via OPENCODE_OPENAI_AUTH_FILE; config dir follows
//       OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME, mirroring anthropic-auth)
//   3. Built-in defaults (lowest priority)
//
// Resolution per setting: an explicitly-set env var wins; otherwise the config
// file value; otherwise the default.

import { readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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

function readConfigFile(): OpenAIAuthConfig {
  try {
    const parsed = JSON.parse(readFileSync(getConfigPath(), 'utf8'))
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
export function isRequestDumpEnabled(): boolean {
  const override = envBool(ENV.dump)
  if (override !== undefined) return override
  const path = getConfigPath()
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
    configDumpEnabled(readConfigFile()),
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

function resolve(): ResolvedSettings {
  const config = readConfigFile()

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

let cached: ResolvedSettings | undefined

/**
 * Resolved settings, memoized per process.
 *
 * Commands that write settings must call `refreshSettings()` to update this
 * process's snapshot. Request dump on/off decisions use `isRequestDumpEnabled()`
 * instead, so another process's toggle is observed without refreshing unrelated
 * settings on every request.
 */
export function getSettings(): ResolvedSettings {
  if (!cached) cached = resolve()
  return cached
}

/**
 * Drop the memoized settings after a command writes the config file, so the
 * running process picks the change up without a restart.
 */
export function refreshSettings(): ResolvedSettings {
  cached = undefined
  dumpCache = undefined
  return getSettings()
}

/** Test-only: drop the memoized settings so a later getSettings() re-reads env + config. */
export function resetSettingsForTest(): void {
  cached = undefined
  dumpCache = undefined
  warnedDumpMaxBytes = false
}
