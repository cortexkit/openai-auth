import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveSettingsOnce, openSettings } from '@cortexkit/common-auth/settings'
import { SettingsFs } from '../../node_modules/@cortexkit/common-auth/dist/settings/fs.js'
import {
  type AccountStorage,
  cacheKeepSettings,
  getFallbackStatuses,
  getKillswitchThresholdsForAccount,
  getQuotaCheckIntervalMs,
  isCostZeroingEnabled,
  isKillswitchEnabled,
  quotaSnapshotPassesPolicy,
  refreshBeforeExpiryMs,
} from '../accounts.js'
import { openaiSettings } from '../settings-definition.js'
import { mapSettings, readSettingsSource } from '../settings-map.js'
import {
  createSettingsSnapshot,
  type OpenAiSettingsHandle,
  type SettingsSnapshot,
  type SettingsView,
  type SnapshotHost,
  type SnapshotSetting,
  type SnapshotValues,
} from '../settings-snapshot.js'

const log = { warn() {}, info() {} }
const folders: string[] = []
const snapshots: SettingsSnapshot[] = []
afterEach(async () => {
  for (const snapshot of snapshots.splice(0)) snapshot.dispose()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'settings-snapshot-'))
  folders.push(path)
  return path
}

async function open(
  file: string,
  host: SnapshotHost = 'opencode',
  watch = false,
) {
  const real = openSettings(openaiSettings, {
    file,
    log,
    separateInstall: false,
    createMissing: true,
  })
  let changed = () => {}
  let unwatched = false
  const handle: OpenAiSettingsHandle = watch
    ? real
    : {
        ...real,
        watch(callback) {
          changed = callback
          return () => {
            unwatched = true
          }
        },
      }
  const snapshot = await createSettingsSnapshot({ handle, file, host })
  snapshots.push(snapshot)
  return {
    snapshot,
    handle,
    fireWatch: () => changed(),
    unwatched: () => unwatched,
  }
}

async function fixture(
  values: Record<string, unknown> = {},
  host: SnapshotHost = 'opencode',
) {
  const file = join(await folder(), 'settings.jsonc')
  await writeFile(file, JSON.stringify({ schema_version: 1, ...values }))
  return { file, ...(await open(file, host)) }
}

const floors = (
  account: string,
  host: SnapshotHost | 'both',
  primary = 80,
  secondary = 80,
) => ({ account, host, primary, secondary })
const thresholds = (snapshot: SettingsSnapshot, id = 'main') =>
  getKillswitchThresholdsForAccount(
    snapshot.view(),
    id === 'main' ? undefined : id,
  )

function invalidSettings(snapshot: SettingsSnapshot) {
  return snapshot
    .report()
    .filter((entry) => entry.reason === 'invalid-value')
    .map((entry) => entry.keyPath[0])
}

