import type {
  ReportEntry,
  SettingsHandle,
  ValueOf,
} from '@cortexkit/common-auth/settings'
import { type AccountStorage, KILLSWITCH_FLOORS_SCHEMA } from './accounts.js'
import { openaiSettings } from './settings-definition.js'

type Declaration = typeof openaiSettings.settings
export type SnapshotSetting = keyof Declaration
export type SnapshotValues = {
  [K in SnapshotSetting]: ValueOf<Declaration[K]['value']>
}
export type SnapshotHost = 'opencode' | 'pi'
export type OpenAiSettingsHandle = SettingsHandle<Declaration>

/** Transport preferences aren't fields of the legacy account-store type. */
export type SettingsView = AccountStorage & {
  dumpDir: string
  dumpMaxBytes: number
  webSockets: boolean
  rawWebSocket: boolean
  responsesLite: boolean
  codexApiEndpoint: string
}

export interface SettingsSnapshot {
  /** Memory only. A view is not evidence that an account store exists. */
  view(store?: AccountStorage | null): SettingsView
  get<K extends SnapshotSetting>(name: K): SnapshotValues[K]
  report(): ReportEntry[]
  /** For menus and list edits, not requests. Also notifies live-setting readers. */
  refresh(): Promise<void>
  onChange(callback: () => void): () => void
  dispose(): void
}

type ListSetting =
  | 'killswitch_account_floors'
  | 'quota_minimum_remaining'
  | 'cache_keep_window'

const protectedSettings = [
  'killswitch_enabled',
  'killswitch_default_primary',
  'killswitch_default_secondary',
  'killswitch_account_floors',
  'quota_minimum_remaining',
  'cache_keep_window',
] as const

function semanticChecks(values: SnapshotValues, file: string): ReportEntry[] {
  const entries: ReportEntry[] = []
  const invalid = (setting: ListSetting, detail: string) => {
    entries.push({
      file: { kind: 'user', path: file },
      keyPath: [setting],
      reason: 'invalid-value',
      detail,
    })
  }
  const floors = values.killswitch_account_floors
  const pairs = floors.map(({ account, host }) =>
    JSON.stringify([account, host]),
  )
  if (new Set(pairs).size !== pairs.length)
    invalid('killswitch_account_floors', 'Duplicate account and host pair')
  if (
    floors.some(
      ({ account, host }) => host === 'both' && !account.startsWith('vault:'),
    )
  )
    invalid(
      'killswitch_account_floors',
      'Only vault accounts may use host both',
    )
  const windows = values.quota_minimum_remaining.map(({ window }) => window)
  if (new Set(windows).size !== windows.length)
    invalid('quota_minimum_remaining', 'Duplicate quota window')
  const warm = values.cache_keep_window
  if (
    warm.length > 1 ||
    warm.some(({ start_hour, end_hour }) => start_hour === end_hour)
  )
    invalid('cache_keep_window', 'Use at most one window with unequal hours')
  return entries
}

function preferences(values: SnapshotValues, host: SnapshotHost): SettingsView {
  // Apply both-host entries first so a host-specific entry wins regardless of order.
  const floors = values.killswitch_account_floors
  const accounts = Object.fromEntries(
    [
      ...floors.filter((entry) => entry.host === 'both'),
      ...floors.filter((entry) => entry.host === host),
    ].map(({ account, primary, secondary }) => [
      account,
      { primary, secondary },
    ]),
  )
  const window = values.cache_keep_window[0]
  return {
    version: 1,
    accounts: [],
    routing: {
      mode: values.routing_mode,
      maxSameAccountWait: ({ off: 0, '15m': 15, cache: 'max' } as const)[
        values.max_same_account_wait
      ],
    },
    fallbackOn: values.fallback_on,
    refresh: {
      enabled: values.refresh_enabled,
      refreshBeforeExpiryMinutes: values.refresh_before_expiry_minutes,
    },
    quota: {
      enabled: values.quota_enabled,
      checkIntervalMinutes: values.quota_check_interval_minutes,
      minimumRemaining: Object.fromEntries(
        values.quota_minimum_remaining.map(({ window, floor }) => [
          window,
          floor,
        ]),
      ),
      failClosedOnUnknownQuota: values.quota_fail_closed_on_unknown,
    },
    costZeroing: { enabled: values.cost_zeroing },
    killswitch: {
      schema: KILLSWITCH_FLOORS_SCHEMA,
      enabled: values.killswitch_enabled,
      defaults: {
        primary: values.killswitch_default_primary,
        secondary: values.killswitch_default_secondary,
      },
      accounts,
    },
    // An absent saved level must let the host consult its environment again.
    logging: {
      level: values.log_level === 'default' ? undefined : values.log_level,
    },
    cachekeep: undefined,
    cacheKeep: {
      enabled: values.cache_keep_enabled,
      subagents: values.cache_keep_subagents,
      sustain: values.cache_keep_sustain,
      startHour: window?.start_hour,
      endHour: window?.end_hour,
    },
    dump: { enabled: values.request_dumps },
    dumpDir: values.dump_dir,
    dumpMaxBytes: values.dump_max_bytes,
    webSockets: values.web_sockets,
    rawWebSocket: values.raw_web_socket,
    responsesLite: values.responses_lite,
    codexApiEndpoint: values.codex_api_endpoint,
  }
}

