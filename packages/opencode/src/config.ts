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

import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CODEX_API_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'

/** Shape of ~/.config/opencode/openai-auth.json (all fields optional). */
export interface OpenAIAuthConfig {
  /** Inject the native web_search tool to keep the Codex prompt cache stable. Default true. */
  webSearch?: boolean
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
  /** Codex-compatible Responses endpoint. Defaults to ChatGPT's Codex backend. */
  codexApiEndpoint?: string
}

export interface ResolvedSettings {
  webSearch: boolean
  webSockets: boolean
  rawWebSocket: boolean
  responsesLite: boolean
  dump: boolean
  dumpDir: string
  codexApiEndpoint: string
}

const CONFIG_FILE_NAME = 'openai-auth.json'

const ENV = {
  // Negative for back-compat: presence disables the (default-on) web_search cache fix.
  noWebSearch: 'CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH',
  webSockets: 'CORTEXKIT_OPENAI_AUTH_WEBSOCKETS',
  rawWebSocket: 'CORTEXKIT_OPENAI_AUTH_RAW_WS',
  responsesLite: 'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
  dump: 'CORTEXKIT_OPENAI_AUTH_DUMP',
  dumpDir: 'OPENCODE_OPENAI_AUTH_DUMP_DIR',
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

function resolve(): ResolvedSettings {
  const config = readConfigFile()
  // web_search is default-on and gated by a NEGATIVE env (NO_WEB_SEARCH). If that env is
  // explicitly set it always wins; otherwise the positive config field, otherwise default true.
  const noWebSearchEnv = envBool(ENV.noWebSearch)
  const webSearch =
    noWebSearchEnv !== undefined
      ? !noWebSearchEnv
      : typeof config.webSearch === 'boolean'
        ? config.webSearch
        : true

  let dumpConfig: boolean | undefined
  if (config.dump !== undefined && config.dump !== null) {
    if (typeof config.dump === 'object') {
      dumpConfig = config.dump.enabled
    } else if (typeof config.dump === 'boolean') {
      dumpConfig = config.dump
    }
  }

  return {
    webSearch,
    webSockets: resolveBool(ENV.webSockets, config.webSockets, false),
    rawWebSocket: resolveBool(ENV.rawWebSocket, config.rawWebSocket, false),
    responsesLite: resolveBool(ENV.responsesLite, config.responsesLite, false),
    dump: resolveBool(ENV.dump, dumpConfig, false),
    dumpDir:
      process.env[ENV.dumpDir]?.trim() ||
      (typeof config.dumpDir === 'string' && config.dumpDir.trim()
        ? config.dumpDir.trim()
        : join(tmpdir(), 'opencode-openai-auth-dumps')),
    codexApiEndpoint:
      process.env[ENV.codexApiEndpoint]?.trim() ||
      (typeof config.codexApiEndpoint === 'string' &&
      config.codexApiEndpoint.trim()
        ? config.codexApiEndpoint.trim()
        : DEFAULT_CODEX_API_ENDPOINT),
  }
}

let cached: ResolvedSettings | undefined

/** Resolved settings, computed once per process (env + config are process-static). */
export function getSettings(): ResolvedSettings {
  if (!cached) cached = resolve()
  return cached
}

/** Test-only: drop the memoized settings so a later getSettings() re-reads env + config. */
export function resetSettingsForTest(): void {
  cached = undefined
}
