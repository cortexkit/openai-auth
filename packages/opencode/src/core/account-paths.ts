import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  ACCOUNT_FILE_NAME,
  ACCOUNT_STATE_FILE_NAME,
  type AccountPaths,
  deriveStatePath,
} from '@cortexkit/openai-auth-core/internal'

/**
 * Where OpenCode's account store lives.
 *
 * This is the ONLY definition of this host's resolution rules. The store code
 * itself takes both paths as arguments and resolves nothing, so the lock and
 * the write it guards can never disagree about which file they mean — a
 * disagreement would lose mutual exclusion on a file holding credentials while
 * every test still passed, since each side works on its own.
 *
 * The file names come from the core so the two hosts cannot drift apart on what
 * the store is called.
 */

export type { AccountPaths }
export { ACCOUNT_FILE_NAME, ACCOUNT_STATE_FILE_NAME, deriveStatePath }

export function fallbackRefreshLockName(accountId: string) {
  return `fallback-oauth-refresh-${createHash('sha256')
    .update(accountId)
    .digest('base64url')
    .slice(0, 16)}`
}

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
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
  return deriveStatePath(configPath)
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
