// Reset credits on OpenCode 2, end to end: the real setup on a fake host, the
// `/openai` menu each location registers, and a stand-in ChatGPT server for
// quota, the credit list, redemption and token refresh. These replay OpenCode
// 1's reset-credit regressions through OpenCode 2's own apply path, where the
// account is a pool row and nothing is read from a host login.
//
// A credit is spent only by `spend` or `retry` applied with `confirmed: true`,
// which the TUI dialog sends after its own confirm prompt. Opening the menu,
// Preview and an unconfirmed apply never reach the redemption.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import {
  VAULT_LOCAL_ACTION_REFUSAL,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import {
  chatgptAccessToken,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { VAULT_MODE_LOCAL_NOTE } from '../../../core/src/vault-account-menu.ts'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { resetNotificationsForTest } from '../rpc/notifications'
import type { ApplyResult, OpenDialogPayload } from '../rpc/protocol'
import type { ControlPlaneMenu } from '../v2/control-plane'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import { waitForQuotaPersistence } from './fixtures/coalesced-quota'
import {
  fakeOpenCode2Host,
  type PoolFiles,
  type PoolSeedRow,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { jwt } from './fixtures/pool-migration-harness'

const HOUR = 3600_000
const PLACEHOLDER = placeholderSecret('openai')

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  resetNotificationsForTest()
})

type WireAccount = { used: number; available: number; applicable: number }

type WireCall = {
  method: string
  path: string
  /** The pool row whose bearer the call carried, or the bearer itself. */
  account: string
  chatgptAccountId: string | null
  body?: string
}

/**
 * The ChatGPT endpoints a reset touches, answering per bearer. `consume` is
 * what a redemption answers: a server code, a thrown connection error, or an
 * HTTP status.
 */
function resetWire(clock: () => number) {
  const wire = {
    accounts: new Map<string, WireAccount>(),
    tokens: new Map<string, string>(),
    calls: [] as WireCall[],
    consume: 'reset' as string | { throws: string } | { status: number },
    /** Runs when a redemption is answered with `reset` or `already_redeemed`. */
    afterConsume: (_account: string) => {},
    /** What the token endpoint answers; refused unless a test sets it. */
    refresh: undefined as (() => Response) | undefined,
    /** Runs inside the redemption request before it is answered. */
    duringConsume: undefined as (() => Promise<void> | void) | undefined,
    posts: () =>
      wire.calls
        .filter((call) => call.path.endsWith('/consume'))
        .map((call) => {
          const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>
          return {
            account: call.account,
            chatgptAccountId: call.chatgptAccountId,
            pair: [body.redeem_request_id, body.credit_id],
          }
        }),
    creditLists: () =>
      wire.calls.filter((call) =>
        call.path.endsWith('/wham/rate-limit-reset-credits'),
      ),
    fetch: undefined as unknown as typeof fetch,
  }
  wire.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method ?? 'GET'
      const headers = new Headers(init?.headers)
      const bearer = (headers.get('authorization') ?? '').replace(
        /^Bearer /,
        '',
      )
      const account = wire.tokens.get(bearer) ?? bearer
      wire.calls.push({
        method,
        path: url.pathname,
        account,
        chatgptAccountId: headers.get('chatgpt-account-id'),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (url.pathname.endsWith('/oauth/token')) {
        if (wire.refresh) return wire.refresh()
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      const state = wire.accounts.get(account)
      if (!state) return Response.json({ error: 'unknown' }, { status: 401 })
      if (url.pathname.endsWith('/wham/usage')) {
        const resetAt = Math.floor((clock() + 2 * HOUR) / 1000)
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: state.used,
              limit_window_seconds: 18_000,
              reset_at: resetAt,
            },
          },
          rate_limit_reset_credits: {
            available_count: state.available,
            applicable_available_count: state.applicable,
          },
        })
      }
      if (url.pathname.endsWith('/wham/rate-limit-reset-credits/consume')) {
        await wire.duringConsume?.()
        const answer = wire.consume
        if (typeof answer === 'object' && 'throws' in answer)
          throw new Error(answer.throws)
        if (typeof answer === 'object')
          return Response.json(
            { error: 'upstream failed' },
            { status: answer.status },
          )
        if (answer === 'reset' || answer === 'already_redeemed')
          wire.afterConsume(account)
        return Response.json({ code: answer })
      }
      if (url.pathname.endsWith('/wham/rate-limit-reset-credits')) {
        const credits = Array.from({ length: state.available }, (_, i) => ({
          id: `credit-${account}-${i + 1}`,
          status: 'available',
          expires_at: new Date(clock() + (i + 1) * 24 * HOUR).toISOString(),
          reset_type: 'codex_rate_limits',
          is_supported_by_plan: true,
        }))
        return Response.json({ credits, available_count: state.available })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    },
    { preconnect() {} },
  ) as typeof fetch
  return wire
}

