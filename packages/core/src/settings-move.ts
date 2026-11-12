import {
  type MoveResult,
  type MoveSource,
  moveSettingsOnce,
} from '@cortexkit/common-auth/settings'
import { openaiSettings } from './settings-definition.js'
import type { SettingsHost, SettingsInstall } from './settings-install.js'
import { mapSettings, readSettingsSource } from './settings-map.js'

export type SettingsMoveFailure =
  | { kind: 'setting'; setting: string }
  | { kind: 'cause'; host: SettingsHost; path: string; code: string }
  | { kind: 'cause'; code: string }

export interface SettingsMoveResult extends MoveResult {
  failure?: SettingsMoveFailure
}

export interface SettingsMoveOptions {
  install: SettingsInstall
  fence(): boolean | Promise<boolean>
  log?: { warn(message: string): unknown }
}

class SourceReadError extends Error {
  constructor(
    readonly host: SettingsHost,
    readonly path: string,
    readonly code: string,
  ) {
    super(`Settings source ${host} ${path}: ${code}`)
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)
    ? code
    : 'SETTINGS_MOVE_FAILED'
}

function classifyFailure(
  cause: unknown,
  sources: readonly MoveSource[],
): SettingsMoveFailure {
  if (cause instanceof SourceReadError) {
    return {
      kind: 'cause',
      host: cause.host,
      path: cause.path,
      code: cause.code,
    }
  }
  // Only the mapper's fixed error shape can supply a setting name. Arbitrary
  // exception messages may contain source text or credentials and stay private.
  const setting =
    cause instanceof Error
      ? /^Cannot move setting ([a-zA-Z_][a-zA-Z0-9_]*)(?: \([a-zA-Z0-9_.]+\))?$/.exec(
          cause.message,
        )?.[1]
      : undefined
  if (setting) return { kind: 'setting', setting }
  const path = (cause as { path?: unknown } | null)?.path
  const source = sources.find((source) => source.path === path)
  const code = errorCode(cause)
  if (source) {
    return {
      kind: 'cause',
      host: source.host as SettingsHost,
      path: source.path,
      code,
    }
  }
  return { kind: 'cause', code }
}

/**
 * Startup calls this only for a present source and an incomplete move, while
 * holding the shared settings-authority lock that orders startup decisions.
 * The runner takes no outer lock or store API:
 * common-auth locks the target, then each store's config and state save paths.
 * Separate installs and opt-ins with no eligible source never call the mover.
 */
export async function runSettingsMove({
  install,
  fence,
  log = console,
}: SettingsMoveOptions): Promise<SettingsMoveResult | undefined> {
  if (install.separate || install.sources.length === 0) return undefined
  const sources: MoveSource[] = [...install.sources]
    .sort((a, b) => Number(a.host === 'pi') - Number(b.host === 'pi'))
    .map((source) => ({
      host: source.host,
      path: source.configPath,
      locks: [
        { path: source.configPath, name: 'save' },
        { path: source.statePath, name: 'save' },
      ],
      read(text) {
        try {
          return readSettingsSource(text)
        } catch (error) {
          throw new SourceReadError(
            source.host,
            source.configPath,
            error instanceof Error &&
              error.message === 'Settings source is not JSON'
              ? 'SOURCE_NOT_JSON'
              : 'SOURCE_NOT_OBJECT',
          )
        }
      },
    }))
  const result: SettingsMoveResult = await moveSettingsOnce({
    definition: openaiSettings,
    target: install.target,
    separateInstall: false,
    sources,
    map: mapSettings,
    fence,
    // common-auth's difference reports can include values. Report only the
    // metadata below, once, rather than forwarding its unrestricted logger.
    log: { warn() {}, info() {} },
  })
  for (const entry of result.unmapped) {
    log.warn(
      `Settings move: ${sources[entry.source]?.host ?? 'unknown'} ${entry.key}: ${entry.reason}`,
    )
  }
  for (const entry of result.noteFailures) {
    const source = sources.find(
      (source) => `${source.path}.MOVED_READPLEASE` === entry.path,
    )
    log.warn(
      `Settings move note: ${source?.host ?? 'unknown'} ${entry.path}: ${errorCode(entry.error)}`,
    )
  }
  if (result.outcome === 'failed') {
    result.failure = classifyFailure(result.cause, sources)
    const failure = result.failure
    log.warn(
      failure.kind === 'setting'
        ? `Settings move failed: cannot move setting ${failure.setting}`
        : 'host' in failure
          ? `Settings move failed: ${failure.host} ${failure.path}: ${failure.code}`
          : `Settings move failed: ${failure.code}`,
    )
  }
  return result
}
