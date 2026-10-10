// The Claustrum vault on the OpenCode 2 entry: the real claustrum client over
// a socket to the mock daemon, the real setup on a fake host. In vault mode
// the vault's accounts are the only ones routed (no pool row is sent with,
// refreshed or polled), each send authorized by the vault, the receipt
// carried as the attempt's value, and a 401 on that send reported to the
// vault against the exact record version it used.

import { afterEach, beforeEach, describe, expect, spyOn } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  OpenCode2AuthError,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import {
  VAULT_MODE_REFUSALS,
  type VaultModeRefusal,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import {
  chatgptAccessToken,
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { PoolAccountSource } from '../core/pool-account-source'
import { isPoolPlaceholder } from '../core/pool-migration'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  type PoolFiles,
  type PoolSeedRow,
  poolFiles,
  type RoutingModeSeed,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { usageBody } from './fixtures/pool-install'
import { createRequestTestScope } from './request-test-scope.ts'

const PLACEHOLDER = placeholderSecret('openai')
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')
const ENROLLMENT_TOKEN = '01'.repeat(32)

const cleanups: Array<() => Promise<void> | void> = []
const requestScope = createRequestTestScope()
const it = requestScope.it

beforeEach(() => requestScope.capturePluginWork())

afterEach(async () => {
  await requestScope.teardown(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
})

/** Quota polls answer for every bearer; anything else is offline. */
const usageOnly = (async (input: unknown) => {
  if (!String(input).includes('/wham/usage'))
    throw new Error('offline in tests')
  return new Response(usageBody(10), { status: 200 })
}) as unknown as typeof fetch

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

async function start(
  mode: RoutingModeSeed,
  rows: PoolSeedRow[],
  credentials: Record<string, MockCredential>,
  options: {
    /** Runs on the seeded files before setup. */
    prepare?: (files: PoolFiles) => void
    fetch?: typeof fetch
    /** Runs the pool lifecycle (migration, then adoptions of slot logins). */
    poolMigration?: boolean
  } = {},
) {
  const files = poolFiles()
  seedPool(files, mode, rows)
  options.prepare?.(files)
  const daemon: MockDaemon = await startMockDaemon({
    directory: files.dir,
    credentials,
  })
  // An approved enrollment, as Connect leaves it.
  const stateDir = join(files.dir, 'vault')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath, rosterPath } = vaultPaths(stateDir, 'opencode')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
  const host = fakeOpenCode2Host()
  const stop = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: options.fetch ?? usageOnly,
    ...(options.poolMigration ? { poolMigration: true } : {}),
    vault: {
      stateDir,
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
    },
  })
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  cleanups.push(() => daemon.stop())
  cleanups.push(async () => {
    await stop?.()
  })
  // Setup reads the roster and takes a quota reading of every vault account
  // in the background; routing admits an account once it has one.
  const routable = Object.keys(credentials).filter(
    (id) => credentials[id]?.type !== 'api_key',
  )
  await waitFor(() => {
    try {
      const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as {
        rows: Array<{ credentialId: string; quota?: unknown }>
      }
      return routable.every((id) =>
        roster.rows.some((row) => row.credentialId === id && row.quota),
      )
    } catch {
      return false
    }
  }, 'the vault accounts and their quota')
  // The vault writes the quota reading to the roster file, then loads the
  // file back into memory; routing sees the reading once that load is done.
  await Bun.sleep(100)
  return { host, daemon, files, tokenPath }
}

type Host = Awaited<ReturnType<typeof start>>['host']

/** Asserts the host's request is refused locally in vault mode for `cause`. */
async function expectVaultRefusal(host: Host, cause: VaultModeRefusal) {
  const draftScope = scope('ses_1', 'primary')
  const headers = {
    authorization: `Bearer ${PLACEHOLDER}`,
  } as Record<string, string>
  const draft = {
    ...draftScope,
    request: new Request('https://codex.test/v1/responses', {
      method: 'POST',
      headers,
      body: '{}',
    }),
  }
  const error = await host
    .fire('model.request', { ...draftScope, headers })
    .then(() => host.fire('http.request', draft))
    .then(
      () => undefined,
      (reason: unknown) => reason,
    )
  expect(error).toBeInstanceOf(OpenCode2AuthError)
  expect((error as OpenCode2AuthError).message).toBe(VAULT_MODE_REFUSALS[cause])
  // Nothing was given a credential to go out with.
  expect(draft.request.headers.get('authorization')).toBe(
    `Bearer ${PLACEHOLDER}`,
  )
}

