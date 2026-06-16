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

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Shape of ~/.config/opencode/openai-auth.json (all fields optional). */
export interface OpenAIAuthConfig {
  /** Inject the native web_search tool to keep the Codex prompt cache stable. Default true. */
  webSearch?: boolean
  /** Use the WebSocket transport for /responses instead of plain HTTP. Default false. */
  webSockets?: boolean
  /** Use the hand-rolled Bun.connect WebSocket client (incremental streaming). Default false. */
  rawWebSocket?: boolean
  /** Declare the native image_generation tool. Default false. */
  imageGeneration?: boolean
}

export interface ResolvedSettings {
  webSearch: boolean
  webSockets: boolean
  rawWebSocket: boolean
  imageGeneration: boolean
}

const CONFIG_FILE_NAME = "openai-auth.json"

const ENV = {
  // Negative for back-compat: presence disables the (default-on) web_search cache fix.
  noWebSearch: "CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH",
  webSockets: "CORTEXKIT_OPENAI_AUTH_WEBSOCKETS",
  rawWebSocket: "CORTEXKIT_OPENAI_AUTH_RAW_WS",
  imageGeneration: "CORTEXKIT_OPENAI_AUTH_IMAGE_GENERATION",
  configFile: "OPENCODE_OPENAI_AUTH_FILE",
  configDir: "OPENCODE_CONFIG_DIR",
} as const

function getConfigDir(): string {
  if (process.env[ENV.configDir]?.trim()) return process.env[ENV.configDir]!.trim()
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

export function getConfigPath(): string {
  return process.env[ENV.configFile]?.trim() || join(getConfigDir(), CONFIG_FILE_NAME)
}

function readConfigFile(): OpenAIAuthConfig {
  try {
    const parsed = JSON.parse(readFileSync(getConfigPath(), "utf8"))
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
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
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false
  return true
}

/** env (if explicitly set) overrides config (if set) overrides default. */
function resolveBool(envName: string, configValue: boolean | undefined, def: boolean): boolean {
  const fromEnv = envBool(envName)
  if (fromEnv !== undefined) return fromEnv
  if (typeof configValue === "boolean") return configValue
  return def
}

function resolve(): ResolvedSettings {
  const config = readConfigFile()
  // web_search is default-on and gated by a NEGATIVE env (NO_WEB_SEARCH). If that env is
  // explicitly set it always wins; otherwise the positive config field, otherwise default true.
  const noWebSearchEnv = envBool(ENV.noWebSearch)
  const webSearch =
    noWebSearchEnv !== undefined ? !noWebSearchEnv : typeof config.webSearch === "boolean" ? config.webSearch : true
  return {
    webSearch,
    webSockets: resolveBool(ENV.webSockets, config.webSockets, false),
    rawWebSocket: resolveBool(ENV.rawWebSocket, config.rawWebSocket, false),
    imageGeneration: resolveBool(ENV.imageGeneration, config.imageGeneration, false),
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
