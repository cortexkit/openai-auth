import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'
import {
  inspectSettingsCompletion,
  type SettingsCompletion,
} from './settings-completion.js'
import {
  recordSettingsDecision,
  type SettingsDecision,
} from './settings-decisions.js'
import {
  canonicalSettingsPath,
  type SettingsInstall,
} from './settings-install.js'
import { runSettingsMove, type SettingsMoveResult } from './settings-move.js'
import {
  type SettingsFenceOptions,
  type SettingsFenceResult,
  settingsFenceOpen,
  settingsProcessRoot,
} from './settings-process-records.js'

export interface SettingsAuthorityResult {
  decision: SettingsDecision
  install: SettingsInstall
  completion?: SettingsCompletion
  fence?: SettingsFenceResult
  ranMove: boolean
  move?: SettingsMoveResult
}

export interface SettingsAuthorityOptions {
  install: SettingsInstall
  stateHome?: string
  /** Publish the host's record even when its periodic heartbeat is disabled. */
  record(settings: SettingsDecision): Promise<unknown>
  log: { warn(message: string): unknown }
  fenceOptions?: Omit<SettingsFenceOptions, 'stateHome'>
}

export class SettingsAuthorityRefusal extends Error {
  constructor(
    readonly folder: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Cannot record settings authority in ${folder}: ${detail}`, { cause })
    this.name = 'SettingsAuthorityRefusal'
  }
}

// Plugin generations can load different copies of core. Pending decisions must
// be shared too, so two instances cannot both start a move or publish a record.
const authorityKey = Symbol.for('@cortexkit/openai-auth/settings-authority')
const processState = globalThis as typeof globalThis & {
  [authorityKey]?: Map<string, Promise<SettingsAuthorityResult>>
}
const authorities = processState[authorityKey] ?? new Map()
processState[authorityKey] = authorities

/** Return the startup details without probing a file or changing the decision. */
export function getSettingsAuthority(
  configPath: string,
): Promise<SettingsAuthorityResult> | undefined {
  return authorities.get(canonicalSettingsPath(configPath))
}

/**
 * Call only at startup, before reading preferences and before taking any lock.
 * The records-root lock orders every target's fence scan and publication with
 * every legacy record, including installs that share only one source store.
 */
export function decideSettingsAuthority(
  options: SettingsAuthorityOptions,
): Promise<SettingsAuthorityResult> {
  const identity = canonicalSettingsPath(options.install.configIdentity)
  const existing = authorities.get(identity)
  if (existing) return existing
  const pending = Promise.resolve().then(() => decide(options))
  authorities.set(identity, pending)
  return pending
}

async function decide({
  install,
  stateHome,
  record,
  log,
  fenceOptions,
}: SettingsAuthorityOptions): Promise<SettingsAuthorityResult> {
  const result: SettingsAuthorityResult = {
    decision: install.separate ? 'separate' : 'shared',
    install,
    ranMove: false,
  }
  const finish = () => {
    recordSettingsDecision(install.configIdentity, result.decision)
    return result
  }
  if (install.separate) {
    // A separate install cannot put another process's move at risk.
    try {
      await record('separate')
    } catch {}
    return finish()
  }

  const folder = settingsProcessRoot(stateHome)
  const inspect = () => {
    result.completion = inspectSettingsCompletion(install)
    return result.completion
  }
  const safeWithoutRecord = (completion: SettingsCompletion) =>
    completion.completed || !completion.sourcePresent
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o700)
    await withLock(
      join(folder, 'settings-authority'),
      { name: 'settings-authority', ...POOL_LOCK_DEFAULTS },
      async (lock) => {
        if (!safeWithoutRecord(inspect())) {
          result.fence = await settingsFenceOpen({ ...fenceOptions, stateHome })
          if (result.fence.open) {
            result.ranMove = true
            try {
              result.move = await runSettingsMove({
                install,
                log,
                async fence() {
                  const fence = await settingsFenceOpen({
                    ...fenceOptions,
                    stateHome,
                  })
                  if (!fence.open) result.fence = fence
                  return fence.open
                },
              })
            } catch (cause) {
              // Move failures keep the old store; only an inability to publish
              // that choice refuses startup. Keep the cause for Diagnostics.
              result.move = {
                outcome: 'failed',
                cause,
                unmapped: [],
                differing: [],
                noteFailures: [],
                postPublishFailures: [],
                failure: { kind: 'cause', code: 'SETTINGS_MOVE_FAILED' },
              }
            }
            const outcome = result.move?.outcome
            const completion = inspect()
            result.decision =
              outcome === 'moved' ||
              outcome === 'done-already' ||
              outcome === 'aborted-target-appeared' ||
              completion.completed
                ? 'shared'
                : 'legacy'
          } else {
            result.decision = 'legacy'
          }
        }
        await lock.assertOwned()
        await record(result.decision)
      },
    )
    return finish()
  } catch (cause) {
    // Lock/folder/record failures cannot authorize old-store access. Publication
    // may have completed while waiting, so check again before refusing startup.
    if (!safeWithoutRecord(inspect()))
      throw new SettingsAuthorityRefusal(folder, cause)
    result.decision = 'shared'
    return finish()
  }
}
