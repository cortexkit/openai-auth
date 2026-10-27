// openai-auth on the real OpenCode 2 host: runs `@opencode/cli` against a
// loopback mock of the Codex backend with two pool accounts, the plugin
// loaded from the packed package's `./server` entry, and checks what reached
// the wire and what landed in the pool. It runs only with
// OPENAI_AUTH_OPENCODE2_E2E=1 (its own CI job, after the build). The binary is
// supplied by the locked fixture's platform package, without lifecycle scripts.
// Install both hosts locally from the repository root with this one command:
// for host in opencode1 opencode2; do npm ci --ignore-scripts --prefix packages/opencode/src/tests/fixtures/$host-host || exit; done

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { vaultPaths, vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import {
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { POOL_PLACEHOLDER } from '../core/pool-migration'
import { CODEX_USER_AGENT, CODEX_VERSION } from '../index'
import { hostBinary, runtimeStateDir } from './fixtures/opencode-host'
import { controlPlaneProbe } from './fixtures/opencode2-control-plane'
import {
  MOCK_ACCOUNTS,
  type MockAccount,
  type MockCodex,
  type RejectMode,
  startMockCodex,
  type WireRecord,
  type WireSample,
} from './fixtures/opencode2-mock-codex'
import { installPackedPlugin, PACKAGE_NAME } from './fixtures/opencode2-pack'

const ENABLED = process.env.OPENAI_AUTH_OPENCODE2_E2E === '1'
export const OPENCODE_CLI_VERSION = '2.2.0'
const PLACEHOLDER = placeholderSecret('openai')
const PASSWORD = 'openai-auth-e2e-loopback-only'
const HOUR = 3600_000

type Transport = 'http' | 'websocket'
type Turn = {
  reject?: { account: MockAccount; mode: RejectMode }
  /** The model variant (reasoning effort) this turn is sent with. */
  variant?: string
}

let scratch = ''
let cli = ''
let serverPlugin = ''
let loginPlugin = ''
let vaultPlugin = ''
let upgradePlugin = ''
let packedConsumer = ''

/** The vault account's record version, which a 401 must be reported with. */
const VAULT_RECORD_VERSION = 7

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function isolatedEnv(root: string) {
  const dirs = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    TMPDIR: join(root, 'tmp'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return {
    PATH: process.env.PATH ?? '',
    ...dirs,
    // Anything that is not the loopback mock goes to a dead proxy, so a
    // misrouted request (a quota poll, a token refresh) fails instead of
    // reaching the internet.
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_OPENAI_AUTH_LOG_FILE: join(root, 'openai-auth.log'),
    OPENCODE_OPENAI_AUTH_LOG_LEVEL: 'debug',
  }
}

/** The pool in its migrated layout under the host's config directory. */
function seedPool(
  configDir: string,
  accounts: MockAccount[],
  mode: 'sticky-balanced' | 'fallback-first' = 'sticky-balanced',
) {
  mkdirSync(configDir, { recursive: true })
  const checkedAt = Date.now()
  const quota = (used: number) => ({
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent: used,
        resetsAt: new Date(checkedAt + 2 * HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
  })
  // Row ids: A is `main`, the others are named by their account id. A starts
  // with the most room so sticky placement puts a session there.
  const rowId = (account: MockAccount) => (account === 'A' ? 'main' : account)
  writeFileSync(
    join(configDir, 'openai-auth.json'),
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode },
      accounts: accounts.map((account) => ({
        id: rowId(account),
        type: 'oauth',
        label: account,
        enabled: true,
        accountId: MOCK_ACCOUNTS[account].id,
        addedAt: 1,
      })),
      commonAuthPool: {
        schemaVersion: 1,
        rows: Object.fromEntries(
          accounts.map((account) => [
            rowId(account),
            {
              credentialEpoch: 1,
              needsFirstReading: false,
              quota: quota(account === 'A' ? 5 : 40),
            },
          ]),
        ),
      },
      openaiAuthPool: { migratedAt: Date.now() - 60_000 },
    }),
  )
  writeFileSync(
    join(configDir, 'openai-auth-state.json'),
    JSON.stringify({
      version: 1,
      accounts: Object.fromEntries(
        accounts.map((account) => [
          rowId(account),
          {
            access: MOCK_ACCOUNTS[account].token,
            refresh: `refresh-${account}`,
            expires: Date.now() + 24 * HOUR,
          },
        ]),
      ),
    }),
  )
}

// The host serves its web shell at `/` with 200 before its background service
// is ready, and answers every other route 503 service_starting until then. Only
// the authenticated `/api/info` reports readiness: 200 ready, 503 still
// starting or stopping, 500 failed (@opencode/cli 2.0.22, server process).
async function waitForServer(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 60_000
  const authorization = `Basic ${btoa(`opencode:${PASSWORD}`)}`
  let last = 'no response'
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`host exited early with ${child.exitCode}`)
    try {
      const response = await fetch(`${url}/api/info`, {
        headers: { authorization },
        signal: AbortSignal.timeout(1000),
      })
      await response.body?.cancel()
      if (response.status === 200) return
      if (response.status !== 503)
        throw new Error(`host readiness answered ${response.status}`)
      last = 'service starting'
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('host readiness'))
        throw error
      last = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`host at ${url} did not become ready (${last})`)
}

