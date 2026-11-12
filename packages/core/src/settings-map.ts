import type {
  LegacySource,
  MapResult,
  ValueDescriptor,
} from '@cortexkit/common-auth/settings'
import { openaiSettings } from './settings-definition.js'
import { mapKillswitchFloors } from './settings-map-floors.js'

type Setting = keyof typeof openaiSettings.settings
type Store = Record<string, unknown>
type Report = (
  key: string,
  reason: 'invalid' | 'shadowed' | 'other-host' | 'retired',
) => void

function isRecord(value: unknown): value is Store {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Parse the locked source snapshot, never substituting defaults for a broken store. */
export function readSettingsSource(text: string): Store {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Settings source is not JSON')
  }
  if (!isRecord(value)) throw new Error('Settings source is not an object')
  return value
}

function at(store: Store, path: readonly string[]): unknown {
  let value: unknown = store
  for (const key of path) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

// common-auth's validator is internal, not exported by its settings entry point.
// Match its complete-object policy for list and record items before publication.
function accepts(
  descriptor: ValueDescriptor,
  value: unknown,
  complete = false,
): boolean {
  switch (descriptor.kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return typeof value === 'string'
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (descriptor.kind !== 'integer' || Number.isInteger(value)) &&
        (descriptor.min === undefined || value >= descriptor.min) &&
        (descriptor.max === undefined || value <= descriptor.max)
      )
    case 'oneOf':
      return typeof value === 'string' && descriptor.values.includes(value)
    case 'list':
      return (
        Array.isArray(value) &&
        Array.from(value).every((item) => accepts(descriptor.item, item, true))
      )
    case 'object':
      return (
        isRecord(value) &&
        Object.entries(value).every(([key, item]) => {
          const field = descriptor.fields[key]
          return (
            Object.hasOwn(descriptor.fields, key) &&
            field !== undefined &&
            accepts(field, item, complete)
          )
        }) &&
        (!complete ||
          Object.keys(descriptor.fields).every((key) =>
            Object.hasOwn(value, key),
          ))
      )
    case 'record':
      return (
        isRecord(value) &&
        Object.values(value).every((item) =>
          accepts(descriptor.value, item, true),
        )
      )
  }
}

function cannotMove(setting: string, key?: string): never {
  // Errors name the setting and key, never the stored value or credential data.
  throw new Error(`Cannot move setting ${setting}${key ? ` (${key})` : ''}`)
}

function numeric(value: unknown, setting: Setting, key: string): number {
  try {
    const result = Number(value)
    if (Number.isFinite(result)) return result
  } catch {
    // JSON objects can have properties that prevent primitive conversion.
  }
  return cannotMove(setting, key)
}

function quotaMinima(store: Store, report: Report): unknown {
  const result: { window: string; floor: number }[] = []
  for (const [window, alias] of [
    ['primary', '5h'],
    ['secondary', '1w'],
  ] as const) {
    const path = ['quota', 'minimumRemaining']
    const canonical = at(store, [...path, window])
    const older = at(store, [...path, alias])
    for (const [key, value] of [
      [window, canonical],
      [alias, older],
    ] as const) {
      if (value === null) report([...path, key].join('.'), 'invalid')
    }
    if (canonical != null && older != null)
      report([...path, alias].join('.'), 'shadowed')
    const value = canonical ?? older
    if (value == null) continue
    // Quota admission uses remaining < floor; the refresh scheduler uses >=.
    // NaN opens admission but blocks scheduling, so it cannot become a number.
    // Missing windows stay missing: admission defaults to 0/0, scheduling to 15/10.
    result.push({
      window,
      floor: numeric(
        value,
        'quota_minimum_remaining',
        [...path, window].join('.'),
      ),
    })
  }
  return result
}

function cacheWindow(store: Store, root: string, report: Report): unknown {
  const start = at(store, [root, 'startHour'])
  const end = at(store, [root, 'endHour'])
  if (start === undefined && end === undefined) return []
  let first: number
  let last: number
  try {
    first = Number(start)
    last = Number(end)
  } catch {
    first = Number.NaN
    last = Number.NaN
  }
  if (
    Number.isInteger(first) &&
    first >= 0 &&
    first <= 23 &&
    Number.isInteger(last) &&
    last >= 0 &&
    last <= 23 &&
    first !== last
  ) {
    return [{ start_hour: first, end_hour: last }]
  }
  if (start !== undefined) report(`${root}.startHour`, 'invalid')
  if (end !== undefined) report(`${root}.endHour`, 'invalid')
  return []
}

