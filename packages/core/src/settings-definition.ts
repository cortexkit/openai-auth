import {
  boolean,
  defineSettings,
  integer,
  list,
  number,
  object,
  oneOf,
  string,
} from '@cortexkit/common-auth/settings'

const shared = {
  hosts: 'OpenCode 1, OpenCode 2 and Pi',
  project: 'user-only',
} as const
const both = { ...shared, overrides: { host: true } } as const
const opencode = {
  hosts: 'OpenCode 1 and OpenCode 2',
  project: 'user-only',
} as const
const opencode1 = { hosts: 'OpenCode 1 only', project: 'user-only' } as const

const legacyFrom = (sources: readonly string[], paths: string[][]) =>
  sources.flatMap((source) => paths.map((path) => ({ source, path })))
const legacy = (...paths: string[][]) =>
  legacyFrom(['opencode-store', 'pi-store'], paths)
const opencodeLegacy = (...paths: string[][]) =>
  legacyFrom(['opencode-store'], paths)

export const openaiSettings = defineSettings({
  plugin: 'openai-auth',
  settings: {
    routing_mode: {
      ...both,
      value: oneOf([
        'ordered',
        'main-first',
        'fallback-first',
        'sticky-balanced',
      ]),
      default: 'main-first',
      legacy: legacy(['routing', 'mode']),
    },
    max_same_account_wait: {
      ...both,
      value: oneOf(['off', '15m', 'cache']),
      default: '15m',
      legacy: legacy(['routing', 'maxSameAccountWait']),
    },
    fallback_on: {
      ...both,
      hosts: 'OpenCode 1 and Pi; not read by OpenCode 2',
      value: list(integer()),
      default: [401, 403, 429],
      legacy: legacy(['fallbackOn']),
    },
    refresh_enabled: {
      ...opencode1,
      hosts: 'OpenCode 1 legacy fallback refresh only',
      value: boolean(),
      default: true,
      legacy: opencodeLegacy(['refresh', 'enabled']),
    },
    refresh_before_expiry_minutes: {
      ...both,
      value: number(),
      default: 240,
      legacy: legacy(['refresh', 'refreshBeforeExpiryMinutes']),
    },
    quota_enabled: {
      ...both,
      value: boolean(),
      default: true,
      legacy: legacy(['quota', 'enabled']),
    },
    quota_check_interval_minutes: {
      ...opencode1,
      hosts: 'OpenCode 1 legacy quota freshness and polling only',
      value: number({ min: 1 }),
      default: 5,
      legacy: opencodeLegacy(['quota', 'checkIntervalMinutes']),
    },
    quota_minimum_remaining: {
      ...both,
      // Missing windows have different defaults in eligibility and refresh scheduling.
      value: list(
        object({ window: oneOf(['primary', 'secondary']), floor: number() }),
      ),
      default: [],
      legacy: legacy(
        ['quota', 'minimumRemaining', 'primary'],
        ['quota', 'minimumRemaining', '5h'],
        ['quota', 'minimumRemaining', 'secondary'],
        ['quota', 'minimumRemaining', '1w'],
      ),
    },
    quota_fail_closed_on_unknown: {
      ...both,
      value: boolean(),
      default: false,
      legacy: legacy(['quota', 'failClosedOnUnknownQuota']),
    },
    cost_zeroing: {
      ...opencode1,
      value: boolean(),
      default: true,
      legacy: opencodeLegacy(['costZeroing', 'enabled']),
    },
    killswitch_enabled: {
      ...both,
      value: boolean(),
      default: false,
      legacy: legacy(['killswitch', 'enabled']),
    },
    killswitch_default_primary: {
      ...both,
      value: number(),
      default: 5,
      legacy: legacy(
        ['killswitch', 'defaults', 'primary'],
        ['killswitch', 'main', 'primary'],
        ['killswitch', 'main', '5h'],
      ),
    },
    killswitch_default_secondary: {
      ...both,
      value: number(),
      default: 10,
      legacy: legacy(
        ['killswitch', 'defaults', 'secondary'],
        ['killswitch', 'main', 'secondary'],
        ['killswitch', 'main', '1w'],
      ),
    },
    killswitch_account_floors: {
      ...shared,
      // Local ids can name different accounts on each host. Tag entries instead
      // of letting a host override replace the entire floors list.
      // Finite manual floors remain unbounded, as in the account store reader.
      value: list(
        object({
          account: string(),
          host: oneOf(['opencode', 'pi', 'both']),
          primary: number(),
          secondary: number(),
        }),
      ),
      default: [],
      legacy: legacy(['killswitch', 'accounts']),
    },
    cache_keep_enabled: {
      ...opencode,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(
        ['cacheKeep', 'enabled'],
        ['cachekeep', 'enabled'],
      ),
    },
    cache_keep_subagents: {
      ...opencode,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(
        ['cacheKeep', 'subagents'],
        ['cachekeep', 'subagents'],
      ),
    },
    cache_keep_sustain: {
      ...opencode,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(
        ['cacheKeep', 'sustain'],
        ['cachekeep', 'sustain'],
      ),
    },
    cache_keep_window: {
      ...opencode,
      value: list(
        object({
          start_hour: integer({ min: 0, max: 23 }),
          end_hour: integer({ min: 0, max: 23 }),
        }),
      ),
      default: [],
      legacy: opencodeLegacy(
        ['cacheKeep', 'startHour'],
        ['cacheKeep', 'endHour'],
        ['cachekeep', 'startHour'],
        ['cachekeep', 'endHour'],
      ),
    },
    log_level: {
      ...opencode,
      value: oneOf(['error', 'warn', 'info', 'debug', 'trace', 'default']),
      default: 'default',
      legacy: opencodeLegacy(['logging', 'level']),
    },
    request_dumps: {
      ...opencode,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(['dump'], ['dump', 'enabled']),
    },
    dump_dir: {
      ...opencode,
      value: string(),
      // The transport resolves an empty folder to its OS-specific temporary path.
      default: '',
      legacy: opencodeLegacy(['dumpDir']),
    },
    dump_max_bytes: {
      ...opencode,
      value: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      default: 536870912,
      legacy: opencodeLegacy(['dumpMaxBytes']),
    },
    web_sockets: {
      ...opencode1,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(['webSockets']),
    },
    raw_web_socket: {
      ...opencode1,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(['rawWebSocket']),
    },
    responses_lite: {
      ...opencode,
      value: boolean(),
      default: false,
      legacy: opencodeLegacy(['responsesLite']),
    },
    codex_api_endpoint: {
      ...opencode,
      value: string(),
      default: 'https://chatgpt.com/backend-api/codex/responses',
      legacy: opencodeLegacy(['codexApiEndpoint']),
    },
  },
})
