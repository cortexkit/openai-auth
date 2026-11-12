import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import {
  isAbsoluteForPlatform,
  settingsFilePath,
} from '@cortexkit/common-auth/settings'
import {
  ACCOUNT_FILE_NAME,
  ACCOUNT_STATE_FILE_NAME,
  type AccountPaths,
} from './paths.ts'

export type SettingsHost = 'opencode' | 'pi'

export interface SettingsPathOptions {
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  homedir?: () => string
}

export interface SettingsStoreSource extends AccountPaths {
  host: SettingsHost
}

export interface SettingsInstall {
  host: SettingsHost
  configIdentity: string
  target: string
  optIn: boolean
  separate: boolean
  sources: SettingsStoreSource[]
}

/**
 * Resolve aliases even before the file exists. Missing path segments are kept
 * after the nearest real ancestor, so a new store and its future path agree.
 */
export function canonicalSettingsPath(path: string): string {
  let ancestor = resolve(path)
  const remaining: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), ...remaining)
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return resolve(path)
      remaining.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/**
 * Default stores are shared move sources, not either host's overridden stores.
 * Only generic environment variables are read here, including when Pi calls it.
 */
export function resolveDefaultSettingsStores(
  options: SettingsPathOptions = {},
): [SettingsStoreSource, SettingsStoreSource] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = (options.homedir ?? homedir)()
  const paths = platform === 'win32' ? win32 : posix
  const configHome = env.XDG_CONFIG_HOME
  const configDir = paths.join(
    configHome && isAbsoluteForPlatform(configHome, platform)
      ? configHome
      : paths.join(home, '.config'),
    'opencode',
  )
  const homeConfigDir = paths.join(home, '.config', 'opencode')
  // OpenCode's runtimeLayoutLocation in core/account-paths.ts hashes the real
  // config folder path, or its resolved path when missing. Use the same key
  // here so a caller on either host finds the marker OpenCode wrote.
  const folderIdentity = (path: string) => {
    try {
      return realpathSync.native(path)
    } catch {
      return resolve(path)
    }
  }
  const key = folderIdentity(configDir)
  const runtimeDir = paths.join(
    env.XDG_STATE_HOME || paths.join(home, '.local', 'state'),
    'cortexkit',
    'openai-auth',
    key === folderIdentity(homeConfigDir)
      ? 'opencode'
      : `opencode-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
  )
  const stateDir = existsSync(paths.join(runtimeDir, 'layout.json'))
    ? runtimeDir
    : configDir
  const piDir = paths.join(home, '.pi', 'agent')
  return [
    {
      host: 'opencode',
      configPath: paths.join(configDir, ACCOUNT_FILE_NAME),
      statePath: paths.join(stateDir, ACCOUNT_STATE_FILE_NAME),
    },
    {
      host: 'pi',
      configPath: paths.join(piDir, ACCOUNT_FILE_NAME),
      statePath: paths.join(piDir, ACCOUNT_STATE_FILE_NAME),
    },
  ]
}

export interface SettingsInstallOptions extends SettingsPathOptions {
  host: SettingsHost
  /** Already resolved by the host, including its store overrides and fallback. */
  paths: AccountPaths
  logger?: { warn(message: string): unknown }
}

export function resolveSettingsInstall(
  options: SettingsInstallOptions,
): SettingsInstall {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.homedir ?? homedir
  const defaults = resolveDefaultSettingsStores({
    env,
    platform,
    homedir: home,
  })
  const ownDefault = defaults[options.host === 'opencode' ? 0 : 1]
  const configIdentity = canonicalSettingsPath(options.paths.configPath)
  const customConfig =
    configIdentity !== canonicalSettingsPath(ownDefault.configPath)
  const variable =
    options.host === 'opencode'
      ? 'OPENCODE_OPENAI_AUTH_SETTINGS_FILE'
      : 'PI_OPENAI_AUTH_SETTINGS_FILE'
  const requested = env[variable]
  let optInPath =
    requested !== undefined && isAbsoluteForPlatform(requested, platform)
      ? requested
      : undefined
  if (optInPath !== undefined) {
    const identity = canonicalSettingsPath(optInPath)
    const stores = [options.paths, ...defaults]
    if (
      stores.some(
        (store) =>
          canonicalSettingsPath(store.configPath) === identity ||
          canonicalSettingsPath(store.statePath) === identity,
      )
    ) {
      optInPath = undefined
      const logger = options.logger ?? console
      logger.warn(
        `openai-auth ignored ${variable}: the settings file must not be an account config or state file.`,
      )
    }
  }
  const optIn = optInPath !== undefined
  const separate = !optIn && customConfig
  return {
    host: options.host,
    configIdentity,
    target:
      optInPath ??
      settingsFilePath({
        plugin: 'openai-auth',
        env,
        platform,
        homedir: home(),
      }),
    optIn,
    separate,
    sources: separate
      ? []
      : optIn
        ? customConfig
          ? [{ host: options.host, ...options.paths }]
          : []
        : defaults.map((source) =>
            source.host === options.host
              ? { host: options.host, ...options.paths }
              : source,
          ),
  }
}