/** The control-plane registry the setup installs each location's menu in. */
const LOCATIONS = Symbol.for('cortexkit.openai-auth.v2.commands')

/**
 * The menu the location registered: the object the TUI's RPC apply and the
 * `/openai` command both call. Calling it directly keeps the loopback socket's
 * two-second client deadline out of these tests.
 */
function locationMenu(directory: string): ControlPlaneMenu {
  const registry = (
    globalThis as typeof globalThis & {
      [LOCATIONS]?: { locations: Map<string, { menu: ControlPlaneMenu }> }
    }
  )[LOCATIONS]
  const menu = registry?.locations.get(directory)?.menu
  if (!menu) throw new Error(`no /openai menu registered for ${directory}`)
  return menu
}

interface StartOptions {
  rows?: PoolSeedRow[]
  /** Edits the seeded files before setup reads them. */
  prepare?: (files: PoolFiles) => void
  /** Accounts the stand-in server knows; every seeded row by default. */
  wire?: Record<string, Partial<WireAccount>>
  host?: Parameters<typeof fakeOpenCode2Host>[0]
  slotReads?: { count: number }
  /** Connects this host to a stand-in vault holding one ChatGPT account. */
  vault?: boolean
}

/** A stand-in vault daemon and an approved enrollment, as Connect leaves it. */
async function connectedVault(files: PoolFiles, stateDir: string) {
  const daemon: MockDaemon = await startMockDaemon({
    directory: files.dir,
    credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
  })
  cleanups.push(() => daemon.stop())
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath } = vaultPaths(stateDir, 'opencode')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
  return daemon
}

/**
 * Waits for setup's background quota reading of the vault account, which
 * asks the vault for its credential, so a test's own count of those requests
 * starts after it.
 */
async function firstVaultReading(
  files: PoolFiles,
  stateDir: string,
  daemon: MockDaemon,
) {
  const observer = acquireOpenCodeVault(
    {
      host: 'opencode',
      stateDir,
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
    },
    files.paths(),
  )
  try {
    const deadline = Date.now() + 5_000
    while (!(observer.vault.snapshot()?.rows ?? []).some((row) => row.quota)) {
      if (Date.now() > deadline)
        throw new Error('timed out waiting for the vault quota reading')
      await Bun.sleep(10)
    }
  } finally {
    observer.release()
  }
}

