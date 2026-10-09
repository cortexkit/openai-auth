// The OpenCode 2 server plugin: openai-auth's account pool on OpenCode 2's own
// OpenAI driver, through `@cortexkit/common-auth/opencode2`.
//
// What setup wires, in order:
// 1. The pool source (`core/pool-account-source.ts`) over the same config and
//    state files OpenCode 1 uses: the pool is the one authority for accounts
//    on both hosts.
// 2. This process's heartbeat and, while the migration switch
//    (`POOL_MIGRATION_ENABLED` in `../index.ts`, the one OpenCode 1 obeys)
//    is on, the background pool migration (`core/pool-lifecycle.ts`), with
//    OpenCode 1's `auth.json` as the login slot (`host-slot.ts`). An install
//    that has not migrated yet then migrates on the first OpenCode 2 start,
//    behind the same version fence as on OpenCode 1; until then the pool
//    serves nothing and pool requests are refused locally.
//
//    While the switch is off nothing migrates. An install that is already
//    migrated is served from its pool as below, without adoptions of later
//    slot logins (OpenCode 1 runs none either). On one that is not, the
//    plugin installs only gated hooks to refuse a cached pool placeholder:
//    no login methods, model rules or vault. That install's accounts live in
//    OpenCode 1's
//    `auth.json` and openai-auth's legacy roster, which only OpenCode 1's
//    request path can serve; OpenCode 2 keeps serving the ChatGPT login in
//    its own credential table through its built-in OpenAI plugin, and no
//    credential is read, copied or moved. Real host credentials pass through.
// 3. This host's Claustrum vault connection (`OpenAiVault` in the core
//    package, enrolled as `openai-auth-opencode`, the name OpenCode 1 uses),
//    whose OpenAI accounts are routed beside the pool rows. Nothing above
//    waits for its first roster read, but what would act on a local row
//    signing in as a vault account does: the source's first-sight quota
//    polls and the lifecycle's adoptions wait for it in the background, a
//    request's token step for at most two seconds.
// 4. The hooks recipe (`installOpenCode2Auth`) with openai-auth's adapter
//    (`adapter.ts`): account choice, credential headers, request rewrites,
//    quota, refusals.
// 5. The ChatGPT logins (`login.ts`), writing into the pool; OpenCode 2's
//    credential table only ever receives a placeholder.
// 6. The model rules (`models.ts`).
// 7. A ChatGPT login OpenCode 2 already held before this plugin ran is copied
//    into the pool only when the pool does not hold that account yet. The copy
//    does not change the host's selected login method or refresh handler.
//    The check runs after migration against the migrated pool, so it never
//    overwrites a newer login the migration just put into row `main`.

