import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  getPiAccountPaths as accountPaths,
  getPiAccountStatePath as statePath,
  getPiAccountStoragePath as storagePath,
} from './store-paths'

export function getPiConfigDir(): string {
  return getAgentDir()
}

export function getPiAccountStoragePath(): string {
  return storagePath(getPiConfigDir())
}

export function getPiAccountStatePath(
  configPath = getPiAccountStoragePath(),
): string {
  return statePath(configPath)
}

export function getPiAccountPaths(
  configPath = getPiAccountStoragePath(),
): AccountPaths {
  return accountPaths(configPath)
}
