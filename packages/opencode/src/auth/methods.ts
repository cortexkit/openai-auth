import { execFileSync as defaultExecFileSync } from 'node:child_process'
import {
  base64UrlEncode,
  beginAccountLogin,
  beginDeviceAuth,
  buildAuthorizeUrl,
  claustrumMode,
  completeDeviceAuth,
  extractAccountId,
  flowCleanup,
  generatePKCE,
  isOAuthAccount,
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
  QuotaManager,
  type RefreshAllQuotaDeps,
  type RefreshAllQuotaResult,
  refreshAllQuota,
  startOAuthServer,
  upsertAccount,
  waitForOAuthCallback,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import type {
  AuthHook,
  AuthOAuthResult,
  PluginInput,
} from '@opencode-ai/plugin'
import { getConfigPath } from '../config'
import { type AccountPaths, getAccountPaths } from '../core/account-paths'
import { PackageVersion } from '../version'
import {
  type AuthDetails,
  createAuthDoctorReport,
  findStoredMainCredential,
  formatAuthDoctorReport,
  readStoreIds,
} from './doctor'
import { type AuthMenuAction, showAuthMenu } from './ui/auth-menu'
import { confirm } from './ui/confirm'

type AuthMethod = AuthHook['methods'][number]
type BeginLogin = typeof beginAccountLogin
type BrowserExec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => unknown

export interface AuthMethodDependencies {
  authorizeBrowser(): Promise<AuthOAuthResult>
  authorizeHeadless(): Promise<AuthOAuthResult>
  beginAccountLogin: BeginLogin
  loadAccounts: typeof loadAccounts
  mutateAccounts: typeof mutateAccounts
  refreshAllQuota: typeof refreshAllQuota
  showAuthMenu: typeof showAuthMenu
  confirm: typeof confirm
  readStoreIds: typeof readStoreIds
  openBrowser(url: string): boolean | undefined | Promise<boolean | undefined>
  now(): number
  custodyQuotaDeps: Pick<
    RefreshAllQuotaDeps,
    | 'isFallbackRefreshInert'
    | 'resolveFallbackAccess'
    | 'reportCustodyAuthFailure'
  >
}

export interface CreateAuthMethodsOptions {
  client: Pick<PluginInput['client'], 'auth'>
  /** Resolves the callback captured by auth.loader, or undefined before it runs. */
  getAuth?: () => Promise<AuthDetails | undefined>
  getPaths?: () => AccountPaths
  fetchImpl?: typeof fetch
  packageVersion?: string
  dependencies?: Partial<AuthMethodDependencies>
}

export function openBrowserForMenu(
  url: string,
  platform: NodeJS.Platform = process.platform,
  execFileSync: BrowserExec = defaultExecFileSync,
): boolean {
  try {
    if (platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], {
        stdio: 'ignore',
        timeout: 3000,
      })
    } else {
      execFileSync(platform === 'darwin' ? 'open' : 'xdg-open', [url], {
        stdio: 'ignore',
        timeout: 3000,
      })
    }
    return true
  } catch {
    return false
  }
}

export function completedMenuResult(): AuthOAuthResult {
  return {
    url: '',
    instructions: '',
    method: 'auto',
    callback: async () => ({ type: 'failed' }),
  }
}

async function authorizeBrowser(): Promise<AuthOAuthResult> {
  const { redirectUri } = await startOAuthServer()
  const pkce = await generatePKCE()
  const state = base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(32)).buffer,
  )
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
  const callbackPromise = waitForOAuthCallback(pkce, state)

  return {
    url: authUrl,
    instructions:
      'Complete authorization in your browser. This window will close automatically.',
    method: 'auto',
    callback: async () => {
      try {
        const tokens = await callbackPromise
        return {
          type: 'success',
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          accountId: extractAccountId(tokens),
        }
      } finally {
        flowCleanup(state)
      }
    },
  }
}

async function authorizeHeadless(version: string): Promise<AuthOAuthResult> {
  const { deviceData, url, instructions } = await beginDeviceAuth(version)
  return {
    url,
    instructions,
    method: 'auto',
    async callback() {
      try {
        const tokens = await completeDeviceAuth(deviceData, version)
        return {
          type: 'success',
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          accountId: extractAccountId(tokens),
        }
      } catch {
        return { type: 'failed' }
      }
    },
  }
}

function printLogin(flow: { url: string; instructions: string }) {
  console.log('\nOpen this URL in your browser and complete sign-in:\n')
  console.log(`${flow.url}\n`)
  if (flow.instructions) console.log(`${flow.instructions}\n`)
}

