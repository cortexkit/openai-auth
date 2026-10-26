import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSettings,
  isRequestDumpEnabled,
  refreshSettings,
  resetSettingsForTest,
} from '../config'
import { flushForTest } from '../logger'

describe('config resolution', () => {
  let tempDir: string
  let configPath: string
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    'OPENCODE_OPENAI_AUTH_FILE',
    'CORTEXKIT_OPENAI_AUTH_DUMP',
    'CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE',
    'OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES',
    'OPENCODE_OPENAI_AUTH_LOG_FILE',
    'OPENCODE_OPENAI_AUTH_LOG_LEVEL',
  ]

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    tempDir = await mkdtemp(join(tmpdir(), 'openai-auth-config-test-'))
    configPath = join(tempDir, 'openai-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    delete process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES
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

  describe('dump byte cap resolution', () => {
    test('defaults to 512 MiB', () => {
      resetSettingsForTest()
      expect(getSettings().dumpMaxBytes).toBe(512 * 1024 * 1024)
    })

    test('env overrides the config cap and zero disables the cap', async () => {
      await writeFile(configPath, JSON.stringify({ dumpMaxBytes: 4096 }))
      resetSettingsForTest()
      expect(getSettings().dumpMaxBytes).toBe(4096)
      process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES = ' 8192 '
      expect(refreshSettings().dumpMaxBytes).toBe(8192)
      process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES = '0'
      expect(refreshSettings().dumpMaxBytes).toBe(0)
    })

    test('invalid byte caps fall back to 512 MiB', async () => {
      await writeFile(configPath, JSON.stringify({ dumpMaxBytes: 4096 }))
      for (const raw of [
        '',
        ' ',
        '-1',
        '1.5',
        'NaN',
        'Infinity',
        '12MiB',
        '9007199254740992',
      ]) {
        process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES = raw
        expect(refreshSettings().dumpMaxBytes).toBe(512 * 1024 * 1024)
      }
      delete process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES
      for (const value of [-1, 0.5, '1024', null]) {
        await writeFile(configPath, JSON.stringify({ dumpMaxBytes: value }))
        expect(refreshSettings().dumpMaxBytes).toBe(512 * 1024 * 1024)
      }
    })

    test('warns only once for invalid caps even when settings are refreshed', async () => {
      await flushForTest()
      const log = join(tempDir, 'config.log')
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = log
      process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'warn'
      process.env.OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES = '-1'
      resetSettingsForTest()
      expect(getSettings().dumpMaxBytes).toBe(512 * 1024 * 1024)
      expect(refreshSettings().dumpMaxBytes).toBe(512 * 1024 * 1024)
      await flushForTest()
      const lines = (await readFile(log, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('Invalid dumpMaxBytes')
      expect(lines[0]).toContain('OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES')
    })
  })

  describe('live dump setting', () => {
    test('observes missing created changed deleted and malformed config without a refresh', async () => {
      delete process.env.CORTEXKIT_OPENAI_AUTH_DUMP
      resetSettingsForTest()
      expect(isRequestDumpEnabled()).toBe(false)
      await writeFile(configPath, JSON.stringify({ dump: { enabled: true } }))
      expect(isRequestDumpEnabled()).toBe(true)
      await writeFile(configPath, JSON.stringify({ dump: false }))
      expect(isRequestDumpEnabled()).toBe(false)
      await writeFile(configPath, JSON.stringify({ dump: true }))
      expect(isRequestDumpEnabled()).toBe(true)
      await writeFile(configPath, '{ malformed')
      expect(isRequestDumpEnabled()).toBe(false)
      await rm(configPath)
      expect(isRequestDumpEnabled()).toBe(false)
      await writeFile(configPath, JSON.stringify({ dump: true }))
      expect(isRequestDumpEnabled()).toBe(true)
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

    test('a config file that still sets the removed webSearch key loads normally', async () => {
      await writeFile(
        configPath,
        JSON.stringify({ webSearch: true, dump: true }),
      )
      resetSettingsForTest()
      expect(getSettings().dump).toBe(true)
      expect('webSearch' in getSettings()).toBe(false)
    })
  })
})
