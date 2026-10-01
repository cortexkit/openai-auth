import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MenuTerminal } from '@cortexkit/common-auth/auth-menu'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type AccountPaths,
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
} from '@cortexkit/openai-auth-core/internal'
import type { AuthHook, AuthOAuthResult } from '@opencode-ai/plugin'
import { authDoctorChecks } from '../auth/doctor'
import {
  type CreateAuthMethodsOptions,
  createAuthMethods,
} from '../auth/methods'
import { quotaMap, readJson, seedPool } from './fixtures/pool-install'

/** The six actions recorded in the auth-login capture. */
const CAPTURED_ACTIONS = [
  'Add account',
  'Auth current',
  'Check quotas',
  'Auth doctor',
  'Apply repairs',
  'Delete all accounts',
]

const DOWN = '\u001b[B'
const ENTER = '\r'

/**
 * A terminal that plays `keys` to whatever is listening, one at a time, and
 * records what is written. The shared menu reads keys only while a selector
 * listens, so each key goes to the selector open at the time.
 */
function scriptedTerminal(keys: string[]) {
  const queue = [...keys]
  let listener: ((data: string) => void) | undefined
  let written = ''
  const feed = () => {
    setTimeout(() => {
      if (!listener || queue.length === 0) return
      listener(queue.shift() as string)
      feed()
    }, 5)
  }
  const terminal = {
    input: {
      isTTY: true,
      isRaw: false,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (_event: 'data', handler: (data: string) => void) => {
        listener = handler
        feed()
        return undefined
      },
      removeListener: () => {
        listener = undefined
        return undefined
      },
    },
    output: {
      write: (text: string) => {
        written += text
        return true
      },
      columns: 120,
      rows: 40,
    },
  } as unknown as MenuTerminal
  return { terminal, written: () => written }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  mock.restore()
})

function tempPaths(): AccountPaths {
  const directory = mkdtempSync(join(tmpdir(), 'openai-auth-menu-'))
  tempDirs.push(directory)
  return {
    configPath: join(directory, 'openai-auth.json'),
    statePath: join(directory, 'openai-auth-state.json'),
  }
}

function account(
  id: string,
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 86_400_000,
    enabled: true,
    addedAt: 1,
    lastUsed: 1,
    ...overrides,
  }
}

async function seedStore(
  paths: AccountPaths,
  accounts: OAuthAccount[],
  mainAccountId = 'chatgpt-main',
) {
  await mutateAccounts((current) => {
    current.main = { type: 'opencode', provider: 'openai' }
    current.mainAccountId = mainAccountId
    current.accounts = structuredClone(accounts)
    return current
  }, paths)
}

function oauthMethod(methods: AuthHook['methods'], index: number) {
  const method = methods[index]
  if (method?.type !== 'oauth') {
    throw new Error(`Expected OAuth method at ${index}`)
  }
  return method
}

function createClient(initialAuth?: {
  type: string
  refresh?: string
  access?: string
  expires?: number
}) {
  let auth = initialAuth ? structuredClone(initialAuth) : undefined
  const set = mock(async (request: unknown) => {
    const body = (request as { body: typeof auth }).body
    auth = body ? structuredClone(body) : undefined
  })
  return {
    client: { auth: { set } } as unknown as CreateAuthMethodsOptions['client'],
    set,
    getAuth: async () => (auth ? structuredClone(auth) : undefined),
    current: () => (auth ? structuredClone(auth) : undefined),
  }
}

function successfulFlow(id = 'new-account') {
  return {
    url: 'https://auth.example/browser',
    instructions: 'Complete authorization in your browser.',
    completion: Promise.resolve(account(id, { accountId: `chatgpt-${id}` })),
  }
}

async function expectMenuCompletionFailed(result: AuthOAuthResult) {
  expect(result).toMatchObject({
    url: '',
    instructions: '',
    method: 'auto',
  })
  if (result.method !== 'auto') throw new Error('Expected automatic result')
  expect(await result.callback()).toEqual({ type: 'failed' })
}

function readStoreBytes(paths: AccountPaths) {
  return {
    config: readFileSync(paths.configPath, 'utf8'),
    state: readFileSync(paths.statePath, 'utf8'),
  }
}

