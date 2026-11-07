import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { vaultPaths, vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../../core/src/tests/fixtures/mock-claustrum'
import { POOL_PLACEHOLDER } from '../../core/pool-migration'
import { runtimeStateDir } from './opencode-host'
import {
  MOCK_ACCOUNTS,
  type MockAccount,
  type RejectMode,
  startMockCodex,
} from './opencode2-mock-codex'

export const POLICY_NOW = Date.now()

export type LimitTurn = {
  reject?: RejectMode
  rejectAgain?: RejectMode
  restart?: boolean
  otherLocation?: boolean
}

type Input = {
  host: 1 | 2
  binary: string
  /** OC1's built entry or OC2's packed package export, resolved by the wrapper. */
  plugin: string
  wrapperRoot: string
  vault?: boolean
  delayedRoster?: boolean
  transport?: 'http' | 'websocket'
  setting?: 0 | 15 | 'max'
  blockedAlternative?: boolean
  allExhausted?: boolean
  mixed?: boolean
  turns: LimitTurn[]
}

function seedPool(
  configDir: string,
  runtimeDir: string,
  vault: boolean,
  setting: Input['setting'],
  blockedAlternative = false,
  allExhausted = false,
) {
  const accounts: MockAccount[] = vault ? [] : ['V', 'B']
  writeFileSync(
    join(configDir, 'openai-auth.json'),
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode: 'sticky-balanced', maxSameAccountWait: setting ?? 15 },
      killswitch: { enabled: blockedAlternative || allExhausted },
      accounts: accounts.map((id) => ({
        id: id === 'V' ? 'main' : id,
        type: 'oauth',
        enabled: true,
        addedAt: 1,
        accountId: MOCK_ACCOUNTS[id].id,
      })),
      openaiAuthPool: { migratedAt: POLICY_NOW - 60_000 },
      commonAuthPool: {
        schemaVersion: 1,
        rows: Object.fromEntries(
          accounts.map((id) => [
            id === 'V' ? 'main' : id,
            {
              credentialEpoch: 1,
              needsFirstReading: false,
              quota: {
                limits: [
                  {
                    scope: 'all',
                    label: 'primary',
                    kind: 'reading',
                    checkedAt: POLICY_NOW,
                    usedPercent: allExhausted
                      ? 100
                      : id === 'V'
                        ? 5
                        : blockedAlternative
                          ? 100
                          : 40,
                    resetsAt: new Date(POLICY_NOW + 7_200_000).toISOString(),
                    windowMinutes: 300,
                  },
                ],
              },
            },
          ]),
        ),
      },
    }),
  )
  writeFileSync(
    join(runtimeDir, 'openai-auth-state.json'),
    JSON.stringify({
      version: 1,
      accounts: Object.fromEntries(
        accounts.map((id) => [
          id === 'V' ? 'main' : id,
          {
            access: MOCK_ACCOUNTS[id].token,
            refresh: `refresh-${id}`,
            expires: POLICY_NOW + 86_400_000,
          },
        ]),
      ),
    }),
    { mode: 0o600 },
  )
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

type PolicyTrace = {
  event: string
  kind?: string
  status?: number
  retryAfter?: string | null
  now: number
  retry?: boolean
  delay?: number
}

