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
//    serves nothing and requests are refused.
//
//    While the switch is off nothing migrates. An install that is already
//    migrated is served from its pool as below, without adoptions of later
//    slot logins (OpenCode 1 runs none either). On one that is not, the
//    plugin stands aside entirely: no hooks, no login methods, no model
//    rules, no vault. That install's accounts live in OpenCode 1's
//    `auth.json` and openai-auth's legacy roster, which only OpenCode 1's
//    request path can serve; OpenCode 2 keeps serving the ChatGPT login in
//    its own credential table through its built-in OpenAI plugin, and no
//    credential is read, copied or moved.
// 3. This host's Claustrum vault connection (`OpenAiVault` in the core
//    package, enrolled as `openai-auth-opencode`, the name OpenCode 1 uses),
//    whose OpenAI accounts are routed beside the pool rows.
// 4. The hooks recipe (`installOpenCode2Auth`) with openai-auth's adapter
//    (`adapter.ts`): account choice, credential headers, request rewrites,
//    quota, refusals.
// 5. The ChatGPT logins (`login.ts`), writing into the pool; OpenCode 2's
//    credential table only ever receives a placeholder.
// 6. The model rules (`models.ts`).
// 7. A ChatGPT login OpenCode 2 already held before this plugin ran is copied
//    into the pool when the pool does not hold that account yet, since the
//    host's next refresh of it through the methods above hands back a
//    placeholder. The check runs once the migration has finished, against
//    the migrated pool, so it never lands on the `main` row the migration
//    just filled.

import {
  installOpenCode2Auth,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import {
  type AccountPaths,
  beginAccountLogin,
  codexRefreshFn,
  extractAccountId,
  extractAccountIdFromClaims,
  loadAccounts,
  OpenAiVault,
  type OpenAiVaultOptions,
  parseJwtClaims,
  vaultStateDir,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import type { Plugin } from '@opencode/plugin'
import { getConfigPath, getSettings } from '../config'
import { getAccountPaths } from '../core/account-paths'
import { PoolAccountSource } from '../core/pool-account-source'
import { poolMigrated } from '../core/pool-accounts'
import {
  createPoolLifecycle,
  type PoolLifecycleDeps,
} from '../core/pool-lifecycle'
import {
  adoptHostSlotLogin,
  type HostSlotAdapter,
  migrateToPool,
} from '../core/pool-migration'
import { observationFromSnapshot } from '../core/pool-quota'
import { startProcessHeartbeat } from '../core/process-heartbeat'
import { POOL_MIGRATION_ENABLED } from '../index'
import { createLogger } from '../logger'
import { PackageVersion } from '../version'
import { createOpenAIAdapter, OPENAI_PROVIDER_ID } from './adapter'
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

/**
 * How often the vault accounts are checked for a stale quota reading, and
 * how old a reading may be before a new one is taken; the values OpenCode
 * 1's background refresh uses. A vault account's quota lives in the vault
 * roster, so the pool's own polls do not cover it.
 */
const VAULT_POLL_INTERVAL_MS = 60_000
const VAULT_STALE_AFTER_MS = 4 * 60_000

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
  >
}

type SetupContext = Pick<
  Plugin.Context,
  'session' | 'event' | 'integration' | 'model'
>

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
    return async () => {}
  }

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
  const lifecycle = migrationEnabled
    ? createPoolLifecycle({
        paths,
        slot: options.slot ?? opencode1HostSlot(),
        version,
        ...(options.fence ? { fence: options.fence } : {}),
        // A run may leave the pool holding a row this process has never
        // polled (or turn the install migrated); re-reading starts those
        // polls at once.
        migrate: async (deps) => {
          const outcome = await migrateToPool(deps)
          void source.load()
          return outcome
        },
        adopt: async (deps) => {
          const outcome = await adoptHostSlotLogin(deps)
          void source.load()
          return outcome
        },
      })
    : undefined
  lifecycle?.start()

  // The vault serves nothing until this host is enrolled as
  // `openai-auth-opencode` (from OpenCode 1's `opencode auth login` menu).
  // Until then each poll only checks for the enrollment token file, so an
  // enrollment another process finished is picked up.
  const vault = new OpenAiVault({
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
  })
  vault.start()
  const pollVault = () => {
    if (vault.enrolled()) void vault.pollStale(VAULT_STALE_AFTER_MS)
  }
  void vault.refresh().then(pollVault)
  const vaultPoll = setInterval(pollVault, VAULT_POLL_INTERVAL_MS)
  vaultPoll.unref?.()

  const pins = new SessionPins()
  const openai = createOpenAIAdapter({
    source,
    storage: () => loadAccounts(paths()),
    pins,
    vault,
    responsesLite: () => getSettings().responsesLite,
    log,
  })
  const installation = await installOpenCode2Auth(ctx, openai.adapter, {
    logger: {
      warn: (message, data) => log.warn(message, { data }),
    },
  })
  openai.attach(installation)

  /** Waits for a migration run when the install has not migrated yet. */
  const ensureMigrated = async () => {
    if (poolMigrated(paths().configPath)) return
    await lifecycle?.idle()
    if (poolMigrated(paths().configPath)) return
    throw new Error(
      'OpenAI accounts move to the shared account pool once every OpenCode process on this machine runs this version of openai-auth; the login was not stored. Update or close the older processes and sign in again.',
    )
  }

  const storeLogin = async (
    login: PoolLoginResult,
    origin: 'login' | 'import' = 'login',
  ) => {
    await ensureMigrated()
    const outcome = await writeLoginToPool(source.poolStore(), paths(), login, {
      origin,
    })
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

  // A login OpenCode 2 stored before this plugin ran would be replaced by a
  // placeholder at its next refresh; copy it into the pool first.
  const importHostLogin = async () => {
    const connection =
      await ctx.integration.connection.active(OPENAI_PROVIDER_ID)
    if (!connection) return
    const value = await ctx.integration.connection.resolve(connection)
    if (value?.type !== 'oauth' || !value.refresh) return
    // Placeholders (this plugin's own, or OpenCode 1's carried over when
    // OpenCode 2 imported a migrated `auth.json`) and tombstones of the
    // removed vault custody hold no credential.
    if (isLeftoverCredential(value)) return
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
    clearInterval(vaultPoll)
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
    source.dispose()
    vault.close()
    await heartbeat?.release()
  }
}