async function collect(
  stream: ReadableStream<Uint8Array> | null | undefined,
  into: string[],
) {
  if (!stream) return
  const decoder = new TextDecoder()
  for await (const chunk of stream)
    into.push(decoder.decode(chunk, { stream: true }))
}

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const child = Bun.spawn([cli, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out: string[] = []
  const err: string[] = []
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  await Promise.all([
    collect(child.stdout, out),
    collect(child.stderr, err),
    child.exited,
  ])
  clearTimeout(timer)
  return { exit: child.exitCode, stdout: out.join(''), stderr: err.join('') }
}

interface ScenarioResult {
  readonly destinations: string[]
  readonly wire: WireRecord[]
  /** Agent-loop requests and frames as sent, with their headers. */
  readonly samples: WireSample[]
  /** What the mock vault was told: one entry per 401 report. */
  readonly vaultReports: MockDaemon['reports']
  readonly stdout: string[]
  readonly retries: unknown[]
  readonly exits: Array<number | null>
  readonly config: {
    accounts: Array<{ id: string; accountId?: string }>
    commonAuthPool: {
      rows: Record<
        string,
        { quota?: { limits?: Array<{ usedPercent?: number }> } }
      >
    }
  }
  readonly state: { accounts: Record<string, { refresh?: string }> }
  readonly exported: string
  /**
   * Where the runtime files ended up: the state folder's layout marker, the
   * bytes of the seeded vault enrollment and sessions file at their new
   * paths, and the runtime files still in OpenCode's config folder.
   */
  readonly runtime: {
    marker: Record<string, unknown>
    moved: Record<string, string | null>
    leftInConfig: string[]
  }
  readonly diagnostics: string
}

/** The vault enrollment `seedPool`'s vault scenarios add to the old layout. */
const OLD_VAULT_TOKEN = 'openai-auth-vault/opencode-enrollment.json'
/** A saved Codex session where versions before the move kept it. */
const OLD_SESSIONS = 'openai-auth-sessions-opencode2.json'
const OLD_SESSIONS_TEXT = `${JSON.stringify({ version: 1, sessions: { ses_old: { threadID: 'thread-before-the-move' } } })}\n`

async function runScenario(input: {
  transport: Transport
  upgrade?: 'default' | 'custom'
  accounts: MockAccount[]
  turns: Turn[]
  plugin?: string
  login?: boolean | 'vault'
  /** The API key the host prepares instead of the account pool's placeholder bearer. */
  apiKey?: string
  /** Omit the pool bearer to show that importing legacy auth.json does not activate pool routing. */
  preparePoolCredential?: boolean
  mode?: 'sticky-balanced' | 'fallback-first'
  /** The model every turn uses; `gpt-5.5` by default. */
  model?: string
  /** Serve account V from a mock Claustrum vault this host is enrolled in. */
  vault?: boolean
}): Promise<ScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), 'oai-oc2-e2e-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: project })
  const mock: MockCodex = startMockCodex([PLACEHOLDER])
  const isolated = isolatedEnv(root)
  const env: Record<string, string> = {
    ...isolated,
    // Read by the vault plugin entry, which sends its quota polls to the mock.
    OPENAI_AUTH_E2E_MOCK_URL: mock.url,
    OPENAI_AUTH_E2E_RETRIES: join(root, 'retries.jsonl'),
  }
  const configDir = join(isolated.XDG_CONFIG_HOME, 'opencode')
  // The pool is seeded where versions before the move kept it; the plugin
  // moves its runtime files into the state home at its first start.
  seedPool(configDir, input.accounts, input.mode)
  const runtimeDir = runtimeStateDir(isolated.XDG_STATE_HOME, configDir)
  if (input.upgrade) {
    const dataDir = join(isolated.XDG_DATA_HOME, 'opencode')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'auth.json'),
      JSON.stringify({ openai: POOL_PLACEHOLDER }),
    )
    env.OPENAI_AUTH_E2E_DESTINATIONS = join(root, 'destinations.jsonl')
  }
  let daemon: MockDaemon | undefined
  if (input.vault) {
    daemon = await startMockDaemon({
      directory: root,
      credentials: {
        'oauth:openai:work': vaultLogin(MOCK_ACCOUNTS.V.id, {
          record_version: VAULT_RECORD_VERSION,
        }),
      },
    })
    env.OPENAI_AUTH_E2E_CLAUSTRUM = daemon.connectionFile
    // An approved enrollment, as Connect in `opencode auth login` leaves it.
    const paths = vaultPaths(
      vaultStateDir(join(configDir, 'openai-auth-state.json')),
      'opencode',
    )
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(
      paths.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    writeFileSync(join(configDir, OLD_SESSIONS), OLD_SESSIONS_TEXT, {
      mode: 0o600,
    })
  }
  const model = input.model ?? 'gpt-5.5'
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify(
      {
        plugins: [
          input.upgrade ? upgradePlugin : (input.plugin ?? serverPlugin),
        ],
        providers: {
          openai: {
            settings: {
              // Prepare exactly the credential selected for this scenario.
              // An old auth.json alone must not activate pool routing.
              ...(input.preparePoolCredential === false
                ? {}
                : { apiKey: input.apiKey ?? PLACEHOLDER }),
              ...(input.upgrade === 'default'
                ? {}
                : { baseURL: `${mock.url}/v1` }),
              transport: input.transport,
            },
            models: {
              'gpt-5.5': { name: 'GPT-5.5 (mock)' },
              'gpt-6-sol': { name: 'GPT-6 Sol (mock)' },
              'gpt-6.1-sol': { name: 'GPT-6.1 Sol (mock)' },
              'gpt-6.1-terra': { name: 'GPT-6.1 Terra (mock)' },
            },
          },
        },
      },
      null,
      2,
    ),
  )

  const port = await freePort()
  const serverURL = `http://127.0.0.1:${port}`
  const serverLog: string[] = []
  const server = Bun.spawn(
    [
      cli,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'info',
    ],
    { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
  )
  const serverOutput = Promise.all([
    collect(server.stdout, serverLog),
    collect(server.stderr, serverLog),
  ])
  const stdout: string[] = []
  const clientLog: string[] = []
  const exits: Array<number | null> = []
  let exported = ''
  try {
    await waitForServer(serverURL, server)
    if (input.login) {
      const login = await runCli(
        [
          'auth',
          'login',
          'openai',
          '--server',
          serverURL,
          '--method',
          input.login === 'vault'
            ? 'openai-auth-vault'
            : 'openai-auth-pool-browser',
        ],
        project,
        env,
      )
      exits.push(login.exit)
      clientLog.push(`--- login ---\n${login.stdout}\n${login.stderr}`)
      const dump = await runCli(
        ['auth', 'export', '--server', serverURL],
        project,
        env,
      )
      exported = dump.stdout
      clientLog.push(`--- export ---\n${dump.stdout}\n${dump.stderr}`)
    }
    for (const [index, turn] of input.turns.entries()) {
      if (turn.reject) mock.reject(turn.reject.account, turn.reject.mode)
      const args = [
        'run',
        '--server',
        serverURL,
        '--format',
        'json',
        '--model',
        `openai/${model}${turn.variant ? `#${turn.variant}` : ''}`,
        ...(index > 0 ? ['--continue'] : []),
        `Turn ${index + 1}: say hello.`,
      ]
      const result = await runCli(args, project, env)
      exits.push(result.exit)
      stdout.push(result.stdout)
      clientLog.push(`--- turn ${index + 1} stderr ---\n${result.stderr}`)
    }
  } finally {
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 15_000)
    await server.exited
    clearTimeout(timer)
    await serverOutput
    await mock.stop()
    await daemon?.stop()
  }
  const read = (path: string) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return {}
    }
  }
  const config = read(join(configDir, 'openai-auth.json'))
  const state = read(join(runtimeDir, 'openai-auth-state.json'))
  const readText = (path: string) =>
    existsSync(path) ? readFileSync(path, 'utf8') : null
  const runtime = {
    marker: read(join(runtimeDir, 'layout.json')),
    moved: Object.fromEntries(
      [OLD_VAULT_TOKEN, OLD_SESSIONS].map((relative) => [
        relative,
        readText(join(runtimeDir, relative)),
      ]),
    ),
    leftInConfig: [
      'openai-auth-state.json',
      'openai-auth-vault',
      'openai-auth-sessions.json',
      OLD_SESSIONS,
    ].filter((name) => existsSync(join(configDir, name))),
  }
  let pluginLog = ''
  try {
    pluginLog = readFileSync(isolated.OPENCODE_OPENAI_AUTH_LOG_FILE, 'utf8')
  } catch {}
  const destinations =
    input.upgrade && existsSync(env.OPENAI_AUTH_E2E_DESTINATIONS!)
      ? readFileSync(env.OPENAI_AUTH_E2E_DESTINATIONS!, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string)
      : []
  const retries = existsSync(env.OPENAI_AUTH_E2E_RETRIES!)
    ? readFileSync(env.OPENAI_AUTH_E2E_RETRIES!, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  const diagnostics = [
    `exported credential: ${exported}`,
    `destinations: ${JSON.stringify(destinations)}`,
    `runtime files: ${JSON.stringify(runtime)}`,
    `vault reports: ${JSON.stringify(daemon?.reports ?? [])}`,
    `wire: ${JSON.stringify(mock.records)}`,
    `samples: ${JSON.stringify(mock.samples)}`,
    `stdout: ${JSON.stringify(stdout)}`,
    `retries: ${JSON.stringify(retries)}`,
    ...clientLog,
    `--- plugin log (tail) ---\n${pluginLog.slice(-6000)}`,
    `--- host log (tail) ---\n${serverLog.join('').slice(-6000)}`,
  ].join('\n')
  rmSync(root, { recursive: true, force: true })
  return {
    destinations,
    wire: [...mock.records],
    samples: [...mock.samples],
    vaultReports: [...(daemon?.reports ?? [])],
    stdout,
    retries,
    exits,
    config,
    state,
    exported,
    runtime,
    diagnostics,
  }
}