const jsonLines = (path: string): PolicyTrace[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

/** Runs the real host; only its backend, clock and credentials are synthetic. */
export async function runLimitAcceptance(input: Input) {
  const root = mkdtempSync(join(tmpdir(), `oai-oc${input.host}-limits-`))
  const project = join(root, 'project')
  mkdirSync(project)
  spawnSync('git', ['init', '-q'], { cwd: project })
  writeFileSync(join(project, 'sentinel.txt'), 'TOOL-SENTINEL\n')
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'),
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,registry.npmjs.org',
    no_proxy: '127.0.0.1,localhost,registry.npmjs.org',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_SERVER_PASSWORD: 'limit-test',
    OPENCODE_PASSWORD: 'limit-test',
    OPENCODE_OPENAI_AUTH_LOG_FILE: join(root, 'plugin.log'),
    OPENCODE_OPENAI_AUTH_LOG_LEVEL: 'debug',
    OPENAI_AUTH_E2E_CLOCK: join(root, 'clock'),
    OPENAI_AUTH_E2E_POLICY_TRACE: join(root, 'policy.jsonl'),
    OPENAI_AUTH_E2E_MOCK_URL: '',
    OPENAI_AUTH_E2E_CLAUSTRUM: '',
  }
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
  ] as const)
    mkdirSync(env[key], { recursive: true })
  writeFileSync(env.OPENAI_AUTH_E2E_CLOCK, String(POLICY_NOW))
  const now = () => Number(readFileSync(env.OPENAI_AUTH_E2E_CLOCK, 'utf8'))
  const mock = startMockCodex(
    [
      placeholderSecret('openai'),
      POOL_PLACEHOLDER.access,
      POOL_PLACEHOLDER.refresh,
    ].filter((value) => value !== ''),
    {
      now,
      resetMs: 1000,
      ...(input.allExhausted
        ? { used: { V: 100, B: 100 } }
        : input.blockedAlternative
          ? { used: { B: 100 } }
          : {}),
    },
  )
  env.OPENAI_AUTH_E2E_MOCK_URL = mock.url
  const configDir = join(env.XDG_CONFIG_HOME, 'opencode')
  const runtimeDir = runtimeStateDir(env.XDG_STATE_HOME, configDir)
  mkdirSync(runtimeDir, { recursive: true })
  // Seed the old location so the real runtime-layout migration, not the
  // fixture, establishes the state-home marker on this process's first start.
  seedPool(
    configDir,
    configDir,
    input.vault ?? false,
    input.setting,
    input.blockedAlternative,
    input.allExhausted,
  )
  const dataDir = join(env.XDG_DATA_HOME, 'opencode')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'auth.json'),
    JSON.stringify({ openai: POOL_PLACEHOLDER }),
    { mode: 0o600 },
  )
  const rosterGate = Promise.withResolvers<void>()
  const daemon = input.vault
    ? await startMockDaemon({
        directory: root,
        ...(input.delayedRoster ? { listReplyGate: rosterGate.promise } : {}),
        credentials: {
          'oauth:openai:work': vaultLogin(MOCK_ACCOUNTS.V.id, {
            record_version: 7,
          }),
        },
      })
    : undefined
  if (daemon) {
    env.OPENAI_AUTH_E2E_CLAUSTRUM = daemon.connectionFile
    const paths = vaultPaths(
      vaultStateDir(join(configDir, 'openai-auth-state.json')),
      'opencode',
    )
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true })
    writeFileSync(
      paths.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
  }
  const wrapper = join(
    input.wrapperRoot,
    `limit-${input.host}-${root.split(/[\\/]/).at(-1)}`,
  )
  mkdirSync(wrapper)
  const entry = join(wrapper, 'index.js')
  writeFileSync(entry, wrapperSource(input))
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify(
      input.host === 1
        ? {
            plugin: [pathToFileURL(entry).href],
            autoupdate: false,
            share: 'disabled',
          }
        : {
            plugins: [wrapper],
            providers: {
              openai: {
                settings: {
                  apiKey: placeholderSecret('openai'),
                  baseURL: `${mock.url}/v1`,
                  transport: input.transport ?? 'http',
                },
                models: { 'gpt-5.5': { name: 'GPT-5.5 (mock)' } },
              },
            },
          },
    ),
  )
  const config = JSON.parse(
    readFileSync(join(configDir, 'openai-auth.json'), 'utf8'),
  )
  writeFileSync(
    join(configDir, 'openai-auth.json'),
    JSON.stringify({
      ...config,
      webSockets: input.transport === 'websocket',
      responsesLite: false,
      codexApiEndpoint: `${mock.url}/backend-api/codex/responses`,
    }),
  )
  return runHost(input, {
    root,
    project,
    env,
    mock,
    daemon,
    wrapper,
    runtimeDir,
    releaseRoster: rosterGate.resolve,
  })
}

