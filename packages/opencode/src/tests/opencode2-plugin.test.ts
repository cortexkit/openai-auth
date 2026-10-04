// The OpenCode 2 entry (`./server`) on a fake host: the hooks recipe from
// `@cortexkit/common-auth/opencode2` wired to openai-auth's pool. Each test
// runs the real setup over real pool files and drives the hooks the way
// OpenCode 2 fires them.

import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isPlaceholderCredential,
  OpenCode2AuthError,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { Credential } from '@opencode/plugin'
import { POOL_PLACEHOLDER } from '../core/pool-migration'
import {
  createOpenAIAdapter,
  inspectCodexEvent,
  NO_ACCOUNT_REFUSAL,
  quotaFromCodexHeaders,
} from '../v2/adapter'
import { applyCodexBaseURL } from '../v2/endpoint'
import { opencode1HostSlot } from '../v2/host-slot'
import { applyCodexModelRules } from '../v2/models'
import { SessionPins } from '../v2/pins'
import { type OpenAIAuthV2Options, setupOpenAIAuth } from '../v2/setup'
import {
  type FakeModel,
  fakeOpenCode2Host,
  type PoolFiles,
  type PoolSeedRow,
  poolFiles,
  type RequestKind,
  type RoutingModeSeed,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const offline: typeof fetch = Object.assign(
  async () => {
    throw new Error('offline in tests')
  },
  { preconnect: () => {} },
) as typeof fetch

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Host = ReturnType<typeof fakeOpenCode2Host>

async function start(
  files: PoolFiles,
  options: Partial<OpenAIAuthV2Options> & {
    activeCredential?: Credential.Value
  } = {},
): Promise<{ host: Host; stop: () => Promise<void> }> {
  const { activeCredential, ...rest } = options
  const host = fakeOpenCode2Host(activeCredential ? { activeCredential } : {})
  const cleanup = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
    ...rest,
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await cleanup?.()
  }
  cleanups.push(stop)
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  return { host, stop }
}

async function startPool(
  mode: RoutingModeSeed,
  rows: PoolSeedRow[],
  options: Partial<OpenAIAuthV2Options> = {},
) {
  const files = poolFiles()
  seedPool(files, mode, rows)
  return { files, ...(await start(files, options)) }
}

async function modelRequest(
  host: Host,
  sessionID = 'ses_1',
  kind: RequestKind = 'primary',
) {
  const draft = {
    ...scope(sessionID, kind),
    headers: {
      Authorization: `Bearer ${PLACEHOLDER}`,
      'chatgpt-account-id': 'acct-HOST',
    } as Record<string, string>,
  }
  await host.fire('model.request', draft)
  return draft.headers
}

async function httpRequest(
  host: Host,
  sessionID = 'ses_1',
  kind: RequestKind = 'primary',
) {
  const draft = {
    ...scope(sessionID, kind),
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  return draft.request
}

async function httpResponse(
  host: Host,
  request: Request,
  response: Response,
  sessionID = 'ses_1',
  kind: RequestKind = 'primary',
) {
  const draft = { ...scope(sessionID, kind), request, response }
  await host.fire('http.response', draft)
  return draft.response
}

async function wsHandshake(host: Host, sessionID = 'ses_1') {
  const draft = {
    ...scope(sessionID),
    url: 'ws://codex.test/v1/responses',
    headers: { authorization: `Bearer ${PLACEHOLDER}` } as Record<
      string,
      string
    >,
  }
  await host.fire('experimental.ws.handshake', draft)
  return draft.headers
}

async function wsReceive(host: Host, frame: unknown, sessionID = 'ses_1') {
  await host.fire('experimental.ws.receive', {
    ...scope(sessionID),
    frame: JSON.stringify(frame),
  })
}

async function retry(
  host: Host,
  error: { type: string; message: string; status?: number },
  decision: { retry: boolean; delay?: number } = { retry: false },
  sessionID = 'ses_1',
) {
  const draft = {
    sessionID,
    model: { providerID: 'openai', id: 'gpt-5.5' },
    attempt: 1,
    error,
    decision,
  }
  await host.fire('retry', draft)
  return draft.decision
}

const bearer = (headers: Record<string, string>) =>
  Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1]

