import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  ACCOUNT_FILE_NAME,
  type AccountPaths,
  deriveStatePath,
} from '@cortexkit/openai-auth-core/internal'

export function getPiConfigDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
}

export function getPiAccountStoragePath(): string {
  return (
    process.env.PI_OPENAI_AUTH_FILE?.trim() ||
    join(getPiConfigDir(), ACCOUNT_FILE_NAME)
  )
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
