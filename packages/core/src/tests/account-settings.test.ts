import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import { loadAccountSettings } from '../accounts'
import { createOpenAiMenu, migrateLegacySettings } from '../commands'
import { flushForTest, initLogger, resetLoggerForTest } from '../logger'
import { maxSameAccountWait } from '../routing-wait'

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
