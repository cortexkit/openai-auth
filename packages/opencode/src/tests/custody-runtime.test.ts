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
import type {
  AccountStorage,
  CorruptOAuthAccount,
  OAuthAccount,
} from '../core/accounts.ts'
import {
  FallbackAccountManager,
  loadAccounts,
  mutateAccounts,
  saveAccounts,
  withAccountStoreTransaction,
} from '../core/accounts.ts'
import { CUSTODY_TOMBSTONE_PREFIX } from '../core/custody.ts'
import {
  type CustodyManifestReadResult,
  defaultCustodyManifestPath,
  readCustodyManifest,
} from '../core/custody-manifest.ts'
import { custodySlotFingerprint } from '../core/custody-transition.ts'
import { CUSTODY_DEPS_INCOMPLETE } from '../core/refresh-all-quota.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
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
let originalStateEnv: string | undefined

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

async function writeCorruptStorageWithManifest(
  storage: AccountStorage,
  manifest: CustodyManifestReadResult,
): Promise<void> {
  await saveAccounts(storage, configPath)
  if (!manifest.ok) return
  writeFileSync(manifestPath, JSON.stringify(manifest.value), { mode: 0o600 })
  chmodSync(manifestPath, 0o600)
}

async function writeBoundRealFixture(): Promise<OAuthAccount> {
  const account = liveAccount('fb-1', { accountId: 'acct-1' })
  await writeStorageWithManifest(
    withClaustrumMode(liveStorage([account])),
    enrollmentManifest(account.id),
  )
  return account
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'custody-runtime-'))
  configPath = join(scratchDir, 'openai-auth.json')
  manifestPath = join(scratchDir, 'opencode-handles.json')
  originalManifestEnv = process.env.CLAUSTRUM_OPENCODE_HANDLES
  originalStateEnv = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
  process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(scratchDir, 'state.json')
  __resetSweepFailureLogDedupeForTest()
})

afterEach(() => {
  process.env.CLAUSTRUM_OPENCODE_HANDLES =
    originalManifestEnv ?? FLOOR_CLAUSTRUM_HANDLES
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = originalStateEnv
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
    withAccountStoreTransaction,
    readCustodyManifest,
    acquireRefreshFileLock: async () => ({
      release: async () => {},
    }),
    logger: overrides.logger ?? makeLogger(),
    ...rest,
  }
}

function corruptAccount(
  id = 'fb-1',
  overrides: Partial<CorruptOAuthAccount> = {},
): CorruptOAuthAccount {
  return {
    id,
    type: 'oauth',
    corrupt: true,
    enabled: false,
    accountId: 'acct-1',
    addedAt: 123,
    ...overrides,
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

describe('orphan binding discovery', () => {
  it('creates one binding-pending row before the manifest join across two runtimes', async () => {
    const storage = liveStorage([], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest('new-account'))
    const { transport } = makeTransport(() => {
      throw new Error('binding stays pending until a credential serves')
    })
    const first = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )
    const second = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )

    await Promise.all([first.boot(), second.boot()])

    const after = await loadAccounts(configPath)
    expect(after?.accounts).toEqual([
      {
        id: 'new-account',
        type: 'oauth',
        access: '',
        refresh: TOMBSTONE_OPENAI,
        expires: 0,
        enabled: true,
      },
    ])
    expect(after?.claustrum?.rowHistory).toEqual(['new-account'])
    first.dispose()
    second.dispose()
  })

  it('logs an orphan once under local mode without creating a row or client', async () => {
    const storage = liveStorage([], {
      claustrum: claustrumConfig({ mode: 'local' }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest('new-account'))
    const logger = makeLogger()
    let connections = 0
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport: makeTransport(() => {
          throw new Error('unused')
        }).transport,
        detection: 'available',
        logger,
        cacheConnector: async () => {
          connections += 1
          throw new Error('must not connect')
        },
      }),
    )

    await runtime.boot()

    expect((await loadAccounts(configPath))?.accounts).toEqual([])
    expect(connections).toBe(0)
    expect(
      logger.info.mock.calls.filter(([message]) =>
        message.includes('orphan-binding: awaiting discovery'),
      ),
    ).toHaveLength(1)
    runtime.dispose()
  })
})

