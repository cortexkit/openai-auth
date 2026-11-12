import { openSettings } from '@cortexkit/common-auth/settings'
import {
  type AccountPaths,
  createLogger,
} from '@cortexkit/openai-auth-core/internal'
import {
  decideSettingsAuthority,
  type SettingsAuthorityResult,
} from '@cortexkit/openai-auth-core/settings-authority'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import {
  buildSettingsDiagnostics,
  settingsDiagnosticsSection,
} from '@cortexkit/openai-auth-core/settings-diagnostics'
import { resolveSettingsInstall } from '@cortexkit/openai-auth-core/settings-install'
import { recordPiProcessSettings } from '@cortexkit/openai-auth-core/settings-process-records'
import {
  createSettingsSnapshot,
  type SettingsSnapshot,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import packageJson from '../package.json' with { type: 'json' }
import { getPiAccountPaths } from './store-paths.ts'

export interface PiSettingsStartup {
  paths: AccountPaths
  authority?: SettingsAuthorityResult
  snapshot?: SettingsSnapshot
  refusal?: Error
  diagnostics: ReturnType<typeof settingsDiagnosticsSection>
  log: { warn(message: string): unknown; info(message: string): unknown }
}

/** Decide before constructing the runtime, which can read or change the store. */
export async function preparePiSettingsStartup(
  options: {
    paths?: AccountPaths
    version?: string
    log?: PiSettingsStartup['log']
  } = {},
): Promise<PiSettingsStartup> {
  const paths = options.paths ?? getPiAccountPaths()
  // The settings handle keeps this logger for watch-time warnings, which arrive
  // while Pi's screen is drawn, so they go to the plugin log, not the terminal.
  const log = options.log ?? createLogger('settings')
  const install = resolveSettingsInstall({ host: 'pi', paths, logger: log })
  let authority: SettingsAuthorityResult
  try {
    authority = await decideSettingsAuthority({
      install,
      log,
      record: (settings) =>
        recordPiProcessSettings({
          configPath: install.configIdentity,
          settings,
          version: options.version ?? packageJson.version,
        }),
    })
  } catch (error) {
    // Another loaded copy of the settings authority module may create the
    // refusal, so identify it by name rather than constructor identity.
    if (!(error instanceof Error) || error.name !== 'SettingsAuthorityRefusal')
      throw error
    return {
      paths,
      log,
      refusal: error,
      diagnostics: settingsDiagnosticsSection({
        configPath: paths.configPath,
        log,
      }),
    }
  }

  const snapshot =
    authority.decision === 'shared'
      ? await createSettingsSnapshot({
          handle: openSettings(openaiSettings, {
            file: authority.install.target,
            log,
            separateInstall: false,
            createMissing: true,
          }),
          file: authority.install.target,
          host: 'pi',
        })
      : undefined
  const diagnosticsOptions = {
    configPath: paths.configPath,
    ...(snapshot ? { snapshot } : {}),
    log,
  }
  await buildSettingsDiagnostics(diagnosticsOptions)
  return {
    paths,
    log,
    authority,
    ...(snapshot ? { snapshot } : {}),
    diagnostics: settingsDiagnosticsSection(diagnosticsOptions),
  }
}