/** Runs setup for one location over a seeded pool and the stand-in server. */
async function start(options: StartOptions = {}) {
  const files = poolFiles()
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  const rows = options.rows ?? [{ id: 'main' }, { id: 'alpha' }]
  seedPool(files, 'main-first', rows)
  options.prepare?.(files)
  let clock = Date.now()
  const wire = resetWire(() => clock)
  for (const row of rows) {
    wire.tokens.set(row.access ?? `${row.id}-token`, row.id)
    wire.accounts.set(row.id, {
      used: 100,
      available: 2,
      applicable: 2,
      ...options.wire?.[row.id],
    })
  }
  const directory = join(files.dir, 'location')
  mkdirSync(directory, { recursive: true })
  const host = fakeOpenCode2Host({ ...options.host, directory })
  const slot = opencode1HostSlot(join(files.dir, 'auth.json'))
  const vaultDir = join(files.dir, 'vault')
  const daemon = options.vault
    ? await connectedVault(files, vaultDir)
    : undefined
  if (daemon) {
    wire.tokens.set(chatgptAccessToken('chatgpt-vault'), 'vault')
    wire.accounts.set('vault', { used: 100, available: 2, applicable: 2 })
  }
  const dispose = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: options.slotReads
      ? {
          ...slot,
          get: async (input) => {
            options.slotReads!.count++
            return slot.get(input)
          },
        }
      : slot,
    fence: async () => ({ open: true }),
    heartbeat: false,
    poolMigration: false,
    fetch: wire.fetch,
    now: () => clock,
    vault: {
      stateDir: vaultDir,
      pollIntervalMs: 0,
      ...(daemon ? { connectionFile: () => daemon.connectionFile } : {}),
    },
  })
  cleanups.push(dispose)
  if (daemon) await firstVaultReading(files, vaultDir, daemon)
  const menu = locationMenu(directory)
  const apply = (
    itemId: string | undefined,
    actionId: string,
    extra: Record<string, unknown> = {},
  ) =>
    menu.apply({
      command: 'openai',
      sectionId: 'reset',
      actionId,
      sessionId: 'S',
      ...(itemId !== undefined ? { itemId } : {}),
      ...extra,
    })
  return {
    files,
    wire,
    host,
    daemon,
    menu,
    apply,
    /** Spend or retry as the TUI dialog sends it after its confirm prompt. */
    confirm: (itemId: string, actionId: 'spend' | 'retry') =>
      apply(itemId, actionId, { confirmed: true }),
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
    savedReset: () =>
      (JSON.parse(readFileSync(files.configPath, 'utf8')).reset ??
        {}) as Record<string, Record<string, unknown> | undefined>,
  }
}

function resetSection(payload: OpenDialogPayload) {
  return payload.menu.sections.find((section) => section.id === 'reset')
}

function text(result: ApplyResult) {
  return result.text
}

/** No redemption was sent and no reset state was written. */
function expectNothingSpent(f: Awaited<ReturnType<typeof start>>) {
  expect(f.wire.posts()).toEqual([])
  expect(f.savedReset()).toEqual({})
}

