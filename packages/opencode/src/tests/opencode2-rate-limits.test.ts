// Rate-limit marks on OpenCode 2: shared by every location in the server
// process (one setup runs per project), never leaving a fresh request with no
// account to try, and a 429 that names no quota window never taking that
// window's cached reset. Pool cases run the real setup over real pool files;
// the vault case runs the real adapter and installer over a fake vault.

import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import { resolveMidStreamRateLimitResetAt } from '@cortexkit/openai-auth-core/internal'
import { createOpenAIAdapter } from '../v2/adapter'
import { opencode1HostSlot } from '../v2/host-slot'
import { SessionPins } from '../v2/pins'
import {
  acquirePoolRateLimitMarks,
  acquireVaultRateLimitMarks,
} from '../v2/rate-limit-marks'
import { setupOpenAIAuth } from '../v2/setup'
import { parseRateLimitSignal, RATE_LIMIT_WINDOW } from '../ws'
import {
  fakeOpenCode2Host,
  type PoolFiles,
  poolFiles,
  quotaMap,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const offline = Object.assign(
  async () => {
    throw new Error('offline in tests')
  },
  { preconnect: () => {} },
) as unknown as typeof fetch

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Host = ReturnType<typeof fakeOpenCode2Host>

async function location(files: PoolFiles): Promise<Host> {
  const host = fakeOpenCode2Host()
  const cleanup = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
  })
  cleanups.push(async () => {
    await cleanup?.()
  })
  return host
}

function store(rows: string[]) {
  const files = poolFiles()
  seedPool(
    files,
    'main-first',
    rows.map((id) => ({ id })),
  )
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  return files
}

/** Sends one agent-loop request and returns its bearer header. */
async function send(host: Host, sessionID: string, refusal?: unknown) {
  const draft = {
    ...scope(sessionID),
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
      body: '{}',
    }),
  }
  await host.fire('model.request', {
    ...scope(sessionID),
    headers: { authorization: `Bearer ${PLACEHOLDER}` },
  })
  await host.fire('http.request', draft)
  if (refusal !== undefined)
    await host.fire('http.response', {
      ...scope(sessionID),
      request: draft.request,
      response: Response.json(refusal, { status: 429 }),
    })
  return draft.request.headers.get('authorization')
}

const usageLimit = {
  error: { type: 'usage_limit_reached', resets_in_seconds: 600 },
}
const capacity = {
  error: { type: 'turn_rate_limit_exceeded', message: 'Codex is at capacity' },
}

describe('a 429 in one location', () => {
  it('pool: keeps every location of the store off the refused account', async () => {
    const files = store(['a', 'b'])
    const one = await location(files)
    const two = await location(files)
    expect(await send(one, 'ses_1', usageLimit)).toBe('Bearer a-token')
    expect(await send(one, 'ses_2')).toBe('Bearer b-token')
    expect(await send(two, 'ses_3')).toBe('Bearer b-token')
  })

  it('pool: a different store keeps its own marks', async () => {
    const one = await location(store(['a', 'b']))
    const other = await location(store(['a', 'b']))
    expect(await send(one, 'ses_1', usageLimit)).toBe('Bearer a-token')
    expect(await send(other, 'ses_2')).toBe('Bearer a-token')
  })

  it('vault: keeps every location of the roster off the refused account', async () => {
    const roster = join(poolFiles().dir, 'roster.json')
    // Two vault objects for one roster, as two locations' leases can be.
    const one = await vaultLocation(fakeVault(['a', 'b'], roster))
    const two = await vaultLocation(fakeVault(['a', 'b'], roster))
    expect(await send(one, 'ses_1', usageLimit)).toBe('Bearer token-a')
    expect(await send(one, 'ses_2')).toBe('Bearer token-b')
    expect(await send(two, 'ses_3')).toBe('Bearer token-b')
  })

  it('shares one map per store and one per vault roster', () => {
    const files = poolFiles()
    const other = poolFiles()
    expect(acquirePoolRateLimitMarks(files.paths())).toBe(
      acquirePoolRateLimitMarks(files.paths()),
    )
    expect(acquirePoolRateLimitMarks(other.paths())).not.toBe(
      acquirePoolRateLimitMarks(files.paths()),
    )
    const roster = join(files.dir, 'roster.json')
    expect(acquireVaultRateLimitMarks(roster)).toBe(
      acquireVaultRateLimitMarks(roster),
    )
    expect(acquireVaultRateLimitMarks(roster)).not.toBe(
      acquireVaultRateLimitMarks(join(other.dir, 'roster.json')),
    )
  })
})

