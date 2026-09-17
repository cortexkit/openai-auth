import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  CommandContext,
  CommandModalName,
} from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  type AccountStorage,
  type IngestAccount,
  isOAuthAccount,
  loadAccounts,
  QuotaManager,
  saveAccounts,
} from '@cortexkit/openai-auth-core/internal'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'

import { buildDialogPayload as buildOpenCodeDialogPayload } from '../../../opencode/src/commands.ts'
import { getAccountPaths as getOpenCodeAccountPaths } from '../../../opencode/src/core/account-paths.ts'
import {
  buildPiDialogPayload,
  type PiCommandDependencies,
  registerCommands,
} from '../commands.ts'
import {
  getPiAccountPaths,
  getPiAccountStatePath,
  getPiAccountStoragePath,
  getPiConfigDir,
} from '../paths.ts'
import { getPiStickyRouting, setPiStickyRouting } from '../routing.ts'

const FIXED_NOW = 1_900_000_000_000
const FIXED_UUID = '00000000-0000-4000-8000-000000000001'
const ENV_KEYS = [
  'OPENCODE_OPENAI_AUTH_FILE',
  'OPENCODE_OPENAI_AUTH_STATE_FILE',
  'PI_AGENT_DIR',
  'PI_OPENAI_AUTH_FILE',
  'PI_OPENAI_AUTH_STATE_FILE',
] as const

type CommandRegistration = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

let tempDir: string
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-openai-commands-'))
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as typeof originalEnv
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tempDir, { recursive: true, force: true })
})

function fixtureStorage(accounts = fixtureAccounts()): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    routing: { mode: 'main-first' },
    quota: { checkIntervalMinutes: 5 },
    accounts,
  }
}

function fixtureAccounts(): AccountStorage['accounts'] {
  return [
    {
      id: 'alpha',
      label: 'Alpha',
      type: 'oauth',
      access: 'access-alpha',
      refresh: 'refresh-alpha',
      expires: FIXED_NOW + 60_000,
      enabled: true,
      addedAt: FIXED_NOW - 3_000,
      quota: {
        primary: {
          usedPercent: 25,
          remainingPercent: 75,
          checkedAt: FIXED_NOW + 1_000_000_000_000,
        },
      },
    },
    {
      id: 'beta',
      label: 'Beta',
      type: 'api',
      apiKey: 'api-key-beta',
      baseURL: 'https://example.test/v1',
      authHeader: 'x-api-key',
      enabled: true,
      addedAt: FIXED_NOW - 2_000,
    },
    {
      id: 'gamma',
      label: 'Gamma',
      type: 'oauth',
      access: 'access-gamma',
      refresh: 'refresh-gamma',
      expires: FIXED_NOW + 120_000,
      enabled: true,
      addedAt: FIXED_NOW - 1_000,
    },
  ]
}

function makePiContext(
  notified: string[],
  options: { sessionId?: string; onNotify?: () => void } = {},
): ExtensionCommandContext {
  return {
    ui: {
      notify(message: string) {
        notified.push(message)
        options.onNotify?.()
      },
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? 'pi-session',
    },
  } as unknown as ExtensionCommandContext
}

function registeredCommands(dependencies: PiCommandDependencies = {}) {
  const commands = new Map<string, CommandRegistration>()
  registerCommands(
    {
      registerCommand(name: string, registration: CommandRegistration) {
        commands.set(name, registration)
      },
    } as unknown as ExtensionAPI,
    dependencies,
  )
  return commands
}

async function makeOpenCodeContext(
  paths: AccountPaths,
  overrides: Partial<CommandContext> = {},
): Promise<CommandContext> {
  const storage = await loadAccounts(paths)
  const quotaManager = new QuotaManager({
    storage: null,
    configPath: paths.configPath,
    now: () => FIXED_NOW,
  })
  quotaManager.seedFallbacksFromAccounts(
    (storage?.accounts ?? []).filter(isOAuthAccount),
  )
  return {
    accountStoragePath: paths.configPath,
    accountStatePath: paths.statePath,
    packageVersion: '0.7.2-test',
    quotaManager,
    loadAccounts,
    client: { auth: { set: async () => {} } },
    sessionId: 'pi-session',
    clearStickyRouting: async () => false,
    getStickyRouting: async () => undefined,
    now: () => FIXED_NOW,
    randomUUID: () => FIXED_UUID,
    ...overrides,
  }
}

