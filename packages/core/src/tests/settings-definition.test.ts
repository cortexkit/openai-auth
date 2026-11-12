import { describe, expect, it } from 'bun:test'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  integer,
  list,
  number,
  object,
  oneOf,
  settingsJsonSchema,
  string,
} from '@cortexkit/common-auth/settings'
import { openaiSettings } from '../settings-definition.ts'

const settings = openaiSettings.settings

describe('settings declaration', () => {
  it('declares only user preferences with portable defaults', () => {
    expect(openaiSettings.plugin).toBe('openai-auth')
    expect(
      Object.fromEntries(
        Object.entries(settings).map(([name, setting]) => [
          name,
          setting.default,
        ]),
      ),
    ).toEqual({
      routing_mode: 'main-first',
      max_same_account_wait: '15m',
      fallback_on: [401, 403, 429],
      refresh_enabled: true,
      refresh_before_expiry_minutes: 240,
      quota_enabled: true,
      quota_check_interval_minutes: 5,
      quota_minimum_remaining: [],
      quota_fail_closed_on_unknown: false,
      cost_zeroing: true,
      killswitch_enabled: false,
      killswitch_default_primary: 5,
      killswitch_default_secondary: 10,
      killswitch_account_floors: [],
      cache_keep_enabled: false,
      cache_keep_subagents: false,
      cache_keep_sustain: false,
      cache_keep_window: [],
      log_level: 'default',
      request_dumps: false,
      dump_dir: '',
      dump_max_bytes: 536870912,
      web_sockets: false,
      raw_web_socket: false,
      responses_lite: false,
      codex_api_endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    })
    expect(openaiSettings).not.toHaveProperty('legacyProject')
    for (const [name, setting] of Object.entries(settings)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(setting.project).toBe('user-only')
      expect(setting).not.toHaveProperty('overrides.model')
      expect(setting).not.toHaveProperty('legacyProject')
    }
  })

  it('allows host overrides only for preferences read by both host families', () => {
    const both = [
      'routing_mode',
      'max_same_account_wait',
      'fallback_on',
      'refresh_before_expiry_minutes',
      'quota_enabled',
      'quota_minimum_remaining',
      'quota_fail_closed_on_unknown',
      'killswitch_enabled',
      'killswitch_default_primary',
      'killswitch_default_secondary',
    ]
    for (const [name, setting] of Object.entries(settings)) {
      if (both.includes(name))
        expect(setting).toHaveProperty('overrides', { host: true })
      else expect(setting).not.toHaveProperty('overrides')
    }
  })

  it('documents each setting according to its actual readers', () => {
    const readers = {
      routing_mode: 'OpenCode 1, OpenCode 2 and Pi',
      max_same_account_wait: 'OpenCode 1, OpenCode 2 and Pi',
      fallback_on: 'OpenCode 1 and Pi; not read by OpenCode 2',
      refresh_enabled: 'OpenCode 1 legacy fallback refresh only',
      refresh_before_expiry_minutes: 'OpenCode 1, OpenCode 2 and Pi',
      quota_enabled: 'OpenCode 1, OpenCode 2 and Pi',
      quota_check_interval_minutes:
        'OpenCode 1 legacy quota freshness and polling only',
      quota_minimum_remaining: 'OpenCode 1, OpenCode 2 and Pi',
      quota_fail_closed_on_unknown: 'OpenCode 1, OpenCode 2 and Pi',
      cost_zeroing: 'OpenCode 1 only',
      killswitch_enabled: 'OpenCode 1, OpenCode 2 and Pi',
      killswitch_default_primary: 'OpenCode 1, OpenCode 2 and Pi',
      killswitch_default_secondary: 'OpenCode 1, OpenCode 2 and Pi',
      killswitch_account_floors: 'OpenCode 1, OpenCode 2 and Pi',
      cache_keep_enabled: 'OpenCode 1 and OpenCode 2',
      cache_keep_subagents: 'OpenCode 1 and OpenCode 2',
      cache_keep_sustain: 'OpenCode 1 and OpenCode 2',
      cache_keep_window: 'OpenCode 1 and OpenCode 2',
      log_level: 'OpenCode 1 and OpenCode 2',
      request_dumps: 'OpenCode 1 and OpenCode 2',
      dump_dir: 'OpenCode 1 and OpenCode 2',
      dump_max_bytes: 'OpenCode 1 and OpenCode 2',
      web_sockets: 'OpenCode 1 only',
      raw_web_socket: 'OpenCode 1 only',
      responses_lite: 'OpenCode 1 and OpenCode 2',
      codex_api_endpoint: 'OpenCode 1 and OpenCode 2',
    } as const
    expect(
      Object.fromEntries(
        Object.entries(settings).map(([name, setting]) => [
          name,
          setting.hosts,
        ]),
      ),
    ).toEqual(readers)
  })

  it('uses readable routing, wait and logging choices', () => {
    expect(settings.routing_mode.value).toEqual(
      oneOf(['ordered', 'main-first', 'fallback-first', 'sticky-balanced']),
    )
    expect(settings.max_same_account_wait.value).toEqual(
      oneOf(['off', '15m', 'cache']),
    )
    expect(settings.log_level.value).toEqual(
      oneOf(['error', 'warn', 'info', 'debug', 'trace', 'default']),
    )
  })

  it('requires complete host-tagged floors without bounding their numbers', () => {
    expect(settings.killswitch_account_floors.value).toEqual(
      list(
        object({
          account: string(),
          host: oneOf(['opencode', 'pi', 'both']),
          primary: number(),
          secondary: number(),
        }),
      ),
    )
    expect(settings.killswitch_default_primary.value).toEqual(number())
    expect(settings.killswitch_default_secondary.value).toEqual(number())
  })

  it('keeps absent quota windows and warm windows as empty lists', () => {
    expect(settings.quota_minimum_remaining.value).toEqual(
      list(
        object({ window: oneOf(['primary', 'secondary']), floor: number() }),
      ),
    )
    expect(settings.cache_keep_window.value).toEqual(
      list(
        object({
          start_hour: integer({ min: 0, max: 23 }),
          end_hour: integer({ min: 0, max: 23 }),
        }),
      ),
    )
    expect(settings.quota_check_interval_minutes.value).toEqual(
      number({ min: 1 }),
    )
    expect(settings.dump_max_bytes.value).toEqual(
      integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    )
  })

  it('preserves legacy metadata for both cache spellings and quota aliases', () => {
    expect(settings.cache_keep_enabled.legacy).toEqual([
      { source: 'opencode-store', path: ['cacheKeep', 'enabled'] },
      { source: 'opencode-store', path: ['cachekeep', 'enabled'] },
    ])
    expect(settings.quota_minimum_remaining.legacy).toEqual(
      ['opencode-store', 'pi-store'].flatMap((source) => [
        { source, path: ['quota', 'minimumRemaining', 'primary'] },
        { source, path: ['quota', 'minimumRemaining', '5h'] },
        { source, path: ['quota', 'minimumRemaining', 'secondary'] },
        { source, path: ['quota', 'minimumRemaining', '1w'] },
      ]),
    )
  })

  it('matches the generated schema under a fixed JSON serialization', () => {
    const shipped = readFileSync(
      new URL('../../openai-auth.schema.json', import.meta.url),
      'utf8',
    )
    expect(`${JSON.stringify(JSON.parse(shipped), null, 2)}\n`).toBe(
      `${JSON.stringify(settingsJsonSchema(openaiSettings), null, 2)}\n`,
    )
  })

  it.each(['opencode', 'pi'])('exposes the settings subpath to %s', (host) => {
    const from = fileURLToPath(new URL(`../../../${host}/`, import.meta.url))
    const resolved = Bun.resolveSync(
      '@cortexkit/openai-auth-core/settings-definition',
      from,
    )
    expect(realpathSync(resolved)).toBe(
      realpathSync(
        fileURLToPath(new URL('../settings-definition.ts', import.meta.url)),
      ),
    )
  })
})