describe('when every account is marked', () => {
  it('a fresh request is still sent, on the one account', async () => {
    const host = await location(store(['a']))
    expect(await send(host, 'ses_1', capacity)).toBe('Bearer a-token')
    expect(await send(host, 'ses_2')).toBe('Bearer a-token')
  })

  it('a fresh request is still sent once both accounts are marked', async () => {
    const host = await location(store(['a', 'b']))
    expect(await send(host, 'ses_1', usageLimit)).toBe('Bearer a-token')
    expect(await send(host, 'ses_2', usageLimit)).toBe('Bearer b-token')
    expect(await send(host, 'ses_3')).toBe('Bearer a-token')
  })
})

describe('a 429 that names no quota window', () => {
  const now = Date.UTC(2026, 9, 30, 12)
  const quota = {
    checkedAt: now,
    primary: {
      usedPercent: 10,
      remainingPercent: 90,
      windowMinutes: 300,
      resetsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    },
  }

  for (const [name, body] of [
    ['a capacity type', capacity],
    ['only a code', { error: { code: 'turn_rate_limit_exceeded' } }],
    ['neither type nor code', { error: { message: 'slow down' } }],
  ] as const) {
    it(`with ${name} keeps its own short mark, not the cached primary reset`, () => {
      const signal = parseRateLimitSignal({ ...body, status: 429 })
      expect(signal?.window).not.toBe('primary')
      expect(
        resolveMidStreamRateLimitResetAt(
          quota as never,
          signal?.window ?? '',
          now,
          60_000,
        ),
      ).toBe(now + 60_000)
    })
  }

  it('without a type or code reports the generic rate-limit window', () => {
    expect(
      parseRateLimitSignal({ status: 429, error: { message: 'x' } })?.window,
    ).toBe(RATE_LIMIT_WINDOW)
  })

  it('usage_limit_reached still reports its own type', () => {
    expect(parseRateLimitSignal({ ...usageLimit, status: 429 })?.window).toBe(
      'usage_limit_reached',
    )
  })
})

function fakeVault(ids: string[], rosterPath: string) {
  return {
    // A fresh reading with room: an account without one waits for its first.
    routes: () =>
      ids.map((id) => ({
        id,
        kind: 'oauth',
        identity: `chatgpt-${id}`,
        quota: quotaMap(10),
      })),
    identities: () => new Set(ids.map((id) => `chatgpt-${id}`)),
    enrolled: () => true,
    authority: async () => 'vault',
    snapshot: () => undefined,
    paths: { rosterPath },
    authorize: async (route: string) => ({
      credentialId: route,
      credentialType: 'oauth',
      accountIdentity: `chatgpt-${route}`,
      accountIdentitySource: 'asserted',
      accessToken: `token-${route}`,
      recordVersion: 1,
      expiresAtMs: null,
    }),
    reportFailure: async () => {},
    recordSnapshot: async () => {},
    requestReading() {},
    grantReach: () => undefined,
    name: 'test',
  }
}

const emptyPool = {
  current: async () => ({ active: true, rows: [] }),
  peek: () => ({ active: true, rows: [] }),
  prepareTokens: async () => {},
  usableToken: () => undefined,
  rateLimitMarks: () => new Map(),
  refreshBackoffFor: () => new Map(),
  requestReading() {},
  recordSnapshot() {},
  markRateLimited() {},
}

async function vaultLocation(
  vault: ReturnType<typeof fakeVault>,
): Promise<Host> {
  const openai = createOpenAIAdapter({
    source: emptyPool,
    storage: async () => ({
      version: 1,
      accounts: [],
      routing: { mode: 'main-first' },
    }),
    pins: new SessionPins(),
    vault,
  } as never)
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, openai.adapter)
  openai.attach(installation)
  cleanups.push(() => installation.dispose())
  return host
}
