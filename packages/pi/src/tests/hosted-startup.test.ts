import { expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_MODE_REFUSALS } from '@cortexkit/openai-auth-core/internal'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  VERSION,
} from '@earendil-works/pi-coding-agent'
import { installVaultRelay } from '../../../core/src/tests/fixtures/host-vault.ts'
import {
  chatgptAccessToken,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import openAIAuth from '../index.ts'
import { PiOpenAIRuntime } from '../runtime.ts'
import { installHostedVaultKey, VAULT_PLACEHOLDER_KEY } from '../vault-slot.ts'
import { isolatePiAgentDir } from './test-isolation.ts'

const agentDir = isolatePiAgentDir()
const nativeBearer = chatgptAccessToken('native-hosted-test')
const vaultBearer = chatgptAccessToken('vault-hosted-test')

async function exerciseStart({
  hosted = true,
  login,
  hasVaultLogin = true,
}: {
  hosted?: boolean
  login: 'valid' | 'expired' | 'absent'
  hasVaultLogin?: boolean
}) {
  const dir = agentDir()
  const authPath = join(dir, 'auth.json')
  const expires = login === 'expired' ? 1 : Date.now() + 3_600_000
  const nativeEntry =
    login === 'absent'
      ? ''
      : `,\n  "openai-codex": { "type": "oauth", "access": "${nativeBearer}", "refresh": "native-refresh", "expires": ${expires} }`
  const original = `{\n  "unrelated": { "type": "api_key", "key": "not-for-codex" }${nativeEntry}\n}\n`
  writeFileSync(authPath, original, { mode: 0o600 })

  const daemon = hosted
    ? await startMockDaemon({
        directory: dir,
        credentials: hasVaultLogin
          ? { 'oauth:openai:hosted': vaultLogin('vault-hosted-test') }
          : {},
      })
    : undefined
  const relay = daemon
    ? await installVaultRelay(daemon.connectionFile)
    : undefined
  const sends: string[] = []
  const polls: string[] = []
  let refreshes = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const token =
        new Headers(init?.headers)
          .get('authorization')
          ?.replace(/^Bearer /, '') ?? ''
      if (url.startsWith('https://auth.openai.com/oauth/token')) {
        refreshes++
        return new Response('{}', { status: 400 })
      }
      if (url.endsWith('/wham/usage')) {
        polls.push(token)
        const reset = Math.floor(Date.now() / 1000) + 3600
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: reset,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604800,
              reset_at: reset + 86400,
            },
          },
        })
      }
      if (!url.endsWith('/codex/responses'))
        throw new Error(`Unexpected test request: ${url}`)
      sends.push(token)
      return new Response(
        'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
    originalFetch,
  )

  const sync = spyOn(PiOpenAIRuntime.prototype, 'syncVaultSlot')
  const interval = globalThis.setInterval
  const timers: ReturnType<typeof setInterval>[] = []
  let tick: (() => void) | undefined
  globalThis.setInterval = ((
    ...[run, ms, ...args]: Parameters<typeof setInterval>
  ) => {
    const timer = interval(run, ms, ...args)
    if (ms === 5000) {
      tick = () => run(...args)
      timers.push(timer)
    }
    return timer
  }) as typeof setInterval
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>['session']
    | undefined
  try {
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-6.1-sol',
      transport: 'sse',
      retry: { enabled: false, provider: { maxRetries: 0 } },
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        async (pi) => {
          await openAIAuth(pi)
          expect(readFileSync(authPath, 'utf8')).toBe(original)
          pi.on('session_start', (_event, ctx) => {
            expect(
              ctx.modelRegistry.getRegisteredProviderConfig('openai-codex')
                ?.apiKey,
            ).toBe(hosted ? VAULT_PLACEHOLDER_KEY : undefined)
          })
        },
      ],
    })
    await resourceLoader.reload()
    const created = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      noTools: 'all',
    })
    session = created.session
    expect(created.extensionsResult.errors).toEqual([])
    if (login === 'absent') {
      // Before session_start installs the override, registration alone can
      // resolve a credential for an empty slot.
      expect(
        (await session.modelRuntime.getAuth('openai-codex'))?.auth.apiKey,
      ).toBe(VAULT_PLACEHOLDER_KEY)
    }
    const extensionErrors: unknown[] = []
    await session.bindExtensions({
      onError: (error) => {
        extensionErrors.push(error)
      },
    })
    expect(extensionErrors).toEqual([])
    if (login === 'absent') {
      // Pi chooses its initial model before the extension provider is ready
      // when native auth is absent; select the now-available Codex model.
      const model = session.modelRuntime.getModel('openai-codex', 'gpt-6.1-sol')
      if (!model) throw new Error('Pi did not offer openai-codex/gpt-6.1-sol')
      await session.setModel(model)
    }
    expect(session.model?.id).toBe('gpt-6.1-sol')
    expect(readFileSync(authPath, 'utf8')).toBe(original)

    if (!tick) throw new Error('The periodic provider sync was not scheduled')
    const callsBefore = sync.mock.calls.length
    tick()
    expect(sync.mock.calls).toHaveLength(callsBefore + 1)
    await sync.mock.results.at(-1)?.value
    expect(readFileSync(authPath, 'utf8')).toBe(original)

    await session.prompt('hello')
    const last = session.messages.at(-1)
    if (hosted && !hasVaultLogin) {
      expect(last).toMatchObject({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: VAULT_MODE_REFUSALS['vault-empty'],
      })
      expect(sends).toEqual([])
      expect(polls).toEqual([])
    } else {
      const expected = hosted ? vaultBearer : nativeBearer
      expect(last).toMatchObject({ role: 'assistant', stopReason: 'stop' })
      expect(sends).toEqual([expected])
      expect(polls).toContain(expected)
      expect(polls.every((token) => token === expected)).toBe(true)
    }
    expect(refreshes).toBe(0)
    expect(readFileSync(authPath, 'utf8')).toBe(original)
  } finally {
    await session?.extensionRunner.emit({
      type: 'session_shutdown',
      reason: 'quit',
    })
    session?.dispose()
    for (const timer of timers) clearInterval(timer)
    globalThis.setInterval = interval
    globalThis.fetch = originalFetch
    sync.mockRestore()
    await relay?.close()
    await daemon?.stop()
  }
}

test.each(['valid', 'expired', 'absent'] as const)(
  'a hosted Pi session with %s native login keeps auth.json and serves with the vault',
  async (login) => exerciseStart({ login }),
)

test('a hosted Pi session without a usable vault receipt gets the fixed refusal', async () => {
  await exerciseStart({ login: 'expired', hasVaultLogin: false })
})

test('a non-hosted Pi session still uses its native login', async () => {
  await exerciseStart({ login: 'valid', hosted: false })
})

test('a missing Pi credential override bridge warns once with the installed version', async () => {
  const warnings: string[] = []
  const log = { warn: (message: string) => warnings.push(message) }
  await installHostedVaultKey({}, log)
  await installHostedVaultKey({ runtime: { setRuntimeApiKey: null } }, log)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(`Pi ${VERSION}`)
})