describe('OpenCode auth method relocation', () => {
  test('keeps the three auth entries and their rendered login results byte-identical', async () => {
    const { client } = createClient()
    const success = async (url: string, instructions: string) => ({
      url,
      instructions,
      method: 'auto' as const,
      callback: async () => ({
        type: 'success' as const,
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 123_456,
        accountId: 'chatgpt-account',
      }),
    })
    const methods = createAuthMethods({
      client,
      dependencies: {
        authorizeBrowser: () =>
          success(
            'https://auth.example/browser',
            'Complete authorization in your browser. This window will close automatically.',
          ),
        authorizeHeadless: () =>
          success(
            'https://auth.openai.com/codex/device',
            'Enter code: ABCD-EFGH',
          ),
      },
    })

    expect(methods.map(({ label, type }) => ({ label, type }))).toEqual([
      { label: 'ChatGPT Pro/Plus (browser)', type: 'oauth' },
      { label: 'ChatGPT Pro/Plus (headless)', type: 'oauth' },
      { label: 'Manually enter API Key', type: 'api' },
    ])

    const browser = await oauthMethod(methods, 0).authorize()
    expect({
      url: browser.url,
      instructions: browser.instructions,
      method: browser.method,
    }).toEqual({
      url: 'https://auth.example/browser',
      instructions:
        'Complete authorization in your browser. This window will close automatically.',
      method: 'auto',
    })
    if (browser.method !== 'auto') throw new Error('Expected automatic result')
    expect(await browser.callback()).toEqual({
      type: 'success',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: 123_456,
      accountId: 'chatgpt-account',
    })

    const headless = await oauthMethod(methods, 1).authorize()
    expect({
      url: headless.url,
      instructions: headless.instructions,
      method: headless.method,
    }).toEqual({
      url: 'https://auth.openai.com/codex/device',
      instructions: 'Enter code: ABCD-EFGH',
      method: 'auto',
    })
    if (headless.method !== 'auto') throw new Error('Expected automatic result')
    expect(await headless.callback()).toEqual({
      type: 'success',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: 123_456,
      accountId: 'chatgpt-account',
    })
  })

  test('keeps TUI login and first CLI login on the original browser flow', async () => {
    const { client } = createClient()
    const authorizeBrowser = mock(async () => ({
      url: 'https://auth.example/browser',
      instructions: 'Browser instructions',
      method: 'auto' as const,
      callback: async () => ({ type: 'failed' as const }),
    }))
    const paths = tempPaths()
    const load = mock(async () => null)
    const { terminal, written } = scriptedTerminal([])
    const methods = createAuthMethods({
      client,
      getPaths: () => paths,
      dependencies: {
        authorizeBrowser,
        loadAccounts: load as never,
        terminal,
      },
    })

    const tui = await oauthMethod(methods, 0).authorize()
    expect(tui.url).toBe('https://auth.example/browser')
    expect(load).not.toHaveBeenCalled()

    const firstCli = await oauthMethod(methods, 0).authorize({})
    expect(firstCli.url).toBe('https://auth.example/browser')
    // The menu never drew: nothing was written to the terminal.
    expect(written()).toBe('')
  })
})

