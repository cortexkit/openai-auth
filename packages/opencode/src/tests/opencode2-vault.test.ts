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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  OpenCode2AuthError,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import {
  OpenAiVault,
  VAULT_MODE_REFUSALS,
  type VaultModeRefusal,
  vaultModeRefusalText,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import {
  chatgptAccessToken,
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { resetSettingsForTest } from '../config'
import { PoolAccountSource } from '../core/pool-account-source'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { resetDumpStateForTest } from '../dump'
import { flushForTest } from '../logger'
import { opencode1HostSlot } from '../v2/host-slot'
import { VAULT_METHOD } from '../v2/login'
import { setupOpenAIAuth } from '../v2/setup'
import { guardLocalStoreReads } from './fixtures/local-store-read-guard'
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
import { restoreEnv } from './setup-env'

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
    /** Leave the first quota poll pending so the request path must await it. */
    waitForQuota?: boolean
    /** Runs the pool lifecycle (migration, then adoptions of slot logins). */
    poolMigration?: boolean
    reverseVaultRoster?: boolean
    /** The grants the vault reports for this host; undefined is an older vault. */
    grants?: MockDaemon['grants']
  } = {},
) {
  const files = poolFiles()
  seedPool(files, mode, rows)
  options.prepare?.(files)
  const daemon: MockDaemon = await startMockDaemon({
    directory: files.dir,
    credentials,
    grants: options.grants,
  })
  // An approved enrollment, as Connect leaves it.
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
  const stop = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
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
  // OpenAiVault publishes quota to disk before reloading its live roster.
  // Wait for that roster to contain the reading instead of sleeping a fixed time.
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
    if (options.waitForQuota !== false)
      await waitFor(() => {
        const rows = observer.vault.snapshot()?.rows ?? []
        return routable.every((id) =>
          rows.some((row) => row.credentialId === id && row.quota),
        )
      }, 'the live vault accounts and their quota')
    if (options.reverseVaultRoster) {
      // Vault discovery sorts credentials by name; reverse the live roster
      // so main-first must move the default account rather than inherit first place.
      const routes = observer.vault.routes.bind(observer.vault)
      const ordered = spyOn(observer.vault, 'routes').mockImplementation(() =>
        routes().reverse(),
      )
      cleanups.push(() => ordered.mockRestore())
      expect(observer.vault.routes().map((row) => row.credentialId)).toEqual([
        'chatgpt:openai:work',
        'chatgpt:openai',
      ])
    }
  } finally {
    observer.release()
  }
  return { host, daemon, files, tokenPath }
}

type Host = Awaited<ReturnType<typeof start>>['host']

it('vault activation is registered and returns only the host placeholder without a pool write', async () => {
  const { host, files } = await start('main-first', [], {})
  const before = [files.paths().configPath, files.paths().statePath].map(
    (path) => readFileSync(path),
  )
  const method = host.methods.find((entry) => entry.method.id === VAULT_METHOD)
  if (!method) throw new Error('missing vault activation method')
  const flow = await method.authorize({})
  expect(flow.url).toBe('')
  expect(flow.mode).toBe('auto')
  if (typeof flow.callback === 'function')
    throw new Error('vault callback must be automatic')
  const credential = await flow.callback
  expect(credential as unknown).toEqual({
    type: 'oauth',
    methodID: 'openai-auth-vault',
    access: 'common-auth-placeholder.openai',
    refresh: 'common-auth-placeholder.openai',
    expires: expect.any(Number),
    metadata: { commonAuthPlaceholder: true },
  })
  expect(
    [files.paths().configPath, files.paths().statePath].map((path) =>
      readFileSync(path),
    ),
  ).toEqual(before)
})

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
  expect((error as OpenCode2AuthError).message).toBe(
    vaultModeRefusalText(cause, 'openai-auth-opencode'),
  )
  // Nothing was given a credential to go out with.
  expect(draft.request.headers.get('authorization')).toBe(
    `Bearer ${PLACEHOLDER}`,
  )
}

/**
 * The receipts the vault authorized from here on, in order: the record
 * version each was served at and whether it was the token kept from an
 * earlier read because the vault could not be reached.
 */
