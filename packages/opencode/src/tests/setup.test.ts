import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
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
import { dirname, join } from 'node:path'
import type { ClaustrumEnrollmentConnection } from '@cortexkit/common-auth/claustrum'
import {
  runSetup,
  type SetupCallbackContext,
  type SetupIO,
} from '@cortexkit/common-auth/setup'
import {
  type beginAccountLogin,
  OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import piPackage from '../../../pi/package.json'
import { getPiAccountPaths } from '../../../pi/src/paths'
import packageInfo from '../../package.json'
import { getAccountPaths } from '../core/account-paths'
import { createSetupPlugin } from '../setup'

let root: string
let savedEnv: NodeJS.ProcessEnv
let output: string
let io: SetupIO
const stopped = { listRunningHosts: async () => [] }
let localContext: SetupCallbackContext
const account = {
  id: 'login-account',
  type: 'oauth' as const,
  enabled: true,
  access: 'setup-access',
  refresh: 'setup-refresh',
  expires: 123456789,
  addedAt: 1,
  lastUsed: 1,
  lastRefreshedAt: 1,
  accountId: 'chatgpt-account',
}
const beginLogin = mock(
  async (_options: Parameters<typeof beginAccountLogin>[0]) => ({
    url: 'https://auth.openai.com/codex/device',
    instructions: 'Use code SETUP',
    completion: Promise.resolve(account),
  }),
)

function seed(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: 0o600 })
}

function plugin() {
  return createSetupPlugin({
    beginLogin,
    openBrowser: () => true,
    fence: stopped,
    io,
    print: (text) => {
      output += `${text}\n`
    },
  })
}

function authPath() {
  return join(root, 'data', 'opencode', 'auth.json')
}

beforeEach(() => {
  savedEnv = { ...process.env }
  root = mkdtempSync(join(tmpdir(), 'openai-setup-'))
  localContext = {
    opencodeGeneration: '1',
    mode: 'local',
    hosts: ['opencode'],
    piAgentDir: join(root, 'pi'),
  }
  const config = join(root, 'config', 'opencode')
  mkdirSync(config, { recursive: true })
  Object.assign(process.env, {
    OPENCODE_CONFIG_DIR: config,
    XDG_DATA_HOME: join(root, 'data'),
    OPENCODE_OPENAI_AUTH_FILE: join(root, 'oc-store', 'accounts.json'),
    OPENCODE_OPENAI_AUTH_STATE_FILE: join(root, 'oc-state', 'state.json'),
    PI_OPENAI_AUTH_FILE: join(root, 'pi-store', 'accounts.json'),
    PI_OPENAI_AUTH_STATE_FILE: join(root, 'pi-state', 'state.json'),
    PI_AGENT_DIR: join(root, 'pi'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'connection.json'),
    SSH_CONNECTION: 'test-headless',
  })
  delete process.env.OPENCODE_AUTH_CONTENT
  beginLogin.mockClear()
  output = ''
  const input = Object.assign(new EventEmitter(), {
    isTTY: false,
    setRawMode() {},
    resume() {},
    pause() {},
  })
  io = {
    home: root,
    cwd: root,
    platform: 'linux',
    env: {
      HOME: root,
      PATH: join(root, 'bin'),
      OPENCODE_CONFIG_DIR: config,
      PI_CODING_AGENT_DIR: join(root, 'pi'),
    },
    fence: stopped,
    terminal: {
      input,
      output: {
        write: (text) => {
          output += text
        },
      },
    },
    runner: { run: async () => ({ exitCode: 0, stdout: '1.0.0', stderr: '' }) },
    wait: async () => {},
  }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  rmSync(root, { recursive: true, force: true })
})