describe('OpenCode 2 entry: the chosen row on the wire', () => {
  it('carries the chosen row bearer and chatgpt-account-id on every hook, never the placeholder', async () => {
    const { host } = await startPool('main-first', [
      { id: 'main' },
      { id: 'fb' },
    ])
    const headers = await modelRequest(host)
    expect(bearer(headers)).toBe('Bearer main-token')
    expect(headers['chatgpt-account-id']).toBe('chatgpt-main')

    const request = await httpRequest(host)
    expect(request.headers.get('authorization')).toBe('Bearer main-token')
    expect(request.headers.get('chatgpt-account-id')).toBe('chatgpt-main')

    const handshake = await wsHandshake(host)
    expect(bearer(handshake)).toBe('Bearer main-token')
    expect(handshake['chatgpt-account-id']).toBe('chatgpt-main')
    for (const value of [
      ...Object.values(headers),
      ...request.headers.values(),
      ...Object.values(handshake),
    ])
      expect(value).not.toContain(PLACEHOLDER)
  })

  it('keeps a sticky session on its row and sends its title request there too', async () => {
    const { host, files } = await startPool('sticky-balanced', [
      { id: 'a', usedPercent: 10 },
      { id: 'b', usedPercent: 90 },
    ])
    expect(bearer(await modelRequest(host, 'ses_1'))).toBe('Bearer a-token')
    // Row b now has far more room: a new session goes there, but ses_1 keeps
    // its pin on a while a can serve, and its title follows it.
    seedPool(files, 'sticky-balanced', [
      { id: 'a', usedPercent: 80 },
      { id: 'b', usedPercent: 5 },
    ])
    expect(bearer(await modelRequest(host, 'ses_2'))).toBe('Bearer b-token')
    expect(bearer(await modelRequest(host, 'ses_1'))).toBe('Bearer a-token')
    expect(bearer(await modelRequest(host, 'ses_1', 'title'))).toBe(
      'Bearer a-token',
    )
    expect(bearer(await modelRequest(host, 'ses_2', 'title'))).toBe(
      'Bearer b-token',
    )
  })
})

describe('OpenCode 2 entry: refusals', () => {
  it('moves an HTTP usage-limit refusal before output to the other row', async () => {
    const { host } = await startPool('main-first', [
      { id: 'main' },
      { id: 'fb' },
    ])
    await modelRequest(host)
    const request = await httpRequest(host)
    expect(request.headers.get('authorization')).toBe('Bearer main-token')
    await httpResponse(
      host,
      request,
      Response.json(
        { error: { type: 'usage_limit_reached', resets_in_seconds: 600 } },
        { status: 429 },
      ),
    )
    const decision = await retry(host, {
      type: 'api',
      message: 'usage limit',
      status: 429,
    })
    expect(decision).toEqual({ retry: true, delay: 0 })
    expect(bearer(await modelRequest(host))).toBe('Bearer fb-token')
    // The refused row stays marked: a new session goes to fb as well.
    expect(bearer(await modelRequest(host, 'ses_2'))).toBe('Bearer fb-token')
  })

  it('moves a WebSocket rate-limit refusal before output, and never retries one after output', async () => {
    const { host } = await startPool('sticky-balanced', [
      { id: 'a', usedPercent: 10 },
      { id: 'b', usedPercent: 50 },
    ])
    expect(bearer(await modelRequest(host))).toBe('Bearer a-token')
    await wsHandshake(host)
    await wsReceive(host, { type: 'response.created', response: {} })
    await wsReceive(host, {
      type: 'response.failed',
      response: { failed: { rate_limit_reached_type: 'primary' } },
    })
    expect(
      await retry(host, { type: 'stream', message: 'rate limit' }),
    ).toEqual({ retry: true, delay: 0 })
    expect(bearer(await modelRequest(host))).toBe('Bearer b-token')
    await wsHandshake(host)
    await wsReceive(host, { type: 'response.output_text.delta', delta: 'hi' })
    await wsReceive(host, {
      type: 'response.failed',
      response: { failed: { rate_limit_reached_type: 'primary' } },
    })
    expect(
      await retry(
        host,
        { type: 'stream', message: 'rate limit' },
        {
          retry: true,
        },
      ),
    ).toEqual({ retry: false })
  })
})