describe('shared settings snapshot', () => {
  it('reads at startup, but request getters and views never call the handle', async () => {
    const diskRead = spyOn(SettingsFs, 'readFile')
    try {
      const { file, snapshot, handle } = await fixture({
        routing_mode: 'sticky-balanced',
      })
      const startupReads = diskRead.mock.calls.length
      expect(startupReads).toBeGreaterThan(0)
      const read = spyOn(handle, 'read')
      const get = spyOn(handle, 'get')
      try {
        for (let request = 0; request < 100; request++) {
          expect(snapshot.get('routing_mode')).toBe('sticky-balanced')
          expect(snapshot.view().routing?.mode).toBe('sticky-balanced')
        }
        expect(read).toHaveBeenCalledTimes(0)
        expect(get).toHaveBeenCalledTimes(0)
        expect(diskRead).toHaveBeenCalledTimes(startupReads)
        await writeFile(file, JSON.stringify({ routing_mode: 'ordered' }))
        await snapshot.refresh()
        expect(read).toHaveBeenCalledTimes(1)
        expect(get).toHaveBeenCalledTimes(
          Object.keys(openaiSettings.settings).length,
        )
        expect(diskRead.mock.calls.length).toBeGreaterThan(startupReads)
      } finally {
        read.mockRestore()
        get.mockRestore()
      }
    } finally {
      diskRead.mockRestore()
    }
  })

  it('replaces every old preference while retaining roster, refresh and quota state', async () => {
    const { snapshot } = await fixture()
    const error = { checkedAt: 123, message: 'backoff' }
    const store = {
      version: 1,
      accounts: [],
      mainAccountId: 'main-id',
      reset: { main: { cooldownUntil: 123 } },
      routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
      fallbackOn: [500],
      refresh: {
        enabled: false,
        refreshBeforeExpiryMinutes: 1,
        mainLastRefreshError: error,
        mainRefreshLeaseId: 'lease',
        mainRefreshLeaseUntil: 123,
        mainRefreshLeaseTokenHash: 'hash',
      },
      quota: {
        enabled: false,
        checkIntervalMinutes: 1,
        refreshEveryNRequests: 20,
        minimumRemaining: { '5h': 99 },
        failClosedOnUnknownQuota: true,
        mainQuota: { resetCreditsAvailable: 3 },
        mainQuotaCheckedAt: 123,
        mainQuotaToken: 'token',
        mainLastQuotaApiError: error,
      },
      killswitch: { enabled: true, main: { primary: 99 } },
      costZeroing: { enabled: false },
      cachekeep: { enabled: true, startHour: 3, endHour: 5 },
      cacheKeep: { sustain: true },
      logging: { level: 'trace' },
      dump: { enabled: true },
      dumpDir: '/old',
      dumpMaxBytes: 1,
      webSockets: true,
      rawWebSocket: true,
      responsesLite: true,
      codexApiEndpoint: 'https://old.invalid',
    } as unknown as AccountStorage
    const view = snapshot.view(store)
    expect(view.routing).toEqual({ mode: 'main-first', maxSameAccountWait: 15 })
    expect(view.fallbackOn).toEqual([401, 403, 429])
    expect(view.refresh).toEqual({
      ...store.refresh,
      enabled: true,
      refreshBeforeExpiryMinutes: 240,
    })
    expect(view.quota).toEqual({
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: {},
      failClosedOnUnknownQuota: false,
      mainQuota: { resetCreditsAvailable: 3 },
      mainQuotaCheckedAt: 123,
      mainQuotaToken: 'token',
      mainLastQuotaApiError: error,
    })
    expect(view.killswitch).toEqual({
      enabled: false,
      schema: 'floors-v1',
      defaults: { primary: 5, secondary: 10 },
      accounts: {},
    })
    expect(view.costZeroing).toEqual({ enabled: true })
    expect(view.cachekeep).toBeUndefined()
    expect(view.cacheKeep).toEqual({
      enabled: false,
      subagents: false,
      sustain: false,
      startHour: undefined,
      endHour: undefined,
    })
    expect(view.logging?.level).toBeUndefined()
    expect(view.dump).toEqual({ enabled: false })
    expect([
      view.dumpDir,
      view.dumpMaxBytes,
      view.webSockets,
      view.rawWebSocket,
      view.responsesLite,
      view.codexApiEndpoint,
    ]).toEqual([
      '',
      536870912,
      false,
      false,
      false,
      'https://chatgpt.com/backend-api/codex/responses',
    ])
    expect(view.accounts).toBe(store.accounts)
    expect(view.reset).toBe(store.reset)
    expect(view.mainAccountId).toBe('main-id')
    expect(store.routing?.mode).toBe('fallback-first')
  })

  for (const host of ['opencode', 'pi'] as const) {
    it(`has a non-null ${host} view with absent store files and no shared file`, async () => {
      const file = join(await folder(), 'absent.jsonc')
      const { snapshot } = await open(file, host)
      expect(snapshot.view(null).routing?.mode).toBe('main-first')
      expect(snapshot.view(null).accounts).toEqual([])
      expect(snapshot.report()).toEqual([])
    })

    it(`uses shared values for ${host} with the store files absent`, async () => {
      const { snapshot } = await fixture(
        {
          routing_mode: 'sticky-balanced',
          killswitch_enabled: true,
          killswitch_account_floors: [
            floors('local', 'opencode'),
            floors('vault:only-opencode', 'opencode'),
          ],
        },
        host,
      )
      expect(snapshot.view(null).routing?.mode).toBe('sticky-balanced')
      expect(isKillswitchEnabled(snapshot.view(null))).toBe(true)
      expect(thresholds(snapshot, 'local')).toEqual(
        host === 'opencode'
          ? { primary: 80, secondary: 80 }
          : { primary: 5, secondary: 10 },
      )
      expect(thresholds(snapshot, 'vault:only-opencode')).toEqual(
        host === 'opencode'
          ? { primary: 80, secondary: 80 }
          : { primary: 5, secondary: 10 },
      )
    })

    for (const reversed of [false, true]) {
      it(`applies both and ${host} floors with host-specific precedence (reversed=${reversed})`, async () => {
        const entries = [
          floors('vault:a', host, 70, 60),
          floors('vault:a', 'both', 30, 20),
          floors('main', 'opencode', 11, 12),
          floors('main', 'pi', 21, 22),
        ]
        const { snapshot } = await fixture(
          { killswitch_account_floors: reversed ? entries.reverse() : entries },
          host,
        )
        expect(thresholds(snapshot, 'vault:a')).toEqual({
          primary: 70,
          secondary: 60,
        })
        expect(thresholds(snapshot)).toEqual(
          host === 'opencode'
            ? { primary: 11, secondary: 12 }
            : { primary: 21, secondary: 22 },
        )
      })
    }
  }

  for (const [word, legacy] of [
    ['off', 0],
    ['15m', 15],
    ['cache', 'max'],
  ] as const) {
    it(`reads ${word} as the old ${legacy} same-account wait`, async () => {
      const { snapshot } = await fixture({ max_same_account_wait: word })
      expect(snapshot.view().routing?.maxSameAccountWait).toBe(legacy)
    })
  }

  it('leaves missing quota windows missing so consumers retain different defaults', async () => {
    const { snapshot } = await fixture({
      quota_minimum_remaining: [{ window: 'primary', floor: 20 }],
    })
    const view = snapshot.view()
    expect(view.quota?.minimumRemaining).toEqual({ primary: 20 })
    expect(view.quota?.minimumRemaining?.secondary ?? 0).toBe(0)
    expect(view.quota?.minimumRemaining?.secondary ?? 10).toBe(10)
  })

  it('returns copies of settings, diagnostics and preferences', async () => {
    const { snapshot } = await fixture({ unknown_setting: true })
    snapshot.get('fallback_on').push(500)
    snapshot.view().routing!.mode = 'fallback-first'
    snapshot.report()[0]!.keyPath.push('changed')
    expect(snapshot.get('fallback_on')).toEqual([401, 403, 429])
    expect(snapshot.view().routing?.mode).toBe('main-first')
    expect(snapshot.report()[0]?.keyPath).toEqual(['unknown_setting'])
  })
})