describe('setup', () => {
  test('fresh dry run plans versioned registration without any credential writes', async () => {
    const result = await runSetup(
      plugin(),
      ['--dry-run', '--yes', '--opencode=both'],
      io,
    )
    expect(result.hosts).toEqual(['opencode'])
    expect(output).toContain(
      join(process.env.OPENCODE_CONFIG_DIR!, 'opencode.jsonc'),
    )
    expect(output).toContain(
      join(process.env.OPENCODE_CONFIG_DIR!, 'tui.jsonc'),
    )
    expect(output).toContain(`${packageInfo.name}@${packageInfo.version}`)
    expect(beginLogin).not.toHaveBeenCalled()
    expect(existsSync(authPath())).toBe(false)
    expect(existsSync(getAccountPaths().configPath)).toBe(false)
    expect(
      existsSync(join(process.env.OPENCODE_CONFIG_DIR!, 'opencode.jsonc')),
    ).toBe(false)
  })

  test('real local setup registers once and the second run changes nothing', async () => {
    seed(authPath(), '{"other":{"type":"api","key":"keep"}}\n')
    const config = join(process.env.OPENCODE_CONFIG_DIR!, 'opencode.jsonc')
    await runSetup(plugin(), ['--yes', '--login', '--opencode=1'], io)
    const before = [config, authPath()].map((path) => ({
      content: readFileSync(path),
      mtime: statSync(path).mtimeMs,
    }))
    expect(JSON.parse(readFileSync(config, 'utf8')).plugin).toEqual([
      `${packageInfo.name}@${packageInfo.version}`,
    ])
    expect(JSON.parse(readFileSync(authPath(), 'utf8'))).toEqual({
      other: { type: 'api', key: 'keep' },
      openai: {
        type: 'oauth',
        access: account.access,
        refresh: account.refresh,
        expires: account.expires,
        accountId: account.accountId,
      },
    })
    expect(existsSync(getAccountPaths().configPath)).toBe(false)
    expect(existsSync(getAccountPaths().statePath)).toBe(false)
    await runSetup(plugin(), ['--yes', '--login', '--opencode=1'], io)
    expect(
      [config, authPath()].map((path) => ({
        content: readFileSync(path),
        mtime: statSync(path).mtimeMs,
      })),
    ).toEqual(before)
    expect(beginLogin).toHaveBeenCalledTimes(1)
    expect(beginLogin.mock.calls[0]).toEqual([
      expect.objectContaining({
        version: packageInfo.version,
        headless: true,
      }),
    ])
  })

  for (const executable of ['opencode', 'opencode2']) {
    test(`OpenCode 2 setup uses ${executable} without local OAuth or slot writes`, async () => {
      const path = join(root, 'bin', executable)
      seed(path, '')
      chmodSync(path, 0o755)
      await runSetup(plugin(), ['--yes', '--login', '--opencode=2'], io)
      expect(beginLogin).not.toHaveBeenCalled()
      expect(existsSync(authPath())).toBe(false)
      expect(existsSync(getAccountPaths().configPath)).toBe(false)
      expect(existsSync(getAccountPaths().statePath)).toBe(false)
      expect(output).toContain(`${executable} auth login openai`)
      expect(output).toContain('"ChatGPT (openai-auth pool, browser)"')
      expect(output).toContain('"ChatGPT (openai-auth pool, headless)"')
      expect(output).toContain('sign in to the account pool and activate it')
    })
  }

  test('OpenCode 2 setup leaves an existing OpenCode 1 login byte-identical', async () => {
    seed(authPath(), 'unreadable as a login: do not parse or rewrite\n')
    const before = readFileSync(authPath())
    await plugin().signInLocal('opencode', {
      ...localContext,
      opencodeGeneration: '2',
    })
    expect(readFileSync(authPath())).toEqual(before)
    expect(beginLogin).not.toHaveBeenCalled()
    expect(output).toContain('auth login openai')
  })

  test('both generations retain OpenCode 1 sign-in and print the OpenCode 2 pool-login step', async () => {
    for (const executable of ['opencode', 'opencode2']) {
      const path = join(root, 'bin', executable)
      seed(path, '')
      chmodSync(path, 0o755)
    }
    const setup = plugin()
    await runSetup(setup, ['--yes', '--login', '--opencode=both'], io)
    expect(beginLogin).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(authPath(), 'utf8')).openai).toEqual({
      type: 'oauth',
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      accountId: account.accountId,
    })
    expect(output).toContain('opencode2 auth login openai')
    expect(output).toContain('"ChatGPT (openai-auth pool, browser)"')
    expect(output).toContain('"ChatGPT (openai-auth pool, headless)"')
    output = ''
    await runSetup(setup, ['--yes', '--login', '--opencode=both'], io)
    expect(beginLogin).toHaveBeenCalledTimes(1)
    expect(output).toContain('opencode2 auth login openai')
  })

  test('vault mode preserves every local credential byte and refuses local sign-in', async () => {
    const files = [
      authPath(),
      ...Object.values(getAccountPaths()),
      ...Object.values(getPiAccountPaths()),
      join(root, 'pi', 'auth.json'),
    ]
    for (const path of files) seed(path, '{"credential":"leave untouched"}\n')
    const before = files.map((path) => readFileSync(path))
    seed(join(root, 'bin', 'ck'), '')
    seed(join(root, 'connection.json'), '{}')
    io.fs = {
      exists: existsSync,
      isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
      isFile: (path) => existsSync(path) && statSync(path).isFile(),
      isExecutable: (path) => existsSync(path) && statSync(path).isFile(),
      readText: (path) => readFileSync(path, 'utf8'),
      realpath: (path) => path,
    }
    io.connect = async () => ({
      enrollPropose: async () => ({ requestId: 'setup-request' }),
      enrollPoll: async () => ({
        status: 'approved',
        name: 'openai-auth-opencode',
        token: '01'.repeat(32),
        tokenGeneration: 1,
      }),
      close() {},
    })
    const setup = plugin()
    await runSetup(setup, ['--yes', '--claustrum', '--opencode=1'], io)
    expect(files.map((path) => readFileSync(path))).toEqual(before)
    expect(beginLogin).not.toHaveBeenCalled()
    await expect(
      setup.beforeRegister!('opencode', 'local', localContext),
    ).rejects.toThrow('enrolled')
    await expect(setup.signInLocal('opencode', localContext)).rejects.toThrow(
      'enrolled',
    )
    expect(files.map((path) => readFileSync(path))).toEqual(before)
  })

  for (const host of ['opencode', 'pi'] as const) {
    test(`${host} enrollment is written exactly where the running plugin reads it`, async () => {
      seed(join(root, 'bin', 'ck'), '')
      seed(join(root, 'connection.json'), '{}')
      if (host === 'pi') {
        seed(join(root, 'bin', 'pi'), '')
        rmSync(process.env.OPENCODE_CONFIG_DIR!, { recursive: true })
      }
      io.fs = {
        exists: existsSync,
        isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
        isFile: (path) => existsSync(path) && statSync(path).isFile(),
        isExecutable: (path) => existsSync(path) && statSync(path).isFile(),
        readText: (path) => readFileSync(path, 'utf8'),
        realpath: (path) => path,
      }
      const name = `openai-auth-${host}`
      const connect = mock(
        async (): Promise<ClaustrumEnrollmentConnection> => ({
          enrollPropose: async (input) => {
            expect(input.name).toBe(name)
            return { requestId: `${host}-request` }
          },
          enrollPoll: async () => ({
            status: 'approved',
            name,
            token: '02'.repeat(32),
            tokenGeneration: 2,
          }),
          close() {},
        }),
      )
      io.connect = connect
      const setup = plugin()
      expect(setup.packages.pi).toBe(piPackage.name)
      await runSetup(setup, ['--yes', '--claustrum', '--opencode=1'], io)
      expect(connect).toHaveBeenCalledWith({
        connectionFile: join(root, 'connection.json'),
        handshakeTimeoutMs: 2000,
      })
      // This is the running host's path, not a path computed from SetupPlugin.
      const runtime = new OpenAiVault({
        host,
        stateDir: join(
          root,
          host === 'pi' ? 'pi-state' : 'oc-state',
          'openai-auth-vault',
        ),
      })
      try {
        expect(runtime.paths.tokenPath).toBe(
          join(
            root,
            host === 'pi' ? 'pi-state' : 'oc-state',
            'openai-auth-vault',
            `${host}-enrollment.json`,
          ),
        )
        expect(
          JSON.parse(readFileSync(runtime.paths.tokenPath, 'utf8')),
        ).toEqual({
          token: '02'.repeat(32),
          token_generation: 2,
        })
        expect(await runtime.authority()).toBe('vault')
      } finally {
        runtime.close()
      }
      expect(
        existsSync(
          join(
            root,
            host === 'pi' ? 'pi-store' : 'oc-store',
            'openai-auth-vault',
          ),
        ),
      ).toBe(false)
    })
  }

  test('Pi local sign-in delegates to Pi without writing its auth file', async () => {
    const path = join(root, 'pi', 'auth.json')
    seed(path, '{"openai-codex":{"refresh":"keep"}}\n')
    const before = readFileSync(path)
    await plugin().signInLocal('pi', localContext)
    expect(output).toContain('/login openai-codex')
    expect(readFileSync(path)).toEqual(before)
    expect(beginLogin).not.toHaveBeenCalled()
  })

  test('failed browser launch falls back to the shared device-code login', async () => {
    delete process.env.SSH_CONNECTION
    delete process.env.SSH_TTY
    process.env.DISPLAY = ':setup-test'
    await createSetupPlugin({
      beginLogin,
      openBrowser: () => false,
      fence: stopped,
      print: (text) => {
        output += text
      },
    }).signInLocal('opencode', localContext)
    expect(beginLogin.mock.calls.map(([options]) => options.headless)).toEqual([
      false,
      true,
    ])
    expect(beginLogin.mock.calls[0]![0].signal!.aborted).toBe(true)
    expect(output).toContain('using device-code sign-in')
    expect(JSON.parse(readFileSync(authPath(), 'utf8')).openai.access).toBe(
      account.access,
    )
  })

  test('enrollment during local login prevents publishing a credential', async () => {
    const setup = createSetupPlugin({
      beginLogin: async () => {
        seed(
          join(
            root,
            'oc-state',
            'openai-auth-vault',
            'opencode-enrollment.json',
          ),
          JSON.stringify({ token: '03'.repeat(32), token_generation: 1 }),
        )
        return {
          url: 'https://auth.openai.com/codex/device',
          instructions: '',
          completion: Promise.resolve(account),
        }
      },
      fence: stopped,
      print: () => {},
    })
    await expect(setup.signInLocal('opencode', localContext)).rejects.toThrow(
      'enrolled',
    )
    expect(existsSync(authPath())).toBe(false)
  })

  test('unknown bin argument prints only one line of usage', async () => {
    const child = Bun.spawn(
      ['node', join(import.meta.dir, '../../dist/bin.js'), 'unknown'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: root },
      },
    )
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toBe('')
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe(
      'Usage: opencode-openai-auth setup [options]\n',
    )
  })
})
