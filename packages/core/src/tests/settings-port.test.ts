import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandApplyRequest } from '@cortexkit/common-auth/commands'
import { openSettings, SettingsRefusal } from '@cortexkit/common-auth/settings'
import type {
  PoolSettings,
  PoolStore,
  SettingsMutator,
} from '@cortexkit/common-auth/store'
import { getKillswitchThresholdsForAccount } from '../accounts'
import { createOpenAiMenu } from '../commands'
import { openaiSettings } from '../settings-definition'
import { SETTINGS_DIAGNOSTICS_TEXT } from '../settings-diagnostics'
import { createBuiltinSettingsPort } from '../settings-port'
import {
  createSettingsSnapshot,
  type OpenAiSettingsHandle,
  type SettingsSnapshot,
  type SnapshotHost,
} from '../settings-snapshot'
import type { MenuVault } from '../vault-account-menu'

const log = { warn() {}, info() {} }
const invocation = { notify() {} }
const { setSettingsWriteStepHookForTest } = (await import(
  new URL('write.js', import.meta.resolve('@cortexkit/common-auth/settings'))
    .href
)) as {
  setSettingsWriteStepHookForTest(
    hook?: (
      step: 'staged',
      paths: { target: string; temp: string },
    ) => void | Promise<void>,
  ): void
}
const folders: string[] = []
const snapshots: SettingsSnapshot[] = []
afterEach(async () => {
  setSettingsWriteStepHookForTest()
  for (const snapshot of snapshots.splice(0)) snapshot.dispose()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

function store(settings: PoolSettings = {}) {
  let current = structuredClone(settings)
  return {
    read: async () => ({
      status: 'ready',
      rows: ['main', 'alpha', 'beta'].map((id) => ({ id, enabled: true })),
    }),
    readSettings: async () => ({
      status: 'ready',
      settings: structuredClone(current),
    }),
    updateSettings: async (mutator: SettingsMutator) => {
      const next = structuredClone(current)
      current = (await mutator(next)) ?? next
      return { status: 'ready', settings: structuredClone(current) }
    },
  } as unknown as PoolStore
}

async function fixture(
  values: Record<string, unknown> | string | null = {},
  host: SnapshotHost = 'opencode',
) {
  // The settings writer reports canonical paths to its step hook, so the
  // overlap tests compare against the folder's real path, not tmpdir()'s alias
  // (/var on macOS, short names on Windows).
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'settings-port-')))
  folders.push(folder)
  const file = join(folder, 'settings.jsonc')
  if (values !== null)
    await writeFile(
      file,
      typeof values === 'string' ? values : JSON.stringify(values),
    )
  return settingsPort(file, host)
}

async function settingsPort(
  file: string,
  host: SnapshotHost,
  beforeWrite?: () => void,
) {
  const handle: OpenAiSettingsHandle = {
    ...openSettings(openaiSettings, {
      file,
      log,
      separateInstall: false,
      createMissing: true,
    }),
    // Hold watcher delivery: only the port may refresh a hand edit or its write.
    watch: () => () => {},
  }
  const snapshot = await createSettingsSnapshot({ handle, file, host })
  snapshots.push(snapshot)
  const port = createBuiltinSettingsPort({
    file,
    host,
    snapshot,
    log,
    ...(beforeWrite
      ? {
          writer: {
            ...handle,
            update: (...args: Parameters<OpenAiSettingsHandle['update']>) => {
              beforeWrite()
              return handle.update(...args)
            },
          },
        }
      : {}),
  })
  const menu = createOpenAiMenu({ store: store(), settings: port })
  const saved = () => handle.get('killswitch_account_floors', { host })
  return { file, host, snapshot, port, menu, handle, saved }
}

const floor = (
  account: string,
  host: SnapshotHost | 'both',
  primary = 30,
  secondary = 40,
) => ({ account, host, primary, secondary })
function setFloor(
  settings: PoolSettings,
  account: string,
  primary: number,
  secondary: number,
) {
  const killswitch = settings.killswitch as {
    accounts: Record<string, { primary: number; secondary: number }>
  }
  killswitch.accounts[account] = { primary, secondary }
}
const apply = (
  menu: ReturnType<typeof createOpenAiMenu>,
  sectionId: string,
  actionId: string,
  values: CommandApplyRequest['values'],
  itemId?: string,
) =>
  menu.apply(
    {
      command: 'openai',
      sectionId,
      actionId,
      values,
      ...(itemId ? { itemId } : {}),
    },
    invocation,
  )
