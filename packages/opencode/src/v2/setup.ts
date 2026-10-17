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
//    While this host is enrolled (vault mode) its OpenAI accounts are the
//    only ones routed: no pool row is sent with, refreshed or polled. Nothing
//    above waits for its first roster read; the lifecycle's adoptions wait
//    for it in the background, and a vault-mode request for at most two
//    seconds before it is refused.
// 4. The hooks recipe (`installOpenCode2Auth`) with openai-auth's adapter
//    (`adapter.ts`): account choice, credential headers, request rewrites,
//    quota, refusals.
// 5. The ChatGPT logins (`login.ts`), writing into the pool; OpenCode 2's
//    credential table only ever receives a placeholder.
// 6. The model rules (`models.ts`).

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import {
  type Attempt,
  installOpenCode2Auth,
  type OpenCode2AuthAdapter,
  OpenCode2AuthError,
  type OpenCode2HookContext,
  placeholderSecret,
  type RequestScope,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import {
  type AccountPaths,
  beginAccountLogin,
  codexRefreshFn,
  extractAccountId,
  loadAccounts,
  type OpenAiVaultOptions,
  redactCredentialError,
  redactCredentialFrame,
  redactCredentialResponse,
  redactCredentialText,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { getConfigPath, getSettings } from '../config'
import { getAccountPaths } from '../core/account-paths'
import {
  PoolAccountSource,
  settlesWithin,
  VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS,
  VAULT_FIRST_ROSTER_WAIT_MS,
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
import { startProcessHeartbeat } from '../core/process-heartbeat'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { migrationFenceOpen } from '../core/version-fence'
import { POOL_MIGRATION_ENABLED } from '../index'
import { createLogger, setLogLevel } from '../logger'
import { PackageVersion } from '../version'
import {
  createOpenAIAdapter,
  OPENAI_PROVIDER_ID,
  type OpenAIAdapterLogger,
} from './adapter'
import {
  acquireCacheKeep,
  type CacheKeepCaptureInput,
  type CacheKeepManagerSetup,
  cacheKeepSettingsOf,
} from './cache-keep'
import { acquireCodexSessions } from './codex-sessions'
import { CodexHttpState } from './codex-wire'
import { type ControlPlaneMenu, installControlPlane } from './control-plane'
import { opencode1HostSlot } from './host-slot'
import {
  assertLocalPoolLogin,
  type BeginLogin,
  chatgptLoginMethods,
  isLeftoverCredential,
  type PoolLoginResult,
  vaultLoginMethod,
  writeLoginToPool,
} from './login'
import { createControlPlaneMenu } from './menu'
import { registerCodexModelRules } from './models'
import { RequestDumps } from './request-dumps'
import {
  createPoolQuotaPull,
  createPoolResetDeps,
  ResetCreditCounts,
} from './reset-credits'
import { acquireSessionAccounts } from './session-accounts'
import { acquireSessionPins } from './shared-pins'
import { acquireSidebarPublisher } from './sidebar-publisher'

/**
 * The plugin id both hosts list this plugin under: the OpenCode 1 plugin's
 * own id, since OpenCode 1 reads the `./server` entry as well.
 */
export const OPENAI_AUTH_PLUGIN_ID = 'cortexkit-openai-auth'

/** Longest a shutdown waits for queued quota writes before it lets go. */
const SETTLE_ON_DISPOSE_MS = 5_000

/** Test and embedding seams; every field has a production default. */
export interface OpenAIAuthV2Options {
  /** Overrides HTTP identity and clock sources for deterministic wire fixtures. */
  codex?: import('./codex-wire').CodexHttpState
  /** Binds this location's sidebar output; defaults to the shared sidebar state file. */
  sidebarStateFile?: string
  /**
   * Test-only interval in milliseconds for checking settings/enrollment file
   * metadata and cached vault rosters. Tests can shorten the 2,000 ms default
   * to observe changes quickly.
   */
  sidebarObservationIntervalMs?: number
  /** Overrides the production menu for transport fixtures. */
  controlPlane?: ControlPlaneMenu
  /**
   * The keep-warm manager's timer and the limit its last release waits for
   * a warm in flight. Used only by the location that builds the store's
   * manager; production uses the global timers and `CACHE_KEEP_JOIN_MS`.
   */
  cacheKeep?: Pick<
    CacheKeepManagerSetup,
    'setIntervalImpl' | 'clearIntervalImpl' | 'joinTimeoutMs'
  >
  /** The account config and state files; read on every use. */
  paths?: () => AccountPaths
  /** OpenCode 1's login slot the migration reads; its `auth.json` by default. */
  slot?: HostSlotAdapter
  /** This build's version, for the heartbeat and the version fence. */
  version?: string
  /** Used for token refreshes and quota polls. */
  fetch?: typeof fetch
  /**
   * The clock for token refreshes, quota polls and the readings they record,
   * rate-limit marks, and reset credits; `Date.now` by default.
   */
  now?: () => number
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
> &
  Partial<Pick<Plugin.Context, 'command' | 'location'>>

async function installPoolHooks<Q, A>(
  ctx: SetupContext,
  adapter: OpenCode2AuthAdapter<Q, A>,
  log: Pick<OpenAIAdapterLogger, 'warn'>,
  codex = new CodexHttpState(),
  // Sees every owned request in its final form, with its account attempt.
  // Keep-warm captures agent-loop requests here.
  onOwnedRequest?: (input: {
    sessionID: string
    kind: string
    request: Request
    attempt: Attempt<A>
  }) => Promise<void>,
) {
  const dumps = new RequestDumps(log)
  // installOpenCode2Auth supplies an Attempt to the rewrite callbacks before it
  // constructs the final Request. Async-local storage carries that handle to
  // this hook's final snapshot without sharing a latest attempt across requests.
  const observing = new AsyncLocalStorage<{ attempt?: Attempt<A> }>()
  // Receive/retry hooks have no request object to identify the send they answer.
  // They answer the last handshake or send for this session, so remember its
  // bearer. A send using another integration's login is not ours to rewrite.
  const sockets = new Map<string, { bearer: string; attempt: Attempt<A> }>()
  const latest = new Map<string, string>()
  const forget = (sessionID: string) => {
    latest.delete(sessionID)
    for (const key of sockets.keys())
      if (key.startsWith(`${sessionID}:`)) sockets.delete(key)
  }
  const context: OpenCode2HookContext = {
    session: {
      hook: (name, callback, options) =>
        ctx.session.hook(
          name,
          async (draft) => {
            const request =
              name === 'http.request'
                ? (draft as SessionHooks['http.request'])
                : undefined
            const handshake =
              name === 'experimental.ws.handshake'
                ? (draft as SessionHooks['experimental.ws.handshake'])
                : undefined
            const prepared = request
              ? request.request.headers
              : handshake
                ? new Headers(handshake.headers)
                : undefined
            const owned =
              prepared?.get('authorization') ===
              `Bearer ${placeholderSecret(adapter.providerID)}`
            const observation: { attempt?: Attempt<A> } = {}
            if (handshake)
              sockets.delete(`${handshake.sessionID}:${handshake.kind}`)
            try {
              await observing.run(observation, () => callback(draft))
            } catch (error) {
              if (owned && !(error instanceof OpenCode2AuthError))
                throw redactCredentialError(error)
              throw error
            }
            if (request && owned && observation.attempt) {
              // accountHeaders runs after the HTTP rewrite and restores the host
              // session id. Keep the same Request object: installOpenCode2Auth
              // uses its identity to attribute responses to the account attempt.
              const threadID = request.request.headers.get('thread-id')
              if (threadID) request.request.headers.set('session-id', threadID)
            }
            if (request && owned && observation.attempt)
              await dumps.captureHttp(request.request, observation.attempt)
            if (request && owned && observation.attempt)
              await onOwnedRequest?.({
                sessionID: request.sessionID,
                kind: request.kind,
                request: request.request,
                attempt: observation.attempt,
              })
            if (handshake && owned && observation.attempt) {
              // A stable thread id lets WebSocket and HTTP fallback share the
              // same cache without changing the host's socket key between turns.
              handshake.headers['session-id'] = codex.get(
                handshake.sessionID,
              ).threadID
            }
            if (name === 'experimental.ws.send') {
              const sent = draft as SessionHooks['experimental.ws.send']
              const socket = sockets.get(`${sent.sessionID}:${sent.kind}`)
              if (socket) await dumps.frame(sent.frame, socket.attempt)
            }
            if (request || handshake) {
              const scope = request ?? handshake
              if (!scope) return
              const headers = request
                ? request.request.headers
                : new Headers(
                    (scope as SessionHooks['experimental.ws.handshake'])
                      .headers,
                  )
              const bearer = headers
                .get('authorization')
                ?.replace(/^Bearer /, '')
              if (owned && bearer) latest.set(scope.sessionID, bearer)
              else latest.delete(scope.sessionID)
              if (handshake) {
                const key = `${handshake.sessionID}:${handshake.kind}`
                if (owned && bearer && observation.attempt)
                  sockets.set(key, { bearer, attempt: observation.attempt })
                else sockets.delete(key)
              }
              if (latest.size > 512) {
                const oldest = latest.keys().next().value
                if (oldest) latest.delete(oldest)
              }
              if (sockets.size > 512) {
                const oldest = sockets.keys().next().value
                if (oldest) sockets.delete(oldest)
              }
            } else if (name === 'experimental.ws.receive') {
              const received = draft as SessionHooks['experimental.ws.receive']
              const socket = sockets.get(
                `${received.sessionID}:${received.kind}`,
              )
              if (socket) {
                // Only an owned socket's frames move the frame turn state.
                codex.frameReceived(received.sessionID, received.frame)
                received.frame = redactCredentialFrame(
                  received.frame,
                  socket.bearer,
                )
              }
            } else if (name === 'retry') {
              const retry = draft as SessionHooks['retry']
              const token = latest.get(retry.sessionID)
              if (token)
                Object.assign(retry.error, {
                  message: redactCredentialText(retry.error.message, token),
                })
            }
          },
          options,
        ),
    },
    event: {
      subscribe: (options) =>
        (async function* () {
          for await (const event of ctx.event.subscribe(options)) {
            if (event.type === 'session.deleted') forget(event.data.sessionID)
            yield event
          }
        })(),
    },
  }
  const installation = await installOpenCode2Auth(
    context,
    {
      ...adapter,
      rewriteRequest: async (input) => {
        const observation = observing.getStore()
        if (observation) observation.attempt = input.attempt
        return adapter.rewriteRequest?.(input)
      },
      rewriteHandshakeURL: (input) => {
        const observation = observing.getStore()
        if (observation) observation.attempt = input.attempt
        return adapter.rewriteHandshakeURL?.(input)
      },
      onAttemptEnd: async (attempt, outcome) => {
        await dumps.end(attempt, outcome)
        await adapter.onAttemptEnd?.(attempt, outcome)
      },
      rewriteResponse: async (input) => {
        await dumps.response(input.request, input.response.status)
        const response =
          (await adapter.rewriteResponse?.(input)) ?? input.response
        return redactCredentialResponse(
          response,
          input.request.headers.get('authorization')?.replace(/^Bearer /, ''),
          'event-stream',
        )
      },
    },
    {
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
    },
  )
  const dispose = installation.dispose
  return {
    ...installation,
    dispose: async () => {
      latest.clear()
      sockets.clear()
      await dispose()
      await dumps.settle()
      dumps.clear()
    },
  }
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
  // The logger starts with the environment floor. A saved choice overrides it,
  // just as it does on OpenCode 1, before setup writes any diagnostic lines.
  const storage = await loadAccounts(paths())
  const storedLevel = storage?.logging?.level
  if (storedLevel && typeof storedLevel === 'string') {
    setLogLevel(storedLevel as Parameters<typeof setLogLevel>[0])
  }
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
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
  // Each poll reads the shared enrollment authority, so an enrollment
  // completed by another process is picked up. It is built before the
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
  let setupComplete = false
  let closing = false
  using _leaseRollback = {
    [Symbol.dispose]() {
      if (!setupComplete) vaultLease.release()
    },
  }
  await vault.authority()
  const vaultFirstRoster = vaultLease.firstRoster

  const resetCounts = new ResetCreditCounts()
  const source = new PoolAccountSource({
    paths,
    refreshProvider: async (credential) => {
      const tokens = await codexRefreshFn({
        refreshToken: credential.refresh,
        fetchImpl,
        now,
      })
      const identity = extractAccountId({
        id_token: '',
        access_token: tokens.access,
        refresh_token: tokens.refresh,
      })
      return { ...tokens, ...(identity ? { identity } : {}) }
    },
    // Each usage poll's windows and available reset-credit count go into
    // the row's quota map (what routing reads). The poll's applicable count,
    // which the reset result reports and the map has no field for, goes
    // into `resetCounts`.
    pullQuota: createPoolQuotaPull({
      fetchImpl,
      now,
      counts: resetCounts,
      logger: logQ,
    }),
    now,
    // One ChatGPT account has one owner. A local pool row signing in as an
    // account the vault holds for this host belongs to the vault, so this
    // source neither refreshes that row's token nor polls quota with it
    // (request routing already skips it). OpenCode 1 wires the same set.
    vaultIdentities: () => vault.identities(),
    // In vault mode (this host enrolled with the vault) no pool row is
    // refreshed, polled or sent with; disconnecting restores them.
    vaultMode: () => vault.enrolled(),
    vaultAuthority: () => vault.authority(),
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
        runDeps: { vaultServes: () => vault.serves() },
        // In vault mode neither the migration nor an adoption runs: a login
        // in OpenCode 1's slot stays there, unused, and the local files stay
        // as they are until the host disconnects.
        paused: async () => (await vault.authority()) !== 'local',
        // A run may leave the pool holding a row this process has never
        // polled (or turn the install migrated); re-reading starts those
        // polls at once.
        migrate: async (deps) => {
          const outcome = await migrateToPool(deps)
          migrationRefused = outcome.status === 'refused'
          if (!closing) await source.load()
          return outcome
        },
        // `vaultServes` is false until the vault's first roster read has
        // settled, so an adoption waits for it, in the background and for a
        // bounded time: past it the run adopts nothing and ends retryable,
        // so the lifecycle (and a login waiting for it to go idle) is never
        // held, and the next scheduled run tries again.
        adopt: async (deps) => {
          if (closing) return { status: 'retry', reason: 'unsettled' }
          if (!(await settlesWithin(vaultFirstRoster, vaultRosterWaitMs)))
            return { status: 'retry', reason: 'vault-roster-pending' }
          if (closing) return { status: 'retry', reason: 'unsettled' }
          const outcome = await adoptHostSlotLogin(deps)
          if (!closing) await source.load()
          return outcome
        },
      })
    : undefined
  lifecycle?.start()

  vaultLease.start()

  const pins = acquireSessionPins(paths())
  const sidebar = acquireSidebarPublisher(
    { paths: paths(), source, pins, vault },
    options.sidebarStateFile,
    options.sidebarObservationIntervalMs,
  )
  using _sidebarRollback = {
    [Symbol.dispose]() {
      if (!setupComplete) void sidebar.release()
    },
  }
  // Disk publication must not hold up the host's location-ready lifecycle.
  void sidebar.publish()
  // Thread ids are saved per host session so the prompt cache key survives a
  // server restart; every location in this process shares the one map.
  const codex =
    options.codex ??
    new CodexHttpState(undefined, undefined, acquireCodexSessions())
  const sessionAccounts = acquireSessionAccounts(paths())
  // One keep-warm manager per process and account store; this location lends
  // it its own pool source, vault, settings and request capture.
  const cacheKeepSettings = cacheKeepSettingsOf(storage)
  const cacheKeep = acquireCacheKeep(
    paths(),
    {
      source,
      storage: () => loadAccounts(paths()),
      vault,
      accounts: sessionAccounts,
      settings: () => cacheKeepSettings,
      parentOf: async (sessionID) =>
        (await ctx.session.get({ sessionID }))?.parentID ?? undefined,
      fetch: fetchImpl,
      log: createLogger('cachekeep'),
    },
    {
      now,
      codexResponsesUrl: getSettings().codexApiEndpoint,
      ...options.cacheKeep,
    },
  )
  using _cacheKeepRollback = {
    [Symbol.dispose]() {
      if (!setupComplete) void cacheKeep.release()
    },
  }
  const openai = createOpenAIAdapter({
    codex,
    onRoute: sidebar.route,
    source,
    slotPlaceholderWithoutMain,
    storage: () => loadAccounts(paths()),
    pins,
    sessionAccounts,
    vault,
    awaitVaultRoster: async () => {
      await settlesWithin(
        vault.awaitRequestRoster(),
        VAULT_FIRST_ROSTER_WAIT_MS,
      )
    },
    responsesLite: () => getSettings().responsesLite,
    codexEndpoint: () => getSettings().codexApiEndpoint,
    now,
    log,
  })
  const installation = await installPoolHooks(
    ctx,
    openai.adapter,
    log,
    codex,
    (input: CacheKeepCaptureInput) => cacheKeep.capture(input),
  )
  openai.attach(installation)

  /** Waits for a migration run when the install has not migrated yet. */
  const ensureMigrated = async (login: PoolLoginResult) => {
    await assertLocalPoolLogin(vault)
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

  const storeLogin = async (login: PoolLoginResult) => {
    await ensureMigrated(login)
    const outcome = await writeLoginToPool(source.poolStore(), paths(), login, {
      vault,
    })
    if (!poolMigrated(paths().configPath)) await lifecycle?.requestAdoption()
    await source.load()
    log.info('ChatGPT login stored in the account pool', outcome)
  }

  const methods = await registerOpenCode2AuthMethods(ctx, {
    integrationID: OPENAI_PROVIDER_ID,
    methods: chatgptLoginMethods({
      beginLogin: options.beginLogin ?? beginAccountLogin,
      version,
      vault,
    }),
    onLogin: (login) => storeLogin(login),
    label: 'ChatGPT (openai-auth account pool)',
    vault: vaultLoginMethod(vault),
  })
  const models = await registerCodexModelRules(ctx)
  if (options.controlPlane && (!ctx.command || !ctx.location))
    throw new Error(
      'OpenCode 2 control plane requires command and location APIs',
    )
  const controlPlane =
    ctx.command && ctx.location
      ? await installControlPlane(
          {
            session: ctx.session,
            command: ctx.command,
            location: ctx.location,
          },
          options.controlPlane ??
            createControlPlaneMenu({
              // Reset credits over the pool: a missing row is refused, and
              // no host login is read in its place.
              ...createPoolResetDeps({
                source,
                storage: () => loadAccounts(paths()),
                counts: resetCounts,
                now,
                authority: () => vault.authority(),
              }),
              fetchImpl,
              now,
              randomUUID,
              accountStoragePath: paths().configPath,
              accountStatePath: paths().statePath,
              packageVersion: version,
              loadAccounts,
              store: () => source.poolStore(),
              migration: async () => {
                if (poolMigrated(paths().configPath)) return { migrated: true }
                const state = await fence()
                return {
                  migrated: false,
                  blockers: state.open ? [] : state.blockers,
                }
              },
              beginAccountLogin: options.beginLogin ?? beginAccountLogin,
              refreshAllQuota: async () =>
                (await source.pollRows(await loadAccounts(paths()))).map(
                  (row) => ({ ...row, account: row.id }),
                ),
              getStickyRouting: async (sessionId) => pins.get(sessionId),
              afterWrite: () => source.load(),
              refreshSidebar: () => sidebar.publish(),
              clearStickyRouting: async (sessionId) => {
                const existed = pins.get(sessionId) !== undefined
                pins.forget(sessionId)
                return existed
              },
              vault,
            }),
        )
      : undefined

  // A deleted session's pin, remembered account and keep-warm target go with
  // it.
  const abort = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === 'session.deleted') {
          openai.forgetSession(event.data.sessionID)
          cacheKeep.forget(event.data.sessionID)
        }
      }
    } catch (error) {
      if (!abort.signal.aborted)
        log.warn('stopped listening for session deletion', {
          error: error instanceof Error ? error.message : String(error),
        })
    }
  })()

  setupComplete = true
  return async () => {
    closing = true
    abort.abort()
    // Drop this location's hold first, so no warm reads the pool source or
    // vault released below. The last hold stops the manager at once; its
    // warm in flight is joined within the shutdown limit below.
    const cacheKeepReleased = cacheKeep.release()
    await controlPlane?.()
    lifecycle?.dispose()
    source.dispose()
    await sidebar.release()
    await Promise.allSettled([
      installation.dispose(),
      methods.dispose(),
      models.dispose(),
    ])
    // Join account-pool transfers and reads after stopping new slot adoptions.
    // Their reloads must finish before releasing this host's state. Also finish
    // saving the sessions this location created or deleted, so a restart right
    // after still finds their thread ids. Preserve the five-second shutdown
    // limit for an unresponsive provider, login slot or session-file lock.
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([
          lifecycle?.idle(),
          source.settled(),
          codex.store?.settled(),
          cacheKeepReleased,
        ]),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, SETTLE_ON_DISPOSE_MS)
          settleTimer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(settleTimer)
      vaultLease.release()
      await heartbeat?.release()
    }
  }
}
