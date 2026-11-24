// The request path of the Pi package: which OpenAI account each Pi request is
// sent with, and what the responses say about each account's quota.
//
// Pi hands every `openai-codex` request to this extension with the access
// token of Pi's own login. That login is routed as row `main`
// (`main-account.ts`); the rows of Pi's account pool (`pool-source.ts`) are
// the fallbacks. Each request is routed by the mode the `/openai` menu set
// (`pool-request.ts`) and sent through pi-ai's Codex stream with the chosen
// account's token in place of Pi's: pi-ai derives the `chatgpt-account-id`
// header from that token, so the token is the whole credential.
//
// An attempt that fails before publishing output may hold or move to another
// account. Once output reaches Pi, that attempt is the request's answer.
//
// Quota is recorded from every HTTP response's `x-codex-*` headers and from
// `codex.rate_limits` events on HTTP SSE and WebSocket, against the account
// whose token produced them.
//
// Once Pi is connected to the Claustrum vault (`/openai` > Vault), Pi is in
// vault mode: the OpenAI accounts the vault serves it are the only accounts
// routed (`vault.ts` in the core), and each attempt on one sends with the
// token the vault serves for it. Connecting deletes Pi's saved login; pool rows
// are neither used, refreshed, polled nor written. A request no vault account can
// serve is refused with a fixed message. Disconnecting re-enables local routing,
// but Pi's previous login is not restored.

import { statSync } from 'node:fs'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import { VAULT_HOST_CONNECT_REFUSAL } from '@cortexkit/common-auth/claustrum'
import type {
  AccountKey,
  LimitDecision,
  LimitSignal,
  PolicyFacts,
} from '@cortexkit/common-auth/limits'
import {
  MAX_SAME_ACCOUNT_HOLD_MS,
  waitForPi,
} from '@cortexkit/common-auth/limits'
import type { PiSlot } from '@cortexkit/common-auth/pi-slot'
import type { PoolRow, PoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  applyMidConversationEffort,
  buildOpenAiQuotaRefusal,
  type CodexEffortState,
  chooseVaultRouting,
  classifyOpenAiLimitBody,
  codexRefreshFn,
  createLogger,
  createSessionActivityStore,
  deferSessionCacheResponseTouch,
  extractAccountId,
  type FrameTurnRecord,
  FrameTurnState,
  hasVaultRoutingAccessor,
  isCompleteQuotaHeaderFrame,
  isRecord,
  isVaultHosted,
  limitAccountKey,
  loadAccounts,
  normalizeQuotaHeaders,
  normalizeWsFrame,
  type OAuthQuotaSnapshot,
  OPENAI_QUOTA_MINIMUM_REFUSAL_MESSAGE,
  OpenAiVault,
  poolLimitsNamespace,
  quotaSnapshotPassesPolicy,
  type RefreshAllQuotaResult,
  type RoutingMode,
  recordSessionCompletion,
  redactCredentialError,
  redactCredentialResponse,
  redactCredentialText,
  reportVaultRouting,
  reportVaultRoutingLimit,
  type SessionDispatch,
  sessionCacheKeepPlan,
  startVaultRoutingWait,
  ttlForModel,
  uuidV7,
  VAULT_REQUEST_ROSTER_WAIT_MS,
  VAULT_ROUTING_REFUSAL_MESSAGE,
  VaultBillingAttempt,
  type VaultModeRefusal,
  type VaultRoutingFeedback,
  vaultLimitsNamespace,
  vaultModeNoRouteCause,
  vaultModeRefusalText,
  vaultStateDir,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import {
  observationFromSnapshot,
  windowsFromQuotaMap,
} from '@cortexkit/openai-auth-core/pool-quota'
import {
  type AdmissionTier,
  CreditsServing,
  FIRST_QUOTA_READING_WAIT_MS,
  FORMER_MAIN_ID,
  POOL_QUOTA_UNKNOWN_RETRY_SECONDS,
  type PoolBlock,
  type PoolRoutingInput,
  vaultMainRouteId,
} from '@cortexkit/openai-auth-core/pool-routing'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  retireIdlePiCodexWebSocket,
  withPiCodexWebSocketAttempt,
} from './codex-websocket.ts'
import {
  omitPiCodexDefaults,
  type PiCodexWireSession,
  piCodexHttpUrl,
  piCodexWebSocketUrl,
  shapePiCodexHttpRequest,
} from './codex-wire.ts'
import { PiMainAccount } from './main-account.ts'
import { getPiAccountPaths } from './paths.ts'
import {
  admitPiVaultRetry,
  type PiRouteContext,
  type PiRouteResult,
  type PiVaultRetry,
  type PiWake,
  type RouteAccount,
  type RouteAttempt,
  routablePoolRows,
  routePiRequest,
} from './pool-request.ts'
import { PiPoolSource, settleWithinBudget } from './pool-source.ts'
import { placePiStickyPin } from './routing.ts'
import {
  openVaultSlot,
  VAULT_PLACEHOLDER_KEY,
  VAULT_SLOT_REFUSAL,
} from './vault-slot.ts'

/**
 * The shared admission budget for an account's missing first usage reading.
 */
export const FIRST_READING_WAIT_MS = FIRST_QUOTA_READING_WAIT_MS

/** Longest a request waits for a lock-free re-read of the account settings. */
const STORAGE_READ_BUDGET_MS = 500
const MAX_EFFORT_SESSIONS = 1024
const routingLog = createLogger('routing')

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

type RefreshAllQuotaResults = RefreshAllQuotaResult[]
type PiRequestSettings = AccountStorage & { waitForReset?: boolean }

export interface PiOpenAIRuntimeDeps {
  /** Sends one attempt of a request: pi-ai's Codex stream. */
  streamSimple: StreamSimple
  /** Creates the stream handed back to Pi. */
  createStream: () => AssistantMessageEventStream
  /** Installed for the lifetime of one request; returns its uninstaller. */
  installWebSocket?: () => () => void
  paths?: () => AccountPaths
  /** Shared with the menu when startup chose shared preferences; omitted while the account config remains authoritative. */
  settings?: { view(store?: AccountStorage | null): PiRequestSettings }
  /** Used for quota polls and token refreshes; read at call time by default. */
  fetchImpl?: typeof fetch
  now?: () => number
  /** Wire identifiers may be seeded in request captures. */
  turnUuid?: () => string
  installationID?: string
  firstReadingWaitMs?: number
  readBudgetMs?: number
  /** Replaces Pi's connection to the Claustrum vault (tests); by default its files live next to the account files. */
  vault?: OpenAiVault
  /** Replaces the disk slot for isolated host-runtime tests. */
  slot?: PiSlot
  /** Observe limit decisions before Pi publishes its first event; does not wait. */
  onLimitDecision?(decision: LimitDecision, facts: PolicyFacts): void
  /** Replaces the cancellable countdown in isolated stream tests. */
  waitForPi?: typeof waitForPi
}

