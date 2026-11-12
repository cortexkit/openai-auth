import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  getKillswitchThresholdsForAccount,
  KILLSWITCH_FLOORS_SCHEMA,
} from '../accounts.js'
import { openaiSettings } from '../settings-definition.js'
import { mapKillswitchFloors } from '../settings-map-floors.js'

type Host = 'opencode' | 'pi'
type Floor = {
  account: string
  host: Host | 'both'
  primary: number
  secondary: number
}

function source(host: Host, killswitch?: unknown): LegacySource {
  return { host, path: `/${host}.json`, present: true, value: { killswitch } }
}

function missing(host: Host): LegacySource {
  return { host, path: `/${host}.json`, present: false }
}

function floors(result: MapResult): Floor[] {
  return (result.entries.find(
    (entry) => entry.setting === 'killswitch_account_floors',
  )?.value ?? []) as Floor[]
}

function defaults(result: MapResult): MapResult['entries'] {
  return result.entries.filter((entry) =>
    entry.setting.startsWith('killswitch_default_'),
  )
}

function marked(accounts: unknown, defaults?: unknown) {
  return { schema: KILLSWITCH_FLOORS_SCHEMA, accounts, defaults }
}

describe('mapKillswitchFloors legacy reader parity', () => {
  it('omits declared defaults and absent sources', () => {
    expect(mapKillswitchFloors([])).toEqual({ entries: [], unmapped: [] })
    expect(mapKillswitchFloors([missing('opencode'), missing('pi')])).toEqual({
      entries: [],
      unmapped: [],
    })
    expect(mapKillswitchFloors([source('opencode'), source('pi')])).toEqual({
      entries: [],
      unmapped: [],
    })
  })

  it('moves a marked block without defaults as zero, ignoring its old main', () => {
    expect(
      mapKillswitchFloors([
        source('opencode', { ...marked({}), main: { primary: 90 } }),
      ]),
    ).toEqual({
      entries: [
        { source: 0, setting: 'killswitch_default_primary', value: 0 },
        { source: 0, setting: 'killswitch_default_secondary', value: 0 },
      ],
      unmapped: [],
    })
  })

  it('keeps marked accounts.main separate from defaults and missing windows at zero', () => {
    const result = mapKillswitchFloors([
      source(
        'opencode',
        marked(
          { main: { primary: 80 }, row: { secondary: 30 }, empty: {} },
          { primary: 12, secondary: 24 },
        ),
      ),
    ])
    expect(defaults(result)).toEqual([
      { source: 0, setting: 'killswitch_default_primary', value: 12 },
      { source: 0, setting: 'killswitch_default_secondary', value: 24 },
    ])
    expect(floors(result)).toEqual([
      { account: 'main', host: 'opencode', primary: 80, secondary: 0 },
      { account: 'row', host: 'opencode', primary: 0, secondary: 30 },
      { account: 'empty', host: 'opencode', primary: 0, secondary: 0 },
    ])
    expect(result.unmapped).toEqual([])
  })

  const markedWindows: [unknown, number][] = [
    ['20', 0],
    ['abc', 0],
    [null, 0],
    [undefined, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
    [{}, 0],
    [[], 0],
    [true, 0],
    [-5, 0],
    [150, 100],
    [20, 20],
  ]
  for (const [window, expected] of markedWindows) {
    it(`normalizes marked window ${String(window)} to ${expected} everywhere`, () => {
      const pair = { primary: window, secondary: window }
      const result = mapKillswitchFloors([
        source('opencode', marked({ row: pair }, pair)),
      ])
      expect(defaults(result)).toEqual([
        { source: 0, setting: 'killswitch_default_primary', value: expected },
        { source: 0, setting: 'killswitch_default_secondary', value: expected },
      ])
      expect(floors(result)).toEqual([
        {
          account: 'row',
          host: 'opencode',
          primary: expected,
          secondary: expected,
        },
      ])
      expect(result.unmapped).toEqual([])
    })
  }

  it('ignores aliases in marked windows and uses defaults for non-object entries', () => {
    const result = mapKillswitchFloors([
      source(
        'opencode',
        marked(
          { aliases: { '5h': 40, '1w': 50 }, null: null, string: '20' },
          { primary: 15, secondary: 25 },
        ),
      ),
    ])
    expect(floors(result)).toEqual([
      { account: 'aliases', host: 'opencode', primary: 0, secondary: 0 },
      { account: 'null', host: 'opencode', primary: 15, secondary: 25 },
      { account: 'string', host: 'opencode', primary: 15, secondary: 25 },
    ])
  })

  it('uses unmarked main as defaults, shadows accounts.main and never expands a roster', () => {
    const value = {
      killswitch: {
        main: { '5h': 17, '1w': 27 },
        accounts: { main: { primary: 99 }, named: { primary: 35 } },
      },
      get accounts(): never {
        throw new Error('roster must not be read')
      },
      get vault(): never {
        throw new Error('vault must not be read')
      },
    }
    const result = mapKillswitchFloors([
      { host: 'pi', path: '/pi.json', present: true, value },
    ])
    expect(defaults(result)).toEqual([
      { source: 0, setting: 'killswitch_default_primary', value: 17 },
      { source: 0, setting: 'killswitch_default_secondary', value: 27 },
    ])
    expect(floors(result)).toEqual([
      { account: 'named', host: 'pi', primary: 35, secondary: 10 },
    ])
    expect(result.unmapped).toEqual([
      { source: 0, key: 'killswitch.accounts.main', reason: 'shadowed' },
    ])
  })

  const unmarkedWindows: [unknown, number][] = [
    ['20', 20],
    ['abc', 0],
    [-5, 0],
    [150, 100],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ]
  for (const [window, expected] of unmarkedWindows) {
    it(`normalizes unmarked window ${String(window)} to ${expected} everywhere`, () => {
      const pair = { primary: window, secondary: window }
      const result = mapKillswitchFloors([
        source('pi', { main: pair, accounts: { row: pair } }),
      ])
      expect(defaults(result)).toEqual([
        { source: 0, setting: 'killswitch_default_primary', value: expected },
        { source: 0, setting: 'killswitch_default_secondary', value: expected },
      ])
      expect(floors(result)).toEqual([
        { account: 'row', host: 'pi', primary: expected, secondary: expected },
      ])
      expect(result.unmapped).toEqual([])
    })
  }

  it('moves unmarked windows with unusable numeric conversion as zero', () => {
    const window = JSON.parse('{"toString":0,"valueOf":0}')
    const pair = { primary: window, secondary: window }
    const result = mapKillswitchFloors([
      source('opencode', { main: pair, accounts: { row: pair } }),
    ])
    expect(defaults(result)).toEqual([
      { source: 0, setting: 'killswitch_default_primary', value: 0 },
      { source: 0, setting: 'killswitch_default_secondary', value: 0 },
    ])
    expect(floors(result)).toEqual([
      { account: 'row', host: 'opencode', primary: 0, secondary: 0 },
    ])
  })

  it('reports null unmarked windows and falls through aliases then older defaults', () => {
    const result = mapKillswitchFloors([
      source('opencode', {
        main: { primary: null, '5h': 18, secondary: null, '1w': 28 },
        accounts: {
          alias: { primary: null, '5h': 38, secondary: null, '1w': 48 },
          fallback: { primary: null, '5h': null, secondary: null, '1w': null },
          canonical: { primary: 58, '5h': 99, secondary: 68, '1w': 99 },
        },
      }),
    ])
    expect(defaults(result)).toEqual([
      { source: 0, setting: 'killswitch_default_primary', value: 18 },
      { source: 0, setting: 'killswitch_default_secondary', value: 28 },
    ])
    expect(floors(result)).toEqual([
      { account: 'alias', host: 'opencode', primary: 38, secondary: 48 },
      { account: 'fallback', host: 'opencode', primary: 5, secondary: 10 },
      { account: 'canonical', host: 'opencode', primary: 58, secondary: 68 },
    ])
    expect(result.unmapped).toEqual(
      [
        'killswitch.main.primary',
        'killswitch.main.secondary',
        'killswitch.accounts.alias.primary',
        'killswitch.accounts.alias.secondary',
        'killswitch.accounts.fallback.primary',
        'killswitch.accounts.fallback.secondary',
        'killswitch.accounts.fallback.5h',
        'killswitch.accounts.fallback.1w',
      ].map((key) => ({ source: 0, key, reason: 'invalid' })),
    )
  })
})

describe('mapKillswitchFloors host placement', () => {
  it('preserves each present store default when only the other store sets floors', () => {
    for (const host of ['opencode', 'pi'] as const) {
      const inputs = [
        source('opencode', host === 'opencode' ? marked({}) : undefined),
        source('pi', host === 'pi' ? marked({}) : undefined),
      ]
      expect(defaults(mapKillswitchFloors(inputs))).toEqual([
        {
          source: 0,
          setting: 'killswitch_default_primary',
          value: host === 'opencode' ? 0 : 5,
        },
        {
          source: 1,
          setting: 'killswitch_default_primary',
          value: host === 'pi' ? 0 : 5,
        },
        {
          source: 0,
          setting: 'killswitch_default_secondary',
          value: host === 'opencode' ? 0 : 10,
        },
        {
          source: 1,
          setting: 'killswitch_default_secondary',
          value: host === 'pi' ? 0 : 10,
        },
      ])
    }
  })

  it('keeps local ids host-tagged, including identical main floors in both stores', () => {
    const pair = { primary: 11, secondary: 22 }
    const result = mapKillswitchFloors([
      source(
        'opencode',
        marked({ main: pair, local: pair, 'Vault:case': pair }),
      ),
      source('pi', marked({ main: pair, local: pair, 'Vault:case': pair })),
    ])
    expect(floors(result)).toEqual([
      { account: 'main', host: 'opencode', ...pair },
      { account: 'local', host: 'opencode', ...pair },
      { account: 'Vault:case', host: 'opencode', ...pair },
      { account: 'main', host: 'pi', ...pair },
      { account: 'local', host: 'pi', ...pair },
      { account: 'Vault:case', host: 'pi', ...pair },
    ])
  })

  it('merges only equal vault floors and retains every different or single-store floor', () => {
    const result = mapKillswitchFloors([
      source(
        'opencode',
        marked({
          'vault:equal': { primary: 20, secondary: 30 },
          'vault:different-primary': { primary: 40, secondary: 50 },
          'vault:different-secondary': { primary: 60, secondary: 70 },
          'vault:opencode-only': { primary: 80, secondary: 90 },
        }),
      ),
      source('pi', {
        accounts: {
          'vault:equal': { primary: '20', secondary: '30' },
          'vault:different-primary': { primary: 41, secondary: 50 },
          'vault:different-secondary': { primary: 60, secondary: 71 },
          'vault:pi-only': { primary: 81, secondary: 91 },
        },
      }),
    ])
    expect(floors(result)).toEqual([
      { account: 'vault:equal', host: 'both', primary: 20, secondary: 30 },
      {
        account: 'vault:different-primary',
        host: 'opencode',
        primary: 40,
        secondary: 50,
      },
      {
        account: 'vault:different-secondary',
        host: 'opencode',
        primary: 60,
        secondary: 70,
      },
      {
        account: 'vault:opencode-only',
        host: 'opencode',
        primary: 80,
        secondary: 90,
      },
      {
        account: 'vault:different-primary',
        host: 'pi',
        primary: 41,
        secondary: 50,
      },
      {
        account: 'vault:different-secondary',
        host: 'pi',
        primary: 60,
        secondary: 71,
      },
      { account: 'vault:pi-only', host: 'pi', primary: 81, secondary: 91 },
    ])
    const lists = result.entries.filter(
      (entry) => entry.setting === 'killswitch_account_floors',
    )
    expect(lists).toHaveLength(1)
    expect(lists[0]?.source).toBe(0)
  })

  it('anchors to the first present source without lending floors to an absent host', () => {
    for (const host of ['opencode', 'pi'] as const) {
      const present = source(
        host,
        marked(
          {
            main: { primary: 12, secondary: 23 },
            'vault:only': { primary: 34, secondary: 45 },
          },
          { primary: 5, secondary: 10 },
        ),
      )
      const inputs =
        host === 'opencode'
          ? [present, missing('pi')]
          : [missing('opencode'), present]
      const result = mapKillswitchFloors(inputs)
      expect(result.entries).toEqual([
        {
          source: host === 'opencode' ? 0 : 1,
          setting: 'killswitch_account_floors',
          value: [
            { account: 'main', host, primary: 12, secondary: 23 },
            { account: 'vault:only', host, primary: 34, secondary: 45 },
          ],
        },
      ])
      expect(
        floors(result).filter(
          (entry) => entry.host === 'both' || entry.host !== host,
        ),
      ).toEqual([])
    }
  })

  it('preserves ids verbatim, normalizes like the reader and leaves snapshots unchanged', () => {
    const block = marked(
      JSON.parse(
        '{"__proto__":{"primary":42,"secondary":43},"vault: spaced id ":{"primary":44,"secondary":45}}',
      ),
      { primary: 46, secondary: 47 },
    )
    const before = structuredClone(block)
    for (const pair of Object.values(
      block.accounts as Record<string, object>,
    )) {
      Object.freeze(pair)
    }
    Object.freeze(block.accounts)
    Object.freeze(block.defaults)
    Object.freeze(block)
    const result = mapKillswitchFloors([source('opencode', block)])
    expect(floors(result)).toEqual([
      { account: '__proto__', host: 'opencode', primary: 42, secondary: 43 },
      {
        account: 'vault: spaced id ',
        host: 'opencode',
        primary: 44,
        secondary: 45,
      },
    ])
    for (const entry of floors(result)) {
      expect({ primary: entry.primary, secondary: entry.secondary }).toEqual(
        getKillswitchThresholdsForAccount(
          { killswitch: block } as AccountStorage,
          entry.account,
        ),
      )
    }
    expect(block).toEqual(before)
  })

  it('publishes one complete list through the real merge with no dropped values', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'settings-map-floors-'))
    const log = { info() {}, warn() {} }
    try {
      const opencode = join(folder, 'opencode.json')
      const pi = join(folder, 'pi.json')
      const target = join(folder, 'settings.jsonc')
      const stores = [
        source(
          'opencode',
          marked(
            {
              main: { primary: 11, secondary: 22 },
              'vault:shared': { primary: 33, secondary: 44 },
            },
            { primary: 55, secondary: 66 },
          ),
        ),
        source(
          'pi',
          marked({
            main: { primary: 12, secondary: 23 },
            'vault:shared': { primary: 33, secondary: 44 },
            'vault:pi': { primary: 77, secondary: 88 },
          }),
        ),
      ]
      const texts = stores.map((store) =>
        JSON.stringify(store.present ? store.value : {}),
      )
      await writeFile(opencode, texts[0] as string)
      await writeFile(pi, texts[1] as string)
      const moved = await moveSettingsOnce({
        definition: openaiSettings,
        target,
        separateInstall: false,
        sources: [opencode, pi].map((path, index) => ({
          host: index === 0 ? 'opencode' : 'pi',
          path,
          locks: [],
          read: JSON.parse,
        })),
        map: mapKillswitchFloors,
        fence: () => true,
        log,
      })
      expect(moved.outcome).toBe('moved')
      expect(moved.unmapped).toEqual([])
      expect(moved.differing).toEqual([])
      const handle = openSettings(openaiSettings, {
        file: target,
        log,
        separateInstall: false,
      })
      const expected: Floor[] = [
        { account: 'main', host: 'opencode', primary: 11, secondary: 22 },
        { account: 'vault:shared', host: 'both', primary: 33, secondary: 44 },
        { account: 'main', host: 'pi', primary: 12, secondary: 23 },
        { account: 'vault:pi', host: 'pi', primary: 77, secondary: 88 },
      ]
      for (const host of ['opencode', 'pi']) {
        expect(await handle.get('killswitch_account_floors', { host })).toEqual(
          expected,
        )
        expect(await handle.get('killswitch_default_primary', { host })).toBe(
          host === 'opencode' ? 55 : 0,
        )
        expect(await handle.get('killswitch_default_secondary', { host })).toBe(
          host === 'opencode' ? 66 : 0,
        )
      }
      expect(handle.report()).toEqual([])
      expect(
        await Promise.all([opencode, pi].map((path) => readFile(path, 'utf8'))),
      ).toEqual(texts)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
