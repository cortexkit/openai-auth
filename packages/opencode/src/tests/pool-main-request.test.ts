// The plugin running beside, and after, the account-pool migration.
//
// Once the migration finishes, OpenCode's `openai` slot holds a placeholder and
// the main account's credential lives in the roster row `main`. These tests
// drive the plugin's real fetch override (as integration.test.ts does) and the
// loader lifecycle against that layout.

import { afterEach, beforeEach, describe, expect } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AccountStorage,
  OAuthAccount,
} from '@cortexkit/openai-auth-core/internal'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { createAuthDoctorReport } from '../auth/doctor.ts'
import {
  isPoolMainPlaceholder,
  POOL_MAIN_PLACEHOLDER_REFRESH,
} from '../core/pool-main.ts'
import {
  adoptHostSlotLogin,
  migrateToPool,
  POOL_PLACEHOLDER_REFRESH,
} from '../core/pool-migration.ts'
import {
  __resetProcessHeartbeatForTest,
  processHeartbeatPath,
} from '../core/process-heartbeat.ts'
import { CodexAuthPlugin, createResetTargetResolver } from '../index.ts'
import { flushForTest } from '../logger.ts'
import {
  drainSidebarWrites,
  hashSidebarSessionId,
  normalizeSidebarState,
  type SidebarState,
} from '../sidebar-state.ts'
import { PackageVersion } from '../version.ts'
import { createFailurePhaseClock } from './failure-phase-clock.ts'
import {
  harness,
  jwt,
  login,
  seedLegacyInstall,
} from './fixtures/pool-migration-harness.ts'
import { createRequestTestScope } from './request-test-scope.ts'
import { restoreEnv } from './setup-env'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

const PLACEHOLDER = {
  type: 'oauth' as const,
  access: '',
  refresh: 'common-auth-placeholder:v1:openai',
  expires: 0,
}

const LOGIN_REQUIRED_MESSAGE =
  'This setup has no OpenAI login in its account store. Sign in for this setup with opencode auth login, or point OPENCODE_OPENAI_AUTH_FILE and OPENCODE_OPENAI_AUTH_STATE_FILE at the store that holds the login.'

type SlotValue = {
  type: 'oauth'
  access?: string
  refresh?: string
  expires?: number
}

let configDir: string
let configFile: string
let sidebarFile: string
let originalFetch: typeof globalThis.fetch
let hooks: Hooks | undefined
const scope = createRequestTestScope()
const it = scope.it
const clock = createFailurePhaseClock()
const phaseIt = (name: string, body: () => Promise<void>) =>
  scope.it(name, () => clock.run(name, body))

beforeEach(() => {
  scope.capturePluginWork()
  configDir = mkdtempSync(join(tmpdir(), 'oai-pool-main-'))
  configFile = join(configDir, 'openai-auth.json')
  sidebarFile = join(configDir, 'sidebar-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
    configDir,
    'openai-auth-state.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarFile
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(configDir, 'test.log')
  process.env.NODE_ENV = 'test'
  process.env.OPENCODE_CONFIG_DIR = configDir
  originalFetch = globalThis.fetch
  hooks = undefined
})

afterEach(async () => {
  await scope.teardown(async () => {
    await hooks?.dispose?.()
    globalThis.fetch = originalFetch
    await drainSidebarWrites()
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    restoreEnv('OPENCODE_CONFIG_DIR')
    restoreEnv('XDG_STATE_HOME')
    restoreEnv('XDG_DATA_HOME')
    delete process.env.NODE_ENV
  })
})

function mockPluginInput(): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'oauth',
    label: id,
    enabled: true,
    access: `${id}-token`,
    refresh: `${id}-refresh`,
    expires: Date.now() + 24 * 3600_000,
    accountId: `chatgpt-${id}`,
    ...extra,
  }
}

function seedStore(
  mode: 'main-first' | 'fallback-first' | 'sticky-balanced',
  accounts: unknown[],
) {
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode },
      refresh: { refreshBeforeExpiryMinutes: 5 },
      accounts,
    }),
  )
}

function seedSharedPlaceholder() {
  process.env.XDG_DATA_HOME = join(configDir, 'data')
  const dataDir = join(configDir, 'data', 'opencode')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'auth.json'),
    JSON.stringify({ openai: PLACEHOLDER }),
  )
}