describe('manifest revision reconciliation', () => {
  it('discovers a new manifest row on the first tick after its revision changes', async () => {
    const storage = liveStorage([], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    await writeStorageWithManifest(storage, emptyManifest())
    const { transport } = makeTransport(() => {
      throw new Error('vault unavailable')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )
    await runtime.boot()
    const nextManifest = enrollmentManifest('revision-account')
    if (!nextManifest.ok) throw new Error('expected manifest')
    writeFileSync(manifestPath, JSON.stringify(nextManifest.value))

    await runtime.runTick()

    expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
      id: 'revision-account',
      refresh: TOMBSTONE_OPENAI,
      accountId: undefined,
    })
    runtime.dispose()
  })

  it('refuses an unreadable manifest before credential inspection and projects its cause', async () => {
    const account = liveAccount('fb-1')
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    await saveAccounts(storage, configPath)
    const { transport, captured } = makeTransport(() => {
      throw new Error('must not inspect vault credentials')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        readCustodyManifest: async () => ({
          ok: false,
          reason: 'invalid',
          message: 'invalid manifest',
        }),
      }),
    )

    await runtime.boot()

    expect(captured.getCalls).toEqual([])
    expect(runtime.getCustodyProjection(account, Date.now())).toEqual({
      state: 'inert',
      reason: 'manifest-unreadable',
    })
    runtime.dispose()
  })
})

