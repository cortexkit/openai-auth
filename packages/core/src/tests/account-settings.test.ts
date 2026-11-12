import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openSettings } from '@cortexkit/common-auth/settings'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  loadAccountSettings,
  loadAccounts,
  mutateAccounts,
  saveAccounts,
} from '../accounts'
import {
  createOpenAiMenu,
  migrateLegacySettings,
  settingsMutateAccounts,
  withSettingsMigration,
} from '../commands'
import { flushForTest, initLogger, resetLoggerForTest } from '../logger'
import { maxSameAccountWait } from '../routing-wait'
import { recordSettingsDecision } from '../settings-decisions'
import { openaiSettings } from '../settings-definition'
import { createBuiltinSettingsPort } from '../settings-port'
import { createSettingsSnapshot } from '../settings-snapshot'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openai-settings-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('settings read neither credential state nor config account rows or runtime fields', async () => {
  const configPath = join(dir, 'openai-auth.json')
  const statePath = join(dir, 'openai-auth-state.json')
  const config = JSON.stringify({
    version: 1,
    accounts: [{ id: 'local', refresh: 'legacy-secret' }],
    commonAuthPool: { rows: { local: {} } },
    mainAccountId: 'local-identity',
    reset: { local: {} },
    routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
    commonAuthLimits: {
      schemaVersion: 1,
      namespace: 'foreign',
      marks: ['untouched'],
    },
    logging: { level: 'debug' },
    cacheKeep: { enabled: true },
    refresh: { enabled: false, mainRefreshLeaseTokenHash: 'local-lease' },
    quota: { enabled: true, mainQuotaToken: 'local-token' },
    killswitch: { enabled: true, defaults: { primary: 95 } },
  })
  writeFileSync(configPath, config)
  writeFileSync(statePath, '{broken')
  const parse = JSON.parse
  const parsed = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const result = parse(text, reviver)
    if (text === config)
      for (const key of ['accounts', 'commonAuthPool'])
        Object.defineProperty(result, key, {
          get() {
            throw new Error('settings inspected local rows')
          },
        })
    return result
  })
  const reads = spyOn(fsp, 'readFile')
  try {
    const settings = await loadAccountSettings({ configPath })
    expect(settings).toMatchObject({
      version: 1,
      accounts: [],
      routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
      logging: { level: 'debug' },
      cacheKeep: { enabled: true },
      refresh: { enabled: false },
      quota: { enabled: true },
      killswitch: { enabled: true, defaults: { primary: 95 } },
    })
    expect(settings?.mainAccountId).toBeUndefined()
    expect(settings?.reset).toBeUndefined()
    expect(settings?.refresh?.mainRefreshLeaseTokenHash).toBeUndefined()
    expect(settings?.quota?.mainQuotaToken).toBeUndefined()
    expect(reads.mock.calls.map(([path]) => path)).toEqual([configPath])
    expect(readFileSync(configPath, 'utf8')).toBe(config)
    expect(readFileSync(statePath, 'utf8')).toBe('{broken')
  } finally {
    parsed.mockRestore()
    reads.mockRestore()
  }
})