/** Runs the assertions and prints the scenario's evidence when one fails. */
function verify(result: ScenarioResult, assertions: () => void) {
  // OPENAI_AUTH_OPENCODE2_E2E_VERBOSE=1 prints the evidence of passing runs too.
  if (process.env.OPENAI_AUTH_OPENCODE2_E2E_VERBOSE === '1')
    console.error(result.diagnostics)
  try {
    assertions()
  } catch (error) {
    console.error(result.diagnostics)
    throw error
  }
}

/** Agent-loop requests: HTTP requests with tools, WebSocket frames. */
const primaries = (wire: WireRecord[]) =>
  wire.filter((record) =>
    record.transport === 'http'
      ? record.action === 'request' && record.kind === 'primary'
      : record.action === 'frame',
  )
const pick = (entries: readonly object[], ...keys: string[]) =>
  entries.map((entry) =>
    keys.map((key) => (entry as Record<string, unknown>)[key] ?? '').join(':'),
  )
/** The agent-loop samples of one transport, in order. */
const samplesOn = (result: ScenarioResult, transport: 'http' | 'ws') =>
  result.samples.filter((sample) => sample.transport === transport)
type SentBody = {
  previous_response_id?: string
  reasoning?: { effort?: string }
  input: Array<{ type?: string; role?: string; reasoning?: unknown }>
}
const bodyOf = (sample: WireSample | undefined) =>
  (sample?.body ?? { input: [] }) as SentBody
