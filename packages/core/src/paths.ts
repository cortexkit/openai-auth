/**
 * Pure path values shared by every host.
 *
 * Nothing here reads an environment variable or knows where a host keeps its
 * configuration. A host resolves its own two file paths and hands them to the
 * store as an `AccountPaths`; the only thing that must not drift between hosts
 * is the file name itself, which is why the constants live here rather than in
 * each host's own resolver.
 */

import { basename, dirname, join } from 'node:path'

export const ACCOUNT_FILE_NAME = 'openai-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'openai-auth-state.json'

/**
 * The config file and the runtime-state file a store operation reads and writes.
 *
 * Both are required. A store function never derives one from the other, because
 * a host may point its state file somewhere the derivation would not reach and
 * a silently derived path would lock one file while writing another.
 */
export interface AccountPaths {
  configPath: string
  statePath: string
}

/** Derive the state-file path from the config path without reading env vars. */
export function deriveStatePath(configPath: string): string {
  return basename(configPath) === ACCOUNT_FILE_NAME
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
}