const badFloors = [
  {
    name: 'duplicate pair',
    entries: [floors('main', 'opencode'), floors('main', 'opencode', 1, 2)],
  },
  { name: 'local both alone', entries: [floors('main', 'both')] },
  {
    name: 'local both beside host-specific',
    entries: [floors('main', 'both'), floors('main', 'opencode')],
  },
  {
    name: 'missing host',
    entries: [{ account: 'main', primary: 1, secondary: 2 }],
  },
  {
    name: 'missing secondary',
    entries: [{ account: 'main', host: 'opencode', primary: 1 }],
  },
]

type ProtectionEdit = {
  [K in SnapshotSetting]: {
    setting: K
    applied: SnapshotValues[K]
    invalid: unknown
    fallback: SnapshotValues[K]
  }
}[SnapshotSetting]

const protectedEdits: ProtectionEdit[] = [
  {
    setting: 'killswitch_enabled',
    applied: true,
    invalid: 'yes',
    fallback: false,
  },
  {
    setting: 'killswitch_default_primary',
    applied: 70,
    invalid: '70',
    fallback: 5,
  },
  {
    setting: 'killswitch_default_secondary',
    applied: 75,
    invalid: null,
    fallback: 10,
  },
  {
    setting: 'killswitch_account_floors',
    applied: [floors('main', 'opencode')],
    invalid: [floors('main', 'both')],
    fallback: [],
  },
  {
    setting: 'killswitch_account_floors',
    applied: [floors('main', 'opencode')],
    invalid: [{ account: 'main', host: 'opencode', primary: 1 }],
    fallback: [],
  },
  {
    setting: 'quota_minimum_remaining',
    applied: [{ window: 'primary', floor: 70 }],
    invalid: [
      { window: 'primary', floor: 1 },
      { window: 'primary', floor: 2 },
    ],
    fallback: [],
  },
  {
    setting: 'quota_minimum_remaining',
    applied: [{ window: 'primary', floor: 70 }],
    invalid: [{ window: 'primary', floor: '1' }],
    fallback: [],
  },
  {
    setting: 'cache_keep_window',
    applied: [{ start_hour: 7, end_hour: 8 }],
    invalid: [{ start_hour: 7, end_hour: 7 }],
    fallback: [],
  },
  {
    setting: 'cache_keep_window',
    applied: [{ start_hour: 7, end_hour: 8 }],
    invalid: [{ start_hour: 7 }],
    fallback: [],
  },
]