const floors = (
  menu: ReturnType<typeof createOpenAiMenu>,
  id: string,
  primary: number | null,
  secondary: number | null,
) => apply(menu, 'limits', 'floors', { primary, secondary }, id)

async function overlappingFloorEdits(
  initial: ReturnType<typeof floor>[],
  firstEdit: SettingsMutator,
  secondEdit: SettingsMutator,
) {
  const first = await fixture({ killswitch_account_floors: initial })
  const releaseFirst = Promise.withResolvers<void>()
  const staged = Promise.withResolvers<void>()
  const second = await settingsPort(first.file, 'pi', releaseFirst.resolve)
  await Promise.all([first.port.read(), second.port.read()])
  let held = false
  setSettingsWriteStepHookForTest(async (_step, { target }) => {
    if (target !== first.file || held) return
    held = true
    // Leave the old file visible until the other port has refreshed and called
    // its writer. The second update must then wait for the first write's lock.
    staged.resolve()
    await releaseFirst.promise
  })
  // Which update finished first goes into the failure message, so a rare
  // failure under load explains itself.
  const finished: string[] = []
  const firstWrite = first.port.update(firstEdit).then(() => {
    finished.push('opencode')
  })
  try {
    await staged.promise
    await Promise.all([
      firstWrite,
      second.port.update(secondEdit).then(() => {
        finished.push('pi')
      }),
    ])
    const floors = JSON.parse(
      await readFile(first.file, 'utf8'),
    ).killswitch_account_floors
    return { floors, finished: `finished: ${finished.join(' then ')}` }
  } finally {
    releaseFirst.resolve()
    await firstWrite
    setSettingsWriteStepHookForTest()
  }
}

