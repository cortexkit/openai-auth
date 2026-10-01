// The Claustrum vault on the OpenCode 2 entry: the real claustrum client over
// a socket to the mock daemon, the real setup on a fake host. A vault account
// is routed beside the pool rows, its send authorized by the vault, the
// receipt carried as the attempt's value, and a 401 on that send reported to
// the vault against the exact record version it used.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { vaultPaths } from '@cortexkit/openai-auth-core/internal'
import {
  chatgptAccessToken,
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
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

const PLACEHOLDER = placeholderSecret('openai')
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')
const ENROLLMENT_TOKEN = '01'.repeat(32)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
  return { host, daemon, files }
}

type Host = Awaited<ReturnType<typeof start>>['host']

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

  it('moves a request the vault refuses to serve to the next account before anything is sent', async () => {
    const { host, daemon } = await start('fallback-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    const credential = daemon.credentials['oauth:openai:vault']
    if (credential) credential.refuse = 'credential_unavailable'
    const gets = daemon.gets.length
    const served = await send(host, 200)
    // The vault was asked to authorize this send and refused, so the request
    // went to the pool row instead.
    expect(daemon.gets.slice(gets)).toEqual([
      expect.objectContaining({ credential_id: 'oauth:openai:vault' }),
    ])
    expect(served.get('authorization')).toBe('Bearer main-token')
    expect(daemon.reports).toEqual([])
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

  it('never refreshes the token of a pool row signing in as an account the vault holds', async () => {
    // Every row's token is inside the refresh window, so the request path
    // refreshes the due ones before it picks an account.
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
    await send(host, 200)
    await waitFor(
      () => refreshed.some((token) => token.includes('main-refresh')),
      'the refresh of row main',
    )
    await Bun.sleep(100)
    expect(refreshed.some((token) => token.includes('B-refresh'))).toBe(false)
  })

  // The pool source polls every row once as soon as it first reads the pool.
  // That first read must already know which accounts the vault holds, or the
  // local copy of a vault account is polled with its own token at startup.
  it('never polls the quota of a pool row signing in as an account the vault holds, from the first read on', async () => {
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
      () => polls.includes('Bearer main-token'),
      'the first quota poll of row main',
    )
    // Every row's first quota poll is fired at once, but each takes the pool
    // store's lock in turn, so a second row's poll can come well after row
    // main's; wait long enough for it to show.
    await Bun.sleep(1_000)
    expect(polls).not.toContain('Bearer B-token')
  })

  it('does not adopt a login in the host slot while the vault serves this host its accounts', async () => {
    const login = {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-login'),
      refresh: 'login-refresh',
      expires: Date.now() + 3_600_000,
    }
    const { files } = await start(
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
    // The lifecycle's first run (already migrated, then one adoption) starts
    // with setup; an adoption would have replaced the slot login with the
    // pool placeholder and added a row by now.
    await Bun.sleep(300)
    expect(
      JSON.parse(readFileSync(join(files.dir, 'auth.json'), 'utf8')).openai,
    ).toEqual(login)
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'main',
    ])
  })
})
