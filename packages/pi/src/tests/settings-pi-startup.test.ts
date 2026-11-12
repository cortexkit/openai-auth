import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as commandEngine from '@cortexkit/common-auth/commands'
import { lockPathFor } from '@cortexkit/common-auth/fs'
import { openSettings } from '@cortexkit/common-auth/settings'
import type {
  PoolSettings,
  PoolStore,
  SettingsMutator,
} from '@cortexkit/common-auth/store'
import * as coreMenu from '@cortexkit/openai-auth-core'
import { getKillswitchThresholdsForAccount } from '@cortexkit/openai-auth-core/internal'
import { getSettingsAuthority } from '@cortexkit/openai-auth-core/settings-authority'
import { openaiSettings } from '@cortexkit/openai-auth-core/settings-definition'
import {
  SETTINGS_DIAGNOSTICS_TEXT,
  settingsReportLine,
} from '@cortexkit/openai-auth-core/settings-diagnostics'
import { resolveDefaultSettingsStores } from '@cortexkit/openai-auth-core/settings-install'
import * as records from '@cortexkit/openai-auth-core/settings-process-records'
import {
  createSettingsSnapshot,
  type SettingsSnapshot,
} from '@cortexkit/openai-auth-core/settings-snapshot'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import * as commands from '../commands.ts'
import extension from '../index.ts'
import { PiOpenAIRuntime, type PiPoolCommands } from '../runtime.ts'
import {
  type PiSettingsStartup,
  preparePiSettingsStartup,
} from '../settings-startup.ts'
import { getPiAccountPaths } from '../store-paths.ts'

const envNames = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_OPENAI_AUTH_FILE',
  'PI_OPENAI_AUTH_STATE_FILE',
  'PI_OPENAI_AUTH_SETTINGS_FILE',
  'CORTEXKIT_VAULT_HOST',
] as const
const log = { warn(_message: string) {}, info(_message: string) {} }
const invocation = { notify() {} }
let folder: string
let previous: Array<string | undefined>
const snapshots: SettingsSnapshot[] = []
beforeEach(() => {
  previous = envNames.map((key) => process.env[key])
  folder =
    process.env.PI_SETTINGS_STARTUP_CHILD === '1'
      ? process.env.HOME!
      : mkdtempSync(join(tmpdir(), 'pi-settings-startup-'))
  for (const key of envNames) delete process.env[key]
  process.env.HOME = folder
  process.env.USERPROFILE = folder
  process.env.APPDATA = join(folder, 'appdata')
  process.env.XDG_CONFIG_HOME = join(folder, 'config')
  process.env.XDG_STATE_HOME = join(folder, 'state')
})