const QUOTA_HEADERS = {
  'x-codex-primary-used-percent': '42',
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': '1781729038',
}

interface Wire {
  /** Authorization header of every model request, in order. */
  sends: string[]
  /** Refresh token sent by every token-refresh POST, in order. */
  refreshTokens: string[]
}

/**
 * Replace the network. Model requests answer with `respond(bearer)`. A token
 * refresh answers with a fresh pair, except for the placeholder, which the
 * real endpoint would reject. Quota polls fail, so only the request under
 * test can write quota.
 */
function installWire(
  respond: (bearer: string) => Response = () =>
    new Response('{}', { status: 200, headers: QUOTA_HEADERS }),
): Wire {
  const wire: Wire = { sends: [], refreshTokens: [] }
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    if (target.includes('/oauth/token')) {
      // The body is form-encoded, so read the field rather than matching the
      // raw text (the placeholder's colons are escaped on the wire).
      const refreshToken =
        new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? ''
      wire.refreshTokens.push(refreshToken)
      if (refreshToken === PLACEHOLDER.refresh) {
        return new Response('{"error":"invalid_grant"}', { status: 400 })
      }
      return new Response(
        JSON.stringify({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
          id_token: 'id',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (target.includes('/responses')) {
      const bearer = new Headers(init?.headers).get('authorization') ?? ''
      wire.sends.push(bearer)
      return respond(bearer)
    }
    return new Response('unavailable', { status: 503 })
  }) as unknown as typeof globalThis.fetch
  return wire
}

async function loadFetch(getAuth: () => Promise<SlotValue>) {
  hooks = await clock.phase('plugin initialization', () =>
    CodexAuthPlugin(mockPluginInput(), {
      experimentalWebSockets: false,
    }),
  )
  const authHook = hooks.auth
  if (!authHook?.loader) throw new Error('No auth loader')
  const loader = authHook.loader
  const loaded = await clock.phase('auth loader', () =>
    loader(
      getAuth as never,
      { id: 'openai', label: 'OpenAI', models: [] } as unknown as Parameters<
        NonNullable<(typeof authHook)['loader']>
      >[1],
    ),
  )
  const fetchOverride = (loaded as Record<string, unknown>).fetch as
    | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined
  if (!fetchOverride) throw new Error('No fetch in loader result')
  return scope.wrap((...args: Parameters<typeof fetchOverride>) =>
    clock.phase('request refresh lock, token refresh and send', () =>
      fetchOverride(...args),
    ),
  )
}

function request(headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }),
  }
}

async function sidebar(): Promise<SidebarState> {
  await drainSidebarWrites()
  return normalizeSidebarState(JSON.parse(readFileSync(sidebarFile, 'utf8')))
}

function expectPlaceholderNeverRefreshed(wire: Wire) {
  expect(wire.refreshTokens).not.toContain(PLACEHOLDER.refresh)
}

describe('placeholder recognition', () => {
  it('matches the value the migration writes, by exact refresh value only', () => {
    expect(POOL_MAIN_PLACEHOLDER_REFRESH).toBe(POOL_PLACEHOLDER_REFRESH)
    expect(isPoolMainPlaceholder({ ...PLACEHOLDER })).toBe(true)
    expect(
      isPoolMainPlaceholder({
        ...PLACEHOLDER,
        refresh: `${PLACEHOLDER.refresh}-suffix`,
      }),
    ).toBe(false)
    expect(
      isPoolMainPlaceholder({
        ...PLACEHOLDER,
        refresh: 'common-auth-placeholder',
      }),
    ).toBe(false)
    expect(isPoolMainPlaceholder({ ...PLACEHOLDER, type: 'api' })).toBe(false)
  })
})