describe('invalid protection edits', () => {
  for (const [
    index,
    { setting, applied, invalid, fallback },
  ] of protectedEdits.entries()) {
    it(`keeps applied ${setting} after an invalid refresh (${index})`, async () => {
      const { file, snapshot } = await fixture({ [setting]: applied })
      expect(snapshot.get(setting)).toEqual(applied)
      await writeFile(file, JSON.stringify({ [setting]: invalid }))
      await snapshot.refresh()
      expect(snapshot.get(setting)).toEqual(applied)
      expect(invalidSettings(snapshot)).toContain(setting)
    })

    it(`uses the declared default for invalid ${setting} at startup (${index})`, async () => {
      const { snapshot } = await fixture({ [setting]: invalid })
      expect(snapshot.get(setting)).toEqual(fallback)
      expect(invalidSettings(snapshot)).toContain(setting)
    })
  }

  for (const reason of ['unparseable', 'unreadable'] as const) {
    it(`retains quota minima and warm hours when the file becomes ${reason}`, async () => {
      const minima: SnapshotValues['quota_minimum_remaining'] = [
        { window: 'primary', floor: 70 },
      ]
      const window = [{ start_hour: 7, end_hour: 8 }]
      const { file, snapshot } = await fixture({
        quota_minimum_remaining: minima,
        cache_keep_window: window,
      })
      if (reason === 'unparseable') await writeFile(file, '{ broken json')
      else {
        await rm(file)
        await mkdir(file)
      }
      await snapshot.refresh()
      expect(snapshot.get('quota_minimum_remaining')).toEqual(minima)
      expect(snapshot.view().quota?.minimumRemaining).toEqual({ primary: 70 })
      expect(snapshot.get('cache_keep_window')).toEqual(window)
      expect(cacheKeepSettings(snapshot.view())?.startHour).toBe(7)
      expect(cacheKeepSettings(snapshot.view())?.endHour).toBe(8)
      expect(snapshot.report()).toContainEqual(
        expect.objectContaining({ reason }),
      )
    })
  }
})