describe('OpenCode 2 entry: quota', () => {
  it('records HTTP header and WebSocket frame quota on the row that served', async () => {
    const { host, files, stop } = await startPool('main-first', [
      { id: 'main', usedPercent: 10 },
      { id: 'fb', usedPercent: 10 },
    ])
    await modelRequest(host, 'ses_1')
    const request = await httpRequest(host, 'ses_1')
    await httpResponse(
      host,
      request,
      new Response('', {
        headers: {
          'x-codex-primary-used-percent': '37',
          'x-codex-primary-window-minutes': '300',
        },
      }),
    )
    // A second session goes to fb once main is refused.
    await modelRequest(host, 'ses_2')
    await wsHandshake(host, 'ses_2')
    await wsReceive(
      host,
      { type: 'error', status: 429, error: { type: 'usage_limit_reached' } },
      'ses_2',
    )
    await retry(host, { type: 'x', message: 'x' }, { retry: false }, 'ses_2')
    expect(bearer(await modelRequest(host, 'ses_2'))).toBe('Bearer fb-token')
    await wsHandshake(host, 'ses_2')
    await wsReceive(
      host,
      {
        type: 'codex.rate_limits',
        rate_limits: {
          primary: { used_percent: 64, window_minutes: 300 },
          secondary: null,
        },
      },
      'ses_2',
    )
    await stop()
    const rows = files.readConfig().commonAuthPool.rows
    const used = (id: string) =>
      rows[id]?.quota?.limits?.find((limit) => limit.usedPercent !== undefined)
        ?.usedPercent
    expect(used('main')).toBe(37)
    expect(used('fb')).toBe(64)
  })
})

describe('OpenCode 2 entry: logins', () => {
  const login = (accountId: string, token = `${accountId}-new`) =>
    (async () => ({
      url: 'https://auth.test/authorize',
      instructions: 'sign in',
      completion: Promise.resolve({
        id: accountId,
        type: 'oauth' as const,
        access: `${token}-access`,
        refresh: `${token}-refresh`,
        expires: Date.now() + 3600_000,
        enabled: true,
        addedAt: Date.now(),
        lastUsed: Date.now(),
        accountId,
      }),
    })) as OpenAIAuthV2Options['beginLogin']

  async function signIn(host: Host, methodID = 'chatgpt-browser') {
    const method = host.methods.find(
      (entry) =>
        entry.integrationID === 'openai' && entry.method.id === methodID,
    )
    if (!method) throw new Error(`no ${methodID} method registered`)
    const authorization = await method.authorize({})
    expect(authorization.mode).toBe('auto')
    return (await authorization.callback) as Credential.OAuth
  }

  it('registers both ChatGPT logins on integration openai', async () => {
    const { host } = await startPool('main-first', [{ id: 'main' }])
    expect(
      host.methods.map((entry) => [entry.integrationID, entry.method.id]),
    ).toEqual([
      ['openai', 'chatgpt-browser'],
      ['openai', 'chatgpt-headless'],
    ])
  })

  it('writes a new account into the pool and leaves the host a placeholder', async () => {
    const { host, files } = await startPool('main-first', [{ id: 'main' }], {
      beginLogin: login('chatgpt-new'),
    })
    const credential = await signIn(host, 'chatgpt-headless')
    expect(isPlaceholderCredential(credential, 'openai')).toBe(true)
    expect(credential.access).not.toContain('chatgpt-new')
    const accounts = files.readConfig().accounts
    expect(accounts.map((account) => account.accountId)).toContain(
      'chatgpt-new',
    )
    const id = accounts.find(
      (account) => account.accountId === 'chatgpt-new',
    )?.id
    expect(id).toBeDefined()
    expect(files.readState().accounts[id ?? '']?.refresh).toBe(
      'chatgpt-new-new-refresh',
    )
    // The new row serves at once.
    await modelRequest(host, 'ses_x')
  })

  it("replaces the credential of the row that already holds the login's account, main included", async () => {
    const { host, files } = await startPool(
      'main-first',
      [{ id: 'main' }, { id: 'fb' }],
      { beginLogin: login('chatgpt-main', 'relogin') },
    )
    await signIn(host)
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'main',
      'fb',
    ])
    expect(files.readState().accounts.main?.refresh).toBe('relogin-refresh')
  })

  it('makes the first login of a pool with no main row the main account', async () => {
    const { host, files } = await startPool('main-first', [{ id: 'fb' }], {
      beginLogin: login('chatgpt-first'),
    })
    await signIn(host)
    const main = files
      .readConfig()
      .accounts.find((account) => account.id === 'main')
    expect(main?.accountId).toBe('chatgpt-first')
  })

  it('leaves an account the pool already holds alone when OpenCode 2 still has an older login of it', async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    const { stop } = await start(files, {
      activeCredential: {
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: 'stale-access',
        refresh: 'stale-refresh',
        expires: Date.now() + 3600_000,
        metadata: { accountID: 'chatgpt-main' },
      } as unknown as Credential.Value,
    })
    await stop()
    expect(files.readState().accounts.main?.refresh).toBe('main-refresh')
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'main',
    ])
  })

  it('copies a ChatGPT login OpenCode 2 already held into the pool', async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    const { stop } = await start(files, {
      activeCredential: {
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: 'host-access',
        refresh: 'host-refresh',
        expires: Date.now() + 3600_000,
        metadata: { accountID: 'chatgpt-host' },
      } as unknown as Credential.Value,
    })
    await stop()
    const row = files
      .readConfig()
      .accounts.find((account) => account.accountId === 'chatgpt-host')
    expect(row).toBeDefined()
    expect(files.readState().accounts[row?.id ?? '']?.refresh).toBe(
      'host-refresh',
    )
  })
})

