// While Pi is connected to the Claustrum vault, only vault credentials may
// authenticate requests. Pi's own login is stashed, and the local account pool
// (additional OAuth logins) is not refreshed, quota-polled, or written. If no
// vault account can authorize a request, it is refused without sending it.
// Disconnect restores Pi's original login and local-account routing.
//
// Pi resolves auth before calling a provider's stream. The real model-runtime
// tests therefore swap the stored login before reloading Pi's auth snapshot.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPiSlot, type PiSlot } from '@cortexkit/common-auth/pi-slot'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  mutateAccounts,
  OpenAiVault,
  type RoutingMode,
  VAULT_MODE_REFUSALS,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  chatgptAccessToken,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { createPiMenu } from '../commands.ts'
import { registerPiProvider } from '../index.ts'
import { PiPoolSource } from '../pool-source.ts'
import { clearPiStickyRouting } from '../routing.ts'
import { FIRST_READING_WAIT_MS, PiOpenAIRuntime } from '../runtime.ts'
import {
  openVaultSlot,
  VAULT_PLACEHOLDER_KEY,
  VAULT_SLOT_CONFLICT,
  VAULT_SLOT_REFUSAL,
} from '../vault-slot.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

isolatePiAgentDir()

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')
/** The token Pi hands over for its own `openai-codex` login. */
const NATIVE_ACCESS = chatgptAccessToken('chatgpt-native')

const MODEL: Model<Api> = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
}

const CONTEXT: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
}

function sseOk(): Response {
  const body = [
    'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","status":"in_progress","content":[]}}',
    'data: {"type":"response.output_text.delta","item_id":"m1","delta":"hi"}',
    'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi"}]}}',
    'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    '',
  ].join('\n\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function whamOk(): Response {
  const resetAt = Math.floor((Date.now() + 7_200_000) / 1000)
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 18_000,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 604_800,
        reset_at: resetAt + 86_400,
      },
    },
  })
}

let dir: string
let paths: AccountPaths
let stateDir: string
let daemon: MockDaemon | undefined
/** Bearer of every Codex request sent. */
let codexTokens: string[]
/** Bearer of every quota poll sent. */
let whamTokens: string[]
/** Every token refresh sent to OpenAI's token endpoint. */
let refreshes: number

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const token =
    new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '') ??
    ''
  if (url === CODEX_URL) {
    codexTokens.push(token)
    return sseOk()
  }
  if (url === WHAM_URL) {
    whamTokens.push(token)
    return whamOk()
  }
  if (url.startsWith(TOKEN_URL)) {
    refreshes++
    return new Response('{}', { status: 400 })
  }
  return new Response('unexpected', { status: 500 })
}) as typeof fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-openai-vault-mode-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
  stateDir = vaultStateDir(paths.statePath)
  codexTokens = []
  whamTokens = []
  refreshes = 0
})

afterEach(async () => {
  clearPiStickyRouting('session-1')
  await daemon?.stop()
  daemon = undefined
  rmSync(dir, { recursive: true, force: true })
})

function vault(
  overrides: Partial<ConstructorParameters<typeof OpenAiVault>[0]> = {},
): OpenAiVault {
  return new OpenAiVault({
    host: 'pi',
    stateDir,
    connectionFile: () => daemon?.connectionFile ?? join(dir, 'none.json'),
    pollIntervalMs: 0,
    fetchImpl: () => fakeFetch,
    ...overrides,
  })
}

function runtimeWith(target: OpenAiVault, slot?: PiSlot): PiOpenAIRuntime {
  return new PiOpenAIRuntime({
    streamSimple,
    createStream: createAssistantMessageEventStream,
    paths: () => paths,
    fetchImpl: fakeFetch,
    // Long enough for the first quota poll of Pi's login once local routing
    // is back, so a local request is not refused for want of a reading.
    firstReadingWaitMs: FIRST_READING_WAIT_MS,
    vault: target,
    slot:
      slot ??
      openPiSlot({
        authPath: join(dir, 'auth.json'),
        stashPath: join(stateDir, 'pi-openai-codex-login.json'),
        provider: 'openai-codex',
        placeholderKey: VAULT_PLACEHOLDER_KEY,
      }),
  })
}

// Authority/menu tests do not inspect login bytes. Keep their slot in memory;
// the lifecycle tests below exercise the real durable stash and restore.
function volatileSlot(): PiSlot {
  let stashed = false
  return {
    inspect: async () => ({
      slot: stashed ? 'placeholder' : 'original',
      stash: stashed ? 'valid' : 'missing',
    }),
    enterVault: async () => {
      stashed = true
    },
    exitVault: async () => {
      const result = stashed ? 'restored' : 'nothing-to-do'
      stashed = false
      return result
    },
  }
}

async function send(
  runtime: PiOpenAIRuntime,
  sessionId?: string,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  await runtime.readAuthority()
  const stream = runtime.stream(MODEL, CONTEXT, {
    transport: 'sse',
    fetch: fakeFetch,
    apiKey: runtime.vaultMode() ? VAULT_PLACEHOLDER_KEY : NATIVE_ACCESS,
    ...(sessionId ? { sessionId } : {}),
  })
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>)
    events.push(event)
  return events
}

function errorOf(events: AssistantMessageEvent[]): string | undefined {
  const last = events.at(-1)
  return last?.type === 'error' ? last.error.errorMessage : undefined
}

async function setMode(mode: RoutingMode): Promise<void> {
  await mutateAccounts((current) => {
    current.routing = { mode }
    return current
  }, paths)
}

function enroll() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath } = vaultPaths(stateDir, 'pi')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
}

/**
 * A pool row for an account the vault does not hold, its token run out. It
 * is written through a store of its own, which polls nothing, so the only
 * polls and refreshes counted are the runtime's.
 */