test.each([undefined, '15', 0, 15, 'max'])(
  'same-account wait %s round-trips with exact menu choices and no limits-envelope changes',
  async (value) => {
    const configPath = join(dir, 'openai-auth.json')
    const statePath = join(dir, 'openai-auth-state.json')
    const envelope = {
      schemaVersion: 1,
      namespace: 'foreign',
      generation: 'saved',
      revision: 2,
      marks: [{ sentinel: true }],
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        commonAuthPool: { schemaVersion: 1, rows: {} },
        routing: { mode: 'ordered', maxSameAccountWait: value },
        commonAuthLimits: envelope,
      }),
    )
    const state = JSON.stringify({
      version: 1,
      accounts: {},
      commonAuthLimits: envelope,
    })
    writeFileSync(statePath, state)
    const store = await openPoolStore({
      configPath,
      statePath,
      provider: 'openai',
      quota: quotaCodec,
    })
    const menu = createOpenAiMenu({ store })
    const invocation = { sessionId: 's', notify() {} }
    const opened = await menu.open(invocation)
    const routing = opened.menu.sections.find(
      (section) => section.id === 'routing',
    )!
    const action = routing.actions?.find(
      (entry) => entry.id === 'maxSameAccountWait',
    )
    if (!action) throw new Error('Missing same-account wait menu action')
    expect(action.label).toBe('Longest wait on the same account')
    expect(action.knobs).toEqual([
      {
        kind: 'choice',
        id: 'maxSameAccountWait',
        label: 'Longest wait on the same account',
        choices: [
          { value: '0', label: "Don't wait" },
          { value: '15', label: '15 minutes' },
          { value: 'max', label: 'Until the cache expires' },
        ],
        value: value === 0 ? '0' : value === 'max' ? 'max' : '15',
      },
    ])
    expect(maxSameAccountWait(await loadAccountSettings({ configPath }))).toBe(
      value === 0 || value === 'max' ? value : 15,
    )
    for (const setting of [0, 15, 'max'] as const) {
      const result = await menu.apply(
        {
          command: 'openai',
          sectionId: 'routing',
          actionId: 'maxSameAccountWait',
          values: { maxSameAccountWait: String(setting) },
        },
        invocation,
      )
      expect(result.ok).toBe(true)
      const saved = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(saved.routing.maxSameAccountWait).toBe(setting)
      expect(
        maxSameAccountWait(await loadAccountSettings({ configPath })),
      ).toBe(setting)
      expect(saved.commonAuthLimits).toEqual(envelope)
      expect(readFileSync(statePath, 'utf8')).toBe(state)
    }
  },
)

test('legacy settings migration preserves a limits envelope while normalizing unrelated settings', () => {
  const envelope = {
    schemaVersion: 1,
    namespace: 'vault',
    revision: 2,
    marks: ['saved'],
  }
  const settings = {
    cachekeep: { enabled: true },
    routing: { maxSameAccountWait: 0 },
    commonAuthLimits: envelope,
  }
  expect(migrateLegacySettings(settings, [])).toBe(true)
  expect(settings.commonAuthLimits).toEqual(envelope)
  expect(settings.routing.maxSameAccountWait).toBe(0)
})

test('missing or unparseable settings use defaults without rewriting config', async () => {
  const configPath = join(dir, 'openai-auth.json')
  const logPath = join(dir, 'settings.log')
  initLogger({ file: logPath, level: 'warn' })
  try {
    expect(await loadAccountSettings({ configPath })).toBeNull()
    writeFileSync(configPath, '{broken')
    expect(await loadAccountSettings({ configPath })).toBeNull()
    expect(await loadAccountSettings({ configPath })).toBeNull()
    expect(readFileSync(configPath, 'utf8')).toBe('{broken')
    await flushForTest()
    expect(readFileSync(logPath, 'utf8').match(/using defaults/g)).toHaveLength(
      1,
    )
  } finally {
    resetLoggerForTest()
  }
})

test.each(['shared', 'legacy', 'separate', undefined] as const)(
  'settings migration respects the config decision %s; an omitted identity retains old behavior',
  async (decision) => {
    const configPath = join(dir, 'old.json')
    const statePath = join(dir, 'old-state.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        commonAuthPool: { schemaVersion: 1, rows: {} },
        cachekeep: { enabled: true },
        killswitch: { enabled: true, main: { primary: 20 } },
      }),
    )
    if (decision) recordSettingsDecision(configPath, decision)
    const store = openPoolStore({
      configPath,
      statePath,
      provider: 'openai',
      quota: quotaCodec,
    })
    const wrapped = withSettingsMigration(
      store,
      decision === undefined ? undefined : configPath,
    )
    const read = await wrapped.readSettings()
    if (read.status === 'error') throw new Error('settings unavailable')
    expect(read.settings.cachekeep !== undefined).toBe(decision === 'shared')
    await settingsMutateAccounts(
      store,
      undefined,
      decision === undefined ? undefined : configPath,
    )(
      (storage) => {
        storage.reset = {}
      },
      { configPath, statePath },
    )
    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(saved.cachekeep !== undefined).toBe(decision === 'shared')
    expect(saved.killswitch.schema).toBe(
      decision === 'shared' ? undefined : 'floors-v1',
    )
    expect(saved.reset).toEqual({})
    if (decision === 'shared') {
      // Omitting identity must not inherit the decision from another wrapper.
      await withSettingsMigration(store).updateSettings(() => undefined)
      expect(JSON.parse(readFileSync(configPath, 'utf8')).cacheKeep).toEqual({
        enabled: true,
      })
    }
  },
)