describe('shared builtin settings port', () => {
  test.each([
    ['"ordered"', '"sticky-balanced"'],
    [
      '{ "pi": "ordered" }',
      '{ "pi": "ordered", "default": "sticky-balanced" }',
    ],
    [
      '{ "default": "ordered", "opencode": "main-first", "pi": "ordered" }',
      '{ "default": "ordered", "opencode": "sticky-balanced", "pi": "ordered" }',
    ],
  ])(
    'writes routing in the existing placement and keeps comments: %s',
    async (before, after) => {
      const f = await fixture(
        `{ // keep this comment\n  "routing_mode": ${before}\n}`,
      )
      expect(
        (await apply(f.menu, 'routing', 'mode', { mode: 'sticky-balanced' }))
          .ok,
      ).toBe(true)
      const text = await readFile(f.file, 'utf8')
      expect(text).toContain('// keep this comment')
      expect(text.replace(/\s/g, '')).toContain(
        `"routing_mode":${after}`.replace(/\s/g, ''),
      )
      expect(f.snapshot.view().routing?.mode).toBe('sticky-balanced')
      const opened = await f.menu.open(invocation)
      expect(
        opened.menu.sections
          .find((s) => s.id === 'routing')
          ?.actions.find((a) => a.id === 'mode')?.knobs[0],
      ).toMatchObject({ value: 'sticky-balanced' })
    },
  )

  test('a first edit and an edit after removal create the commented template', async () => {
    const f = await fixture(null)
    expect(await readFile(f.file, 'utf8').catch((error) => error.code)).toBe(
      'ENOENT',
    )
    expect(
      (await apply(f.menu, 'limits', 'killswitch', { enabled: true })).ok,
    ).toBe(true)
    expect(await readFile(f.file, 'utf8')).toContain('//')
    await rm(f.file)
    expect(
      (await apply(f.menu, 'routing', 'mode', { mode: 'ordered' })).ok,
    ).toBe(true)
    expect(await readFile(f.file, 'utf8')).toContain('//')
  })

  test.each([
    [0, 'off'],
    [15, '15m'],
    ['max', 'cache'],
  ] as const)(
    'same-account wait %s writes a word and reads the existing choice',
    async (value, word) => {
      const f = await fixture({
        max_same_account_wait: value === 15 ? 'off' : '15m',
      })
      expect(
        (
          await apply(f.menu, 'routing', 'maxSameAccountWait', {
            maxSameAccountWait: String(value),
          })
        ).ok,
      ).toBe(true)
      expect(
        await f.handle.get('max_same_account_wait', { host: f.host }),
      ).toBe(word)
      expect(f.snapshot.view().routing?.maxSameAccountWait).toBe(value)
      const opened = await f.menu.open(invocation)
      expect(
        opened.menu.sections
          .find((section) => section.id === 'routing')
          ?.actions.find((action) => action.id === 'maxSameAccountWait')
          ?.knobs[0],
      ).toMatchObject({ value: String(value) })
    },
  )

  test.each(['opencode', 'pi'] as const)(
    'a local set and clear on %s preserve every other host entry',
    async (host) => {
      const other = host === 'pi' ? 'opencode' : 'pi'
      const untouched = [
        floor('alpha', other, 61, 62),
        floor('beta', host),
        floor('beta', other),
        floor('vault:other', 'both'),
      ]
      const f = await fixture(
        { killswitch_account_floors: [floor('alpha', host), ...untouched] },
        host,
      )
      expect((await floors(f.menu, 'alpha', 70, null)).ok).toBe(true)
      expect(await f.saved()).toEqual([
        ...untouched,
        floor('alpha', host, 70, 0),
      ])
      expect((await floors(f.menu, 'alpha', null, null)).ok).toBe(true)
      expect(await f.saved()).toEqual(untouched)
      expect(
        getKillswitchThresholdsForAccount(f.snapshot.view(), 'alpha'),
      ).toEqual({ primary: 5, secondary: 10 })
    },
  )

  test('the port leaves zero windows out and clearing the last window restores defaults', async () => {
    const f = await fixture({
      killswitch_enabled: true,
      killswitch_account_floors: [floor('alpha', 'opencode', 80, 0)],
    })
    expect((await f.port.read()).killswitch).toMatchObject({
      accounts: { alpha: { primary: 80 } },
    })
    expect((await floors(f.menu, 'alpha', null, null)).ok).toBe(true)
    expect(await f.saved()).toEqual([])
    expect(
      getKillswitchThresholdsForAccount(f.snapshot.view(), 'alpha'),
    ).toEqual({ primary: 5, secondary: 10 })
  })

  test('enable, set and clear reproduce the store-backed effective floors for every account', async () => {
    const original = {
      killswitch: {
        schema: 'floors-v1',
        enabled: false,
        defaults: { primary: 12, secondary: 23 },
        accounts: { beta: { primary: 41, secondary: 52 } },
      },
    }
    const legacyStore = store(original)
    const legacy = createOpenAiMenu({ store: legacyStore })
    const f = await fixture({
      killswitch_default_primary: 12,
      killswitch_default_secondary: 23,
      killswitch_account_floors: [floor('beta', 'opencode', 41, 52)],
    })
    const requests: Omit<CommandApplyRequest, 'command'>[] = [
      {
        sectionId: 'limits',
        actionId: 'killswitch',
        values: { enabled: true },
      },
      {
        sectionId: 'limits',
        actionId: 'floors',
        itemId: 'alpha',
        values: { primary: 70, secondary: 80 },
      },
      {
        sectionId: 'limits',
        actionId: 'floors',
        itemId: 'alpha',
        values: { primary: null, secondary: null },
      },
    ]
    for (const request of requests) {
      expect(
        (await legacy.apply({ command: 'openai', ...request }, invocation)).ok,
      ).toBe(true)
      expect(
        (await f.menu.apply({ command: 'openai', ...request }, invocation)).ok,
      ).toBe(true)
      const read = await legacyStore.readSettings()
      if (read.status === 'error') throw new Error('settings unavailable')
      for (const id of [undefined, 'alpha', 'beta', 'later'])
        expect(
          getKillswitchThresholdsForAccount(f.snapshot.view(), id),
        ).toEqual(
          getKillswitchThresholdsForAccount(
            { version: 1, accounts: [], ...read.settings },
            id,
          ),
        )
    }
  })
})

test('Pi updates only its existing host override', async () => {
  const f = await fixture(
    {
      routing_mode: {
        default: 'ordered',
        opencode: 'main-first',
        pi: 'fallback-first',
      },
    },
    'pi',
  )
  expect(
    (await apply(f.menu, 'routing', 'mode', { mode: 'sticky-balanced' })).ok,
  ).toBe(true)
  expect(JSON.parse(await readFile(f.file, 'utf8')).routing_mode).toEqual({
    default: 'ordered',
    opencode: 'main-first',
    pi: 'sticky-balanced',
  })
})

