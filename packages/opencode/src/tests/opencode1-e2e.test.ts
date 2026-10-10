// openai-auth on the real OpenCode 1 host: runs the `opencode` binary (the
// npm package `opencode-ai`) with the plugin loaded from this checkout's build
// through a `file://` URL, over an install that has not moved into the
// account pool yet, and checks that the move happens on OpenCode 1's own
// plugin client: the login in OpenCode 1's `auth.json` lands in pool row
// `main`, its `auth.json` entry holds the pool placeholder instead of real
// credentials, and a request afterwards is served from the row.
//
// It needs the build (`bun run build`) and the binary, so it runs only with
// OPENAI_AUTH_OPENCODE1_E2E=1 (its own CI job, after the build). The binary is
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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadAccounts,
  mutateAccounts,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum'
import { authDoctorChecks, readStoreIds } from '../auth/doctor'
import { VAULT_LOGIN_LABEL } from '../auth/methods'
import {
  isPoolPlaceholder,
  POOL_MIGRATION_KEY,
  POOL_PLACEHOLDER,
} from '../core/pool-migration'
import { hostBinary } from './fixtures/opencode-host'
import {
  MOCK_ACCOUNTS,
  type MockCodex,
  startMockCodex,
  type WireRecord,
} from './fixtures/opencode2-mock-codex'

const ENABLED = process.env.OPENAI_AUTH_OPENCODE1_E2E === '1'
export const OPENCODE1_VERSION = '1.18.30'
const HOUR = 3600_000
// The login OpenCode 1 holds before the move: the mock backend's account V,
// the one whose access token is a JWT naming its ChatGPT account, as a real
// login's is (the plugin reads the account id from that token).
const ACCOUNT = MOCK_ACCOUNTS.V
const BUILT_PLUGIN = resolve(import.meta.dir, '..', '..', 'dist', 'index.js')

let scratch = ''
let binary = ''

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
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
    // misrouted request (a token refresh, a model catalog fetch) fails
    // instead of reaching the internet. The npm registry is the exception:
    // OpenCode 1 installs `@opencode-ai/plugin` into its config directory
    // before it loads any plugin, and waits for that install.
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,registry.npmjs.org',
    no_proxy: '127.0.0.1,localhost,registry.npmjs.org',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_OPENAI_AUTH_LOG_FILE: join(root, 'openai-auth.log'),
    OPENCODE_OPENAI_AUTH_LOG_LEVEL: 'debug',
  }
}

/**
 * The plugin as OpenCode 1 loads it: this checkout's build, behind a module
 * that first sends what the plugin addresses to chatgpt.com (its requests and
 * its quota polls) to the mock instead. The build is imported only after
 * that, so nothing in it can hold the unredirected `fetch`.
 */
function writePluginEntry(dir: string, mockURL: string, vault = false): string {
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'openai-auth-e2e.js')
  writeFileSync(
    entry,
    [
      'const realFetch = globalThis.fetch',
      `const mock = ${JSON.stringify(mockURL)}`,
      'globalThis.fetch = Object.assign((input, init) => {',
      '  const url = input instanceof Request ? input.url : String(input)',
      "  if (!url.startsWith('https://chatgpt.com/')) return realFetch(input, init)",
      "  const target = url.replace('https://chatgpt.com', mock)",
      '  return realFetch(input instanceof Request ? new Request(target, input) : target, init)',
      '}, realFetch)',
      `const plugin = await import(${JSON.stringify(pathToFileURL(BUILT_PLUGIN).href)})`,
      vault
        ? 'export default { ...plugin.default, server: (input) => plugin.CodexAuthPlugin(input, { vault: { connectionFile: () => process.env.OPENAI_AUTH_E2E_CLAUSTRUM, pollIntervalMs: 0 } }) }'
        : 'export default plugin.default',
      '',
    ].join('\n'),
  )
  return pathToFileURL(entry).href
}