describe('OpenCode 2 reset credits menu', () => {
  test('opening /openai lists main and each enabled account with Preview, Spend and Retry, and spends nothing', async () => {
    const f = await start({
      rows: [{ id: 'main' }, { id: 'alpha' }, { id: 'off' }],
      prepare: (files) => {
        const config = files.readConfig()
        for (const row of config.accounts)
          if (row.id === 'off') row.enabled = false
        writeFileSync(files.configPath, JSON.stringify(config))
      },
    })
    const section = resetSection(await f.menu.open('S'))
    expect(section?.title).toBe('Reset credits')
    expect(section?.lines).toEqual(['Restore exhausted quota'])
    expect(section?.items.map((item) => item.id)).toEqual(['main', 'alpha'])
    for (const item of section?.items ?? []) {
      expect(item.actions.map((action) => action.id)).toEqual([
        'preview',
        'spend',
        'retry',
      ])
      // Spend and Retry are irreversible, so the dialog confirms them first.
      expect(
        item.actions
          .filter((action) => action.confirm?.irreversible)
          .map((action) => action.id),
      ).toEqual(['spend', 'retry'])
    }
    expect(f.wire.creditLists()).toEqual([])
    expectNothingSpent(f)
  })

  test('Preview shows the balance and eligibility of an exhausted account and spends nothing', async () => {
    const f = await start()
    const preview = await f.apply('alpha', 'preview')
    expect(preview.ok).toBe(true)
    expect(text(preview)).toContain('100% used')
    expect(text(preview)).toContain('2/2 applicable/available')
    expect(text(preview)).toContain('eligible · credit credit-alpha-1')
    expect(text(preview)).toContain(
      'Eligible: choose "Spend a reset credit" to redeem one.',
    )
    expect(text(preview)).not.toContain('alpha-token')
    // The preview read the account's own quota and credits with its bearer.
    expect(
      f.wire.creditLists().map((call) => [call.account, call.chatgptAccountId]),
    ).toEqual([['alpha', 'chatgpt-alpha']])
    expectNothingSpent(f)
  })

  test('Preview of an account that is not eligible gives the reason and spends nothing', async () => {
    const f = await start({
      wire: {
        main: { used: 10 },
        alpha: { available: 0, applicable: 0 },
      },
    })
    const healthy = await f.apply('main', 'preview')
    expect(healthy.ok).toBe(false)
    expect(text(healthy)).toContain('10% used')
    expect(text(healthy)).toContain('Cannot reset: **')
    const noCredit = await f.apply('alpha', 'preview')
    expect(noCredit.ok).toBe(false)
    expect(text(noCredit)).toContain('Cannot reset: **no eligible credit**')
    expectNothingSpent(f)
  })

  test('Spend and Retry without confirmation never reach the redemption', async () => {
    const f = await start()
    for (const actionId of ['spend', 'retry'])
      for (const confirmed of [undefined, false, 'true', 1]) {
        const result = await f.apply(
          'alpha',
          actionId,
          confirmed === undefined ? {} : { confirmed },
        )
        expect(result.ok).toBe(false)
        expect(result.code).toBe('needs-confirmation')
      }
    // Neither the account's credits nor its quota were read for a spend.
    expect(f.wire.creditLists()).toEqual([])
    expectNothingSpent(f)
  })

  test('reset requests other than Preview, Spend and Retry on one account are refused', async () => {
    const f = await start()
    const requests: Array<[string | undefined, string]> = [
      [undefined, 'preview'],
      [undefined, 'spend'],
      [undefined, 'retry'],
      [undefined, 'unknown'],
      ['alpha', 'unknown'],
      ['alpha', 'redeem'],
      ['alpha', ''],
    ]
    for (const [itemId, actionId] of requests) {
      const result = await f.apply(itemId, actionId, { confirmed: true })
      expect({ itemId, actionId, ok: result.ok, code: result.code }).toEqual({
        itemId,
        actionId,
        ok: false,
        code: 'unavailable',
      })
      expect(text(result)).toBe('Not available on OpenCode 2 yet.')
    }
    expect(f.wire.creditLists()).toEqual([])
    expectNothingSpent(f)
  })

  test('Cache is available alongside reset credits without spending a credit', async () => {
    const f = await start()
    const cache = (await f.menu.open('S')).menu.sections.find(
      (section) => section.id === 'cache',
    )
    expect(cache?.actions.map((action) => action.id)).toEqual([
      'enabled',
      'subagents',
      'sustain',
      'window',
    ])
    const result = await f.menu.apply({
      command: 'openai',
      sectionId: 'cache',
      actionId: 'enabled',
      values: { enabled: true },
    })
    expect(result.ok).toBe(true)
    expect(text(result)).toContain('Keep-warm is on.')
    expectNothingSpent(f)
  })
})

/** A window that was used up and is fresh again after the redemption. */
function refreshesAfterReset(f: Awaited<ReturnType<typeof start>>) {
  f.wire.afterConsume = (account) => {
    const state = f.wire.accounts.get(account)
    if (state) Object.assign(state, { used: 0, available: 5, applicable: 2 })
  }
}