describe('fresh list edits and refusals', () => {
  test('overlapping local floor edits from two hosts preserve both updates', async () => {
    const untouched = [
      floor('alpha', 'pi', 21, 22),
      floor('vault:other', 'both'),
    ]
    const { floors, finished } = await overlappingFloorEdits(
      [floor('alpha', 'opencode'), floor('beta', 'pi'), ...untouched],
      (settings) => {
        setFloor(settings, 'alpha', 71, 72)
      },
      (settings) => {
        setFloor(settings, 'beta', 81, 82)
      },
    )
    expect(floors, finished).toEqual([
      ...untouched,
      floor('alpha', 'opencode', 71, 72),
      floor('beta', 'pi', 81, 82),
    ])
  })

  test('overlapping vault floor edits use the last host values and preserve other accounts', async () => {
    const untouched = [floor('alpha', 'opencode'), floor('beta', 'pi')]
    const { floors, finished } = await overlappingFloorEdits(
      [
        floor('vault:shared', 'both'),
        floor('vault:shared', 'pi'),
        ...untouched,
      ],
      (settings) => {
        setFloor(settings, 'vault:shared', 71, 72)
      },
      (settings) => {
        setFloor(settings, 'vault:shared', 81, 82)
      },
    )
    expect(floors, finished).toEqual([
      ...untouched,
      floor('vault:shared', 'both', 81, 82),
    ])
  })

  test.each([
    { name: 'non-array', value: {} },
    { name: 'null', value: null },
    {
      name: 'incomplete entry',
      value: [{ account: 'beta', host: 'pi', primary: 80 }],
    },
    { name: 'null entry', value: [null] },
  ])(
    'a floor value made invalid after the last read refuses without writing scalar edits: $name',
    async ({ value }) => {
      const f = await fixture({
        killswitch_account_floors: [floor('alpha', 'opencode')],
      })
      const invalid = JSON.stringify({ killswitch_account_floors: value })
      await expect(
        f.port.update(async (settings) => {
          setFloor(settings, 'alpha', 71, 72)
          settings.routing = {
            ...(settings.routing as object),
            mode: 'ordered',
          }
          // Mutators run after the port's last refresh, before the writer locks.
          await writeFile(f.file, invalid)
        }),
      ).rejects.toMatchObject({
        code: 'settings-invalid-value',
        message: "That value isn't allowed for this setting.",
      })
      expect(await readFile(f.file, 'utf8')).toBe(invalid)
    },
  )

  test.each(['key', 'file'] as const)(
    'floor edits use the declared default when the %s disappears after the last read',
    async (missing) => {
      const f = await fixture({
        killswitch_account_floors: [
          floor('alpha', 'opencode'),
          floor('beta', 'pi'),
        ],
      })
      await f.port.update(async (settings) => {
        setFloor(settings, 'alpha', 71, 72)
        if (missing === 'file') await rm(f.file)
        else await writeFile(f.file, '{}')
      })
      expect(await f.saved()).toEqual([floor('alpha', 'opencode', 71, 72)])
    },
  )

  test.each(['unparseable', 'unreadable'])(
    'a floor edit refuses an %s file without writing',
    async (kind) => {
      const f = await fixture({
        killswitch_account_floors: [floor('alpha', 'opencode')],
      })
      if (kind === 'unparseable') await writeFile(f.file, '{broken')
      else {
        await rm(f.file)
        await mkdir(f.file)
      }
      const result = await floors(f.menu, 'alpha', 70, 80)
      expect({ ok: result.ok, code: result.code, text: result.text }).toEqual({
        ok: false,
        code: 'settings-invalid-value',
        text: "That value isn't allowed for this setting.",
      })
      if (kind === 'unparseable')
        expect(await readFile(f.file, 'utf8')).toBe('{broken')
      else
        expect(
          await readFile(f.file, 'utf8').catch((error) => error.code),
        ).toBe('EISDIR')
    },
  )
  test.each([
    [{ account: 'alpha', primary: 80, secondary: 90 }],
    [{ account: 'alpha', host: 'opencode', primary: 80 }],
    [floor('alpha', 'opencode'), floor('alpha', 'opencode', 80, 90)],
    [floor('main', 'both')],
  ])(
    'set and clear refuse a hand-written unusable list without watcher delivery: %j',
    async (...entries) => {
      const f = await fixture({
        killswitch_account_floors: [floor('alpha', 'opencode')],
      })
      const text = JSON.stringify({ killswitch_account_floors: entries })
      await writeFile(f.file, text)
      await f.snapshot.refresh()
      expect(f.snapshot.report().map((entry) => entry.keyPath[0])).toContain(
        'killswitch_account_floors',
      )
      for (const values of [
        [80, 90],
        [null, null],
        [30, 40],
      ] as const) {
        const result = await floors(f.menu, 'alpha', values[0], values[1])
        const { ok, code, text: message } = result
        expect({ ok, code, text: message }).toMatchObject({
          ok: false,
          code: 'settings-invalid-value',
          text: "That value isn't allowed for this setting.",
        })
        expect(await readFile(f.file, 'utf8')).toBe(text)
      }
    },
  )

  test('a valid entry added by hand survives the next edit of another account', async () => {
    const f = await fixture({ killswitch_account_floors: [] })
    const added = [
      floor('beta', 'pi', 73, 74),
      floor('beta', 'opencode', 81, 82),
    ]
    await writeFile(
      f.file,
      JSON.stringify({ killswitch_account_floors: added }),
    )
    expect((await floors(f.menu, 'alpha', 63, 64)).ok).toBe(true)
    expect(await f.saved()).toEqual([
      ...added,
      floor('alpha', 'opencode', 63, 64),
    ])
  })

  test.each(
    Object.keys(
      SETTINGS_DIAGNOSTICS_TEXT.refusal,
    ) as (keyof typeof SETTINGS_DIAGNOSTICS_TEXT.refusal)[],
  )(
    'renders %s without the path and applies no live side effect',
    async (code) => {
      const f = await fixture()
      let changed = 0
      let applied = 0
      f.snapshot.onChange(() => {
        if (f.snapshot.view().routing?.mode === 'ordered') changed++
      })
      const port = createBuiltinSettingsPort({
        file: f.file,
        host: f.host,
        snapshot: f.snapshot,
        log,
        writer: {
          ...f.handle,
          update: async () => {
            throw new SettingsRefusal(code, f.file)
          },
        },
      })
      const menu = createOpenAiMenu({
        store: store(),
        settings: port,
        afterApply() {
          applied++
        },
      })
      const before = await readFile(f.file, 'utf8')
      const result = await apply(menu, 'routing', 'mode', { mode: 'ordered' })
      expect(result).toMatchObject({
        ok: false,
        code,
        text: SETTINGS_DIAGNOSTICS_TEXT.refusal[code],
      })
      expect(result.text).not.toContain(f.file)
      expect(await readFile(f.file, 'utf8')).toBe(before)
      expect(changed).toBe(0)
      expect(applied).toBe(0)
      expect(f.snapshot.view().routing?.mode).toBe('main-first')
    },
  )
})

