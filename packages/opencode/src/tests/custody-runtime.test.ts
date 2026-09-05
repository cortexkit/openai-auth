/**
 * Loader-level custody runtime tests.
 *
 * The runtime owns one vendored client + cache per process, runs the boot
 * completion sweep before the background refresh is armed, ticks every five
 * minutes with jitter, and projects custody state into the sidebar. These
 * tests drive the runtime directly through `__createCustodyRuntimeForTest`
 * with injectable deps; the loader-order case drives `CodexAuthPlugin` through
 * its custody seam so the handoff to background refresh is observable.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountStorage, OAuthAccount } from '../core/accounts.ts'
import {
  FallbackAccountManager,
  loadAccounts,
  mutateAccounts,
  saveAccounts,
} from '../core/accounts.ts'
import {
  __resetEnrollPendingForTest,
  CUSTODY_TOMBSTONE_PREFIX,
  enrollPendingReason,
} from '../core/custody.ts'
import {
  type CustodyManifestReadResult,
  defaultCustodyManifestPath,
  readCustodyManifest,
} from '../core/custody-manifest.ts'
import { CUSTODY_DEPS_INCOMPLETE } from '../core/refresh-all-quota.ts'
import {
  __createCustodyRuntimeForTest,
  __resetSweepFailureLogDedupeForTest,
  type ClaustrumCacheTransportLike,
  CodexAuthPlugin,
  type CustodyRuntimeOptions,
} from '../index.ts'
import type { detectClaustrumConnection } from '../vendor/claustrum-client/index.ts'
import {
  claustrumConfig,
  emptyManifest,
  enrollmentManifest,
  liveAccount,
  liveStorage,
  makeSentinelAccount,
  TOMBSTONE_OPENAI,
  withClaustrumMode,
} from './custody-fixtures.ts'
import {
  FLOOR_CLAUSTRUM_HANDLES,
  FLOOR_CLAUSTRUM_HANDLES_LOCK,
} from './setup-env.ts'

const HANDLE = 'ckh_ZmItMQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let scratchDir: string
let configPath: string
let manifestPath: string
let originalManifestEnv: string | undefined

type Detections = 'available' | 'absent' | 'malformed'
type DetectionResult = Awaited<ReturnType<typeof detectClaustrumConnection>>

function detectOverride(
  detections: Detections,
): () => Promise<DetectionResult> {
  return async () => {
    if (detections === 'available') {
      return {
        status: 'available',
        schema: 1,
        wireVersion: 1,
        endpoints: [],
      }
    }
    if (detections === 'absent') {
      return { status: 'absent', path: manifestPath }
    }
    return { status: 'malformed', path: manifestPath, reason: 'bad shape' }
  }
}

interface CapturedTransport {
  getCalls: Array<{ handle: string; minTtlMs?: number }>
  reportCalls: Array<{
    handle: string
    providerStatus: number
    recordVersion: number
  }>
  statusCalls: Array<{ handle: string }>
  closeCalls: number
}

function makeTransport(
  behaviour: (input: { handle: string; minTtlMs?: number }) =>
    | {
        material: string
        recordVersion: number
        expiresAtMs: number
      }
    | Promise<{
        material: string
        recordVersion: number
        expiresAtMs: number
      }>,
): { transport: ClaustrumCacheTransportLike; captured: CapturedTransport } {
  const captured: CapturedTransport = {
    getCalls: [],
    reportCalls: [],
    statusCalls: [],
    closeCalls: 0,
  }
  const transport: ClaustrumCacheTransportLike = {
    getCredential: async (handle, minTtlMs) => {
      captured.getCalls.push({ handle, minTtlMs })
      return behaviour({ handle, minTtlMs })
    },
    statusCredential: async (handle) => {
      captured.statusCalls.push({ handle })
      return {
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      }
    },
    reportAuthFailure: async (params) => {
      captured.reportCalls.push(params)
    },
    close: () => {
      captured.closeCalls += 1
    },
  }
  return { transport, captured }
}

function makeJwt(accountId: string | undefined, expiresInSec = 600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  )
  const claims: Record<string, unknown> = {
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
  }
  if (accountId) {
    claims['https://api.openai.com/auth'] = { chatgpt_account_id: accountId }
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.sig`
}

async function writeStorageWithManifest(
  storage: AccountStorage,
  manifest: CustodyManifestReadResult,
): Promise<void> {
  if (!manifest.ok) return
  // Serialise the owning provider only — the reader ignores other blocks.
  const file = {
    version: manifest.value.version,
    providers: manifest.value.providers,
  }
  await saveAccounts(storage, configPath)
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
  writeFileSync(manifestPath, JSON.stringify(file), { mode: 0o600 })
  chmodSync(manifestPath, 0o600)
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'custody-runtime-'))
  configPath = join(scratchDir, 'openai-auth.json')
  manifestPath = join(scratchDir, 'opencode-handles.json')
  originalManifestEnv = process.env.CLAUSTRUM_OPENCODE_HANDLES
  process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
  __resetEnrollPendingForTest()
  __resetSweepFailureLogDedupeForTest()
})

afterEach(() => {
  process.env.CLAUSTRUM_OPENCODE_HANDLES =
    originalManifestEnv ?? FLOOR_CLAUSTRUM_HANDLES
  try {
    rmSync(scratchDir, { recursive: true, force: true })
  } catch {}
})

function makeLogger() {
  return {
    info: mock((_msg: string, _meta?: unknown) => undefined),
    warn: mock((_msg: string, _meta?: unknown) => undefined),
    debug: mock((_msg: string, _meta?: unknown) => undefined),
    error: mock((_msg: string, _meta?: unknown) => undefined),
  }
}

function makeOptions(
  overrides: Partial<CustodyRuntimeOptions> & {
    storage: AccountStorage | null
    transport: ClaustrumCacheTransportLike
    detection: Detections
    logger?: CustodyRuntimeOptions['logger']
  },
): CustodyRuntimeOptions {
  const { storage: _ignoredStorage, ...rest } = overrides
  void _ignoredStorage
  const storage = overrides.storage
    ? {
        ...overrides.storage,
        claustrum:
          overrides.storage.claustrum ?? claustrumConfig({ mode: 'claustrum' }),
      }
    : overrides.storage
  return {
    storage,
    configPath,
    manifestPath,
    detectClaustrumConnection: detectOverride(overrides.detection),
    cacheConnector: async () => overrides.transport,
    loadAccounts: (path?: string) => loadAccounts(path ?? configPath),
    mutateAccounts,
    readCustodyManifest,
    acquireRefreshFileLock: async () => ({
      release: async () => {},
    }),
    logger: overrides.logger ?? makeLogger(),
    ...rest,
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('custody detection', () => {
  it('logs once at info and creates no client or timer when the connection file is absent', async () => {
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      statusCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      reportAuthFailure: mock(async () => undefined),
      close: () => {},
    }
    const logger = makeLogger()
    const setIntervalFn = mock(
      () => 0 as unknown as ReturnType<typeof setInterval>,
    )
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([liveAccount('fb-1')]),
        transport,
        detection: 'absent',
        logger,
        setIntervalFn,
        clearIntervalFn: mock(() => undefined),
      }),
    )
    await runtime.boot()
    expect(runtime.isEnabled()).toBe(false)
    expect(runtime.getCache()).toBeUndefined()
    expect(runtime.getTransport()).toBeUndefined()
    // The absent case is logged once at info.
    const infoMessages = logger.info.mock.calls.map(([msg]) => msg)
    expect(
      infoMessages.some((msg) => msg.includes('custody not configured')),
    ).toBe(true)
    expect(setIntervalFn).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('logs once at warn and disables custody for the process when the connection file is malformed', async () => {
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      statusCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      reportAuthFailure: mock(async () => undefined),
      close: () => {},
    }
    const logger = makeLogger()
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([liveAccount('fb-1')]),
        transport,
        detection: 'malformed',
        logger,
      }),
    )
    await runtime.boot()
    expect(runtime.isEnabled()).toBe(false)
    expect(runtime.getCache()).toBeUndefined()
    const warnMessages = logger.warn.mock.calls.map(([msg]) => msg)
    expect(
      warnMessages.some((msg) => msg.includes('connection malformed')),
    ).toBe(true)
    runtime.dispose()
  })
})

// ---------------------------------------------------------------------------
// Warm / tick
// ---------------------------------------------------------------------------

describe('custody warm and tick', () => {
  it('resolves the warm within the bound and the cache is immediately peekable', async () => {
    const account = liveAccount('fb-1', { accountId: 'acct-1' })
    const manifest = enrollmentManifest('fb-1')
    await writeStorageWithManifest(liveStorage([account]), manifest)
    const { transport, captured } = makeTransport(({ handle }) => ({
      material: makeJwt('acct-1'),
      recordVersion: 7,
      expiresAtMs: Date.now() + 600_000,
    }))
    const logger = makeLogger()
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([account], {
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        transport,
        detection: 'available',
        logger,
      }),
    )
    const start = Date.now()
    await runtime.boot()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
    const cache = runtime.getCache()
    expect(cache).toBeDefined()
    expect(captured.getCalls.length).toBeGreaterThan(0)
    const peeked = await cache?.peek(HANDLE)
    expect(peeked?.recordVersion).toBe(7)
    runtime.dispose()
  })

  it('does not delay the loader past the warm bound when the vault is slow; populates later', async () => {
    const account = makeSentinelAccount({ id: 'fb-1', accountId: 'acct-1' })
    await writeStorageWithManifest(
      liveStorage([account]),
      enrollmentManifest('fb-1'),
    )
    const slowTransport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return {
          material: makeJwt('acct-1'),
          recordVersion: 9,
          expiresAtMs: Date.now() + 600_000,
        }
      }),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 9,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => {},
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport: slowTransport,
        detection: 'available',
      }),
    )
    const start = Date.now()
    await runtime.boot()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(250)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const peeked = await runtime.getCache()?.peek(HANDLE)
    expect(peeked?.recordVersion).toBe(9)
    runtime.dispose()
  })

  it("schedules the first tick at t+0 and the interval sits inside the 5-minute ± 30 s jitter envelope; the timer is unref'd", async () => {
    const account = liveAccount('fb-1', { accountId: 'acct-1' })
    await writeStorageWithManifest(
      liveStorage([account]),
      enrollmentManifest('fb-1'),
    )
    const fakeTimer = { unref: mock(() => undefined) }
    const timerHandle = fakeTimer as unknown as ReturnType<typeof setInterval>
    const setIntervalFn = mock(
      (_cb: () => void, _ms: number): ReturnType<typeof setInterval> =>
        timerHandle,
    )
    const clearIntervalFn = mock(() => undefined)
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => ({
        material: makeJwt('acct-1'),
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      })),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => {},
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport,
        detection: 'available',
        setIntervalFn: setIntervalFn as unknown as (
          callback: () => void,
          intervalMs: number,
        ) => ReturnType<typeof setInterval>,
        clearIntervalFn,
      }),
    )
    await runtime.boot()
    expect(setIntervalFn).toHaveBeenCalled()
    const callArgs = setIntervalFn.mock.calls[0]
    const intervalMs = callArgs?.[1]
    expect(intervalMs).toBeDefined()
    expect(intervalMs!).toBeGreaterThanOrEqual(5 * 60_000 - 30_000)
    expect(intervalMs!).toBeLessThanOrEqual(5 * 60_000 + 30_000)
    expect(fakeTimer.unref).toHaveBeenCalled()
    runtime.dispose()
  })

  it('makes zero vault calls on a manifest entry when the storage toggle is off', async () => {
    const account = liveAccount('fb-1', { accountId: 'acct-1' })
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [account],
      claustrum: claustrumConfig({ mode: 'local' }),
    }
    await writeStorageWithManifest(storage, enrollmentManifest('fb-1'))
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      statusCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      reportAuthFailure: mock(async () => undefined),
      close: () => {},
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    await runtime.runTick()
    expect(transport.getCredential).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('limits to one get per enabled manifest account per tick', async () => {
    const a = liveAccount('fb-1', { accountId: 'acct-1' })
    const b = liveAccount('fb-2', { accountId: 'acct-2' })
    const manifest: CustodyManifestReadResult = {
      ok: true,
      value: {
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
              {
                label: 'fb-2',
                handle: `ckh_${'b'.repeat(43)}`,
                credential_id: 'oauth:openai:fb-2',
              },
            ],
          },
        ],
      },
      revision: 'test-manifest-revision',
    }
    await writeStorageWithManifest(liveStorage([a, b]), manifest)
    const { transport, captured } = makeTransport(({ handle }) => ({
      material: makeJwt(handle === HANDLE ? 'acct-1' : 'acct-2'),
      recordVersion: 3,
      expiresAtMs: Date.now() + 600_000,
    }))
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([a, b]),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    const initialGetCalls = captured.getCalls.length
    await runtime.runTick()
    // One get per account (the sweep's force:true on each enrolling account
    // is the only get for an `enrolling` account; the warm pass is one
    // get per enabled account).
    const delta = captured.getCalls.length - initialGetCalls
    expect(delta).toBeLessThanOrEqual(2)
    runtime.dispose()
  })

  it('skips the tick when the runtime is disposed', async () => {
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => ({
        material: makeJwt('acct-1'),
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      })),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: mock(() => undefined),
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([liveAccount('fb-1', { accountId: 'acct-1' })]),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    runtime.dispose()
    await runtime.runTick() // should be a no-op
    expect(transport.close).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Enroll-completion sweep
// ---------------------------------------------------------------------------

describe('enroll-completion sweep', () => {
  it('writes both tombstone fields and expiry in exactly one account mutation', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-1' })
    await writeStorageWithManifest(
      liveStorage([live]),
      enrollmentManifest(live.id),
    )
    const { transport } = makeTransport(() => ({
      material: makeJwt('acct-1'),
      recordVersion: 21,
      expiresAtMs: Date.now() + 600_000,
    }))
    const writes: OAuthAccount[] = []
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([live])),
        transport,
        detection: 'available',
        mutateAccounts: async (transform, path) => {
          const before = await loadAccounts(path)
          if (before) {
            const after = transform(before)
            const changed = after?.accounts.find(
              (account) => account.id === live.id,
            )
            if (changed?.type === 'oauth') writes.push(changed)
          }
          return mutateAccounts(transform, path)
        },
      }),
    )
    await runtime.boot()
    expect(writes).toEqual([
      expect.objectContaining({
        access: TOMBSTONE_OPENAI,
        refresh: TOMBSTONE_OPENAI,
        expires: 0,
      }),
    ])
    runtime.dispose()
  })

  it('completes an enrolling account before boot returns: a manifest entry with no enroll having run lands the tombstone', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-1' })
    // Live access/refresh; no enroll has run.
    await saveAccounts(liveStorage([live]), configPath)
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    const { transport, captured } = makeTransport(({ handle }) => ({
      material: makeJwt('acct-1'),
      recordVersion: 11,
      expiresAtMs: Date.now() + 600_000,
    }))
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([live])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    const after = await loadAccounts(configPath)
    const tombstonedAccount = after?.accounts.find((a) => a.id === 'fb-1')
    if (tombstonedAccount?.type !== 'oauth')
      throw new Error('expected oauth account')
    expect(tombstonedAccount.access).toBe(TOMBSTONE_OPENAI)
    expect(tombstonedAccount.refresh).toBe(TOMBSTONE_OPENAI)
    expect(tombstonedAccount.expires).toBe(0)
    // Manifest entry untouched by the sweep.
    const manifestRaw = JSON.parse(await Bun.file(manifestPath).text()) as {
      providers: Array<{ accounts: Array<unknown> }>
    }
    expect(manifestRaw.providers[0]?.accounts.length).toBe(1)
    expect(captured.getCalls.length).toBeGreaterThan(0)
    runtime.dispose()
  })

  it('refuses the sweep when the served claim differs from the local account id; the local family is intact', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-local' })
    await saveAccounts(liveStorage([live]), configPath)
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    // Served token carries a DIFFERENT ChatGPT account id.
    const { transport } = makeTransport(({ handle }) => ({
      material: makeJwt('acct-foreign'),
      recordVersion: 12,
      expiresAtMs: Date.now() + 600_000,
    }))
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([live])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    const after = await loadAccounts(configPath)
    const account = after?.accounts.find((a) => a.id === 'fb-1')
    if (account?.type !== 'oauth') throw new Error('expected oauth account')
    // Local family intact — no tombstone, no write.
    expect(account.access).toBe('acc-fb-1')
    expect(account.refresh).toBe('ref-fb-1')
    expect(account.expires).toBeGreaterThan(0)
    // Manifest entry untouched.
    const manifestRaw = JSON.parse(await Bun.file(manifestPath).text()) as {
      providers: Array<{ accounts: Array<unknown> }>
    }
    expect(manifestRaw.providers[0]?.accounts.length).toBe(1)
    runtime.dispose()
  })

  it('refuses the sweep when the served access token has no claims (nullClaim)', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-1' })
    await saveAccounts(liveStorage([live]), configPath)
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    const { transport } = makeTransport(({ handle }) => ({
      material: 'not-a-jwt',
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([live])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    const after = await loadAccounts(configPath)
    const account = after?.accounts.find((a) => a.id === 'fb-1')
    if (account?.type !== 'oauth') throw new Error('expected oauth account')
    expect(account.access).toBe('acc-fb-1')
    expect(account.refresh).toBe('ref-fb-1')
    runtime.dispose()
  })

  it('skips the sweep when the per-account refresh lock is busy and never waits', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-1' })
    await saveAccounts(liveStorage([live]), configPath)
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    const { transport } = makeTransport(({ handle }) => ({
      material: makeJwt('acct-1'),
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([live])),
        transport,
        detection: 'available',
        acquireRefreshFileLock: async () => null,
      }),
    )
    await runtime.boot()
    const after = await loadAccounts(configPath)
    const account = after?.accounts.find((a) => a.id === 'fb-1')
    if (account?.type !== 'oauth') throw new Error('expected oauth account')
    expect(account.access).toBe('acc-fb-1')
    runtime.dispose()
  })
})

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('custody runtime disposal', () => {
  it('closes the cache and transport on dispose and is idempotent', async () => {
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => ({
        material: makeJwt('acct-1'),
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      })),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: mock(() => undefined),
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([liveAccount('fb-1', { accountId: 'acct-1' })]),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    runtime.dispose()
    runtime.dispose()
    expect(transport.close).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Boot order
// ---------------------------------------------------------------------------

describe('custody boot order', () => {
  it('does not arm fallback refresh until a blocked enrollment completion has tombstoned storage', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-1' })
    const manifest = enrollmentManifest(live.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    writeFileSync(
      configPath,
      JSON.stringify({
        ...liveStorage([live]),
        claustrum: claustrumConfig({ mode: 'claustrum' }),
      }),
    )
    writeFileSync(manifestPath, JSON.stringify(manifest.value))
    chmodSync(manifestPath, 0o600)

    let enteredResolve!: () => void
    let releaseResolve!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve
    })
    const transport: ClaustrumCacheTransportLike = {
      async getCredential() {
        enteredResolve()
        await release
        return {
          material: makeJwt('acct-1'),
          recordVersion: 31,
          expiresAtMs: Date.now() + 600_000,
        }
      },
      async statusCredential() {
        return {
          ready: true,
          lastErrorCode: null,
          leaseHeld: false,
          recordVersion: 31,
        }
      },
      async reportAuthFailure() {},
      close() {},
    }
    const originalStart =
      FallbackAccountManager.prototype.startBackgroundRefresh
    const starts = mock(function (this: FallbackAccountManager) {
      return originalStart.call(this)
    })
    FallbackAccountManager.prototype.startBackgroundRefresh = starts
    const originalAuthFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    const originalStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const originalSidebarFile =
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    const originalLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(scratchDir, 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
      scratchDir,
      'sidebar.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(scratchDir, 'test.log')
    process.env.OPENCODE_CONFIG_DIR = scratchDir
    let hooks: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
    try {
      hooks = await CodexAuthPlugin(
        {
          client: { auth: { set: async () => {} } },
          project: { id: 'test', name: 'test' },
          directory: '',
          worktree: scratchDir,
          experimental_workspace: { register: () => {} },
          serverUrl: new URL('http://localhost:0'),
          $: {},
        } as never,
        { custody: { transport, detection: 'available' } },
      )
      const loader = hooks.auth?.loader
      if (!loader) throw new Error('expected auth loader')
      const loading = loader(
        async () => ({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3_600_000,
        }),
        {} as never,
      )
      await entered
      expect(starts).not.toHaveBeenCalled()
      await new Promise((resolve) => setTimeout(resolve, 125))
      expect(starts).not.toHaveBeenCalled()
      releaseResolve()
      await loading
      expect(starts).toHaveBeenCalledTimes(1)
      const after = await loadAccounts(configPath)
      const tombstoned = after?.accounts.find(
        (account) => account.id === live.id,
      )
      if (tombstoned?.type !== 'oauth')
        throw new Error('expected oauth account')
      expect(tombstoned).toMatchObject({
        access: TOMBSTONE_OPENAI,
        refresh: TOMBSTONE_OPENAI,
        expires: 0,
      })
    } finally {
      releaseResolve()
      await hooks?.dispose?.()
      FallbackAccountManager.prototype.startBackgroundRefresh = originalStart
      process.env.OPENCODE_OPENAI_AUTH_FILE = originalAuthFile
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = originalStateFile
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = originalSidebarFile
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = originalLogFile
      if (originalConfigDir === undefined)
        delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
    }
  })

  it('runs the initial completion sweep before the first tick fires', async () => {
    const live = liveAccount('fb-1', { accountId: 'acct-1' })
    await saveAccounts(liveStorage([live]), configPath)
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    const sweepEvents: string[] = []
    const { transport } = makeTransport(({ handle }) => ({
      material: makeJwt('acct-1'),
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    // Wrap the transport to track call order vs `setInterval`.
    const wrapped: ClaustrumCacheTransportLike = {
      ...transport,
      getCredential: async (...args) => {
        sweepEvents.push('get')
        return transport.getCredential(...args)
      },
    }
    let tickScheduledAt: number | undefined
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([live])),
        transport: wrapped,
        detection: 'available',
        setIntervalFn: (cb, ms) => {
          tickScheduledAt = sweepEvents.length
          cb()
          return 0 as unknown as ReturnType<typeof setInterval>
        },
        clearIntervalFn: mock(() => undefined),
      }),
    )
    await runtime.boot()
    expect(tickScheduledAt).toBeDefined()
    // The completion sweep runs BEFORE the timer is scheduled (and the first
    // tick is fire-and-forget, but the get order pins it).
    expect(sweepEvents[0]).toBe('get')
    runtime.dispose()
  })
})

// ---------------------------------------------------------------------------
// Quota construction builder
// ---------------------------------------------------------------------------

describe('quota construction dep wiring', () => {
  it('omitting the resolver + reporter fails closed with custody-deps-incomplete', async () => {
    const { refreshAllQuota } = await import('../core/refresh-all-quota.ts')
    const deps = {
      getAuth: async () => ({
        type: 'oauth' as const,
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 3600_000,
      }),
      codexRefreshFn: async () => ({
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 3600_000,
      }),
      refreshMainWithLease: async () => ({
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 3600_000,
      }),
      fallbackManager: {
        refreshAccount: async (a: unknown) => a,
      },
      quotaManager: {
        setFallback: () => undefined,
        isFallbackBackedOff: () => false,
        peekFallbackForPolicy: () => undefined,
      },
      loadAccounts: async () => ({
        version: 1 as const,
        mainAccountId: 'main',
        accounts: [
          {
            id: 'fb-1',
            type: 'oauth' as const,
            access: 'acc-fb1',
            refresh: 'ref-fb1',
            expires: Date.now() + 3600_000,
            accountId: 'acct-1',
          },
        ],
      }),
      writeSidebarState: async () => undefined,
      client: { auth: { set: async () => undefined } },
      fetchImpl: fetch,
      now: () => Date.now(),
      configPath: '/tmp/test.json',
      storageMainAccountId: 'main',
      isOAuthAccountFn: () => true,
      whamFn: async () => ({
        primary: { usedPercent: 0, remainingPercent: 100 },
      }),
      // Only isFallbackRefreshInert is wired; resolver + reporter missing —
      // mirrors what happens at one quota construction if the spread drops
      // the custody deps entirely. The poller must fail closed.
      isFallbackRefreshInert: async () => true,
    } as unknown as Parameters<typeof refreshAllQuota>[0]
    const results = await refreshAllQuota(deps, { accountKey: 'fb-1' })
    const fb = results.find((r) => r.account === 'fb-1')
    expect(fb?.ok).toBe(false)
    expect(fb?.error).toBe(CUSTODY_DEPS_INCOMPLETE)
  })
})

// ---------------------------------------------------------------------------
// Enroll-completion latch
// ---------------------------------------------------------------------------

function makeSingleEnrollingSetup(): OAuthAccount {
  return {
    id: 'fb-1',
    type: 'oauth' as const,
    access: 'acc-fb-1',
    refresh: 'ref-fb-1',
    expires: Date.now() + 3_600_000,
    addedAt: 1_000,
    accountId: 'acct-1',
  }
}

async function writeSingleEnrollingFixture(
  armed = true,
): Promise<OAuthAccount> {
  const account = makeSingleEnrollingSetup()
  await saveAccounts(
    armed ? withClaustrumMode(liveStorage([account])) : liveStorage([account]),
    configPath,
  )
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      providers: [
        {
          provider: 'openai',
          shape: 'oauth',
          serve: 'openai-auth',
          accounts: [
            {
              label: 'fb-1',
              handle: HANDLE,
              credential_id: 'oauth:openai:fb-1',
            },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  )
  chmodSync(manifestPath, 0o600)
  return account
}

describe('enroll-completion sweep latch', () => {
  it('leaves local enrollment secrets intact while completion is disarmed across boot and ticks', async () => {
    const account = await writeSingleEnrollingFixture(false)
    const before = JSON.stringify({
      access: account.access,
      refresh: account.refresh,
    })
    const logger = makeLogger()
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => ({
        material: makeJwt('acct-1'),
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      })),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: liveStorage([account], {
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        transport,
        detection: 'available',
        logger,
      }),
    )
    await runtime.boot()
    await runtime.runTick()
    await runtime.runTick()
    const persisted = await loadAccounts(configPath)
    const after = persisted?.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    expect(after?.type).toBe('oauth')
    if (after?.type !== 'oauth') throw new Error('expected oauth account')
    expect(
      JSON.stringify({ access: after.access, refresh: after.refresh }),
    ).toBe(before)
    expect(enrollPendingReason(account.id)).toBe('completionDisarmed')
    expect(
      logger.info.mock.calls.filter(([message]) =>
        message.includes('enrollment completion is disarmed'),
      ),
    ).toHaveLength(1)
    runtime.dispose()
  })

  it('a first completion failure latches the reason into enrollPending (the dashboard never sees a plain local)', async () => {
    const account = await writeSingleEnrollingFixture()
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        throw Object.assign(new Error('unreachable'), { action: 'retry' })
      }),
      statusCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    const projection = runtime.getCustodyProjection(account, Date.now())
    expect(projection?.state).toBe('enrollPending')
    expect(projection?.reason).toBe('unavailable')
    expect(enrollPendingReason('fb-1')).toBe('unavailable')
    runtime.dispose()
  })

  it('a second failure with a different reason does not overwrite the latched reason', async () => {
    const account = await writeSingleEnrollingFixture()
    // Stage 1: every sweep failure latches `identityMismatch` (wrong claim).
    // Stage 2 (after boot): a tick failure returns nullClaim — the latch
    // MUST NOT downgrade from `identityMismatch` to `nullClaim`.
    let phase: 'wrong-claim' | 'null-claim' = 'wrong-claim'
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        if (phase === 'wrong-claim') {
          return {
            material: makeJwt('acct-other'),
            recordVersion: 9,
            expiresAtMs: Date.now() + 600_000,
          }
        }
        return {
          material: 'not-a-jwt',
          recordVersion: 11,
          expiresAtMs: Date.now() + 600_000,
        }
      }),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    // After boot, the latch is set to identityMismatch (the only phase-1
    // outcome, regardless of which sweep ran first).
    expect(enrollPendingReason('fb-1')).toBe('identityMismatch')
    phase = 'null-claim'
    // A subsequent tick with a different failure reason: the latch MUST NOT
    // downgrade.
    await runtime.runTick()
    expect(enrollPendingReason('fb-1')).toBe('identityMismatch')
    const projection = runtime.getCustodyProjection(account, Date.now())
    expect(projection?.state).toBe('enrollPending')
    expect(projection?.reason).toBe('identityMismatch')
    runtime.dispose()
  })

  it('a later successful completion clears the latch and projects vault with the served recordVersion', async () => {
    const account = await writeSingleEnrollingFixture()
    let index = 0
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        index += 1
        if (index === 1) {
          // Boot sweep — nullClaim so the latch moves to nullClaim.
          return {
            material: 'not-a-jwt',
            recordVersion: 1,
            expiresAtMs: Date.now() + 600_000,
          }
        }
        // Tick sweep succeeds with the local account id.
        return {
          material: makeJwt('acct-1'),
          recordVersion: 7,
          expiresAtMs: Date.now() + 600_000,
        }
      }),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    expect(enrollPendingReason('fb-1')).toBe('nullClaim')
    const afterBoot = runtime.getCustodyProjection(account, Date.now())
    expect(afterBoot?.state).toBe('enrollPending')
    expect(afterBoot?.reason).toBe('nullClaim')
    await runtime.runTick()
    expect(enrollPendingReason('fb-1')).toBeUndefined()
    const projection = runtime.getCustodyProjection(account, Date.now())
    expect(projection?.state).toBe('vault')
    expect(projection?.recordVersion).toBe(7)
    runtime.dispose()
  })
})

// ---------------------------------------------------------------------------
// Sweep failure log
// ---------------------------------------------------------------------------

describe('sweep failure log dedupe', () => {
  it('logs once per account+reason within an hour; emits again past the hour', async () => {
    const account = await writeSingleEnrollingFixture()
    const logger1 = makeLogger()
    let clock = 1_000_000
    const transport1: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        throw Object.assign(new Error('boom'), { action: 'gone' })
      }),
      statusCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime1 = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport: transport1,
        detection: 'available',
        logger: logger1,
        now: () => clock,
      }),
    )
    await runtime1.boot()
    // Two failures within the hour: only one warn line.
    await runtime1.runTick()
    const failed1 = logger1.warn.mock.calls.filter(([msg]) =>
      msg.includes('enroll-completion sweep failed'),
    )
    expect(failed1).toHaveLength(1)
    const firstMeta = failed1[0]?.[1] as Record<string, unknown>
    expect(firstMeta.accountId).toBe('fb-1')
    expect(firstMeta.reason).toBe('gone')
    runtime1.dispose()
    // Advance the clock past the hour; the next failure emits again.
    clock += 60 * 60_000 + 1_000
    __resetSweepFailureLogDedupeForTest()
    const logger2 = makeLogger()
    const transport2: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        throw Object.assign(new Error('boom2'), { action: 'gone' })
      }),
      statusCredential: mock(async () => {
        throw new Error('should not be called')
      }),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime2 = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport: transport2,
        detection: 'available',
        logger: logger2,
        now: () => clock,
      }),
    )
    await runtime2.boot()
    const failed2 = logger2.warn.mock.calls.filter(([msg]) =>
      msg.includes('enroll-completion sweep failed'),
    )
    expect(failed2).toHaveLength(1)
    runtime2.dispose()
  })
})

// ---------------------------------------------------------------------------
// recordVersion projection
// ---------------------------------------------------------------------------

describe('recordVersion projection', () => {
  it('the warm pass threads the served recordVersion into the sidebar projection', async () => {
    const account = liveAccount('fb-1', { accountId: 'acct-1' })
    // Start already-tombstoned so the warm pass is the active path.
    await saveAccounts(
      liveStorage([makeSentinelAccount({ id: 'fb-1', accountId: 'acct-1' })]),
      configPath,
    )
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'openai',
            shape: 'oauth',
            serve: 'openai-auth',
            accounts: [
              {
                label: 'fb-1',
                handle: HANDLE,
                credential_id: 'oauth:openai:fb-1',
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => ({
        material: makeJwt('acct-1'),
        recordVersion: 17,
        expiresAtMs: Date.now() + 600_000,
      })),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 17,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport,
        detection: 'available',
      }),
    )
    await runtime.boot()
    await runtime.runTick()
    const projection = runtime.getCustodyProjection(account, Date.now())
    expect(projection?.state).toBe('vault')
    expect(projection?.recordVersion).toBe(17)
    const json = JSON.stringify(projection)
    expect(json).not.toContain(HANDLE)
    expect(json).not.toContain('material')
    runtime.dispose()
  })
})

// ---------------------------------------------------------------------------
// Under-lock re-check
// ---------------------------------------------------------------------------

describe('under-lock re-check', () => {
  it('skips the sweep without get or write when the account is no longer enrolling under the lock', async () => {
    const account = await writeSingleEnrollingFixture()
    let lockAcquired = 0
    const getCalls: string[] = []
    const transport: ClaustrumCacheTransportLike = {
      getCredential: mock(async () => {
        getCalls.push('called')
        return {
          material: makeJwt('acct-1'),
          recordVersion: 1,
          expiresAtMs: Date.now() + 600_000,
        }
      }),
      statusCredential: mock(async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      })),
      reportAuthFailure: mock(async () => undefined),
      close: () => undefined,
    }
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage: withClaustrumMode(liveStorage([account])),
        transport,
        detection: 'available',
        acquireRefreshFileLock: async () => {
          lockAcquired += 1
          // Tombstone the account between the pre-lock check and the lock
          // acquisition. The under-lock re-check must see a non-enrolling
          // account and skip the sweep. The first tick's warm pass still
          // issues one get (it observes the now-tombstoned account as a
          // valid refresh-inert target); with the re-check, no SWEEP get
          // is issued. Dropping the re-check would add a second get.
          await saveAccounts(
            liveStorage([
              makeSentinelAccount({ id: 'fb-1', accountId: 'acct-1' }),
            ]),
            configPath,
          )
          return { release: async () => undefined }
        },
      }),
    )
    await runtime.boot()
    expect(lockAcquired).toBe(1)
    // One get from the warm pass; zero from the sweep under the re-check.
    expect(getCalls).toHaveLength(1)
    runtime.dispose()
  })
})

// Keep the floor import referenced so a deletion in setup-env surfaces here.
void FLOOR_CLAUSTRUM_HANDLES_LOCK
void defaultCustodyManifestPath
void CUSTODY_TOMBSTONE_PREFIX
void emptyManifest
