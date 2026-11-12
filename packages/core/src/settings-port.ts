import { isDeepStrictEqual } from 'node:util'
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
  SnapshotValues,
} from './settings-snapshot.js'
import { isRecord } from './util/record.js'

const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}

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
  const accounts = new Set<string>()
  let touched = false
  let active = true
  const changed = (path: string[]) => {
    if (!active) return
    if (path[0] !== 'killswitch' || path[1] !== 'accounts') return
    touched = true
    if (path[2] !== undefined) accounts.add(path[2])
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
        if (typeof key === 'string') changed([...path, key])
        return Reflect.set(object, key, next)
      },
      deleteProperty(object, key) {
        if (typeof key === 'string') changed([...path, key])
        return Reflect.deleteProperty(object, key)
      },
    })
  return {
    value: wrap(value, []),
    accounts,
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
        // Never replace a list based on a stale watcher snapshot.
        await snapshot.refresh()
        const before = menuView(snapshot)
        const tracked = trackFloors(structuredClone(before))
        const edited = (await mutator(tracked.value)) ?? tracked.value
        tracked.finish()
        // Compare a plain copy, not the tracking proxies: Bun 1.3's
        // isDeepStrictEqual reports a Proxy unequal to an identical object,
        // which would mark every account as edited and reorder the list.
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
        ]))
          if (!isDeepStrictEqual(oldAccounts[id], accounts[id]))
            tracked.accounts.add(id)
        if (tracked.touched() || tracked.accounts.size > 0) {
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
          let floors = snapshot.get('killswitch_account_floors')
          for (const id of tracked.accounts) {
            // Vault ids name one account on both hosts. Local ids name only
            // this host's account; all entries belonging to the other host stay.
            floors = floors.filter(
              (entry) =>
                entry.account !== id ||
                (!id.startsWith('vault:') && entry.host !== host),
            )
            const own = record(accounts[id])
            if (Object.keys(own).length > 0)
              floors.push({
                account: id,
                host: id.startsWith('vault:') ? 'both' : host,
                primary: own.primary ?? 0,
                secondary: own.secondary ?? 0,
              } as SnapshotValues['killswitch_account_floors'][number])
          }
          edits.push({ setting: 'killswitch_account_floors', value: floors })
        }
        await writer.update(edits, { host })
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