async function send(host: Host, status: number) {
  const draftScope = scope('ses_1', 'primary')
  const headers = {
    authorization: `Bearer ${PLACEHOLDER}`,
  } as Record<string, string>
  await host.fire('model.request', { ...draftScope, headers })
  const draft = {
    ...draftScope,
    request: new Request('https://codex.test/v1/responses', {
      method: 'POST',
      headers,
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  await host.fire('http.response', {
    ...draftScope,
    request: draft.request,
    response: new Response(status === 200 ? 'data: {}\n\n' : '{}', {
      status,
    }),
  })
  return draft.request.headers
}

describe('vault accounts on OpenCode 2', () => {
  it('sends with the token the vault serves, and reports a 401 against that send record version only', async () => {
    const { host, daemon } = await start('fallback-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault', {
        record_version: 7,
      }),
    })
    const served = await send(host, 500)
    expect(served.get('authorization')).toBe(`Bearer ${VAULT_ACCESS}`)
    expect(served.get('chatgpt-account-id')).toBe('chatgpt-vault')
    expect(served.get('originator')).toBe('codex_exec')
    // Not a 401: nothing is reported.
    await Bun.sleep(50)
    expect(daemon.reports).toEqual([])

    await send(host, 401)
    await waitFor(() => daemon.reports.length > 0, 'the 401 report')
    expect(daemon.reports).toEqual([
      expect.objectContaining({
        credential_id: 'oauth:openai:vault',
        provider_status: 401,
        record_version: 7,
      }),
    ])
  })

  it('refuses locally a request the vault refuses to serve: no local row takes it', async () => {
    const { host, daemon } = await start('fallback-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    const credential = daemon.credentials['oauth:openai:vault']
    if (credential) credential.refuse = 'credential_unavailable'
    const gets = daemon.gets.length
    await expectVaultRefusal(host, 'vault-refused')
    // The vault was asked to authorize this send and refused; in vault mode
    // the pool row `main` is not tried.
    expect(daemon.gets.slice(gets)).toEqual([
      expect.objectContaining({ credential_id: 'oauth:openai:vault' }),
    ])
    expect(daemon.reports).toEqual([])
  })

  it('never routes a pool row the vault does not hold, and leaves the pool files byte-identical', async () => {
    const { host, files } = await start('main-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    const config = readFileSync(files.configPath, 'utf8')
    const state = readFileSync(files.statePath, 'utf8')
    // A pool row is not even considered: none is asked for its token.
    const tokens = spyOn(PoolAccountSource.prototype, 'usableToken')
    try {
      for (let index = 0; index < 3; index++)
        expect((await send(host, 200)).get('authorization')).toBe(
          `Bearer ${VAULT_ACCESS}`,
        )
      expect(tokens).not.toHaveBeenCalled()
    } finally {
      tokens.mockRestore()
    }
    await Bun.sleep(100)
    expect(readFileSync(files.configPath, 'utf8')).toBe(config)
    expect(readFileSync(files.statePath, 'utf8')).toBe(state)
  })

  it('refuses locally when the vault serves no account', async () => {
    const { host } = await start('main-first', [{ id: 'main' }], {})
    await expectVaultRefusal(host, 'vault-empty')
  })

  it('routes the pool rows again once this host disconnects', async () => {
    const { host, tokenPath } = await start('main-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    // Disconnect deletes the enrollment token.
    rmSync(tokenPath)
    expect((await send(host, 200)).get('authorization')).toBe(
      'Bearer main-token',
    )
  })

  it('skips a pool row signing in as an account the vault holds, and never routes a vault API key', async () => {
    const { host } = await start(
      'fallback-first',
      [{ id: 'main' }, { id: 'B', identity: 'chatgpt-vault' }],
      {
        'oauth:openai:vault': vaultLogin('chatgpt-vault'),
        'apikey:openai:key': {
          payload: JSON.stringify({ api_key: 'sk-vault' }),
          record_version: 1,
          expires_at_ms: null,
          type: 'api_key',
          refresh_adapter: null,
        },
      },
    )
    const bearers = new Set<string | null>()
    for (let index = 0; index < 3; index++)
      bearers.add((await send(host, 200)).get('authorization'))
    expect([...bearers]).toEqual([`Bearer ${VAULT_ACCESS}`])
  })

  it('never refreshes the token of a pool row, whether or not the vault holds its account', async () => {
    // Every row's token is inside the refresh window, so outside vault mode
    // the request path would refresh the due ones before it picks one.
    const refreshed: string[] = []
    const recording = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body ?? ''))
        refreshed.push(body.get('refresh_token') ?? String(init?.body))
      }
      return usageOnly(input as never, init)
    }) as unknown as typeof fetch
    const { host } = await start(
      'fallback-first',
      [{ id: 'main' }, { id: 'B', identity: 'chatgpt-vault' }],
      { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      {
        fetch: recording,
        prepare: (files) => {
          const state = files.readState() as {
            accounts: Record<string, { expires?: number }>
          }
          for (const account of Object.values(state.accounts))
            account.expires = Date.now() + 3 * 60_000
          writeFileSync(files.statePath, JSON.stringify(state))
        },
      },
    )
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    await Bun.sleep(300)
    expect(refreshed).toEqual([])
  })

  // The pool source polls every row once when it first reads the pool. In
  // vault mode it polls none, from the first read on.
  it('never polls the quota of a pool row, whether or not the vault holds its account, from the first read on', async () => {
    const polls: string[] = []
    const recording = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/wham/usage'))
        polls.push(new Headers(init?.headers).get('authorization') ?? '')
      return usageOnly(input as never, init)
    }) as unknown as typeof fetch
    await start(
      'fallback-first',
      [{ id: 'main' }, { id: 'B', identity: 'chatgpt-vault' }],
      { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      { fetch: recording },
    )
    await waitFor(
      () => polls.includes(`Bearer ${VAULT_ACCESS}`),
      'the first quota poll of the vault account',
    )
    // A row's first poll would take the pool store's lock in turn, so it
    // could come well after the vault's; wait long enough for it to show.
    await Bun.sleep(1_000)
    expect(polls).not.toContain('Bearer main-token')
    expect(polls).not.toContain('Bearer B-token')
  })

  it('a vault daemon that never answers holds neither setup nor, past a bounded wait, a request, which is refused locally', async () => {
    const files = poolFiles()
    seedPool(files, 'fallback-first', [{ id: 'main' }])
    const stateDir = join(files.dir, 'vault')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const { tokenPath } = vaultPaths(stateDir, 'opencode')
    writeFileSync(
      tokenPath,
      JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
      { mode: 0o600 },
    )
    chmodSync(tokenPath, 0o600)
    const host = fakeOpenCode2Host()
    const starting = Date.now()
    const stop = await setupOpenAIAuth(host.ctx, {
      paths: files.paths,
      slot: opencode1HostSlot(join(files.dir, 'auth.json')),
      fence: async () => ({ open: true }),
      heartbeat: false,
      fetch: usageOnly,
      vault: {
        stateDir,
        // The connection is never made, so the first roster read never ends.
        connectScoped: () => new Promise(() => {}),
        pollIntervalMs: 0,
      },
    })
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    cleanups.push(async () => {
      await stop?.()
    })
    expect(Date.now() - starting).toBeLessThan(1_000)

    const sending = Date.now()
    await expectVaultRefusal(host, 'vault-unreachable')

    // The request waited for the vault's first account list, but only up to
    // VAULT_FIRST_ROSTER_WAIT_MS (2 s).
    expect(Date.now() - sending).toBeGreaterThanOrEqual(1_900)
    expect(Date.now() - sending).toBeLessThan(4_000)
  }, 10_000)

  // A login on an install that has not migrated yet waits for the pool
  // lifecycle to go idle, and the lifecycle's adoption waits for the vault's
  // first roster. With a daemon that never answers, that adoption must give
  // up after its bound without adopting, so the login still completes.
  it('a vault daemon that never answers holds no login on an unmigrated install, and nothing is adopted', async () => {
    const files = poolFiles()
    writeFileSync(
      files.configPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        routing: { mode: 'main-first' },
        accounts: [],
      }),
    )
    const authPath = join(files.dir, 'auth.json')
    writeFileSync(
      authPath,
      JSON.stringify({
        openai: {
          type: 'oauth',
          access: chatgptAccessToken('chatgpt-main'),
          refresh: 'slot-refresh',
          expires: Date.now() + 3_600_000,
        },
      }),
    )
    const stateDir = join(files.dir, 'vault')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const { tokenPath } = vaultPaths(stateDir, 'opencode')
    writeFileSync(
      tokenPath,
      JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
      { mode: 0o600 },
    )
    chmodSync(tokenPath, 0o600)
    // The migration waits at its version fence until the login is under
    // way. Once the install is migrated, the next fence read (the
    // adoption's) finds a later login in the slot, which an adoption that
    // did not wait for the vault would take into the pool.
    const later = {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-later'),
      refresh: 'later-refresh',
      expires: Date.now() + 3_600_000,
    }
    const releaseMigration = Promise.withResolvers<void>()
    let laterWritten = false
    const fence = async () => {
      if (files.readConfig().openaiAuthPool?.migratedAt === undefined) {
        await releaseMigration.promise
      } else if (!laterWritten) {
        laterWritten = true
        writeFileSync(authPath, JSON.stringify({ openai: later }))
      }
      return { open: true as const }
    }
    const host = fakeOpenCode2Host()
    const stop = await setupOpenAIAuth(host.ctx, {
      paths: files.paths,
      slot: opencode1HostSlot(authPath),
      fence,
      heartbeat: false,
      fetch: usageOnly,
      poolMigration: true,
      beginLogin: (async () => ({
        url: 'https://auth.test/authorize',
        instructions: 'sign in',
        completion: Promise.resolve({
          id: 'chatgpt-new',
          type: 'oauth' as const,
          access: 'new-access',
          refresh: 'new-refresh',
          expires: Date.now() + 3_600_000,
          enabled: true,
          addedAt: Date.now(),
          lastUsed: Date.now(),
          accountId: 'chatgpt-new',
        }),
      })) as never,
      vault: {
        stateDir,
        // The connection is never made, so the first roster read never ends.
        connectScoped: () => new Promise(() => {}),
        pollIntervalMs: 0,
        firstRosterWaitMs: 300,
      },
    })
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    cleanups.push(async () => {
      await stop?.()
    })

    const method = host.methods.find(
      (entry) =>
        entry.integrationID === 'openai' &&
        entry.method.id === 'openai-auth-pool-browser',
    )
    if (!method)
      throw new Error('no openai-auth-pool-browser method registered')
    const signing = Date.now()
    const authorization = await method.authorize({})
    const signedIn = authorization.callback
    // Long enough for the login to reach its wait for the migration.
    await Bun.sleep(100)
    releaseMigration.resolve()
    await signedIn

    // The adoption gave up after its 300 ms bound; the rest is the migration
    // and the login write, which take longer on a loaded machine. A login
    // held by an unbounded wait would never finish (the test times out).
    expect(Date.now() - signing).toBeLessThan(8_000)
    const accounts = files.readConfig().accounts
    expect(accounts.map((account) => account.accountId)).toContain(
      'chatgpt-new',
    )
    expect(laterWritten).toBe(true)
    expect(accounts.map((account) => account.accountId)).not.toContain(
      'chatgpt-later',
    )
    expect(JSON.parse(readFileSync(authPath, 'utf8')).openai).toEqual(later)
  }, 15_000)

  it('adopts a slot login while the vault serves, but routes that account through the vault only', async () => {
    const login = {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-vault', 'local-login'),
      refresh: 'login-refresh',
      expires: Date.now() + 3_600_000,
    }
    const { files, host, daemon } = await start(
      'fallback-first',
      [{ id: 'main' }],
      { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
      {
        poolMigration: true,
        prepare: (seeded) =>
          writeFileSync(
            join(seeded.dir, 'auth.json'),
            JSON.stringify({ openai: login }),
          ),
      },
    )
    // The lifecycle restores the placeholder without Disconnect, but the
    // local copy cannot serve as a second owner of the vault's account.
    await Bun.sleep(300)
    expect(
      isPoolPlaceholder(
        JSON.parse(readFileSync(join(files.dir, 'auth.json'), 'utf8')).openai,
      ),
    ).toBe(true)
    expect(files.readConfig().accounts.map((account) => account.id)).toContain(
      'chatgpt-vault',
    )
    const gets = daemon.gets.length
    const served = await send(host, 200)
    expect(served.get('authorization')).toBe(`Bearer ${VAULT_ACCESS}`)
    expect(served.get('authorization')).not.toBe(`Bearer ${login.access}`)
    expect(daemon.gets.length).toBeGreaterThan(gets)
  })
})