describe('OpenCode 2 reset credits redemption', () => {
  test('a confirmed Spend redeems on the chosen account, verifies the window and reports the remaining credits', async () => {
    const f = await start()
    refreshesAfterReset(f)
    // The pool polls every row when it loads, reading 2 available credits.
    // With a fixed clock that reading ties with the post-spend re-check, and the
    // newest-reading merge would keep whichever lands last. Move the clock so
    // the re-check is newer, as it always is in use.
    f.advance(1_000)
    const result = await f.confirm('alpha', 'spend')
    expect(result.ok).toBe(true)
    expect(text(result)).toContain('Code: `reset`')
    expect(text(result)).toContain('Post-verification: **window fresh**.')
    expect(text(result)).toContain('Remaining applicable credits: **2**')
    expect(text(result)).not.toContain('alpha-token')
    expect(f.wire.posts()).toEqual([
      {
        account: 'alpha',
        chatgptAccountId: 'chatgpt-alpha',
        pair: [expect.any(String), 'credit-alpha-1'],
      },
    ])
    // The re-check publishes 5 available credits immediately, then the
    // detached writer commits the balance to the pool's quota map.
    await waitForQuotaPersistence(() => {
      const quota = f.files.readConfig().commonAuthPool.rows.alpha?.quota as
        | { counters?: { resetCredits?: { value: number } } }
        | undefined
      return quota?.counters?.resetCredits?.value === 5
    })
    const quota = (
      f.files.readConfig().commonAuthPool.rows.alpha as {
        quota?: { counters?: { resetCredits?: { value: number } } }
      }
    ).quota
    expect(quota?.counters?.resetCredits?.value).toBe(5)
    const saved = f.savedReset().alpha
    expect(saved?.inFlight).toBeUndefined()
    expect(saved?.cooldownUntil).toBeGreaterThan(f.now())
  })

  test('main is the pool row main, sent with its own bearer and never the placeholder', async () => {
    const f = await start()
    refreshesAfterReset(f)
    const result = await f.confirm('main', 'spend')
    expect(text(result)).toContain('Account: **Main account** (`main`)')
    expect(text(result)).toContain('Code: `reset`')
    // Main is redeemed without an account header, as on OpenCode 1.
    expect(f.wire.posts()).toEqual([
      {
        account: 'main',
        chatgptAccountId: null,
        pair: [expect.any(String), 'credit-main-1'],
      },
    ])
    expect(f.wire.calls.map((call) => call.account)).not.toContain(PLACEHOLDER)
  })

  test('a second Spend right after a reset is held by the cooldown and sends nothing', async () => {
    const f = await start()
    await f.confirm('alpha', 'spend')
    expect(f.wire.posts()).toHaveLength(1)
    const again = await f.confirm('alpha', 'spend')
    expect(again.ok).toBe(false)
    expect(text(again)).toContain('This account just reset')
    expect(text(again)).toContain('Code: `cooldown_active`')
    expect(f.wire.posts()).toHaveLength(1)
  })

  test('an unknown outcome keeps its pair, and Retry and Spend replay the same ids', async () => {
    const f = await start()
    f.wire.consume = { throws: 'connection lost' }
    const ambiguous = await f.confirm('alpha', 'spend')
    expect(ambiguous.ok).toBe(false)
    expect(text(ambiguous)).toContain('outcome is unknown')
    const [sent] = f.wire.posts()
    if (!sent) throw new Error('no redemption was sent')
    expect(f.savedReset().alpha?.inFlight).toMatchObject({
      redeemRequestId: sent.pair[0],
      creditId: sent.pair[1],
    })
    // Spend while the pair is in flight replays it instead of spending again.
    await f.confirm('alpha', 'spend')
    f.wire.consume = 'already_redeemed'
    const retried = await f.confirm('alpha', 'retry')
    expect(text(retried)).toContain('Code: `already_redeemed`')
    expect(f.wire.posts().map((post) => post.pair)).toEqual([
      sent.pair,
      sent.pair,
      sent.pair,
    ])
    expect(f.savedReset().alpha?.inFlight).toBeUndefined()
  })

  test('an expired unknown outcome refuses Spend, and Retry still replays its ids', async () => {
    const f = await start()
    f.wire.consume = { throws: 'connection lost' }
    await f.confirm('alpha', 'spend')
    const [sent] = f.wire.posts()
    if (!sent) throw new Error('no redemption was sent')
    f.advance(6 * 60_000)
    const refused = await f.confirm('alpha', 'spend')
    expect(text(refused)).toContain('expired_unreconciled')
    expect(f.wire.posts()).toHaveLength(1)
    f.wire.consume = 'already_redeemed'
    await f.confirm('alpha', 'retry')
    expect(f.wire.posts().map((post) => post.pair)).toEqual([
      sent.pair,
      sent.pair,
    ])
  })

  test('Retry with no redemption in flight sends nothing', async () => {
    const f = await start()
    const result = await f.confirm('alpha', 'retry')
    expect(result.ok).toBe(false)
    expect(text(result)).toContain('no active reset redemption to retry')
    expectNothingSpent(f)
  })

  test('two overlapping confirmed Spends claim one request and credit pair', async () => {
    const f = await start()
    // Hold the first redemption open until the second one is sent or has
    // finished without sending, so the two genuinely overlap.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    f.wire.duringConsume = async () => {
      if (f.wire.posts().length >= 2) release()
      await held
    }
    await Promise.all(
      [0, 1].map(() => f.confirm('alpha', 'spend').finally(() => release())),
    )
    const pairs = f.wire.posts().map((post) => JSON.stringify(post.pair))
    // The second claim finds the first one's pair in flight and replays it.
    expect(pairs).toHaveLength(2)
    expect(new Set(pairs).size).toBe(1)
  })

  test('a terminal outcome whose state write fails says so and offers the same ids', async () => {
    const f = await start()
    let config = ''
    f.wire.duringConsume = () => {
      // The account file turns unreadable between the claim and the result.
      config = readFileSync(f.files.configPath, 'utf8')
      writeFileSync(f.files.configPath, '{')
    }
    const result = await f.confirm('alpha', 'spend')
    writeFileSync(f.files.configPath, config)
    expect(text(result)).toContain('but the state write failed')
    expect(text(result)).toContain(
      'A retry within five minutes reuses the same request and credit identifiers',
    )
    expect(f.wire.posts()).toHaveLength(1)
  })
})