describe('unread lists and files', () => {
  for (const { name, entries } of badFloors) {
    it(`uses default floors for every account on startup with ${name}`, async () => {
      const { snapshot } = await fixture({
        killswitch_enabled: true,
        killswitch_account_floors: [
          floors('valid', 'opencode', 90, 90),
          ...entries,
        ],
      })
      expect(isKillswitchEnabled(snapshot.view())).toBe(true)
      for (const id of ['main', 'valid', 'new'])
        expect(thresholds(snapshot, id)).toEqual({ primary: 5, secondary: 10 })
      expect(invalidSettings(snapshot)).toContain('killswitch_account_floors')
    })

    it(`retains applied floors across refreshes with ${name}`, async () => {
      const { file, snapshot } = await fixture({
        killswitch_enabled: true,
        killswitch_account_floors: [floors('main', 'opencode')],
      })
      expect(thresholds(snapshot)).toEqual({ primary: 80, secondary: 80 })
      await writeFile(
        file,
        JSON.stringify({
          killswitch_enabled: true,
          killswitch_default_primary: 1,
          killswitch_default_secondary: 2,
          killswitch_account_floors: entries,
        }),
      )
      await snapshot.refresh()
      expect(thresholds(snapshot)).toEqual({ primary: 80, secondary: 80 })
      expect(thresholds(snapshot, 'unlisted')).toEqual({
        primary: 5,
        secondary: 10,
      })
      await snapshot.refresh()
      expect(thresholds(snapshot)).toEqual({ primary: 80, secondary: 80 })
      expect(snapshot.get('killswitch_account_floors')).toEqual([
        floors('main', 'opencode'),
      ])
      expect(invalidSettings(snapshot)).toContain('killswitch_account_floors')
    })
  }

  it('uses configured default floors, not valid entries from an invalid list, on startup', async () => {
    const { snapshot } = await fixture({
      killswitch_enabled: true,
      killswitch_default_primary: 35,
      killswitch_default_secondary: 45,
      killswitch_account_floors: [
        floors('valid', 'opencode'),
        floors('main', 'both'),
      ],
    })
    expect(thresholds(snapshot, 'valid')).toEqual({
      primary: 35,
      secondary: 45,
    })
    expect(thresholds(snapshot)).toEqual({ primary: 35, secondary: 45 })
  })

  it('recovers from invalid floors only after a valid whole list is loaded', async () => {
    const { file, snapshot } = await fixture({
      killswitch_account_floors: [floors('main', 'opencode')],
    })
    await writeFile(
      file,
      JSON.stringify({ killswitch_account_floors: [floors('main', 'both')] }),
    )
    await snapshot.refresh()
    expect(thresholds(snapshot)).toEqual({ primary: 80, secondary: 80 })
    await writeFile(
      file,
      JSON.stringify({
        killswitch_account_floors: [],
        killswitch_default_primary: 2,
        killswitch_default_secondary: 3,
      }),
    )
    await snapshot.refresh()
    expect(thresholds(snapshot)).toEqual({ primary: 2, secondary: 3 })
    expect(snapshot.report()).toEqual([])
  })

  const invalidLists = [
    {
      setting: 'quota_minimum_remaining',
      value: [
        { window: 'primary', floor: 20 },
        { window: 'primary', floor: 90 },
      ],
    },
    {
      setting: 'quota_minimum_remaining',
      value: [{ window: 'primary', floor: 20 }, { window: 'secondary' }],
    },
    {
      setting: 'cache_keep_window',
      value: [
        { start_hour: 1, end_hour: 2 },
        { start_hour: 3, end_hour: 4 },
      ],
    },
    { setting: 'cache_keep_window', value: [{ start_hour: 3, end_hour: 3 }] },
    { setting: 'cache_keep_window', value: [{ start_hour: 3 }] },
  ] as const
  for (const [index, { setting, value }] of invalidLists.entries()) {
    it(`unreads all of ${setting} on startup and refresh (${index})`, async () => {
      const { file, snapshot } = await fixture({
        [setting]: value,
        unknown_setting: true,
      })
      for (const pass of [0, 1]) {
        if (pass) {
          await writeFile(
            file,
            JSON.stringify({
              [setting]: value,
              unknown_setting: true,
              routing_mode: 'ordered',
            }),
          )
          await snapshot.refresh()
        }
        expect(snapshot.get(setting)).toEqual([])
        if (setting === 'quota_minimum_remaining') {
          const minima = snapshot.view().quota?.minimumRemaining
          expect(minima).toEqual({})
          expect(minima?.primary ?? 0).toBe(0)
          expect(minima?.primary ?? 15).toBe(15)
        } else {
          expect(cacheKeepSettings(snapshot.view())?.startHour).toBeUndefined()
          expect(cacheKeepSettings(snapshot.view())?.endHour).toBeUndefined()
        }
        expect(invalidSettings(snapshot)).toContain(setting)
        expect(snapshot.report()).toContainEqual(
          expect.objectContaining({
            keyPath: ['unknown_setting'],
            reason: 'unknown-key',
          }),
        )
      }
    })
  }

  for (const reason of ['unparseable', 'unreadable'] as const) {
    it(`starts on defaults with the killswitch off when the file is ${reason}`, async () => {
      const file = join(await folder(), 'broken.jsonc')
      if (reason === 'unparseable') await writeFile(file, '{ invalid json')
      else await mkdir(file)
      const { snapshot } = await open(file)
      expect(isKillswitchEnabled(snapshot.view())).toBe(false)
      expect(snapshot.view().routing?.mode).toBe('main-first')
      expect(thresholds(snapshot)).toEqual({ primary: 5, secondary: 10 })
      expect(snapshot.report()).toContainEqual(
        expect.objectContaining({ reason, file: { kind: 'user', path: file } }),
      )
    })

    it(`keeps applied floors when an already invalid list becomes ${reason}`, async () => {
      const { file, snapshot } = await fixture({
        killswitch_enabled: true,
        killswitch_account_floors: [floors('main', 'opencode')],
      })
      await writeFile(
        file,
        JSON.stringify({
          killswitch_enabled: true,
          killswitch_account_floors: [floors('main', 'both')],
        }),
      )
      await snapshot.refresh()
      if (reason === 'unparseable') await writeFile(file, '{ invalid json')
      else {
        await rm(file)
        await mkdir(file)
      }
      await snapshot.refresh()
      expect(thresholds(snapshot)).toEqual({ primary: 80, secondary: 80 })
      expect(snapshot.report()).toContainEqual(
        expect.objectContaining({ reason }),
      )
    })
  }
})