// Bun caches homedir(), so each default-install scenario needs a fresh process.
function isolatedTest(name: string, run: () => unknown | Promise<unknown>) {
  test(name, async () => {
    if (process.env.PI_SETTINGS_STARTUP_CHILD === '1') {
      await run()
      return
    }
    const child = spawnSync(
      process.execPath,
      [
        'test',
        import.meta.path,
        '-t',
        `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PI_SETTINGS_STARTUP_CHILD: '1' },
      },
    )
    if (child.error) throw child.error
    if (child.status !== 0) {
      const output = `${child.stdout}\n${child.stderr}`
        .split('\n')
        .filter(
          (line) =>
            !/^\s*(Ran \d+ tests? across|\d+ (pass|fail|skip)$|\d+ expect\(\) calls)/.test(
              line,
            ),
        )
        .join('\n')
      throw new Error(output)
    }
    expect(child.status).toBe(0)
  })
}
afterEach(() => {
  for (const snapshot of snapshots.splice(0)) snapshot.dispose()
  envNames.forEach((key, index) => {
    const value = previous[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  rmSync(folder, { recursive: true, force: true })
})

function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

async function startup() {
  const result = await preparePiSettingsStartup({ log })
  if (result.snapshot) snapshots.push(result.snapshot)
  return result
}

function pool(settings: PoolSettings = {}, vaultMode = false) {
  let saved = structuredClone(settings)
  const store = {
    read: async () => ({
      status: 'ready',
      rows: [{ id: 'alpha', enabled: true }],
    }),
    readSettings: async () => ({
      status: 'ready',
      settings: structuredClone(saved),
    }),
    updateSettings: async (mutator: SettingsMutator) => {
      const next = structuredClone(saved)
      saved = (await mutator(next)) ?? next
      return { status: 'ready', settings: structuredClone(saved) }
    },
  } as unknown as PoolStore
  const authority = async () =>
    vaultMode ? ('vault' as const) : ('local' as const)
  const support = {
    store: () => store,
    readAuthority: authority,
    vaultMode: () => vaultMode,
    reload: async () => {},
    mainIdentity: () => undefined,
    mainQuota: () => undefined,
    vault: {
      name: 'pi-test',
      authority,
      refresh: async () => ({ ok: true }),
      snapshot: () => ({}),
      status: async () => ({
        discovered: true,
        accounts: vaultMode
          ? [
              {
                routeId: 'vault:alpha',
                enabled: true,
                state: 'ready',
                credentialType: 'oauth',
              },
            ]
          : [],
      }),
      identities: () => new Set(),
      routes: () => (vaultMode ? [{ id: 'vault:alpha' }] : []),
    },
  } as unknown as PiPoolCommands
  return { support, saved: () => saved }
}

const menuFor = (result: PiSettingsStartup, support = pool().support) =>
  commands.createPiMenu(support, { settingsStartup: result })
const edit = (
  menu: commandEngine.CommandMenu,
  sectionId: string,
  actionId: string,
  values: commandEngine.CommandApplyRequest['values'],
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
const diagnostics = async (menu: commandEngine.CommandMenu) =>
  (await menu.open(invocation)).menu.sections.find(
    (section) => section.id === 'diagnostics',
  )!

for (const kind of ['none', 'config', 'state', 'both']) {
  isolatedTest(
    `core default Pi paths match the host with ${kind} XDG homes and no agent override`,
    () => {
      if (kind !== 'config' && kind !== 'both')
        delete process.env.XDG_CONFIG_HOME
      if (kind !== 'state' && kind !== 'both') delete process.env.XDG_STATE_HOME
      delete process.env.PI_CODING_AGENT_DIR
      const { host, ...paths } = resolveDefaultSettingsStores()[1]
      expect(host).toBe('pi')
      expect(paths).toEqual(getPiAccountPaths())
      expect(paths.configPath).toBe(
        join(homedir(), '.pi', 'agent', 'openai-auth.json'),
      )
    },
  )
}

isolatedTest(
  'fresh Pi records shared without a move or file and its first local floor edit creates the template with the Pi tag',
  async () => {
    const result = await startup()
    expect(result.authority).toMatchObject({
      decision: 'shared',
      ranMove: false,
    })
    const file = result.authority!.install.target
    expect(existsSync(file)).toBe(false)
    expect(
      JSON.parse(
        readFileSync(
          join(records.piProcessRecordDir(), `${process.pid}.json`),
          'utf8',
        ),
      ).settings,
    ).toBe('shared')
    const local = pool()
    const menu = menuFor(result, local.support)
    expect(
      (
        await edit(
          menu,
          'limits',
          'floors',
          { primary: 30, secondary: 40 },
          'alpha',
        )
      ).ok,
    ).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('//')
    expect(result.snapshot!.get('killswitch_account_floors')).toEqual([
      { account: 'alpha', host: 'pi', primary: 30, secondary: 40 },
    ])
    const other = await createSettingsSnapshot({
      handle: openSettings(openaiSettings, {
        file,
        log,
        separateInstall: false,
      }),
      file,
      host: 'opencode',
    })
    snapshots.push(other)
    expect(getKillswitchThresholdsForAccount(other.view(), 'alpha')).toEqual({
      primary: 5,
      secondary: 10,
    })
    expect(local.saved()).toEqual({})
    expect(existsSync(result.paths.configPath)).toBe(false)
  },
)

isolatedTest(
  'Pi vault-menu floor edits write one both entry and preserve the other host floors',
  async () => {
    const paths = getPiAccountPaths()
    const target = join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')
    const untouched = {
      account: 'beta',
      host: 'opencode' as const,
      primary: 11,
      secondary: 22,
    }
    write(target, {
      killswitch_account_floors: [
        untouched,
        { account: 'vault:alpha', host: 'pi', primary: 1, secondary: 2 },
        { account: 'vault:alpha', host: 'opencode', primary: 3, secondary: 4 },
      ],
    })
    const result = await startup()
    expect(result.paths).toEqual(paths)
    expect(
      (
        await edit(
          menuFor(result, pool({}, true).support),
          'limits',
          'floors',
          { primary: 50, secondary: 60 },
          'vault:alpha',
        )
      ).ok,
    ).toBe(true)
    expect(result.snapshot!.get('killswitch_account_floors')).toEqual([
      untouched,
      { account: 'vault:alpha', host: 'both', primary: 50, secondary: 60 },
    ])
  },
)

isolatedTest(
  'Pi passes its config path to the shared vault-menu migration helper',
  async () => {
    const result = await startup()
    const create = spyOn(coreMenu, 'createOpenAiMenu')
    try {
      menuFor(result)
      const options = create.mock.calls[0]![0]
      expect(options.configPath).toBe(result.paths.configPath)
      expect(options.settings).toBeDefined()
      expect(options.vault).toBeDefined()
    } finally {
      create.mockRestore()
    }
  },
)

isolatedTest(
  'a default Pi start moves its present store before menus read the shared preferences',
  async () => {
    const paths = getPiAccountPaths()
    const old = JSON.stringify({
      version: 1,
      accounts: [],
      routing: { mode: 'sticky-balanced' },
      killswitch: { enabled: true },
    })
    write(paths.configPath, old)
    const result = await startup()
    expect(result.authority).toMatchObject({
      decision: 'shared',
      ranMove: true,
      move: { outcome: 'moved' },
    })
    expect(result.snapshot!.view().routing?.mode).toBe('sticky-balanced')
    expect(result.snapshot!.view().killswitch?.enabled).toBe(true)
    expect(readFileSync(paths.configPath, 'utf8')).toBe(old)
    expect(existsSync(`${paths.configPath}.MOVED_READPLEASE`)).toBe(true)
    expect((await diagnostics(menuFor(result))).lines).toEqual([
      SETTINGS_DIAGNOSTICS_TEXT.file(result.authority!.install.target),
      SETTINGS_DIAGNOSTICS_TEXT.sharedMoved,
    ])
  },
)

isolatedTest(
  'repeated Pi instances use the first authority target for the same config path',
  async () => {
    const first = await startup()
    write(first.authority!.install.target, { routing_mode: 'ordered' })
    const alternate = join(folder, 'alternate-settings.jsonc')
    write(alternate, { routing_mode: 'fallback-first' })
    process.env.PI_OPENAI_AUTH_SETTINGS_FILE = alternate
    const second = await startup()
    expect(second.authority).toBe(first.authority)
    expect(second.snapshot!.view().routing?.mode).toBe('ordered')
  },
)

isolatedTest(
  'Pi awaits authority publication under the lock before registering /openai or constructing the runtime',
  async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const recording = new Promise<void>((resolve) => {
      entered = resolve
    })
    const record = records.recordPiProcessSettings
    const publish = spyOn(
      records,
      'recordPiProcessSettings',
    ).mockImplementation(async (input) => {
      expect(
        existsSync(
          lockPathFor(
            join(records.settingsProcessRoot(), 'settings-authority'),
            'settings-authority',
          ),
        ),
      ).toBe(true)
      const path = await record(input)
      entered()
      await barrier
      return path
    })
    const sync = spyOn(
      PiOpenAIRuntime.prototype,
      'syncVaultSlot',
    ).mockResolvedValue()
    const support = spyOn(PiOpenAIRuntime.prototype, 'commandSupport')
    const registered: string[] = []
    const providers: string[] = []
    let shutdown: (() => Promise<void>) | undefined
    const loading = extension({
      registerCommand(name: string) {
        registered.push(name)
      },
      registerProvider(name: string) {
        providers.push(name)
      },
      on(name: string, handler: () => Promise<void>) {
        if (name === 'session_shutdown') shutdown = handler
      },
    } as never)
    try {
      await recording
      expect(registered).toEqual([])
      expect(support).not.toHaveBeenCalled()
      release()
      await loading
      expect(registered).toEqual(['openai'])
      expect(providers).toEqual(['openai-codex'])
      expect(
        existsSync(
          lockPathFor(
            join(records.settingsProcessRoot(), 'settings-authority'),
            'settings-authority',
          ),
        ),
      ).toBe(false)
      expect(
        JSON.parse(
          readFileSync(
            join(records.piProcessRecordDir(), `${process.pid}.json`),
            'utf8',
          ),
        ),
      ).toMatchObject({ settings: 'shared', pid: process.pid })
    } finally {
      release()
      await loading
      await shutdown?.()
      publish.mockRestore()
      sync.mockRestore()
      support.mockRestore()
    }
  },
)

isolatedTest(
  'a refused Pi entry registers a store-free /openai with read-only Diagnostics and never constructs the runtime',
  async () => {
    const paths = getPiAccountPaths()
    const old = JSON.stringify({
      version: 1,
      accounts: [],
      routing: { mode: 'sticky-balanced' },
    })
    write(paths.configPath, old)
    const other = resolveDefaultSettingsStores()[0].configPath
    const otherText = JSON.stringify({
      version: 1,
      accounts: [],
      killswitch: { enabled: true },
    })
    write(other, otherText)
    write(records.settingsProcessRoot(), 'not a folder')
    const support = spyOn(PiOpenAIRuntime.prototype, 'commandSupport')
    const sync = spyOn(PiOpenAIRuntime.prototype, 'syncVaultSlot')
    const register = spyOn(commands, 'registerCommands')
    const create = spyOn(commandEngine, 'createCommandMenu')
    let rendered: commandEngine.CommandDialogPayload | undefined
    const render = spyOn(commandEngine, 'runPiCommandMenu').mockImplementation(
      async (menu) => {
        rendered = await menu.open(invocation)
      },
    )
    let command: Parameters<ExtensionAPI['registerCommand']>[1] | undefined
    const providers: string[] = []
    try {
      await extension({
        registerCommand(name: string, value: typeof command) {
          expect(name).toBe('openai')
          command = value
        },
        registerProvider(name: string) {
          providers.push(name)
        },
      } as never)
      expect(command).toBeDefined()
      expect(providers).toEqual([])
      expect(support).not.toHaveBeenCalled()
      expect(sync).not.toHaveBeenCalled()
      const result = register.mock.calls[0]![1]!.settingsStartup!
      expect(result.refusal?.name).toBe('SettingsAuthorityRefusal')
      await command!.handler('', {
        ui: {},
        sessionManager: { getSessionId: () => 'test-session' },
      } as unknown as ExtensionCommandContext)
      const options = create.mock.calls[0]![0]
      expect(options.store).toBeUndefined()
      expect(Object.keys(options.replace!)).toEqual([
        'accounts',
        'quota',
        'routing',
        'limits',
      ])
      expect(rendered!.menu.sections.map((section) => section.id)).toEqual([
        'accounts',
        'quota',
        'routing',
        'limits',
        'diagnostics',
      ])
      for (const section of rendered!.menu.sections.slice(0, 4)) {
        expect(section.lines).toEqual([
          "Unavailable: openai-auth didn't start. See Diagnostics.",
        ])
        expect(section.items).toEqual([])
        expect(section.actions).toEqual([])
      }
      const section = rendered!.menu.sections.at(-1)!
      const cause = result.refusal!.cause as Error
      expect(section.lines).toEqual([
        SETTINGS_DIAGNOSTICS_TEXT.refused(
          records.settingsProcessRoot(),
          cause.message,
        ),
      ])
      expect(section.actions).toEqual([])
      expect(section.lines.join('\n')).toContain(records.settingsProcessRoot())
      expect(section.lines.join('\n')).toMatch(/EEXIST|ENOTDIR/)
      expect(readFileSync(paths.configPath, 'utf8')).toBe(old)
      expect(readFileSync(other, 'utf8')).toBe(otherText)
      expect(
        existsSync(join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')),
      ).toBe(false)
    } finally {
      support.mockRestore()
      sync.mockRestore()
      register.mockRestore()
      create.mockRestore()
      render.mockRestore()
    }
  },
)

for (const decision of ['separate', 'legacy'] as const) {
  isolatedTest(
    `${decision} Pi keeps its store writer and passes no shared settings port`,
    async () => {
      if (decision === 'separate')
        process.env.PI_CODING_AGENT_DIR = join(folder, 'isolated-agent')
      const paths = getPiAccountPaths()
      write(paths.configPath, {
        version: 1,
        accounts: [],
        routing: { mode: 'ordered' },
      })
      if (decision === 'legacy') {
        write(join(records.piProcessRecordDir(), `${process.ppid}.json`), {
          pid: process.ppid,
          version: records.SETTINGS_ADOPTING_VERSION,
          settings: 'legacy',
          startedAt: Date.now(),
        })
      }
      const result = await startup()
      expect(result.authority!.decision).toBe(decision)
      expect(result.snapshot).toBeUndefined()
      const local = pool({ routing: { mode: 'ordered' } })
      const create = spyOn(coreMenu, 'createOpenAiMenu')
      try {
        const menu = menuFor(result, local.support)
        expect(create.mock.calls[0]![0].settings).toBeUndefined()
        expect(create.mock.calls[0]![0].configPath).toBe(paths.configPath)
        expect(
          (await edit(menu, 'routing', 'mode', { mode: 'sticky-balanced' })).ok,
        ).toBe(true)
        expect(local.saved().routing).toMatchObject({ mode: 'sticky-balanced' })
        const section = await diagnostics(menu)
        expect(section.actions).toEqual([])
        if (decision === 'separate')
          expect(section.lines).toEqual([SETTINGS_DIAGNOSTICS_TEXT.separate])
        else
          expect(section.lines).toEqual([
            SETTINGS_DIAGNOSTICS_TEXT.file(result.authority!.install.target),
            SETTINGS_DIAGNOSTICS_TEXT.legacyProcess,
          ])
      } finally {
        create.mockRestore()
      }
    },
  )
}

isolatedTest(
  'Pi Diagnostics uses the core table, refreshes report and semantic errors, and adds no Cache, dump or log actions',
  async () => {
    const result = await startup()
    const menu = menuFor(result)
    const file = result.authority!.install.target
    expect((await diagnostics(menu)).lines).toEqual([
      SETTINGS_DIAGNOSTICS_TEXT.file(file),
      SETTINGS_DIAGNOSTICS_TEXT.sharedMissing,
    ])
    write(file, {
      routing_mode: 'invalid',
      killswitch_account_floors: [
        { account: 'main', host: 'both', primary: 20, secondary: 30 },
      ],
    })
    const section = await diagnostics(menu)
    expect(
      result.snapshot!.report().map((entry) => entry.keyPath[0]),
    ).toContain('routing_mode')
    expect(
      result.snapshot!.report().map((entry) => entry.keyPath[0]),
    ).toContain('killswitch_account_floors')
    expect(section.lines).toEqual([
      SETTINGS_DIAGNOSTICS_TEXT.file(file),
      SETTINGS_DIAGNOSTICS_TEXT.sharedFound,
      ...result.snapshot!.report().map(settingsReportLine),
    ])
    expect(section.actions).toEqual([])
    const model = (await menu.open(invocation)).menu
    expect(model.sections.slice(0, 5).map((item) => item.id)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
      'diagnostics',
    ])
    expect(model.sections.some((item) => item.id === 'cache')).toBe(false)
    expect(
      model.sections.flatMap((item) => item.actions).map((action) => action.id),
    ).not.toContain('dump')
    expect(
      model.sections.flatMap((item) => item.actions).map((action) => action.id),
    ).not.toContain('logging')
  },
)

isolatedTest(
  'Pi Diagnostics keeps the pre-existing-file notice only while its conditions hold and logs it once',
  async () => {
    const paths = getPiAccountPaths()
    write(paths.configPath, {
      version: 1,
      accounts: [],
      routing: { mode: 'ordered' },
    })
    const file = join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')
    write(file, {})
    const warn = spyOn(log, 'warn')
    try {
      const result = await startup()
      const menu = menuFor(result)
      const expected = [
        SETTINGS_DIAGNOSTICS_TEXT.file(file),
        SETTINGS_DIAGNOSTICS_TEXT.sharedFound,
        SETTINGS_DIAGNOSTICS_TEXT.preExistingFile(file),
      ]
      expect((await diagnostics(menu)).lines).toEqual(expected)
      expect((await diagnostics(menu)).lines).toEqual(expected)
      expect(warn.mock.calls).toEqual([
        [SETTINGS_DIAGNOSTICS_TEXT.preExistingFile(file)],
      ])
      write(
        `${paths.configPath}.MOVED_READPLEASE`,
        `Settings moved to ${file}.\nA rollback loses changes made after the move.\n`,
      )
      expect((await diagnostics(menu)).lines).toEqual(expected.slice(0, 2))
    } finally {
      warn.mockRestore()
    }
  },
)

isolatedTest(
  'Pi Diagnostics shows a removed-file notice until a menu edit recreates the file',
  async () => {
    const paths = getPiAccountPaths()
    const file = join(folder, 'config', 'cortexkit', 'openai-auth.jsonc')
    write(paths.configPath, { version: 1, accounts: [] })
    write(
      `${paths.configPath}.MOVED_READPLEASE`,
      `Settings moved to ${file}.\nA rollback loses changes made after the move.\n`,
    )
    const result = await startup()
    expect(result.authority!.ranMove).toBe(false)
    const menu = menuFor(result)
    expect((await diagnostics(menu)).lines).toEqual([
      SETTINGS_DIAGNOSTICS_TEXT.file(file),
      SETTINGS_DIAGNOSTICS_TEXT.sharedMissing,
      SETTINGS_DIAGNOSTICS_TEXT.removedFile(file),
    ])
    expect((await edit(menu, 'routing', 'mode', { mode: 'ordered' })).ok).toBe(
      true,
    )
    expect((await diagnostics(menu)).lines).toEqual([
      SETTINGS_DIAGNOSTICS_TEXT.file(file),
      SETTINGS_DIAGNOSTICS_TEXT.sharedFound,
    ])
  },
)

isolatedTest(
  'Pi startup and menu never read an OpenCode environment variable',
  async () => {
    const original = process.env
    process.env = new Proxy(original, {
      get(target, key) {
        if (typeof key === 'string' && key.startsWith('OPENCODE_'))
          throw new Error(`Pi read ${key}`)
        return Reflect.get(target, key)
      },
    })
    try {
      const result = await startup()
      expect(await getSettingsAuthority(result.paths.configPath)).toBe(
        result.authority,
      )
      expect((await menuFor(result).open(invocation)).command).toBe('openai')
    } finally {
      process.env = original
    }
  },
)