async function addExpiredLocalRow() {
  await openPoolStore({
    provider: 'openai',
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: quotaCodec,
  }).add({
    id: 'local',
    identity: 'chatgpt-local',
    credential: {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-local'),
      refresh: 'local-refresh',
      expires: Date.now() - 60_000,
    },
  })
}

function poolFiles(): string[] {
  return [paths.configPath, paths.statePath].map((path) =>
    existsSync(path) ? readFileSync(path, 'utf8') : '',
  )
}

describe('Pi in vault mode', () => {
  for (const mode of ['main-first', 'fallback-first'] as const) {
    test(`${mode} places the default vault account as main`, async () => {
      const credentials = {
        'chatgpt:openai': vaultLogin('chatgpt-default'),
        'chatgpt:openai:work': vaultLogin('chatgpt-work'),
      }
      daemon = await startMockDaemon({
        directory: dir,
        credentials,
      })
      enroll()
      await setMode(mode)
      const target = vault()
      const runtime = runtimeWith(target)
      try {
        await target.refresh()
        // Discovery sorts credentials by name; put the default second so
        // main-first must actually change the routing order.
        const routes = target.routes.bind(target)
        const ordered =
          mode === 'main-first'
            ? spyOn(target, 'routes').mockImplementation(() =>
                routes().reverse(),
              )
            : undefined
        try {
          expect(target.routes().map((row) => row.credentialId)).toEqual(
            mode === 'main-first'
              ? ['chatgpt:openai:work', 'chatgpt:openai']
              : ['chatgpt:openai', 'chatgpt:openai:work'],
          )
          expect(errorOf(await send(runtime))).toBeUndefined()
          expect(codexTokens).toEqual([
            chatgptAccessToken(
              mode === 'main-first' ? 'chatgpt-default' : 'chatgpt-work',
            ),
          ])
        } finally {
          ordered?.mockRestore()
        }
      } finally {
        target.close()
      }
    })
  }

  test('alias-only vault placements keep Ordered order and never serve the local main', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        'chatgpt:openai:work': vaultLogin('chatgpt-work'),
        'chatgpt:openai:home': vaultLogin('chatgpt-home'),
      },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await target.refresh()
      for (const mode of ['ordered', 'main-first', 'fallback-first'] as const) {
        await setMode(mode)
        expect(errorOf(await send(runtime))).toBeUndefined()
        const routing = (
          await createPiMenu(runtime.commandSupport()).open({ notify() {} })
        ).menu.sections.find((section) => section.id === 'routing')!
        expect(
          routing.lines.includes(
            'No default vault account, so this mode orders like Ordered',
          ),
        ).toBe(mode !== 'ordered')
      }
      expect(codexTokens).toEqual(
        Array(3).fill(chatgptAccessToken('chatgpt-home')),
      )
    } finally {
      target.close()
    }
  })

  test('unknown authority blocks synchronous local observation until a fresh read', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      expect(runtime.vaultMode()).toBe(true)
      expect(runtime.main.currentToken()).toBeUndefined()
      expect(whamTokens).toEqual([])
      await runtime.commandSupport().observeLogin(NATIVE_ACCESS)
      await runtime.main.pending()
      expect(runtime.vaultMode()).toBe(false)
      expect(whamTokens).toEqual([NATIVE_ACCESS])
    } finally {
      target.close()
    }
  })

  for (const state of ['missing-token', 'unreadable'] as const) {
    test(`${state} enrollment disables local work and retains menu Disconnect`, async () => {
      const locks = await import(
        new URL(
          './lock.js',
          import.meta.resolve('@cortexkit/common-auth/pi-slot'),
        ).href
      )
      const acquire = spyOn(locks, 'acquirePiLock')
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        vaultPaths(stateDir, 'pi').statePath,
        state === 'unreadable'
          ? '{invalid'
          : JSON.stringify({
              version: 1,
              phase: 'approved',
              proposedName: 'openai-auth-pi',
              tokenGeneration: 1,
              updatedAt: Date.now(),
            }),
        { mode: 0o600 },
      )
      const target = vault()
      const runtime = runtimeWith(target, volatileSlot())
      try {
        await runtime.syncVaultSlot()
        expect(await runtime.readAuthority()).toBe(
          state === 'unreadable' ? 'unreadable' : 'vault',
        )
        await runtime.commandSupport().observeLogin(NATIVE_ACCESS)
        await runtime.commandSupport().refreshAllQuota()
        const events = await send(runtime)
        expect(errorOf(events)).toBeDefined()
        expect(codexTokens).toEqual([])
        expect(whamTokens).toEqual([])
        expect(refreshes).toBe(0)
        const command = createPiMenu(runtime.commandSupport())
        const { menu } = await command.open({ notify() {} })
        expect(
          menu.sections
            .find((section) => section.id === 'vault')
            ?.actions.some((action) => action.id === 'disconnect'),
        ).toBe(true)
        const add = await command.apply(
          {
            command: 'openai',
            sectionId: 'accounts',
            actionId: 'add',
            confirmed: true,
          },
          { notify() {} },
        )
        expect(add.ok).toBe(false)
        const disconnected = await command.apply(
          {
            command: 'openai',
            sectionId: 'vault',
            actionId: 'disconnect',
            confirmed: true,
          },
          { notify() {} },
        )
        expect(disconnected.ok).toBe(true)
        expect(await runtime.readAuthority()).toBe('local')
        expect(acquire).not.toHaveBeenCalled()
      } finally {
        acquire.mockRestore()
        target.close()
      }
    })
  }

  test('approval during request storage read never polls the native login', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    const storage = spyOn(
      runtime as unknown as { storage(): Promise<null> },
      'storage',
    ).mockImplementation(async () => {
      enroll()
      return null
    })
    try {
      await send(runtime)
      await runtime.main.pending()
      expect(runtime.vaultMode()).toBe(true)
      expect(whamTokens).toEqual([])
      expect(runtime.main.currentToken()).toBeUndefined()
      expect(codexTokens).toEqual([])
    } finally {
      storage.mockRestore()
      target.close()
    }
  })

  test('approval during refresh-all storage read never polls the native login', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    await runtime.commandSupport().observeLogin(NATIVE_ACCESS)
    await runtime.main.pending()
    whamTokens = []
    const storage = spyOn(
      runtime as unknown as { storage(): Promise<null> },
      'storage',
    ).mockImplementation(async () => {
      enroll()
      return null
    })
    try {
      const results = await runtime.commandSupport().refreshAllQuota()
      expect(runtime.vaultMode()).toBe(true)
      expect(whamTokens).toEqual([])
      expect(results).toEqual([])
    } finally {
      storage.mockRestore()
      target.close()
    }
  })

  test('a native quota poll queued before approval refuses to send in vault mode', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime.commandSupport().observeLogin(NATIVE_ACCESS)
      await runtime.main.pending()
      whamTokens = []
      enroll()
      const result = await runtime.main.pollNow()
      expect(result.ok).toBe(false)
      expect(whamTokens).toEqual([])
    } finally {
      target.close()
    }
  })

  test("neither Pi's login nor a pool row the vault does not hold is sent with, refreshed or polled, and the pool files stay byte-identical", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await addExpiredLocalRow()
      // Fallback-first puts the pool row ahead of Pi's login and the vault.
      await setMode('fallback-first')
      const before = poolFiles()
      enroll()
      await target.refresh()
      await target.pollStale(0)
      whamTokens = []
      // Everything a session does: start (the pool's first read), requests
      // with and without a session, the menu taking Pi's login, and a quota
      // check.
      await runtime.start()
      for (const session of ['session-1', undefined, 'session-1']) {
        const events = await send(runtime, session)
        expect(events[0]?.type).toBe('start')
      }
      const support = runtime.commandSupport()
      await support.observeLogin(NATIVE_ACCESS)
      await support.refreshAllQuota()
      await runtime.pool.settled()

      expect(codexTokens).toEqual([VAULT_ACCESS, VAULT_ACCESS, VAULT_ACCESS])
      expect(whamTokens.every((token) => token === VAULT_ACCESS)).toBe(true)
      expect(refreshes).toBe(0)
      expect(poolFiles()).toEqual(before)
    } finally {
      target.close()
    }
  })

  test('the pool source sets local work aside before invoking its providers', async () => {
    await addExpiredLocalRow()
    await openPoolStore({
      provider: 'openai',
      configPath: paths.configPath,
      statePath: paths.statePath,
      quota: quotaCodec,
    }).add({
      id: 'valid-local',
      credential: {
        type: 'oauth',
        access: 'valid-local-bearer',
        refresh: 'valid-local-refresh',
        expires: Date.now() + 3_600_000,
      },
    })
    const before = poolFiles()
    enroll()
    const target = vault()
    let providerCalls = 0
    // PiOpenAIRuntime also checks enrollment inside refresh and quota callbacks.
    // Plain callbacks prove the pool source refuses before invoking either one.
    const source = new PiPoolSource({
      paths: () => paths,
      vaultMode: () => target.enrolled(),
      vaultAuthority: () => target.authority(),
      refreshProvider: async () => {
        providerCalls++
        throw new Error('local refresh must not start')
      },
      pullQuota: async () => {
        providerCalls++
        throw new Error('local quota must not start')
      },
    })
    try {
      const view = await source.load()
      const row = view.rows.find((row) => row.id === 'valid-local')
      if (!row) throw new Error('missing local row')
      expect(source.usableToken(row)).toBeUndefined()
      await source.refreshDueTokens(view.rows, null)
      expect(await source.pollRows(null)).toEqual([])
      await source.settled()
      expect(providerCalls).toBe(0)
      expect(poolFiles()).toEqual(before)
    } finally {
      source.dispose()
      await source.settled()
      target.close()
    }
  })

  test('a vault that serves no account refuses the request locally: nothing is sent, refreshed or polled', async () => {
    daemon = await startMockDaemon({ directory: dir, credentials: {} })
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await addExpiredLocalRow()
      enroll()
      await target.refresh()

      const events = await send(runtime)

      expect(errorOf(events)).toBe(VAULT_MODE_REFUSALS['vault-empty'])
      expect(codexTokens).toEqual([])
      expect(whamTokens).toEqual([])
      expect(refreshes).toBe(0)
    } finally {
      target.close()
    }
  })

  test('Pi /openai waits for the first vault answer without an empty-access hint', async () => {
    const gate = Promise.withResolvers<void>()
    daemon = await startMockDaemon({
      directory: dir,
      credentials: {},
      grants: [],
      listReplyGate: gate.promise,
    })
    const target = vault()
    const runtime = runtimeWith(target, volatileSlot())
    try {
      enroll()
      const started = Date.now()
      const { menu } = await createPiMenu(runtime.commandSupport()).open({
        notify() {},
      })
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
      expect(daemon.lists).toBe(1)
      expect(await target.status()).toMatchObject({
        discovered: false,
        accounts: [],
      })
      const section = menu.sections.find((s) => s.id === 'vault')!
      expect(section.lines).toContain(
        "Connected · waiting for the vault's first answer",
      )
      expect(section.lines?.join('\n')).not.toMatch(
        /0 accounts|ck auth grant|reclassify/,
      )
      expect(section.items).toEqual([])
      expect(section.actions.map((a) => a.id)).toEqual(['disconnect'])
      expect(menu.sections.find((s) => s.id === 'accounts')?.items).toEqual([])
      gate.resolve()
      await target.refresh()
      expect(await target.status()).toMatchObject({
        discovered: true,
        accounts: [],
      })
      const answered = await createPiMenu(runtime.commandSupport()).open({
        notify() {},
      })
      expect(
        answered.menu.sections.find((s) => s.id === 'vault')?.lines,
      ).toContain('Connected · 0 accounts')
    } finally {
      gate.resolve()
      target.close()
    }
  }, 10_000)

  // A vault that lists no account says why when it reports Pi's grants. The
  // menu's Vault section and the request refusal give the same fix.
  for (const [name, grants, refusal, menuHint] of [
    [
      'no grant names the grant command for Pi',
      [],
      'Request refused locally: this host is connected to the credential vault, which has no grant letting it read OpenAI accounts, and local accounts are not used while it is connected. Disconnect this host from the vault, or grant it access with: ck auth grant --principal enrolled:openai-auth-pi --selector-kind category --selector openai-native --operation read',
      'The vault has no grant letting openai-auth-pi read OpenAI accounts. Grant it with `ck auth grant --principal enrolled:openai-auth-pi --selector-kind category --selector openai-native --operation read`.',
    ],
    [
      'a grant reaching no login names reclassify and status',
      [
        {
          selector_kind: 'category',
          selector: 'openai-native',
          operation: 'read',
        },
      ],
      VAULT_MODE_REFUSALS['vault-grant-unreached'],
      "The vault's grant for openai-auth-pi reaches no ChatGPT login: no login has the `openai-native` category. `ck auth reclassify --from-registry` fills empty category sets from the vault's defaults; then check the CATEGORIES column with `ck auth status`.",
    ],
    [
      'an older vault keeps the general texts',
      undefined,
      VAULT_MODE_REFUSALS['vault-empty'],
      'No ChatGPT login in the vault has the `openai-native` category, or the grant is missing. Check `ck auth status` for categories and `ck auth grant` for the grant.',
    ],
  ] as const) {
    test(`an empty vault: ${name}`, async () => {
      daemon = await startMockDaemon({
        directory: dir,
        credentials: {},
        grants: grants as MockDaemon['grants'],
      })
      const target = vault()
      // The menu is only read here, so Pi's login needs no durable stash.
      const slot = volatileSlot()
      const runtime = runtimeWith(target, slot)
      try {
        enroll()
        await target.refresh()

        expect(errorOf(await send(runtime))).toBe(refusal)
        const { menu } = await createPiMenu(runtime.commandSupport()).open({
          notify() {},
        })
        expect(
          menu.sections.find((section) => section.id === 'vault')?.lines,
        ).toContain(menuHint)
        expect(codexTokens).toEqual([])
      } finally {
        target.close()
      }
    })
  }

  test('a vault that cannot be reached refuses the request locally after a bounded wait: nothing is sent, refreshed or polled', async () => {
    const target = vault({ connectScoped: () => new Promise(() => {}) })
    const runtime = runtimeWith(target)
    try {
      await addExpiredLocalRow()
      enroll()
      // The first account list never arrives.
      target.start()
      const started = Date.now()

      const events = await send(runtime)

      expect(errorOf(events)).toBe(VAULT_MODE_REFUSALS['vault-unreachable'])
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(codexTokens).toEqual([])
      expect(whamTokens).toEqual([])
      expect(refreshes).toBe(0)
    } finally {
      target.close()
    }
  }, 10_000)

  // The vault stops answering after it has served this process a token. The
  // shared vault code keeps the last token it served each account, in memory
  // only, and serves it while the vault cannot be reached; `outage` makes the
  // mock daemon answer every vault call with a transport error.
  test('a request during a vault outage is sent with the kept token at its record version, the first after the vault answers again is served fresh, and no local account is routed, refreshed or polled', async () => {
    const running = await startMockDaemon({
      directory: dir,
      credentials: {
        'oauth:openai:vault': vaultLogin('chatgpt-vault', {
          record_version: 7,
        }),
      },
    })
    daemon = running
    await addExpiredLocalRow()
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    // The receipt behind each model request: its record version, and whether
    // it was the token kept from an earlier read.
    const receipts: Array<{ recordVersion: number; kept: boolean }> = []
    const original = target.send.bind(target)
    const sends = spyOn(target, 'send').mockImplementation(
      (routeId, dispatch, options) =>
        original(
          routeId,
          (token, attempt) => {
            if (options.site === 'model')
              receipts.push({
                recordVersion: attempt.recordVersion,
                kept: attempt.fromKeptReceipt === true,
              })
            return dispatch(token, attempt)
          },
          options,
        ),
    )
    try {
      await target.refresh()
      await target.pollStale(0)
      expect(errorOf(await send(runtime))).toBeUndefined()

      running.outage = 'connection_dropped'
      expect(errorOf(await send(runtime))).toBeUndefined()
      expect(running.outageCalls).toContain('credential.get_scoped')
      expect(codexTokens).toEqual([VAULT_ACCESS, VAULT_ACCESS])
      expect(receipts).toEqual([
        { recordVersion: 7, kept: false },
        { recordVersion: 7, kept: true },
      ])

      const rotated = chatgptAccessToken('chatgpt-vault', 'rotated')
      running.credentials['oauth:openai:vault'] = vaultLogin('chatgpt-vault', {
        record_version: 8,
        payload: JSON.stringify({ access_token: rotated }),
      })
      running.outage = undefined
      // The outage ends when the vault answers again, not on the next send:
      // that send is still served the kept token at once and starts a
      // background list, and once the list is answered sends are fresh.
      expect(errorOf(await send(runtime))).toBeUndefined()
      expect(codexTokens.at(-1)).toBe(VAULT_ACCESS)
      expect(receipts.at(-1)).toEqual({ recordVersion: 7, kept: true })
      const deadline = Date.now() + 2_000
      while (target.keptReceiptState().active) {
        if (Date.now() > deadline) throw new Error('kept serving never ended')
        await Bun.sleep(5)
      }
      expect(errorOf(await send(runtime))).toBeUndefined()
      expect(codexTokens.at(-1)).toBe(rotated)
      expect(receipts.at(-1)).toEqual({ recordVersion: 8, kept: false })
      expect(whamTokens).not.toContain(chatgptAccessToken('chatgpt-local'))
      expect(refreshes).toBe(0)
    } finally {
      sends.mockRestore()
      target.close()
    }
  })

  test("disconnecting restores local routing: Pi's login serves again", async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await target.refresh()
      await target.pollStale(0)
      await send(runtime)
      expect(codexTokens).toEqual([VAULT_ACCESS])

      await target.disconnect()
      await send(runtime)

      expect(codexTokens).toEqual([VAULT_ACCESS, NATIVE_ACCESS])
    } finally {
      target.close()
    }
  })
})

