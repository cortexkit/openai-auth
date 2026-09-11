import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Where the account store lives.
 *
 * This is the ONLY definition. It used to be duplicated verbatim in both
 * `accounts.ts` and `refresh-file-lock.ts`, because `accounts.ts` imports the
 * lock and the reverse import would have been a cycle. Two copies of a path
 * resolver is a bad trade for that: the lock and the write must agree on the
 * exact file, and if the copies ever drifted, a writer would take a lock on one
 * path while writing another — mutual exclusion silently lost on a file holding
 * credentials. Nothing would fail a test, since each copy works on its own.
 *
 * This module imports nothing from either side, so both can depend on it.
 */

export const ACCOUNT_FILE_NAME = 'openai-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'openai-auth-state.json'

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

/** Derive the state-file path from the config path without reading env vars. */
export function deriveStatePath(configPath: string): string {
  return basename(configPath) === ACCOUNT_FILE_NAME
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
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
