import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AccountPaths,
  hashRefreshToken,
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
} from '@cortexkit/openai-auth-core/internal'
import type { AuthHook, AuthOAuthResult } from '@opencode-ai/plugin'
import {
  type CreateAuthMethodsOptions,
  createAuthMethods,
} from '../auth/methods'
import { AUTH_MENU_ACTIONS } from '../auth/ui/auth-menu'

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
    const load = mock(async () => null)
    const show = mock(async () => 'delete-all' as const)
    const methods = createAuthMethods({
      client,
      dependencies: {
        authorizeBrowser,
        loadAccounts: load as never,
        showAuthMenu: show,
      },
    })

    const tui = await oauthMethod(methods, 0).authorize()
    expect(tui.url).toBe('https://auth.example/browser')
    expect(load).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()

    const firstCli = await oauthMethod(methods, 0).authorize({})
    expect(firstCli.url).toBe('https://auth.example/browser')
    expect(load).toHaveBeenCalledTimes(1)
    expect(show).not.toHaveBeenCalled()
  })
})

describe('OpenCode auth menu', () => {
  test('renders exactly the six approved actions', () => {
    expect(AUTH_MENU_ACTIONS).toEqual([
      'Add account',
      'Auth current',
      'Check quotas',
      'Auth doctor',
      'Apply repairs',
      'Delete all accounts',
    ])
  })

  // Reads the committed capture only. It does not run OpenCode, so it cannot
  // notice the host changing what it prints; what it does catch is someone
  // editing the record of what an operator sees without meaning to. The
  // behaviour behind it is defended by the tests that exercise the callback.
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

    for (const action of AUTH_MENU_ACTIONS) {
      const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const section = baseline.match(
        new RegExp(`\\[${escaped}\\]\\nexit_code=(\\d+)\\nstdout_json=(".*")`),
      )
      expect(section?.[1]).toBe('0')
      expect(JSON.parse(section?.[2] ?? 'null')).toBe(expectedStdout)
    }
    expect(baseline).not.toContain('Login successful')
  })

  test('opening and cancelling the menu performs no network calls', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('fallback')])
    const { client } = createClient()
    let networkCalls = 0
    const methods = createAuthMethods({
      client,
      getPaths: () => paths,
      fetchImpl: (async () => {
        networkCalls += 1
        throw new Error('unexpected network call')
      }) as unknown as typeof fetch,
      dependencies: { showAuthMenu: async () => 'cancel' },
    })

    const result = await oauthMethod(methods, 0).authorize({})

    expect(networkCalls).toBe(0)
    await expectMenuCompletionFailed(result)
  })

  // The state every ordinary user is in: signed in, no fallbacks yet. Gating
  // the menu on the fallback roster hid it from exactly the person who came to
  // add their first one, on a machine where the removed binary was the only
  // other way to do it.
  test('opens for a signed-in user who has no fallback accounts yet', async () => {
    const paths = tempPaths()
    await seedStore(paths, [])
    const { client, getAuth } = createClient({
      type: 'oauth',
      refresh: 'main-refresh',
      access: 'main-access',
      expires: Date.now() + 86_400_000,
    })
    const show = mock(async () => 'cancel' as const)
    const authorizeBrowser = mock(async () => ({
      url: 'https://auth.example/browser',
      instructions: 'Browser instructions',
      method: 'auto' as const,
      callback: async () => ({ type: 'failed' as const }),
    }))
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      dependencies: { showAuthMenu: show, authorizeBrowser },
    })

    const result = await oauthMethod(methods, 0).authorize({})

    expect(show).toHaveBeenCalledTimes(1)
    expect(authorizeBrowser).not.toHaveBeenCalled()
    await expectMenuCompletionFailed(result)
  })

  test('Add account falls back to device flow when the browser opener throws', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('existing')])
    const main = {
      type: 'oauth',
      refresh: 'main-refresh',
      access: 'main-access',
      expires: 999,
    }
    const { client, set, getAuth, current } = createClient(main)
    const starts: boolean[] = []
    const beginAccountLogin = mock(
      async (options: { headless?: boolean; signal?: AbortSignal }) => {
        starts.push(options.headless === true)
        if (options.headless) {
          return {
            url: 'https://auth.openai.com/codex/device',
            instructions: 'Enter code: DEVICE-CODE',
            completion: Promise.resolve(
              account('device-account', {
                accountId: 'chatgpt-device-account',
              }),
            ),
          }
        }
        return {
          url: 'https://auth.example/browser',
          instructions: 'Browser instructions',
          completion: new Promise<OAuthAccount>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new Error('Login cancelled')),
            )
          }),
        }
      },
    )
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => 'add-account',
        beginAccountLogin: beginAccountLogin as never,
        openBrowser: async () => {
          throw new Error('no browser')
        },
      },
    })

    const result = await oauthMethod(methods, 0).authorize({})

    expect(starts).toEqual([false, true])
    expect(log.mock.calls.flat().map(String).join('\n')).toContain(
      'https://auth.openai.com/codex/device',
    )
    expect(log.mock.calls.flat().map(String).join('\n')).toContain(
      'Enter code: DEVICE-CODE',
    )
    expect((await loadAccounts(paths))?.accounts.map(({ id }) => id)).toEqual([
      'existing',
      'device-account',
    ])
    expect(set).not.toHaveBeenCalled()
    expect(current()).toEqual(main)
    await expectMenuCompletionFailed(result)
  })

  test('Auth current changes only the OpenCode main credential', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('fallback')])
    const before = readStoreBytes(paths)
    const { client, set, getAuth, current } = createClient({
      type: 'oauth',
      refresh: 'old-main-refresh',
      access: 'old-main-access',
      expires: 1,
    })
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => 'auth-current',
        beginAccountLogin: (async () => ({
          ...successfulFlow('new-main'),
          completion: Promise.resolve(
            account('new-main', {
              refresh: 'new-main-refresh',
              access: 'new-main-access',
              expires: 777,
            }),
          ),
        })) as never,
        openBrowser: async () => true,
      },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(set).toHaveBeenCalledTimes(1)
    expect(current()).toEqual({
      type: 'oauth',
      refresh: 'new-main-refresh',
      access: 'new-main-access',
      expires: 777,
    })
    expect(readStoreBytes(paths)).toEqual(before)
    await expectMenuCompletionFailed(result)
  })

  test('Check quotas bypasses an armed backoff and performs one fetch per account', async () => {
    const paths = tempPaths()
    const now = Date.now()
    await seedStore(paths, [
      account('fallback', {
        lastRefreshError: {
          message: 'Token refresh failed: 401',
          checkedAt: now,
          nextRetryAt: now + 24 * 60 * 60_000,
          tokenHash: hashRefreshToken('refresh-fallback'),
        },
      }),
    ])
    const main = {
      type: 'oauth',
      refresh: 'main-refresh',
      access: 'main-access',
      expires: now + 86_400_000,
    }
    const { client, set, getAuth, current } = createClient(main)
    const fetchedAuthorization: string[] = []
    const fetchImpl = mock(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      fetchedAuthorization.push(headers.get('authorization') ?? '')
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dependencies: { showAuthMenu: async () => 'check-quotas' },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchedAuthorization).toEqual([
      'Bearer main-access',
      'Bearer access-fallback',
    ])
    expect(set).not.toHaveBeenCalled()
    expect(current()).toEqual(main)
    const stored = await loadAccounts(paths)
    expect(
      stored?.accounts.map(({ id, enabled }) => ({ id, enabled })),
    ).toEqual([{ id: 'fallback', enabled: true }])
    expect((stored?.accounts[0] as OAuthAccount | undefined)?.refresh).toBe(
      'refresh-fallback',
    )
    await expectMenuCompletionFailed(result)
  })

  test('Auth doctor leaves both store files byte-unchanged', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('main', { accountId: 'chatgpt-main' })])
    const before = readStoreBytes(paths)
    const { client, set, getAuth } = createClient({
      type: 'oauth',
      refresh: 'refresh-main',
      access: 'access-main',
      expires: 123,
    })
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      dependencies: { showAuthMenu: async () => 'auth-doctor' },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(readStoreBytes(paths)).toEqual(before)
    expect(set).not.toHaveBeenCalled()
    await expectMenuCompletionFailed(result)
  })

  test('Apply repairs performs only the three declared mutations', async () => {
    const paths = tempPaths()
    const now = Date.now()
    await seedStore(paths, [
      account('main', {
        accountId: 'chatgpt-main',
        lastRefreshError: {
          message: 'Token refresh failed: 401',
          checkedAt: now,
          nextRetryAt: now + 24 * 60 * 60_000,
          tokenHash: hashRefreshToken('refresh-main'),
        },
      }),
    ])
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as {
      accounts: Record<string, unknown>
    }
    state.accounts.orphan = { refresh: 'orphan-secret' }
    writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`)

    const { client, set, getAuth, current } = createClient()
    const mutate = mock(async (...args: Parameters<typeof mutateAccounts>) =>
      mutateAccounts(...args),
    )
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => 'apply-repairs',
        confirm: async () => true,
        mutateAccounts: mutate,
        now: () => now,
      },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(set).toHaveBeenCalledTimes(1)
    expect(current()).toEqual({
      type: 'oauth',
      refresh: 'refresh-main',
      access: 'access-main',
      expires: expect.any(Number),
    })
    expect(mutate).toHaveBeenCalledTimes(2)
    const repaired = await loadAccounts(paths)
    expect(repaired?.accounts.map(({ id }) => id)).toEqual(['main'])
    const repairedMain = repaired?.accounts[0] as OAuthAccount | undefined
    expect(repairedMain?.lastRefreshError).toBeUndefined()
    expect(repairedMain?.refresh).toBe('refresh-main')
    const repairedState = JSON.parse(readFileSync(paths.statePath, 'utf8')) as {
      accounts: Record<string, unknown>
    }
    expect(Object.keys(repairedState.accounts)).toEqual(['main'])
    await expectMenuCompletionFailed(result)
  })

  test('declining Apply repairs leaves both files byte-unchanged', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('main', { accountId: 'chatgpt-main' })])
    const before = readStoreBytes(paths)
    const { client, set } = createClient()
    const mutate = mock(async (...args: Parameters<typeof mutateAccounts>) =>
      mutateAccounts(...args),
    )
    const methods = createAuthMethods({
      client,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => 'apply-repairs',
        confirm: async () => false,
        mutateAccounts: mutate,
      },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(readStoreBytes(paths)).toEqual(before)
    await expectMenuCompletionFailed(result)
  })

  test('Delete all removes every non-main raw id and prunes matching state', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('main'), account('fallback')])
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8')) as {
      accounts: Array<Record<string, unknown>>
    }
    config.accounts.push({ id: 'load-dropped', type: 'oauth', enabled: true })
    writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`)
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as {
      accounts: Record<string, unknown>
    }
    state.accounts['load-dropped'] = { refresh: '' }
    state.accounts['state-only'] = { refresh: 'orphan-secret' }
    writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`)

    const main = {
      type: 'oauth',
      refresh: 'provider-refresh',
      access: 'provider-access',
      expires: 99,
    }
    const { client, set, getAuth, current } = createClient(main)
    let allowed: readonly string[] | undefined
    const mutate = mock(async (...args: Parameters<typeof mutateAccounts>) => {
      allowed = args[2]?.allowDrop
      return mutateAccounts(...args)
    })
    const methods = createAuthMethods({
      client,
      getAuth,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => 'delete-all',
        confirm: async () => true,
        mutateAccounts: mutate,
      },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(allowed).toEqual(
      ['main', 'fallback', 'load-dropped'].filter((id) => id !== 'main'),
    )
    const configAfter = JSON.parse(readFileSync(paths.configPath, 'utf8')) as {
      accounts: Array<{ id: string }>
    }
    expect(configAfter.accounts.map(({ id }) => id)).toEqual(['main'])
    const stateAfter = JSON.parse(readFileSync(paths.statePath, 'utf8')) as {
      accounts: Record<string, unknown>
    }
    expect(Object.keys(stateAfter.accounts)).toEqual(['main'])
    expect(set).not.toHaveBeenCalled()
    expect(current()).toEqual(main)
    await expectMenuCompletionFailed(result)
  })

  test('declining Delete all leaves both files byte-unchanged', async () => {
    const paths = tempPaths()
    await seedStore(paths, [account('fallback')])
    const before = readStoreBytes(paths)
    const { client, set } = createClient({
      type: 'oauth',
      refresh: 'provider-refresh',
    })
    const mutate = mock(async (...args: Parameters<typeof mutateAccounts>) =>
      mutateAccounts(...args),
    )
    const methods = createAuthMethods({
      client,
      getPaths: () => paths,
      dependencies: {
        showAuthMenu: async () => 'delete-all',
        confirm: async () => false,
        mutateAccounts: mutate,
      },
    })
    spyOn(console, 'log').mockImplementation(() => {})

    const result = await oauthMethod(methods, 0).authorize({})

    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(readStoreBytes(paths)).toEqual(before)
    await expectMenuCompletionFailed(result)
  })
})
