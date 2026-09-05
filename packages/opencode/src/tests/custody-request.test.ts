import { beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FallbackAccountManager,
  loadAccounts,
  type OAuthAccount,
} from '../core/accounts.ts'
import type { CacheKeepManager } from '../core/cachekeep.ts'
import {
  ClaustrumCredentialCache,
  CUSTODY_REFUSE,
  resolveFallbackAccess,
  stampVaultProvenance,
  type VaultProvenance,
} from '../core/custody.ts'
import { CUSTODY_INERT_REASONS } from '../core/custody-state.ts'
import {
  __resetBootQuotaSeedForTest,
  type ClaustrumCacheTransportLike,
  CodexAuthPlugin,
  type CustodyRuntime,
  createResetTargetResolver,
} from '../index.ts'
import { hashSidebarSessionId } from '../sidebar-state.ts'
import {
  claustrumConfig,
  emptyManifest,
  enrollmentManifest,
  liveAccount,
  liveStorage,
  makeSentinelAccount,
  TOMBSTONE_OPENAI,
} from './custody-fixtures.ts'
import {
  FLOOR_AUTH_FILE,
  FLOOR_CLAUSTRUM_HANDLES,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

function jwtFor(accountId: string, tag?: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      chatgpt_account_id: accountId,
      ...(tag ? { tag } : {}),
    }),
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
    credentialForGet?: () => { material: string; recordVersion: number }
    now?: () => number
    sidebar?: Record<string, unknown>
    observeRequest?: (
      authorization: string,
      url: string,
      configPath: string,
    ) => Promise<void> | void
    withFallbackAccountLock?: <T>(
      accountId: string,
      action: () => Promise<T>,
    ) => Promise<T>
    respond: (authorization: string, url: string) => number
  },
  run: (input: {
    fetchOverride: typeof globalThis.fetch
    authorizations: string[]
    reports: Array<{ recordVersion: number; reporterSource: string }>
    gets: () => number
    runtime: CustodyRuntime
    cacheKeepManager: {
      track: CacheKeepManager['track']
      tick: CacheKeepManager['tick']
    }
    configPath: string
    commandHook: (input: {
      command: string
      arguments: string
      sessionID: string
    }) => Promise<void>
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
  let runtime: CustodyRuntime | undefined
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
      claustrum: claustrumConfig({
        mode: options.claustrumEnabled === false ? 'local' : 'claustrum',
      }),
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
    await options.observeRequest?.(authorization, urlText, configPath)
    if (urlText.endsWith('/responses')) authorizations.push(authorization)
    return new Response('{}', {
      status: options.respond(authorization, urlText),
    })
  }) as typeof globalThis.fetch
  const transport: ClaustrumCacheTransportLike = {
    async getCredential() {
      gets++
      const credential = options.credentialForGet?.() ?? options.credential
      if (!credential) throw new Error('vault unavailable')
      return {
        ...credential,
        expiresAtMs: (options.now ?? Date.now)() + 60_000,
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
      client: {
        auth: { set: async () => {} },
        session: { promptAsync: async () => {} },
      },
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
        now: options.now,
        onRuntime: (value) => {
          runtime = value
        },
        withFallbackAccountLock: options.withFallbackAccountLock,
      },
    },
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
    const cacheKeepManager = (
      globalThis as typeof globalThis & {
        __openaiAuthCacheKeepManager?: CacheKeepManager
      }
    ).__openaiAuthCacheKeepManager
    if (!cacheKeepManager) throw new Error('expected cachekeep manager')
    if (!runtime) throw new Error('expected custody runtime')
    const commandHook = (
      hooks as unknown as {
        'command.execute.before'?: (input: {
          command: string
          arguments: string
          sessionID: string
        }) => Promise<void>
      }
    )['command.execute.before']
    if (!commandHook) throw new Error('expected command hook')
    await run({
      fetchOverride,
      authorizations,
      reports,
      gets: () => gets,
      runtime,
      cacheKeepManager,
      configPath,
      commandHook,
    })
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

  it('refuses enabling a bound row when the served custody identity differs', async () => {
    const account = liveAccount('binding-mismatch', {
      enabled: false,
      accountId: 'row-account',
    })
    await withCustodyLoader(
      {
        accounts: [account],
        credential: {
          material: jwtFor('served-account'),
          recordVersion: 1,
        },
        respond: () => 200,
      },
      async ({ commandHook, configPath }) => {
        await commandHook({
          command: 'openai-account',
          arguments: `enable ${account.id}`,
          sessionID: 'binding-mismatch',
        }).catch(() => {})

        expect(CUSTODY_INERT_REASONS).toContain('identity-mismatch')
        expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
          accountId: 'row-account',
          enabled: false,
        })
      },
    )
  })

  it('binds a pending row under the account lock before enabling it', async () => {
    const account = liveAccount('binding-pending', { enabled: false })
    let lockHeld = false
    let boundWhileLocked = false
    await withCustodyLoader(
      {
        accounts: [account],
        credential: {
          material: jwtFor('served-account'),
          recordVersion: 1,
        },
        respond: () => 200,
        withFallbackAccountLock: async (_id, action) => {
          lockHeld = true
          try {
            const result = await action()
            boundWhileLocked =
              (await loadAccounts(process.env.OPENCODE_OPENAI_AUTH_FILE))
                ?.accounts[0]?.accountId === 'served-account'
            return result
          } finally {
            lockHeld = false
          }
        },
      },
      async ({ commandHook, configPath }) => {
        await commandHook({
          command: 'openai-account',
          arguments: `enable ${account.id}`,
          sessionID: 'binding-pending',
        }).catch(() => {})

        expect(lockHeld).toBe(false)
        expect(boundWhileLocked).toBe(true)
        expect((await loadAccounts(configPath))?.accounts[0]).toMatchObject({
          accountId: 'served-account',
          enabled: true,
        })
      },
    )
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
        claustrum: claustrumConfig({ mode: 'claustrum' }),
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

  it('persists the tombstone before sending an enrollment credential', async () => {
    const fallback = enrollingAccount()
    const vaultAccess = jwtFor('acct-1')
    let observed: OAuthAccount | undefined
    await withCustodyLoader(
      {
        accounts: [fallback],
        credential: { material: vaultAccess, recordVersion: 18 },
        observeRequest: async (authorization, url, configPath) => {
          if (!url.endsWith('/responses')) return
          if (authorization !== `Bearer ${vaultAccess}`) return
          const storage = await loadAccounts(configPath)
          const account = storage?.accounts.find(
            (candidate) => candidate.id === fallback.id,
          )
          if (account?.type === 'oauth' && !account.corrupt) observed = account
        },
        respond: (authorization, url) =>
          url.endsWith('/responses') && authorization === 'Bearer main-access'
            ? 401
            : 200,
      },
      async ({ fetchOverride }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(200)
      },
    )
    expect(observed).toMatchObject({
      access: makeSentinelAccount().access,
      refresh: makeSentinelAccount().refresh,
      expires: 0,
    })
  })

  it('binds an absent account id from the first served credential', async () => {
    const fallback = makeSentinelAccount({
      id: 'custody-1',
      accountId: undefined,
    })
    await withCustodyLoader(
      {
        accounts: [fallback],
        credential: { material: jwtFor('acct-bound'), recordVersion: 19 },
        respond: () => 200,
      },
      async ({ fetchOverride, configPath }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(200)
        const bound = (await loadAccounts(configPath))?.accounts.find(
          (account) => account.id === fallback.id,
        )
        expect(bound).toMatchObject({ accountId: 'acct-bound' })
      },
    )
  })

  it('reconciles an expired bound row to the vault before fallback routing', async () => {
    const expired = enrollingAccount()
    const next = enrollingAccount({
      id: 'next',
      access: 'next-access',
      refresh: 'next-refresh',
      expires: Date.now() + 100_000,
    })
    await withCustodyLoader(
      {
        accounts: [expired, next],
        routing: { mode: 'fallback-first' },
        credential: { material: jwtFor('acct-1'), recordVersion: 18 },
        respond: (authorization) =>
          authorization === 'Bearer main-access' ? 401 : 200,
      },
      async ({ fetchOverride, authorizations, configPath }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(authorizations).toContain(`Bearer ${jwtFor('acct-1')}`)
        const storage = await loadAccounts(configPath)
        const preserved = storage?.accounts.find(
          (account) => account.id === expired.id,
        )
        expect(preserved?.type).toBe('oauth')
        if (preserved?.type !== 'oauth')
          throw new Error('expected oauth account')
        expect(preserved).toMatchObject({
          access: '',
          refresh: 'claustrum-tombstone:v1:openai',
          expires: 0,
        })
      },
    )
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
        claustrum: claustrumConfig({ mode: 'claustrum' }),
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
        expect(authorizations.join(' ')).not.toContain(TOMBSTONE_OPENAI)
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
        expect(authorizations.join(' ')).not.toContain(TOMBSTONE_OPENAI)
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
        respond: (_authorization, url) =>
          url.endsWith('/responses') ? 401 : 200,
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

  it('keeps a due manifest account out of local refresh during cachekeep replay', async () => {
    const fallback = enrollingAccount({
      id: 'cachekeep-local',
      expires: Date.now() - 1_000,
    })
    const originalRefresh = FallbackAccountManager.prototype.refreshAccount
    let refreshes = 0
    FallbackAccountManager.prototype.refreshAccount = async function (...args) {
      refreshes++
      return originalRefresh.apply(this, args)
    }
    try {
      await withCustodyLoader(
        {
          accounts: [fallback],
          claustrumEnabled: false,
          respond: () => 200,
        },
        async ({ cacheKeepManager }) => {
          cacheKeepManager.track(
            'cachekeep-local',
            JSON.stringify({ model: 'gpt-5.5', input: [] }),
            fallback.id,
          )
          const target = (
            cacheKeepManager as never as {
              targets: Map<string, { cacheExpiresAt: number }>
            }
          ).targets.get('cachekeep-local')
          if (!target) throw new Error('expected cachekeep target')
          target.cacheExpiresAt = Date.now()
          await cacheKeepManager.tick()
          expect(refreshes).toBe(0)
        },
      )
    } finally {
      FallbackAccountManager.prototype.refreshAccount = originalRefresh
    }
  })

  it('uses the vault bearer during a cachekeep replay', async () => {
    const fallback = makeSentinelAccount({
      id: 'cachekeep-vault',
      accountId: 'acct-cachekeep-vault',
    })
    const vaultAccess = jwtFor('acct-cachekeep-vault')
    await withCustodyLoader(
      {
        accounts: [fallback],
        credential: { material: vaultAccess, recordVersion: 53 },
        respond: () => 200,
      },
      async ({ cacheKeepManager, authorizations }) => {
        cacheKeepManager.track(
          'cachekeep-vault',
          JSON.stringify({ model: 'gpt-5.5', input: [] }),
          fallback.id,
        )
        const target = (
          cacheKeepManager as never as {
            targets: Map<string, { cacheExpiresAt: number }>
          }
        ).targets.get('cachekeep-vault')
        if (!target) throw new Error('expected cachekeep target')
        target.cacheExpiresAt = Date.now()
        await cacheKeepManager.tick()
        expect(authorizations).toContain(`Bearer ${vaultAccess}`)
      },
    )
  })

  it('reports the served vault version after a cachekeep replay 401', async () => {
    const fallback = makeSentinelAccount({
      id: 'cachekeep-vault-401',
      accountId: 'acct-cachekeep-vault-401',
    })
    const vaultAccess = jwtFor('acct-cachekeep-vault-401')
    await withCustodyLoader(
      {
        accounts: [fallback],
        credential: { material: vaultAccess, recordVersion: 54 },
        respond: (_authorization, url) =>
          url.endsWith('/responses') ? 401 : 200,
      },
      async ({ cacheKeepManager, reports }) => {
        cacheKeepManager.track(
          'cachekeep-vault-401',
          JSON.stringify({ model: 'gpt-5.5', input: [] }),
          fallback.id,
        )
        const target = (
          cacheKeepManager as never as {
            targets: Map<string, { cacheExpiresAt: number }>
          }
        ).targets.get('cachekeep-vault-401')
        if (!target) throw new Error('expected cachekeep target')
        target.cacheExpiresAt = Date.now()
        await cacheKeepManager.tick()
        expect(reports).toEqual([
          { recordVersion: 54, reporterSource: 'direct' },
        ])
      },
    )
  })

  it('does not report a local cachekeep replay 401', async () => {
    const fallback = liveAccount('cachekeep-local-401', {
      accountId: 'acct-cachekeep-local-401',
      expires: Date.now() + 24 * 60 * 60_000,
    })
    await withCustodyLoader(
      {
        accounts: [fallback],
        claustrumEnabled: false,
        respond: (_authorization, url) =>
          url.endsWith('/responses') ? 401 : 200,
      },
      async ({ cacheKeepManager, reports }) => {
        cacheKeepManager.track(
          'cachekeep-local-401',
          JSON.stringify({ model: 'gpt-5.5', input: [] }),
          fallback.id,
        )
        const target = (
          cacheKeepManager as never as {
            targets: Map<string, { cacheExpiresAt: number }>
          }
        ).targets.get('cachekeep-local-401')
        if (!target) throw new Error('expected cachekeep target')
        target.cacheExpiresAt = Date.now()
        await cacheKeepManager.tick()
        expect(reports).toEqual([])
      },
    )
  })

  it('reports a vault 401 from the sticky replacement send', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'custody-sticky-replacement-'))
    const configPath = join(directory, 'openai-auth.json')
    const manifestPath = join(directory, 'handles.json')
    const sidebarPath = join(directory, 'sidebar.json')
    const sessionId = 'sticky-replacement-session'
    const checkedAt = Date.now() + 5 * 60_000
    const local = liveAccount('sticky-local', {
      accountId: 'acct-sticky-local',
      enabled: true,
    })
    const vault = makeSentinelAccount({
      id: 'sticky-vault',
      accountId: 'acct-sticky-vault',
      enabled: true,
    })
    const manifest = enrollmentManifest(vault.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const vaultAccess = jwtFor('acct-sticky-vault')
    const authorizations: string[] = []
    const reports: Array<{ recordVersion: number; reporterSource: string }> = []
    const originalFetch = globalThis.fetch
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(directory, 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = sidebarPath
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
    process.env.OPENCODE_CONFIG_DIR = directory
    process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [local, vault],
        claustrum: claustrumConfig({ mode: 'claustrum' }),
        routing: { mode: 'sticky-balanced' },
      }),
    )
    writeFileSync(manifestPath, JSON.stringify(manifest.value))
    chmodSync(manifestPath, 0o600)
    writeFileSync(
      sidebarPath,
      JSON.stringify({
        main: {
          quota: {
            primary: { remainingPercent: 20, checkedAt },
          },
          mainAccountId: 'acc-main',
        },
        fallbacks: [
          {
            id: local.id,
            accountId: local.accountId,
            enabled: true,
            quota: { primary: { remainingPercent: 90, checkedAt } },
          },
          {
            id: vault.id,
            accountId: vault.accountId,
            enabled: true,
            quota: { primary: { remainingPercent: 100, checkedAt } },
          },
        ],
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: local.id,
            assignedAt: Date.now(),
            lastSeenAt: Date.now(),
            inputBytes: 1,
          },
        },
      }),
    )
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.includes('wham')) {
        return new Response('{}', { status: 500 })
      }
      if (urlText.endsWith('/responses')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
      }
      return new Response('{}', { status: 401 })
    }) as typeof globalThis.fetch
    const transport: ClaustrumCacheTransportLike = {
      async getCredential() {
        return {
          material: vaultAccess,
          recordVersion: 71,
          expiresAtMs: Date.now() + 60_000,
        }
      },
      async statusCredential() {
        return {
          ready: true,
          lastErrorCode: null,
          leaseHeld: false,
          recordVersion: 71,
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
      const fetchOverride = (result as { fetch?: typeof globalThis.fetch })
        .fetch
      if (!fetchOverride) throw new Error('expected fetch override')
      const response = await fetchOverride(
        'https://chatgpt.com/backend-api/codex/responses',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'session-id': sessionId,
          },
          body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
        },
      )
      expect(response.status).toBe(401)
      expect(authorizations).toEqual([
        `Bearer ${local.access}`,
        `Bearer ${vaultAccess}`,
      ])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reports).toEqual([{ recordVersion: 71, reporterSource: 'direct' }])
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

  it('refuses a reported vault credential until a tick refills the request cache', async () => {
    const fallback = makeSentinelAccount({
      id: 'invalidate-request-cache',
      accountId: 'acct-invalidate-request-cache',
    })
    const vault17 = jwtFor('acct-invalidate-request-cache')
    const vault18 = jwtFor('acct-invalidate-request-cache', 'v18')
    let credential = { material: vault17, recordVersion: 17 }
    await withCustodyLoader(
      {
        accounts: [fallback],
        routing: { mode: 'fallback-first' },
        credentialForGet: () => credential,
        respond: (authorization, url) =>
          url.endsWith('/responses') && authorization !== 'Bearer main-access'
            ? 401
            : 200,
      },
      async ({ fetchOverride, authorizations, reports, runtime }) => {
        const [url, init] = codexRequest()
        expect((await fetchOverride(url, init)).status).toBe(200)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toEqual([
          { recordVersion: 17, reporterSource: 'direct' },
        ])

        const afterRejected = authorizations.length
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(authorizations.slice(afterRejected)).toEqual([
          'Bearer main-access',
        ])

        credential = { material: vault18, recordVersion: 18 }
        await runtime.runTick()
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(authorizations).toContain(`Bearer ${vault18}`)
      },
    )
  })

  it('bounds repeated vault 401 reports until a later vault success resets the handle', async () => {
    const fallback = makeSentinelAccount({
      id: 'bound-request-cache',
      accountId: 'acct-bound-request-cache',
    })
    const manifest = enrollmentManifest(fallback.id)
    if (!manifest.ok) throw new Error('expected manifest fixture')
    const handle = manifest.value.providers[0]!.accounts[0]!.handle
    let clock = Date.now()
    let version = 17
    let vaultSucceeds = false
    await withCustodyLoader(
      {
        accounts: [fallback],
        routing: { mode: 'fallback-first' },
        now: () => clock,
        credentialForGet: () => ({
          material: jwtFor('acct-bound-request-cache', String(version)),
          recordVersion: version,
        }),
        respond: (authorization, url) => {
          if (!url.endsWith('/responses')) return 200
          if (authorization === 'Bearer main-access') return 200
          return vaultSucceeds ? 200 : 401
        },
      },
      async ({ fetchOverride, reports, gets, runtime, authorizations }) => {
        const [url, init] = codexRequest()
        await fetchOverride(url, init)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toEqual([
          { recordVersion: 17, reporterSource: 'direct' },
        ])

        version = 18
        await runtime.runTick()
        await fetchOverride(url, init)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toEqual([
          { recordVersion: 17, reporterSource: 'direct' },
          { recordVersion: 18, reporterSource: 'direct' },
        ])

        const getsBeforeReauthTick = gets()
        version = 19
        await runtime.runTick()
        expect(gets()).toBe(getsBeforeReauthTick)
        const reauthRequestStart = authorizations.length
        await fetchOverride(url, init)
        expect(authorizations.slice(reauthRequestStart)).toEqual([
          'Bearer main-access',
        ])
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toHaveLength(2)

        clock += 60 * 60_000 + 1
        version = 20
        await runtime.runTick()
        expect(runtime.getCache()?.isReauth(handle, clock)).toBe(false)
        expect(runtime.getCache()?.isBlocked(handle)).toBe(false)
        expect((await runtime.getCache()?.peek(handle))?.recordVersion).toBe(20)
        await fetchOverride(url, init)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toEqual([
          { recordVersion: 17, reporterSource: 'direct' },
          { recordVersion: 18, reporterSource: 'direct' },
          { recordVersion: 20, reporterSource: 'direct' },
        ])

        version = 21
        await runtime.runTick()
        vaultSucceeds = true
        expect((await fetchOverride(url, init)).status).toBe(200)
        expect(authorizations.at(-1)).toBe(
          `Bearer ${jwtFor('acct-bound-request-cache', '21')}`,
        )

        vaultSucceeds = false
        await fetchOverride(url, init)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reports).toEqual([
          { recordVersion: 17, reporterSource: 'direct' },
          { recordVersion: 18, reporterSource: 'direct' },
          { recordVersion: 20, reporterSource: 'direct' },
          { recordVersion: 21, reporterSource: 'direct' },
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

  it('refuses a bound real row under claustrum before it can serve local access', async () => {
    const account = enrollingAccount({ expires: 100_000 })
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
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
    const result = await resolveFallbackAccess(account, storage, manifest, {
      cache,
      manifestHandle: handle,
      refreshBeforeExpiryMs: 60_000,
      now: () => 1_000,
    })

    expect(result).toBe(CUSTODY_REFUSE)
    expect(vaultGets).toBe(0)
    cache.close()
  })

  it('serves a local account after its manifest entry is removed', async () => {
    const account = enrollingAccount({ expires: 1_000 })
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    const result = await resolveFallbackAccess(
      account,
      storage,
      emptyManifest(),
      {
        now: () => 1_000,
      },
    )

    expect(result).toEqual({ token: 'local-access', provenance: 'local' })
  })

  it('completes a due enrollment before serving vault access', async () => {
    const account = enrollingAccount()
    let storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
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
    let storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
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
    const intact = storage.accounts[0]
    expect(intact?.type).toBe('oauth')
    if (intact?.type !== 'oauth') throw new Error('expected oauth account')
    expect(intact.access).toBe('local-access')
    expect(intact.refresh).toBe('local-refresh')
    cache.close()
  })

  it('refuses a due enrollment when completion cannot fetch vault material', async () => {
    const account = enrollingAccount()
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
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
    cache.close()
  })

  it('skips reset refresh when a fallback is refresh-inert', async () => {
    const account = liveAccount('custody-1', { expires: 0 })
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'local' }),
    })
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