/** Edits row `id` of the seeded account config. */
function editAccount(
  files: PoolFiles,
  id: string,
  edit: (row: Record<string, unknown>) => void,
) {
  const config = files.readConfig()
  for (const row of config.accounts)
    if (row.id === id) edit(row as unknown as Record<string, unknown>)
  writeFileSync(files.configPath, JSON.stringify(config))
}

/** Edits row `id`'s credential in the seeded state file. */
function editCredential(
  files: PoolFiles,
  id: string,
  edit: (credential: Record<string, unknown>) => void,
) {
  const state = files.readState()
  const credential = state.accounts[id] as Record<string, unknown>
  edit(credential)
  writeFileSync(files.statePath, JSON.stringify(state))
}

describe('OpenCode 2 reset credits target', () => {
  // Spend reads the account's eligibility first and shows the resolver's
  // reason as why it cannot reset; Retry resolves the account directly and
  // reports the refusal code.
  const refusals: Array<{
    name: string
    code: string
    reason: string
    message: string
    options: StartOptions
  }> = [
    {
      name: 'a pool without row main',
      code: 'unknown_account',
      reason: 'Main account main was not found.',
      message: 'the selected account no longer exists',
      options: { rows: [{ id: 'alpha' }] },
    },
    {
      name: 'a disabled row main',
      code: 'disabled_account',
      reason: 'Main account main is disabled.',
      message: 'the selected account is disabled',
      options: {
        prepare: (files) =>
          editAccount(files, 'main', (row) => {
            row.enabled = false
          }),
      },
    },
    {
      name: 'a row main that is not an OAuth login',
      code: 'non_oauth_account',
      reason: 'Main account main is not an OAuth account.',
      message: 'the selected account is not authenticated with OAuth',
      options: {
        prepare: (files) =>
          editAccount(files, 'main', (row) => {
            row.type = 'api'
            row.baseURL = 'https://api.openai.com/v1'
          }),
      },
    },
    {
      name: 'a row main without a token whose refresh is refused',
      code: 'token_unavailable',
      reason: 'Main OpenAI account has no usable access token.',
      message: 'the selected account token is unavailable',
      options: {
        prepare: (files) =>
          editCredential(files, 'main', (credential) => {
            credential.access = ''
            credential.expires = 0
          }),
      },
    },
  ]
  for (const refusal of refusals) {
    test(`refuses ${refusal.name} as ${refusal.code}`, async () => {
      const f = await start(refusal.options)
      for (const actionId of ['preview', 'spend'] as const) {
        const result =
          actionId === 'preview'
            ? await f.apply('main', actionId)
            : await f.confirm('main', actionId)
        expect(result.ok).toBe(false)
        expect(text(result)).toContain(`Cannot reset: **${refusal.reason}**`)
      }
      const retry = await f.confirm('main', 'retry')
      expect(retry.ok).toBe(false)
      expect(text(retry)).toContain(refusal.message)
      expect(text(retry)).toContain(`Code: \`${refusal.code}\``)
      expect(f.wire.creditLists()).toEqual([])
      expectNothingSpent(f)
    })
  }

  test('an expired row is refreshed and redeemed with its new token, not refused as tokenless', async () => {
    const fresh = jwt('chatgpt-alpha', 'fresh')
    const f = await start({
      prepare: (files) =>
        editCredential(files, 'alpha', (credential) => {
          credential.expires = Date.now() - 60_000
        }),
    })
    f.wire.tokens.set(fresh, 'alpha-fresh')
    f.wire.accounts.set('alpha-fresh', {
      used: 100,
      available: 2,
      applicable: 2,
    })
    f.wire.refresh = () =>
      Response.json({
        access_token: fresh,
        refresh_token: 'alpha-refresh-2',
        expires_in: 3600,
      })
    const result = await f.confirm('alpha', 'spend')
    expect(text(result)).toContain('Code: `reset`')
    expect(f.wire.posts()).toEqual([
      {
        account: 'alpha-fresh',
        chatgptAccountId: 'chatgpt-alpha',
        pair: [expect.any(String), 'credit-alpha-fresh-1'],
      },
    ])
    expect(f.files.readState().accounts.alpha?.access).toBe(fresh)
  })

  test('a pool without main never falls back to a host OpenAI login', async () => {
    const hostLogin = jwt('chatgpt-host-login')
    const slotReads = { count: 0 }
    const f = await start({
      rows: [{ id: 'alpha' }],
      prepare: (files) =>
        writeFileSync(
          join(files.dir, 'auth.json'),
          JSON.stringify({
            openai: {
              type: 'oauth',
              access: hostLogin,
              refresh: 'host-refresh',
              expires: Date.now() + 24 * HOUR,
            },
          }),
        ),
      host: {
        activeCredential: {
          type: 'oauth',
          methodID: 'chatgpt-browser',
          access: hostLogin,
          refresh: 'host-refresh',
          expires: Date.now() + 24 * HOUR,
        } as never,
      },
      slotReads,
    })
    f.wire.tokens.set(hostLogin, 'host')
    f.wire.accounts.set('host', { used: 100, available: 2, applicable: 2 })
    const reads = { ...f.host.connectionReads, slot: slotReads.count }
    expect(text(await f.apply('main', 'preview'))).toContain(
      'Cannot reset: **Main account main was not found.**',
    )
    expect(text(await f.confirm('main', 'spend'))).toContain(
      'Cannot reset: **Main account main was not found.**',
    )
    expect(text(await f.confirm('main', 'retry'))).toContain(
      'Code: `unknown_account`',
    )
    expect({ ...f.host.connectionReads, slot: slotReads.count }).toEqual(reads)
    expect(f.wire.calls.map((call) => call.account)).not.toContain('host')
    expectNothingSpent(f)
  })
})

