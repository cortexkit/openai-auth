import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings, resetSettingsForTest } from '../config'

describe('config resolution', () => {
  let tempDir: string
  let configPath: string
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    'OPENCODE_OPENAI_AUTH_FILE',
    'CORTEXKIT_OPENAI_AUTH_DUMP',
    'CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH',
    'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
  ]

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    tempDir = await mkdtemp(join(tmpdir(), 'openai-auth-config-test-'))
    configPath = join(tempDir, 'openai-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    resetSettingsForTest()
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('dump setting resolution', () => {
    test('resolves dump: { enabled: true } to true', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          dump: { enabled: true },
        }),
      )
      resetSettingsForTest()
      expect(getSettings().dump).toBe(true)
    })

    test('resolves dump: { enabled: false } to false', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          dump: { enabled: false },
        }),
      )
      resetSettingsForTest()
      expect(getSettings().dump).toBe(false)
    })

    test('resolves dump: true to true', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          dump: true,
        }),
      )
      resetSettingsForTest()
      expect(getSettings().dump).toBe(true)
    })

    test('resolves dump: false to false', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          dump: false,
        }),
      )
      resetSettingsForTest()
      expect(getSettings().dump).toBe(false)
    })

    test('env override wins over config object', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          dump: { enabled: true },
        }),
      )
      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = 'false'
      resetSettingsForTest()
      expect(getSettings().dump).toBe(false)

      await writeFile(
        configPath,
        JSON.stringify({
          dump: { enabled: false },
        }),
      )
      process.env.CORTEXKIT_OPENAI_AUTH_DUMP = 'true'
      resetSettingsForTest()
      expect(getSettings().dump).toBe(true)
    })
  })

  describe('Responses Lite setting resolution', () => {
    test('defaults to false', () => {
      resetSettingsForTest()
      expect(getSettings().responsesLite).toBe(false)
    })

    test('reads the config value', async () => {
      await writeFile(configPath, JSON.stringify({ responsesLite: true }))
      resetSettingsForTest()
      expect(getSettings().responsesLite).toBe(true)
    })

    test('env overrides config', async () => {
      await writeFile(configPath, JSON.stringify({ responsesLite: true }))
      process.env.CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE = 'false'
      resetSettingsForTest()
      expect(getSettings().responsesLite).toBe(false)

      await writeFile(configPath, JSON.stringify({ responsesLite: false }))
      process.env.CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE = 'true'
      resetSettingsForTest()
      expect(getSettings().responsesLite).toBe(true)
    })
  })

  describe('envBool parser', () => {
    test('accepts documented truthy values (case-insensitive, trimmed)', () => {
      const truthyValues = ['1', 'true', 'yes', 'on', ' TRUE ', 'Yes', 'ON']
      for (const val of truthyValues) {
        process.env.CORTEXKIT_OPENAI_AUTH_DUMP = val
        resetSettingsForTest()
        expect(getSettings().dump).toBe(true)
      }
    })

    test('accepts documented falsey values (case-insensitive, trimmed)', () => {
      const falseyValues = [
        '0',
        'false',
        'no',
        'off',
        '',
        ' FALSE ',
        'No',
        'OFF',
        '   ',
      ]
      for (const val of falseyValues) {
        process.env.CORTEXKIT_OPENAI_AUTH_DUMP = val
        resetSettingsForTest()
        expect(getSettings().dump).toBe(false)
      }
    })

    test('ignores unrecognized values and falls through to config/default', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          dump: true,
        }),
      )

      const unrecognizedValues = ['flase', 'maybe', 'unknown', '2', 'yes-ish']
      for (const val of unrecognizedValues) {
        process.env.CORTEXKIT_OPENAI_AUTH_DUMP = val
        resetSettingsForTest()
        // Should fall through to config (true)
        expect(getSettings().dump).toBe(true)
      }
    })

    test('ignores unrecognized values for negative env (NO_WEB_SEARCH)', async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          webSearch: true,
        }),
      )

      // Unrecognized value should fall through to config (true)
      process.env.CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH = 'maybe'
      resetSettingsForTest()
      expect(getSettings().webSearch).toBe(true)

      // Documented truthy value (true) for NO_WEB_SEARCH disables webSearch
      process.env.CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH = 'true'
      resetSettingsForTest()
      expect(getSettings().webSearch).toBe(false)

      // Documented falsey value (false) for NO_WEB_SEARCH enables webSearch
      process.env.CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH = 'false'
      resetSettingsForTest()
      expect(getSettings().webSearch).toBe(true)
    })
  })
})