const EFFORT_UPDATE_HIGH = {
  type: 'configuration_update',
  reasoning: { effort: 'high' },
}

/** The Codex client identity, as OpenCode 1 sends it. */
function expectCodexClient(headers: Record<string, string>) {
  expect(headers.version).toBe(CODEX_VERSION)
  expect(headers['user-agent']).toBe(CODEX_USER_AGENT)
  expect(headers.originator).toBe('codex_exec')
  expect(headers['session-id']).toBeTruthy()
}

const usedOn = (result: ScenarioResult, row: string) =>
  result.config.commonAuthPool?.rows?.[row]?.quota?.limits?.find(
    (limit) => limit.usedPercent !== undefined,
  )?.usedPercent

/**
 * Holds for every scenario: every request on the wire carried a pool
 * account's bearer with that account's `chatgpt-account-id`, and none
 * carried the host's placeholder.
 */
function expectOnlyPoolAccountsOnWire(result: ScenarioResult) {
  expect(result.wire.length).toBeGreaterThan(0)
  expect(result.wire.filter((record) => record.forbiddenSeen)).toEqual([])
  expect(result.wire.filter((record) => record.identity === 'none')).toEqual([])
  for (const record of result.wire) {
    if (record.identity === 'none') continue
    expect(record.accountHeader).toBe(MOCK_ACCOUNTS[record.identity].id)
  }
}

