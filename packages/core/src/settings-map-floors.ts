import type { LegacySource, MapResult } from '@cortexkit/common-auth/settings'
import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
  KILLSWITCH_FLOORS_SCHEMA,
} from './accounts.js'

type Floors = { primary: number; secondary: number }
type SourceHost = 'opencode' | 'pi'
type AccountFloor = Floors & { account: string; host: SourceHost | 'both' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampFloor(value: unknown): number {
  // Remaining-quota comparisons coerce legacy string windows with Number().
  // The floors-schema reader has already made non-numbers zero.
  try {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0
  } catch {
    // Some JSON objects cannot convert to a number. Treat them as no floor
    // rather than letting one malformed window abort the move.
    return 0
  }
}

function movedFloors(storage: AccountStorage, account?: string): Floors {
  const floors = getKillswitchThresholdsForAccount(storage, account)
  return {
    primary: clampFloor(floors.primary),
    secondary: clampFloor(floors.secondary),
  }
}

function reportNullWindows(
  value: unknown,
  key: string,
  source: number,
  unmapped: MapResult['unmapped'],
): void {
  if (!isRecord(value)) return
  for (const window of ['primary', 'secondary', '5h', '1w']) {
    if (value[window] === null) {
      unmapped.push({ source, key: `${key}.${window}`, reason: 'invalid' })
    }
  }
}

/** Map snapshots for moveSettingsOnce without reading stores or taking locks. */
export function mapKillswitchFloors(
  legacy: readonly LegacySource[],
): MapResult {
  const result: MapResult = { entries: [], unmapped: [] }
  const defaults: { source: number; floors: Floors }[] = []
  const accounts: AccountFloor[] = []

  legacy.forEach((source, index) => {
    if (!source.present) return
    if (source.host !== 'opencode' && source.host !== 'pi') {
      throw new Error('Unsupported killswitch floors source host')
    }
    const host = source.host
    const value = isRecord(source.value) ? source.value : {}
    const block = isRecord(value.killswitch) ? value.killswitch : undefined
    const storage = {
      killswitch: value.killswitch,
    } as AccountStorage
    const marked = block?.schema === KILLSWITCH_FLOORS_SCHEMA

    // A marked accounts.main entry belongs to main, not to the defaults.
    // Removing accounts lets the same reader resolve only the default floors.
    const fallback = marked
      ? movedFloors({
          killswitch: { ...block, accounts: undefined },
        } as AccountStorage)
      : movedFloors(storage)
    defaults.push({ source: index, floors: fallback })

    if (!marked) {
      reportNullWindows(block?.main, 'killswitch.main', index, result.unmapped)
    }
    if (!isRecord(block?.accounts)) return
    for (const account of Object.keys(block.accounts)) {
      const key = `killswitch.accounts.${account}`
      if (!marked && account === 'main') {
        // Legacy callers pass undefined for main, so this key never applied.
        result.unmapped.push({ source: index, key, reason: 'shadowed' })
        continue
      }
      if (!marked) {
        reportNullWindows(block.accounts[account], key, index, result.unmapped)
      }
      accounts.push({
        account,
        host,
        ...movedFloors(storage, account === 'main' ? undefined : account),
      })
    }
  })

  // Default floors support host overrides. Emit all present sources whenever
  // one differs from the declared default, so an unset host keeps its value.
  for (const [window, absent] of [
    ['primary', 5],
    ['secondary', 10],
  ] as const) {
    if (defaults.every(({ floors }) => floors[window] === absent)) continue
    for (const { source, floors } of defaults) {
      result.entries.push({
        source,
        setting: `killswitch_default_${window}`,
        value: floors[window],
      })
    }
  }

  const merged: AccountFloor[] = []
  for (const entry of accounts) {
    const shared = entry.account.startsWith('vault:')
      ? merged.find(
          (other) =>
            other.account === entry.account &&
            other.host !== entry.host &&
            other.primary === entry.primary &&
            other.secondary === entry.secondary,
        )
      : undefined
    if (shared) shared.host = 'both'
    else merged.push(entry)
  }
  // The account-floor setting has no host override. common-auth would report
  // a second list as differing rather than merge its items, so emit one value.
  const first = defaults[0]
  if (first && merged.length > 0) {
    result.entries.push({
      source: first.source,
      setting: 'killswitch_account_floors',
      value: merged,
    })
  }
  return result
}