describe('OpenCode 2 reset credits precondition', () => {
  test('an account with quota left is refused before anything is spent', async () => {
    const f = await start({ wire: { alpha: { used: 10 } } })
    const result = await f.confirm('alpha', 'spend')
    expect(result.ok).toBe(false)
    expect(text(result)).toContain('Cannot reset: **')
    expectNothingSpent(f)
  })

  test('an account without an eligible credit is refused before anything is spent', async () => {
    const f = await start({ wire: { alpha: { available: 0, applicable: 0 } } })
    const result = await f.confirm('alpha', 'spend')
    expect(result.ok).toBe(false)
    expect(text(result)).toContain('Cannot reset: **no eligible credit**')
    expectNothingSpent(f)
  })

  test("the request path's rate-limit mark counts as exhausted quota", async () => {
    const f = await start({ wire: { main: { used: 10 } } })
    // A usage-limit refusal on main's request marks main rate limited.
    await f.host.fire('model.request', {
      ...scope('ses_1'),
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    })
    const draft = {
      ...scope('ses_1'),
      request: new Request('http://codex.test/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
        body: '{}',
      }),
    }
    await f.host.fire('http.request', draft)
    expect(draft.request.headers.get('authorization')).toBe('Bearer main-token')
    await f.host.fire('http.response', {
      ...scope('ses_1'),
      request: draft.request,
      response: Response.json(
        { error: { type: 'usage_limit_reached', resets_in_seconds: 600 } },
        { status: 429 },
      ),
    })
    const result = await f.confirm('main', 'spend')
    expect(text(result)).toContain('Code: `reset`')
    expect(f.wire.posts().map((post) => post.account)).toEqual(['main'])
  })
})