// Pi's agent retries by matching the error text, so provider details must not
// appear in the terminal error of an attempt that has already published output.
const TERMINAL_AFTER_OUTPUT_MESSAGE =
  'The response ended early after part of it had already been shown. It was not sent again, because repeating it would duplicate that output and re-run any tools it had started.'

/** An attempt as the router sees it, with the events it produced so far. */
interface StreamAttempt extends RouteAttempt {
  /** Only a real HTTP status can trigger vault credential recovery. */
  httpStatus?: number
  /** The events through the first output or terminal event, held until selection. */
  buffered: AssistantMessageEvent[]
  /** The rest of the attempt's events, when it is streaming. */
  rest: AsyncIterator<AssistantMessageEvent> | undefined
}

interface PiRouteExecution {
  canWait: boolean
  wake?: PiWake
  vaultRetry?: PiVaultRetry
  attemptedVaultIds: Set<string>
  billingAttempt?: number
}

function piRequestKind(options: SimpleStreamOptions | undefined) {
  return options?.cacheRetention === 'none' ? 'generate' : 'primary'
}

function isPiOutput(event: AssistantMessageEvent): boolean {
  // pi-ai mutates partial in place. Use the event's own text instead of reading
  // later content through an earlier lifecycle event.
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
      return event.delta.length > 0
    case 'text_end':
    case 'thinking_end':
      return event.content.length > 0
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
      return true
    default:
      return false
  }
}

function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export function errorEvent(
  model: Model<Api>,
  message: string,
): AssistantMessageEvent {
  return {
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'error',
      errorMessage: message,
      timestamp: Date.now(),
    },
  }
}

type PiBlock = PoolBlock | { reason: 'quota-minimum'; resetAtMs?: never }

/** The error message Pi shows for a request no account may serve. */
export function blockedMessage(block: PiBlock): string {
  const reset =
    block.resetAtMs !== undefined
      ? ` It resets at ${new Date(block.resetAtMs).toISOString()}.`
      : ''
  switch (block.reason) {
    case 'quota-minimum':
      return OPENAI_QUOTA_MINIMUM_REFUSAL_MESSAGE
    case 'quota-unknown':
      return `No OpenAI account has a quota reading yet; one is being taken now. Try again in ${POOL_QUOTA_UNKNOWN_RETRY_SECONDS} seconds.`
    case 'quota-exhausted':
      return `Every OpenAI account has used up its quota.${reset}`
    case 'killswitch':
      return 'Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`).'
    case 'mid-stream-rate-limit':
      return `Every OpenAI account is rate-limited.${reset}`
    case 'no-credential':
      return 'No OpenAI account holds a usable sign-in. Sign in with `/login` or add an account with `/openai`.'
  }
}

type PiQuotaDispatch = {
  accountId: string
  token: string
  receipt?: QuotaReceipt
}

export class PiOpenAIRuntime {
  readonly main: PiMainAccount
  readonly pool: PiPoolSource
  readonly vault: OpenAiVault
  readonly activity = createSessionActivityStore()
  private readonly effortBySession = new Map<string, CodexEffortState>()
  private readonly frameTurns = new FrameTurnState()
  private readonly installationID: string
  /** Captured from a live Pi context; absent in headless hosts. */
  setWorkingMessage: ((message?: string) => void) | undefined
  private readonly deps: PiOpenAIRuntimeDeps
  /**
   * Which accounts this runtime serves on prepaid credits, so the info line
   * is written once when an account starts serving on them.
   */
  private readonly creditsServing = new CreditsServing()
  private readonly now: () => number
  private readonly paths: () => AccountPaths
  private slot: PiSlot | undefined
  private slotVaultMode: boolean | undefined
  private slotNeedsRefresh = false
  private slotQueue: Promise<unknown> = Promise.resolve()
  private storageCache:
    | { key: string; storage: AccountStorage | null }
    | undefined
  private storageRead:
    | { key: string; promise: Promise<AccountStorage | null> }
    | undefined

  constructor(deps: PiOpenAIRuntimeDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.installationID = deps.installationID ?? crypto.randomUUID()
    this.paths = deps.paths ?? getPiAccountPaths
    const fetchImpl = () => deps.fetchImpl ?? globalThis.fetch
    this.main = new PiMainAccount({
      now: this.now,
      poll: async (token, identity) => {
        if ((await this.readAuthority()) !== 'local')
          throw new Error('Pi login quota polling is disabled while enrolled')
        const snapshot = await whamUsageFn({
          accessToken: token,
          fetchImpl: fetchImpl(),
          now: this.now,
          ...(identity ? { accountId: identity } : {}),
          accountKey: FORMER_MAIN_ID,
        })
        const observation = observationFromSnapshot(snapshot, this.now(), true)
        if (!observation) throw new Error('the quota poll returned no reading')
        return { snapshot, observation }
      },
    })
    this.pool = new PiPoolSource({
      paths: this.paths,
      now: this.now,
      ...(deps.readBudgetMs !== undefined
        ? { readBudgetMs: deps.readBudgetMs }
        : {}),
      // In vault mode the pool is set aside: nothing in it is refreshed,
      // polled or written. Read on every use, so a disconnect re-enables it.
      vaultMode: () => this.vaultMode(),
      vaultAuthority: () => this.readAuthority(),
      refreshProvider: async (credential) => {
        if ((await this.readAuthority()) !== 'local')
          throw new Error('Local token refresh is disabled while enrolled')
        const tokens = await codexRefreshFn({
          refreshToken: credential.refresh,
          fetchImpl: fetchImpl(),
          now: this.now,
        })
        const identity = extractAccountId({
          id_token: '',
          access_token: tokens.access,
          refresh_token: tokens.refresh,
        })
        return { ...tokens, ...(identity ? { identity } : {}) }
      },
      pullQuota: async (request) => {
        if ((await this.readAuthority()) !== 'local')
          throw new Error('Local quota polling is disabled while enrolled')
        const credential = request.credential
        if (credential.type !== 'oauth' || !credential.access)
          throw new Error('the row holds no access token to poll with')
        const snapshot = await whamUsageFn({
          accessToken: credential.access,
          fetchImpl: fetchImpl(),
          now: this.now,
          ...(request.identity ? { accountId: request.identity } : {}),
          accountKey: request.id,
        })
        const observation = observationFromSnapshot(snapshot, this.now(), true)
        if (!observation) throw new Error('the quota poll returned no reading')
        return { snapshot, observation }
      },
    })
    this.vault =
      deps.vault ??
      new OpenAiVault({
        host: 'pi',
        stateDir: vaultStateDir(this.paths().statePath),
        reservedRouteIds: () => this.pool.peek().rows.map((row) => row.id),
        fetchImpl,
        now: this.now,
      })
  }

