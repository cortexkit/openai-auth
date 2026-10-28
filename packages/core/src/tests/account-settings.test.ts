import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccountSettings } from '../accounts'
import { flushForTest, initLogger, resetLoggerForTest } from '../logger'

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
    routing: { mode: 'fallback-first' },
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
      routing: { mode: 'fallback-first' },
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