function authorizedReceipts() {
  const spy = spyOn(OpenAiVault.prototype, 'authorize')
  cleanups.push(() => spy.mockRestore())
  const receipts = async () => {
    const receipts: Array<{ recordVersion: number; kept: boolean }> = []
    for (const result of spy.mock.results) {
      const receipt = (await result.value) as ClaustrumScopedAttempt | undefined
      if (receipt)
        receipts.push({
          recordVersion: receipt.recordVersion,
          kept: receipt.fromKeptReceipt === true,
        })
    }
    return receipts
  }
  /**
   * Waits until every vault that authorized a send reports kept receipts as
   * inactive. That happens when the vault answers the `list_scoped` call a
   * send served from a kept receipt starts in the background.
   */
  const answered = () =>
    waitFor(
      () =>
        spy.mock.contexts.every(
          (vault) => !(vault as OpenAiVault).keptReceiptState().active,
        ),
      'the vault to answer again',
    )
  return Object.assign(receipts, { answered })
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
  it('dumps the internal vault route key without vault credentials or personal identifiers', async () => {
    const keys = [
      'CORTEXKIT_OPENAI_AUTH_DUMP',
      'OPENCODE_OPENAI_AUTH_DUMP_DIR',
      'OPENCODE_OPENAI_AUTH_FILE',
      'OPENCODE_OPENAI_AUTH_LOG_FILE',
    ]
    const previous = keys.map((key) => process.env[key])
    cleanups.push(() => {
      for (const [index, key] of keys.entries()) {
        restoreEnv(key, previous[index])
      }
      resetSettingsForTest()
      resetDumpStateForTest()
    })
    const { host, daemon, files } = await start(
      'main-first',
      [{ id: 'main' }],
      {
        'oauth:openai:vault': vaultLogin('chatgpt-vault', {
          wire: { email: 'private-vault@example.test' },
        }),
      },
      {
        prepare: (files) => {
          process.env.CORTEXKIT_OPENAI_AUTH_DUMP = '1'
          process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR = join(files.dir, 'dumps')
          process.env.OPENCODE_OPENAI_AUTH_FILE = files.configPath
          process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(
            files.dir,
            'dump.log',
          )
          resetSettingsForTest()
          resetDumpStateForTest()
        },
      },
    )
    const lease = acquireOpenCodeVault(
      {
        host: 'opencode',
        stateDir: join(files.dir, 'vault'),
        connectionFile: () => daemon.connectionFile,
        pollIntervalMs: 0,
      },
      files.paths(),
    )
    const key = lease.vault.routes()[0]!.id
    lease.release()
    await send(host, 200)
    const dir = join(files.dir, 'dumps')
    const names = readdirSync(dir)
    const metas = names.filter((name) => name.endsWith('.meta.json'))
    expect(metas).toHaveLength(1)
    expect(
      JSON.parse(readFileSync(join(dir, metas[0]!), 'utf8')).accountId,
    ).toBe(key)
    await flushForTest()
    const text =
      names.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n') +
      readFileSync(join(files.dir, 'dump.log'), 'utf8')
    for (const secret of [
      VAULT_ACCESS,
      ENROLLMENT_TOKEN,
      'chatgpt-vault',
      'private-vault@example.test',
    ])
      expect(text).not.toContain(secret)
  })

  it('main-first places the default vault account first and fallback-first places it last', async () => {
    for (const mode of ['main-first', 'fallback-first'] as const) {
      const credentials = {
        'chatgpt:openai': vaultLogin('chatgpt-default'),
        'chatgpt:openai:work': vaultLogin('chatgpt-work'),
      }
      const { host } = await start(mode, [{ id: 'main' }], credentials, {
        reverseVaultRoster: mode === 'main-first',
      })
      const headers = await send(host, 200)
      expect(headers.get('authorization')).toBe(
        `Bearer ${chatgptAccessToken(mode === 'main-first' ? 'chatgpt-default' : 'chatgpt-work')}`,
      )
      expect(headers.get('chatgpt-account-id')).toBe(
        mode === 'main-first' ? 'chatgpt-default' : 'chatgpt-work',
      )
    }
  })

  it('alias-only vault placements keep Ordered order and never serve the local main', async () => {
    for (const mode of ['ordered', 'main-first', 'fallback-first'] as const) {
      const { host } = await start(mode, [{ id: 'main' }], {
        'chatgpt:openai:work': vaultLogin('chatgpt-work'),
        'chatgpt:openai:home': vaultLogin('chatgpt-home'),
      })
      expect((await send(host, 200)).get('authorization')).toBe(
        `Bearer ${chatgptAccessToken('chatgpt-home')}`,
      )
    }
  })

  it('the original request joins a pending first vault quota poll and serves without a retry', async () => {
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let polls = 0
    const { host } = await start(
      'fallback-first',
      [{ id: 'main' }],
      {
        'oauth:openai:vault': vaultLogin('chatgpt-vault', {
          record_version: 7,
        }),
      },
      {
        waitForQuota: false,
        fetch: (async (...args: Parameters<typeof fetch>) => {
          polls++
          started.resolve()
          await gate.promise
          return usageOnly(...args)
        }) as typeof fetch,
      },
    )
    try {
      await started.promise
      let finished = false
      const serving = send(host, 200).then(
        (headers) => {
          finished = true
          return { headers }
        },
        (error: unknown) => {
          finished = true
          return { error }
        },
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finished).toBe(false)
      gate.resolve()
      const result = await serving
      expect('headers' in result).toBe(true)
      if ('headers' in result) {
        expect(result.headers.get('chatgpt-account-id')).toBe('chatgpt-vault')
      }
      expect(polls).toBe(1)
    } finally {
      gate.resolve()
    }
  })

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

  // The vault stops answering after it has served this process a token. The
  // shared vault code keeps the last token it served each account, in memory
  // only, and serves it while the vault cannot be reached; `outage` makes the
  // mock daemon answer every vault call with a transport error.
  it('during a vault outage a send carries the kept receipt at its record version, the first send after the vault answers again is authorized fresh, and no pool row is asked for a token', async () => {
    const { host, daemon } = await start('fallback-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault', { record_version: 7 }),
    })
    const receipts = authorizedReceipts()
    const tokens = spyOn(PoolAccountSource.prototype, 'usableToken')
    cleanups.push(() => tokens.mockRestore())
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )

    daemon.outage = 'connection_dropped'
    const during = await send(host, 200)
    expect(daemon.outageCalls).toContain('credential.get_scoped')
    expect(during.get('authorization')).toBe(`Bearer ${VAULT_ACCESS}`)
    expect(during.get('chatgpt-account-id')).toBe('chatgpt-vault')
    expect((await receipts()).at(-1)).toEqual({ recordVersion: 7, kept: true })

    const rotated = chatgptAccessToken('chatgpt-vault', 'rotated')
    daemon.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-vault', {
      record_version: 8,
      payload: JSON.stringify({ access_token: rotated }),
    })
    daemon.outage = undefined
    // The outage ends when the vault answers again, not on the next send:
    // that send is still served the kept receipt at once and starts a
    // background list, and once the list is answered sends are fresh.
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    expect((await receipts()).at(-1)).toEqual({ recordVersion: 7, kept: true })
    await receipts.answered()
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${rotated}`,
    )
    expect((await receipts()).at(-1)).toEqual({ recordVersion: 8, kept: false })
    expect(tokens).not.toHaveBeenCalled()
  })

  it('a 401 on a kept receipt is not reported, and the account then refuses for the rest of the outage', async () => {
    const { host, daemon } = await start('fallback-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault', { record_version: 7 }),
    })
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    daemon.outage = 'connection_dropped'
    expect((await send(host, 401)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    await expectVaultRefusal(host, 'vault-refused')
    expect(daemon.outageCalls).not.toContain('credential.report_auth_failure')
    daemon.outage = undefined
    expect(daemon.reports).toEqual([])
  })

  it('a 401 reported while the vault answers is not served again during a later outage', async () => {
    const { host, daemon } = await start('fallback-first', [{ id: 'main' }], {
      'oauth:openai:vault': vaultLogin('chatgpt-vault', { record_version: 7 }),
    })
    const receipts = authorizedReceipts()
    // First, with nothing yet discarding the kept token, an outage is served with it.
    daemon.outage = 'connection_dropped'
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    daemon.outage = undefined
    // The outage lasts until the vault answers a call again. This send is
    // served from the kept receipt (the token the vault last served) and
    // starts a background `list_scoped` call; the vault's answer to that
    // call ends the outage.
    await send(host, 200)
    await receipts.answered()

    await send(host, 401)
    await waitFor(() => daemon.reports.length > 0, 'the 401 report')
    expect(daemon.reports).toEqual([
      expect.objectContaining({ provider_status: 401, record_version: 7 }),
    ])
    daemon.outage = 'connection_dropped'
    await expectVaultRefusal(host, 'vault-refused')
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

  it('an empty vault with no grant for this host refuses with the exact grant command', async () => {
    const { host } = await start(
      'main-first',
      [{ id: 'main' }],
      {},
      { grants: [] },
    )
    await expectVaultRefusal(host, 'vault-no-grant')
    expect(
      vaultModeRefusalText('vault-no-grant', 'openai-auth-opencode'),
    ).toEndWith(
      'grant it access with: ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read',
    )
  })

  it('an empty vault whose grant reaches no login refuses with reclassify and status', async () => {
    const { host } = await start(
      'main-first',
      [{ id: 'main' }],
      {},
      {
        grants: [
          {
            selector_kind: 'category',
            selector: 'openai-native',
            operation: 'read',
          },
        ],
      },
    )
    await expectVaultRefusal(host, 'vault-grant-unreached')
    expect(VAULT_MODE_REFUSALS['vault-grant-unreached']).toContain(
      'ck auth reclassify --from-registry',
    )
  })

  it('routes the pool rows again once this host disconnects', async () => {
    let reads: ReturnType<typeof guardLocalStoreReads> | undefined
    const { host, tokenPath } = await start(
      'main-first',
      [{ id: 'main' }],
      {
        'oauth:openai:vault': vaultLogin('chatgpt-vault'),
      },
      {
        prepare: (files) => {
          reads = guardLocalStoreReads(files.configPath, files.statePath)
          cleanups.push(() => reads?.restore())
        },
      },
    )
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    expect(reads?.counts()).toEqual({ stateReads: 0, rowReads: 0 })
    // Disconnect deletes the enrollment token.
    reads?.allowLocal()
    rmSync(tokenPath)
    expect((await send(host, 200)).get('authorization')).toBe(
      'Bearer main-token',
    )
    expect(reads?.counts().stateReads).toBeGreaterThan(0)
  })

  it('a corrupt local state does not affect vault startup or requests', async () => {
    const { host, files } = await start(
      'main-first',
      [{ id: 'main' }],
      {
        'oauth:openai:vault': vaultLogin('chatgpt-vault'),
      },
      {
        prepare: (files) => writeFileSync(files.statePath, '{broken'),
      },
    )
    expect((await send(host, 200)).get('authorization')).toBe(
      `Bearer ${VAULT_ACCESS}`,
    )
    expect(readFileSync(files.statePath, 'utf8')).toBe('{broken')
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
      sidebarStateFile: join(files.dir, 'sidebar.json'),
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

  // In vault mode the migration does not run (it writes the local files). An
  // install that has not migrated is still served from the vault, which
  // needs no pool row; a login through the plugin cannot be stored in the
  // pool, so it is refused at once, saying why, and nothing on disk changes.
  it('in vault mode a never-migrated install is served from the vault, a login on it is refused with the reason, and nothing is migrated, stored or adopted', async () => {
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
    const daemon = await startMockDaemon({
      directory: files.dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    cleanups.push(() => daemon.stop())
    const stateDir = join(files.dir, 'vault')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const { tokenPath, rosterPath } = vaultPaths(stateDir, 'opencode')
    writeFileSync(
      tokenPath,
      JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
      { mode: 0o600 },
    )
    chmodSync(tokenPath, 0o600)
    const config = readFileSync(files.configPath, 'utf8')
    const auth = readFileSync(authPath, 'utf8')
    const host = fakeOpenCode2Host()
    const stop = await setupOpenAIAuth(host.ctx, {
      paths: files.paths,
      sidebarStateFile: join(files.dir, 'sidebar.json'),
      slot: opencode1HostSlot(authPath),
      fence: async () => ({ open: true as const }),
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
        connectionFile: () => daemon.connectionFile,
        pollIntervalMs: 0,
      },
    })
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    cleanups.push(async () => {
      await stop?.()
    })

    // The vault account gets its first quota reading in the background.
    await waitFor(() => {
      try {
        const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as {
          rows: Array<{ quota?: unknown }>
        }
        return roster.rows.some((row) => row.quota)
      } catch {
        return false
      }
    }, 'the vault account and its quota')
    await Bun.sleep(100)
    const served = await send(host, 200)
    expect(served.get('authorization')).toBe(`Bearer ${VAULT_ACCESS}`)

    const method = host.methods.find(
      (entry) =>
        entry.integrationID === 'openai' &&
        entry.method.id === 'openai-auth-pool-browser',
    )
    if (!method)
      throw new Error('no openai-auth-pool-browser method registered')
    await expect(method.authorize({})).rejects.toThrow(
      'connected to the credential vault',
    )
    await Bun.sleep(100)

    expect(readFileSync(files.configPath, 'utf8')).toBe(config)
    expect(readFileSync(authPath, 'utf8')).toBe(auth)
  })

  it('in vault mode leaves a slot login where it is, unused and not adopted, the local files byte-identical, and routes the vault only', async () => {
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
    const authPath = join(files.dir, 'auth.json')
    const before = [files.configPath, files.statePath, authPath].map((path) =>
      readFileSync(path, 'utf8'),
    )
    // Long enough for an adoption to have run, had vault mode allowed one.
    await Bun.sleep(300)
    const gets = daemon.gets.length
    const served = await send(host, 200)
    expect(served.get('authorization')).toBe(`Bearer ${VAULT_ACCESS}`)
    expect(served.get('authorization')).not.toBe(`Bearer ${login.access}`)
    expect(daemon.gets.length).toBeGreaterThan(gets)
    await Bun.sleep(100)
    expect(
      [files.configPath, files.statePath, authPath].map((path) =>
        readFileSync(path, 'utf8'),
      ),
    ).toEqual(before)
    expect(JSON.parse(readFileSync(authPath, 'utf8')).openai).toEqual(login)
  })
})