  /**
   * Conservative mode hint for synchronous hooks. Unknown or unreadable
   * enrollment blocks local work; asynchronous boundaries read authority anew.
   */
  vaultMode(): boolean {
    return this.vault.enrolled()
  }

  /** A fresh read of enrollment, through the vault so Pi and OpenCode share one rule and one cache. */
  readAuthority(): Promise<'host' | 'local' | 'vault' | 'unreadable'> {
    return this.vault.authority()
  }

  private vaultSlot(): PiSlot {
    this.slot ??= this.deps.slot ?? openVaultSlot(this.paths().statePath)
    return this.slot
  }

  private withSlot<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.slotQueue.then(run)
    // A failed reload must not prevent a later session from retrying it.
    this.slotQueue = pending.catch(() => {
      this.slotVaultMode = undefined
    })
    return pending
  }

  /**
   * Delete Pi's original login and install the placeholder before reloading
   * auth, so Pi cannot refresh the local login after approval outside the menu.
   */
  syncVaultSlot(refresh?: () => unknown, explicit = false): Promise<void> {
    return this.withSlot(async () => {
      await this.reconcileSlot(explicit)
      if (!isVaultHosted() && this.slotNeedsRefresh && refresh) {
        await refresh()
        this.slotNeedsRefresh = false
      }
    })
  }

  /**
   * Clear the placeholder before forgetting this host's vault enrollment.
   * The slot helper leaves any non-placeholder entry untouched on exit.
   */
  disconnectVault(): Promise<'cleared' | 'nothing-to-do'> {
    return this.withSlot(async () => {
      if ((await this.readAuthority()) === 'host')
        throw new Error(VAULT_HOST_CONNECT_REFUSAL)
      this.slotVaultMode = undefined
      try {
        const result = await this.vaultSlot().exitVault()
        this.slotNeedsRefresh = true
        await this.vault.disconnect()
        return result
      } finally {
        await this.reconcileSlot()
      }
    })
  }

  private async reconcileSlot(explicit = false): Promise<void> {
    const authority = await this.readAuthority()
    // The hosted provider uses an in-memory key, never Pi's auth.json slot.
    if (authority === 'host') return
    const mode = authority !== 'local'
    // Background ticks only read enrollment. An explicit sync or an unknown
    // slot state must reconcile under the helper's lock even in the same mode.
    if (mode === this.slotVaultMode && !explicit) return
    const previousMode = this.slotVaultMode
    this.slotVaultMode = undefined
    const before = await this.vaultSlot().inspect()
    if (isVaultHosted()) return
    if (mode) await this.vaultSlot().enterVault()
    else await this.vaultSlot().exitVault()
    this.slotNeedsRefresh =
      (mode && before.slot !== 'placeholder') ||
      (!mode && before.slot === 'placeholder') ||
      (previousMode !== undefined && mode !== previousMode) ||
      this.slotNeedsRefresh
    // Another process can change enrollment while the slot helper waits for
    // its auth.json lock. Reconcile that change after the locked update finishes.
    const currentAuthority = await this.readAuthority()
    if (currentAuthority === 'host') return
    const currentMode = currentAuthority !== 'local'
    if (currentMode !== mode) {
      if (currentMode) await this.vaultSlot().enterVault()
      else await this.vaultSlot().exitVault()
      this.slotNeedsRefresh = true
    }
    this.slotVaultMode = currentMode
  }

  /**
   * Reads the pool once, which starts every row's first quota poll, and
   * starts the vault's background poll of Pi's vault accounts. Never
   * rejects.
   */
  async start(): Promise<void> {
    await this.readAuthority()
    this.vault.start()
    return this.pool.load().then(
      () => {},
      () => {},
    )
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * The account settings (routing mode, killswitch, fallback statuses). A
   * lock-free read, re-done only when the config file changed and waited for
   * at most the read budget; past it the last settings serve.
   */
  private async storage(): Promise<AccountStorage | null> {
    const paths = this.paths()
    let key: string
    try {
      const stat = statSync(paths.configPath)
      key = `${paths.configPath}|${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch {
      key = `${paths.configPath}|-`
    }
    if (this.storageCache?.key === key) return this.storageCache.storage
    if (this.storageRead?.key !== key) {
      const promise = loadAccounts(paths).then(
        (storage) => {
          this.storageCache = { key, storage }
          return storage
        },
        () => this.storageCache?.storage ?? null,
      )
      this.storageRead = { key, promise }
    }
    return settleWithinBudget(
      this.storageRead.promise,
      this.deps.readBudgetMs ?? STORAGE_READ_BUDGET_MS,
      () => this.storageCache?.storage ?? null,
    )
  }

  /** Memory only; a settings view never decides whether an account store exists. */
  private settings(storage: AccountStorage | null): PiRequestSettings | null {
    // Without a shared snapshot the store itself is the settings, exactly as
    // before, including null for a missing store.
    return this.deps.settings ? this.deps.settings.view(storage) : storage
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  /**
   * The accounts one request may be sent with: Pi's login, then the pool
   * rows, then the vault's accounts. In vault mode the vault's accounts
   * alone: neither Pi's login nor a pool row is read.
   */
  private accounts(storage: AccountStorage | null): RouteAccount[] {
    const out: RouteAccount[] = []
    if (!this.vaultMode()) this.localAccounts(storage, out)
    for (const route of this.vault.routes()) {
      out.push({
        id: route.id,
        token: undefined,
        kind: route.kind,
        vault: true,
        ...(route.identity ? { identity: route.identity } : {}),
        ...(route.quota !== undefined ? { quota: route.quota } : {}),
      })
    }
    return out.map((account) => ({
      ...account,
      accountKey: this.accountKey(account),
    }))
  }

  private accountKey(account: RouteAccount): AccountKey | undefined {
    if (!account.identity) return undefined
    const paths = this.paths()
    if (account.vault) {
      const row = this.vault
        .snapshot()
        ?.rows.find((value) => value.routeId === account.id)
      return row
        ? limitAccountKey(vaultLimitsNamespace(this.vault.paths.rosterPath), {
            kind: 'vault',
            routeId: account.id,
            addedAt: row.addedAt,
          })
        : undefined
    }
    const namespace = poolLimitsNamespace(paths.configPath, paths.statePath)
    if (account.id === FORMER_MAIN_ID)
      return limitAccountKey(namespace, {
        kind: 'legacy',
        id: account.id,
        verifiedIdentity: account.identity,
      })
    const row = this.poolRowById(account.id)
    return row
      ? limitAccountKey(namespace, {
          kind: 'pool',
          id: row.id,
          credentialEpoch: row.credentialEpoch,
        })
      : undefined
  }

  /**
   * Pi's login and the routable pool rows, outside vault mode. A login or
   * row signing in as a ChatGPT account the vault holds is left out.
   */
  private localAccounts(
    storage: AccountStorage | null,
    out: RouteAccount[],
  ): void {
    const mainToken = this.main.currentToken()
    const mainIdentity = this.main.currentIdentity()
    const vaultIdentities = this.vault.identities()
    if (
      mainToken &&
      !(mainIdentity !== undefined && vaultIdentities.has(mainIdentity))
    ) {
      const quota = this.main.quotaMap()
      out.push({
        id: FORMER_MAIN_ID,
        token: mainToken,
        ...(mainIdentity ? { identity: mainIdentity } : {}),
        ...(quota ? { quota } : {}),
      })
    }
    const view = this.pool.peek()
    const now = this.now()
    if (view.active) {
      for (const row of routablePoolRows(
        view.rows,
        storage,
        now,
        mainIdentity,
        vaultIdentities,
      )) {
        out.push({
          id: row.id,
          token: this.pool.usableToken(row, now),
          ...(row.identity ? { identity: row.identity } : {}),
          ...(row.quota !== undefined ? { quota: row.quota } : {}),
        })
      }
    }
  }

  private poolRowById(id: string): PoolRow | undefined {
    return this.pool.peek().rows.find((row) => row.id === id)
  }

  private requestPull(id: string): ReturnType<PoolRoutingInput['requestPull']> {
    if (id === FORMER_MAIN_ID) return this.main.requestReading()
    if (this.vault.owns(id)) return this.vault.requestReading(id)
    return this.pool.requestReading(id)
  }

  // -------------------------------------------------------------------------
  // Quota observed on the wire
  // -------------------------------------------------------------------------

  private recordHeaders(
    dispatch: PiQuotaDispatch,
    headers: Record<string, string>,
  ): void {
    const parsed = new Headers(headers)
    this.recordQuota(
      dispatch,
      normalizeQuotaHeaders(parsed) as Record<string, unknown>,
      isCompleteQuotaHeaderFrame(parsed),
      { headers: parsed },
    )
  }

  private recordQuota(
    { accountId, token, receipt }: PiQuotaDispatch,
    snapshot: Record<string, unknown>,
    complete: boolean,
    reply: { headers: Headers } | { frame: unknown },
  ): void {
    if (receipt) {
      this.vault.reportUsage(accountId, reply, receipt)
      void this.vault.recordSnapshot(accountId, snapshot, complete, receipt)
    } else if (accountId === FORMER_MAIN_ID) {
      this.main.record(snapshot, token, complete)
    } else {
      this.pool.recordSnapshot(accountId, snapshot, token, complete)
    }
  }

  /** Credit quota to the account and vault credential that sent this request, not the socket's opener. */
  observeWebSocketMessage(
    dispatch: PiQuotaDispatch,
    data: string,
  ): OAuthQuotaSnapshot | undefined {
    if (!data.includes('codex.rate_limits')) return
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    return this.recordQuotaEvent(dispatch, event)
  }

  private recordQuotaEvent(dispatch: PiQuotaDispatch, event: unknown) {
    if (!isRecord(event) || event.type !== 'codex.rate_limits') return
    const snapshot = normalizeWsFrame(
      event as unknown as Parameters<typeof normalizeWsFrame>[0],
    )
    this.recordQuota(dispatch, snapshot as Record<string, unknown>, true, {
      frame: event,
    })
    return snapshot
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /** Pi's `streamSimple` for the `openai-codex` provider. */
  stream(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const outer = this.deps.createStream()
    const restoreWebSocket = this.deps.installWebSocket?.() ?? (() => {})
    const setWorkingMessage = this.setWorkingMessage
    void (async () => {
      let endWait: ReturnType<typeof startVaultRoutingWait>
      try {
        let waited = false
        const execution: PiRouteExecution = {
          canWait: false,
          attemptedVaultIds: new Set(),
        }
        for (;;) {
          if (options?.signal?.aborted) return
          const authority = await this.readAuthority()
          if (
            !execution.vaultRetry &&
            authority !== 'host' &&
            authority !== 'local' &&
            options?.apiKey !== VAULT_PLACEHOLDER_KEY
          ) {
            outer.push(errorEvent(model, VAULT_SLOT_REFUSAL))
            return
          }
          execution.canWait = !!setWorkingMessage && !waited
          const attempt = await this.route(model, context, options, execution)
          if (options?.signal?.aborted) return
          if (attempt.kind === 'vault-refused') {
            outer.push(errorEvent(model, VAULT_ROUTING_REFUSAL_MESSAGE))
            return
          }
          let delayMs: number | undefined
          if (attempt.kind === 'policy') {
            const decision = attempt.decision
            if (
              decision.action === 'refuse' ||
              waited ||
              (!setWorkingMessage && decision.waitKind !== 'terminal')
            ) {
              const refusal = buildOpenAiQuotaRefusal({
                decision,
                host: 'pi',
                now: this.now(),
              })
              outer.push(
                errorEvent(
                  model,
                  refusal.kind === 'throw'
                    ? refusal.error.message
                    : refusal.body,
                ),
              )
              return
            }
            execution.wake = attempt.wake
            delayMs = decision.delayMs
          }
          if (attempt.kind === 'vault-retry') {
            execution.vaultRetry = attempt.target
            execution.wake = undefined
            delayMs = attempt.delayMs
          }
          if (delayMs !== undefined) {
            endWait?.('resumed')
            waited = true
            const at = this.now()
            endWait = startVaultRoutingWait({
              sessionId: options?.sessionId,
              reason: 'account_limit',
              now: at,
              nextMs: at + delayMs,
            })
            let result: 'elapsed' | 'aborted'
            try {
              result = await (this.deps.waitForPi ?? waitForPi)(delayMs, {
                signal: options?.signal,
                setWorkingMessage: setWorkingMessage ?? (() => {}),
              })
            } finally {
              // A failed wait helper must not leave Pi's working indicator behind.
              try {
                setWorkingMessage?.()
              } catch {}
            }
            if (result === 'aborted' || options?.signal?.aborted) {
              endWait?.('cancelled')
              endWait = undefined
              return
            }
            continue
          }
          if (attempt.kind === 'policy' || attempt.kind === 'vault-retry')
            continue
          if (attempt.kind === 'blocked') {
            outer.push(
              errorEvent(
                model,
                attempt.refusal
                  ? vaultModeRefusalText(attempt.refusal, this.vault.name)
                  : blockedMessage(attempt.block),
              ),
            )
            return
          }
          endWait?.('resumed')
          endWait = undefined
          const { buffered, rest } = attempt.attempt
          for (const event of buffered) outer.push(event)
          if (rest) {
            for (;;) {
              const next = await rest.next()
              if (next.done) break
              outer.push(next.value)
            }
          }
          return
        }
      } catch (error) {
        outer.push(
          errorEvent(
            model,
            redactCredentialError(error, options?.apiKey).message,
          ),
        )
      } finally {
        endWait?.(options?.signal?.aborted ? 'cancelled' : 'abandoned')
        outer.end()
        restoreWebSocket()
      }
    })()
    return outer
  }

  private async route(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    execution: PiRouteExecution,
  ): Promise<
    | Exclude<PiRouteResult<StreamAttempt>, { kind: 'blocked' }>
    | { kind: 'blocked'; block: PiBlock; refusal?: VaultModeRefusal }
  > {
    const storage = await this.storage()
    const settings = this.settings(storage)
    const authority = await this.readAuthority()
    const vaultMode = authority !== 'local'
    const vaultRetry = execution.vaultRetry
    if (
      vaultRetry &&
      ((authority !== 'host' && authority !== 'vault') ||
        !hasVaultRoutingAccessor())
    )
      return { kind: 'vault-refused' }
    if (vaultMode) {
      // Vault mode: Pi's login (the key Pi hands over) and the pool are not
      // used. Before the vault's first account list there is nothing to
      // route, so that is waited for, for a bounded time.
      await settleWithinBudget(
        this.vault.awaitRequestRoster().then(() => true),
        VAULT_REQUEST_ROSTER_WAIT_MS,
        () => false,
      )
    } else {
      if (!execution.wake) this.main.observeToken(options?.apiKey)
      await this.pool.current()
      await this.pool.prepareTokens(this.pool.peek().rows, settings)
    }
    const mode: RoutingMode = settings?.routing?.mode ?? 'main-first'
    let vaultRefused = false
    let candidates = 0
    let quotaFiltered = false
    const route: PiRouteContext<StreamAttempt> = {
      accounts: () => {
        const accounts = this.accounts(settings).filter(
          (account) => !vaultMode || account.vault,
        )
        candidates = accounts.length
        const now = this.now()
        const eligible = accounts.filter((account) => {
          if (!account.vault) return true
          const reading = windowsFromQuotaMap(account.quota)
          // Leave unread routes visible so admission can request a poll.
          return !reading || quotaSnapshotPassesPolicy(reading, settings, now)
        })
        quotaFiltered = eligible.length < candidates
        return eligible
      },
      storage: settings,
      mode,
      mainId: vaultMode ? vaultMainRouteId(this.vault.routes()) : undefined,
      sessionId: options?.sessionId,
      requestBytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
      now: this.now,
      refreshBackoff: (accounts) =>
        this.pool.refreshBackoffFor(
          accounts
            .map((account) => this.poolRowById(account.id))
            .filter((row): row is PoolRow => row !== undefined),
        ),
      requestPull: (id) => this.requestPull(id),
      firstReadingWaitMs: this.deps.firstReadingWaitMs ?? FIRST_READING_WAIT_MS,
      captureAdmissionTier: hasVaultRoutingAccessor(),
      limitPolicy: {
        execute: true,
        canWait: execution.canWait,
        waitForReset: settings?.waitForReset,
        wake: execution.wake,
        effectiveModel: model.id,
        activity: () =>
          options?.sessionId ? this.activity.get(options.sessionId) : undefined,
        onDecision: (decision, facts) =>
          this.deps.onLimitDecision?.(decision, facts),
      },
      send: (account, tier) =>
        options?.signal?.aborted
          ? Promise.resolve(undefined)
          : account.vault
            ? this.vaultAttempt(
                model,
                context,
                options,
                account.id,
                execution,
                tier === 'free',
                vaultRetry &&
                  (async (receipt) => {
                    const authority = await this.readAuthority()
                    return (
                      (authority === 'host' || authority === 'vault') &&
                      !options?.signal?.aborted &&
                      receipt.credentialId === vaultRetry.credentialId &&
                      receipt.accountIdentity === vaultRetry.identity &&
                      admitPiVaultRetry(route, vaultRetry)?.tier
                    )
                  }),
              ).then((attempt) => {
                if (!attempt) vaultRefused = true
                else execution.attemptedVaultIds.add(account.id)
                return attempt
              })
            : account.token
              ? this.attempt(model, context, options, account.id, account.token)
              : Promise.resolve(undefined),
      afterVaultLimit: async (account, feedback, routing) => {
        const refused = { kind: 'vault-refused' } as const
        if (options?.signal?.aborted) return refused
        const retry = (target: PiVaultRetry, delayMs: number) =>
          execution.canWait &&
          delayMs >= 0 &&
          delayMs <= MAX_SAME_ACCOUNT_HOLD_MS
            ? { kind: 'vault-retry' as const, target, delayMs }
            : refused
        if (feedback.kind === 'backoff')
          return retry(
            {
              id: account.id,
              identity: feedback.accountIdentity,
              credentialId: feedback.credentialId,
              accountKey: account.accountKey,
            },
            Math.max(0, feedback.retryAtMs - this.now()),
          )
        const routes = this.vault.routes()
        const accounts = route.accounts()
        const sessionId = options?.sessionId
        const answer = await chooseVaultRouting({
          vaultMode,
          fresh: false,
          sessionId,
          request: { modelId: model.id, kind: piRequestKind(options) },
          routes,
          routing,
          eligibleIds: accounts
            .filter(
              (candidate) => !execution.attemptedVaultIds.has(candidate.id),
            )
            .map((candidate) => candidate.id),
          continuation: {
            previousId: account.id,
            exhausted: feedback.exhausted,
          },
          wait: {
            activity: sessionId ? this.activity.get(sessionId) : undefined,
            accountKey: account.accountKey,
            maxSameAccountWait: execution.canWait
              ? settings?.routing?.maxSameAccountWait
              : 0,
          },
        })
        if (!answer) {
          // Vault mode admits subscription logins, not paid keys. Without a
          // routing answer Pi can still use its order for those logins.
          const currentAuthority = await this.readAuthority()
          if (currentAuthority !== 'host' && currentAuthority !== 'vault')
            return refused
          return undefined
        }
        if (typeof answer === 'string') {
          const selected = routes.find((candidate) => candidate.id === answer)
          if (!selected?.credentialId) return refused
          return {
            kind: 'vault-retry',
            target: {
              id: selected.id,
              identity: selected.identity,
              credentialId: selected.credentialId,
              accountKey: accounts.find((candidate) => candidate.id === answer)
                ?.accountKey,
            },
          }
        }
        if ('holdMs' in answer)
          return retry(
            {
              id: account.id,
              identity: feedback.exhausted.accountId,
              credentialId: feedback.exhausted.credentialId,
              accountKey: account.accountKey,
            },
            answer.holdMs,
          )
        return refused
      },
      placePin: placePiStickyPin,
      creditsServing: this.creditsServing,
      // Only the credits info line: this router's debug lines stay off.
      log: {
        debug: () => {},
        info: (message, data) => routingLog.info(message, data),
      },
    }
    const result = await routePiRequest(route, vaultRetry)
    if (result.kind === 'blocked') {
      // Vault mode never falls back to a local account: a request no vault
      // account could take is refused with a fixed text naming the cause.
      // An admission refusal on quota keeps its own message.
      if (vaultMode && (candidates === 0 || vaultRefused))
        return {
          ...result,
          refusal: vaultRefused
            ? 'vault-refused'
            : vaultModeNoRouteCause(this.vault),
        }
      if (quotaFiltered && result.block.reason === 'no-credential')
        return { ...result, block: { reason: 'quota-minimum' } }
      if (vaultMode && result.block.reason === 'no-credential')
        return { ...result, refusal: 'vault-empty' }
      return result
    }
    return result
  }

  private applyEffort(body: Record<string, unknown>, sessionId: string) {
    const previous = this.effortBySession.get(sessionId)
    const state = previous ?? {}
    applyMidConversationEffort(body, state)
    if (previous || state.pinnedEffort === undefined) return
    this.effortBySession.set(sessionId, state)
    if (this.effortBySession.size > MAX_EFFORT_SESSIONS) {
      const oldest = this.effortBySession.keys().next().value
      if (oldest !== undefined) this.effortBySession.delete(oldest)
    }
  }

  /**
   * Calls pi-ai with one account's token and waits for output or termination.
   * Lifecycle events alone do not commit the attempt to a serving account.
   */
  private async attempt(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    accountId: string,
    token: string,
    receipt?: QuotaReceipt,
    execution?: { billingAttempt?: number },
    freeQuota = false,
  ): Promise<StreamAttempt> {
    const kind = piRequestKind(options)
    const sessionId = options?.sessionId
    const cacheSessionId = kind === 'primary' ? sessionId : undefined
    let sentTurn: FrameTurnRecord | undefined
    const wireSession: PiCodexWireSession | undefined = cacheSessionId
      ? {
          threadID: cacheSessionId,
          windowID: `${cacheSessionId}:0`,
          installationID: this.installationID,
          now: this.now,
          turn: (body) => {
            // Choose from the first unshaped send. Retries and HTTP fallback
            // can use a different body, but still belong to the same attempt.
            if (sentTurn) return sentTurn
            const turn = this.frameTurns.advance(cacheSessionId, body, {
              now: this.now,
              uuid: this.deps.turnUuid ?? uuidV7,
            })
            sentTurn = this.frameTurns.get(cacheSessionId)
            return turn
          },
        }
      : undefined
    let billing: VaultBillingAttempt | undefined
    if (
      receipt?.credentialId &&
      sessionId &&
      execution &&
      hasVaultRoutingAccessor()
    ) {
      execution.billingAttempt = (execution.billingAttempt ?? 0) + 1
      billing = new VaultBillingAttempt(
        sessionId,
        receipt,
        kind,
        model.id,
        execution.billingAttempt,
        (sessionId) => {
          const plan = sessionCacheKeepPlan(sessionId)
          return plan && plan.mode !== 'off'
            ? { on: false, stopReason: 'unsupported' }
            : { on: false }
        },
        freeQuota,
      )
    }
    const account = this.accounts(
      this.settings(this.storageCache?.storage ?? null),
    ).find((value) => value.id === accountId)
    const accountKey = account?.accountKey
    const initialReading = windowsFromQuotaMap(account?.quota)
    let reading = initialReading
    let httpStatus: number | undefined
    let httpBody: string | undefined
    let headers: Headers | undefined
    let limit: { signal: LimitSignal; body: unknown } | undefined
    let wsCompleted = false
    const status = () => limit?.signal.status ?? httpStatus
    const beginSend = () => {
      // pi-ai can retry a send or switch transports without ending its stream.
      httpStatus = undefined
      httpBody = undefined
      headers = undefined
      limit = undefined
      wsCompleted = false
      reading = initialReading
    }
    const mergeReading = (snapshot: OAuthQuotaSnapshot | undefined) => {
      if (!snapshot) return
      const observedAt = this.now()
      for (const window of [snapshot.primary, snapshot.secondary]) {
        if (window) window.checkedAt = observedAt
      }
      reading = { ...reading, ...snapshot }
    }
    let vaultFeedback: VaultRoutingFeedback | undefined
    let failureReported = false
    const reportFailure = () => {
      if (
        failureReported ||
        !receipt ||
        options?.signal?.aborted ||
        !hasVaultRoutingAccessor()
      )
        return
      failureReported = true
      const responseStatus = status()
      if (responseStatus !== 429 && responseStatus !== 403) return
      if (responseStatus === 429 && limit?.signal.kind === 'quota-exhausted') {
        const { signal, body } = limit
        const exhausted = reportVaultRoutingLimit(
          sessionId,
          receipt,
          {
            window: signal.reason,
            resetAt: signal.windows.find(
              (window) => window.confirmed && window.provenance === 'provider',
            )?.resetAt,
          },
          { body, headers, quota: account?.quota, now: signal.observedAt },
        )
        if (exhausted) {
          vaultFeedback = { kind: 'exhausted', exhausted }
          return
        }
      }
      // The provider body has already gone through the limit classifier. An
      // unproved window must not be promoted to exhaustion a second way.
      vaultFeedback = reportVaultRouting(sessionId, receipt, {
        status: responseStatus,
        headers: headers ?? new Headers(),
        now: this.now(),
        backoff: true,
      })
    }
    const dispatch: SessionDispatch | undefined =
      accountKey && cacheSessionId
        ? {
            sessionId: cacheSessionId,
            accountKey,
            dispatchedAt: this.now(),
            ttlMs: ttlForModel(JSON.stringify({ model: model.id })),
          }
        : undefined
    let inner: AssistantMessageEventStream
    try {
      const send = options?.fetch ?? globalThis.fetch
      const httpUrl = piCodexHttpUrl(model.baseUrl)
      const quotaDispatch: PiQuotaDispatch = {
        accountId,
        token,
        ...(receipt && { receipt }),
      }
      // Pi's compaction and summary calls can carry the routing session id,
      // but disable caching. They must not pin or change conversation effort.
      const effortSessionId = cacheSessionId
      const useWebSocketShim =
        this.deps.installWebSocket && options?.transport !== 'sse'
      const streamOptions: SimpleStreamOptions = {
        ...options,
        apiKey: token,
        // On Bun, an explicit environment makes pi-ai read the current WebSocket
        // constructor instead of reusing one cached before the shim was installed.
        ...(useWebSocketShim &&
          process.versions.bun && { env: options?.env ?? {} }),
        // Effort updates belong in pi-ai's logical history; wire-only changes do not.
        onPayload: async (payload, payloadModel) => {
          const logical = omitPiCodexDefaults(payload, options)
          const replacement = await options?.onPayload?.(logical, payloadModel)
          let source = replacement === undefined ? logical : replacement
          if (effortSessionId && isRecord(source)) {
            const body = { ...source }
            this.applyEffort(body, effortSessionId)
            source = body
          }
          // A cached socket may have gone idle while the caller built its payload.
          if (useWebSocketShim) retireIdlePiCodexWebSocket()
          return source
        },
        // Scrub before pi-ai parses errors into its shared partial message objects.
        fetch: Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            beginSend()
            try {
              const response = await send(
                input,
                input === httpUrl
                  ? shapePiCodexHttpRequest(init, wireSession)
                  : init,
              )
              const safe = await redactCredentialResponse(
                response,
                token,
                'event-stream',
                { boundRefusal: !!receipt && hasVaultRoutingAccessor() },
              )
              // Read the same diagnostic pi-ai gets, never a second copy of
              // the provider's potentially unbounded body.
              if (safe.status === 429) httpBody = await safe.clone().text()
              return safe
            } catch (error) {
              // pi-ai can inspect a fetch rejection before emitting its shared partial error.
              throw redactCredentialError(error, token)
            }
          },
          send,
        ),
        onResponse: async (response, responseModel) => {
          httpStatus = response.status
          headers = new Headers(response.headers)
          this.recordHeaders(quotaDispatch, response.headers)
          mergeReading(normalizeQuotaHeaders(headers))
          limit = undefined
          if (accountKey && httpStatus === 429) {
            let body: unknown
            if (httpBody !== undefined) {
              try {
                body = JSON.parse(httpBody)
              } catch {
                // A non-JSON diagnostic can only supply the HTTP status.
              }
            }
            const signal = classifyOpenAiLimitBody({
              account: accountKey,
              status: httpStatus,
              headers,
              body,
              now: this.now(),
              reading,
            })
            if (signal) limit = { signal, body }
          }
          await options?.onResponse?.(response, responseModel)
        },
        onProviderStreamEvent: async (event, eventModel) => {
          if (
            httpStatus === undefined &&
            isRecord(event) &&
            event.type === 'response.completed'
          )
            wsCompleted = true
          // The bound WebSocket records quota before pi-ai dispatches this callback.
          if (httpStatus !== undefined || !useWebSocketShim)
            mergeReading(this.recordQuotaEvent(quotaDispatch, event))
          if (
            accountKey &&
            isRecord(event) &&
            event.type === 'response.failed'
          ) {
            const signal = classifyOpenAiLimitBody({
              account: accountKey,
              body: event,
              headers,
              now: this.now(),
              reading,
            })
            if (signal)
              limit = {
                signal: { ...signal, status: signal.status ?? 429 },
                body: structuredClone(event),
              }
          }
          await options?.onProviderStreamEvent?.(event, eventModel)
        },
      }
      const start = () => this.deps.streamSimple(model, context, streamOptions)
      inner = useWebSocketShim
        ? withPiCodexWebSocketAttempt(
            {
              url: piCodexWebSocketUrl(httpUrl),
              token,
              owner: this,
              session: wireSession,
              onSend: beginSend,
              onMessage: (data) =>
                mergeReading(this.observeWebSocketMessage(quotaDispatch, data)),
            },
            start,
          )
        : start()
    } catch (error) {
      billing?.end(false, false, status())
      return {
        buffered: [
          errorEvent(model, redactCredentialError(error, token).message),
        ],
        rest: undefined,
      }
    }
    const runtime = this
    let outputStarted = false
    const iterator = (async function* () {
      let stopped = false
      let failed = false
      try {
        for await (const event of inner) {
          outputStarted ||= isPiOutput(event)
          if (event.type === 'done') stopped = true
          if (billing) {
            if (event.type === 'done')
              billing.piCompleted(event.message.responseId, event.message.usage)
            else if (event.type === 'error') {
              billing.piResponseId(event.error.responseId)
              if (event.reason !== 'aborted') billing.event({ type: 'error' })
            }
          }
          if (event.type === 'error') {
            failed = true
            // Only pi-ai's terminal result can make the wire observation a
            // routing outcome. A retry or fallback inside pi-ai may succeed.
            if (event.reason !== 'aborted') reportFailure()
            // Routing may discard an unpublished error without draining the iterator.
            billing?.end(outputStarted, false, status())
            // pi-ai reuses this message in earlier start/delta events; a clone leaves those aliases raw.
            event.error.errorMessage =
              outputStarted && event.reason !== 'aborted'
                ? TERMINAL_AFTER_OUTPUT_MESSAGE
                : redactCredentialText(event.error.errorMessage ?? '', token)
          }
          yield event
        }
        if (stopped && !failed && !options?.signal?.aborted) {
          if (dispatch)
            recordSessionCompletion(
              runtime.activity,
              dispatch,
              runtime
                .accounts(
                  runtime.settings(runtime.storageCache?.storage ?? null),
                )
                .find((value) => value.id === accountId)?.accountKey,
              { kind: 'pi', stop: 'stop', aborted: false },
            )
          // Pi's terminal result comes after it finishes consuming the HTTP
          // event stream. A socket must have delivered its completion frame.
          const completedStatus = httpStatus ?? (wsCompleted ? 200 : undefined)
          if (
            completedStatus !== undefined &&
            completedStatus >= 200 &&
            completedStatus < 300
          ) {
            if (cacheSessionId && sentTurn)
              runtime.frameTurns.completed(cacheSessionId, sentTurn)
            reportVaultRouting(sessionId, receipt, {
              status: completedStatus,
              headers: headers ?? new Headers(),
            })
            if (cacheSessionId && hasVaultRoutingAccessor())
              deferSessionCacheResponseTouch(cacheSessionId, runtime.now())
          }
        }
      } catch (error) {
        failed = true
        reportFailure()
        billing?.end(outputStarted, false, status())
        yield errorEvent(
          model,
          outputStarted
            ? TERMINAL_AFTER_OUTPUT_MESSAGE
            : redactCredentialError(error, token).message,
        )
      } finally {
        billing?.end(outputStarted, stopped && !failed, status())
      }
    })()
    const buffered: AssistantMessageEvent[] = []
    let rest: StreamAttempt['rest']
    for (;;) {
      const next = await iterator.next()
      // A stream that ends without output or a terminal event hands its held
      // lifecycle events on unchanged; only a discarded attempt drops them.
      if (next.done) break
      const event = next.value
      buffered.push(event)
      if (event.type === 'error') break
      if (outputStarted || event.type === 'done') {
        rest = iterator
        break
      }
    }
    const attemptStatus = status()
    return {
      // The observed status still reaches billing. Neither the account router
      // nor vault credential recovery may use it to replay an output attempt.
      ...(attemptStatus !== undefined && !outputStarted
        ? { status: attemptStatus }
        : {}),
      ...(httpStatus !== undefined && !outputStarted ? { httpStatus } : {}),
      ...(accountKey ? { accountKey } : {}),
      ...(limit && !outputStarted ? { signal: limit.signal } : {}),
      ...(vaultFeedback && !outputStarted ? { vaultFeedback } : {}),
      ...(reading ? { reading } : {}),
      buffered,
      rest,
    }
  }

  /**
   * One attempt on a vault account, with the token the vault serves for it.
   * The vault sees the attempt's HTTP status, so a 401 is retried once with
   * a newer version of the same login and otherwise reported to the vault.
   * Undefined when the vault refused to serve before anything was sent.
   */
  private async vaultAttempt(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    accountId: string,
    execution: { billingAttempt?: number },
    freeQuota = false,
    revalidate?: (
      receipt: QuotaReceipt,
    ) => Promise<AdmissionTier | false | undefined>,
  ): Promise<StreamAttempt | undefined> {
    let last: StreamAttempt | undefined
    const response = await this.vault.send(
      accountId,
      async (token, attempt) => {
        if (revalidate) {
          const tier = await revalidate(attempt)
          if (!tier) {
            last = undefined
            return new Response(null, { status: 200 })
          }
          freeQuota = tier === 'free'
        }
        // An attempt the vault retries is dropped unread: it ended without
        // streaming, so nothing of it reached Pi.
        last = await this.attempt(
          model,
          context,
          options,
          accountId,
          token,
          attempt,
          execution,
          freeQuota,
        )
        return new Response(null, { status: last.httpStatus ?? 200 })
      },
      { site: 'model', ...(options?.signal ? { signal: options.signal } : {}) },
    )
    return response ? last : undefined
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** What `/openai` reads and changes on the pool. */
  commandSupport(): PiPoolCommands {
    return {
      vaultMode: () => this.vaultMode(),
      readAuthority: () => this.readAuthority(),
      syncVaultSlot: (refresh, explicit) =>
        this.syncVaultSlot(refresh, explicit),
      disconnectVault: () => this.disconnectVault(),
      // In vault mode Pi's login is not used, so it is not taken (taking a
      // new login starts a quota poll with it).
      observeLogin: async (token) => {
        if ((await this.readAuthority()) === 'local')
          this.main.observeToken(token)
      },
      store: () => this.pool.poolStore(),
      mainIdentity: () => this.main.currentIdentity(),
      mainQuota: () => this.main.quotaSnapshot(),
      reload: () => this.pool.load(),
      vault: this.vault,
      refreshAllQuota: async () => {
        const storage =
          (await this.readAuthority()) === 'local' ? await this.storage() : null
        // Vault mode polls the vault's accounts alone.
        if ((await this.readAuthority()) !== 'local')
          return (await this.vault.pollStale(0)).map((row) => ({
            account: row.id,
            ok: row.ok,
            ...(row.error ? { error: row.error } : {}),
          }))
        const [main, rows, vaultRows] = await Promise.all([
          this.main.currentToken() ? this.main.pollNow() : undefined,
          this.pool.pollRows(this.settings(storage)),
          this.vault.pollStale(0),
        ])
        const results: RefreshAllQuotaResults = []
        if (main)
          results.push({
            account: FORMER_MAIN_ID,
            ok: main.ok,
            ...(main.error ? { error: main.error } : {}),
          })
        for (const row of [...rows, ...vaultRows])
          results.push({
            account: row.id,
            ok: row.ok,
            ...(row.error ? { error: row.error } : {}),
          })
        return results
      },
    }
  }
}

/** The pool-backed parts of the Pi `/openai` command. */
export interface PiPoolCommands {
  readAuthority: () => Promise<'host' | 'local' | 'vault' | 'unreadable'>
  syncVaultSlot?: (refresh?: () => unknown, explicit?: boolean) => Promise<void>
  disconnectVault?: () => Promise<'cleared' | 'nothing-to-do'>
  /**
   * Whether Pi is in vault mode. Pi's own login is then not read: asking Pi
   * for its key would make Pi refresh and store that login.
   */
  vaultMode: () => boolean
  /** Takes the token Pi holds for its login now, as a request would. */
  observeLogin: (token: string | undefined) => Promise<void>
  /** The store Pi's pool rows live in. */
  store: () => PoolStore
  /** The ChatGPT account Pi's own login signs in with, when known. */
  mainIdentity: () => string | undefined
  /** The last quota reading of Pi's own login, which is not a pool row. */
  mainQuota: () => OAuthQuotaSnapshot | undefined
  /** Re-reads the pool, so requests route across changed rows at once. */
  reload: () => Promise<unknown>
  /** Polls the quota of Pi's login, every pool row and every vault account now. */
  refreshAllQuota: () => Promise<RefreshAllQuotaResults>
  /** Pi's connection to the Claustrum vault (the Vault section). */
  vault: OpenAiVault
}
