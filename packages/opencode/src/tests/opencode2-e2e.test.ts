// openai-auth on the real OpenCode 2 host: runs `@opencode/cli` against a
// loopback mock of the Codex backend with two pool accounts, the plugin
// loaded from the packed package's `./server` entry, and checks what reached
// the wire and what landed in the pool. It installs the CLI from npm, so it
// runs only with OPENAI_AUTH_OPENCODE2_E2E=1 (its own CI job, after the
// build). OPENAI_AUTH_OPENCODE2_E2E_CLI_DIR may name a directory that already
// holds the pinned CLI install, to skip the install while iterating.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { vaultPaths, vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import {
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { POOL_PLACEHOLDER } from '../core/pool-migration'
import { CODEX_USER_AGENT, CODEX_VERSION } from '../index'
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
const REUSE_CLI_DIR = process.env.OPENAI_AUTH_OPENCODE2_E2E_CLI_DIR
export const OPENCODE_CLI_VERSION = '2.0.22'
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

async function waitForServer(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`host exited early with ${child.exitCode}`)
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error(`host at ${url} did not start`)
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
  readonly diagnostics: string
}

async function runScenario(input: {
  transport: Transport
  upgrade?: 'default' | 'custom'
  accounts: MockAccount[]
  turns: Turn[]
  plugin?: string
  login?: boolean
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
  }
  const configDir = join(isolated.XDG_CONFIG_HOME, 'opencode')
  seedPool(configDir, input.accounts, input.mode)
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
  let rosterPath = ''
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
    rosterPath = paths.rosterPath
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(
      paths.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
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
            // The host's own credential for the provider is the placeholder,
            // as it is after a login through the plugin.
            settings: {
              ...(input.upgrade === 'default'
                ? {}
                : { baseURL: `${mock.url}/v1` }),
              ...(input.upgrade ? {} : { apiKey: PLACEHOLDER }),
              transport: input.transport,
            },
            models: {
              'gpt-5.5': { name: 'GPT-5.5 (mock)' },
              'gpt-6-sol': { name: 'GPT-6 Sol (mock)' },
              'gpt-6.1-sol': { name: 'GPT-6.1 Sol (mock)' },
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
          'chatgpt-browser',
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
    // The host starts the plugin with the first session. The plugin then
    // reads the vault's roster and takes a quota reading of its account in
    // the background; routing admits the account once it has one.
    const vaultReady = async () => {
      const deadline = Date.now() + 30_000
      const ready = () => {
        try {
          return JSON.parse(readFileSync(rosterPath, 'utf8')).rows.some(
            (row: { quota?: unknown }) => row.quota,
          )
        } catch {
          return false
        }
      }
      while (!ready() && Date.now() < deadline) await Bun.sleep(100)
    }
    for (const [index, turn] of input.turns.entries()) {
      if (input.vault && index === 1) await vaultReady()
      if (turn.reject) mock.reject(turn.reject.account, turn.reject.mode)
      const result = await runCli(
        [
          'run',
          '--server',
          serverURL,
          '--format',
          'json',
          '--model',
          `openai/${model}${turn.variant ? `#${turn.variant}` : ''}`,
          ...(index > 0 ? ['--continue'] : []),
          `Turn ${index + 1}: say hello.`,
        ],
        project,
        env,
      )
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
  const state = read(join(configDir, 'openai-auth-state.json'))
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
  const diagnostics = [
    `destinations: ${JSON.stringify(destinations)}`,
    `vault reports: ${JSON.stringify(daemon?.reports ?? [])}`,
    `wire: ${JSON.stringify(mock.records)}`,
    `samples: ${JSON.stringify(mock.samples)}`,
    `stdout: ${JSON.stringify(stdout)}`,
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
    exits,
    config,
    state,
    exported,
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
    const cliDir = REUSE_CLI_DIR ?? join(scratch, 'cli')
    if (!REUSE_CLI_DIR) {
      mkdirSync(cliDir, { recursive: true })
      writeFileSync(join(cliDir, 'package.json'), '{"private":true}\n')
      // npm, not bun: the CLI package installs its platform binary from a
      // lifecycle script, which bun does not run for untrusted packages.
      const install = spawnSync(
        'npm',
        [
          'install',
          '--no-audit',
          '--no-fund',
          '--no-save',
          `@opencode/cli@${OPENCODE_CLI_VERSION}`,
        ],
        { cwd: cliDir, encoding: 'utf8' },
      )
      if (install.status !== 0)
        throw new Error(
          `CLI install failed:\n${install.stdout}\n${install.stderr}`,
        )
    }
    cli = join(cliDir, 'node_modules', '.bin', 'opencode2')
    if (!existsSync(cli)) throw new Error(`no opencode2 binary at ${cli}`)
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
    serverPlugin = join(consumer, 'server-plugin')
    mkdirSync(serverPlugin, { recursive: true })
    writeFileSync(
      join(serverPlugin, 'index.js'),
      `export { default } from '${PACKAGE_NAME}/server'\n`,
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

  test('first run after OpenCode 1 upgrade reaches Codex without a provider baseURL', async () => {
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

  test('first run after OpenCode 1 upgrade keeps a custom provider baseURL', async () => {
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

  test('http: a vault account is served with the token the vault hands out, and a 401 is reported with its record version', async () => {
    const result = await runScenario({
      transport: 'http',
      accounts: ['A'],
      mode: 'fallback-first',
      plugin: vaultPlugin,
      vault: true,
      // The first turn starts the plugin. It goes to the vault account only if
      // the account's first quota reading lands before the turn is routed;
      // otherwise the pool row serves it.
      turns: [{}, {}, { reject: { account: 'V', mode: 'unauthorized' } }],
    })
    verify(result, () => {
      expect(result.exits.slice(0, 2)).toEqual([0, 0])
      expectOnlyPoolAccountsOnWire(result)
      const served = pick(primaries(result.wire), 'identity', 'rejected')
      expect(['A:', 'V:']).toContain(served[0] ?? '')
      expect(served.slice(1)).toEqual(['V:', 'V:unauthorized'])
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
})