describe('OpenCode auth menu', () => {
  test('the recorded auth-login capture still says every action reports a failed login', () => {
    const baseline = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../docs/baselines/opencode-auth-menu.v1.18.30.txt',
          import.meta.url,
        ),
      ),
      'utf8',
    )
    const expectedStdout =
      '┌  Add credential\n\u001b[?25l│\n◆  Failed to authorize\n\u001b[?25h│\n└  Done\n\n'

    // The capture was taken with the six actions of the menu this one
    // replaced; it pins what OpenCode prints for a menu result, which the
    // shared menu returns unchanged (`menuCompletedResult`).
    for (const action of CAPTURED_ACTIONS) {
      const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const section = baseline.match(
        new RegExp(`\\[${escaped}\\]\\nexit_code=(\\d+)\\nstdout_json=(".*")`),
      )
      expect(section?.[1]).toBe('0')
      expect(JSON.parse(section?.[2] ?? 'null')).toBe(expectedStdout)
    }
    expect(baseline).not.toContain('Login successful')
  })

  function poolFiles() {
    const paths = tempPaths()
    return {
      paths,
      files: { configFile: paths.configPath, stateFile: paths.statePath },
    }
  }

  function menuMethods(
    paths: AccountPaths,
    keys: string[],
    overrides: Partial<
      NonNullable<CreateAuthMethodsOptions['dependencies']>
    > = {},
  ) {
    const { client } = createClient({ type: 'oauth', refresh: 'slot-refresh' })
    const scripted = scriptedTerminal(keys)
    const methods = createAuthMethods({
      client,
      getAuth: async () => ({ type: 'oauth', refresh: 'slot-refresh' }),
      getPaths: () => paths,
      dependencies: {
        terminal: scripted.terminal,
        openBrowser: async () => true,
        migrationBlockers: async () => [],
        ...overrides,
      },
    })
    return { method: oauthMethod(methods, 0), written: scripted.written }
  }

  test('opens on a migrated install and ends with the failed-callback result', async () => {
    const { paths, files } = poolFiles()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    // Escape cancels the menu without running anything.
    const { method, written } = menuMethods(paths, ['\u001b'])

    const result = await method.authorize({})

    await expectMenuCompletionFailed(result)
    expect(written()).toContain('Add account')
    expect(written()).toContain('Delete all accounts')
  })

  test('Add account adds the login as a pool row through the store', async () => {
    const { paths, files } = poolFiles()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const { method } = menuMethods(paths, [ENTER], {
      beginAccountLogin: (async () => successfulFlow('work')) as never,
    })

    await expectMenuCompletionFailed(await method.authorize({}))

    const rows = readJson(paths.configPath).accounts as Array<{ id: string }>
    expect(rows.map((row) => row.id)).toEqual(['main', 'work'])
    const state = readJson(paths.statePath).accounts as Record<
      string,
      { refresh?: string }
    >
    expect(state.work?.refresh).toBe('refresh-work')
  })

  test("Add account for an account a row holds replaces that row's credential", async () => {
    const { paths, files } = poolFiles()
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'alpha', quota: quotaMap(10) },
    ])
    const { method } = menuMethods(paths, [ENTER], {
      beginAccountLogin: (async () => ({
        ...successfulFlow('again'),
        completion: Promise.resolve(
          account('again', { accountId: 'chatgpt-alpha' }),
        ),
      })) as never,
    })

    await expectMenuCompletionFailed(await method.authorize({}))

    const rows = readJson(paths.configPath).accounts as Array<{ id: string }>
    expect(rows.map((row) => row.id)).toEqual(['main', 'alpha'])
    const state = readJson(paths.statePath).accounts as Record<
      string,
      { refresh?: string }
    >
    expect(state.alpha?.refresh).toBe('refresh-again')
  })

  test("Add account refuses the main account's ChatGPT account", async () => {
    const { paths, files } = poolFiles()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const { method } = menuMethods(paths, [ENTER], {
      beginAccountLogin: (async () => ({
        ...successfulFlow('again'),
        completion: Promise.resolve(
          account('again', { accountId: 'chatgpt-main' }),
        ),
      })) as never,
    })

    await expectMenuCompletionFailed(await method.authorize({}))

    const rows = readJson(paths.configPath).accounts as Array<{ id: string }>
    expect(rows.map((row) => row.id)).toEqual(['main'])
  })

  test('Delete all accounts keeps main and removes the rest through the store', async () => {
    const { paths, files } = poolFiles()
    seedPool(files, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'alpha', quota: quotaMap(10) },
      { id: 'beta', quota: quotaMap(10) },
    ])
    // Delete all is last of the seven actions; its confirmation lists No
    // first, so the yes is one step down.
    const { method } = menuMethods(paths, [
      ...Array(6).fill(DOWN),
      ENTER,
      DOWN,
      ENTER,
    ])

    await expectMenuCompletionFailed(await method.authorize({}))

    const rows = readJson(paths.configPath).accounts as Array<{ id: string }>
    expect(rows.map((row) => row.id)).toEqual(['main'])
    expect(Object.keys(readJson(paths.statePath).accounts as object)).toEqual([
      'main',
    ])
  })

  test('before the move the menu offers only the doctor, and names what holds the move back', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('fallback-a')])
    const before = readStoreBytes(paths)
    const { method, written } = menuMethods(paths, ['\u001b'], {
      migrationBlockers: async () => [{ pid: 4242, version: '0.10.0' }],
    })

    await expectMenuCompletionFailed(await method.authorize({}))

    expect(written()).toContain('pid 4242: version 0.10.0')
    expect(written()).toContain('Auth doctor')
    expect(written()).not.toContain('Add account')
    expect(readStoreBytes(paths)).toEqual(before)
  })

  test('the doctor offers the legacy-file repairs only before the move', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('fallback-a')])
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        version: 1,
        accounts: {
          ...(readJson(paths.statePath).accounts as object),
          orphan: { refresh: 'orphan-refresh' },
        },
      }),
    )
    const checks = (migrated: boolean) =>
      authDoctorChecks({
        paths,
        migrated,
        readAuth: async () => ({ type: 'oauth', refresh: 'slot-refresh' }),
        loadAccounts,
        readStoreIds: async () => ({
          rosterIds: ['fallback-a'],
          stateIds: ['fallback-a', 'orphan'],
          orphanStateIds: ['orphan'],
        }),
        mutateAccounts,
        setMainAuth: async () => {},
        now: Date.now,
      })

    const [legacy] = checks(false)
    const legacyOrphans = (await legacy?.run())?.find(
      (finding) => finding.code === 'orphan-state-ids',
    )
    expect(legacyOrphans?.repair?.label).toContain('orphan')

    const [migrated] = checks(true)
    const migratedOrphans = (await migrated?.run())?.find(
      (finding) => finding.code === 'orphan-state-ids',
    )
    expect(migratedOrphans).toBeDefined()
    expect(migratedOrphans?.repair).toBeUndefined()
  })
})