function effective(setting: Setting, store: Store, report: Report): unknown {
  const declaration = openaiSettings.settings[setting]
  const absent = declaration.default
  if (setting === 'quota_minimum_remaining') return quotaMinima(store, report)
  const cacheRoot = isRecord(store.cacheKeep) ? 'cacheKeep' : 'cachekeep'
  if (setting === 'cache_keep_window')
    return cacheWindow(store, cacheRoot, report)
  const first = declaration.legacy[0]
  if (!first) return cannotMove(setting)
  let path = first.path
  if (setting.startsWith('cache_keep_')) path = [cacheRoot, ...path.slice(1)]
  if (setting === 'request_dumps')
    path = typeof store.dump === 'boolean' ? ['dump'] : ['dump', 'enabled']
  const raw = at(store, path)
  const key = path.join('.')
  if (raw === undefined) return absent
  if (setting === 'max_same_account_wait') {
    if (raw === 0) return 'off'
    if (raw === 15) return '15m'
    if (raw === 'max') return 'cache'
  } else if (setting === 'fallback_on') {
    if (Array.isArray(raw)) {
      const statuses = raw.filter((status) => Number.isInteger(status))
      if (statuses.length !== raw.length) report(key, 'invalid')
      return statuses.length ? statuses : absent
    }
  } else if (
    setting === 'refresh_before_expiry_minutes' ||
    setting === 'quota_check_interval_minutes'
  ) {
    if (raw != null) {
      const value = numeric(raw, setting, key)
      return setting === 'quota_check_interval_minutes'
        ? Math.max(1, value)
        : value
    }
  } else if (setting === 'quota_fail_closed_on_unknown') {
    if (raw != null) return Boolean(raw)
  } else if (setting === 'dump_dir' || setting === 'codex_api_endpoint') {
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  } else if (accepts(declaration.value, raw)) {
    return raw
  }
  // orderedPlacement treats unknown routing modes as main-first. Cache and
  // killswitch readers and OpenCode's transport resolver ignore non-booleans.
  // Refresh, quota and cost-zeroing switches stay on unless exactly false.
  report(key, 'invalid')
  return absent
}

const stateKeys = new Set([
  'version',
  'accounts',
  'main',
  'commonAuthPool',
  'commonAuthLimits',
  'openaiAuthPool',
  'mainAccountId',
  'reset',
  'claustrum',
])
const statePaths = new Set([
  'refresh.mainLastRefreshError',
  'refresh.mainRefreshLeaseId',
  'refresh.mainRefreshLeaseUntil',
  'refresh.mainRefreshLeaseTokenHash',
  'quota.mainQuota',
  'quota.mainQuotaCheckedAt',
  'quota.mainQuotaToken',
  'quota.mainLastQuotaApiError',
])

function reportResidue(store: Store, host: string, report: Report): void {
  const known = new Set<string>()
  for (const declaration of Object.values(openaiSettings.settings)) {
    for (const legacy of declaration.legacy) {
      const key = legacy.path.join('.')
      known.add(key)
      if (
        host === 'pi' &&
        !declaration.legacy.some((item) => item.source === 'pi-store') &&
        at(store, legacy.path) !== undefined
      ) {
        // dump is itself a legacy path; reporting its object once suffices.
        if (key === 'dump.enabled' && Object.hasOwn(store, 'dump')) continue
        report(key, 'other-host')
      }
    }
  }
  const visit = (block: Store, prefix = '') => {
    for (const [key, value] of Object.entries(block)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (
        (!prefix && stateKeys.has(key)) ||
        statePaths.has(path) ||
        path === 'killswitch.schema'
      )
        continue
      if (known.has(path)) continue
      if ([...known].some((item) => item.startsWith(`${path}.`))) {
        if (isRecord(value)) visit(value, path)
        else report(path, 'invalid')
      } else report(path, 'retired')
    }
  }
  visit(store)
  if (
    host === 'opencode' &&
    isRecord(store.cacheKeep) &&
    store.cachekeep !== undefined
  )
    report('cachekeep', 'shadowed')
}

/** Map locked snapshots only: no store, vault, filesystem or lock operations. */
export function mapSettings(legacy: readonly LegacySource[]): MapResult {
  const result: MapResult = { entries: [], unmapped: [] }
  const present = legacy.flatMap((source, index) => {
    if (!source.present) return []
    if (source.host !== 'opencode' && source.host !== 'pi')
      throw new Error('Unsupported settings source host')
    if (!isRecord(source.value))
      throw new Error('Settings source is not an object')
    const report: Report = (key, reason) => {
      if (
        !result.unmapped.some(
          (item) =>
            item.source === index && item.key === key && item.reason === reason,
        )
      ) {
        result.unmapped.push({ source: index, key, reason })
      }
    }
    reportResidue(source.value, source.host, report)
    return [{ source: index, host: source.host, store: source.value, report }]
  })

  for (const setting of Object.keys(openaiSettings.settings) as Setting[]) {
    if (
      setting.startsWith('killswitch_default_') ||
      setting === 'killswitch_account_floors'
    )
      continue
    const declaration = openaiSettings.settings[setting]
    const values = present
      .filter((source) =>
        declaration.legacy.some(
          (item) => item.source === `${source.host}-store`,
        ),
      )
      .map((source) => ({
        source: source.source,
        value: effective(setting, source.store, source.report),
      }))
    if (
      values.every(
        (item) =>
          JSON.stringify(item.value) === JSON.stringify(declaration.default),
      )
    )
      continue
    for (const item of values) result.entries.push({ ...item, setting })
  }
  const floors = mapKillswitchFloors(legacy)
  result.entries.push(...floors.entries)
  result.unmapped.push(...floors.unmapped)
  for (const entry of result.entries) {
    if (!Object.hasOwn(openaiSettings.settings, entry.setting))
      cannotMove(entry.setting)
    if (
      !accepts(
        openaiSettings.settings[entry.setting as Setting].value,
        entry.value,
      )
    )
      cannotMove(entry.setting)
  }
  return result
}
