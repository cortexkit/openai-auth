import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type LegacySource,
  type MapResult,
  moveSettingsOnce,
  openSettings,
} from '@cortexkit/common-auth/settings'
import {
  type AccountStorage,
  getQuotaCheckIntervalMs,
  isKillswitchEnabled,
  quotaSnapshotPassesPolicy,
  refreshBeforeExpiryMs,
} from '../accounts.js'
import { openaiSettings } from '../settings-definition.js'
import { mapSettings, readSettingsSource } from '../settings-map.js'
import * as floorsMapper from '../settings-map-floors.js'

type Host = 'opencode' | 'pi'
type Setting = keyof typeof openaiSettings.settings
type Row = {
  setting: Setting
  store: Record<string, unknown>
  expected: unknown
  only?: 'opencode'
}

function source(host: Host, value: Record<string, unknown> = {}): LegacySource {
  return { host, path: `/${host}.json`, present: true, value }
}

function missing(host: Host): LegacySource {
  return { host, path: `/${host}.json`, present: false }
}

function value(result: MapResult, setting: Setting, index = 0): unknown {
  return (
    result.entries.find(
      (entry) => entry.setting === setting && entry.source === index,
    )?.value ?? openaiSettings.settings[setting].default
  )
}

// These are literal legacy inputs and expected effective values, not values
// derived from the mapper or its declarations.
const rows: Row[] = [
  {
    setting: 'killswitch_enabled',
    store: { killswitch: { enabled: 'yes' } },
    expected: false,
  },
  {
    setting: 'quota_minimum_remaining',
    store: { quota: { minimumRemaining: { primary: null } } },
    expected: [],
  },
  {
    setting: 'routing_mode',
    store: { routing: { mode: 'sticky-balanced' } },
    expected: 'sticky-balanced',
  },
  ...(
    [
      ['ordered', 'ordered'],
      ['main-first', 'main-first'],
      ['fallback-first', 'fallback-first'],
    ] as const
  ).map(([mode, expected]) => ({
    setting: 'routing_mode' as const,
    store: { routing: { mode } },
    expected,
  })),
  ...(
    [
      [0, 'off'],
      [15, '15m'],
      ['max', 'cache'],
    ] as const
  ).map(([wait, expected]) => ({
    setting: 'max_same_account_wait' as const,
    store: { routing: { maxSameAccountWait: wait } },
    expected,
  })),
  {
    setting: 'fallback_on',
    store: { fallbackOn: [429, 503, -1, 200] },
    expected: [429, 503, -1, 200],
  },
  {
    setting: 'fallback_on',
    store: { fallbackOn: [] },
    expected: [401, 403, 429],
  },
  {
    setting: 'fallback_on',
    store: { fallbackOn: [429, 1.5, '403'] },
    expected: [429],
  },
  {
    setting: 'refresh_enabled',
    store: { refresh: { enabled: false } },
    expected: false,
    only: 'opencode',
  },
  {
    setting: 'refresh_before_expiry_minutes',
    store: { refresh: { refreshBeforeExpiryMinutes: 300 } },
    expected: 300,
  },
  {
    setting: 'quota_enabled',
    store: { quota: { enabled: false } },
    expected: false,
  },
  {
    setting: 'quota_check_interval_minutes',
    store: { quota: { checkIntervalMinutes: 7.5 } },
    expected: 7.5,
    only: 'opencode',
  },
  {
    setting: 'quota_minimum_remaining',
    store: { quota: { minimumRemaining: { primary: 20, secondary: 30 } } },
    expected: [
      { window: 'primary', floor: 20 },
      { window: 'secondary', floor: 30 },
    ],
  },
  {
    setting: 'quota_minimum_remaining',
    store: { quota: { minimumRemaining: { '5h': 25, '1w': 35 } } },
    expected: [
      { window: 'primary', floor: 25 },
      { window: 'secondary', floor: 35 },
    ],
  },
  {
    setting: 'quota_minimum_remaining',
    store: { quota: { minimumRemaining: { secondary: 0 } } },
    expected: [{ window: 'secondary', floor: 0 }],
  },
  {
    setting: 'quota_minimum_remaining',
    store: {
      quota: {
        minimumRemaining: { primary: 0, '5h': 90, secondary: 10, '1w': 90 },
      },
    },
    expected: [
      { window: 'primary', floor: 0 },
      { window: 'secondary', floor: 10 },
    ],
  },
  {
    setting: 'quota_fail_closed_on_unknown',
    store: { quota: { failClosedOnUnknownQuota: true } },
    expected: true,
  },
  {
    setting: 'cost_zeroing',
    store: { costZeroing: { enabled: false } },
    expected: false,
    only: 'opencode',
  },
  {
    setting: 'killswitch_enabled',
    store: { killswitch: { enabled: true } },
    expected: true,
  },
  {
    setting: 'killswitch_default_primary',
    store: { killswitch: { main: { '5h': 25, '1w': 35 } } },
    expected: 25,
  },
  {
    setting: 'killswitch_default_secondary',
    store: { killswitch: { main: { primary: 25, secondary: 35 } } },
    expected: 35,
  },
  {
    setting: 'killswitch_default_primary',
    store: {
      killswitch: {
        schema: 'floors-v1',
        defaults: { primary: 40, secondary: 50 },
      },
    },
    expected: 40,
  },
  {
    setting: 'killswitch_default_secondary',
    store: { killswitch: { schema: 'floors-v1' } },
    expected: 0,
  },
  ...(['cacheKeep', 'cachekeep'] as const).flatMap((root) => [
    ...(['enabled', 'subagents', 'sustain'] as const).map((key) => ({
      setting: `cache_keep_${key}` as Setting,
      store: { [root]: { [key]: true } },
      expected: true,
      only: 'opencode' as const,
    })),
    {
      setting: 'cache_keep_window' as const,
      store: { [root]: { startHour: 22, endHour: 6 } },
      expected: [{ start_hour: 22, end_hour: 6 }],
      only: 'opencode' as const,
    },
  ]),
  ...(['error', 'warn', 'info', 'debug', 'trace'] as const).map((level) => ({
    setting: 'log_level' as const,
    store: { logging: { level } },
    expected: level,
    only: 'opencode' as const,
  })),
  {
    setting: 'request_dumps',
    store: { dump: true },
    expected: true,
    only: 'opencode',
  },
  {
    setting: 'request_dumps',
    store: { dump: { enabled: true } },
    expected: true,
    only: 'opencode',
  },
  {
    setting: 'request_dumps',
    store: { dump: false },
    expected: false,
    only: 'opencode',
  },
  {
    setting: 'dump_dir',
    store: { dumpDir: ' /custom/dumps ' },
    expected: '/custom/dumps',
    only: 'opencode',
  },
  {
    setting: 'dump_max_bytes',
    store: { dumpMaxBytes: 0 },
    expected: 0,
    only: 'opencode',
  },
  {
    setting: 'web_sockets',
    store: { webSockets: true },
    expected: true,
    only: 'opencode',
  },
  {
    setting: 'raw_web_socket',
    store: { rawWebSocket: true },
    expected: true,
    only: 'opencode',
  },
  {
    setting: 'responses_lite',
    store: { responsesLite: true },
    expected: true,
    only: 'opencode',
  },
  {
    setting: 'codex_api_endpoint',
    store: { codexApiEndpoint: ' https://example.test/responses ' },
    expected: 'https://example.test/responses',
    only: 'opencode',
  },
]

