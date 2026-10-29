import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACCOUNT_FILE_NAME,
  type AccountPaths,
  deriveStatePath,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'

const legacyNotices = new Set<string>()

/** Setup runs without Pi installed; parity tests keep this resolver aligned with Pi. */
export function resolvePiAgentDir(): string {
  let dir = process.env.PI_CODING_AGENT_DIR
  if (!dir) return join(homedir(), '.pi', 'agent')
  if (
    process.platform === 'win32' &&
    dir.startsWith('/') &&
    !dir.startsWith('//') &&
    !dir.includes('\\')
  ) {
    const match = dir.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
    if (match?.[1])
      dir = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`
  }
  if (dir === '~') return homedir()
  if (
    dir.startsWith('~/') ||
    (process.platform === 'win32' && dir.startsWith('~\\'))
  )
    return join(homedir(), dir.slice(2))
  return dir.startsWith('file://') ? fileURLToPath(dir) : dir
}

export function getPiAccountStoragePath(
  agentDir = resolvePiAgentDir(),
): string {
  const override = process.env.PI_OPENAI_AUTH_FILE?.trim()
  if (override) return override
  const current = join(agentDir, ACCOUNT_FILE_NAME)
  const legacy = join(homedir(), '.pi', 'agent', ACCOUNT_FILE_NAME)
  // A vault-only install can have enrollment records but no local account files.
  // A roster alone is cached data, not evidence that this host is enrolled.
  const hasStore = (path: string) => {
    const state = deriveStatePath(path)
    const vault = vaultPaths(vaultStateDir(state), 'pi')
    return (
      existsSync(path) ||
      existsSync(state) ||
      existsSync(vault.tokenPath) ||
      existsSync(vault.statePath)
    )
  }
  if (
    resolve(current) === resolve(legacy) ||
    hasStore(current) ||
    !hasStore(legacy)
  )
    return current
  const key = `${current}\0${legacy}`
  if (!legacyNotices.has(key)) {
    legacyNotices.add(key)
    // Pi has no file logger at extension startup; stderr also works in headless mode.
    console.warn(
      `openai-auth is using its store in the legacy Pi agent directory: ${legacy} (${current} has no store). Credentials were not copied or moved. Set PI_OPENAI_AUTH_FILE to choose a store explicitly.`,
    )
  }
  return legacy
}

export function getPiAccountStatePath(
  configPath = getPiAccountStoragePath(),
): string {
  return (
    process.env.PI_OPENAI_AUTH_STATE_FILE?.trim() || deriveStatePath(configPath)
  )
}

export function getPiAccountPaths(
  configPath = getPiAccountStoragePath(),
): AccountPaths {
  return { configPath, statePath: getPiAccountStatePath(configPath) }
}