describe('OpenCode 2 entry: the pool migration', () => {
  it("moves OpenCode 1's login slot into row main on the first start and leaves the slot a placeholder", async () => {
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
          access: 'slot-access',
          refresh: 'slot-refresh',
          expires: Date.now() + 3600_000,
        },
      }),
    )
    // The migrated row has no quota reading yet, and unknown quota blocks
    // admission; this answers the first quota poll.
    const usage: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (!String(input).includes('/wham/usage'))
          throw new Error('offline in tests')
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 18_000,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: null,
          },
        })
      },
      { preconnect: () => {} },
    ) as typeof fetch
    const { host } = await start(files, { fetch: usage, poolMigration: true })
    let deadline = Date.now() + 15_000
    while (
      Date.now() < deadline &&
      files.readConfig().openaiAuthPool?.migratedAt === undefined
    )
      await Bun.sleep(50)
    expect(files.readConfig().openaiAuthPool?.migratedAt).toBeNumber()
    expect(files.readState().accounts.main?.refresh).toBe('slot-refresh')
    expect(JSON.parse(readFileSync(authPath, 'utf8')).openai).toEqual(
      POOL_PLACEHOLDER,
    )
    // The migrated row serves; its token goes on the wire, the slot's
    // placeholder never does.
    deadline = Date.now() + 15_000
    const request = await (async () => {
      for (;;) {
        try {
          await modelRequest(host)
          return await httpRequest(host)
        } catch (error) {
          if (Date.now() > deadline) throw error
          await Bun.sleep(50)
        }
      }
    })()
    expect(request.headers.get('authorization')).toBe('Bearer slot-access')
  }, 30_000)
})

describe('OpenCode 2 entry: models', () => {
  it('applies the OpenCode 1 allow and deny lists and context caps', () => {
    const model = (id: string, modelID = id): FakeModel => ({
      id,
      modelID,
      providerID: 'openai',
      enabled: true,
      limit: { context: 1_000_000, output: 100_000 },
    })
    const models = [
      model('gpt-5.5'),
      model('gpt-5.6'),
      model('gpt-5.6-sol'),
      model('gpt-6-astra'),
      model('gpt-6'),
      model('gpt-4.1'),
      model('gpt-5.4-mini'),
    ]
    for (const entry of models) applyCodexModelRules(entry)
    const view = Object.fromEntries(
      models.map((entry) => [
        entry.id,
        entry.enabled ? entry.limit.context : 'off',
      ]),
    )
    expect(view).toEqual({
      'gpt-5.5': 400_000,
      'gpt-5.6': 'off',
      'gpt-5.6-sol': 372_000,
      'gpt-6-astra': 872_000,
      'gpt-6': 'off',
      'gpt-4.1': 'off',
      'gpt-5.4-mini': 1_000_000,
    })
  })

  it('registers the rules as a model transform for provider openai only', async () => {
    const { host } = await startPool('main-first', [{ id: 'main' }])
    const models = host.transformModels([
      {
        id: 'gpt-6',
        providerID: 'openai',
        enabled: true,
        limit: { context: 1, output: 1 },
      },
      {
        id: 'gpt-6',
        providerID: 'other',
        enabled: true,
        limit: { context: 1, output: 1 },
      },
    ])
    expect(models.map((model) => model.enabled)).toEqual([false, true])
  })
})