describe('off-request refresh and watch callbacks', () => {
  it('refreshes before menus even when a watch callback has not fired', async () => {
    const { file, snapshot, handle, unwatched } = await fixture({
      log_level: 'info',
    })
    const applied: string[] = []
    const stop = snapshot.onChange(() => {
      applied.push(snapshot.get('log_level'))
    })
    await writeFile(
      file,
      JSON.stringify({
        log_level: 'trace',
        killswitch_account_floors: [floors('new', 'opencode')],
      }),
    )
    expect(snapshot.get('log_level')).toBe('info')
    await snapshot.refresh()
    expect(applied).toEqual(['trace'])
    expect(thresholds(snapshot, 'new')).toEqual({ primary: 80, secondary: 80 })
    await handle.update([{ setting: 'log_level', value: 'debug' }], {
      host: 'opencode',
    })
    await snapshot.refresh()
    expect(snapshot.view().logging?.level).toBe('debug')
    expect(applied).toEqual(['trace', 'debug'])
    stop()
    await snapshot.refresh()
    expect(applied).toEqual(['trace', 'debug'])
    snapshot.dispose()
    expect(unwatched()).toBe(true)
  })

  it('reloads and checks lists when the watch callback fires', async () => {
    const { file, snapshot, fireWatch } = await fixture({
      killswitch_account_floors: [floors('main', 'opencode')],
    })
    await writeFile(
      file,
      JSON.stringify({
        killswitch_account_floors: [floors('main', 'both')],
        request_dumps: true,
      }),
    )
    const changed = new Promise<void>((resolve) => {
      snapshot.onChange(resolve)
    })
    fireWatch()
    await changed
    expect(snapshot.view().dump?.enabled).toBe(true)
    expect(thresholds(snapshot)).toEqual({ primary: 80, secondary: 80 })
    expect(snapshot.report()).toContainEqual(
      expect.objectContaining({
        keyPath: ['killswitch_account_floors'],
        reason: 'invalid-value',
      }),
    )
  })

  it('observes external edits through the real settings watcher', async () => {
    const file = join(await folder(), 'watched.jsonc')
    await writeFile(
      file,
      JSON.stringify({ log_level: 'info', request_dumps: false }),
    )
    const { snapshot } = await open(file, 'opencode', true)
    const changed = new Promise<void>((resolve) => {
      snapshot.onChange(() => {
        if (
          snapshot.get('request_dumps') &&
          snapshot.get('log_level') === 'default'
        )
          resolve()
      })
    })
    await writeFile(file, JSON.stringify({ request_dumps: true }))
    await changed
    expect(snapshot.view().dump?.enabled).toBe(true)
    expect(snapshot.view().logging?.level).toBeUndefined()
  })
})

type RoundtripRow = {
  setting: SnapshotSetting
  old: Record<string, unknown>
  read: (view: SettingsView) => unknown
  expected: unknown
  piDefault?: unknown
}