import {
  installOpenCode2Auth,
  type OpenCode2AuthAdapter,
  OpenCode2AuthError,
  type RequestScope,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import {
  type AccountPaths,
  beginAccountLogin,
  codexRefreshFn,
  extractAccountId,
  extractAccountIdFromClaims,
  loadAccounts,
  type OpenAiVaultOptions,
  parseJwtClaims,
  vaultStateDir,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import type { Plugin } from '@opencode/plugin'
import { getConfigPath, getSettings } from '../config'
import { getAccountPaths } from '../core/account-paths'
import {
  PoolAccountSource,
  settlesWithin,
  VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS,
} from '../core/pool-account-source'
import { poolMigrated } from '../core/pool-accounts'
import {
  createPoolLifecycle,
  type PoolLifecycleDeps,
} from '../core/pool-lifecycle'
import { POOL_LOGIN_REQUIRED_MESSAGE } from '../core/pool-main'
import {
  adoptHostSlotLogin,
  type HostSlotAdapter,
  migrateToPool,
  poolPlaceholderWithoutMain,
} from '../core/pool-migration'
import { observationFromSnapshot } from '../core/pool-quota'
import { startProcessHeartbeat } from '../core/process-heartbeat'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { migrationFenceOpen } from '../core/version-fence'
import { POOL_MIGRATION_ENABLED } from '../index'
import { createLogger } from '../logger'
import { PackageVersion } from '../version'
import {
  createOpenAIAdapter,
  OPENAI_PROVIDER_ID,
  type OpenAIAdapterLogger,
} from './adapter'
import { opencode1HostSlot } from './host-slot'
import {
  type BeginLogin,
  chatgptLoginMethods,
  isLeftoverCredential,
  type PoolLoginResult,
  writeLoginToPool,
} from './login'
import { registerCodexModelRules } from './models'
import { SessionPins } from './pins'

/**
 * The plugin id both hosts list this plugin under: the OpenCode 1 plugin's
 * own id, since OpenCode 1 reads the `./server` entry as well.
 */
export const OPENAI_AUTH_PLUGIN_ID = 'cortexkit-openai-auth'

function identityOfToken(token: string): string | undefined {
  const claims = token ? parseJwtClaims(token) : undefined
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

/** Longest a shutdown waits for queued quota writes before it lets go. */
const SETTLE_ON_DISPOSE_MS = 5_000

/** Test and embedding seams; every field has a production default. */
export interface OpenAIAuthV2Options {
  /** The account config and state files; read on every use. */
  paths?: () => AccountPaths
  /** OpenCode 1's login slot the migration reads; its `auth.json` by default. */
  slot?: HostSlotAdapter
  /** This build's version, for the heartbeat and the version fence. */
  version?: string
  /** Used for token refreshes and quota polls. */
  fetch?: typeof fetch
  /** Starts one ChatGPT login (`beginAccountLogin`). */
  beginLogin?: BeginLogin
  /** The migration's version fence; `migrationFenceOpen` for `version` by default. */
  fence?: PoolLifecycleDeps['fence']
  /** Overrides `POOL_MIGRATION_ENABLED`, so tests can run the migration. */
  poolMigration?: boolean
  /** Whether to write this process's heartbeat (other processes' fence reads it). */
  heartbeat?: boolean
  /** The vault's directory and connections; the production ones by default. */
  vault?: Partial<
    Pick<
      OpenAiVaultOptions,
      | 'stateDir'
      | 'connectionFile'
      | 'connectScoped'
      | 'connectEnrollment'
      | 'pollIntervalMs'
    >
  > & {
    /**
     * Longest an adoption or the pool source's first quota polls wait for
     * the vault's first roster; `VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS` by
     * default.
     */
    firstRosterWaitMs?: number
  }
}

type SetupContext = Pick<
  Plugin.Context,
  'session' | 'event' | 'integration' | 'model'
>

function installPoolHooks<Q, A>(
  ctx: SetupContext,
  adapter: OpenCode2AuthAdapter<Q, A>,
  log: Pick<OpenAIAdapterLogger, 'warn'>,
) {
  return installOpenCode2Auth(ctx, adapter, {
    gateOnPlaceholder: {
      credential: (headers) => {
        const authorization = headers.get('authorization')
        return authorization?.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : undefined
      },
    },
    logger: {
      warn: (message, data) => log.warn(message, { data }),
    },
  })
}

export function createOpenAIAuthPlugin(
  options: OpenAIAuthV2Options = {},
): Plugin.Plugin {
  return {
    id: OPENAI_AUTH_PLUGIN_ID,
    setup: (ctx) => setupOpenAIAuth(ctx, options),
  }
}

export async function setupOpenAIAuth(
  ctx: SetupContext,
  options: OpenAIAuthV2Options = {},
): Promise<Plugin.Cleanup> {
  const log = createLogger('opencode2')
  const logQ = createLogger('quota')
  const paths = options.paths ?? (() => getAccountPaths(getConfigPath()))
  const fetchImpl = options.fetch ?? fetch
  const version = options.version ?? PackageVersion
  const migrationEnabled = options.poolMigration ?? POOL_MIGRATION_ENABLED

  if (!migrationEnabled && !poolMigrated(paths().configPath)) {
    log.info(
      'openai-auth stands aside on OpenCode 2: this install has not moved into the account pool and the migration is switched off, so OpenCode 2 serves its own ChatGPT login',
    )
    // A cached pool placeholder must still be refused locally even when this
    // store cannot migrate. Real host credentials bypass the shared gate.
    const refuse = (input: RequestScope): never => {
      throw new OpenCode2AuthError({
        kind: 'no-account',
        providerID: OPENAI_PROVIDER_ID,
        sessionID: input.sessionID,
        requestKind: input.kind,
        message: POOL_LOGIN_REQUIRED_MESSAGE,
      })
    }
    const installation = await installPoolHooks(
      ctx,
      {
        providerID: OPENAI_PROVIDER_ID,
        chooseAccount: refuse,
        accountHeaders: refuse,
      },
      log,
    )
    return () => installation.dispose()
  }

  // The vault serves nothing until this host is enrolled as
  // `openai-auth-opencode` (from OpenCode 1's `opencode auth login` menu).
  // Until then each poll only checks for the enrollment token file, so an
  // enrollment another process finished is picked up. It is built before the
  // pool source, whose first load already asks which accounts it holds, and
  // started further down.
  //
  // `vaultFirstRoster` settles once the vault's first roster read has,
  // successfully or not. Until then the vault reports no accounts, so a
  // local row signing in as a vault account looks like this host's own: the
  // pool source's first-sight quota polls and the lifecycle's adoptions wait
  // for it in the background, and a request's token step waits for it for a
  // bounded time (`PoolAccountSource`). Setup itself never waits for it.
  const vaultRosterWaitMs =
    options.vault?.firstRosterWaitMs ?? VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS
  const vaultLease = acquireOpenCodeVault(
    {
      host: 'opencode',
      stateDir: options.vault?.stateDir ?? vaultStateDir(paths().statePath),
      reservedRouteIds: () => source.peek().rows.map((row) => row.id),
      ...(options.vault?.connectionFile
        ? { connectionFile: options.vault.connectionFile }
        : {}),
      ...(options.vault?.connectScoped
        ? { connectScoped: options.vault.connectScoped }
        : {}),
      ...(options.vault?.connectEnrollment
        ? { connectEnrollment: options.vault.connectEnrollment }
        : {}),
      ...(options.vault?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.vault.pollIntervalMs }
        : {}),
      fetchImpl: () => fetchImpl,
    },
    paths(),
  )
  const vault = vaultLease.vault
  const vaultFirstRoster = vaultLease.firstRoster

  const source = new PoolAccountSource({
    paths,
    refreshProvider: async (credential) => {
      const tokens = await codexRefreshFn({
        refreshToken: credential.refresh,
        fetchImpl,
        now: Date.now,
      })
      const identity = extractAccountId({
        id_token: '',
        access_token: tokens.access,
        refresh_token: tokens.refresh,
      })
      return { ...tokens, ...(identity ? { identity } : {}) }
    },
    pullQuota: async (request) => {
      const credential = request.credential
      if (credential.type !== 'oauth' || !credential.access)
        throw new Error('the row holds no access token to poll with')
      const snapshot = await whamUsageFn({
        accessToken: credential.access,
        fetchImpl,
        now: Date.now,
        ...(request.identity ? { accountId: request.identity } : {}),
        accountKey: request.id,
        logger: logQ,
      })
      return observationFromSnapshot(snapshot, Date.now(), true)
    },
    // One ChatGPT account has one owner. A local pool row signing in as an
    // account the vault holds for this host belongs to the vault, so this
    // source neither refreshes that row's token nor polls quota with it
    // (request routing already skips it). OpenCode 1 wires the same set.
    vaultIdentities: () => vault.identities(),
    vaultFirstRoster,
    vaultFirstRosterBackgroundWaitMs: vaultRosterWaitMs,
    log: createLogger('pool'),
  })
  await source.load()

  const heartbeat =
    options.heartbeat === false
      ? undefined
      : await startProcessHeartbeat({
          version,
          logger: createLogger('heartbeat'),
        })

  // Only while the migration is switched on. With it off, setup gets here
  // only on an already migrated install, and no adoption of a later login in
  // OpenCode 1's slot runs, as on OpenCode 1 with the switch off.
  const fence =
    options.fence ?? (() => migrationFenceOpen({ currentVersion: version }))
  const migrationSlot = options.slot ?? opencode1HostSlot()
  const slotPlaceholderWithoutMain = async () =>
    poolPlaceholderWithoutMain(
      paths(),
      await migrationSlot.get({ path: { id: 'openai' } }),
    )
  let migrationRefused = false
  const lifecycle = migrationEnabled
    ? createPoolLifecycle({
        paths,
        slot: migrationSlot,
        version,
        fence,
        // Adoption restores the host placeholder even with vault accounts;
        // the source excludes pool identities owned by the vault.
        runDeps: { vaultServes: () => vault.serves() },
        // A run may leave the pool holding a row this process has never
        // polled (or turn the install migrated); re-reading starts those
        // polls at once.
        migrate: async (deps) => {
          const outcome = await migrateToPool(deps)
          migrationRefused = outcome.status === 'refused'
          void source.load()
          return outcome
        },
        // `vaultServes` is false until the vault's first roster read has
        // settled, so an adoption waits for it, in the background and for a
        // bounded time: past it the run adopts nothing and ends retryable,
        // so the lifecycle (and a login waiting for it to go idle) is never
        // held, and the next scheduled run tries again.
        adopt: async (deps) => {
          if (!(await settlesWithin(vaultFirstRoster, vaultRosterWaitMs)))
            return { status: 'retry', reason: 'vault-roster-pending' }
          const outcome = await adoptHostSlotLogin(deps)
          void source.load()
          return outcome
        },
      })
    : undefined
  lifecycle?.start()

  vaultLease.start()

  const pins = new SessionPins()
  const openai = createOpenAIAdapter({
    source,
    slotPlaceholderWithoutMain,
    storage: () => loadAccounts(paths()),
    pins,
    vault,
    responsesLite: () => getSettings().responsesLite,
    codexEndpoint: () => getSettings().codexApiEndpoint,
    log,
  })
  const installation = await installPoolHooks(ctx, openai.adapter, log)
  openai.attach(installation)

  /** Waits for a migration run when the install has not migrated yet. */
  const ensureMigrated = async (login: PoolLoginResult) => {
    if (poolMigrated(paths().configPath)) return
    await lifecycle?.idle()
    if (poolMigrated(paths().configPath)) return
    if (
      migrationRefused &&
      !isLeftoverCredential(login) &&
      (await fence()).open
    ) {
      // The migration was refused because the placeholder in the login slot
      // came from another store. A real login made for this setup can start
      // this store: write it as `main` first, then let the migration finish
      // from that row, leaving the shared slot as the other store left it.
      await source.poolStore().initialize()
      return
    }
    throw new Error(
      'OpenAI accounts move to the shared account pool once every OpenCode process on this machine runs this version of openai-auth; the login was not stored. Update or close the older processes and sign in again.',
    )
  }

  const storeLogin = async (
    login: PoolLoginResult,
    origin: 'login' | 'import' = 'login',
  ) => {
    await ensureMigrated(login)
    const outcome = await writeLoginToPool(source.poolStore(), paths(), login, {
      origin,
    })
    if (!poolMigrated(paths().configPath)) await lifecycle?.requestAdoption()
    await source.load()
    log.info(
      outcome.operation === 'kept'
        ? 'the account pool already holds the ChatGPT login OpenCode 2 held'
        : 'ChatGPT login stored in the account pool',
      outcome,
    )
  }

  const methods = await registerOpenCode2AuthMethods(ctx, {
    integrationID: OPENAI_PROVIDER_ID,
    methods: chatgptLoginMethods({
      beginLogin: options.beginLogin ?? beginAccountLogin,
      version,
    }),
    onLogin: (login) => storeLogin(login),
    label: 'ChatGPT (openai-auth account pool)',
  })
  const models = await registerCodexModelRules(ctx)

  // Copy a pre-existing host login into the pool without selecting the pool
  // connection. The host's own login and refresh methods stay in charge of it.
  const importHostLogin = async () => {
    const connection =
      await ctx.integration.connection.active(OPENAI_PROVIDER_ID)
    if (!connection) return
    const value = await ctx.integration.connection.resolve(connection)
    if (value?.type !== 'oauth' || !value.refresh) return
    // Placeholders (this plugin's own, or OpenCode 1's carried over when
    // OpenCode 2 imported a migrated `auth.json`) and tombstones of the
    // removed vault custody hold no credential.
    if (isLeftoverCredential(value)) {
      if (await slotPlaceholderWithoutMain()) {
        if (lifecycle) lifecycle.noticePlaceholderWithoutMain()
        else log.warn(POOL_LOGIN_REQUIRED_MESSAGE)
      }
      return
    }
    const accountId =
      typeof value.metadata?.accountID === 'string'
        ? value.metadata.accountID
        : identityOfToken(value.access)
    // Stored only when no pool row holds this account yet, checked by
    // `writeLoginToPool` after the migration has finished: the pool may have
    // rotated this login's tokens since, or the migration may have just moved
    // a newer copy of the account into row `main`.
    await storeLogin(
      {
        id: accountId ?? crypto.randomUUID(),
        refresh: value.refresh,
        ...(value.access ? { access: value.access } : {}),
        ...(value.expires ? { expires: value.expires } : {}),
        ...(accountId ? { accountId } : {}),
      },
      'import',
    )
  }
  const imported = importHostLogin().catch((error: unknown) => {
    log.warn('the ChatGPT login OpenCode 2 holds was not copied to the pool', {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  // A deleted session's pin and remembered account go with it.
  const abort = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === 'session.deleted')
          openai.forgetSession(event.data.sessionID)
      }
    } catch (error) {
      if (!abort.signal.aborted)
        log.warn('stopped listening for session deletion', {
          error: error instanceof Error ? error.message : String(error),
        })
    }
  })()

  return async () => {
    abort.abort()
    lifecycle?.dispose()
    await Promise.allSettled([
      installation.dispose(),
      methods.dispose(),
      models.dispose(),
      imported,
    ])
    // Quota readings taken from responses are written to the pool files in
    // the background; wait a bounded time for those writes so a clean
    // shutdown does not lose them.
    await Promise.race([
      source.settled(),
      new Promise((resolve) =>
        setTimeout(resolve, SETTLE_ON_DISPOSE_MS).unref?.(),
      ),
    ])
    vaultLease.release()
    source.dispose()
    await heartbeat?.release()
  }
}