describe('OpenCode 2 adapter: event rules', () => {
  it("counts output by openai-auth's rule", () => {
    const verdict = (event: unknown) =>
      inspectCodexEvent(JSON.stringify(event), Date.now())
    expect(verdict({ type: 'response.created' })).toBeUndefined()
    expect(verdict({ type: 'response.in_progress' })).toBeUndefined()
    expect(verdict({ type: 'codex.something' })).toBeUndefined()
    expect(verdict({ type: 'error', error: { type: 'other' } })).toBeUndefined()
    expect(verdict({ type: 'response.output_item.added' })).toEqual({
      outputStarted: true,
    })
    expect(verdict('not json')).toBeUndefined()
  })

  it('reads refusals and quota frames', () => {
    const now = Date.now()
    expect(
      inspectCodexEvent(
        JSON.stringify({
          type: 'error',
          status: 429,
          error: { type: 'usage_limit_reached', resets_in_seconds: 30 },
        }),
        now,
      ),
    ).toEqual({
      limit: {
        reason: 'usage_limit_reached',
        status: 429,
        retryAfterMs: expect.any(Number),
      },
    })
    const limited = inspectCodexEvent(
      JSON.stringify({
        type: 'error',
        status: 429,
        error: { type: 'usage_limit_reached', resets_in_seconds: 30 },
      }),
      now,
    )
    expect(limited?.limit?.retryAfterMs).toBeGreaterThan(29_000)
    expect(limited?.limit?.retryAfterMs).toBeLessThanOrEqual(31_000)
    expect(
      inspectCodexEvent(
        JSON.stringify({
          type: 'response.failed',
          response: { error: { code: 'rate_limit_exceeded' } },
        }),
        now,
      ),
    ).toEqual({ limit: { reason: 'rate_limit_exceeded' } })
    const quota = inspectCodexEvent(
      JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: { primary: { used_percent: 12, window_minutes: 300 } },
      }),
      now,
    )
    expect(quota?.quota?.complete).toBe(true)
    const primary = quota?.quota?.snapshot.primary as
      | { usedPercent: number }
      | undefined
    expect(primary?.usedPercent).toBe(12)
    expect(quotaFromCodexHeaders(new Headers({ 'x-other': '1' }))).toBe(
      undefined,
    )
  })

  it('refuses a row without a usable token locally rather than sending it without a credential or with the placeholder', async () => {
    const row = {
      id: 'main',
      type: 'oauth' as const,
      candidate: true,
      enabled: true,
    }
    const openai = createOpenAIAdapter({
      source: {
        peek: () => ({ active: true, rows: [row] }),
        usableToken: () => undefined,
      } as never,
      storage: async () => null,
      pins: new SessionPins(),
    })
    // The installer's no-account refusal: the host stops before sending, so
    // nothing reaches the provider without the row's credential.
    const error = await Promise.resolve(
      openai.adapter.accountHeaders({
        ...scope(),
        providerID: 'openai',
        modelID: 'gpt-5.5',
        accountId: 'main',
      }),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(OpenCode2AuthError)
    expect((error as OpenCode2AuthError).kind).toBe('no-account')
    expect((error as OpenCode2AuthError).message).toBe(NO_ACCOUNT_REFUSAL)
  })
})

describe('Codex destination independent of the host credential', () => {
  it('rewrites the default origin in the pool model.request hook', async () => {
    const { host } = await startPool('main-first', [
      { id: 'main', identity: 'acct-A', usedPercent: 5 },
    ])
    const draft = {
      ...scope('ses_endpoint'),
      baseURL: 'https://api.openai.com/v1',
      headers: {} as Record<string, string>,
    }
    await host.fire('model.request', draft)
    expect(draft.baseURL).toBe('https://chatgpt.com/backend-api/codex')
    expect(draft.headers['session-id']).toBe('ses_endpoint')
    const custom = {
      ...scope('ses_custom'),
      baseURL: 'https://proxy.example/v1',
      headers: { 'session-id': 'host-derived-session' },
    }
    await host.fire('model.request', custom)
    expect(custom.baseURL).toBe('https://proxy.example/v1')
    expect(custom.headers['session-id']).toBe('host-derived-session')
  })

  it('uses the configured Codex base and leaves API-key destinations unchanged', () => {
    const oauth = { baseURL: 'https://api.openai.com/v1' }
    applyCodexBaseURL(oauth, 'oauth', 'https://codex.example/custom/responses')
    expect(oauth.baseURL).toBe('https://codex.example/custom')
    const key = { baseURL: 'https://api.openai.com/v1' }
    applyCodexBaseURL(key, 'api-key', 'https://codex.example/responses')
    expect(key.baseURL).toBe('https://api.openai.com/v1')
    const custom = { baseURL: 'https://api.openai.com.example/v1' }
    expect(
      applyCodexBaseURL(custom, 'oauth', 'https://codex.example/responses'),
    ).toBe(true)
    expect(custom.baseURL).toBe('https://api.openai.com.example/v1')
  })

  it('removes maxTokens from pool context and compaction without a host login', async () => {
    const { host } = await startPool('main-first', [
      { id: 'main', identity: 'acct-A', usedPercent: 5 },
    ])
    for (const hook of ['context', 'compaction']) {
      const draft = {
        ...scope('ses_options'),
        options: { maxTokens: 1024, temperature: 0.5 } as {
          maxTokens?: number
          temperature: number
        },
      }
      await host.fire(hook, draft)
      expect(draft.options).toEqual({ temperature: 0.5 })
    }
  })
})