// Literal results pin the old readers independently of the mapper and snapshot.
const roundtrips: RoundtripRow[] = [
  {
    setting: 'routing_mode',
    old: { routing: { mode: 'sticky-balanced' } },
    read: (view) => view.routing?.mode ?? 'main-first',
    expected: 'sticky-balanced',
  },
  {
    setting: 'max_same_account_wait',
    old: { routing: { maxSameAccountWait: 'max' } },
    read: (view) => view.routing?.maxSameAccountWait ?? 15,
    expected: 'max',
  },
  {
    setting: 'fallback_on',
    old: { fallbackOn: [418, 429] },
    read: getFallbackStatuses,
    expected: [418, 429],
  },
  {
    setting: 'refresh_enabled',
    old: { refresh: { enabled: false } },
    read: (view) => view.refresh?.enabled !== false,
    expected: false,
    piDefault: true,
  },
  {
    setting: 'refresh_before_expiry_minutes',
    old: { refresh: { refreshBeforeExpiryMinutes: 300 } },
    read: refreshBeforeExpiryMs,
    expected: 18_000_000,
  },
  {
    setting: 'quota_enabled',
    old: { quota: { enabled: false, failClosedOnUnknownQuota: true } },
    read: (view) => quotaSnapshotPassesPolicy(undefined, view),
    expected: true,
  },
  {
    setting: 'quota_check_interval_minutes',
    old: { quota: { checkIntervalMinutes: 0.5 } },
    read: getQuotaCheckIntervalMs,
    expected: 60_000,
    piDefault: 300_000,
  },
  {
    setting: 'quota_minimum_remaining',
    old: { quota: { minimumRemaining: { '5h': 27 } } },
    read: (view) => ({
      primary:
        view.quota?.minimumRemaining?.primary ??
        view.quota?.minimumRemaining?.['5h'],
      secondary:
        view.quota?.minimumRemaining?.secondary ??
        view.quota?.minimumRemaining?.['1w'],
    }),
    expected: { primary: 27, secondary: undefined },
  },
  {
    setting: 'quota_fail_closed_on_unknown',
    old: { quota: { failClosedOnUnknownQuota: true } },
    read: (view) => quotaSnapshotPassesPolicy(undefined, view),
    expected: false,
  },
  {
    setting: 'cost_zeroing',
    old: { costZeroing: { enabled: false } },
    read: isCostZeroingEnabled,
    expected: false,
    piDefault: true,
  },
  {
    setting: 'killswitch_enabled',
    old: { killswitch: { enabled: true } },
    read: isKillswitchEnabled,
    expected: true,
  },
  {
    setting: 'killswitch_default_primary',
    old: { killswitch: { main: { '5h': 31 } } },
    read: (view) => getKillswitchThresholdsForAccount(view).primary,
    expected: 31,
  },
  {
    setting: 'killswitch_default_secondary',
    old: { killswitch: { main: { '1w': 32 } } },
    read: (view) => getKillswitchThresholdsForAccount(view).secondary,
    expected: 32,
  },
  {
    setting: 'killswitch_account_floors',
    old: {
      killswitch: { schema: 'floors-v1', accounts: { a: { primary: 42 } } },
    },
    read: (view) => getKillswitchThresholdsForAccount(view, 'a'),
    expected: { primary: 42, secondary: 0 },
  },
  {
    setting: 'cache_keep_enabled',
    old: { cachekeep: { enabled: true } },
    read: (view) => cacheKeepSettings(view)?.enabled === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'cache_keep_subagents',
    old: { cacheKeep: { subagents: true } },
    read: (view) => cacheKeepSettings(view)?.subagents === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'cache_keep_sustain',
    old: { cachekeep: { sustain: true } },
    read: (view) => cacheKeepSettings(view)?.sustain === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'cache_keep_window',
    old: { cacheKeep: { startHour: 23, endHour: 4 } },
    read: (view) => ({
      start: cacheKeepSettings(view)?.startHour,
      end: cacheKeepSettings(view)?.endHour,
    }),
    expected: { start: 23, end: 4 },
    piDefault: { start: undefined, end: undefined },
  },
  {
    setting: 'log_level',
    old: { logging: { level: 'debug' } },
    read: (view) => view.logging?.level ?? 'trace',
    expected: 'debug',
    piDefault: 'trace',
  },
  {
    setting: 'request_dumps',
    old: { dump: { enabled: true } },
    read: (view) => view.dump?.enabled === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'dump_dir',
    old: { dumpDir: '/custom/dumps' },
    read: (view) => view.dumpDir || 'os-temp-folder',
    expected: '/custom/dumps',
    piDefault: 'os-temp-folder',
  },
  {
    setting: 'dump_max_bytes',
    old: { dumpMaxBytes: 1024 },
    read: (view) => view.dumpMaxBytes ?? 536870912,
    expected: 1024,
    piDefault: 536870912,
  },
  {
    setting: 'web_sockets',
    old: { webSockets: true },
    read: (view) => view.webSockets === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'raw_web_socket',
    old: { rawWebSocket: true },
    read: (view) => view.rawWebSocket === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'responses_lite',
    old: { responsesLite: true },
    read: (view) => view.responsesLite === true,
    expected: true,
    piDefault: false,
  },
  {
    setting: 'codex_api_endpoint',
    old: { codexApiEndpoint: 'https://endpoint.invalid/responses' },
    read: (view) =>
      view.codexApiEndpoint ||
      'https://chatgpt.com/backend-api/codex/responses',
    expected: 'https://endpoint.invalid/responses',
    piDefault: 'https://chatgpt.com/backend-api/codex/responses',
  },
]