function wrapperSource(input: Input): string {
  const prelude = [
    "import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'",
    'const now = () => Number(readFileSync(process.env.OPENAI_AUTH_E2E_CLOCK, "utf8"))',
    // OC1 samples Date.now directly; freezing it also holds registry freshness
    // constant while vault discovery crosses the first-request boundary.
    'Date.now = now',
    'const trace = (event) => appendFileSync(process.env.OPENAI_AUTH_E2E_POLICY_TRACE, JSON.stringify(event) + "\\n")',
    'const advance = (ms) => writeFileSync(process.env.OPENAI_AUTH_E2E_CLOCK, String(now() + ms))',
    'const realFetch = globalThis.fetch',
    'const mock = process.env.OPENAI_AUTH_E2E_MOCK_URL',
    'globalThis.fetch = Object.assign((input, init) => {',
    '  const url = input instanceof Request ? input.url : String(input)',
    "  if (!url.startsWith('https://chatgpt.com/')) return realFetch(input, init)",
    "  const target = url.replace('https://chatgpt.com', mock)",
    '  return realFetch(input instanceof Request ? new Request(target, input) : target, init)',
    '}, realFetch)',
    `const plugin = await import(${JSON.stringify(input.plugin)})`,
    `const options = ${input.vault ? '{ vault: { connectionFile: () => process.env.OPENAI_AUTH_E2E_CLAUSTRUM, pollIntervalMs: 0 } }' : '{}'}`,
  ]
  if (input.host === 1)
    return [
      ...prelude,
      'export default { ...plugin.default, async server(input) {',
      `  const hooks = await plugin.CodexAuthPlugin(input, { ...options, experimentalWebSockets: ${input.transport === 'websocket'}, responsesLite: false, codexApiEndpoint: mock + '/backend-api/codex/responses' })`,
      '  const loader = hooks.auth.loader',
      '  hooks.auth.loader = async (...args) => {',
      '    const loaded = await loader(...args)',
      '    const send = loaded.fetch',
      '    loaded.fetch = async (...args) => {',
      '      const body = args[1]?.body ?? (args[0] instanceof Request ? await args[0].clone().text() : "")',
      '      const kind = /"tools"\\s*:/.test(String(body)) ? "primary" : "other"',
      '      const response = await send(...args)',
      '      const retryAfter = response.headers.get("retry-after")',
      '      trace({ event: "response", kind, status: response.status, retryAfter, now: now() })',
      '      if (retryAfter && response.status === 429) advance(Number(retryAfter) * 1000)',
      '      return response',
      '    }',
      '    return loaded',
      '  }',
      '  return hooks',
      '} }',
    ].join('\n')
  return [
    ...prelude,
    'const configured = plugin.createOpenAIAuthPlugin({ ...options, now, fetch: globalThis.fetch })',
    'export default { ...configured, async setup(ctx) {',
    ...(input.mixed
      ? [
          '  let foreignArrived',
          '  const foreign = new Promise((resolve) => { foreignArrived = resolve })',
          '  const outsider = await ctx.session.hook("http.request", (draft) => {',
          '    if (draft.kind !== "title") return',
          '    draft.request.headers.set("authorization", "Bearer unrelated-api-key")',
          '    trace({ event: "foreign-title", now: now() })',
          '    foreignArrived()',
          '  }, { providerID: "openai" })',
          '  const baseline = await ctx.session.hook("retry", (draft) => trace({ event: "host-retry", ...draft.decision, now: now() }), { providerID: "openai" })',
        ]
      : []),
    '  const dispose = await configured.setup(ctx)',
    ...(input.mixed
      ? [
          '  const barrier = await ctx.session.hook("http.request", async (draft) => { if (draft.kind === "primary") await foreign }, { providerID: "openai" })',
        ]
      : []),
    '  const retry = await ctx.session.hook("retry", (draft) => {',
    '    trace({ event: "retry", ...draft, ...draft.decision, now: now() })',
    '    if (draft.decision.retry && draft.decision.delay > 0) advance(draft.decision.delay)',
    '  }, { providerID: "openai" })',
    `  return async () => { await retry.dispose(); ${input.mixed ? 'await barrier.dispose(); await outsider.dispose(); await baseline.dispose();' : ''} await dispose?.() }`,
    '} }',
  ].join('\n')
}

export async function waitForHostReady(
  url: string,
  host: 1 | 2,
  options: {
    authorization?: string
    checkRunning?: () => void
    timeoutMs?: number
    requestTimeoutMs?: number
    pollIntervalMs?: number
  } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 180_000)
  let last = 'no response'
  while (Date.now() < deadline) {
    options.checkRunning?.()
    try {
      // OpenCode 2 reports startup readiness on /api/info, without enumerating
      // providers or hydrating the plugin before the first turn. /health is
      // only a web app fallback on OpenCode 1, so preserve its socket check.
      const response = await fetch(
        `${url}${host === 2 ? '/api/info' : '/health'}`,
        {
          headers: options.authorization
            ? { authorization: options.authorization }
            : undefined,
          signal: AbortSignal.timeout(options.requestTimeoutMs ?? 500),
        },
      )
      await response.body?.cancel()
      if (host === 1 || response.status === 200) return
      if (response.status !== 503)
        throw new Error(`host readiness answered ${response.status}`)
      last = 'service starting'
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('host readiness'))
        throw error
      last = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(options.pollIntervalMs ?? 50)
  }
  throw new Error(`host at ${url} did not become ready (${last})`)
}

