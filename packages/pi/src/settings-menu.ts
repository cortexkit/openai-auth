import {
  CommandError,
  type PluginSection,
} from '@cortexkit/common-auth/commands'
import { openSettings, SettingsRefusal } from '@cortexkit/common-auth/settings'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import { settingsRefusalText } from '@cortexkit/openai-auth-core/settings-diagnostics'
import type { PiSettingsStartup } from './settings-startup.ts'

const controlsUnavailable = 'Controls require a shared settings file.'
const warmLine = (enabled: boolean) =>
  `Saved keep-warm preference: ${enabled ? 'on' : 'off'}.`
const appliesWhenAvailable = (feature: string) =>
  `This preference applies when ${feature} is available on this install.`

export function piSettingsSections(startup: PiSettingsStartup): {
  cache: PluginSection
  diagnostics: PluginSection
} {
  const { authority, snapshot, log, diagnostics } = startup
  const declarations = openaiSettings.settings
  if (authority?.decision !== 'shared' || !snapshot) {
    return {
      cache: {
        title: 'Cache',
        build: () => ({
          lines: [
            warmLine(declarations.cache_keep_enabled.default),
            controlsUnavailable,
          ],
        }),
      },
      diagnostics: {
        ...diagnostics,
        async build() {
          const view = await diagnostics.build()
          return { ...view, lines: [...view.lines, controlsUnavailable] }
        },
      },
    }
  }

  const writer = openSettings(openaiSettings, {
    file: authority.install.target,
    log,
    separateInstall: false,
    createMissing: true,
  })
  const write = async (
    setting: 'cache_keep_enabled' | 'request_dumps' | 'log_level',
    value: unknown,
  ) => {
    try {
      await writer.update([{ setting, value, level: 'pi' }], { host: 'pi' })
      await snapshot.refresh()
    } catch (error) {
      if (error instanceof SettingsRefusal)
        throw new CommandError(error.code, settingsRefusalText(error.code))
      throw error
    }
  }

  return {
    cache: {
      title: 'Cache',
      async build() {
        await snapshot.refresh()
        const enabled = snapshot.get('cache_keep_enabled')
        return {
          lines: [warmLine(enabled)],
          actions: [
            {
              id: 'enabled',
              label: `Set keep-warm preference ${enabled ? 'off' : 'on'}`,
              description: appliesWhenAvailable('keep-warm'),
              knobs: [
                {
                  kind: 'toggle',
                  id: 'enabled',
                  label: 'Keep-warm',
                  value: !enabled,
                },
              ],
              async run({ values }) {
                const on = values.enabled === true
                await write('cache_keep_enabled', on)
                return warmLine(on)
              },
            },
          ],
        }
      },
    },
    diagnostics: {
      ...diagnostics,
      async build() {
        const view = await diagnostics.build()
        const dumping = snapshot.get('request_dumps')
        return {
          ...view,
          actions: [
            {
              id: 'dump',
              label: `Set request dump preference ${dumping ? 'off' : 'on'}`,
              description: `${appliesWhenAvailable('request dumping')} Body dumps may contain prompt and session content.`,
              knobs: [
                {
                  kind: 'toggle',
                  id: 'enabled',
                  label: 'Request dumps',
                  value: !dumping,
                },
              ],
              async run({ values }) {
                const on = values.enabled === true
                await write('request_dumps', on)
                return `Saved request dump preference: ${on ? 'on' : 'off'}.`
              },
            },
            {
              id: 'logging',
              label: 'Set the log level preference',
              description: appliesWhenAvailable('log-level control'),
              knobs: [
                {
                  kind: 'choice',
                  id: 'level',
                  label: 'Level',
                  choices: declarations.log_level.value.values.map((value) => ({
                    value,
                    label: value,
                  })),
                  value: snapshot.get('log_level'),
                },
              ],
              async run({ values }) {
                await write('log_level', values.level)
                return `Saved log level preference: ${values.level}.`
              },
            },
          ],
        }
      },
    },
  }
}