test('vault menu passes the port to Routing and Limits and rewrites or removes every entry for a vault id', async () => {
  const id = 'vault:alpha'
  const untouched = [floor('beta', 'pi'), floor('vault:other', 'pi')]
  const f = await fixture({
    killswitch_account_floors: [
      floor(id, 'both'),
      floor(id, 'pi', 80, 90),
      floor(id, 'opencode', 70, 80),
      ...untouched,
    ],
  })
  const vault = {
    authority: async () => 'vault',
    refresh: async () => ({ ok: true }),
    snapshot: () => ({}),
    status: async () => ({
      discovered: true,
      accounts: [
        { routeId: id, enabled: true, state: 'ready', credentialType: 'oauth' },
      ],
    }),
    identities: () => new Set(),
    routes: () => [{ id }],
  } as unknown as MenuVault
  const menu = createOpenAiMenu({ store: store(), vault, settings: f.port })
  expect((await apply(menu, 'routing', 'mode', { mode: 'ordered' })).ok).toBe(
    true,
  )
  expect(f.snapshot.view().routing?.mode).toBe('ordered')
  expect((await floors(menu, id, 50, 60)).ok).toBe(true)
  expect(await f.saved()).toEqual([...untouched, floor(id, 'both', 50, 60)])
  await writeFile(
    f.file,
    JSON.stringify({
      killswitch_account_floors: [
        floor(id, 'both'),
        floor(id, 'pi', 80, 90),
        floor(id, 'opencode', 70, 80),
        ...untouched,
      ],
    }),
  )
  expect((await floors(menu, id, null, null)).ok).toBe(true)
  expect(await f.saved()).toEqual(untouched)
  await writeFile(
    f.file,
    JSON.stringify({
      killswitch_account_floors: [floor(id, 'pi', 80, 90), ...untouched],
    }),
  )
  expect((await floors(menu, id, null, null)).ok).toBe(true)
  expect(await f.saved()).toEqual(untouched)
})
