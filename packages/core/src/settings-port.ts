import {
  type BuiltinSettingsPort,
  CommandError,
} from '@cortexkit/common-auth/commands'
import {
  openSettings,
  type SettingsEdit,
  SettingsRefusal,
} from '@cortexkit/common-auth/settings'
import type { PoolSettings } from '@cortexkit/common-auth/store'
import { openaiSettings } from './settings-definition.js'
import { settingsRefusalText } from './settings-diagnostics.js'
import type {
  OpenAiSettingsHandle,
  SettingsSnapshot,
  SnapshotHost,
} from './settings-snapshot.js'
import { isRecord } from './util/record.js'

const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}
const floorWindows = ['primary', 'secondary'] as const
type FloorWindow = (typeof floorWindows)[number]

/** A zero floor is an unset menu window, not an explicit zero-valued knob. */
function menuView(snapshot: SettingsSnapshot): PoolSettings {
  const { routing, killswitch } = snapshot.view()
  const accounts = Object.fromEntries(
    Object.entries(killswitch?.accounts ?? {}).map(([id, floors]) => [
      id,
      Object.fromEntries(
        Object.entries(record(floors)).filter(([, floor]) => floor !== 0),
      ),
    ]),
  )
  // A vault id may have only another host's floor. Keep an empty menu entry so
  // clearing it can remove those entries too, without applying their windows.
  for (const { account } of snapshot.get('killswitch_account_floors'))
    if (!Object.hasOwn(accounts, account))
      Object.defineProperty(accounts, account, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      })
  return { routing, killswitch: { ...killswitch, accounts } }
}

/**
 * The builtins edit store-shaped objects. Track even a repeated set or a clear
 * of an absent window, so an unusable list cannot masquerade as a no-op edit.
 */
function trackFloors(value: PoolSettings) {
  const windows = new Map<string, Set<FloorWindow>>()
  const add = (id: string, window: FloorWindow) => {
    const own = windows.get(id) ?? new Set<FloorWindow>()
    own.add(window)
    windows.set(id, own)
  }
  let touched = false
  let active = true
  const changed = (path: string[], mutation = false) => {
    if (!active) return
    if (path[0] !== 'killswitch' || path[1] !== 'accounts') return
    touched = true
    const [, , id, window] = path
    if (
      mutation &&
      id !== undefined &&
      (window === 'primary' || window === 'secondary')
    )
      add(id, window)
  }
  const wrap = (
    target: Record<string, unknown>,
    path: string[],
  ): PoolSettings =>
    new Proxy(target, {
      ownKeys(object) {
        changed(path)
        return Reflect.ownKeys(object)
      },
      get(object, key) {
        const value = Reflect.get(object, key)
        return typeof key === 'string' && isRecord(value)
          ? wrap(value, [...path, key])
          : value
      },
      set(object, key, next) {
        if (typeof key === 'string') changed([...path, key], true)
        return Reflect.set(object, key, next)
      },
      deleteProperty(object, key) {
        if (typeof key === 'string') changed([...path, key], true)
        return Reflect.deleteProperty(object, key)
      },
    })
  return {
    value: wrap(value, []),
    windows,
    add,
    touched: () => touched,
    finish: () => {
      active = false
    },
  }
}

/**
 * Bridge only the shared builtins' preferences. The writer permits template
 * creation after a fresh install or removal; reads and opens create nothing.
 */