async function runHost(
  input: Input,
  fixture: {
    root: string
    project: string
    env: Record<string, string> & {
      OPENAI_AUTH_E2E_POLICY_TRACE: string
      OPENCODE_OPENAI_AUTH_LOG_FILE: string
      XDG_CONFIG_HOME: string
    }
    mock: ReturnType<typeof startMockCodex>
    daemon: Awaited<ReturnType<typeof startMockDaemon>> | undefined
    wrapper: string
    runtimeDir: string
    releaseRoster: () => void
  },
) {
  const { root, project, env, mock, daemon, wrapper, runtimeDir } = fixture
  const serverLog: string[] = []
  const results: { stdout: string; stderr: string; exit: number | null }[] = []
  const pids: number[] = []
  let wireBeforeRoster: typeof mock.records = []
  let server: ReturnType<typeof Bun.spawn> | undefined
  let output: Promise<unknown> | undefined
  let url = ''
  const capture = async (
    stream: ReadableStream<Uint8Array>,
    onLine?: (line: string) => void,
  ) => {
    const decoder = new TextDecoder()
    let text = ''
    let pending = ''
    for await (const chunk of stream) {
      const decoded = decoder.decode(chunk, { stream: true })
      text += decoded
      pending += decoded
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        onLine?.(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    text += decoder.decode()
    if (pending) onLine?.(pending)
    return text
  }
  const stop = async () => {
    if (!server) return
    server.kill('SIGTERM')
    const timer = setTimeout(() => server?.kill('SIGKILL'), 15_000)
    await server.exited
    clearTimeout(timer)
    await output
    server = undefined
  }
  const start = async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    const child = Bun.spawn(
      [
        input.binary,
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
        '--print-logs',
      ],
      {
        cwd: project,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    server = child
    pids.push(child.pid)
    output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then((parts) => serverLog.push(...parts))
    await waitForHostReady(url, input.host, {
      authorization:
        input.host === 2
          ? `Basic ${btoa(`opencode:${env.OPENCODE_SERVER_PASSWORD}`)}`
          : undefined,
      checkRunning: () => {
        if (child.exitCode !== null)
          throw new Error(`host exited before listening: ${serverLog.join('')}`)
      },
    })
  }
  let error: unknown
  try {
    await start()
    for (const [index, turn] of input.turns.entries()) {
      if (turn.restart) {
        await stop()
        await start()
      }
      let cwd = project
      if (turn.otherLocation) {
        cwd = join(root, `project-${index}`)
        mkdirSync(cwd)
        spawnSync('git', ['init', '-q'], { cwd })
      }
      if (turn.reject) mock.reject('V', turn.reject)
      if (turn.rejectAgain) mock.reject('V', turn.rejectAgain)
      const child = Bun.spawn(
        [
          input.binary,
          'run',
          ...(input.host === 1
            ? ['--attach', url, '--dir', cwd]
            : ['--server', url]),
          '--format',
          'json',
          '--model',
          'openai/gpt-5.5',
          ...(index > 0 && !turn.restart && !turn.otherLocation
            ? ['--continue']
            : []),
          `Turn ${index + 1}: say hello.`,
        ],
        { cwd, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      if (input.delayedRoster && index === 0) {
        const deadline = Date.now() + 30_000
        while (!daemon?.lists) {
          if (Date.now() > deadline)
            throw new Error('vault never requested the delayed roster')
          await Bun.sleep(10)
        }
        // Keep the reply pending across the owned request, with no provider
        // warm-up or quota-readiness wait in the test controller.
        await Bun.sleep(100)
        wireBeforeRoster = [...mock.records]
        fixture.releaseRoster()
      }
      const [stdout, stderr] = await Promise.all([
        capture(child.stdout, (line) => {
          if (turn.reject !== 'cut-after-tool' || !line.startsWith('{')) return
          const event = JSON.parse(line)
          if (
            event.type === 'tool_use' &&
            event.part?.tool === 'read' &&
            event.part?.state?.status === 'completed' &&
            event.part.state.output?.includes('TOOL-SENTINEL')
          ) {
            mock.toolCompleted()
          }
        }),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      results.push({ stdout, stderr, exit: child.exitCode })
    }
  } catch (caught) {
    error = caught
  } finally {
    fixture.releaseRoster()
    await stop()
    await mock.stop()
    await daemon?.stop()
  }
  const trace = jsonLines(env.OPENAI_AUTH_E2E_POLICY_TRACE)
  const read = (path: string) =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const state = read(join(runtimeDir, 'openai-auth-state.json'))
  const pluginLog = existsSync(env.OPENCODE_OPENAI_AUTH_LOG_FILE)
    ? readFileSync(env.OPENCODE_OPENAI_AUTH_LOG_FILE, 'utf8')
    : ''
  const diagnostics = JSON.stringify(
    {
      error: error instanceof Error ? error.stack : error,
      results,
      trace,
      wire: mock.records,
      pluginLog: pluginLog.slice(-12_000),
      serverLog: serverLog.join('').slice(-12_000),
      state,
      cuts: mock.cuts,
    },
    null,
    2,
  )
  const limits = read(
    join(env.XDG_CONFIG_HOME, 'opencode', 'openai-auth.json'),
  ).commonAuthLimits
  const result = {
    results,
    trace,
    wire: [...mock.records],
    wireBeforeRoster,
    samples: [...mock.samples],
    cuts: [...mock.cuts],
    reports: daemon?.reports ?? [],
    pids,
    state,
    limits,
    pluginLog,
    diagnostics,
    error,
  }
  rmSync(wrapper, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  return result
}