/** Build the three OpenCode auth entries and keep CLI-only management inside the browser entry. */
export function createAuthMethods({
  client,
  getAuth,
  getPaths = () => getAccountPaths(getConfigPath()),
  fetchImpl = fetch,
  packageVersion = PackageVersion,
  dependencies,
}: CreateAuthMethodsOptions): AuthMethod[] {
  const deps: AuthMethodDependencies = {
    authorizeBrowser: dependencies?.authorizeBrowser ?? authorizeBrowser,
    authorizeHeadless:
      dependencies?.authorizeHeadless ??
      (() => authorizeHeadless(packageVersion)),
    beginAccountLogin: dependencies?.beginAccountLogin ?? beginAccountLogin,
    loadAccounts: dependencies?.loadAccounts ?? loadAccounts,
    mutateAccounts: dependencies?.mutateAccounts ?? mutateAccounts,
    refreshAllQuota: dependencies?.refreshAllQuota ?? refreshAllQuota,
    showAuthMenu: dependencies?.showAuthMenu ?? showAuthMenu,
    confirm: dependencies?.confirm ?? confirm,
    readStoreIds: dependencies?.readStoreIds ?? readStoreIds,
    openBrowser: dependencies?.openBrowser ?? openBrowserForMenu,
    now: dependencies?.now ?? Date.now,
    custodyQuotaDeps: dependencies?.custodyQuotaDeps ?? {},
  }

  const readAuth = async (): Promise<AuthDetails> =>
    (await getAuth?.().catch(() => undefined)) ?? { type: 'missing' }

  /**
   * Whether this machine is past its first sign-in.
   *
   * A signed-in account is the thing that makes the menu meaningful, and it is
   * usually the only account there is: fallbacks are stored separately and a
   * normal store starts with none. Asking about the fallback roster instead
   * would hide the menu from exactly the person who came to add their first
   * one — and since the standalone command was removed, a headless machine
   * would have no way to add it at all.
   */
  const hasSomethingToManage = async (): Promise<boolean> => {
    if ((await readAuth()).type !== 'missing') return true
    const storage = await deps.loadAccounts(getPaths())
    return (storage?.accounts.length ?? 0) > 0
  }
  const setMainAuth = async (credential: {
    refresh: string
    access?: string
    expires?: number
  }) => {
    await client.auth.set({
      path: { id: 'openai' },
      body: { type: 'oauth', ...credential },
    } as never)
  }

  const runOwnedLogin = async () => {
    const abort = new AbortController()
    let flow = await deps.beginAccountLogin({
      version: packageVersion,
      signal: abort.signal,
    })
    // The rejection handler is attached before the opener runs because an
    // immediate opener failure aborts this browser flow in the same turn.
    void flow.completion.catch(() => {})
    printLogin(flow)

    let opened = false
    try {
      opened = (await deps.openBrowser(flow.url)) !== false
    } catch {
      opened = false
    }
    if (!opened) {
      abort.abort()
      console.log(
        'Could not open a browser. Switching to device authorization.\n',
      )
      flow = await deps.beginAccountLogin({
        version: packageVersion,
        headless: true,
      })
      printLogin(flow)
    }
    return flow.completion
  }

  const addAccount = async () => {
    const storage = await deps.loadAccounts(getPaths())
    if (claustrumMode(storage) === 'claustrum') {
      console.log(
        'That account cannot be added while Claustrum mode is active. Run `/openai-account local` first.',
      )
      return
    }
    const account = await runOwnedLogin()
    let selfFallback = false
    await deps.mutateAccounts((current) => {
      if (
        account.accountId &&
        current.mainAccountId &&
        account.accountId === current.mainAccountId
      ) {
        selfFallback = true
        return current
      }
      upsertAccount(current.accounts, account as OAuthAccount)
      return current
    }, getPaths())
    if (selfFallback) {
      console.log('That account is already the OpenCode main credential.')
      return
    }
    console.log(`Added fallback account ${account.id}.`)
  }

  const authCurrent = async () => {
    const account = await runOwnedLogin()
    await setMainAuth({
      refresh: account.refresh,
      access: account.access ?? '',
      expires: account.expires ?? 0,
    })
    console.log('Updated the OpenCode main credential.')
  }

  const checkQuotas = async () => {
    const paths = getPaths()
    const storage = await deps.loadAccounts(paths)
    const quotaManager = new QuotaManager({
      storage,
      configPath: paths.configPath,
      fetchImpl,
      now: deps.now,
    })
    // A quota check may update quota cache fields, but it must never rotate or
    // persist credentials. The shared refresher still owns account iteration,
    // normalization, and result reporting. Its `respectBackoff: false` bypasses
    // quota backoff; the copied load view below removes refresh backoff for this
    // one manual poll without clearing the persisted diagnosis.
    const fallbackManager = {
      refreshAccount: async (candidate: OAuthAccount) => candidate,
    } as unknown as RefreshAllQuotaDeps['fallbackManager']
    const noCredentialRefresh = async () => {
      throw new Error('No usable main access token for quota check')
    }

    const loadForQuotaCheck: typeof loadAccounts = async (requestedPaths) => {
      const current = await deps.loadAccounts(requestedPaths)
      if (!current) return null
      return {
        ...current,
        accounts: current.accounts.map((candidate) =>
          isOAuthAccount(candidate)
            ? { ...candidate, lastRefreshError: undefined }
            : { ...candidate },
        ),
      }
    }

    const results = await deps.refreshAllQuota({
      getAuth: readAuth,
      codexRefreshFn: noCredentialRefresh,
      refreshMainWithLease: noCredentialRefresh,
      fallbackManager,
      quotaManager,
      loadAccounts: loadForQuotaCheck,
      writeSidebarState: async () => {},
      client: {
        auth: {
          set: async () => {
            throw new Error('Quota checks cannot write credentials')
          },
        },
      },
      fetchImpl,
      now: deps.now,
      paths,
      storageMainAccountId: storage?.mainAccountId,
      isOAuthAccountFn: isOAuthAccount,
      whamFn: whamUsageFn,
      respectBackoff: false,
      readSidebarState: async () => ({ main: {}, fallbacks: [] }),
      ...deps.custodyQuotaDeps,
    })
    printQuotaResults(results)
  }

  const doctor = async () => {
    const paths = getPaths()
    const [storage, ids, auth] = await Promise.all([
      deps.loadAccounts(paths),
      deps.readStoreIds(paths),
      readAuth(),
    ])
    const report = createAuthDoctorReport({
      auth: auth.type === 'missing' ? undefined : auth,
      storage,
      orphanStateIds: ids.orphanStateIds,
      now: deps.now(),
    })
    console.log(formatAuthDoctorReport(report))
    return report
  }

  const applyRepairs = async () => {
    const report = await doctor()
    if (report.repairs.length === 0) {
      console.log('No repairs are available.')
      return
    }
    if (!(await deps.confirm('Apply the listed auth repairs?'))) {
      console.log('Repairs cancelled.')
      return
    }

    const paths = getPaths()
    for (const repair of report.repairs) {
      if (repair.type === 'restore-main-credential') {
        const storage = await deps.loadAccounts(paths)
        const account = findStoredMainCredential(storage)
        if (!account) continue
        await setMainAuth({
          refresh: account.refresh,
          access: account.access ?? '',
          expires: account.expires ?? 0,
        })
        continue
      }
      if (repair.type === 'prune-orphan-state-ids') {
        await deps.mutateAccounts((current) => current, paths)
        continue
      }
      await deps.mutateAccounts((current) => {
        const account = current.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === repair.accountId && isOAuthAccount(candidate),
        )
        if (account) account.lastRefreshError = undefined
        return current
      }, paths)
    }
    console.log(`Applied ${report.repairs.length} auth repair(s).`)
  }

  const deleteAllAccounts = async () => {
    if (!(await deps.confirm('Delete all fallback accounts?'))) {
      console.log('Delete cancelled.')
      return
    }
    const allowDrop: string[] = []
    await deps.mutateAccounts(
      (current, context) => {
        const removed = new Set(
          [
            ...(context?.rawRosterIds ?? []),
            ...current.accounts.map((account) => account.id),
          ].filter((accountId) => accountId !== 'main'),
        )
        allowDrop.splice(0, allowDrop.length, ...removed)
        current.accounts = current.accounts.filter(
          (account) => account.id === 'main',
        )
        return current
      },
      getPaths(),
      { allowDrop },
    )
    console.log('Deleted all fallback accounts.')
  }

  const runMenuAction = async (action: AuthMenuAction) => {
    switch (action) {
      case 'add-account':
        await addAccount()
        break
      case 'auth-current':
        await authCurrent()
        break
      case 'check-quotas':
        await checkQuotas()
        break
      case 'auth-doctor':
        await doctor()
        break
      case 'apply-repairs':
        await applyRepairs()
        break
      case 'delete-all':
        await deleteAllAccounts()
        break
      case 'cancel':
        break
    }
  }

  return [
    {
      label: 'ChatGPT Pro/Plus (browser)',
      type: 'oauth',
      authorize: async (inputs?: Record<string, string>) => {
        // `inputs` is only present when this runs from `opencode auth login`;
        // the TUI never sends it, so the TUI always signs in as before.
        if (inputs && (await hasSomethingToManage())) {
          await runMenuAction(await deps.showAuthMenu())
          return completedMenuResult()
        }

        return deps.authorizeBrowser()
      },
    },
    {
      label: 'ChatGPT Pro/Plus (headless)',
      type: 'oauth',
      authorize: deps.authorizeHeadless,
    },
    {
      label: 'Manually enter API Key',
      type: 'api',
    },
  ]
}

function printQuotaResults(results: readonly RefreshAllQuotaResult[]) {
  for (const result of results) {
    console.log(
      result.ok
        ? `${result.account}: quota refreshed`
        : `${result.account}: ${result.error ?? 'quota refresh failed'}`,
    )
  }
}