describe('request path with the main account in the pool', () => {
  it('a wrongly migrated empty store refuses locally with sign-in instructions', async () => {
    seedSharedPlaceholder()
    // The separate setup's config after it wrongly adopted the operator's
    // placeholder, with no login moved into its own account store.
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        commonAuthPool: { schemaVersion: 1, rows: {} },
        routing: { mode: 'main-first' },
        openaiAuthPool: { migratedAt: 1_791_000_000_000 },
      }),
    )
    writeFileSync(
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE as string,
      '{"version":1,"accounts":{}}',
    )
    const wire = installWire()
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))
    await expect(
      fetchOverride('https://api.openai.com/v1/responses', request()),
    ).rejects.toThrow(LOGIN_REQUIRED_MESSAGE)
    expect(wire.sends).toEqual([])
    expect(wire.refreshTokens).toEqual([])
    flushForTest()
    const warnings = readFileSync(
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE as string,
      'utf8',
    )
      .split('\n')
      .filter((line) => line.includes(LOGIN_REQUIRED_MESSAGE))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('WARN')
  })

  it('an unmigrated empty store with a foreign placeholder refuses locally', async () => {
    seedSharedPlaceholder()
    seedStore('main-first', [])
    const wire = installWire()
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))
    await expect(
      fetchOverride('https://api.openai.com/v1/responses', request()),
    ).rejects.toThrow(LOGIN_REQUIRED_MESSAGE)
    expect(wire.sends).toEqual([])
    expect(wire.refreshTokens).toEqual([])
  })

  it('a completed base migration with an untagged placeholder still serves main and adopts later logins', async () => {
    const h = harness()
    try {
      await seedLegacyInstall(h)
      const config = await h.config()
      config.routing = { mode: 'main-first' }
      writeFileSync(h.paths.configPath, JSON.stringify(config))
      await migrateToPool(h.deps())
      await h.setSlot(PLACEHOLDER)
      expect(await migrateToPool(h.deps())).toEqual({
        status: 'already-migrated',
      })
      expect(await adoptHostSlotLogin(h.deps())).toEqual({
        status: 'nothing-to-import',
        slot: 'placeholder',
      })
      expect((await h.row('main'))?.enabled).toBe(true)
      expect((await h.row('main'))?.disabledReason).toBeUndefined()
      const bytes = await h.bytes()
      writeFileSync(configFile, bytes.config as string)
      writeFileSync(
        process.env.OPENCODE_OPENAI_AUTH_STATE_FILE as string,
        bytes.state as string,
      )
      const wire = installWire()
      const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))
      const response = await fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )
      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([`Bearer ${jwt('acct-main')}`])
      expectPlaceholderNeverRefreshed(wire)
      await h.setSlot(login('acct-main', 'signed-in-again'))
      expect(await adoptHostSlotLogin(h.deps())).toMatchObject({
        status: 'completed',
        rowId: 'main',
      })
      expect((await h.row('main'))?.enabled).toBe(true)
      expect((await h.row('main'))?.credential).toMatchObject({
        refresh: 'signed-in-again',
      })
    } finally {
      h.cleanup()
    }
  })

  phaseIt(
    'an interrupted own migration still serves main after writing the placeholder',
    async () => {
      const h = harness()
      try {
        await clock.phase('seed', () => seedLegacyInstall(h))
        const config = await h.config()
        config.routing = { mode: 'main-first' }
        writeFileSync(h.paths.configPath, JSON.stringify(config))
        const crash = new Error('interrupted after placeholder write')
        await clock.phase('interrupted migration', () =>
          expect(
            migrateToPool(
              h.deps({
                onStep: (step) => {
                  if (step === 'after-placeholder-write') throw crash
                },
              }),
            ),
          ).rejects.toThrow(crash.message),
        )
        const interrupted = await h.config()
        expect(interrupted.openaiAuthPool.migratedAt).toBeUndefined()
        expect(interrupted.openaiAuthPool.pending.rowId).toBe('main')
        expect(interrupted.mainAccountId).toBe('acct-main')
        const mainToken = (await h.slot.all()).openai
        expect(mainToken).toMatchObject(PLACEHOLDER)
        expect((mainToken as { accountId: string }).accountId).toMatch(
          /^openai-auth-pool:[a-f0-9]{64}$/,
        )
        const bytes = await h.bytes()
        writeFileSync(configFile, bytes.config as string)
        writeFileSync(
          process.env.OPENCODE_OPENAI_AUTH_STATE_FILE as string,
          bytes.state as string,
        )
        const wire = installWire()
        const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))
        const response = await clock.phase('request', () =>
          fetchOverride('https://api.openai.com/v1/responses', request()),
        )
        expect(response.status).toBe(200)
        expect(wire.sends).toEqual([`Bearer ${jwt('acct-main')}`])
        expectPlaceholderNeverRefreshed(wire)
        expect(
          await clock.phase('resume', () => migrateToPool(h.deps())),
        ).toMatchObject({
          status: 'completed',
          rowId: 'main',
          operation: 'resumed',
        })
      } finally {
        h.cleanup()
        await clock.phase('drain', () => scope.settlePluginWork())
      }
    },
  )

  it('main-first sends with row main and attributes its quota to main', async () => {
    seedStore('main-first', [row('main'), row('fallback-1')])
    const wire = installWire()
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    expectPlaceholderNeverRefreshed(wire)
    const state = await sidebar()
    expect(state.main.quota?.primary?.usedPercent).toBe(42)
    expect(
      state.fallbacks.find((entry) => entry.id === 'main')?.quota?.primary
        ?.usedPercent,
    ).not.toBe(42)
  })

  it('fallback-first tries the fallbacks, then row main as main, never row main as a fallback', async () => {
    // Row main is listed first: if it were still treated as a fallback, the
    // proactive gate would try it before fallback-1 and record it as one.
    seedStore('fallback-first', [row('main'), row('fallback-1')])
    const wire = installWire((bearer) =>
      bearer === 'Bearer fallback-1-token'
        ? new Response('{}', { status: 429 })
        : new Response('{}', { status: 200, headers: QUOTA_HEADERS }),
    )
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer fallback-1-token', 'Bearer main-token'])
    expectPlaceholderNeverRefreshed(wire)
    const state = await sidebar()
    expect(state.main.quota?.primary?.usedPercent).toBe(42)
  })

  it('sticky-balanced pins the session to row main as the main account', async () => {
    seedStore('sticky-balanced', [row('main')])
    const wire = installWire()
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request({ 'x-session-affinity': 'pooled-session' }),
    )

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    expectPlaceholderNeverRefreshed(wire)
    const state = await sidebar()
    expect(
      state.stickyAssignments?.[hashSidebarSessionId('pooled-session')]
        ?.accountId,
    ).toBe('main')
    expect(state.main.quota?.primary?.usedPercent).toBe(42)
  })

  it('refreshes a due row main through the per-row refresh path, never the placeholder', async () => {
    seedStore('main-first', [
      row('main', { expires: Date.now() + 60_000 }),
      row('fallback-1'),
    ])
    const wire = installWire()
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.refreshTokens).toEqual(['main-refresh'])
    expect(wire.sends).toEqual(['Bearer refreshed-access'])
  })

  it('without a row main, main is unavailable and a fallback serves', async () => {
    seedStore('main-first', [row('fallback-1')])
    const wire = installWire()
    const fetchOverride = await loadFetch(async () => ({ ...PLACEHOLDER }))

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer fallback-1-token'])
    expectPlaceholderNeverRefreshed(wire)
  })
})