// The doctor's restore repair writes OpenCode's slot. It must hold the
// `main-refresh` lock the account-pool migration holds around its last slot
// read and placeholder write, or the restore can land in between and be
// erased by the placeholder.
describe('the doctor restore writes the slot under main-refresh', () => {
  const PLACEHOLDER = {
    type: 'oauth',
    access: '',
    refresh: 'common-auth-placeholder:v1:openai',
    expires: 0,
  }

  async function restoreSetup() {
    const paths = tempPaths()
    // A stored `main` row whose token differs from the slot's: the doctor
    // offers to copy it back into the slot.
    await seedStore(paths, [account('main', { accountId: 'chatgpt-main' })])
    let slot: Record<string, unknown> = {
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1,
    }
    const writes: Array<{ at: number; body: unknown }> = []
    const client = {
      auth: {
        set: async (request: { body: Record<string, unknown> }) => {
          writes.push({ at: performance.now(), body: request.body })
          slot = structuredClone(request.body)
        },
      },
    } as unknown as CreateAuthMethodsOptions['client']
    // The install is not migrated to the account pool yet, so the menu offers
    // only the doctor: Enter runs it, then Down and Enter answer yes to its
    // restore repair (the confirmation lists No first).
    const scripted = scriptedTerminal([ENTER, DOWN, ENTER])
    const methods = createAuthMethods({
      client,
      getAuth: async () => structuredClone(slot) as never,
      getPaths: () => paths,
      dependencies: {
        terminal: scripted.terminal,
        migrationBlockers: async () => [],
      },
    })
    return {
      paths,
      writes,
      setSlot: (value: Record<string, unknown>) => {
        slot = value
      },
      run: () => oauthMethod(methods, 0).authorize({}),
    }
  }

  test('waits for a held main-refresh lock before writing the slot', async () => {
    const setup = await restoreSetup()
    const held = await acquireRefreshFileLock({
      name: 'main-refresh',
      ttlMs: 60_000,
      path: setup.paths.configPath,
    })
    if (!held) throw new Error('could not take main-refresh')
    let releasedAt = 0
    const releasing = (async () => {
      await Bun.sleep(400)
      releasedAt = performance.now()
      await held.release()
    })()

    await expectMenuCompletionFailed(await setup.run())
    await releasing

    expect(setup.writes.map((write) => write.body)).toEqual([
      {
        type: 'oauth',
        refresh: 'refresh-main',
        access: 'access-main',
        expires: expect.any(Number),
      },
    ])
    expect(setup.writes[0]?.at).toBeGreaterThanOrEqual(releasedAt)
  })

  test('writes nothing when the slot became the placeholder while it waited', async () => {
    const setup = await restoreSetup()
    const held = await acquireRefreshFileLock({
      name: 'main-refresh',
      ttlMs: 60_000,
      path: setup.paths.configPath,
    })
    if (!held) throw new Error('could not take main-refresh')
    const releasing = (async () => {
      await Bun.sleep(400)
      // The migration, holding the lock, puts the placeholder in.
      setup.setSlot({ ...PLACEHOLDER })
      await held.release()
    })()

    await expectMenuCompletionFailed(await setup.run())
    await releasing

    expect(setup.writes).toEqual([])
  })
})