/**
 * Own one snapshot per shared instance. common-auth's get() refreshes files, so
 * only startup, explicit menu refreshes and watch callbacks may call it here.
 */
export async function createSettingsSnapshot(options: {
  handle: OpenAiSettingsHandle
  host: SnapshotHost
  file: string
}): Promise<SettingsSnapshot> {
  const { handle, host, file } = options
  let values: SnapshotValues
  let current: SettingsView
  let report: ReportEntry[] = []
  let disposed = false
  let pending = Promise.resolve()
  const callbacks = new Set<() => void>()

  const reload = async () => {
    await handle.read()
    const next = Object.fromEntries(
      await Promise.all(
        (Object.keys(openaiSettings.settings) as SnapshotSetting[]).map(
          async (name) => [name, await handle.get(name, { host })],
        ),
      ),
    ) as SnapshotValues
    const readReport = handle.report()
    report = [...readReport, ...semanticChecks(next, file)]
    const fileFailed = readReport.some(
      (entry) =>
        entry.file.path === file &&
        (entry.reason === 'unreadable' || entry.reason === 'unparseable'),
    )
    const invalid = (setting: SnapshotSetting) =>
      report.some(
        (entry) =>
          entry.reason === 'invalid-value' && entry.keyPath[0] === setting,
      )
    const retain = <K extends SnapshotSetting>(setting: K) => {
      next[setting] = structuredClone(
        values?.[setting] ?? openaiSettings.settings[setting].default,
      ) as SnapshotValues[K]
    }
    // Invalid edits and whole-file failures keep the applied protection policy.
    for (const setting of protectedSettings)
      if (fileFailed || invalid(setting)) retain(setting)
    // With no applied policy to retain, a broken file must not disable protection.
    if (fileFailed && !values) next.killswitch_enabled = true
    if (invalid('killswitch_account_floors')) {
      // Retain the complete applied policy, including defaults: a corrupt list
      // must not quietly remove an account's protection or lower its fallback.
      next.killswitch_default_primary =
        values?.killswitch_default_primary ?? next.killswitch_default_primary
      next.killswitch_default_secondary =
        values?.killswitch_default_secondary ??
        next.killswitch_default_secondary
    }
    values = next
    current = preferences(next, host)
    if (!disposed) for (const callback of callbacks) callback()
  }
  const refresh = () => {
    // Serialize watch and menu reloads so an older read cannot publish last.
    pending = pending.then(reload, reload)
    return pending
  }
  const unwatch = handle.watch(() => {
    void refresh()
  })
  try {
    await refresh()
  } catch (error) {
    unwatch()
    throw error
  }
  return {
    view(store) {
      const prefs = structuredClone(current)
      return {
        ...store,
        ...prefs,
        accounts: store?.accounts ?? [],
        main: store?.main,
        // These objects mix preferences and state. Copy only their state fields
        // from the store, never a preference omitted by the shared file.
        refresh: {
          ...prefs.refresh,
          mainLastRefreshError: store?.refresh?.mainLastRefreshError,
          mainRefreshLeaseId: store?.refresh?.mainRefreshLeaseId,
          mainRefreshLeaseUntil: store?.refresh?.mainRefreshLeaseUntil,
          mainRefreshLeaseTokenHash: store?.refresh?.mainRefreshLeaseTokenHash,
        },
        quota: {
          ...prefs.quota,
          mainQuota: store?.quota?.mainQuota,
          mainQuotaCheckedAt: store?.quota?.mainQuotaCheckedAt,
          mainQuotaToken: store?.quota?.mainQuotaToken,
          mainLastQuotaApiError: store?.quota?.mainLastQuotaApiError,
        },
      }
    },
    get(name) {
      return structuredClone(values[name])
    },
    report() {
      return structuredClone(report)
    },
    refresh,
    onChange(callback) {
      callbacks.add(callback)
      return () => {
        callbacks.delete(callback)
      }
    },
    dispose() {
      disposed = true
      unwatch()
      callbacks.clear()
    },
  }
}