describe('fingerprint-gated reconciliation resume', () => {
  it('tombstones a matching fallback row and clears the completed transition', async () => {
    const account = liveAccount('fb-1')
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({
        mode: 'claustrum',
        transition: {
          manifestRevision: 'revision-1',
          storeGeneration: 'generation-1',
          fingerprints: {
            fallbacks: {
              [account.id]: custodySlotFingerprint(
                account.access!,
                account.refresh,
              ),
            },
          },
        },
      }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest(account.id))
    const { transport } = makeTransport(() => {
      throw new Error('resume must not depend on the vault')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )

    await runtime.boot()

    const after = await loadAccounts(configPath)
    expect(after?.accounts[0]).toMatchObject({
      access: '',
      refresh: TOMBSTONE_OPENAI,
      expires: 0,
    })
    expect(after?.claustrum?.transition).toBeUndefined()
    runtime.dispose()
  })

  it('keeps a mismatched fallback real and retains all transition fingerprints', async () => {
    const account = liveAccount('fb-1', { access: 'new-local-access' })
    const transition = {
      manifestRevision: 'revision-1',
      storeGeneration: 'generation-1',
      fingerprints: {
        fallbacks: {
          [account.id]: custodySlotFingerprint(
            'old-local-access',
            account.refresh,
          ),
        },
      },
    }
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum', transition }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest(account.id))
    const { transport } = makeTransport(() => {
      throw new Error('resume must not depend on the vault')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )

    await runtime.boot()

    const after = await loadAccounts(configPath)
    expect(after?.accounts[0]).toMatchObject({
      access: 'new-local-access',
      refresh: account.refresh,
    })
    expect(after?.claustrum?.transition).toEqual(transition)
    runtime.dispose()
  })

  it('skips an already-tombstoned fallback before comparing its stale fingerprint', async () => {
    const account = makeSentinelAccount({ id: 'fb-1' })
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({
        mode: 'claustrum',
        transition: {
          manifestRevision: 'revision-1',
          storeGeneration: 'generation-1',
          fingerprints: {
            fallbacks: {
              [account.id]: custodySlotFingerprint('old-access', 'old-refresh'),
            },
          },
        },
      }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest(account.id))
    const { transport } = makeTransport(() => {
      throw new Error('resume must not depend on the vault')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )

    await runtime.boot()

    expect(
      (await loadAccounts(configPath))?.claustrum?.transition,
    ).toBeUndefined()
    runtime.dispose()
  })

  it('retains the transition while any persisted fallback fingerprint is incomplete', async () => {
    const matching = liveAccount('matching')
    const mismatch = liveAccount('mismatch', { access: 'new-access' })
    const transition = {
      manifestRevision: 'revision-1',
      storeGeneration: 'generation-1',
      fingerprints: {
        fallbacks: {
          matching: custodySlotFingerprint(matching.access!, matching.refresh),
          mismatch: custodySlotFingerprint('old-access', mismatch.refresh),
        },
      },
    }
    const storage = liveStorage([matching, mismatch], {
      claustrum: claustrumConfig({ mode: 'claustrum', transition }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest(matching.id))
    const { transport } = makeTransport(() => {
      throw new Error('resume must not depend on the vault')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )

    await runtime.boot()

    const after = await loadAccounts(configPath)
    expect(after?.accounts[0]).toMatchObject({ refresh: TOMBSTONE_OPENAI })
    expect(after?.accounts[1]).toMatchObject({ access: 'new-access' })
    expect(after?.claustrum?.transition).toEqual(transition)
    runtime.dispose()
  })

  it('resumes main through the guarded host-slot path and retries an empty auth map on tick', async () => {
    const main = {
      type: 'oauth' as const,
      access: 'main-access',
      refresh: 'main-refresh',
      expires: 1,
    }
    const transition = {
      manifestRevision: 'revision-1',
      storeGeneration: 'generation-1',
      fingerprints: {
        main: custodySlotFingerprint(main.access, main.refresh),
        fallbacks: {},
      },
    }
    const storage = liveStorage([], {
      claustrum: claustrumConfig({ mode: 'claustrum', transition }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest('main'))
    const { transport } = makeTransport(() => {
      throw new Error('resume must not depend on the vault')
    })
    let empty = true
    let writes = 0
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        auth: {
          all: async () => (empty ? {} : { openai: main }),
          get: async () => main,
          set: async ({ body }) => {
            writes += 1
            Object.assign(main, body)
          },
        },
      }),
    )

    await runtime.boot()
    expect(writes).toBe(0)
    expect((await loadAccounts(configPath))?.claustrum?.transition).toEqual(
      transition,
    )

    empty = false
    await runtime.runTick()
    expect(writes).toBe(1)
    expect(main).toMatchObject({
      access: TOMBSTONE_OPENAI,
      refresh: TOMBSTONE_OPENAI,
      expires: 0,
    })
    expect(
      (await loadAccounts(configPath))?.claustrum?.transition,
    ).toBeUndefined()
    runtime.dispose()
  })

  it('keeps main resume incomplete when the post-write readback is real', async () => {
    const main = {
      type: 'oauth' as const,
      access: 'main-access',
      refresh: 'main-refresh',
      expires: 1,
    }
    const transition = {
      manifestRevision: 'revision-1',
      storeGeneration: 'generation-1',
      fingerprints: {
        main: custodySlotFingerprint(main.access, main.refresh),
        fallbacks: {},
      },
    }
    const storage = liveStorage([], {
      claustrum: claustrumConfig({ mode: 'claustrum', transition }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest('main'))
    const { transport } = makeTransport(() => {
      throw new Error('resume must not depend on the vault')
    })
    let writes = 0
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        auth: {
          all: async () => ({ openai: main }),
          get: async () => main,
          set: async () => {
            writes += 1
          },
        },
      }),
    )

    await runtime.boot()

    expect(writes).toBe(1)
    expect((await loadAccounts(configPath))?.claustrum?.transition).toEqual(
      transition,
    )
    runtime.dispose()
  })
})

describe('real fallback reconciliation', () => {
  for (const [vaultState, reason] of [
    ['cold', 'takeover-incomplete/vault-unavailable'],
    ['needs_reauth', 'takeover-incomplete/vault-unavailable'],
  ] as const) {
    it(`retains real local material inert when the vault is ${vaultState}`, async () => {
      const account = liveAccount('fb-1', { accountId: 'acct-1' })
      const storage = liveStorage([account], {
        claustrum: claustrumConfig({ mode: 'claustrum' }),
      })
      await writeStorageWithManifest(storage, enrollmentManifest(account.id))
      const { transport } = makeTransport(() => {
        throw new Error('vault unavailable')
      })
      let writes = 0
      const runtime = __createCustodyRuntimeForTest(
        makeOptions({
          storage,
          transport,
          detection: 'available',
          resolveFallbackVaultState: async () => vaultState,
          mutateAccounts: async (transform, path) => {
            writes += 1
            return mutateAccounts(transform, path)
          },
        }),
      )

      await runtime.boot()
      await runtime.runTick()

      expect(writes).toBe(0)
      expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
        access: account.access,
        refresh: account.refresh,
        expires: account.expires,
      })
      expect(runtime.getCustodyProjection(account, Date.now())).toEqual({
        state: 'inert',
        reason,
      })
      runtime.dispose()
    })
  }
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
  it('does not install a tombstone into a gone main host slot', async () => {
    const storage = liveStorage([], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    await writeStorageWithManifest(storage, enrollmentManifest('main'))
    const { transport } = makeTransport(() => ({
      material: makeJwt('acct-main'),
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    let accountMutations = 0
    let hostWrites = 0
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        mutateAccounts: async (transform, path) => {
          accountMutations += 1
          return mutateAccounts(transform, path)
        },
        auth: {
          all: async () => ({ anthropic: { type: 'oauth' } }),
          get: async () => undefined,
          set: async () => {
            hostWrites += 1
          },
        },
      }),
    )

    await runtime.boot()

    expect(accountMutations).toBe(0)
    expect(hostWrites).toBe(0)
    runtime.dispose()
  })

  for (const vaultState of ['serves', 'cold', 'needs_reauth'] as const) {
    it(`installs the exact fallback tombstone over a corrupt marker when the vault ${vaultState}`, async () => {
      const corrupt = corruptAccount()
      const storage: AccountStorage = {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [corrupt],
        claustrum: claustrumConfig({ mode: 'claustrum' }),
      }
      await writeCorruptStorageWithManifest(
        storage,
        enrollmentManifest(corrupt.id),
      )
      const { transport } = makeTransport(() => ({
        material: makeJwt('acct-1'),
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      }))
      const runtime = __createCustodyRuntimeForTest(
        makeOptions({
          storage,
          transport,
          detection: 'available',
          resolveFallbackVaultState: async () => vaultState,
        }),
      )

      expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
        id: 'fb-1',
        corrupt: true,
      })

      await runtime.boot()

      expect((await loadAccounts(configPath))?.accounts).toEqual([
        {
          id: 'fb-1',
          type: 'oauth',
          access: '',
          refresh: TOMBSTONE_OPENAI,
          expires: 0,
          enabled: false,
          accountId: 'acct-1',
          addedAt: 123,
        },
      ])
      runtime.dispose()
    })
  }

  for (const vaultState of ['no_handle', 'identity_mismatch'] as const) {
    it(`does not install a corrupt fallback marker for ${vaultState}`, async () => {
      const corrupt = corruptAccount()
      const storage: AccountStorage = {
        version: 1,
        accounts: [corrupt],
        claustrum: claustrumConfig({ mode: 'claustrum' }),
      }
      await writeCorruptStorageWithManifest(
        storage,
        enrollmentManifest(corrupt.id),
      )
      const { transport } = makeTransport(() => ({
        material: makeJwt('acct-1'),
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      }))
      const runtime = __createCustodyRuntimeForTest(
        makeOptions({
          storage,
          transport,
          detection: 'available',
          resolveFallbackVaultState: async () => vaultState,
        }),
      )

      await runtime.boot()

      expect((await loadAccounts(configPath))?.accounts).toEqual([corrupt])
      runtime.dispose()
    })
  }

  it('does not install a corrupt fallback marker without a manifest binding', async () => {
    const corrupt = corruptAccount()
    const storage: AccountStorage = {
      version: 1,
      accounts: [corrupt],
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    }
    await writeCorruptStorageWithManifest(storage, emptyManifest())
    const { transport, captured } = makeTransport(() => {
      throw new Error('vault must not be consulted')
    })
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({ storage, transport, detection: 'available' }),
    )

    await runtime.boot()

    expect((await loadAccounts(configPath))?.accounts).toEqual([corrupt])
    expect(captured.getCalls).toEqual([])
    runtime.dispose()
  })

  it('does not install when the manifest handle changes before the account lock', async () => {
    const corrupt = corruptAccount()
    const storage: AccountStorage = {
      version: 1,
      accounts: [corrupt],
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    }
    await writeCorruptStorageWithManifest(
      storage,
      enrollmentManifest(corrupt.id),
    )
    const { transport } = makeTransport(() => ({
      material: makeJwt('acct-1'),
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    let writes = 0
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        resolveFallbackVaultState: async () => 'serves',
        acquireRefreshFileLock: async () => {
          const manifest = enrollmentManifest(corrupt.id)
          if (!manifest.ok) throw new Error('expected manifest')
          manifest.value.providers[0]!.accounts[0]!.handle =
            `ckh_${'z'.repeat(43)}`
          writeFileSync(manifestPath, JSON.stringify(manifest.value))
          return { release: async () => {} }
        },
        mutateAccounts: async (transform, path) => {
          writes += 1
          return mutateAccounts(transform, path)
        },
      }),
    )

    await runtime.boot()

    expect(writes).toBe(0)
    expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
      corrupt: true,
    })
    runtime.dispose()
  })

  it('does not install when mode changes before the account lock', async () => {
    const corrupt = corruptAccount()
    const storage: AccountStorage = {
      version: 1,
      accounts: [corrupt],
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    }
    await writeCorruptStorageWithManifest(
      storage,
      enrollmentManifest(corrupt.id),
    )
    const { transport } = makeTransport(() => ({
      material: makeJwt('acct-1'),
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    let writes = 0
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        resolveFallbackVaultState: async () => 'serves',
        acquireRefreshFileLock: async () => {
          writeFileSync(
            configPath,
            JSON.stringify({
              ...storage,
              claustrum: claustrumConfig({ mode: 'local' }),
            }),
          )
          return { release: async () => {} }
        },
        mutateAccounts: async (transform, path) => {
          writes += 1
          return mutateAccounts(transform, path)
        },
      }),
    )

    await runtime.boot()

    expect(writes).toBe(0)
    expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
      corrupt: true,
    })
    runtime.dispose()
  })

  it('preserves fallback roster order and enabled metadata during install', async () => {
    const first = liveAccount('fb-first')
    const corrupt = corruptAccount('fb-corrupt', { enabled: true })
    const last = liveAccount('fb-last')
    const storage: AccountStorage = {
      version: 1,
      accounts: [first, corrupt, last],
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    }
    await writeCorruptStorageWithManifest(
      storage,
      enrollmentManifest(corrupt.id),
    )
    const { transport } = makeTransport(() => ({
      material: makeJwt('acct-1'),
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    }))
    const runtime = __createCustodyRuntimeForTest(
      makeOptions({
        storage,
        transport,
        detection: 'available',
        resolveFallbackVaultState: async () => 'serves',
      }),
    )

    await runtime.boot()

    const after = await loadAccounts(configPath)
    expect(after?.accounts.map((account) => account.id)).toEqual([
      'fb-first',
      'fb-corrupt',
      'fb-last',
    ])
    expect(after?.accounts[1]?.enabled).toBe(true)
    runtime.dispose()
  })

  it('re-reads the corrupt marker under the refresh lock so two processes install once', async () => {
    const corrupt = corruptAccount()
    const storage: AccountStorage = {
      version: 1,
      accounts: [corrupt],
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    }
    await writeCorruptStorageWithManifest(
      storage,
      enrollmentManifest(corrupt.id),
    )
    let installs = 0
    const countingMutate: typeof mutateAccounts = async (transform, path) =>
      mutateAccounts((current) => {
        const before = current.accounts.find(
          (account) => account.id === corrupt.id,
        )
        const next = transform(current)
        if (before?.type === 'oauth' && before.corrupt) installs += 1
        return next
      }, path)
    const firstWithCount = __createCustodyRuntimeForTest({
      ...makeOptions({
        storage,
        transport: makeTransport(() => ({
          material: makeJwt('acct-1'),
          recordVersion: 1,
          expiresAtMs: Date.now() + 600_000,
        })).transport,
        detection: 'available',
        resolveFallbackVaultState: async () => 'serves',
        acquireRefreshFileLock,
      }),
      mutateAccounts: countingMutate,
    })
    const secondWithCount = __createCustodyRuntimeForTest({
      ...makeOptions({
        storage,
        transport: makeTransport(() => ({
          material: makeJwt('acct-1'),
          recordVersion: 1,
          expiresAtMs: Date.now() + 600_000,
        })).transport,
        detection: 'available',
        resolveFallbackVaultState: async () => 'serves',
        acquireRefreshFileLock,
      }),
      mutateAccounts: countingMutate,
    })

    await Promise.all([firstWithCount.boot(), secondWithCount.boot()])

    expect(installs).toBe(1)
    firstWithCount.dispose()
    secondWithCount.dispose()
  })

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
            if (changed?.type === 'oauth' && !changed.corrupt)
              writes.push(changed)
          }
          return mutateAccounts(transform, path)
        },
      }),
    )
    await runtime.boot()
    expect(writes).toEqual([
      expect.objectContaining({
        access: '',
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
    expect(tombstonedAccount.access).toBe('')
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
        access: '',
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
// Sweep failure log
// ---------------------------------------------------------------------------

describe('sweep failure log dedupe', () => {
  it('logs once per account+reason within an hour; emits again past the hour', async () => {
    const account = await writeBoundRealFixture()
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
    const account = await writeBoundRealFixture()
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