function writeNativeLogin(): string {
  const entryJson = `{
    "type": "oauth", "access": ${JSON.stringify(NATIVE_ACCESS)},
    "refresh": "native-refresh", "expires": 1,
    "accountId": "chatgpt-native", "extra": { "preserve": true }
  }`
  writeFileSync(
    join(dir, 'auth.json'),
    `{\n  "unrelated": { "type": "api_key", "key": "other" },\n  "openai-codex": ${entryJson}\n}\n`,
    { mode: 0o600 },
  )
  return entryJson
}

describe("Pi's real model runtime in vault mode", () => {
  test('an expired Pi login is stashed before reload and requests use openai-codex without refresh', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    // Pi's own `openai-codex` login, run out: resolving it would refresh it
    // with OpenAI and store the result in this file.
    const authPath = join(dir, 'auth.json')
    const entryJson = writeNativeLogin()
    const authBefore = readFileSync(authPath, 'utf8')
    const piFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    const target = vault()
    try {
      const models = await ModelRuntime.create({
        authPath,
        modelsPath: join(dir, 'models.json'),
      })
      const runtime = runtimeWith(target)
      await target.refresh()
      await target.pollStale(0)
      registerPiProvider(
        {
          registerProvider: (name: string, config: unknown) =>
            models.registerProvider(name, config as never),
        } as never,
        runtime,
      )
      let reloads = 0
      await runtime.syncVaultSlot(async () => {
        reloads++
        await models.refresh()
      })
      expect(reloads).toBe(1)
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'],
      ).toEqual({
        type: 'api_key',
        key: VAULT_PLACEHOLDER_KEY,
      })
      const stashPath = join(stateDir, 'pi-openai-codex-login.json')
      const stash = JSON.parse(readFileSync(stashPath, 'utf8'))
      expect(stash.entryJson).toBe(entryJson)
      expect(stash.entry).toEqual(JSON.parse(authBefore)['openai-codex'])
      expect(statSync(stashPath).mode & 0o777).toBe(0o600)
      expect(statSync(stateDir).mode & 0o777).toBe(0o700)

      const available = (await models.getAvailable()).filter((model) =>
        model.provider.startsWith('openai-codex'),
      )
      expect(available.length).toBeGreaterThan(0)
      expect(
        available.every((model) => model.provider === 'openai-codex'),
      ).toBe(true)
      const model = available.find((entry) => entry.id === 'gpt-5.4')
      if (!model) throw new Error('openai-codex offers no gpt-5.4')

      const result = await models
        .streamSimple(model, CONTEXT, {
          sessionId: 'session-1',
          transport: 'sse',
          fetch: fakeFetch,
        } as never)
        .result()

      expect(result.stopReason).not.toBe('error')
      expect(codexTokens).toEqual([VAULT_ACCESS])
      expect(codexTokens).not.toContain(VAULT_PLACEHOLDER_KEY)
      expect(refreshes).toBe(0)
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
    } finally {
      globalThis.fetch = piFetch
      target.close()
    }
  })
})