export function createBuiltinSettingsPort(options: {
  file: string
  host: SnapshotHost
  snapshot: SettingsSnapshot
  log: { warn(message: string): unknown; info(message: string): unknown }
  /** Override the writer in refusal tests; never used to own the snapshot. */
  writer?: OpenAiSettingsHandle
}): BuiltinSettingsPort {
  const { host, snapshot } = options
  const writer =
    options.writer ??
    openSettings(openaiSettings, {
      file: options.file,
      log: options.log,
      separateInstall: false,
      createMissing: true,
    })
  return {
    async read() {
      await snapshot.refresh()
      return menuView(snapshot)
    },
    async update(mutator) {
      try {
        // Refresh the menu view and catch existing file problems before editing.
        await snapshot.refresh()
        const before = menuView(snapshot)
        const tracked = trackFloors(structuredClone(before))
        const edited = (await mutator(tracked.value)) ?? tracked.value
        tracked.finish()
        // Read back a plain copy after tracking the mutator's explicit edits.
        const next = JSON.parse(JSON.stringify(edited)) as PoolSettings
        const edits: SettingsEdit[] = []
        const routing = record(next.routing)
        const oldRouting = record(before.routing)
        if (routing.mode !== oldRouting.mode)
          edits.push({ setting: 'routing_mode', value: routing.mode })
        if (routing.maxSameAccountWait !== oldRouting.maxSameAccountWait)
          edits.push({
            setting: 'max_same_account_wait',
            value:
              routing.maxSameAccountWait === 0
                ? 'off'
                : routing.maxSameAccountWait === 'max'
                  ? 'cache'
                  : '15m',
          })
        const killswitch = record(next.killswitch)
        if (killswitch.enabled !== record(before.killswitch).enabled)
          edits.push({
            setting: 'killswitch_enabled',
            value: killswitch.enabled,
          })
        const oldAccounts = record(record(before.killswitch).accounts)
        const accounts = record(killswitch.accounts)
        for (const id of new Set([
          ...Object.keys(oldAccounts),
          ...Object.keys(accounts),
        ])) {
          const clearedAccount =
            Object.hasOwn(oldAccounts, id) &&
            !Object.hasOwn(accounts, id) &&
            !tracked.windows.has(id)
          for (const window of floorWindows) {
            if (
              clearedAccount ||
              !Object.is(
                record(oldAccounts[id])[window],
                record(accounts[id])[window],
              )
            )
              tracked.add(id, window)
          }
        }
        const editFloors = tracked.touched() || tracked.windows.size > 0
        if (editFloors) {
          if (
            snapshot
              .report()
              .some(
                (entry) =>
                  entry.keyPath[0] === 'killswitch_account_floors' ||
                  entry.reason === 'unreadable' ||
                  entry.reason === 'unparseable',
              )
          )
            throw new SettingsRefusal('settings-invalid-value', options.file)
        }
        await writer.update(
          (current) => {
            const planned = [...edits]
            if (editFloors) {
              // Another writer may have changed a different window on the
              // same account. Read its value from the locked file.
              const base =
                current.status === 'ready' &&
                Object.hasOwn(current.document, 'killswitch_account_floors')
                  ? current.document.killswitch_account_floors
                  : openaiSettings.settings.killswitch_account_floors.default
              if (!Array.isArray(base))
                throw new SettingsRefusal(
                  'settings-invalid-value',
                  options.file,
                )
              let floors: unknown[] = base
              for (const [id, windows] of tracked.windows) {
                // Vault ids name one account on both hosts. Local ids name only
                // this host's account; all entries belonging to the other host stay.
                const vault = id.startsWith('vault:')
                const matching = (entry: unknown) =>
                  record(entry).account === id
                const currentFloors = record(
                  floors.find(
                    (entry) => matching(entry) && record(entry).host === host,
                  ) ??
                    (vault
                      ? floors.find(
                          (entry) =>
                            matching(entry) && record(entry).host === 'both',
                        )
                      : undefined),
                )
                floors = floors.filter(
                  (entry) =>
                    !matching(entry) || (!vault && record(entry).host !== host),
                )
                const editedFloors = record(accounts[id])
                const valueFor = (window: FloorWindow) => {
                  if (windows.has(window)) return editedFloors[window]
                  const value = currentFloors[window]
                  return value === 0 ? undefined : value
                }
                const primary = valueFor('primary')
                const secondary = valueFor('secondary')
                if (primary !== undefined || secondary !== undefined)
                  floors.push({
                    account: id,
                    host: vault ? 'both' : host,
                    primary: primary ?? 0,
                    secondary: secondary ?? 0,
                  })
              }
              // The writer validates the complete list against its declaration
              // before publishing either the floors or the scalar edits.
              planned.push({
                setting: 'killswitch_account_floors',
                value: floors,
              })
            }
            return planned
          },
          { host },
        )
        // Publish to request readers and live-setting callbacks before success.
        await snapshot.refresh()
      } catch (error) {
        if (error instanceof SettingsRefusal)
          throw new CommandError(error.code, settingsRefusalText(error.code))
        throw error
      }
    },
  }
}