function bytes(paths: AccountPaths): [string, string] {
  return [
    readFileSync(paths.configPath, 'utf8'),
    readFileSync(paths.statePath, 'utf8'),
  ]
}

function sensitiveKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(sensitiveKeys)
  const found: string[] = []
  for (const [key, entry] of Object.entries(value)) {
    if (
      [
        'access',
        'refresh',
        'apiKey',
        'authHeader',
        'password',
        'secret',
      ].includes(key)
    ) {
      found.push(key)
    }
    found.push(...sensitiveKeys(entry))
  }
  return found
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Pi OpenAI command wrappers', () => {
  test('keeps config and state bytes equal to OpenCode for shared mutations', async () => {
    const paths = {
      configPath: join(tempDir, 'parity', 'openai-auth.json'),
      statePath: join(tempDir, 'parity', 'openai-auth-state.json'),
    }
    await saveAccounts(fixtureStorage(), paths)
    const seedBytes = bytes(paths)

    const notified: string[] = []
    const ctx = makePiContext(notified)
    const commands = registeredCommands({
      accountPaths: () => paths,
      now: () => FIXED_NOW,
      randomUUID: () => FIXED_UUID,
      packageVersion: '0.7.2-test',
    })
    const operations: Array<[CommandModalName, string]> = [
      ['openai-account', 'list'],
      ['openai-account', 'remove beta'],
      ['openai-account', 'order alpha gamma'],
      ['openai-routing', 'fallback-first'],
      ['openai-routing', 'sticky-balanced'],
      ['openai-routing', 'main-first'],
    ]

    for (const [command, args] of operations) {
      writeFileSync(paths.configPath, seedBytes[0])
      writeFileSync(paths.statePath, seedBytes[1])
      await commands.get(command)?.handler(args, ctx)
      const piBytes = bytes(paths)

      writeFileSync(paths.configPath, seedBytes[0])
      writeFileSync(paths.statePath, seedBytes[1])
      const openCodePayload = await buildOpenCodeDialogPayload(
        command,
        args,
        await makeOpenCodeContext(paths),
      )

      expect(notified.at(-1)).toBe(openCodePayload.text)
      expect(piBytes).toEqual(bytes(paths))
    }
  })

  test('removes the only configured fallback account', async () => {
    const paths = {
      configPath: join(tempDir, 'single', 'openai-auth.json'),
      statePath: join(tempDir, 'single', 'openai-auth-state.json'),
    }
    await saveAccounts(fixtureStorage([fixtureAccounts()[0]!]), paths)
    const commands = registeredCommands({ accountPaths: () => paths })

    await commands
      .get('openai-account')
      ?.handler('remove alpha', makePiContext([]))

    expect((await loadAccounts(paths))?.accounts).toEqual([])
  })

  test('adds an account with an injected login and reports completion once', async () => {
    const paths = {
      configPath: join(tempDir, 'add', 'openai-auth.json'),
      statePath: join(tempDir, 'add', 'openai-auth-state.json'),
    }
    await saveAccounts(fixtureStorage([]), paths)
    const login = deferred<IngestAccount>()
    const loginInputs: unknown[] = []
    const notified: string[] = []
    let finishNotify!: () => void
    const completionNotified = new Promise<void>((resolve) => {
      finishNotify = resolve
    })
    const beginAccountLogin: NonNullable<
      CommandContext['beginAccountLogin']
    > = async (input) => {
      loginInputs.push(input)
      return {
        url: 'https://login.example.test/device',
        instructions: 'Enter code: ABCD-EFGH',
        completion: login.promise,
      }
    }
    const commands = registeredCommands({
      accountPaths: () => paths,
      beginAccountLogin,
      packageVersion: '0.7.2-test',
    })
    const piContext = makePiContext(notified, {
      onNotify: () => {
        if (notified.length === 2) finishNotify()
      },
    })

    await commands
      .get('openai-account')
      ?.handler('add Work --headless', piContext)

    const comparisonLogin: NonNullable<
      CommandContext['beginAccountLogin']
    > = async () => ({
      url: 'https://login.example.test/device',
      instructions: 'Enter code: ABCD-EFGH',
      completion: new Promise<IngestAccount>(() => {}),
    })
    const openCodePayload = await buildOpenCodeDialogPayload(
      'openai-account',
      'add Work --headless',
      await makeOpenCodeContext(paths, {
        beginAccountLogin: comparisonLogin,
      }),
    )

    expect(notified).toEqual([openCodePayload.text])
    expect(loginInputs).toEqual([
      { label: 'Work', headless: true, version: '0.7.2-test' },
    ])

    login.resolve({
      id: 'work-account',
      label: 'Work',
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: FIXED_NOW + 60_000,
      enabled: true,
      addedAt: FIXED_NOW,
      lastUsed: FIXED_NOW,
    })
    await completionNotified

    expect(notified).toHaveLength(2)
    expect(notified[1]).toContain('## Account Added')
    expect((await loadAccounts(paths))?.accounts.map(({ id }) => id)).toEqual([
      'work-account',
    ])
  })

  test('reports a failed injected login without writing either store file', async () => {
    const paths = {
      configPath: join(tempDir, 'add-failure', 'openai-auth.json'),
      statePath: join(tempDir, 'add-failure', 'openai-auth-state.json'),
    }
    await saveAccounts(fixtureStorage([]), paths)
    const before = bytes(paths)
    const login = deferred<IngestAccount>()
    const notified: string[] = []
    let finishNotify!: () => void
    const completionNotified = new Promise<void>((resolve) => {
      finishNotify = resolve
    })
    const commands = registeredCommands({
      accountPaths: () => paths,
      beginAccountLogin: async () => ({
        url: 'https://login.example.test/browser',
        instructions: 'Complete authorization.',
        completion: login.promise,
      }),
    })

    await commands.get('openai-account')?.handler(
      'add',
      makePiContext(notified, {
        onNotify: () => {
          if (notified.length === 2) finishNotify()
        },
      }),
    )
    login.reject(new Error('login rejected'))
    await completionNotified

    expect(notified).toHaveLength(2)
    expect(notified[1]).toContain('Account add failed: login rejected')
    expect(bytes(paths)).toEqual(before)
  })

  test('reads and clears the current Pi session sticky route', async () => {
    const paths = {
      configPath: join(tempDir, 'routing', 'openai-auth.json'),
      statePath: join(tempDir, 'routing', 'openai-auth-state.json'),
    }
    await saveAccounts(
      { ...fixtureStorage(), routing: { mode: 'sticky-balanced' } },
      paths,
    )
    setPiStickyRouting('pi-session', 'alpha')
    const notified: string[] = []
    const commands = registeredCommands({ accountPaths: () => paths })
    const ctx = makePiContext(notified)

    await commands.get('openai-routing')?.handler('', ctx)
    await commands.get('openai-routing')?.handler('reset', ctx)

    expect(notified[0]).toContain('Session pin: `alpha`')
    expect(notified[1]).toContain("This session's pin was cleared")
    expect(getPiStickyRouting('pi-session')).toBeUndefined()
  })

  test('renders persisted fallback quota like OpenCode without network traffic', async () => {
    const paths = {
      configPath: join(tempDir, 'quota', 'openai-auth.json'),
      statePath: join(tempDir, 'quota', 'openai-auth-state.json'),
    }
    await saveAccounts(fixtureStorage([fixtureAccounts()[0]!]), paths)
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch
    const notified: string[] = []
    const commands = registeredCommands({
      accountPaths: () => paths,
      fetchImpl,
      now: () => FIXED_NOW,
    })

    await commands.get('openai-quota')?.handler('', makePiContext(notified))
    const openCodePayload = await buildOpenCodeDialogPayload(
      'openai-quota',
      '',
      await makeOpenCodeContext(paths),
    )

    expect(notified).toEqual([openCodePayload.text])
    expect(notified[0]).toContain('### Fallback accounts')
    expect(notified[0]).not.toContain('### Main account')
    expect(fetchCalls).toBe(0)
  })

  test('scrubs credential-shaped knobs before the Pi wrapper returns or renders', async () => {
    const paths = {
      configPath: join(tempDir, 'scrub', 'openai-auth.json'),
      statePath: join(tempDir, 'scrub', 'openai-auth-state.json'),
    }
    await saveAccounts(fixtureStorage(), paths)
    const notified: string[] = []
    const ctx = makePiContext(notified)
    const dependencies = { accountPaths: () => paths }
    const payload = await buildPiDialogPayload(
      'openai-account',
      'list',
      ctx,
      dependencies,
    )
    const openCodePayload = await buildOpenCodeDialogPayload(
      'openai-account',
      'list',
      await makeOpenCodeContext(paths),
    )
    await registeredCommands(dependencies)
      .get('openai-account')
      ?.handler('list', ctx)

    expect(sensitiveKeys(payload.knobs)).toEqual([])
    expect(payload).toEqual(openCodePayload)
    expect(notified.join('\n')).not.toContain('access-alpha')
    expect(notified.join('\n')).not.toContain('refresh-alpha')
    expect(notified.join('\n')).not.toContain('api-key-beta')
  })
})