describe('Pi vault slot lifecycle', () => {
  test('a paused stash publication expires the lease and the awaited sync owns lock-compromised', async () => {
    const { createPiSlot } = (await import(
      new URL(
        './slot.js',
        import.meta.resolve('@cortexkit/common-auth/pi-slot'),
      ).href
    )) as {
      createPiSlot(
        options: Parameters<typeof openPiSlot>[0],
        onStep: undefined,
        hooks: {
          onRenew(renew: () => Promise<void>): void
          beforeRename(path: string): Promise<void>
        },
      ): PiSlot
    }
    const authPath = join(dir, 'auth.json')
    const stashPath = join(stateDir, 'pi-openai-codex-login.json')
    const original = writeNativeLogin()
    enroll()
    let renew!: () => Promise<void>
    let entered!: () => void
    let release!: () => void
    const syncing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    const slot = createPiSlot(
      {
        authPath,
        stashPath,
        provider: 'openai-codex',
        placeholderKey: VAULT_PLACEHOLDER_KEY,
      },
      undefined,
      {
        onRenew: (update) => {
          renew = update
        },
        beforeRename: async (path) => {
          if (path !== stashPath) return
          entered()
          await resume
        },
      },
    )
    const target = vault()
    const runtime = runtimeWith(target, slot)
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    let clock: { mockRestore(): void } | undefined
    // Handle syncVaultSlot's rejection before releasing the paused stash write,
    // so an expired Pi auth lease cannot escape as an unhandled rejection.
    const result = runtime.syncVaultSlot().then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await syncing
      expect(existsSync(`${authPath}.lock`)).toBe(true)
      // common-auth's beforeRename hook pauses after fsync but before publishing
      // the stash. Advance Date.now and invoke its captured onRenew callback to
      // test a renewal more than ten seconds overdue without a wall-clock wait.
      const expired = Date.now() + 10_001
      clock = spyOn(Date, 'now').mockReturnValue(expired)
      await renew()
      clock.mockRestore()
      clock = undefined
      release()
      expect(await result).toMatchObject({ code: 'lock-compromised' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(existsSync(stashPath)).toBe(false)
      expect(readFileSync(authPath, 'utf8')).toContain(original)
      expect(existsSync(`${authPath}.lock`)).toBe(true)
      // common-auth leaves an expired lock for the next writer to reclaim once
      // old enough. Remove this test's abandoned lock instead of waiting for
      // that age threshold, then check that syncVaultSlot can recover.
      rmSync(`${authPath}.lock`, { recursive: true })
      await runtime.syncVaultSlot()
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
    } finally {
      clock?.mockRestore()
      release()
      await result
      process.off('unhandledRejection', onUnhandled)
      target.close()
    }
  })

  test('steady local and vault sync ticks take no Pi auth locks', async () => {
    const locks = await import(
      new URL(
        './lock.js',
        import.meta.resolve('@cortexkit/common-auth/pi-slot'),
      ).href
    )
    const acquire = spyOn(locks, 'acquirePiLock')
    const authPath = join(dir, 'auth.json')
    const count = () =>
      acquire.mock.calls.filter((args) => args[0] === authPath).length
    writeNativeLogin()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime.syncVaultSlot()
      expect(count()).toBeGreaterThan(0)
      acquire.mockClear()
      for (let tick = 0; tick < 10; tick++) await runtime.syncVaultSlot()
      expect(count()).toBe(0)
      enroll()
      await runtime.syncVaultSlot()
      expect(count()).toBeGreaterThan(0)
      acquire.mockClear()
      for (let tick = 0; tick < 10; tick++) await runtime.syncVaultSlot()
      expect(count()).toBe(0)
    } finally {
      acquire.mockRestore()
      target.close()
    }
  })

  test('explicit slot sync and recovery after failure take Pi auth locks', async () => {
    const locks = await import(
      new URL(
        './lock.js',
        import.meta.resolve('@cortexkit/common-auth/pi-slot'),
      ).href
    )
    const acquire = spyOn(locks, 'acquirePiLock')
    const authPath = join(dir, 'auth.json')
    const count = () =>
      acquire.mock.calls.filter((args) => args[0] === authPath).length
    const slot = openPiSlot({
      authPath,
      stashPath: join(stateDir, 'pi-openai-codex-login.json'),
      provider: 'openai-codex',
      placeholderKey: VAULT_PLACEHOLDER_KEY,
    })
    writeNativeLogin()
    const target = vault()
    const runtime = runtimeWith(target, slot)
    const inspect = spyOn(slot, 'inspect')
    try {
      await runtime.syncVaultSlot()
      acquire.mockClear()
      await runtime.syncVaultSlot(undefined, true)
      expect(count()).toBeGreaterThan(0)
      inspect.mockRejectedValueOnce(new Error('slot inspection failed'))
      await expect(runtime.syncVaultSlot(undefined, true)).rejects.toThrow(
        'slot inspection failed',
      )
      acquire.mockClear()
      await runtime.syncVaultSlot()
      expect(count()).toBeGreaterThan(0)
      acquire.mockClear()
      await runtime.syncVaultSlot()
      expect(count()).toBe(0)
      await runtime.disconnectVault()
      expect(count()).toBeGreaterThan(0)
    } finally {
      inspect.mockRestore()
      acquire.mockRestore()
      target.close()
    }
  })

  test('disconnect failure between token and ceremony removal keeps vault authority', async () => {
    writeNativeLogin()
    enroll()
    writeFileSync(
      vaultPaths(stateDir, 'pi').statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: 'openai-auth-pi',
        tokenGeneration: 1,
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    )
    const target = vault()
    const runtime = runtimeWith(target)
    const disconnect = spyOn(target, 'disconnect').mockImplementation(
      async () => {
        rmSync(target.paths.tokenPath)
        throw new Error('ceremony removal failed')
      },
    )
    try {
      await runtime.syncVaultSlot()
      await expect(runtime.disconnectVault()).rejects.toThrow(
        'ceremony removal failed',
      )
      expect(await runtime.readAuthority()).toBe('vault')
      expect(
        JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex']
          .key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        true,
      )
      await runtime.commandSupport().observeLogin(NATIVE_ACCESS)
      expect(whamTokens).toEqual([])
    } finally {
      disconnect.mockRestore()
      target.close()
    }
  })

  test('a slot restore rejection before moving leaves the original stash and vault routing', async () => {
    writeNativeLogin()
    enroll()
    const target = vault()
    const slot = openPiSlot({
      authPath: join(dir, 'auth.json'),
      stashPath: join(stateDir, 'pi-openai-codex-login.json'),
      provider: 'openai-codex',
      placeholderKey: VAULT_PLACEHOLDER_KEY,
    })
    const runtime = runtimeWith(target, slot)
    const restore = spyOn(slot, 'exitVault').mockRejectedValue(
      new Error('restore failed'),
    )
    const disconnect = spyOn(target, 'disconnect')
    try {
      await runtime.syncVaultSlot()
      const stashBefore = readFileSync(
        join(stateDir, 'pi-openai-codex-login.json'),
      )
      await expect(runtime.disconnectVault()).rejects.toThrow('restore failed')
      expect(disconnect).not.toHaveBeenCalled()
      expect(runtime.vaultMode()).toBe(true)
      expect(
        JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex']
          .key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(
        readFileSync(join(stateDir, 'pi-openai-codex-login.json')),
      ).toEqual(stashBefore)
    } finally {
      restore.mockRestore()
      disconnect.mockRestore()
      target.close()
    }
  })

  test('disconnect failure before enrollment removal re-stashes the restored login', async () => {
    writeNativeLogin()
    const before = readFileSync(join(dir, 'auth.json'))
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    const disconnect = spyOn(target, 'disconnect').mockRejectedValue(
      new Error('enrollment removal failed'),
    )
    try {
      await runtime.syncVaultSlot()
      const command = createPiMenu(runtime.commandSupport())
      const result = await command.apply(
        {
          command: 'openai',
          sectionId: 'vault',
          actionId: 'disconnect',
          confirmed: true,
        },
        { notify() {} },
      )
      expect(result.ok).toBe(false)
      expect(runtime.vaultMode()).toBe(true)
      expect(
        JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex']
          .key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        true,
      )
      expect(result.text).toContain('still enrolled')
      disconnect.mockRestore()
      await runtime.disconnectVault()
      expect(readFileSync(join(dir, 'auth.json'))).toEqual(before)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        false,
      )
    } finally {
      disconnect.mockRestore()
      target.close()
    }
  })

  test('disconnect failure after enrollment removal keeps the original login and reloads Pi', async () => {
    writeNativeLogin()
    const before = readFileSync(join(dir, 'auth.json'))
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    const remove = target.disconnect.bind(target)
    const disconnect = spyOn(target, 'disconnect').mockImplementation(
      async () => {
        await remove()
        throw new Error('roster refresh failed')
      },
    )
    let reloads = 0
    try {
      await runtime.syncVaultSlot(() => {
        reloads++
      })
      const command = createPiMenu(runtime.commandSupport(), {
        afterApply: () =>
          runtime.syncVaultSlot(() => {
            reloads++
          }),
      })
      const result = await command.apply(
        {
          command: 'openai',
          sectionId: 'vault',
          actionId: 'disconnect',
          confirmed: true,
        },
        { notify() {} },
      )
      expect(result.ok).toBe(false)
      expect(runtime.vaultMode()).toBe(false)
      expect(readFileSync(join(dir, 'auth.json'))).toEqual(before)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        false,
      )
      expect(reloads).toBe(2)
      expect(result.text).toContain('local accounts are active')
    } finally {
      disconnect.mockRestore()
      target.close()
    }
  })

  test('a slot restore rejection keeps enrollment and reconciles the restored login', async () => {
    writeNativeLogin()
    enroll()
    const target = vault()
    const slot = openPiSlot({
      authPath: join(dir, 'auth.json'),
      stashPath: join(stateDir, 'pi-openai-codex-login.json'),
      provider: 'openai-codex',
      placeholderKey: VAULT_PLACEHOLDER_KEY,
    })
    const runtime = runtimeWith(target, slot)
    const exit = slot.exitVault.bind(slot)
    const restore = spyOn(slot, 'exitVault').mockImplementation(async () => {
      await exit()
      throw new Error('restore completion failed')
    })
    const disconnect = spyOn(target, 'disconnect')
    try {
      await runtime.syncVaultSlot()
      await expect(runtime.disconnectVault()).rejects.toThrow(
        'restore completion failed',
      )
      expect(disconnect).not.toHaveBeenCalled()
      expect(runtime.vaultMode()).toBe(true)
      expect(
        JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex']
          .key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        true,
      )
    } finally {
      restore.mockRestore()
      disconnect.mockRestore()
      target.close()
    }
  })

  test('a second runtime restoring during approval preserves the original login exactly once', async () => {
    writeNativeLogin()
    const before = readFileSync(join(dir, 'auth.json'))
    enroll()
    const firstVault = vault()
    const secondVault = vault()
    const slot = openPiSlot({
      authPath: join(dir, 'auth.json'),
      stashPath: join(stateDir, 'pi-openai-codex-login.json'),
      provider: 'openai-codex',
      placeholderKey: VAULT_PLACEHOLDER_KEY,
    })
    const first = runtimeWith(firstVault)
    const second = runtimeWith(secondVault, slot)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const restoring = new Promise<void>((resolve) => {
      entered = resolve
    })
    const exit = slot.exitVault.bind(slot)
    const restore = spyOn(slot, 'exitVault').mockImplementation(async () => {
      entered()
      await held
      return exit()
    })
    try {
      await Promise.all([first.syncVaultSlot(), second.syncVaultSlot()])
      await firstVault.disconnect()
      const pending = second.syncVaultSlot()
      await restoring
      enroll()
      await first.syncVaultSlot()
      release()
      await pending
      expect(
        JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex']
          .key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        true,
      )
      restore.mockRestore()
      await first.disconnectVault()
      await second.syncVaultSlot()
      expect(readFileSync(join(dir, 'auth.json'))).toEqual(before)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        false,
      )
    } finally {
      release()
      restore.mockRestore()
      firstVault.close()
      secondVault.close()
    }
  })

  test('the vault slot uses Pi auth.json independently of pool file overrides', async () => {
    const previousAgentDir = process.env.PI_AGENT_DIR
    const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR
    const previousPoolFile = process.env.PI_OPENAI_AUTH_FILE
    try {
      const agentDir = join(dir, 'agent')
      process.env.PI_AGENT_DIR = join(dir, 'plugin-agent')
      process.env.PI_CODING_AGENT_DIR = agentDir
      process.env.PI_OPENAI_AUTH_FILE = join(dir, 'different-pool.json')
      mkdirSync(agentDir, { mode: 0o700 })
      const authPath = join(agentDir, 'auth.json')
      const before =
        '{"openai-codex":{"type":"oauth","access":"native","refresh":"refresh","expires":1}}'
      writeFileSync(authPath, before, { mode: 0o600 })
      const slot = openVaultSlot(paths.statePath)
      await slot.enterVault()
      expect(
        JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].key,
      ).toBe(VAULT_PLACEHOLDER_KEY)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        true,
      )
      expect(existsSync(process.env.PI_OPENAI_AUTH_FILE)).toBe(false)
      await slot.exitVault()
      expect(readFileSync(authPath, 'utf8')).toBe(before)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR
      else process.env.PI_AGENT_DIR = previousAgentDir
      if (previousCodingAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir
      if (previousPoolFile === undefined) delete process.env.PI_OPENAI_AUTH_FILE
      else process.env.PI_OPENAI_AUTH_FILE = previousPoolFile
    }
  })

  test('disconnect restores the original Pi entry byte-identical before removing enrollment', async () => {
    writeNativeLogin()
    const authPath = join(dir, 'auth.json')
    const before = readFileSync(authPath)
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    let reloads = 0
    const refresh = async () => {
      reloads++
    }
    try {
      await runtime.syncVaultSlot(refresh)
      const command = createPiMenu(runtime.commandSupport(), {
        afterApply: () => runtime.syncVaultSlot(refresh),
      })
      // Pi's original auth entry must already be restored when deletion of
      // this host's vault enrollment token begins.
      const disconnect = target.disconnect.bind(target)
      target.disconnect = async () => {
        expect(readFileSync(authPath)).toEqual(before)
        expect(existsSync(vaultPaths(stateDir, 'pi').tokenPath)).toBe(true)
        await disconnect()
      }
      const result = await command.apply(
        {
          command: 'openai',
          sectionId: 'vault',
          actionId: 'disconnect',
          confirmed: true,
        },
        { notify() {} },
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(authPath)).toEqual(before)
      expect(existsSync(join(stateDir, 'pi-openai-codex-login.json'))).toBe(
        false,
      )
      expect(existsSync(vaultPaths(stateDir, 'pi').tokenPath)).toBe(false)
      expect(reloads).toBe(2)
    } finally {
      target.close()
    }
  })

  test('a foreign Pi login makes disconnect report a conflict and overwrite neither login', async () => {
    writeNativeLogin()
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime.syncVaultSlot()
      const authPath = join(dir, 'auth.json')
      const stashPath = join(stateDir, 'pi-openai-codex-login.json')
      const stashBefore = readFileSync(stashPath)
      const foreign =
        '{ "openai-codex": {"type":"oauth","access":"foreign-access","refresh":"foreign-refresh","expires":1} }\n'
      writeFileSync(authPath, foreign)
      const command = createPiMenu(runtime.commandSupport())
      const result = await command.apply(
        {
          command: 'openai',
          sectionId: 'vault',
          actionId: 'disconnect',
          confirmed: true,
        },
        { notify() {} },
      )
      expect(result.ok).toBe(true)
      expect(result.text).toContain(VAULT_SLOT_CONFLICT)
      expect(readFileSync(authPath, 'utf8')).toBe(foreign)
      expect(readFileSync(stashPath)).toEqual(stashBefore)
      expect(existsSync(vaultPaths(stateDir, 'pi').tokenPath)).toBe(false)
      expect(runtime.vaultMode()).toBe(false)
    } finally {
      target.close()
    }
  })

  test('a non-placeholder resolved credential refuses locally even with a healthy vault', async () => {
    daemon = await startMockDaemon({
      directory: dir,
      credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
    })
    enroll()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await target.refresh()
      await target.pollStale(0)
      const pollsBefore = [...whamTokens]
      for (const apiKey of [NATIVE_ACCESS, undefined]) {
        const events: AssistantMessageEvent[] = []
        for await (const event of runtime.stream(MODEL, CONTEXT, {
          transport: 'sse',
          fetch: fakeFetch,
          apiKey,
        }))
          events.push(event)
        expect(errorOf(events)).toBe(VAULT_SLOT_REFUSAL)
      }
      expect(codexTokens).toEqual([])
      expect(whamTokens).toEqual(pollsBefore)
      expect(refreshes).toBe(0)
    } finally {
      target.close()
    }
  })

  test('only openai-codex is registered in local and vault mode', async () => {
    const target = vault()
    const runtime = runtimeWith(target)
    const registrations: string[] = []
    const registrar = {
      registerProvider: (id: string) => {
        registrations.push(id)
      },
    }
    try {
      registerPiProvider(registrar as never, runtime)
      enroll()
      await runtime.syncVaultSlot()
      registerPiProvider(registrar as never, runtime)
      expect(registrations).toEqual(['openai-codex', 'openai-codex'])
    } finally {
      target.close()
    }
  })

  test('approval after startup swaps the login and awaits Pi reload before returning', async () => {
    writeNativeLogin()
    const target = vault()
    const runtime = runtimeWith(target)
    try {
      await runtime.syncVaultSlot()
      enroll()
      let release!: () => void
      let entered!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const reloading = new Promise<void>((resolve) => {
        entered = resolve
      })
      let finished = false
      const pending = runtime
        .syncVaultSlot(async () => {
          expect(
            JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))[
              'openai-codex'
            ].key,
          ).toBe(VAULT_PLACEHOLDER_KEY)
          entered()
          await released
        })
        .then(() => {
          finished = true
        })
      await reloading
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        expect(finished).toBe(false)
      } finally {
        release()
        await pending
      }
      expect(finished).toBe(true)
    } finally {
      target.close()
    }
  })
})