describe.skipIf(!ENABLED)('openai-auth on OpenCode 2 (real host)', () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'oai-oc2-cli-'))
    cli = hostBinary(2)
    const version = spawnSync(cli, ['--version'], {
      encoding: 'utf8',
    }).stdout.trim()
    if (!version.includes(OPENCODE_CLI_VERSION))
      throw new Error(
        `expected @opencode/cli ${OPENCODE_CLI_VERSION}, found "${version}"`,
      )
    // The plugin as a consumer gets it: the packed package, imported through
    // its `./server` export.
    const { consumer } = installPackedPlugin(join(scratch, 'pack'))
    packedConsumer = consumer
    serverPlugin = join(consumer, 'server-plugin')
    mkdirSync(serverPlugin, { recursive: true })
    writeFileSync(
      join(serverPlugin, 'index.js'),
      [
        `import plugin from '${PACKAGE_NAME}/server'`,
        "import { appendFileSync } from 'node:fs'",
        'export default { ...plugin, async setup(ctx) {',
        '  const dispose = await plugin.setup(ctx)',
        "  const retry = await ctx.session.hook('retry', (draft) => {",
        '    appendFileSync(process.env.OPENAI_AUTH_E2E_RETRIES, JSON.stringify(draft.error) + "\\n")',
        "  }, { providerID: 'openai' })",
        '  return async () => { await retry.dispose(); await dispose?.() }',
        '} }',
        '',
      ].join('\n'),
    )
    // Observe the destination chosen by the real driver before redirecting
    // Codex traffic to loopback. Platform traffic is recorded and refused.
    upgradePlugin = join(consumer, 'upgrade-plugin')
    mkdirSync(upgradePlugin, { recursive: true })
    writeFileSync(
      join(upgradePlugin, 'index.js'),
      [
        `import plugin from '${PACKAGE_NAME}/server'`,
        "import { appendFileSync } from 'node:fs'",
        'export default { ...plugin, async setup(ctx) {',
        '  const dispose = await plugin.setup(ctx)',
        "  const wire = await ctx.session.hook('http.request', (draft) => {",
        '    const url = new URL(draft.request.url)',
        '    appendFileSync(process.env.OPENAI_AUTH_E2E_DESTINATIONS, JSON.stringify(url.href) + "\\n")',
        "    if (url.origin === 'https://api.openai.com') throw new Error('platform API request refused by mock')",
        "    if (url.origin === 'https://chatgpt.com') {",
        "      if (!url.pathname.startsWith('/backend-api/codex/')) throw new Error('not a Codex path')",
        '      draft.request = new Request(process.env.OPENAI_AUTH_E2E_MOCK_URL + url.pathname + url.search, draft.request)',
        '    }',
        "  }, { providerID: 'openai' })",
        '  return async () => { await wire.dispose(); await dispose?.() }',
        '} }',
        '',
      ].join('\n'),
    )
    // The same entry with its ChatGPT login replaced by one that completes at
    // once as account C: the real OAuth flow needs auth.openai.com.
    const c = MOCK_ACCOUNTS.C
    loginPlugin = join(consumer, 'login-plugin')
    mkdirSync(loginPlugin, { recursive: true })
    writeFileSync(
      join(loginPlugin, 'index.js'),
      [
        `import { createOpenAIAuthPlugin } from '${PACKAGE_NAME}/server'`,
        'export default createOpenAIAuthPlugin({',
        '  beginLogin: async () => ({',
        "    url: 'http://127.0.0.1:9/authorize',",
        "    instructions: 'mock login',",
        '    completion: Promise.resolve({',
        `      id: '${c.id}', type: 'oauth', enabled: true, addedAt: 0, lastUsed: 0,`,
        `      access: '${c.token}', refresh: 'refresh-C',`,
        `      expires: Date.now() + 86400000, accountId: '${c.id}',`,
        '    }),',
        '  }),',
        '})',
        '',
      ].join('\n'),
    )
    // The same entry with its quota polls sent to the scenario's mock and its
    // vault pointed at the scenario's mock Claustrum daemon.
    vaultPlugin = join(consumer, 'vault-plugin')
    mkdirSync(vaultPlugin, { recursive: true })
    writeFileSync(
      join(vaultPlugin, 'index.js'),
      [
        `import { createOpenAIAuthPlugin } from '${PACKAGE_NAME}/server'`,
        'const mock = process.env.OPENAI_AUTH_E2E_MOCK_URL',
        'export default createOpenAIAuthPlugin({',
        '  fetch: (input, init) => fetch(',
        '    String(input instanceof Request ? input.url : input).replace(',
        "      'https://chatgpt.com', mock),",
        '    init,',
        '  ),',
        '  vault: {',
        '    connectionFile: () => process.env.OPENAI_AUTH_E2E_CLAUSTRUM,',
        '    pollIntervalMs: 0,',
        '  },',
        '})',
        '',
      ].join('\n'),
    )
  }, 300_000)

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  /**
   * Runs the control-plane probe and checks the packed command, dialog and
   * sidebar. With `hostResetup`, the host also reloads the TUI plugin before
   * phase 4, as OpenCode sometimes does by itself after a location reload.
   */
  async function proveControlPlane(hostResetup: boolean) {
    const root = join(
      scratch,
      hostResetup ? 'control-plane-host-resetup' : 'control-plane',
    )
    mkdirSync(root)
    const env = isolatedEnv(root)
    seedPool(join(env.XDG_CONFIG_HOME, 'opencode'), ['A', 'B'])
    const result = await controlPlaneProbe({
      cli,
      consumer: packedConsumer,
      root,
      env,
      hostResetup,
    })
    expect(result.trace).toContain('"server"')
    expect(result.trace).not.toContain('"failure"')
    expect(result.trace).toContain('"event":"done"')
    expect(result.trace).toContain('"event":"fresh-session-command"')
    const events = result.trace
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const rows = (event: string) =>
      events.filter((entry) => entry.event === event)
    // Require visible server-published quotas and a component render event;
    // registering a slot or rendering placeholder text alone is not enough.
    // Visible text is read from the rendered screen: the renderer repaints
    // only changed cells, so the raw bytes may never hold a phrase whole.
    const outcome =
      result.screen.includes('95% left') &&
      result.screen.includes('60% left') &&
      rows('render').length > 0
        ? 'a'
        : 'c'
    expect(outcome).toBe('a')
    expect(result.output).not.toContain('OpenAI P0 sidebar component')
    expect(result.screen).not.toContain('OpenAI P0 sidebar component')
    expect(rows('commands').map((row) => row.count)).toEqual([1, 1, 1, 1])
    expect(rows('location-count').map((row) => [row.stage, row.count])).toEqual(
      [
        ['both-set-up', 1],
        ['both-set-up', 1],
        ['location-reloaded', 1],
        ['location-reloaded', 1],
      ],
    )
    expect(rows('server').length).toBeGreaterThanOrEqual(3)
    // OpenCode may dispose the TUI plugin and run its setup again after a
    // location reload, so the number of mounts varies from run to run. Each
    // mount is released before the next one, and the last one stays mounted.
    const slots = rows('slot').map((row) => row.slots)
    expect(slots.length).toBeGreaterThanOrEqual(3)
    expect(slots).toEqual(slots.map((_, index) => (index % 2 === 0 ? 1 : 0)))
    const mounts = rows('slot').filter((row) => row.slots === 1)
    expect(mounts.map((row) => [row.anchor, row.numericOrder])).toEqual(
      mounts.map(() => ['sidebar.content', false]),
    )
    const done = rows('done')[0]
    const setups = rows('tui').length
    console.log(`P0: the host ran the TUI plugin's setup ${setups} time(s)`)
    expect(done.setups).toBe(setups)
    // However often the host set the plugin up, exactly one mount is live at
    // the end: one sidebar slot and one RPC poll loop, both from the newest
    // mount, and phase 4's dialog was opened by that mount.
    expect(done.slots).toBe(1)
    expect(done.polls).toEqual([done.generation])
    expect(rows('dialog').at(-1)?.generation).toBe(done.generation)
    // Neither the terminal output nor the rendered screen shows a TypeError
    // or any text about an unhandled error or rejection.
    for (const text of [result.output, result.screen]) {
      expect(text).not.toContain('TypeError')
      expect(text).not.toMatch(/unhandled/i)
      expect(text).not.toContain('Plugin cortexkit.openai-auth crashed')
    }
    expect(rows('dialog').map((row) => [row.phase, row.dialogs])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ])
    for (let phase = 1; phase <= 4; phase++)
      expect(result.screen).toContain(`OpenAI P0 connection ${phase}`)
    const sessions = rows('sessions')[0]
    expect([...new Set(rows('render').map((row) => row.sessionId))]).toEqual([
      sessions.a,
      sessions.b,
      sessions.c,
    ])
    expect(rows('apply').map((row) => row.request.sessionId)).toEqual([
      sessions.a,
      sessions.b,
      sessions.c,
      sessions.c,
    ])
    // OpenCode may report a location by its resolved path (on macOS the temp
    // folder /var is a link to /private/var), so compare resolved paths.
    expect(rows('apply').map((row) => realpathSync(row.directory))).toEqual([
      realpathSync(join(root, 'project')),
      realpathSync(join(root, 'project')),
      realpathSync(join(root, 'other-project')),
      realpathSync(join(root, 'other-project')),
    ])
    expect(
      rows('result').map((row) => [
        row.result.ok,
        row.result.text,
        row.slots,
        row.dialogs,
      ]),
    ).toEqual(
      Array.from({ length: 4 }, () => [false, 'P0: nothing was changed', 1, 0]),
    )
    const theme = rows('theme')[0]
    expect(theme.before).not.toBe(theme.after)
    const reloaded = events.findIndex((row) => row.event === 'reload')
    expect(rows('tick').some((row) => row.generation === 1)).toBe(true)
    expect(
      events
        .slice(reloaded + 1)
        .filter((row) => row.event === 'tick')
        .map((row) => row.generation),
    ).not.toContain(1)
    expect(
      events
        .slice(reloaded + 1)
        .some((row) => row.event === 'tick' && row.generation > 1),
    ).toBe(true)
    if (hostResetup) {
      expect(setups).toBeGreaterThanOrEqual(2)
      expect(rows('host-dispose').length).toBeGreaterThanOrEqual(1)
    }
  }

  test(
    'P0: packed command, dialog and sidebar mount on the locked host',
    () => proveControlPlane(false),
    60_000,
  )

  test(
    'P0: after the host sets the TUI plugin up again, one mount stays live and the dialog still works',
    () => proveControlPlane(true),
    60_000,
  )

  test('http: a prepared API key bypasses a migrated pool without attribution', async () => {
    const key = 'sk-opencode2-user-key'
    const result = await runScenario({
      transport: 'http',
      accounts: ['A', 'B'],
      apiKey: key,
      turns: [{}],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expect(result.stdout.join('')).toContain('MOCK-HTTP-REPLY')
      const sent = samplesOn(result, 'http')
      expect(sent.length).toBe(1)
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${key}`)
      expect(sent[0]?.headers['chatgpt-account-id']).toBeUndefined()
      expect(sent[0]?.headers.originator).toBeUndefined()
      expect(
        primaries(result.wire).every((record) => record.identity === 'none'),
      ).toBe(true)
      expect(usedOn(result, 'main')).toBe(5)
      expect(usedOn(result, 'B')).toBe(40)
      expect(result.state.accounts.main?.refresh).toBe('refresh-A')
      expect(result.state.accounts.B?.refresh).toBe('refresh-B')
    })
  }, 180_000)

  test('a selected pool placeholder after OpenCode 1 upgrade reaches Codex without a provider baseURL', async () => {
    const result = await runScenario({
      transport: 'http',
      upgrade: 'default',
      accounts: ['A'],
      turns: [{}],
    })
    verify(result, () => {
      expect(result.destinations.length).toBeGreaterThan(0)
      expect(
        result.destinations.every((url) =>
          url.startsWith('https://chatgpt.com/backend-api/codex/'),
        ),
      ).toBe(true)
      expect(result.exits).toEqual([0])
      expect(result.stdout.join('')).toContain('MOCK-HTTP-REPLY')
      expectOnlyPoolAccountsOnWire(result)
    })
  }, 180_000)

  test('an imported OpenCode 1 placeholder alone does not activate pool routing', async () => {
    const result = await runScenario({
      transport: 'http',
      upgrade: 'custom',
      accounts: ['A'],
      preparePoolCredential: false,
      turns: [{}],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0])
      const sent = samplesOn(result, 'http')
      expect(sent.length).toBe(1)
      expect(sent[0]?.headers['chatgpt-account-id']).toBeUndefined()
      expect(sent[0]?.headers.originator).toBeUndefined()
      expect(
        primaries(result.wire).every((record) => record.identity === 'none'),
      ).toBe(true)
      expect(usedOn(result, 'main')).toBe(5)
    })
  }, 180_000)

  test('a selected pool placeholder after OpenCode 1 upgrade keeps a custom provider baseURL', async () => {
    const result = await runScenario({
      transport: 'http',
      upgrade: 'custom',
      accounts: ['A'],
      turns: [{}],
    })
    verify(result, () => {
      expect(result.destinations.length).toBeGreaterThan(0)
      expect(
        result.destinations.every((url) =>
          /^http:\/\/127\.0\.0\.1:\d+\/v1\//.test(url),
        ),
      ).toBe(true)
      expect(result.exits).toEqual([0])
      expect(result.stdout.join('')).toContain('MOCK-HTTP-REPLY')
      expectOnlyPoolAccountsOnWire(result)
    })
  }, 180_000)

  test('http: a sticky session stays on its account, and its quota lands on that row', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A', 'B'],
      turns: [{}, {}],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      expectOnlyPoolAccountsOnWire(result)
      expect(pick(primaries(result.wire), 'transport', 'identity')).toEqual([
        'http:A',
        'http:A',
      ])
      expect(result.stdout[1]).toContain('-A')
      expect(usedOn(result, 'main')).toBe(MOCK_ACCOUNTS.A.used)
      expect(usedOn(result, 'B')).toBe(40)
    })
  }, 180_000)

  test('websocket: the handshake carries the account, and frame quota lands on its row', async () => {
    const result = await runScenario({
      transport: 'websocket',
      accounts: ['A', 'B'],
      turns: [{}, {}],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      expectOnlyPoolAccountsOnWire(result)
      const handshakes = result.wire.filter(
        (record) => record.action === 'handshake',
      )
      expect(handshakes.length).toBeGreaterThan(0)
      expect(new Set(pick(handshakes, 'identity'))).toEqual(new Set(['A']))
      expect(pick(primaries(result.wire), 'transport', 'identity')).toEqual([
        'ws:A',
        'ws:A',
      ])
      expect(usedOn(result, 'main')).toBe(MOCK_ACCOUNTS.A.used)
    })
  }, 180_000)

  test('websocket: a usage-limit refusal before output moves the turn to the other account', async () => {
    const result = await runScenario({
      transport: 'websocket',
      accounts: ['A', 'B'],
      turns: [{ reject: { account: 'A', mode: 'usage-limit' } }],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expectOnlyPoolAccountsOnWire(result)
      expect(pick(primaries(result.wire), 'identity', 'rejected')).toEqual([
        'A:usage-limit',
        'B:',
      ])
      expect(result.stdout[0]).toContain('-B')
      expect(result.stdout[0]).not.toContain('-A')
      expect(usedOn(result, 'B')).toBe(MOCK_ACCOUNTS.B.used)
    })
  }, 180_000)

  test('http: a usage-limit refusal before output moves the turn to the other account', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A', 'B'],
      turns: [{ reject: { account: 'A', mode: 'usage-limit' } }],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expectOnlyPoolAccountsOnWire(result)
      expect(pick(primaries(result.wire), 'identity', 'rejected')).toEqual([
        'A:usage-limit',
        'B:',
      ])
      expect(result.stdout[0]).toContain('-B')
    })
  }, 180_000)

  for (const mode of [
    'stream-error-missing-type',
    'stream-error-plain-type',
  ] as const) {
    test(`http: parses ${mode} as a streamed provider error`, async () => {
      const result = await runScenario({
        transport: 'http',
        accounts: ['A'],
        turns: [{ reject: { account: 'A', mode } }],
      })
      verify(result, () => {
        expect(
          primaries(result.wire).some((record) => record.rejected === mode),
        ).toBe(true)
        expect(JSON.stringify(result.retries)).toContain('Stream refused key')
        expect(JSON.stringify(result.retries)).toContain(
          'Stream refused key [credential]; [credential]',
        )
        expect(JSON.stringify(result.retries)).not.toContain(
          MOCK_ACCOUNTS.A.token,
        )
        expect(JSON.stringify(result.retries)).not.toContain(
          MOCK_ACCOUNTS.V.token,
        )
      })
    }, 180_000)
  }

  test('http: every request carries the Codex client identity', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A'],
      turns: [{}, {}],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      const sent = samplesOn(result, 'http')
      expect(sent.length).toBe(2)
      for (const sample of sent) expectCodexClient(sample.headers)
    })
  }, 180_000)

  test('websocket: the handshake carries the Codex client identity and one socket serves every turn', async () => {
    const result = await runScenario({
      transport: 'websocket',
      accounts: ['A'],
      turns: [{}, {}, {}],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0, 0])
      const handshakes = result.wire.filter(
        (record) => record.action === 'handshake',
      )
      expect(handshakes.length).toBe(1)
      const frames = primaries(result.wire)
      expect(pick(frames, 'connection')).toEqual(['1', '1', '1'])
      // Each sample carries the handshake headers of its socket.
      for (const sample of samplesOn(result, 'ws'))
        expectCodexClient(sample.headers)
      // Turns after the first chain on the reused socket.
      const bodies = samplesOn(result, 'ws').map(bodyOf)
      expect(
        bodies.map((body) => body.previous_response_id !== undefined),
      ).toEqual([false, true, true])
    })
  }, 180_000)

  for (const transport of ['http', 'websocket'] as const) {
    test(`${transport}: Terra inherits Sol's xhigh variant on the wire`, async () => {
      const result = await runScenario({
        transport,
        accounts: ['A'],
        model: 'gpt-6.1-terra',
        turns: [{ variant: 'low' }, { variant: 'xhigh' }],
      })
      verify(result, () => {
        expect(result.exits).toEqual([0, 0])
        const bodies = samplesOn(
          result,
          transport === 'websocket' ? 'ws' : 'http',
        ).map(bodyOf)
        expect(bodies).toHaveLength(2)
        expect(bodies[0]?.reasoning?.effort).toBe('low')
        expect(bodies[1]?.reasoning?.effort).toBe('low')
        expect(
          bodies[1]?.input.filter(
            (item: Record<string, unknown>) =>
              item.type === 'configuration_update',
          ),
        ).toEqual([
          { type: 'configuration_update', reasoning: { effort: 'xhigh' } },
        ])
        expect(bodies[1]?.input.at(-1)?.role).toBe('user')
      })
    }, 240_000)
  }

  test('websocket: an effort change goes in as an update item, the effort stays pinned, and the turns after it chain on the same socket', async () => {
    const result = await runScenario({
      transport: 'websocket',
      accounts: ['A'],
      model: 'gpt-6.1-sol',
      turns: [
        { variant: 'low' },
        { variant: 'low' },
        { variant: 'high' },
        { variant: 'high' },
      ],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0, 0, 0])
      expect(
        result.wire.filter((record) => record.action === 'handshake').length,
      ).toBe(1)
      expect(pick(primaries(result.wire), 'connection')).toEqual([
        '1',
        '1',
        '1',
        '1',
      ])
      const [first, second, change, after] = samplesOn(result, 'ws').map(bodyOf)
      for (const body of [first, second, change, after])
        expect(body?.reasoning?.effort).toBe('low')
      // OpenCode 2.0.22 carries this model's effort change itself: the turn
      // whose effort changed stays chained and carries one update right
      // before the new user message, and nothing else.
      expect(second?.previous_response_id).toBeDefined()
      expect(change?.previous_response_id).toBeDefined()
      expect(change?.input).toHaveLength(2)
      expect(change?.input[0]).toEqual(EFFORT_UPDATE_HIGH)
      expect(change?.input[1]?.role).toBe('user')
      // The update is in the server's history now, so the next turn is just
      // the new user message on the same chain.
      expect(after?.previous_response_id).toBeDefined()
      expect(after?.input).toHaveLength(1)
      expect(after?.input[0]?.role).toBe('user')
    })
  }, 240_000)

  test('http: an effort change goes in as an update item before the new user message, the effort stays pinned', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A'],
      model: 'gpt-6.1-sol',
      turns: [{ variant: 'low' }, { variant: 'high' }],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      const [first, change] = samplesOn(result, 'http').map(bodyOf)
      expect(first?.reasoning?.effort).toBe('low')
      expect(change?.reasoning?.effort).toBe('low')
      const input = change?.input ?? []
      expect(input.at(-2)).toEqual(EFFORT_UPDATE_HIGH)
      expect(input.at(-1)?.role).toBe('user')
      expectCodexClient(samplesOn(result, 'http')[1]?.headers ?? {})
    })
  }, 180_000)

  test('http: on a model whose effort change the host carries itself, the rewrite adds no second update', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A'],
      model: 'gpt-6-sol',
      turns: [{ variant: 'low' }, { variant: 'high' }],
    })
    verify(result, () => {
      expect(result.exits).toEqual([0, 0])
      const [, change] = samplesOn(result, 'http').map(bodyOf)
      expect(change?.reasoning?.effort).toBe('low')
      expect(
        (change?.input ?? []).filter(
          (item) => item.type === 'configuration_update',
        ),
      ).toEqual([EFFORT_UPDATE_HIGH])
    })
  }, 180_000)

  test('http: the old runtime files move to the state home, then a vault account is served with the token the vault hands out, and a 401 is reported with its record version', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A'],
      mode: 'fallback-first',
      plugin: vaultPlugin,
      vault: true,
      turns: [{}, {}, { reject: { account: 'V', mode: 'unauthorized' } }],
    })
    verify(result, () => {
      // The server's start moved the state file, the vault enrollment and the
      // sessions file out of OpenCode's config folder; vault mode survived it.
      expect(result.runtime.marker).toMatchObject({
        version: 1,
        oldFilesRemoved: true,
      })
      expect(result.runtime.leftInConfig).toEqual([])
      expect(result.runtime.moved[OLD_VAULT_TOKEN]).toBe(
        JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      )
      expect(
        JSON.parse(result.runtime.moved[OLD_SESSIONS] ?? '{}').sessions
          ?.ses_old,
      ).toEqual({ threadID: 'thread-before-the-move' })
      expect(result.state.accounts.main?.refresh).toBe('refresh-A')
      expect(result.exits.slice(0, 2)).toEqual([0, 0])
      expectOnlyPoolAccountsOnWire(result)
      const served = pick(primaries(result.wire), 'identity', 'rejected')
      expect(served).toEqual(['V:', 'V:', 'V:unauthorized'])
      expect(result.stdout[1]).toContain('-V')
      expect(result.vaultReports).toEqual([
        expect.objectContaining({
          credential_id: 'oauth:openai:work',
          provider_status: 401,
          record_version: VAULT_RECORD_VERSION,
        }),
      ])
    })
  }, 180_000)

  test('a login through the plugin writes a pool row and leaves the host a placeholder', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A'],
      turns: [{}],
      plugin: loginPlugin,
      login: true,
    })
    verify(result, () => {
      expect(result.exits[0]).toBe(0)
      const row = result.config.accounts.find(
        (account) => account.accountId === MOCK_ACCOUNTS.C.id,
      )
      expect(row).toBeDefined()
      expect(result.state.accounts[row?.id ?? '']?.refresh).toBe('refresh-C')
      // The host's stored credential is the placeholder, not account C.
      expect(result.exported).toContain(PLACEHOLDER)
      expect(result.exported).not.toContain(MOCK_ACCOUNTS.C.token)
      expect(result.exported).not.toContain('refresh-C')
      expectOnlyPoolAccountsOnWire(result)
    })
  }, 180_000)

  test('vault activation leaves the host only a placeholder without creating a local account', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: [],
      turns: [],
      plugin: vaultPlugin,
      vault: true,
      login: 'vault',
      preparePoolCredential: false,
    })
    verify(result, () => {
      expect(result.exits).toEqual([0])
      expect(result.config.commonAuthPool.rows).toEqual({})
      expect(result.state.accounts ?? {}).toEqual({})
      expect(result.exported).toContain(PLACEHOLDER)
      expect(result.exported).toContain('openai-auth-vault')
      const secrets = [
        ...result.exported.matchAll(/"(?:access|refresh)"\s*:\s*"([^"]*)"/g),
      ].map((match) => match[1])
      expect(secrets).toEqual([
        'common-auth-placeholder.openai',
        'common-auth-placeholder.openai',
      ])
      for (const account of Object.values(MOCK_ACCOUNTS))
        expect(result.exported).not.toContain(account.token)
      expect(result.exported).not.toContain('refresh-')
      expect(result.wire.filter((record) => record.identity !== 'V')).toEqual(
        [],
      )
    })
  }, 180_000)
})