describe('Pi OpenAI account paths', () => {
  test('stays isolated from explicit OpenCode config and state overrides', () => {
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(tempDir, 'oc-config.json')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(tempDir, 'oc-state.json')
    process.env.PI_OPENAI_AUTH_FILE = join(tempDir, 'pi-config.json')
    process.env.PI_OPENAI_AUTH_STATE_FILE = join(tempDir, 'pi-state.json')

    const piPaths = getPiAccountPaths()
    const openCodePaths = getOpenCodeAccountPaths()
    expect(piPaths.configPath).not.toBe(openCodePaths.configPath)
    expect(piPaths.statePath).not.toBe(openCodePaths.statePath)
  })

  test('uses only the Pi agent directory when host file overrides are absent', () => {
    delete process.env.OPENCODE_OPENAI_AUTH_FILE
    delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    delete process.env.PI_OPENAI_AUTH_FILE
    delete process.env.PI_OPENAI_AUTH_STATE_FILE
    process.env.PI_AGENT_DIR = join(tempDir, 'agent-home')

    const piPaths = getPiAccountPaths()
    const openCodePaths = getOpenCodeAccountPaths()
    expect(getPiConfigDir()).toBe(join(tempDir, 'agent-home'))
    expect(getPiAccountStoragePath()).toBe(
      join(tempDir, 'agent-home', 'openai-auth.json'),
    )
    expect(getPiAccountStatePath()).toBe(
      join(tempDir, 'agent-home', 'openai-auth-state.json'),
    )
    expect(piPaths.configPath).not.toBe(openCodePaths.configPath)
    expect(piPaths.statePath).not.toBe(openCodePaths.statePath)
  })

  test('never lets an OpenCode state override capture a Pi removal', async () => {
    const redirectedOpenCodeState = join(
      tempDir,
      'redirected-opencode-state.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(tempDir, 'opencode-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = redirectedOpenCodeState
    process.env.PI_OPENAI_AUTH_FILE = join(tempDir, 'pi', 'openai-auth.json')
    delete process.env.PI_OPENAI_AUTH_STATE_FILE

    const piPaths = getPiAccountPaths()
    await saveAccounts(fixtureStorage([fixtureAccounts()[0]!]), piPaths)
    await registeredCommands()
      .get('openai-account')
      ?.handler('remove alpha', makePiContext([]))

    expect((await loadAccounts(piPaths))?.accounts).toEqual([])
    expect(existsSync(piPaths.statePath)).toBe(true)
    expect(existsSync(redirectedOpenCodeState)).toBe(false)

    const openCodePaths = getOpenCodeAccountPaths()
    writeFileSync(
      openCodePaths.configPath,
      `${JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [{ id: 'alpha', type: 'oauth', enabled: true }],
      })}\n`,
    )
    await buildOpenCodeDialogPayload(
      'openai-account',
      'remove alpha',
      await makeOpenCodeContext(openCodePaths),
    )

    expect(existsSync(redirectedOpenCodeState)).toBe(true)
  })
})