async function moved(
  stores: Partial<Record<SnapshotHost, Record<string, unknown>>>,
) {
  const root = await folder()
  const target = join(root, 'settings.jsonc')
  const sources = await Promise.all(
    (['opencode', 'pi'] as const).map(async (host) => {
      const path = join(root, `${host}.json`)
      if (stores[host]) await writeFile(path, JSON.stringify(stores[host]))
      return { host, path, locks: [], read: readSettingsSource }
    }),
  )
  const result = await moveSettingsOnce({
    definition: openaiSettings,
    target,
    separateInstall: false,
    sources,
    map: mapSettings,
    fence: () => true,
    log,
  })
  expect(result.outcome).toBe('moved')
  expect(result.differing).toEqual([])
  expect(
    result.unmapped.filter(
      (entry) =>
        entry.reason === 'unknown-setting' || entry.reason === 'invalid-value',
    ),
  ).toEqual([])
  return target
}

describe('old store to move to resolved view', () => {
  it('covers every setting-table row', () => {
    expect(roundtrips.map(({ setting }) => setting).sort()).toEqual(
      (Object.keys(openaiSettings.settings) as SnapshotSetting[]).sort(),
    )
  })
  for (const host of ['opencode', 'pi'] as const) {
    for (const row of roundtrips) {
      it(`roundtrips ${row.setting} on ${host}`, async () => {
        const old = {
          version: 1,
          accounts: [],
          ...row.old,
        } as unknown as SettingsView
        expect(row.read(old)).toEqual(row.expected)
        const target = await moved({ [host]: old })
        const { snapshot } = await open(target, host)
        expect(row.read(snapshot.view(old))).toEqual(
          host === 'pi' && Object.hasOwn(row, 'piDefault')
            ? row.piDefault
            : row.expected,
        )
        expect(snapshot.report()).toEqual([])
      })
    }
  }

  it('preserves different effective values and local main floors for the two hosts', async () => {
    const target = await moved({
      opencode: {
        routing: { mode: 'fallback-first' },
        killswitch: {
          enabled: true,
          main: { primary: 8, secondary: 9 },
          accounts: { main: { primary: 99 }, local: { primary: 33 } },
        },
      },
      pi: {
        routing: { mode: 'sticky-balanced' },
        killswitch: {
          schema: 'floors-v1',
          enabled: true,
          accounts: {
            main: { primary: 44, secondary: 55 },
            local: { secondary: 66 },
          },
        },
      },
    })
    const oc = (await open(target)).snapshot
    const pi = (await open(target, 'pi')).snapshot
    expect(oc.view().routing?.mode).toBe('fallback-first')
    expect(pi.view().routing?.mode).toBe('sticky-balanced')
    expect(thresholds(oc)).toEqual({ primary: 8, secondary: 9 })
    expect(thresholds(oc, 'local')).toEqual({ primary: 33, secondary: 10 })
    expect(thresholds(pi)).toEqual({ primary: 44, secondary: 55 })
    expect(thresholds(pi, 'local')).toEqual({ primary: 0, secondary: 66 })
    expect(thresholds(pi, 'new')).toEqual({ primary: 0, secondary: 0 })
  })

  it('keeps an unset mode, both cache spellings, legacy dump and absent saved log level effective', async () => {
    for (const cacheKey of ['cachekeep', 'cacheKeep']) {
      const target = await moved({
        opencode: {
          [cacheKey]: { enabled: true, startHour: 20, endHour: 3 },
          dump: true,
        },
      })
      const { snapshot } = await open(target)
      expect(snapshot.view().routing?.mode).toBe('main-first')
      expect(cacheKeepSettings(snapshot.view())).toEqual({
        enabled: true,
        subagents: false,
        sustain: false,
        startHour: 20,
        endHour: 3,
      })
      expect(snapshot.view().dump?.enabled).toBe(true)
      expect(snapshot.view().logging?.level ?? 'trace').toBe('trace')
      expect(snapshot.view().logging?.level ?? 'info').toBe('info')
    }
  })
})
