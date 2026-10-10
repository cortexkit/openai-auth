import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vaultPaths, vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import {
  chatgptAccessToken,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { PiOpenAIRuntime } from '../runtime.ts'
import { VAULT_PLACEHOLDER_KEY } from '../vault-slot.ts'

type Provider = NonNullable<ReturnType<ModelRuntime['getProvider']>>
type ComposingRuntime = { composeProvider(id: string): Provider | undefined }

// The SDK constructs its own ModelRuntime and loads the extension through Pi's
// real loader. These observers delegate unchanged; they only record the order.
test('Pi 1.0.4 startup swaps the enrolled slot before auth resolution and the first request', async () => {
  if (process.env.PI_STARTUP_ORDER_CHILD !== '1') {
    const homeDir = mkdtempSync(join(tmpdir(), 'pi-vault-startup-home-'))
    try {
      const child = spawnSync(
        process.execPath,
        [
          'test',
          './src/tests/startup-order.test.ts',
          '-t',
          'Pi 1.0.4 startup swaps the enrolled slot before auth resolution and the first request',
        ],
        {
          cwd: join(import.meta.dir, '../..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: homeDir,
            PI_STARTUP_ORDER_CHILD: '1',
          },
        },
      )
      if (child.error) throw child.error
      if (child.status !== 0) {
        throw new Error(`${child.stdout}\n${child.stderr}`)
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'pi-vault-startup-order-'))
  const homeDir = process.env.HOME!
  const piAgentDir = join(homeDir, 'x')
  const pluginAgentDir = join(dir, 'plugin-agent')
  const authPath = join(piAgentDir, 'auth.json')
  const pluginAuthPath = join(pluginAgentDir, 'auth.json')
  const events: string[] = []
  const observedEnv = [
    'HOME',
    'PI_CODING_AGENT_DIR',
    'PI_AGENT_DIR',
    'PI_OPENAI_AUTH_FILE',
    'PI_OPENAI_AUTH_STATE_FILE',
    'PI_OFFLINE',
    'CLAUSTRUM_SUBC_CONNECTION',
  ] as const
  const previousEnv = Object.fromEntries(
    observedEnv.map((name) => [name, process.env[name]]),
  )
  const prototype = ModelRuntime.prototype as unknown as ComposingRuntime
  const compose = prototype.composeProvider
  const refresh = ModelRuntime.prototype.refresh
  const syncSlot = PiOpenAIRuntime.prototype.syncVaultSlot
  const start = PiOpenAIRuntime.prototype.start
  const fetch = globalThis.fetch
  let runtime: PiOpenAIRuntime | undefined
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>['session']
    | undefined
  const traceKey = Symbol.for('openai-auth.tests.pi-startup-order')
  const globals = globalThis as unknown as Record<symbol, unknown>
  globals[traceKey] = events
  const intervals: ReturnType<typeof setInterval>[] = []
  const interval = globalThis.setInterval
  const daemon = await startMockDaemon({
    directory: dir,
    credentials: { 'oauth:openai:vault': vaultLogin('chatgpt-vault') },
  })
  let refreshes = 0
  const codexTokens: string[] = []
  const pluginAuthBefore = JSON.stringify({
    'openai-codex': { type: 'api_key', key: 'plugin-account-store' },
  })
  const slotType = () =>
    JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].type as string
  try {
    process.env.HOME = homeDir
    process.env.PI_CODING_AGENT_DIR = '~/x'
    process.env.PI_AGENT_DIR = pluginAgentDir
    process.env.PI_OPENAI_AUTH_FILE = join(dir, 'pool.json')
    process.env.PI_OPENAI_AUTH_STATE_FILE = join(dir, 'pool-state.json')
    process.env.PI_OFFLINE = '1'
    process.env.CLAUSTRUM_SUBC_CONNECTION = daemon.connectionFile
    mkdirSync(piAgentDir, { recursive: true })
    mkdirSync(pluginAgentDir, { recursive: true })
    writeFileSync(
      authPath,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: chatgptAccessToken('chatgpt-native'),
          refresh: 'expired-native-refresh',
          expires: 1,
        },
      }),
      { mode: 0o600 },
    )
    writeFileSync(pluginAuthPath, pluginAuthBefore, { mode: 0o600 })
    const stateDir = vaultStateDir(process.env.PI_OPENAI_AUTH_STATE_FILE)
    mkdirSync(stateDir, { mode: 0o700 })
    writeFileSync(
      vaultPaths(stateDir, 'pi').tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(piAgentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'openai-codex',
        defaultModel: 'gpt-5.4',
      }),
    )
    mkdirSync(join(piAgentDir, 'extensions'))
    writeFileSync(
      join(piAgentDir, 'extensions', 'observe.ts'),
      `import plugin from ${JSON.stringify(join(import.meta.dir, '..', 'index.ts'))};
export default async function(pi) {
  const events = globalThis[Symbol.for('openai-auth.tests.pi-startup-order')];
  events.push('factory:start');
  pi.on('session_start', () => { events.push('session_start'); });
  await plugin(pi);
  events.push('factory:end');
}`,
    )
    prototype.composeProvider = function (id) {
      const provider = compose.call(this, id)
      if (id === 'openai-codex' && provider) {
        for (const [kind, methods] of Object.entries(provider.auth)) {
          if (!methods || typeof methods !== 'object') continue
          const record = methods as unknown as Record<string, unknown>
          for (const name of ['check', 'resolve', 'toAuth', 'refresh']) {
            const method = record[name]
            if (typeof method !== 'function') continue
            record[name] = (...args: unknown[]) => {
              events.push(`${kind}.${name}:${slotType()}`)
              return method.apply(methods, args)
            }
          }
        }
      }
      return provider
    }
    ModelRuntime.prototype.refresh = function (options) {
      events.push(`registry.refresh:${slotType()}`)
      return refresh.call(this, options)
    }
    PiOpenAIRuntime.prototype.syncVaultSlot = async function (reload) {
      await syncSlot.call(this, reload)
      events.push(`slot.sync:${slotType()}`)
    }
    PiOpenAIRuntime.prototype.start = function () {
      runtime = this
      return start.call(this)
    }
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const timer = interval(...args)
      intervals.push(timer)
      return timer
    }) as typeof setInterval
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith('https://auth.openai.com/oauth/token')) {
        refreshes++
        events.push('transport:oauth-refresh')
        return new Response('{}', { status: 400 })
      }
      if (url.endsWith('/wham/usage'))
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 7200,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604800,
              reset_at: Math.floor(Date.now() / 1000) + 86400,
            },
          },
        })
      if (url.endsWith('/codex/responses')) {
        events.push('transport:codex')
        codexTokens.push(new Headers(init?.headers).get('authorization') ?? '')
        return new Response(
          'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch
    const created = await createAgentSession({
      cwd: dir,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(dir),
      noTools: 'all',
    })
    session = created.session
    expect(created.extensionsResult.errors).toEqual([])
    await session.bindExtensions({})
    expect(runtime).toBeDefined()
    const hostEntry = JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex']
    expect(hostEntry.key).toBe(VAULT_PLACEHOLDER_KEY)
    expect(hostEntry.type).toBe('api_key')
    expect(readFileSync(pluginAuthPath, 'utf8')).toBe(pluginAuthBefore)
    // Load the vault accounts' remaining-usage readings with vault tokens,
    // not Pi auth. Otherwise a request can refuse for missing quota data,
    // independently of the authentication ordering measured here.
    await runtime?.vault.refresh()
    await runtime?.vault.pollStale(0)
    const models = session.modelRuntime
    const model = (await models.getAvailable('openai-codex')).find(
      (entry) => entry.id === 'gpt-5.4',
    )
    expect(model).toBeDefined()
    if (!model) throw new Error('Pi did not offer openai-codex/gpt-5.4')
    const result = await models
      .streamSimple(
        model,
        { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] },
        { transport: 'sse' } as never,
      )
      .result()
    expect(result.stopReason).not.toBe('error')
    expect(refreshes).toBe(0)
    expect(codexTokens).toEqual([
      `Bearer ${chatgptAccessToken('chatgpt-vault')}`,
    ])
    const swapped = events.indexOf('slot.sync:api_key')
    const firstResolve = events.findIndex((event) =>
      /^(apiKey|oauth)\.(resolve|toAuth|refresh):/.test(event),
    )
    expect(swapped).toBeGreaterThan(events.indexOf('factory:start'))
    expect(events.indexOf('factory:end')).toBeGreaterThan(swapped)
    expect(events.indexOf('session_start')).toBeGreaterThan(swapped)
    expect(firstResolve).toBeGreaterThan(swapped)
    expect(events[firstResolve]).toBe('apiKey.resolve:api_key')
    expect(JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].key).toBe(
      VAULT_PLACEHOLDER_KEY,
    )
    console.log(`Pi startup order: ${JSON.stringify(events)}`)
  } finally {
    session?.dispose()
    runtime?.vault.close()
    for (const timer of intervals) clearInterval(timer)
    globalThis.setInterval = interval
    prototype.composeProvider = compose
    ModelRuntime.prototype.refresh = refresh
    PiOpenAIRuntime.prototype.syncVaultSlot = syncSlot
    PiOpenAIRuntime.prototype.start = start
    globalThis.fetch = fetch
    delete globals[traceKey]
    for (const name of observedEnv) {
      if (previousEnv[name] === undefined) delete process.env[name]
      else process.env[name] = previousEnv[name]
    }
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20000)
