import { beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthAccount } from '../core/accounts.ts'
import {
  ClaustrumCredentialCache,
  CUSTODY_REFUSE,
  clearEnrollPending,
  enrollPendingReason,
  markEnrollPending,
  resolveFallbackAccess,
  stampVaultProvenance,
  type VaultProvenance,
} from '../core/custody.ts'
import {
  __resetBootQuotaSeedForTest,
  type ClaustrumCacheTransportLike,
  CodexAuthPlugin,
  createResetTargetResolver,
} from '../index.ts'
import {
  enrollmentManifest,
  liveAccount,
  liveStorage,
  makeSentinelAccount,
} from './custody-fixtures.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_CLAUSTRUM_HANDLES,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

function jwtFor(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ chatgpt_account_id: accountId }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

function enrollingAccount(overrides: Partial<OAuthAccount> = {}): OAuthAccount {
  return {
    id: 'custody-1',
    type: 'oauth',
    access: 'local-access',
    refresh: 'local-refresh',
    expires: 1_000,
    addedAt: 1,
    accountId: 'acct-1',
    ...overrides,
  }
}

async function withCustodyLoader(
  options: {
    accounts: OAuthAccount[]
    routing?: { mode: 'main-first' | 'fallback-first' | 'sticky-balanced' }
    claustrumEnabled?: boolean
    credential?: { material: string; recordVersion: number } | undefined
    sidebar?: Record<string, unknown>
    respond: (authorization: string, url: string) => number
  },
  run: (input: {
    fetchOverride: typeof globalThis.fetch
    authorizations: string[]
    reports: Array<{ recordVersion: number; reporterSource: string }>
    gets: () => number
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'custody-request-loader-'))
  const configPath = join(directory, 'openai-auth.json')
  const manifestPath = join(directory, 'handles.json')
  const manifest = enrollmentManifest(options.accounts[0]?.id ?? 'custody-1')
  if (!manifest.ok) throw new Error('expected manifest fixture')
  const originalFetch = globalThis.fetch
  const authorizations: string[] = []
  const reports: Array<{ recordVersion: number; reporterSource: string }> = []
  let gets = 0
  process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(directory, 'state.json')
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    directory,
    'sidebar.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
  process.env.OPENCODE_CONFIG_DIR = directory
  process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: options.accounts,
      claustrum: { enabled: options.claustrumEnabled ?? true },
      routing: options.routing,
    }),
  )
  writeFileSync(manifestPath, JSON.stringify(manifest.value))
  if (options.sidebar) {
    writeFileSync(
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE,
      JSON.stringify(options.sidebar),
    )
  }
  chmodSync(manifestPath, 0o600)
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    const urlText = String(url)
    if (urlText.endsWith('/responses')) authorizations.push(authorization)
    return new Response('{}', {
      status: options.respond(authorization, urlText),
    })
  }) as typeof globalThis.fetch
  const transport: ClaustrumCacheTransportLike = {
    async getCredential() {
      gets++
      if (!options.credential) throw new Error('vault unavailable')
      return {
        ...options.credential,
        expiresAtMs: Date.now() + 60_000,
      }
    },
    async statusCredential() {
      return {
        ready: Boolean(options.credential),
        lastErrorCode: options.credential ? null : 'unavailable',
        leaseHeld: false,
        recordVersion: options.credential?.recordVersion ?? 0,
      }
    },
    async reportAuthFailure(params) {
      reports.push({
        recordVersion: params.recordVersion,
        reporterSource: params.reporterSource,
      })
    },
    close() {},
  }
  const hooks = await CodexAuthPlugin(
    {
      client: { auth: { set: async () => {} } },
      project: { id: 'test', name: 'test' },
      directory: '',
      worktree: directory,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:0'),
      $: {},
    } as never,
    { custody: { transport, detection: 'available' } },
  )
  try {
    const loader = hooks.auth?.loader
    if (!loader) throw new Error('expected auth loader')
    const result = await loader(
      async () => ({
        type: 'oauth' as const,
        access: 'main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 3_600_000,
      }),
      {} as never,
    )
    const fetchOverride = (result as { fetch?: typeof globalThis.fetch }).fetch
    if (!fetchOverride) throw new Error('expected fetch override')
    await run({ fetchOverride, authorizations, reports, gets: () => gets })
  } finally {
    await hooks.dispose?.()
    globalThis.fetch = originalFetch
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      FLOOR_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
    process.env.CLAUSTRUM_OPENCODE_HANDLES = FLOOR_CLAUSTRUM_HANDLES
    delete process.env.OPENCODE_CONFIG_DIR
    rmSync(directory, { recursive: true, force: true })
  }
}

