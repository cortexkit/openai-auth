import { openSettings } from '@cortexkit/common-auth/settings'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import {
  decideSettingsAuthority,
  type SettingsAuthorityResult,
} from '@cortexkit/openai-auth-core/settings-authority'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import { resolveSettingsInstall } from '@cortexkit/openai-auth-core/settings-install'
import {
  createSettingsSnapshot,
  type OpenAiSettingsHandle,
  type SettingsSnapshot,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import { applySettingsLogLevel, createLogger } from '../logger.ts'
import { getAccountPaths } from './account-paths.ts'
import { recordProcessSettings } from './process-heartbeat.ts'

export interface SettingsStartup {
  authority: SettingsAuthorityResult
  /** Present only for shared authority; updates may create a missing file. */
  handle?: OpenAiSettingsHandle
  /** Present only for shared authority. The plugin instance owns its disposal. */
  snapshot?: SettingsSnapshot
}

/**
 * Both plugin generations await this after prepareRuntimeLayout, before their
 * first preference read. Core fixes one authority decision per config file for
 * the process lifetime, including a legacy decision that could not move yet.
 * A required record failure rejects with SettingsAuthorityRefusal (folder and
 * cause); no shared handle or plugin hooks may be opened after that refusal.
 *
 * Shared instances each own a snapshot/watch. Startup applies a saved concrete
 * log level only; refreshes also clear a removed/default level's runtime override
 * so the logger returns to the environment level, or info. Legacy and separate
 * callers keep loading their old store's log level at startup as before.
 */
export async function prepareSettingsStartup(options: {
  version: string
  paths?: AccountPaths
  log?: {
    warn(message: string): unknown
    info(message: string): unknown
  }
}): Promise<SettingsStartup> {
  const log = options.log ?? createLogger('settings')
  const install = resolveSettingsInstall({
    host: 'opencode',
    paths: options.paths ?? getAccountPaths(),
    logger: log,
  })
  const authority = await decideSettingsAuthority({
    install,
    log,
    record: (settings) =>
      recordProcessSettings({
        configPath: install.configIdentity,
        settings,
        version: options.version,
      }),
  })
  if (authority.decision !== 'shared') return { authority }

  const handle = openSettings(openaiSettings, {
    file: authority.install.target,
    log,
    separateInstall: false,
    createMissing: true,
  })
  const snapshot = await createSettingsSnapshot({
    handle,
    file: authority.install.target,
    host: 'opencode',
  })
  applySettingsLogLevel(snapshot.get('log_level'), 'startup')
  snapshot.onChange(() => {
    applySettingsLogLevel(snapshot.get('log_level'), 'refresh')
  })
  return { authority, handle, snapshot }
}