describe('OpenCode 2 reset credits in vault mode', () => {
  test('Reset credits shows the vault note, and every action is refused without reading a credential', async () => {
    const f = await start({ vault: true })
    const opened = await f.menu.open('S')
    expect(resetSection(opened)).toMatchObject({
      lines: [VAULT_MODE_LOCAL_NOTE],
      items: [],
    })
    const gets = f.daemon?.gets.length
    const calls = f.wire.calls.length
    for (const actionId of ['preview', 'spend', 'retry'])
      for (const itemId of ['main', 'alpha'])
        for (const confirmed of [false, true]) {
          const result = await f.apply(
            itemId,
            actionId,
            confirmed ? { confirmed } : {},
          )
          expect({
            ok: result.ok,
            code: result.code,
            text: result.text,
          }).toEqual({
            ok: false,
            code: 'vault-local-action',
            text: VAULT_LOCAL_ACTION_REFUSAL,
          })
        }
    // No pool row's token was read or refreshed, no vault credential was
    // asked for, and nothing reached ChatGPT.
    expect(f.daemon?.gets.length).toBe(gets)
    expect(f.wire.calls.slice(calls)).toEqual([])
    expect(gets).toBeGreaterThan(0)
    expectNothingSpent(f)
  })

  test('Cache remains available in vault mode without spending a credit', async () => {
    const f = await start({ vault: true })
    const result = await f.menu.apply({
      command: 'openai',
      sectionId: 'cache',
      actionId: 'enabled',
      values: { enabled: true },
    })
    expect(result.ok).toBe(true)
    expect(result.text).not.toBe(VAULT_LOCAL_ACTION_REFUSAL)
    expect(result.text).toContain('Keep-warm is on.')
    expectNothingSpent(f)
  })
})
