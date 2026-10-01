// The OpenCode 2 server plugin: openai-auth's account pool on OpenCode 2's own
// OpenAI driver, through `@cortexkit/common-auth/opencode2`.
//
// What setup wires, in order:
// 1. The pool source (`core/pool-account-source.ts`) over the same config and
//    state files OpenCode 1 uses: the pool is the one authority for accounts
//    on both hosts.
// 2. This process's heartbeat and the background pool migration
//    (`core/pool-lifecycle.ts`), with OpenCode 1's `auth.json` as the login
//    slot (`host-slot.ts`). An install that has not migrated yet migrates on
//    the first OpenCode 2 start, behind the same version fence as on OpenCode
//    1; until then the pool serves nothing and requests are refused.
// 3. The hooks recipe (`installOpenCode2Auth`) with openai-auth's adapter
//    (`adapter.ts`): account choice, credential headers, quota, refusals.
// 4. The ChatGPT logins (`login.ts`), writing into the pool; OpenCode 2's
//    credential table only ever receives a placeholder.
// 5. The model rules (`models.ts`).
// 6. A ChatGPT login OpenCode 2 already held before this plugin ran is copied
//    into the pool once, since the host's next refresh of it through the
//    methods above hands back a placeholder.

import {
  installOpenCode2Auth,
  isPlaceholderCredential,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import {
  type AccountPaths,
  beginAccountLogin,
  codexRefreshFn,
  extractAccountId,
  loadAccounts,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import type { Plugin } from '@opencode/plugin'
import { getConfigPath } from '../config'
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
  POOL_PLACEHOLDER_REFRESH,
} from '../core/pool-migration'
import { observationFromSnapshot } from '../core/pool-quota'
import { startProcessHeartbeat } from '../core/process-heartbeat'
import { createLogger } from '../logger'
import { PackageVersion } from '../version'
import { createOpenAIAdapter, OPENAI_PROVIDER_ID } from './adapter'
import { opencode1HostSlot } from './host-slot'
import {
  type BeginLogin,
  chatgptLoginMethods,
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
  /** Whether to write this process's heartbeat (other processes' fence reads it). */
  heartbeat?: boolean
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

  const lifecycle = createPoolLifecycle({
    paths,
    slot: options.slot ?? opencode1HostSlot(),
    version,
    ...(options.fence ? { fence: options.fence } : {}),
    // A run may leave the pool holding a row this process has never polled
    // (or turn the install migrated); re-reading starts those polls at once.
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
  lifecycle.start()

  const pins = new SessionPins()
  const openai = createOpenAIAdapter({
    source,
    storage: () => loadAccounts(paths()),
    pins,
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
    await lifecycle.idle()
    if (poolMigrated(paths().configPath)) return
    throw new Error(
      'OpenAI accounts move to the shared account pool once every OpenCode process on this machine runs this version of openai-auth; the login was not stored. Update or close the older processes and sign in again.',
    )
  }

  const storeLogin = async (login: PoolLoginResult) => {
    await ensureMigrated()
    const outcome = await writeLoginToPool(source.poolStore(), paths(), login)
    await source.load()
    log.info('ChatGPT login stored in the account pool', outcome)
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
    if (isPlaceholderCredential(value, OPENAI_PROVIDER_ID)) return
    // OpenCode 1's own placeholder, carried over if OpenCode 2 imported a
    // migrated `auth.json`.
    if (value.refresh === POOL_PLACEHOLDER_REFRESH) return
    const accountId =
      typeof value.metadata?.accountID === 'string'
        ? value.metadata.accountID
        : undefined
    await storeLogin({
      id: accountId ?? crypto.randomUUID(),
      refresh: value.refresh,
      ...(value.access ? { access: value.access } : {}),
      ...(value.expires ? { expires: value.expires } : {}),
      ...(accountId ? { accountId } : {}),
    })
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
    lifecycle.dispose()
    await Promise.allSettled([
      installation.dispose(),
      methods.dispose(),
      models.dispose(),
      imported,
    ])
    // Quota a response carried is written in the background; give those
    // writes a bounded moment so a clean shutdown keeps them.
    await Promise.race([
      source.settled(),
      new Promise((resolve) =>
        setTimeout(resolve, SETTLE_ON_DISPOSE_MS).unref?.(),
      ),
    ])
    source.dispose()
    await heartbeat?.release()
  }
}