describe('other main-slot readers with the main account in the pool', () => {
  function storageWith(accounts: OAuthAccount[]): AccountStorage {
    return {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts,
    }
  }
  const poolMain = row('main') as OAuthAccount

  it('the auth doctor calls the layout healthy and never offers to copy row main into the slot', () => {
    const report = createAuthDoctorReport({
      auth: { ...PLACEHOLDER },
      storage: storageWith([poolMain]),
    })
    expect(report.findings).toEqual([])
    expect(report.repairs).toEqual([])
  })

  it('the auth doctor reports a missing row main without a repair', () => {
    const report = createAuthDoctorReport({
      auth: { ...PLACEHOLDER },
      storage: storageWith([row('fallback-1') as OAuthAccount]),
    })
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'main-pool-row-missing',
    ])
    expect(report.repairs).toEqual([])
  })

  it('reset-credit target resolution resolves main to row main, refreshing it as the pool main', async () => {
    const dueMain = { ...poolMain, expires: Date.now() + 60_000 }
    const refreshedRows: string[] = []
    const resolve = createResetTargetResolver({
      getAuth: async () => ({ ...PLACEHOLDER }),
      refreshMainWithLease: async () => {
        throw new Error('the placeholder must never be refreshed')
      },
      refreshFallbackAccount: async () => {
        throw new Error('row main must be refreshed as the pool main')
      },
      refreshPoolMainRow: async (account) => {
        refreshedRows.push(account.id)
        return { ...account, access: 'main-refreshed-token' }
      },
      loadAccounts: async () => storageWith([dueMain]),
      accountStoragePath: configFile,
      accountStatePath: join(configDir, 'openai-auth-state.json'),
      now: Date.now,
    })

    const target = await resolve('main')

    expect(refreshedRows).toEqual(['main'])
    expect(target).toMatchObject({
      accountKey: 'main',
      label: 'Main account',
      accessToken: 'main-refreshed-token',
      chatgptAccountId: 'chatgpt-main',
    })
  })
})