test.each([
  ['shared', 'separate'],
  ['separate', 'shared'],
] as const)(
  'mixed instances in %s then %s order keep menu and direct writer authority config-scoped',
  async (first, second) => {
    const order = [first, second]
    const file = join(dir, 'shared.jsonc')
    const log = { warn() {}, info() {} }
    const handle = {
      ...openSettings(openaiSettings, {
        file,
        log,
        separateInstall: false,
        createMissing: true,
      }),
      watch: () => () => {},
    }
    const snapshot = await createSettingsSnapshot({
      handle,
      file,
      host: 'opencode',
    })
    const port = createBuiltinSettingsPort({
      file,
      host: 'opencode',
      snapshot,
      log,
    })
    const instances = new Map<
      string,
      {
        configPath: string
        statePath: string
        store: ReturnType<typeof openPoolStore>
      }
    >()
    try {
      for (const decision of order) {
        const configPath = join(dir, `${decision}.json`)
        const statePath = join(dir, `${decision}-state.json`)
        writeFileSync(
          configPath,
          JSON.stringify({
            version: 1,
            accounts: [],
            commonAuthPool: { schemaVersion: 1, rows: {} },
            routing: { mode: 'ordered', maxSameAccountWait: 0 },
            cachekeep: { enabled: true },
          }),
        )
        recordSettingsDecision(configPath, decision)
        instances.set(decision, {
          configPath,
          statePath,
          store: openPoolStore({
            configPath,
            statePath,
            provider: 'openai',
            quota: quotaCodec,
          }),
        })
      }
      for (const [decision, instance] of instances) {
        const menu = createOpenAiMenu({
          store: instance.store,
          configPath: instance.configPath,
          ...(decision === 'shared' ? { settings: port } : {}),
        })
        expect(
          (
            await menu.apply(
              {
                command: 'openai',
                sectionId: 'routing',
                actionId: 'mode',
                values: { mode: 'sticky-balanced' },
              },
              { notify() {} },
            )
          ).ok,
        ).toBe(true)
        await settingsMutateAccounts(
          instance.store,
          undefined,
          instance.configPath,
        )((storage) => {
          storage.reset = {}
        }, instance)
        for (const writer of ['save', 'mutate']) {
          if (writer === 'save') {
            const storage = (await loadAccounts(instance))!
            storage.routing = {
              mode: 'fallback-first',
              maxSameAccountWait: 'max',
            }
            await saveAccounts(storage, instance)
          } else {
            await mutateAccounts((storage) => {
              storage.routing = { mode: 'main-first', maxSameAccountWait: 15 }
            }, instance)
          }
          const saved = JSON.parse(readFileSync(instance.configPath, 'utf8'))
          expect(saved.routing.mode).toBe(
            decision === 'shared'
              ? 'ordered'
              : writer === 'save'
                ? 'fallback-first'
                : 'main-first',
          )
          expect(saved.routing.maxSameAccountWait).toBe(
            decision === 'shared' ? 0 : writer === 'save' ? 'max' : 15,
          )
          expect(saved.cachekeep !== undefined).toBe(decision === 'shared')
        }
      }
      expect(snapshot.view().routing?.mode).toBe('sticky-balanced')
    } finally {
      snapshot.dispose()
    }
  },
)