/** An install from before the account pool: main lives in OpenCode's slot. */
function seedLegacyInstall(configDir: string, dataDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'openai-auth.json'),
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
      // Older builds record the slot login's account here; the migration
      // drops it once the login has moved.
      mainAccountId: ACCOUNT.id,
    }),
  )
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'auth.json'),
    `${JSON.stringify(
      {
        openai: {
          type: 'oauth',
          access: ACCOUNT.token,
          refresh: 'refresh-V',
          expires: Date.now() + 24 * HOUR,
          accountId: ACCOUNT.id,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  child: Bun.Subprocess,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`host exited (${child.exitCode}) waiting for ${what}`)
    try {
      if (await check()) return
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

interface ScenarioResult {
  /** What stopped the scenario before its end, if anything did. */
  readonly failure?: unknown
  readonly wire: WireRecord[]
  readonly runExit: number | null
  readonly runStdout: string
  readonly config: Record<string, any>
  readonly state: { accounts?: Record<string, Record<string, unknown>> }
  readonly slot: unknown
  readonly authFileMode: number
  readonly doctorFindings: unknown[]
  readonly diagnostics: string
}

async function runScenario(vaultActivation = false): Promise<ScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), 'oai-oc1-e2e-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: project })
  const mock: MockCodex = startMockCodex([])
  const env = isolatedEnv(root)
  const configDir = join(env.XDG_CONFIG_HOME, 'opencode')
  const dataDir = join(env.XDG_DATA_HOME, 'opencode')
  const configFile = join(configDir, 'openai-auth.json')
  const stateFile = join(configDir, 'openai-auth-state.json')
  const authFile = join(dataDir, 'auth.json')
  const daemon = vaultActivation
    ? await startMockDaemon({
        directory: root,
        credentials: { 'oauth:openai:work': vaultLogin(ACCOUNT.id) },
      })
    : undefined
  let rosterPath = ''
  if (daemon) {
    Object.assign(env, { OPENAI_AUTH_E2E_CLAUSTRUM: daemon.connectionFile })
    mkdirSync(configDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(authFile, '{}\n', { mode: 0o600 })
    const paths = vaultPaths(vaultStateDir(stateFile), 'opencode')
    rosterPath = paths.rosterPath
    mkdirSync(join(paths.tokenPath, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(
      paths.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
  } else seedLegacyInstall(configDir, dataDir)
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [
          writePluginEntry(join(root, 'plugin'), mock.url, vaultActivation),
        ],
        autoupdate: false,
        share: 'disabled',
      },
      null,
      2,
    ),
  )

  if (vaultActivation) {
    const login = Bun.spawn(
      [
        binary,
        'auth',
        'login',
        '--provider',
        'openai',
        '--method',
        VAULT_LOGIN_LABEL,
      ],
      { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const timer = setTimeout(() => login.kill('SIGKILL'), 180_000)
    const output = await Promise.all([
      new Response(login.stdout).text(),
      new Response(login.stderr).text(),
      login.exited,
    ])
    clearTimeout(timer)
    if (login.exitCode !== 0 || !isPoolPlaceholder(readJson(authFile).openai)) {
      await daemon?.stop()
      await mock.stop()
      throw new Error(
        `vault login did not activate OpenCode 1: ${output.join('\n')}`,
      )
    }
  }

  const port = await freePort()
  const serverURL = `http://127.0.0.1:${port}`
  const serverLog: string[] = []
  const server = Bun.spawn(
    [
      binary,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'INFO',
    ],
    { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
  )
  const serverOutput = Promise.all([
    collect(server.stdout, serverLog),
    collect(server.stderr, serverLog),
  ])
  let run = { exit: null as number | null, stdout: '', stderr: '' }
  let wireBeforeRun: WireRecord[] = []
  let failure: unknown
  try {
    await waitFor(
      async () => {
        const response = await fetch(
          `${serverURL}/config/providers?directory=${encodeURIComponent(project)}`,
          { signal: AbortSignal.timeout(30_000) },
        )
        return response.ok
      },
      'the host to serve',
      server,
      // The first start includes OpenCode 1's install into its config dir.
      180_000,
    )
    // Listing the providers starts the `openai` provider, whose auth loader
    // starts the migration in the background.
    if (!vaultActivation)
      await waitFor(
        () =>
          readJson(configFile)[POOL_MIGRATION_KEY]?.migratedAt > 0 &&
          isPoolPlaceholder(readJson(authFile).openai),
        'the migration to finish',
        server,
      )
    // A migrated install refuses an account until its first quota reading
    // is in; the migration starts that poll itself.
    await waitFor(
      () =>
        vaultActivation
          ? readJson(rosterPath).rows?.some(
              (row: { quota?: unknown }) => row.quota,
            )
          : readJson(configFile).commonAuthPool?.rows?.main?.quota !==
            undefined,
      "the serving account's first quota reading",
      server,
    )
    wireBeforeRun = [...mock.records]
    const child = Bun.spawn(
      [
        binary,
        'run',
        '--attach',
        serverURL,
        '--dir',
        project,
        '--format',
        'json',
        '--model',
        'openai/gpt-5.5',
        'Say hello.',
      ],
      { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const out: string[] = []
    const err: string[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    await Promise.all([
      collect(child.stdout, out),
      collect(child.stderr, err),
      child.exited,
    ])
    clearTimeout(timer)
    run = { exit: child.exitCode, stdout: out.join(''), stderr: err.join('') }
  } catch (error) {
    failure = error
  } finally {
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 15_000)
    await server.exited
    clearTimeout(timer)
    await serverOutput
    await mock.stop()
    await daemon?.stop()
  }

  const config = readJson(configFile)
  const slot = readJson(authFile).openai
  // The auth doctor's checks, built the way the account menu builds them, run
  // over the files the host left behind.
  const paths = { configPath: configFile, statePath: stateFile }
  const doctor = authDoctorChecks({
    paths,
    migrated: true,
    readAuth: async () => slot ?? { type: 'missing' },
    loadAccounts,
    readStoreIds,
    mutateAccounts,
    setMainAuth: async () => {
      throw new Error('the doctor offered a repair')
    },
    now: Date.now,
  })
  const doctorFindings = (
    await Promise.all(doctor.map((check) => check.run()))
  ).flat()
  let pluginLog = ''
  try {
    pluginLog = readFileSync(env.OPENCODE_OPENAI_AUTH_LOG_FILE, 'utf8')
  } catch {}
  const result: ScenarioResult = {
    ...(failure !== undefined ? { failure } : {}),
    wire: [...mock.records],
    runExit: run.exit,
    runStdout: run.stdout,
    config,
    state: readJson(stateFile),
    slot,
    authFileMode: existsSync(authFile) ? statSync(authFile).mode & 0o777 : 0,
    doctorFindings,
    diagnostics: [
      `wire before the run: ${JSON.stringify(wireBeforeRun)}`,
      `wire: ${JSON.stringify(mock.records)}`,
      `config: ${JSON.stringify(config)}`,
      `slot: ${JSON.stringify(slot)}`,
      `--- run (exit ${run.exit}) ---\n${run.stdout}\n${run.stderr}`,
      `--- plugin log (tail) ---\n${pluginLog.slice(-8000)}`,
      `--- host log (tail) ---\n${serverLog.join('').slice(-8000)}`,
    ].join('\n'),
  }
  rmSync(root, { recursive: true, force: true })
  return result
}

function verify(result: ScenarioResult, assertions: () => void) {
  // OPENAI_AUTH_OPENCODE1_E2E_VERBOSE=1 prints the evidence of passing runs too.
  if (process.env.OPENAI_AUTH_OPENCODE1_E2E_VERBOSE === '1')
    console.error(result.diagnostics)
  try {
    if (result.failure !== undefined) throw result.failure
    assertions()
  } catch (error) {
    console.error(result.diagnostics)
    throw error
  }
}

describe.skipIf(!ENABLED)('openai-auth on OpenCode 1 (real host)', () => {
  beforeAll(() => {
    if (!existsSync(BUILT_PLUGIN))
      throw new Error(`no plugin build at ${BUILT_PLUGIN}; run bun run build`)
    scratch = mkdtempSync(join(tmpdir(), 'oai-oc1-cli-'))
    binary = hostBinary(1)
    const version = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
    }).stdout.trim()
    if (version !== OPENCODE1_VERSION)
      throw new Error(
        `expected opencode ${OPENCODE1_VERSION}, found "${version}" at ${binary}`,
      )
  }, 300_000)

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  test('the login in auth.json moves into the pool, and a request is served from row main', async () => {
    const result = await runScenario()
    verify(result, () => {
      // The move: row main holds the login, the slot the placeholder, and
      // the record of the slot login's account is gone.
      expect(result.config[POOL_MIGRATION_KEY]?.migratedAt).toBeGreaterThan(0)
      expect(result.config.commonAuthPool).toBeDefined()
      expect('mainAccountId' in result.config).toBe(false)
      expect(result.state.accounts?.main).toMatchObject({
        access: ACCOUNT.token,
        refresh: 'refresh-V',
      })
      expect(isPoolPlaceholder(result.slot)).toBe(true)
      // The placeholder went through OpenCode 1's own writer, which keeps
      // `auth.json` readable by its owner only.
      expect(result.authFileMode).toBe(0o600)

      // The turn after the move, with the slot holding the placeholder, went
      // out under the row's login and account.
      expect(result.runExit).toBe(0)
      const primaries = result.wire.filter(
        (record) => record.action === 'request' && record.kind === 'primary',
      )
      expect(primaries.length).toBeGreaterThan(0)
      expect(
        result.wire.filter((record) => record.identity === 'none'),
      ).toEqual([])
      for (const record of primaries) {
        expect(record.identity).toBe('V')
        expect(record.accountHeader).toBe(ACCOUNT.id)
      }

      expect(result.doctorFindings).toEqual([])
    })
  }, 240_000)

  test('vault login activates an empty host slot and requests route only to the vault', async () => {
    const result = await runScenario(true)
    verify(result, () => {
      expect(isPoolPlaceholder(result.slot)).toBe(true)
      expect(result.slot).toEqual(POOL_PLACEHOLDER)
      expect(result.config.commonAuthPool?.rows ?? {}).toEqual({})
      expect(result.state.accounts ?? {}).toEqual({})
      expect(result.runExit).toBe(0)
      const primaries = result.wire.filter(
        (record) => record.action === 'request' && record.kind === 'primary',
      )
      expect(primaries.length).toBeGreaterThan(0)
      for (const record of primaries) {
        expect(record.identity).toBe('V')
        expect(record.accountHeader).toBe(ACCOUNT.id)
      }
      expect(result.wire.filter((record) => record.identity !== 'V')).toEqual(
        [],
      )
    })
  }, 240_000)
})