describe('main refresh re-reads the slot once it holds the lock', () => {
  // Models another process changing the slot in the window between this
  // process's first read and its taking the main-refresh lock. The slot reads
  // as `before` until this process has created the lock file and as `after`
  // from then on, so only a read made while holding the lock can see `after`.
  function slotChangingUnderLock(before: SlotValue, after: SlotValue) {
    const lockFile = `${configFile}.main-refresh.lock`
    return async () =>
      clock.phase(
        existsSync(lockFile)
          ? 'slot read under refresh lock'
          : 'slot read before refresh lock',
        () => ({ ...(existsSync(lockFile) ? after : before) }),
      )
  }

  const expiredR1: SlotValue = {
    type: 'oauth',
    access: 'main-R1-access',
    refresh: 'main-R1',
    expires: Date.now() - 1_000,
  }

  phaseIt(
    'refreshes the token present after the lock, not the one read before it',
    async () => {
      seedStore('main-first', [])
      const wire = installWire()
      const fetchOverride = await loadFetch(
        slotChangingUnderLock(expiredR1, {
          type: 'oauth',
          access: 'main-R2-access',
          refresh: 'main-R2',
          expires: Date.now() - 1_000,
        }),
      )

      const response = await fetchOverride(
        'https://api.openai.com/v1/responses',
        request(),
      )

      expect(response.status).toBe(200)
      expect(wire.refreshTokens).toEqual(['main-R2'])
      expect(wire.sends).toEqual(['Bearer refreshed-access'])
    },
  )

  it('uses a token another process already rotated without refreshing again', async () => {
    seedStore('main-first', [])
    const wire = installWire()
    const fetchOverride = await loadFetch(
      slotChangingUnderLock(expiredR1, {
        type: 'oauth',
        access: 'main-R2-access',
        refresh: 'main-R2',
        expires: Date.now() + 3600_000,
      }),
    )

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.refreshTokens).toEqual([])
    expect(wire.sends).toEqual(['Bearer main-R2-access'])
  })

  it('stops, and serves row main, when the slot became the placeholder', async () => {
    seedStore('main-first', [row('main')])
    const wire = installWire()
    const fetchOverride = await loadFetch(
      slotChangingUnderLock(expiredR1, { ...PLACEHOLDER }),
    )

    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.refreshTokens).toEqual([])
    expect(wire.sends).toEqual(['Bearer main-token'])
  })
})

describe('process heartbeat', () => {
  beforeEach(() => {
    __resetProcessHeartbeatForTest()
  })

  it('is written on loader start and removed on dispose', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'oai-heartbeat-'))
    process.env.XDG_STATE_HOME = stateHome
    seedStore('main-first', [])
    installWire()
    const startedBefore = Date.now()
    await loadFetch(async () => ({
      type: 'oauth',
      access: 'main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 3600_000,
    }))

    const dir = join(stateHome, 'cortexkit', 'openai-auth', 'processes')
    const file = processHeartbeatPath(process.pid, dir)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      pid: process.pid,
      version: PackageVersion,
      startedAt: expect.any(Number),
    })
    const { startedAt } = JSON.parse(readFileSync(file, 'utf8'))
    expect(startedAt).toBeGreaterThanOrEqual(startedBefore)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)

    await hooks?.dispose?.()
    hooks = undefined
    expect(existsSync(file)).toBe(false)
  })

  it('a heartbeat that cannot be written does not fail the loader', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'oai-heartbeat-blocked-'))
    // A regular file where the state directory should be: mkdir under it fails.
    const blocker = join(stateHome, 'not-a-directory')
    writeFileSync(blocker, '')
    process.env.XDG_STATE_HOME = blocker
    seedStore('main-first', [])
    const wire = installWire()

    const fetchOverride = await loadFetch(async () => ({
      type: 'oauth',
      access: 'main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 3600_000,
    }))
    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-access'])
  })
})
