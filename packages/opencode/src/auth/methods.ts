import { readFile } from 'node:fs/promises'
import {
  type AccountMenuOptions,
  type AuthorizeInputs,
  type DoctorCheck,
  doctorAction,
  type LoginAccount,
  type MenuAction,
  type MenuLogin,
  type MenuOutcome,
  type MenuTerminal,
  menuAuthorize,
  menuCompletedResult,
  openBrowserForMenu,
  poolHasCredential,
  runAccountMenu,
  runMenu,
} from '@cortexkit/common-auth/auth-menu'
import { enrollmentAuthority } from '@cortexkit/common-auth/claustrum'
import type { PoolRow, PoolStore } from '@cortexkit/common-auth/store'
import {
  type MigrationBlocker,
  withAccountRules,
} from '@cortexkit/openai-auth-core'
import {
  base64UrlEncode,
  beginAccountLogin,
  beginDeviceAuth,
  buildAuthorizeUrl,
  completeDeviceAuth,
  extractAccountId,
  flowCleanup,
  generatePKCE,
  loadAccounts,
  mutateAccounts,
  type OpenAiVault,
  POOL_MAIN_ROW_ID,
  startOAuthServer,
  type VaultWaitOptions,
  vaultApprovalInstructions,
  vaultConnectOutcome,
  vaultEnrollmentLine,
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
import { opencodeAuthPath } from '../core/host-slot'
import {
  migratedPoolRows,
  openAccountPool,
  poolRemovalRefusal,
  poolSettingsLocks,
} from '../core/pool-accounts'
import { isPoolMainPlaceholder } from '../core/pool-main'
import {
  legacyRefreshLocks,
  POOL_PLACEHOLDER,
  withMainRefreshLock,
} from '../core/pool-migration'
import { observationFromSnapshot } from '../core/pool-quota'
import { migrationFenceOpen } from '../core/version-fence'
import { PackageVersion } from '../version'
import { type AuthDetails, authDoctorChecks, readStoreIds } from './doctor'
import { runVaultAccountMenu } from './vault-account-menu'

type AuthMethod = AuthHook['methods'][number]
type BeginLogin = typeof beginAccountLogin

export { menuCompletedResult, openBrowserForMenu }

export interface AuthMethodDependencies {
  authorizeBrowser(): Promise<AuthOAuthResult>
  authorizeHeadless(): Promise<AuthOAuthResult>
  beginAccountLogin: BeginLogin
  loadAccounts: typeof loadAccounts
  /** The legacy writer the doctor's repairs use on an install that has not migrated. */
  mutateAccounts: typeof mutateAccounts
  readStoreIds: typeof readStoreIds
  openBrowser(url: string): boolean | undefined | Promise<boolean | undefined>
  now(): number
  /** Opens the account pool's store (a migrated install's accounts). */
  openAccountPool: typeof openAccountPool
  /** The processes holding the migration back (the version fence's blockers). */
  migrationBlockers(): Promise<readonly MigrationBlocker[]>
  /** The terminal the menu draws on; the process's own by default. */
  terminal?: MenuTerminal
  /** How Connect waits for the operator's approval (tests shorten it). */
  vaultWait?: VaultWaitOptions
}

export interface CreateAuthMethodsOptions {
  client: Pick<PluginInput['client'], 'auth'>
  /** Resolves the callback captured by auth.loader, or undefined before it runs. */
  getAuth?: () => Promise<AuthDetails | undefined>
  getPaths?: () => AccountPaths
  fetchImpl?: typeof fetch
  packageVersion?: string
  dependencies?: Partial<AuthMethodDependencies>
  /**
   * Called, and awaited, after these methods write a credential into
   * OpenCode's `openai` slot themselves (the doctor's restore repair). The
   * plugin adopts it into the account pool there on a migrated install; a
   * failure never fails the repair.
   */
  onMainSlotWritten?: () => Promise<void>
  /**
   * This host's connection to the Claustrum vault. With it, the menu of a
   * migrated install offers to connect (enroll) this host.
   */
  vault?: Pick<
    OpenAiVault,
    | 'host'
    | 'name'
    | 'paths'
    | 'enrolled'
    | 'status'
    | 'waitForApproval'
    | 'routes'
    | 'snapshot'
    | 'identities'
    | 'refresh'
    | 'pollQuota'
  >
}

const MENU_TITLE = 'OpenAI accounts'
export const VAULT_LOGIN_LABEL = 'ChatGPT accounts in the vault'
/**
 * Shown while the vault login runs. OpenCode 1's failed callback carries no
 * message of its own, so this text also explains why the login can fail.
 */
export const VAULT_LOGIN_INSTRUCTIONS =
  'Uses the ChatGPT accounts in the Claustrum vault, with no sign-in. This works only while this host is connected to the vault and OpenCode has no OpenAI login stored; otherwise it fails and changes nothing.'

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

/**
 * Build OpenCode's auth entries. The browser entry opens the shared
 * account menu when `opencode auth login` runs on a machine that already
 * has a credential; the TUI and a first CLI login sign in as before.
 */
export function createAuthMethods({
  client,
  getAuth,
  getPaths = () => getAccountPaths(getConfigPath()),
  fetchImpl = fetch,
  packageVersion = PackageVersion,
  dependencies,
  onMainSlotWritten,
  vault,
}: CreateAuthMethodsOptions): AuthMethod[] {
  const deps: AuthMethodDependencies = {
    authorizeBrowser: dependencies?.authorizeBrowser ?? authorizeBrowser,
    authorizeHeadless:
      dependencies?.authorizeHeadless ??
      (() => authorizeHeadless(packageVersion)),
    beginAccountLogin: dependencies?.beginAccountLogin ?? beginAccountLogin,
    loadAccounts: dependencies?.loadAccounts ?? loadAccounts,
    mutateAccounts: dependencies?.mutateAccounts ?? mutateAccounts,
    readStoreIds: dependencies?.readStoreIds ?? readStoreIds,
    openBrowser: dependencies?.openBrowser ?? openBrowserForMenu,
    now: dependencies?.now ?? Date.now,
    openAccountPool: dependencies?.openAccountPool ?? openAccountPool,
    migrationBlockers:
      dependencies?.migrationBlockers ??
      (async () => {
        const fence = await migrationFenceOpen({
          currentVersion: packageVersion,
        })
        return fence.open
          ? []
          : fence.blockers.map((blocker) => ({
              pid: blocker.pid,
              version: blocker.version,
            }))
      }),
    ...(dependencies?.terminal ? { terminal: dependencies.terminal } : {}),
    ...(dependencies?.vaultWait ? { vaultWait: dependencies.vaultWait } : {}),
  }

  const readAuth = async (): Promise<AuthDetails> =>
    (await getAuth?.().catch(() => undefined)) ?? { type: 'missing' }

  /**
   * Whether this machine is past its first sign-in: OpenCode's slot holds a
   * credential, or the account store does.
   *
   * A signed-in account is the thing that makes the menu meaningful, and it is
   * usually the only account there is and need not be a roster row. Asking
   * whether the roster is non-empty instead would hide the menu from exactly
   * the person who came to add their first extra account, and a headless
   * machine would have no way to add it at all.
   */
  const hasCredential = async (): Promise<boolean> => {
    if ((await readAuth()).type !== 'missing') return true
    const paths = getPaths()
    const store = deps.openAccountPool(paths)
    if ((await store.read()).status === 'ready') return poolHasCredential(store)
    // An install that has not migrated keeps its credentials in the legacy
    // account files, every stored account with its own.
    const storage = await deps.loadAccounts(paths)
    return (storage?.accounts.length ?? 0) > 0
  }

  // Writes OpenCode's `openai` slot under `main-refresh`, the lock every slot
  // writer of this plugin holds, so this write cannot land between the
  // account-pool migration's last slot read and its placeholder write. The
  // slot is read again under the lock: if the migration put the placeholder
  // in meanwhile, main lives in the pool row and nothing is written. The
  // lock is released before `onMainSlotWritten`, whose adoption takes it.
  const setMainAuth = async (credential: {
    refresh: string
    access?: string
    expires?: number
  }) => {
    const written = await withMainRefreshLock(
      getPaths().configPath,
      async () => {
        if (isPoolMainPlaceholder(await readAuth())) return false
        await client.auth.set({
          path: { id: 'openai' },
          body: { type: 'oauth', ...credential },
        } as never)
        return true
      },
    )
    if (written) await onMainSlotWritten?.().catch(() => {})
  }

  /** The OAuth login the menu's add and re-authenticate actions run. */
  const menuLogin = (store: PoolStore): MenuLogin => ({
    begin: async ({ headless, signal }) => {
      const flow = await deps.beginAccountLogin({
        version: packageVersion,
        headless,
        ...(signal ? { signal } : {}),
      })
      return {
        url: flow.url,
        instructions: flow.instructions,
        completion: flow.completion.then(async (account) => {
          const load = await store.read()
          const main =
            load.status === 'ready'
              ? load.rows.find((row) => row.id === POOL_MAIN_ROW_ID)?.identity
              : undefined
          if (account.accountId && main && account.accountId === main)
            throw new Error(
              'that account is already the OpenCode main credential',
            )
          const login: LoginAccount = {
            id: account.id,
            credential: {
              type: 'oauth',
              refresh: account.refresh,
              ...(account.access !== undefined
                ? { access: account.access }
                : {}),
              ...(account.expires !== undefined
                ? { expires: account.expires }
                : {}),
            },
            ...(account.accountId !== undefined
              ? { identity: account.accountId }
              : {}),
            ...(account.label !== undefined ? { label: account.label } : {}),
          }
          return login
        }),
      }
    },
    openBrowser: (url) => deps.openBrowser(url),
  })

  /** One quota reading for a row, taken with the token it holds; nothing is refreshed. */
  const pollQuota = async (row: PoolRow) => {
    const credential = row.credential
    if (credential?.type !== 'oauth' || !credential.access)
      throw new Error('no usable access token for a quota check')
    const snapshot = await whamUsageFn({
      accessToken: credential.access,
      fetchImpl,
      now: deps.now,
      ...(row.identity ? { accountId: row.identity } : {}),
      accountKey: row.id,
    })
    return observationFromSnapshot(snapshot, deps.now(), true)
  }

  const doctorChecks = (migrated: boolean): DoctorCheck[] =>
    authDoctorChecks({
      paths: getPaths(),
      migrated,
      readAuth,
      loadAccounts: deps.loadAccounts,
      readStoreIds: deps.readStoreIds,
      mutateAccounts: deps.mutateAccounts,
      setMainAuth,
      now: deps.now,
    })

  /** The menu over the pool, the accounts as its rows. */
  const accountMenuOptions = (
    paths: AccountPaths,
    store: PoolStore,
  ): AccountMenuOptions => ({
    title: MENU_TITLE,
    // A re-login replaces the row's credential, and a row write holds the
    // locks an older process refreshes that row under (`withAccountRules`).
    store: withAccountRules(store, {
      rowLocks: (id) => legacyRefreshLocks(paths, id),
    }),
    ...(deps.terminal ? { terminal: deps.terminal } : {}),
    login: menuLogin(store),
    // Row `main` (the account OpenCode signs in with) and a row the
    // migration is still moving a login into are never removed, delete-all
    // included.
    protect: (id, view) => poolRemovalRefusal(id, view),
    extraLocks: poolSettingsLocks(paths),
    pollQuota,
    doctor: doctorChecks(true),
    status: async () => {
      const storage = await deps.loadAccounts(paths)
      return [
        `Routing: ${storage?.routing?.mode ?? 'main-first'}`,
        ...(vault
          ? [
              vaultEnrollmentLine(
                vault.host,
                vault.name,
                (await vault.status()).enrollment,
              ),
            ]
          : []),
      ]
    },
    ...(vault ? { extraActions: [connectVaultAction(vault)] } : {}),
  })

  /**
   * Enrolls this host with the Claustrum vault: proposes it, tells the
   * operator the `ck` commands that approve it, and waits for the approval.
   * Interrupting the wait loses nothing: the request stays on disk, and
   * Connect resumes it.
   */
  const connectVaultAction = (
    target: NonNullable<CreateAuthMethodsOptions['vault']>,
  ): MenuAction => ({
    id: 'vault-connect',
    label: 'Connect to the Claustrum vault',
    hint: 'serve OpenAI accounts held in the vault',
    run: async (context) => {
      context.print(`Asking the Claustrum vault to enroll ${target.name}…`)
      let shown: string | undefined
      const status = await target.waitForApproval({
        ...deps.vaultWait,
        onPending: (pending) => {
          const key =
            pending.state === 'pending'
              ? (pending.requestId ?? pending.retryCode ?? '')
              : pending.state
          if (key === shown) return
          shown = key
          for (const line of vaultApprovalInstructions(target.name, pending))
            context.print(line)
          context.print(
            'Waiting for the approval… (stop with Ctrl-C; Connect picks the request up again)',
          )
        },
      })
      context.print(vaultConnectOutcome(target, status).text)
    },
  })

  /**
   * What `opencode auth login` shows before the install has migrated: why
   * the accounts cannot be managed yet, and the doctor, whose repairs are
   * this install's own.
   */
  const notMigratedMenu = async (): Promise<MenuOutcome> => {
    const blockers = await deps.migrationBlockers()
    return runMenu({
      title: MENU_TITLE,
      status: [
        'Accounts move to the new account layout once every OpenCode process on this machine runs this version of OpenAI auth. Account management opens after the move.',
        ...(blockers.length > 0
          ? [
              'These processes still hold the move back:',
              ...blockers.map(
                (blocker) =>
                  `  ${blocker.pid === 'unknown' ? 'processes that could not be read' : `pid ${blocker.pid}`}: version ${blocker.version}`,
              ),
            ]
          : []),
      ],
      actions: [doctorAction({ checks: doctorChecks(false) })],
      ...(deps.terminal ? { terminal: deps.terminal } : {}),
    })
  }

  const openMenu = async (_inputs: AuthorizeInputs): Promise<MenuOutcome> => {
    const paths = getPaths()
    const store = deps.openAccountPool(paths)
    if ((await migratedPoolRows(paths, store)) === undefined)
      return notMigratedMenu()
    const options = accountMenuOptions(paths, store)
    return vault ? runVaultAccountMenu(options, vault) : runAccountMenu(options)
  }

  return [
    {
      label: 'ChatGPT Pro/Plus (browser)',
      type: 'oauth',
      // `inputs` is only present when this runs from `opencode auth login`;
      // the TUI never sends it, so the TUI always signs in as before.
      authorize: menuAuthorize<AuthOAuthResult>({
        hasCredential,
        openMenu,
        login: () => deps.authorizeBrowser(),
      }) as (inputs?: Record<string, string>) => Promise<AuthOAuthResult>,
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
    ...(vault?.enrolled()
      ? [
          {
            label: VAULT_LOGIN_LABEL,
            type: 'oauth' as const,
            authorize: async (): Promise<AuthOAuthResult> => ({
              url: '',
              instructions: VAULT_LOGIN_INSTRUCTIONS,
              method: 'auto',
              callback: async () => {
                if (
                  (await enrollmentAuthority(vault.paths, vault.name)) !==
                  'vault'
                )
                  return { type: 'failed' }
                // The host client cannot read logins. Inspect the disk record
                // without filtering invalid entries or treating read errors as
                // an empty slot: even an unrecognised login must be preserved.
                try {
                  const map: unknown = JSON.parse(
                    await readFile(opencodeAuthPath(), 'utf8'),
                  )
                  if (
                    !map ||
                    typeof map !== 'object' ||
                    Array.isArray(map) ||
                    Object.hasOwn(map, 'openai')
                  )
                    return { type: 'failed' }
                } catch (error) {
                  // A fresh install can have no auth file yet. All other
                  // failures are unsafe to interpret as an absent login.
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    return { type: 'failed' }
                }
                return { ...POOL_PLACEHOLDER, type: 'success' }
              },
            }),
          },
        ]
      : []),
  ]
}