describe('settings map setting-table parity', () => {
  for (const host of ['opencode', 'pi'] as const) {
    rows.forEach((row, index) => {
      it(`${host} row ${index}: ${row.setting}`, () => {
        const result = mapSettings([source(host, row.store)])
        if (row.only && row.only !== host) {
          expect(
            result.entries.filter((entry) => entry.setting === row.setting),
          ).toEqual([])
          expect(
            result.unmapped.some((entry) => entry.reason === 'other-host'),
          ).toBe(true)
        } else expect(value(result, row.setting)).toEqual(row.expected)
      })
    })
  }

  it('covers every declared setting, with floors composed as one host-tagged list', () => {
    expect(
      new Set([...rows.map((row) => row.setting), 'killswitch_account_floors']),
    ).toEqual(new Set(Object.keys(openaiSettings.settings)))
    const legacy = [
      source('opencode', {
        killswitch: {
          accounts: { 'vault:a': { '5h': 20 }, row: { secondary: 30 } },
        },
      }),
      source('pi', {
        killswitch: { accounts: { 'vault:a': { primary: 20 } } },
      }),
    ]
    expect(mapSettings(legacy)).toEqual(
      floorsMapper.mapKillswitchFloors(legacy),
    )
    expect(
      mapSettings(legacy).entries.filter(
        (entry) => entry.setting === 'killswitch_account_floors',
      ),
    ).toEqual([
      {
        source: 0,
        setting: 'killswitch_account_floors',
        value: [
          { account: 'vault:a', host: 'both', primary: 20, secondary: 10 },
          { account: 'row', host: 'opencode', primary: 5, secondary: 30 },
        ],
      },
    ])
  })

  it('emits nothing for absent stores, unset modes and defaults in present stores', () => {
    for (const legacy of [
      [],
      [missing('opencode'), missing('pi')],
      [source('opencode')],
      [source('pi')],
      [source('opencode'), source('pi')],
    ]) {
      expect(mapSettings(legacy)).toEqual({ entries: [], unmapped: [] })
    }
  })

  it('keeps an absent saved log level independent of the environment', () => {
    const before = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
    try {
      process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'trace'
      expect(value(mapSettings([source('opencode')]), 'log_level')).toBe(
        'default',
      )
      expect(mapSettings([source('opencode')]).entries).toEqual([])
      expect(
        value(
          mapSettings([source('opencode', { logging: { level: 'info' } })]),
          'log_level',
        ),
      ).toBe('info')
    } finally {
      if (before === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
      else process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = before
    }
  })
})

const coerced: Row[] = [
  ...([1, 'true', 0, ''] as const).map((raw, index) => ({
    setting: 'quota_fail_closed_on_unknown' as const,
    store: { quota: { failClosedOnUnknownQuota: raw } },
    expected: index < 2,
  })),
  {
    setting: 'quota_check_interval_minutes',
    store: { quota: { checkIntervalMinutes: 0.5 } },
    expected: 1,
    only: 'opencode',
  },
  {
    setting: 'quota_check_interval_minutes',
    store: { quota: { checkIntervalMinutes: '8.5' } },
    expected: 8.5,
    only: 'opencode',
  },
  {
    setting: 'refresh_before_expiry_minutes',
    store: { refresh: { refreshBeforeExpiryMinutes: '300' } },
    expected: 300,
  },
  {
    setting: 'quota_minimum_remaining',
    store: { quota: { minimumRemaining: { primary: '20' } } },
    expected: [{ window: 'primary', floor: 20 }],
  },
]

describe('settings map garbage tiers', () => {
  for (const host of ['opencode', 'pi'] as const) {
    it(`${host}: treats ignored garbage as absent and reports invalid keys`, () => {
      const store = {
        killswitch: { enabled: 'yes' },
        quota: { minimumRemaining: { primary: null, secondary: null } },
      }
      expect(mapSettings([source(host, store)])).toEqual({
        entries: [],
        unmapped: [
          {
            source: 0,
            key: 'quota.minimumRemaining.primary',
            reason: 'invalid',
          },
          {
            source: 0,
            key: 'quota.minimumRemaining.secondary',
            reason: 'invalid',
          },
          { source: 0, key: 'killswitch.enabled', reason: 'invalid' },
        ],
      })
      expect(isKillswitchEnabled(store as unknown as AccountStorage)).toBe(
        false,
      )
    })

    it(`${host}: a null canonical quota window still falls through to its alias`, () => {
      const result = mapSettings([
        source(host, {
          quota: { minimumRemaining: { primary: null, '5h': 25 } },
        }),
      ])
      expect(value(result, 'quota_minimum_remaining')).toEqual([
        { window: 'primary', floor: 25 },
      ])
      expect(result.unmapped).toEqual([
        { source: 0, key: 'quota.minimumRemaining.primary', reason: 'invalid' },
      ])
    })

    coerced.forEach((row, index) => {
      if (row.only && row.only !== host) return
      it(`${host}: coercion ${index} ${row.setting}`, () => {
        const result = mapSettings([source(host, row.store)])
        expect(value(result, row.setting)).toEqual(row.expected)
        expect(result.unmapped).toEqual([])
        const storage = row.store as AccountStorage
        if (row.setting === 'quota_check_interval_minutes')
          expect(getQuotaCheckIntervalMs(storage)).toBe(
            (row.expected as number) * 60_000,
          )
        if (row.setting === 'refresh_before_expiry_minutes')
          expect(refreshBeforeExpiryMs(storage)).toBe(
            (row.expected as number) * 60_000,
          )
        if (row.setting === 'quota_fail_closed_on_unknown')
          expect(quotaSnapshotPassesPolicy(undefined, storage)).toBe(
            !row.expected,
          )
      })
    })

    for (const [setting, store] of [
      [
        'quota_minimum_remaining',
        { quota: { minimumRemaining: { primary: 'abc' } } },
      ],
      [
        'quota_minimum_remaining',
        { quota: { minimumRemaining: { secondary: 'abc' } } },
      ],
      [
        'refresh_before_expiry_minutes',
        { refresh: { refreshBeforeExpiryMinutes: 'abc' } },
      ],
      ...(host === 'opencode'
        ? ([
            [
              'quota_check_interval_minutes',
              { quota: { checkIntervalMinutes: 'abc' } },
            ],
          ] as const)
        : []),
    ] as const) {
      it(`${host}: refuses unreproducible ${setting}`, () => {
        expect(() => mapSettings([source(host, store)])).toThrow(
          `Cannot move setting ${setting}`,
        )
        try {
          mapSettings([source(host, store)])
        } catch (error) {
          expect(String(error)).not.toContain('abc')
        }
      })
    }
  }

  it('uses the whole winning cache object, not a field-by-field merge', () => {
    const result = mapSettings([
      source('opencode', {
        cacheKeep: { enabled: true },
        cachekeep: {
          subagents: true,
          sustain: true,
          startHour: 22,
          endHour: 6,
        },
      }),
    ])
    expect(result).toEqual({
      entries: [{ source: 0, setting: 'cache_keep_enabled', value: true }],
      unmapped: [{ source: 0, key: 'cachekeep', reason: 'shadowed' }],
    })
  })

  it('coerces valid warm hours and treats invalid or incomplete pairs as unrestricted', () => {
    expect(
      value(
        mapSettings([
          source('opencode', { cachekeep: { startHour: '22', endHour: '6' } }),
        ]),
        'cache_keep_window',
      ),
    ).toEqual([{ start_hour: 22, end_hour: 6 }])
    for (const cacheKeep of [
      { startHour: 22 },
      { startHour: 5, endHour: 5 },
      { startHour: -1, endHour: 5 },
      { startHour: 0, endHour: 24 },
      { startHour: 'abc', endHour: 6 },
    ]) {
      const result = mapSettings([source('opencode', { cacheKeep })])
      expect(value(result, 'cache_keep_window')).toEqual([])
      expect(result.unmapped.every((entry) => entry.reason === 'invalid')).toBe(
        true,
      )
    }
  })
})

describe('settings map placement and residue', () => {
  it('emits both present stores whenever either shared effective value is nondefault', () => {
    for (const row of [...rows, ...coerced]) {
      if (row.only) continue
      for (const index of [0, 1]) {
        const stores = [
          source('opencode', index === 0 ? row.store : {}),
          source('pi', index === 1 ? row.store : {}),
        ]
        const result = mapSettings(stores)
        const entries = result.entries.filter(
          (entry) => entry.setting === row.setting,
        )
        const absent = openaiSettings.settings[row.setting].default
        if (JSON.stringify(row.expected) === JSON.stringify(absent))
          expect(entries).toEqual([])
        else {
          expect(entries).toHaveLength(2)
          expect(value(result, row.setting, index)).toEqual(row.expected)
          expect(value(result, row.setting, 1 - index)).toEqual(absent)
        }
      }
    }
  })

  it('does not invent entries for an absent source', () => {
    expect(
      mapSettings([
        source('opencode', { routing: { mode: 'sticky-balanced' } }),
        missing('pi'),
      ]).entries,
    ).toEqual([
      { source: 0, setting: 'routing_mode', value: 'sticky-balanced' },
    ])
    expect(
      mapSettings([
        missing('opencode'),
        source('pi', { routing: { mode: 'sticky-balanced' } }),
      ]).entries,
    ).toEqual([
      { source: 1, setting: 'routing_mode', value: 'sticky-balanced' },
    ])
  })

  it('does not map or report state, refresh leases, errors, version stamps or claustrum', () => {
    const store = {
      version: 1,
      accounts: [{ id: 'a', access: 'not-a-setting' }],
      main: { type: 'opencode' },
      commonAuthPool: { version: 1 },
      commonAuthLimits: { version: 1 },
      openaiAuthPool: { migratedAt: 1 },
      mainAccountId: 'id',
      reset: { main: { cooldownUntil: 100 } },
      claustrum: { mode: 'claustrum' },
      refresh: {
        mainLastRefreshError: {},
        mainRefreshLeaseId: 'lease',
        mainRefreshLeaseUntil: 1,
        mainRefreshLeaseTokenHash: 'hash',
      },
      quota: {
        mainQuota: {},
        mainQuotaCheckedAt: 1,
        mainQuotaToken: 'token',
        mainLastQuotaApiError: {},
      },
    }
    expect(
      mapSettings([source('opencode', store), source('pi', store)]),
    ).toEqual({ entries: [], unmapped: [] })
  })

  it('reports dormant and unknown preferences as retired without leaking values', () => {
    const result = mapSettings([
      source('opencode', {
        quota: { refreshEveryNRequests: 'private-value' },
        unknownPreference: 'private-value',
      }),
    ])
    expect(result).toEqual({
      entries: [],
      unmapped: [
        { source: 0, key: 'quota.refreshEveryNRequests', reason: 'retired' },
        { source: 0, key: 'unknownPreference', reason: 'retired' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('private-value')
  })

  it('accepts source JSON objects only, rejecting syntax errors, nulls and arrays', () => {
    expect(readSettingsSource('{"routing":{"mode":"ordered"}}')).toEqual({
      routing: { mode: 'ordered' },
    })
    expect(() => readSettingsSource('{broken')).toThrow(
      'Settings source is not JSON',
    )
    for (const text of ['null', '[]', '1', '"text"', 'true'])
      expect(() => readSettingsSource(text)).toThrow(
        'Settings source is not an object',
      )
    expect(() =>
      mapSettings([
        { host: 'opencode', path: '/store', present: true, value: null },
      ]),
    ).toThrow('Settings source is not an object')
  })
})

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  )
})

async function move(stores: (Record<string, unknown> | string | undefined)[]) {
  const folder = await mkdtemp(join(tmpdir(), 'settings-map-'))
  folders.push(folder)
  const target = join(folder, 'settings.jsonc')
  const sources = await Promise.all(
    (['opencode', 'pi'] as const).map(async (host, index) => {
      const path = join(folder, `${host}.json`)
      const store = stores[index]
      if (store !== undefined)
        await writeFile(
          path,
          typeof store === 'string' ? store : JSON.stringify(store),
        )
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
    log: { warn() {}, info() {} },
  })
  return { result, target, sources }
}

describe('settings map common-auth merge', () => {
  it('keeps every supported table row and garbage normalization through publication', async () => {
    for (const host of ['opencode', 'pi'] as const) {
      for (const row of [...rows, ...coerced]) {
        if (row.only && row.only !== host) continue
        const stores = host === 'opencode' ? [row.store, {}] : [{}, row.store]
        const { result, target, sources } = await move(stores)
        expect(result.outcome).toBe('moved')
        expect(result.differing).toEqual([])
        expect(
          result.unmapped.some(
            (entry) =>
              entry.reason === 'unknown-setting' ||
              entry.reason === 'invalid-value',
          ),
        ).toBe(false)
        const handle = openSettings(openaiSettings, {
          file: target,
          separateInstall: false,
          log: { warn() {}, info() {} },
        })
        expect<unknown>(await handle.get(row.setting, { host })).toEqual(
          row.expected,
        )
        expect(handle.report()).toEqual([])
        for (let index = 0; index < stores.length; index++)
          expect(await readFile(sources[index]!.path, 'utf8')).toBe(
            JSON.stringify(stores[index]),
          )
      }
    }
  })

  it('writes default and pi for unequal modes, never an opencode override', async () => {
    for (const modes of [
      ['sticky-balanced', 'main-first'],
      ['main-first', 'sticky-balanced'],
      ['sticky-balanced', 'sticky-balanced'],
      ['main-first', 'main-first'],
    ] as const) {
      const stores = modes.map((mode) =>
        mode === 'main-first' ? {} : { routing: { mode } },
      )
      const { target, result } = await move(stores)
      expect(result.differing).toEqual([])
      const text = await readFile(target, 'utf8')
      const document = JSON.parse(text.replace(/^\/\/.*$/gm, ''))
      const expected = modes.every((mode) => mode === 'main-first')
        ? undefined
        : modes[0] === modes[1]
          ? modes[0]
          : { default: modes[0], pi: modes[1] }
      expect(document.routing_mode).toEqual(expected)
      expect(Object.keys(document.routing_mode ?? {})).not.toContain('opencode')
      for (const [index, host] of (['opencode', 'pi'] as const).entries()) {
        const handle = openSettings(openaiSettings, {
          file: target,
          separateInstall: false,
          log: { warn() {}, info() {} },
        })
        expect<unknown>(await handle.get('routing_mode', { host })).toBe(
          modes[index],
        )
      }
    }
  })

  it('lets the absent host read the sole present store plain value', async () => {
    for (const stores of [
      [
        { routing: { mode: 'sticky-balanced' }, killswitch: { enabled: true } },
        undefined,
      ],
      [
        undefined,
        { routing: { mode: 'sticky-balanced' }, killswitch: { enabled: true } },
      ],
    ]) {
      const { target, result } = await move(stores)
      expect(result.differing).toEqual([])
      expect(
        JSON.parse((await readFile(target, 'utf8')).replace(/^\/\/.*$/gm, ''))
          .routing_mode,
      ).toBe('sticky-balanced')
      for (const host of ['opencode', 'pi']) {
        const handle = openSettings(openaiSettings, {
          file: target,
          separateInstall: false,
          log: { warn() {}, info() {} },
        })
        expect(await handle.get('routing_mode', { host })).toBe(
          'sticky-balanced',
        )
        expect(await handle.get('killswitch_enabled', { host })).toBe(true)
      }
    }
  })

  it('fails before publishing when either store cannot be parsed as an object', async () => {
    for (const broken of ['{not-json', 'null', '[]']) {
      for (const stores of [
        [broken, { routing: { mode: 'ordered' } }],
        [{ routing: { mode: 'ordered' } }, broken],
      ]) {
        const { result, target, sources } = await move(stores)
        expect(result.outcome).toBe('failed')
        expect(String(result.cause)).toMatch(
          /Settings source is not (JSON|an object)/,
        )
        expect(await stat(target).catch(() => null)).toBeNull()
        for (const source of sources)
          expect(
            await stat(`${source.path}.MOVED_READPLEASE`).catch(() => null),
          ).toBeNull()
      }
    }
  })

  it('fails before publishing unreproducible garbage and leaves source bytes intact', async () => {
    for (const store of [
      { quota: { minimumRemaining: { primary: 'abc' } } },
      { quota: { checkIntervalMinutes: 'abc' } },
      { refresh: { refreshBeforeExpiryMinutes: 'abc' } },
    ]) {
      const { result, target, sources } = await move([store, {}])
      expect(result.outcome).toBe('failed')
      expect(String(result.cause)).toContain('Cannot move setting')
      expect(await stat(target).catch(() => null)).toBeNull()
      expect(await readFile(sources[0]!.path, 'utf8')).toBe(
        JSON.stringify(store),
      )
      for (const source of sources)
        expect(
          await stat(`${source.path}.MOVED_READPLEASE`).catch(() => null),
        ).toBeNull()
    }
  })

  it('validates every composed entry before common-auth can silently drop it', async () => {
    const invalidEntries = [
      { setting: 'undeclared_setting', value: true },
      { setting: 'constructor', value: true },
      { setting: 'routing_mode', value: 'invalid-mode' },
      { setting: 'killswitch_enabled', value: 'yes' },
      { setting: 'quota_check_interval_minutes', value: 0.5 },
      { setting: 'fallback_on', value: [429, 1.5] },
      { setting: 'killswitch_default_primary', value: Number.NaN },
      {
        setting: 'killswitch_account_floors',
        value: [{ account: 'main', primary: 5, secondary: 10 }],
      },
      {
        setting: 'killswitch_account_floors',
        value: [
          {
            account: 'main',
            host: 'opencode',
            primary: 5,
            secondary: 10,
            extra: true,
          },
        ],
      },
    ]
    for (const entry of invalidEntries) {
      const seam = spyOn(floorsMapper, 'mapKillswitchFloors').mockReturnValue({
        entries: [{ source: 0, ...entry }],
        unmapped: [],
      })
      try {
        expect(() => mapSettings([source('opencode')])).toThrow(
          `Cannot move setting ${entry.setting}`,
        )
        const { result, target, sources } = await move([{}])
        expect(result.outcome).toBe('failed')
        expect(String(result.cause)).toContain(entry.setting)
        expect(await stat(target).catch(() => null)).toBeNull()
        expect(
          await stat(`${sources[0]!.path}.MOVED_READPLEASE`).catch(() => null),
        ).toBeNull()
      } finally {
        seam.mockRestore()
      }
    }
  })
})