function codexRequest(sessionId?: string): [string, RequestInit] {
  return [
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sessionId ? { 'x-session-affinity': sessionId } : {}),
      },
      body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
    },
  ]
}

describe('custody request resolution', () => {
  beforeEach(() => {
    __resetBootQuotaSeedForTest()
  })

  it('uses the configured custody transport in the loader', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'custody-loader-'))
    const configPath = join(directory, 'openai-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(directory, 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
      directory,
      'sidebar.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
    process.env.OPENCODE_CONFIG_DIR = directory
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        claustrum: { enabled: true },
      }),
    )
    let closes = 0
    const transport: ClaustrumCacheTransportLike = {
      async getCredential() {
        throw new Error('no credential requested')
      },
      async statusCredential() {
        return {
          ready: false,
          lastErrorCode: null,
          leaseHeld: false,
          recordVersion: 0,
        }
      },
      async reportAuthFailure() {},
      close() {
        closes++
      },
    }
    const hooks = await CodexAuthPlugin(
      {
        client: { auth: { set: async () => {} } },
        project: { id: 'test', name: 'test' },
        directory: '',
        worktree: directory,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {},
      } as never,
      {
        custody: {
          transport,
          detection: 'available',
        },
      },
    )
    try {
      const loader = hooks.auth?.loader
      if (!loader) throw new Error('expected auth loader')
      await loader(
        async () => ({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3_600_000,
        }),
        {} as never,
      )
      await hooks.dispose?.()
      expect(closes).toBeGreaterThan(0)
    } finally {
      await hooks.dispose?.()
      process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        FLOOR_SIDEBAR_STATE_FILE
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
      delete process.env.OPENCODE_CONFIG_DIR
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('sends the vault bearer and fences repeated fallback-first 401 reports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'custody-fallback-first-'))
    const configPath = join(directory, 'openai-auth.json')
    const manifestPath = join(directory, 'handles.json')
    const fallback = makeSentinelAccount({
      id: 'fallback-1',
      accountId: 'acct-1',
    })
    const manifest = enrollmentManifest(fallback.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const vaultAccess = jwtFor('acct-1')
    const authorizations: string[] = []
    const reports: Array<{
      handle: string
      providerStatus: number
      recordVersion: number
      reporterSource: 'direct' | 'relay_status_field' | 'relay_message_parse'
    }> = []
    let vaultGets = 0
    const originalFetch = globalThis.fetch
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(directory, 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
      directory,
      'sidebar.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
    process.env.OPENCODE_CONFIG_DIR = directory
    process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [fallback],
        claustrum: { enabled: true },
        routing: { mode: 'fallback-first' },
      }),
    )
    writeFileSync(manifestPath, JSON.stringify(manifest.value))
    chmodSync(manifestPath, 0o600)
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.endsWith('/responses')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
      }
      return new Response('{}', {
        status: urlText.includes('wham') ? 200 : 401,
      })
    }) as typeof globalThis.fetch
    const transport: ClaustrumCacheTransportLike = {
      async getCredential() {
        vaultGets++
        return {
          material: vaultAccess,
          recordVersion: 17,
          expiresAtMs: Date.now() + 60_000,
        }
      },
      async statusCredential() {
        return {
          ready: true,
          lastErrorCode: null,
          leaseHeld: false,
          recordVersion: 17,
        }
      },
      async reportAuthFailure(params) {
        reports.push(params)
      },
      close() {},
    }
    const hooks = await CodexAuthPlugin(
      {
        client: { auth: { set: async () => {} } },
        project: { id: 'test', name: 'test' },
        directory: '',
        worktree: directory,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {},
      } as never,
      { custody: { transport, detection: 'available' } },
    )
    try {
      const loader = hooks.auth?.loader
      if (!loader) throw new Error('expected auth loader')
      const result = await loader(
        async () => ({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3_600_000,
        }),
        {} as never,
      )
      const fetchOverride = (result as { fetch?: typeof globalThis.fetch })
        .fetch
      if (!fetchOverride) throw new Error('expected fetch override')
      expect(vaultGets).toBeGreaterThan(0)
      const response = await fetchOverride(
        'https://chatgpt.com/backend-api/codex/responses',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
        },
      )
      expect(response.status).toBe(401)
      expect(authorizations.filter(Boolean)[0]).toBe(`Bearer ${vaultAccess}`)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reports).toEqual([
        {
          handle: manifest.value.providers[0]!.accounts[0]!.handle,
          providerStatus: 401,
          recordVersion: 17,
          reporterSource: 'direct',
        },
      ])
      await fetchOverride('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reports).toHaveLength(1)
    } finally {
      await hooks.dispose?.()
      globalThis.fetch = originalFetch
      process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        FLOOR_SIDEBAR_STATE_FILE
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
      process.env.CLAUSTRUM_OPENCODE_HANDLES = FLOOR_CLAUSTRUM_HANDLES
      delete process.env.OPENCODE_CONFIG_DIR
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('continues past a refused custodied fallback to a healthy local fallback', async () => {
    const refused = makeSentinelAccount({
      id: 'refused',
      accountId: 'acct-refused',
    })
    const local = liveAccount('local', { accountId: 'acct-local' })
    await withCustodyLoader(
      {
        accounts: [refused, local],
        routing: { mode: 'fallback-first' },
        credential: undefined,
        respond: () => 200,
      },
      async ({ fetchOverride, authorizations, gets }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(gets()).toBeGreaterThan(0)
        expect(authorizations.filter(Boolean)).toEqual([
          `Bearer ${local.access}`,
        ])
        expect(authorizations.join(' ')).not.toContain(refused.access)
      },
    )
  })

  it('omits a disabled custody tombstone from fallback sends', async () => {
    const tombstone = makeSentinelAccount({
      id: 'disabled',
      accountId: 'acct-disabled',
    })
    await withCustodyLoader(
      {
        accounts: [tombstone],
        routing: { mode: 'fallback-first' },
        claustrumEnabled: false,
        credential: { material: jwtFor('acct-disabled'), recordVersion: 11 },
        respond: () => 200,
      },
      async ({ fetchOverride, authorizations }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(authorizations).toEqual(['Bearer main-access'])
        expect(authorizations.join(' ')).not.toContain(tombstone.access)
      },
    )
  })

  it('reports the served vault version after a reactive fallback 401', async () => {
    const fallback = makeSentinelAccount({
      id: 'reactive',
      accountId: 'acct-reactive',
    })
    const vaultAccess = jwtFor('acct-reactive')
    await withCustodyLoader(
      {
        accounts: [fallback],
        credential: { material: vaultAccess, recordVersion: 23 },
        respond: () => 401,
      },
      async ({ fetchOverride, authorizations, reports }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(401)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(authorizations).toEqual([
          'Bearer main-access',
          `Bearer ${vaultAccess}`,
        ])
        expect(reports).toEqual([
          { recordVersion: 23, reporterSource: 'direct' },
        ])
      },
    )
  })

  it('uses the vault bearer for a sticky fallback send', async () => {
    const fallback = makeSentinelAccount({
      id: 'sticky',
      accountId: 'acct-sticky',
    })
    const vaultAccess = jwtFor('acct-sticky')
    const checkedAt = Date.now()
    await withCustodyLoader(
      {
        accounts: [fallback],
        routing: { mode: 'sticky-balanced' },
        credential: { material: vaultAccess, recordVersion: 41 },
        sidebar: {
          main: { quota: { primary: { remainingPercent: 1, checkedAt } } },
          fallbacks: [
            {
              id: fallback.id,
              accountId: fallback.accountId,
              enabled: true,
              quota: { primary: { remainingPercent: 100, checkedAt } },
            },
          ],
        },
        respond: () => 200,
      },
      async ({ fetchOverride, authorizations }) => {
        const [url, init] = codexRequest('sticky-custody-session')
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(authorizations).toEqual([`Bearer ${vaultAccess}`])
      },
    )
  })

  it('reports the served vault version after a sticky fallback 401', async () => {
    const fallback = makeSentinelAccount({
      id: 'sticky-401',
      accountId: 'acct-sticky-401',
    })
    const vaultAccess = jwtFor('acct-sticky-401')
    const checkedAt = Date.now()
    await withCustodyLoader(
      {
        accounts: [fallback],
        routing: { mode: 'sticky-balanced' },
        credential: { material: vaultAccess, recordVersion: 43 },
        sidebar: {
          main: { quota: { primary: { remainingPercent: 1, checkedAt } } },
          fallbacks: [
            {
              id: fallback.id,
              accountId: fallback.accountId,
              enabled: true,
              quota: { primary: { remainingPercent: 100, checkedAt } },
            },
          ],
        },
        respond: () => 401,
      },
      async ({ fetchOverride, reports }) => {
        const [url, init] = codexRequest('sticky-custody-401')
        expect((await fetchOverride(url, init)).status).toBe(401)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toEqual([
          { recordVersion: 43, reporterSource: 'direct' },
        ])
      },
    )
  })

  describe('vault failure filtering', () => {
    it('does not report a local 401', async () => {
      await withCustodyLoader(
        { accounts: [], respond: () => 401 },
        async ({ fetchOverride, reports }) => {
          const [url, init] = codexRequest()
          expect((await fetchOverride(url, init)).status).toBe(401)
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(reports).toEqual([])
        },
      )
    })

    it('does not report a vault 403', async () => {
      const fallback = makeSentinelAccount({
        id: 'forbidden',
        accountId: 'acct-forbidden',
      })
      const vaultAccess = jwtFor('acct-forbidden')
      await withCustodyLoader(
        {
          accounts: [fallback],
          routing: { mode: 'fallback-first' },
          credential: { material: vaultAccess, recordVersion: 29 },
          respond: () => 403,
        },
        async ({ fetchOverride, reports }) => {
          const [url, init] = codexRequest()
          expect((await fetchOverride(url, init)).status).toBe(403)
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(reports).toEqual([])
        },
      )
    })

    it('does not report a vault 429', async () => {
      const fallback = makeSentinelAccount({
        id: 'limited',
        accountId: 'acct-limited',
      })
      const vaultAccess = jwtFor('acct-limited')
      await withCustodyLoader(
        {
          accounts: [fallback],
          routing: { mode: 'fallback-first' },
          credential: { material: vaultAccess, recordVersion: 31 },
          respond: () => 429,
        },
        async ({ fetchOverride, reports }) => {
          const [url, init] = codexRequest()
          expect((await fetchOverride(url, init)).status).toBe(429)
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(reports).toEqual([])
        },
      )
    })

    it('does not report a vault 401 outside the Codex endpoint', async () => {
      const fallback = makeSentinelAccount({
        id: 'outside',
        accountId: 'acct-outside',
      })
      const vaultAccess = jwtFor('acct-outside')
      await withCustodyLoader(
        {
          accounts: [fallback],
          credential: { material: vaultAccess, recordVersion: 37 },
          respond: (_authorization, url) => (url.includes('wham') ? 200 : 401),
        },
        async ({ fetchOverride, reports }) => {
          const init: RequestInit = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
          }
          expect(
            (await fetchOverride('https://example.test/responses', init))
              .status,
          ).toBe(401)
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(reports).toEqual([])
        },
      )
    })
  })

  it('serves a valid local enrollment without refreshing it', async () => {
    const account = enrollingAccount({ expires: 100_000 })
    const storage = liveStorage([account], { claustrum: { enabled: true } })
    const manifest = enrollmentManifest(account.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const handle = manifest.value.providers[0]?.accounts[0]?.handle
    if (!handle) throw new Error('expected fixture handle')
    let vaultGets = 0
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        ({
          async getCredential() {
            vaultGets++
            throw new Error('local token should serve')
          },
          async statusCredential() {
            return {
              ready: false,
              lastErrorCode: null,
              leaseHeld: false,
              recordVersion: 0,
            }
          },
          async reportAuthFailure() {},
          close() {},
        }) as never,
    })
    markEnrollPending(account.id, 'unavailable')

    const result = await resolveFallbackAccess(account, storage, manifest, {
      cache,
      manifestHandle: handle,
      refreshBeforeExpiryMs: 60_000,
      now: () => 1_000,
    })

    expect(result).toEqual({ token: 'local-access', provenance: 'local' })
    expect(vaultGets).toBe(0)
    clearEnrollPending(account.id)
    cache.close()
  })

  it('completes a due enrollment before serving vault access', async () => {
    const account = enrollingAccount()
    let storage = liveStorage([account], { claustrum: { enabled: true } })
    const manifest = enrollmentManifest(account.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const handle = manifest.value.providers[0]?.accounts[0]?.handle
    if (!handle) throw new Error('expected fixture handle')
    const vaultAccess = jwtFor('acct-1')
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        ({
          async getCredential() {
            return {
              material: vaultAccess,
              recordVersion: 7,
              expiresAtMs: 10_000,
            }
          },
          async statusCredential() {
            return {
              ready: true,
              lastErrorCode: null,
              leaseHeld: false,
              recordVersion: 7,
            }
          },
          async reportAuthFailure() {},
          close() {},
        }) as never,
    })

    const result = await resolveFallbackAccess(account, storage, manifest, {
      cache,
      manifestHandle: handle,
      refreshBeforeExpiryMs: 60_000,
      now: () => 1_000,
      completeEnrollmentDeps: {
        loadAccounts: async () => storage,
        readCustodyManifest: async () => manifest,
        acquireRefreshFileLock: async () =>
          ({ release: async () => {} }) as never,
        configPath: 'memory',
        cache,
        minTtlMs: 30_000,
        mutateAccounts: async (mutate) => {
          storage = mutate(storage) ?? storage
        },
      },
    })

    expect(result).toEqual({
      token: vaultAccess,
      provenance: { handle, recordVersion: 7 },
    })
    const completed = storage.accounts[0]
    expect(completed?.type).toBe('oauth')
    if (completed?.type !== 'oauth') throw new Error('expected oauth account')
    expect(completed.access).not.toBe('local-access')
    cache.close()
  })

  it('refuses a due enrollment when the served claim differs from its local identity', async () => {
    const account = enrollingAccount()
    let storage = liveStorage([account], { claustrum: { enabled: true } })
    const manifest = enrollmentManifest(account.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const handle = manifest.value.providers[0]?.accounts[0]?.handle
    if (!handle) throw new Error('expected fixture handle')
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        ({
          async getCredential() {
            return {
              material: jwtFor('wrong-account'),
              recordVersion: 8,
              expiresAtMs: 10_000,
            }
          },
          async statusCredential() {
            return {
              ready: true,
              lastErrorCode: null,
              leaseHeld: false,
              recordVersion: 8,
            }
          },
          async reportAuthFailure() {},
          close() {},
        }) as never,
    })

    const result = await resolveFallbackAccess(account, storage, manifest, {
      cache,
      manifestHandle: handle,
      refreshBeforeExpiryMs: 60_000,
      now: () => 1_000,
      completeEnrollmentDeps: {
        loadAccounts: async () => storage,
        readCustodyManifest: async () => manifest,
        acquireRefreshFileLock: async () =>
          ({ release: async () => {} }) as never,
        configPath: 'memory',
        cache,
        minTtlMs: 30_000,
        mutateAccounts: async (mutate) => {
          storage = mutate(storage) ?? storage
        },
      },
    })

    expect(result).toBe(CUSTODY_REFUSE)
    expect(enrollPendingReason(account.id)).toBe('identityMismatch')
    const intact = storage.accounts[0]
    expect(intact?.type).toBe('oauth')
    if (intact?.type !== 'oauth') throw new Error('expected oauth account')
    expect(intact.access).toBe('local-access')
    expect(intact.refresh).toBe('local-refresh')
    clearEnrollPending(account.id)
    cache.close()
  })

  it('refuses a due enrollment when completion cannot fetch vault material', async () => {
    const account = enrollingAccount()
    const storage = liveStorage([account], { claustrum: { enabled: true } })
    const manifest = enrollmentManifest(account.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const handle = manifest.value.providers[0]?.accounts[0]?.handle
    if (!handle) throw new Error('expected fixture handle')
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        ({
          async getCredential() {
            throw new Error('vault unavailable')
          },
          async statusCredential() {
            return {
              ready: false,
              lastErrorCode: 'unavailable',
              leaseHeld: false,
              recordVersion: 0,
            }
          },
          async reportAuthFailure() {},
          close() {},
        }) as never,
    })

    const result = await resolveFallbackAccess(account, storage, manifest, {
      cache,
      manifestHandle: handle,
      refreshBeforeExpiryMs: 60_000,
      now: () => 1_000,
      completeEnrollmentDeps: {
        loadAccounts: async () => storage,
        readCustodyManifest: async () => manifest,
        acquireRefreshFileLock: async () =>
          ({ release: async () => {} }) as never,
        configPath: 'memory',
        cache,
        minTtlMs: 30_000,
        mutateAccounts: async () => {},
      },
    })

    expect(result).toBe(CUSTODY_REFUSE)
    expect(enrollPendingReason(account.id)).toBe('unavailable')
    clearEnrollPending(account.id)
    cache.close()
  })

  it('skips reset refresh when a fallback is refresh-inert', async () => {
    const account = liveAccount('custody-1', { expires: 0 })
    const storage = liveStorage([account], { claustrum: { enabled: false } })
    let refreshes = 0
    const resolve = createResetTargetResolver({
      getAuth: async () => ({ type: 'oauth' }),
      refreshMainWithLease: async () => ({
        access: 'main-access',
        refresh: 'main-refresh',
        expires: 100_000,
      }),
      refreshFallbackAccount: async () => {
        refreshes++
        return account
      },
      loadAccounts: async () => storage,
      accountStoragePath: 'memory',
      now: () => 1_000,
      isFallbackRefreshInert: async () => true,
      resolveFallbackAccess: async () => ({
        token: 'vault-access',
        provenance: { handle: 'ckh_test', recordVersion: 7 },
      }),
    })

    await expect(resolve(account.id)).resolves.toMatchObject({
      accessToken: 'vault-access',
    })
    expect(refreshes).toBe(0)
  })

  it('records only vault provenance for a response', () => {
    const response = new Response(null, { status: 401 })
    const provenance = new WeakMap<Response, VaultProvenance>()

    stampVaultProvenance(response, 'local', provenance)
    expect(provenance.get(response)).toBeUndefined()

    stampVaultProvenance(
      response,
      { handle: 'ckh_test', recordVersion: 17 },
      provenance,
    )
    expect(provenance.get(response)).toEqual({
      handle: 'ckh_test',
      recordVersion: 17,
    })
  })
})
