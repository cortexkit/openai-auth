// Rate-limit marks on OpenCode 2: shared by every location in the server
// process (one setup runs per project), never leaving a fresh request with no
// account to try, and a 429 that names no quota window never taking that
// window's cached reset. Pool cases run the real setup over real pool files;
// the vault case runs the real adapter and installer over a fake vault.

import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultRosterFile } from '@cortexkit/common-auth/claustrum'
import * as sharedLimits from '@cortexkit/common-auth/limits'
import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'
import {
  type AccountHeadersResult,
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import * as limitsCore from '@cortexkit/openai-auth-core/internal'
import { resolveMidStreamRateLimitResetAt } from '@cortexkit/openai-auth-core/internal'
import { createLimitsLeaseManager } from '../../../core/src/limit-registry'
import { OpenCodeLimitSource } from '../core/limit-source'
import { PoolAccountSource } from '../core/pool-account-source'
import {
  createOpenAIAdapter,
  type OpenAIAttemptData,
  type OpenAILimitSignal,
} from '../v2/adapter'
import { opencode1HostSlot } from '../v2/host-slot'
import { SessionPins } from '../v2/pins'
import { type OpenAIAuthV2Options, setupOpenAIAuth } from '../v2/setup'
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

async function location(
  files: PoolFiles,
  options: OpenAIAuthV2Options = {},
): Promise<Host> {
  const host = fakeOpenCode2Host()
  const cleanup = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
    ...options,
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

  it('persists the account-wide pool mark after the last location releases', async () => {
    const files = store(['a', 'b'])
    const one = await location(files)
    expect(await send(one, 'ses_persist', usageLimit)).toBe('Bearer a-token')
    await cleanups.pop()?.()
    const two = await location(files)
    expect(await send(two, 'ses_restart')).toBe('Bearer b-token')
    expect(JSON.stringify(files.readConfig())).toContain('rate-limit')
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
  const roster: VaultRosterFile = {
    version: 1,
    complete: true,
    declined: [],
    rows: ids.map((id) => ({
      routeId: id,
      credentialId: id,
      credentialType: 'oauth',
      accountIdentity: `chatgpt-${id}`,
      state: 'active',
      label: id,
      enabled: true,
      addedAt: 7,
    })),
  }
  if (!existsSync(rosterPath)) writeFileSync(rosterPath, JSON.stringify(roster))
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
    snapshot: () => roster,
    awaitRequestRoster: async () => {},
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
    reportUsage() {},
    requestReading() {},
    grantReach: () => undefined,
    name: 'test',
  }
}

const emptyPool = {
  dispose: async () => {},
  current: async () => ({ active: true, rows: [] }),
  peek: () => ({ active: true, rows: [] }),
  prepareTokens: async () => {},
  usableToken: () => undefined,
  rateLimitMarks: () => new Map(),
  refreshBackoffFor: () => new Map(),
  requestReading: () => undefined,
  recordSnapshot() {},
  markRateLimited() {},
}

async function vaultLocation(
  vault: ReturnType<typeof fakeVault>,
): Promise<Host> {
  const limits = new OpenCodeLimitSource({
    pool: emptyPool as never,
    vault: vault as never,
  })
  cleanups.push(() => limits.dispose())
  const openai = createOpenAIAdapter({
    limits,
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

const T0 = 1_800_000_000_000

async function registryLocation(
  kind: 'pool' | 'vault',
  files = store(['a', 'b']),
  isolated = false,
) {
  if (isolated) {
    // A limit event that cannot be stored logs only once per process. Give
    // each fallback test a fresh lease manager so it can assert that diagnostic,
    // while retaining the native persistence adapters.
    const manager = createLimitsLeaseManager()
    const acquire = spyOn(limitsCore, 'acquireOpenAiLimits').mockImplementation(
      (options) => {
        const source = options.source
        const namespace =
          source.kind === 'pool'
            ? limitsCore.poolLimitsNamespace(
                source.configPath,
                source.statePath,
              )
            : limitsCore.vaultLimitsNamespace(source.rosterPath)
        return manager.acquire({
          namespace,
          log: options.log ?? (() => {}),
          isAccessRestrictive: () => false,
          adapter: async () =>
            source.kind === 'pool'
              ? sharedLimits.createPoolLimitsAdapter({
                  namespace,
                  store: source.store,
                })
              : createVaultLimitsAdapter({
                  namespace,
                  path: source.rosterPath,
                }),
        })
      },
    )
    cleanups.push(() => acquire.mockRestore())
  }
  const messages: string[] = []
  const vault =
    kind === 'vault'
      ? fakeVault(['a', 'b'], join(files.dir, 'roster.json'))
      : {
          authority: async () => 'local',
          enrolled: () => false,
          awaitRequestRoster: async () => {},
          snapshot: () => undefined,
          routes: () => [],
          identities: () => new Set<string>(),
          paths: { rosterPath: join(files.dir, 'unused.json') },
        }
  const source = new PoolAccountSource({
    paths: files.paths,
    refreshProvider: async () => {
      throw new Error('unexpected refresh')
    },
    pullQuota: async () => undefined,
    vaultAuthority: vault.authority as () => Promise<'local' | 'vault'>,
    vaultMode: vault.enrolled,
    log: { debug() {}, info() {}, warn: (message) => messages.push(message) },
  })
  const limits = new OpenCodeLimitSource({
    pool: source,
    vault: vault as never,
    log: (message) => messages.push(message),
  })
  const openai = createOpenAIAdapter({
    source,
    limits,
    vault: kind === 'vault' ? (vault as never) : undefined,
    storage: async () => ({
      version: 1,
      accounts: [],
      routing: { mode: 'main-first' },
    }),
    pins: new SessionPins(),
  })
  const host = fakeOpenCode2Host()
  const installation = await installOpenCode2Auth(host.ctx, openai.adapter)
  openai.attach(installation)
  cleanups.push(async () => {
    await installation.dispose()
    await limits.dispose()
  })
  return { files, source, limits, openai, host, messages, vault }
}

async function cleanSend(
  host: Host,
  sessionID: string,
  transport: 'http' | 'ws',
) {
  await host.fire('model.request', {
    ...scope(sessionID),
    headers: { authorization: `Bearer ${PLACEHOLDER}` },
  })
  if (transport === 'ws') {
    const handshake = {
      ...scope(sessionID),
      url: 'ws://codex.test/v1/responses',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }
    await host.fire('experimental.ws.handshake', handshake)
    await host.fire('experimental.ws.receive', {
      ...scope(sessionID),
      frame: '{"type":"response.completed"}',
    })
    return handshake.headers.authorization
  }
  const draft = {
    ...scope(sessionID),
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  const response = {
    ...scope(sessionID),
    request: draft.request,
    response: new Response('sentinel'),
  }
  await host.fire('http.response', response)
  expect(await response.response.text()).toBe('sentinel')
  return draft.request.headers.get('authorization')
}

function freezeClock() {
  let time = T0
  const clock = spyOn(Date, 'now').mockImplementation(() => time)
  cleanups.push(() => clock.mockRestore())
  return (value: number) => {
    time = value
  }
}

describe('OC2 policy facts and numeric-only Retry-After', () => {
  it('relative reset uses one parser sample under an advancing clock', async () => {
    let samples = 0
    const clock = spyOn(Date, 'now').mockImplementation(
      () => T0 + ++samples * 1000,
    )
    try {
      const openai = createOpenAIAdapter({
        source: emptyPool,
        storage: async () => null,
        pins: new SessionPins(),
        now: () => T0,
      })
      const attempt = { accountId: 'a' } as never
      const event = openai.adapter.inspectEvent!({
        data: '{"status":429,"error":{"type":"usage_limit_reached","resets_in_seconds":30}}',
        transport: 'ws',
        attempt,
      })
      expect(event?.limit?.retryAfterMs).toBe(30000)
      const response = await openai.adapter.limitFromResponse!({
        status: 429,
        headers: new Headers(),
        body: async () =>
          '{"error":{"type":"usage_limit_reached","resets_in_seconds":30}}',
        attempt,
      })
      expect(response?.retryAfterMs).toBe(30000)
    } finally {
      clock.mockRestore()
    }
  })

  it('failed usage error retains its explicit reset alongside confirmed core facts', () => {
    freezeClock()
    const openai = createOpenAIAdapter({
      source: emptyPool,
      storage: async () => null,
      pins: new SessionPins(),
      now: () => T0,
    })
    const event = openai.adapter.inspectEvent!({
      data: '{"type":"response.failed","response":{"error":{"code":"usage_limit_reached","resets_at":1800000060}}}',
      transport: 'ws',
      attempt: { accountId: 'a' } as never,
    })
    expect((event?.limit as OpenAILimitSignal | undefined)?.windows).toEqual([
      {
        window: 'usage',
        confirmed: true,
        confirmedByReading: false,
        resetAt: T0 + 60000,
        observedAt: T0,
        provenance: 'provider',
      },
    ])
    expect(event?.limit?.retryAfterMs).toBe(60000)
  })

  for (const field of ['code', 'type'])
    for (const status of [undefined, 429]) {
      for (const code of ['usage_limit_reached', 'rate_limit_exceeded']) {
        it(`failed ${field} ${code} at status ${status} carries core confirmation once`, async () => {
          freezeClock()
          const openai = createOpenAIAdapter({
            source: emptyPool,
            storage: async () => null,
            pins: new SessionPins(),
          })
          const verdict = openai.adapter.inspectEvent!({
            data: JSON.stringify({
              type: 'response.failed',
              ...(status === undefined ? {} : { status }),
              response: { error: { [field]: code } },
            }),
            transport: 'ws',
            attempt: { accountId: 'a' } as never,
          })
          expect(
            (verdict?.limit as OpenAILimitSignal | undefined)?.windows,
          ).toEqual([
            {
              window:
                code === 'usage_limit_reached'
                  ? 'usage'
                  : 'rate_limit_exceeded',
              confirmed: code === 'usage_limit_reached',
              confirmedByReading: false,
              resetAt: undefined,
              observedAt: T0,
              provenance: 'unproven',
            },
          ])
        })
      }
    }

  for (const [name, headers, error, hint, until] of [
    [
      'absolute wins both fields and header',
      { 'retry-after': '5' },
      {
        type: 'usage_limit_reached',
        resets_at: 1800000090,
        resets_in_seconds: 30,
      },
      90000,
      T0 + 90000,
    ],
    [
      'relative body wins header',
      { 'retry-after': '5' },
      { type: 'usage_limit_reached', resets_in_seconds: 30 },
      30000,
      T0 + 30000,
    ],
    [
      'past body suppresses header',
      { 'retry-after': '5' },
      { type: 'usage_limit_reached', resets_at: 1799999999 },
      0,
      T0 + 60000,
    ],
    ['headerless empty body', {}, {}, undefined, T0 + 60000],
    ['fractional seconds', { 'retry-after': '1.5' }, {}, 1500, T0 + 1500],
    ['zero', { 'retry-after': '0' }, {}, 0, T0 + 60000],
    [
      'HTTP date',
      { 'retry-after': 'Fri, 15 Jan 2027 08:00:00 GMT' },
      {},
      undefined,
      T0 + 60000,
    ],
    ['invalid', { 'retry-after': 'later' }, {}, undefined, T0 + 60000],
    ['negative', { 'retry-after': '-1' }, {}, undefined, T0 + 60000],
    ['empty', { 'retry-after': '' }, {}, undefined, T0 + 60000],
    [
      'retry-after-ms ignored',
      { 'retry-after-ms': '1500' },
      {},
      undefined,
      T0 + 60000,
    ],
  ] as const) {
    it(`${name}: host hint and one registry command have pinned expiry`, async () => {
      freezeClock()
      const f = await registryLocation('pool')
      const request = {
        ...scope('parse'),
        accountId: 'a',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        phase: 'request' as const,
      }
      await f.limits.forRequest()
      const credentials = (await f.openai.adapter.accountHeaders(
        request,
      )) as AccountHeadersResult<OpenAIAttemptData>
      const attempt = {
        ...request,
        attemptId: 'parse',
        transport: 'http',
        data: credentials.attempt,
      } as const
      const limit = await f.openai.adapter.limitFromResponse!({
        status: 429,
        headers: new Headers(headers),
        body: async () => JSON.stringify({ error }),
        attempt,
      })
      expect(limit?.retryAfterMs).toBe(hint)
      // Deliver the parsed signal through the installer's public listener path.
      const draft = {
        ...scope('real-parse'),
        request: new Request('http://codex.test/v1/responses', {
          headers: { authorization: `Bearer ${PLACEHOLDER}` },
        }),
      }
      await f.host.fire('http.request', draft)
      await f.host.fire('http.response', {
        ...scope('real-parse'),
        request: draft.request,
        response: Response.json({ error }, { status: 429, headers }),
      })
      const snapshot = f.limits.owner()!.snapshot()!
      expect(snapshot.marks).toHaveLength(1)
      expect(snapshot.marks[0]!.key.window).toBe('account')
      expect(snapshot.marks[0]!.entries[0]!.until).toBe(until)
      expect(snapshot.marks[0]!.entries[0]!.cause).toBe('rate-limit')
      await f.limits.owner()!.flush()
      expect(f.limits.owner()!.snapshot()!.operationIds).toHaveLength(1)
    })
  }
})

describe('OC2 registry-owned dispatch and recovery', () => {
  for (const kind of ['pool', 'vault'] as const)
    for (const transport of ['http', 'ws'] as const) {
      it(`${kind} ${transport}: first owned sentinel, 20 completions, zero speculative commits`, async () => {
        freezeClock()
        const f = await registryLocation(kind)
        expect(f.limits.owner()).toBeUndefined()
        const before = readFileSync(
          kind === 'pool' ? f.files.configPath : f.vault.paths.rosterPath,
          'utf8',
        )
        for (let n = 0; n < 20; n++) {
          expect(await cleanSend(f.host, `healthy-${n}`, transport)).toBe(
            kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
          )
        }
        const owner = f.limits.owner()!
        await owner.flush()
        expect(owner.snapshot()!.revision).toBe(0)
        expect(owner.snapshot()!.operationIds).toEqual([])
        expect(f.limits.activity.get('healthy-19')).toEqual({
          accountKey: f.limits.accountKey('a')!,
          lastAcceptedAt: T0,
          ttlMs: 300000,
        })
        expect(
          readFileSync(
            kind === 'pool' ? f.files.configPath : f.vault.paths.rosterPath,
            'utf8',
          ),
        ).toBe(before)
        f.openai.forgetSession('healthy-19')
        expect(f.limits.activity.get('healthy-19')).toBeUndefined()
      })

      it(`${kind} ${transport}: live-mark escape never clears, expired clean probe clears only once`, async () => {
        const time = freezeClock()
        const f = await registryLocation(kind, store(['a']))
        // Restrict the fake vault too: with every account marked, fresh requests
        // may try the account again without removing its stored mark.
        if (kind === 'vault') {
          const routes = f.vault.routes
          f.vault.routes = () => routes().filter((route) => route.id === 'a')
        }
        expect(
          await send(f.host, 'marked', {
            error: { type: 'usage_limit_reached', resets_in_seconds: 1 },
          }),
        ).toBe(kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a')
        const owner = f.limits.owner()!
        await owner.flush()
        expect(await cleanSend(f.host, 'live', transport)).toBe(
          kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
        )
        await owner.flush()
        expect(owner.snapshot()!.revision).toBe(1)
        expect(owner.snapshot()!.marks).toHaveLength(1)
        time(T0 + 2000)
        await cleanSend(f.host, 'expired', transport)
        await owner.flush()
        expect(owner.snapshot()!.marks).toEqual([])
        expect(owner.snapshot()!.revision).toBe(2)
        expect(owner.snapshot()!.operationIds).toHaveLength(2)
        for (let n = 0; n < 20; n++)
          await cleanSend(f.host, `after-${n}`, transport)
        await owner.flush()
        expect(owner.snapshot()!.revision).toBe(2)
        expect(owner.snapshot()!.operationIds).toHaveLength(2)
      })
    }
})

describe('OC2 native envelope adoption', () => {
  for (const kind of ['pool', 'vault'] as const) {
    const fileOf = (f: Awaited<ReturnType<typeof registryLocation>>) =>
      kind === 'pool' ? f.files.configPath : f.vault.paths.rosterPath
    const field = kind === 'pool' ? 'commonAuthLimits' : 'limits'

    it(`${kind}: a foreign namespace with a live mark serves its first owned request`, async () => {
      freezeClock()
      const foreign = await registryLocation(kind)
      await send(foreign.host, 'foreign', usageLimit)
      await foreign.limits.owner()!.flush()
      const envelope = JSON.parse(readFileSync(fileOf(foreign), 'utf8'))[field]
      expect(envelope).toBeDefined()
      const f = await registryLocation(kind)
      const path = fileOf(f)
      const file = JSON.parse(readFileSync(path, 'utf8'))
      file[field] = envelope
      writeFileSync(path, JSON.stringify(file))
      expect(await cleanSend(f.host, 'first', 'http')).toBe(
        kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
      )
      expect(f.limits.owner()!.snapshot()!.marks).toEqual([])
      expect(f.limits.owner()!.namespace).not.toBe(
        foreign.limits.owner()!.namespace,
      )
    })

    for (const ErrorType of [
      sharedLimits.LimitsEnvelopeConflictError,
      sharedLimits.LimitsEnvelopeUnsupportedError,
    ]) {
      it(`${kind}: ${ErrorType.name} logs once and never reacquires that store`, async () => {
        freezeClock()
        const f = await registryLocation(kind, undefined, true)
        const acquire = spyOn(
          sharedLimits,
          'acquireLimitsRegistry',
        ).mockRejectedValue(new ErrorType())
        try {
          expect(await cleanSend(f.host, 'first', 'http')).toBe(
            kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
          )
          expect(f.limits.owner()!.registry).toBeUndefined()
          expect(f.messages).toEqual([
            'OpenAI limits tracking is unavailable; serving without timed marks for this process.',
          ])
          expect(await cleanSend(f.host, 'second', 'ws')).toBe(
            kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
          )
          expect(acquire).toHaveBeenCalledTimes(1)
          expect(f.messages).toHaveLength(1)
          await send(f.host, 'dropped-1', usageLimit)
          await send(f.host, 'dropped-2', usageLimit)
          expect(f.limits.marks()).toEqual(new Map())
          expect(acquire).toHaveBeenCalledTimes(1)
          expect(f.messages).toHaveLength(2)
          expect(await cleanSend(f.host, 'after-dropped', 'http')).toBe(
            kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
          )
        } finally {
          acquire.mockRestore()
        }
      })
    }

    it(`${kind}: abandonment cannot block an already dispatched response or later sends`, async () => {
      freezeClock()
      const f = await registryLocation(kind)
      const draft = {
        ...scope('in-flight'),
        request: new Request('http://codex.test/v1/responses', {
          headers: { authorization: `Bearer ${PLACEHOLDER}` },
        }),
      }
      await f.host.fire('http.request', draft)
      expect(draft.request.headers.get('authorization')).toBe(
        kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
      )
      const path = fileOf(f)
      const file = JSON.parse(readFileSync(path, 'utf8'))
      file[field] = { schemaVersion: 2 }
      writeFileSync(path, JSON.stringify(file))
      await f.limits.owner()!.reload()
      expect(f.limits.owner()!.registry).toBeUndefined()
      const reply = {
        ...scope('in-flight'),
        request: draft.request,
        response: new Response('sentinel-in-flight'),
      }
      await f.host.fire('http.response', reply)
      expect(await reply.response.text()).toBe('sentinel-in-flight')
      expect(await cleanSend(f.host, 'after-abandon', 'http')).toBe(
        kind === 'pool' ? 'Bearer a-token' : 'Bearer token-a',
      )
      expect(
        f.messages.filter(
          (message) =>
            message ===
            'OpenAI limits tracking is unavailable; serving without timed marks for this process.',
        ),
      ).toHaveLength(1)
      expect(JSON.parse(readFileSync(path, 'utf8'))[field]).toEqual({
        schemaVersion: 2,
      })
    })
  }
})

it('setup pending migration does not spend acquisition budget; migration at +60s hydrates on the next request and marks a later 429', async () => {
  const time = freezeClock()
  const files = store(['a', 'b'])
  const config = files.readConfig()
  delete config.openaiAuthPool
  writeFileSync(files.configPath, JSON.stringify(config))
  const acquire = spyOn(sharedLimits, 'acquireLimitsRegistry')
  try {
    const host = await location(files, {
      fence: async () => ({ open: false, blockers: [] }),
    })
    expect(acquire).not.toHaveBeenCalled()
    time(T0 + 60000)
    seedPool(files, 'main-first', [{ id: 'a' }, { id: 'b' }])
    expect(await cleanSend(host, 'first-migrated', 'http')).toBe(
      'Bearer a-token',
    )
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(await send(host, 'later-limit', usageLimit)).toBe('Bearer a-token')
    expect(await send(host, 'after-limit')).toBe('Bearer b-token')
  } finally {
    acquire.mockRestore()
  }
})

for (const registryFirst of [true, false]) {
  it(`first pool request joins consumer and registry readiness with registry ${registryFirst ? 'first' : 'last'}`, async () => {
    freezeClock()
    const f = await registryLocation('pool')
    const consumerReady = Promise.withResolvers<void>()
    const consumerEntered = Promise.withResolvers<void>()
    const registryReady = Promise.withResolvers<void>()
    const registryEntered = Promise.withResolvers<void>()
    const originalLoad = f.source.load.bind(f.source)
    const originalAcquire = sharedLimits.acquireLimitsRegistry
    const load = spyOn(f.source, 'load').mockImplementation(async () => {
      consumerEntered.resolve()
      await consumerReady.promise
      return originalLoad()
    })
    const acquire = spyOn(
      sharedLimits,
      'acquireLimitsRegistry',
    ).mockImplementation(async (options) => {
      registryEntered.resolve()
      await registryReady.promise
      return originalAcquire(options)
    })
    try {
      if (registryFirst) registryReady.resolve()
      let completed = false
      const request = cleanSend(f.host, 'cold-first', 'http').then((bearer) => {
        completed = true
        return bearer
      })
      await consumerEntered.promise
      expect(acquire).not.toHaveBeenCalled()
      expect(completed).toBe(false)
      consumerReady.resolve()
      await registryEntered.promise
      if (!registryFirst) {
        expect(completed).toBe(false)
        registryReady.resolve()
      }
      expect(await request).toBe('Bearer a-token')
      expect(f.limits.activity.get('cold-first')?.lastAcceptedAt).toBe(T0)
      expect(acquire).toHaveBeenCalledTimes(1)
    } finally {
      consumerReady.resolve()
      registryReady.resolve()
      load.mockRestore()
      acquire.mockRestore()
    }
  })
}

it('HTTP completion records dispatch time, not a four-minute stream tail; failed completion records no activity', async () => {
  const time = freezeClock()
  const f = await registryLocation('pool')
  const draft = {
    ...scope('long'),
    request: new Request('http://codex.test/v1/responses', {
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }),
  }
  await f.host.fire('http.request', draft)
  time(T0 + 240000)
  const reply = {
    ...scope('long'),
    request: draft.request,
    response: new Response('long-sentinel'),
  }
  await f.host.fire('http.response', reply)
  expect(await reply.response.text()).toBe('long-sentinel')
  expect(f.limits.activity.get('long')?.lastAcceptedAt).toBe(T0)
  expect(f.limits.activity.get('long')?.ttlMs).toBe(300000)
  await send(f.host, 'failed', usageLimit)
  expect(f.limits.activity.get('failed')).toBeUndefined()
})

it('a blocked detached mark commit does not delay B, while a control acknowledgement fences only A', async () => {
  freezeClock()
  const f = await registryLocation('pool')
  await f.source.load()
  const store = f.source.poolStore()
  const original = store.updateLimitsNamespace!.bind(store)
  let entered = Promise.withResolvers<void>()
  let release = Promise.withResolvers<void>()
  const write = spyOn(store, 'updateLimitsNamespace').mockImplementation(
    async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    },
  )
  await f.limits.forRequest()
  const owner = f.limits.owner()!
  const binding = f.limits
    .bindings()
    .find((value) => value.account.accountId === 'a')!
  try {
    await send(f.host, 'mark-blocked', usageLimit)
    const flush = owner.flush()
    await entered.promise
    expect(await cleanSend(f.host, 'b-before-commit', 'http')).toBe(
      'Bearer b-token',
    )
    release.resolve()
    await flush
    entered = Promise.withResolvers<void>()
    release = Promise.withResolvers<void>()
    owner.enqueue({
      type: 'clear',
      binding,
      baseRevision: owner.snapshot()!.revision,
      producerId: 'control-test',
      operationId: 'clear-a',
      keys: [{ scope: { kind: 'pool' }, window: 'account' }],
      cause: 'rate-limit',
      evidenceAt: T0 + 1,
    })
    const flushing = owner.flush()
    await entered.promise
    let aDispatched = false
    const headersA = Promise.resolve(
      f.openai.adapter.accountHeaders({
        sessionID: 'controlled-a',
        kind: 'primary',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        agent: 'build',
        accountId: 'a',
      }),
    ).then(() => {
      aDispatched = true
    })
    const headersB = (await f.openai.adapter.accountHeaders({
      sessionID: 'unrelated-b',
      kind: 'primary',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: 'build',
      accountId: 'b',
    })) as AccountHeadersResult<OpenAIAttemptData>
    expect(headersB.headers.authorization).toBe('Bearer b-token')
    expect(aDispatched).toBe(false)
    release.resolve()
    await flushing
    await headersA
    expect(aDispatched).toBe(true)
  } finally {
    release.resolve()
    write.mockRestore()
  }
})

it('one owned request under changing projections joins readiness once and keeps one five-second budget', async () => {
  const time = freezeClock()
  const f = await registryLocation('pool')
  await f.limits.forRequest()
  const bindings = f.source.limitsBindings.bind(f.source)
  let reads = 0
  const projection = spyOn(f.source, 'limitsBindings').mockImplementation(() =>
    bindings().map((binding) =>
      binding.account.accountId === 'b'
        ? { ...binding, identity: `changing-${++reads}` }
        : binding,
    ),
  )
  const registry = f.limits.owner()!.registry!
  const reload = registry.reload.bind(registry)
  let elapsed = 0
  const changing = spyOn(registry, 'reload').mockImplementation(async () => {
    elapsed += 1000
    time(T0 + elapsed)
    await reload()
  })
  const joins = spyOn(f.limits, 'forRequest')
  try {
    expect(await cleanSend(f.host, 'changing-projection', 'http')).toBe(
      'Bearer a-token',
    )
    expect(elapsed).toBe(5000)
    expect(joins).toHaveBeenCalledTimes(1)
    expect(reads).toBeGreaterThan(5)
  } finally {
    projection.mockRestore()
    changing.mockRestore()
    joins.mockRestore()
  }
})

for (const drop of [
  'consumed',
  'dropped',
  'forgotten',
  'mismatched',
  'expired',
] as const) {
  it(`${drop === 'expired' ? 'an' : 'a'} ${drop} request handoff falls back to fresh readiness without refusing dispatch`, async () => {
    freezeClock()
    const f = await registryLocation('pool')
    const request = {
      sessionID: 'handoff',
      kind: 'primary' as const,
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: 'build',
    }
    const joins = spyOn(f.limits, 'forRequest')
    const monotonic = spyOn(performance, 'now')
    try {
      expect(
        await f.openai.adapter.chooseAccount({ ...request, phase: 'request' }),
      ).toBe('a')
      const headers = { ...request, accountId: 'a' }
      if (drop === 'consumed') await f.openai.adapter.accountHeaders(headers)
      if (drop === 'dropped')
        await f.openai.adapter.dropChoice?.({ ...headers, phase: 'request' })
      if (drop === 'forgotten') f.openai.forgetSession(request.sessionID)
      if (drop === 'mismatched') headers.accountId = 'b'
      if (drop === 'expired')
        monotonic.mockReturnValue(performance.now() + 5001)
      const result = (await f.openai.adapter.accountHeaders(
        headers,
      )) as AccountHeadersResult<OpenAIAttemptData>
      expect(result.headers.authorization).toBe(
        drop === 'mismatched' ? 'Bearer b-token' : 'Bearer a-token',
      )
      expect(joins).toHaveBeenCalledTimes(2)
    } finally {
      monotonic.mockRestore()
      joins.mockRestore()
    }
  })
}
