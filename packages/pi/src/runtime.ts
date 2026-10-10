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
// An attempt that fails before streaming anything (an HTTP error answer) may
// be sent again with another account: nothing reached Pi yet. Once an attempt
// has streamed its first event, that attempt is the request's answer.
//
// Quota is recorded from every HTTP response's `x-codex-*` headers and from
// every `codex.rate_limits` WebSocket frame, against the account whose token
// produced it.
//
// Once Pi is connected to the Claustrum vault (`/openai` > Vault), Pi is in
// vault mode: the OpenAI accounts the vault serves it are the only accounts
// routed (`vault.ts` in the core), and each attempt on one sends with the
// token the vault serves for it. Pi's own login and the pool rows are then
// neither used, refreshed, polled nor written; a request no vault account can
// serve is refused with a fixed message. Disconnecting restores them.

import { statSync } from 'node:fs'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import type { PoolRow, PoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  codexRefreshFn,
  extractAccountId,
  isCompleteQuotaHeaderFrame,
  loadAccounts,
  normalizeQuotaHeaders,
  normalizeWsFrame,
  type OAuthQuotaSnapshot,
  OpenAiVault,
  type RefreshAllQuotaResult,
  type RoutingMode,
  VAULT_MODE_REFUSALS,
  VAULT_REQUEST_ROSTER_WAIT_MS,
  type VaultModeRefusal,
  vaultModeNoRouteCause,
  vaultStateDir,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import { observationFromSnapshot } from '@cortexkit/openai-auth-core/pool-quota'
import {
  FORMER_MAIN_ID,
  POOL_QUOTA_UNKNOWN_RETRY_SECONDS,
  type PoolBlock,
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
import { PiMainAccount } from './main-account.ts'
import { getPiAccountPaths } from './paths.ts'
import {
  type RouteAccount,
  type RouteAttempt,
  routablePoolRows,
  routePiRequest,
} from './pool-request.ts'
import { PiPoolSource, settleWithinBudget } from './pool-source.ts'
import { placePiStickyPin } from './routing.ts'

/**
 * How long a request refused for want of a quota reading waits for the first
 * quota poll of Pi's login (row `main`), which is already under way, before
 * routing once more. The poll is one HTTP call (no store lock); without this
 * wait the first request of every Pi process could be refused.
 */
export const FIRST_READING_WAIT_MS = 5_000

/** Longest a request waits for a lock-free re-read of the account settings. */
const STORAGE_READ_BUDGET_MS = 500

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

type RefreshAllQuotaResults = RefreshAllQuotaResult[]

export interface PiOpenAIRuntimeDeps {
  /** Sends one attempt of a request: pi-ai's Codex stream. */
  streamSimple: StreamSimple
  /** Creates the stream handed back to Pi. */
  createStream: () => AssistantMessageEventStream
  /** Installed for the lifetime of one request; returns its uninstaller. */
  installWebSocket?: () => () => void
  paths?: () => AccountPaths
  /** Used for quota polls and token refreshes; read at call time by default. */
  fetchImpl?: typeof fetch
  now?: () => number
  firstReadingWaitMs?: number
  readBudgetMs?: number
  /** Replaces Pi's connection to the Claustrum vault (tests); by default its files live next to the account files. */
  vault?: OpenAiVault
}

/** How many vault tokens are remembered, so a WebSocket frame finds its account. */
const VAULT_TOKENS_KEPT = 64

/** An attempt as the router sees it, with the events it produced so far. */
interface StreamAttempt extends RouteAttempt {
  /** The first event (when there was one), held until the attempt is chosen. */
  head: AssistantMessageEvent | undefined
  /** The rest of the attempt's events, when it is streaming. */
  rest: AsyncIterator<AssistantMessageEvent> | undefined
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

/** The error message Pi shows for a request no account may serve. */
export function blockedMessage(block: PoolBlock): string {
  const reset =
    block.resetAtMs !== undefined
      ? ` It resets at ${new Date(block.resetAtMs).toISOString()}.`
      : ''
  switch (block.reason) {
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

function bearerOf(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue
    const match = /^Bearer\s+(.+)$/i.exec(value.trim())
    return match?.[1]
  }
  return undefined
}

export class PiOpenAIRuntime {
  readonly main: PiMainAccount
  readonly pool: PiPoolSource
  readonly vault: OpenAiVault
  private readonly deps: PiOpenAIRuntimeDeps
  /**
   * The vault account behind each recent vault token, with the receipt the
   * vault served the token under, newest last, so a rate-limit frame
   * arriving on a WebSocket opened with one is recorded against that
   * account. The vault keeps a reading only while the account still holds
   * the receipt's credential and ChatGPT account.
   */
  private readonly vaultTokens = new Map<
    string,
    { id: string; receipt: QuotaReceipt }
  >()
  private readonly now: () => number
  private readonly paths: () => AccountPaths
  private storageCache:
    | { key: string; storage: AccountStorage | null }
    | undefined
  private storageRead:
    | { key: string; promise: Promise<AccountStorage | null> }
    | undefined

  constructor(deps: PiOpenAIRuntimeDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.paths = deps.paths ?? getPiAccountPaths
    const fetchImpl = () => deps.fetchImpl ?? globalThis.fetch
    this.main = new PiMainAccount({
      now: this.now,
      poll: async (token, identity) => {
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
      // polled or written. Read on every use, so a disconnect restores it.
      vaultMode: () => this.vaultMode(),
      refreshProvider: async (credential) => {
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
   * Whether Pi is in vault mode: connected to the Claustrum vault, so only
   * the vault's accounts serve and nothing local is used or touched.
   */
  vaultMode(): boolean {
    return this.vault.enrolled()
  }

  /**
   * Reads the pool once, which starts every row's first quota poll, and
   * starts the vault's background poll of Pi's vault accounts. Never
   * rejects.
   */
  start(): Promise<void> {
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
    return out
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

  private requestPull(id: string): void {
    if (id === FORMER_MAIN_ID) this.main.requestReading()
    else if (this.vault.owns(id)) this.vault.requestReading(id)
    else this.pool.requestReading(id)
  }

  private rememberVaultToken(
    token: string,
    entry: { id: string; receipt: QuotaReceipt },
  ): void {
    this.vaultTokens.delete(token)
    this.vaultTokens.set(token, entry)
    while (this.vaultTokens.size > VAULT_TOKENS_KEPT) {
      const oldest = this.vaultTokens.keys().next().value
      if (oldest === undefined) break
      this.vaultTokens.delete(oldest)
    }
  }

  // -------------------------------------------------------------------------
  // Quota observed on the wire
  // -------------------------------------------------------------------------

  private recordHeaders(
    accountId: string,
    token: string,
    headers: Record<string, string>,
  ): void {
    const parsed = new Headers(headers)
    const snapshot = normalizeQuotaHeaders(parsed) as Record<string, unknown>
    const complete = isCompleteQuotaHeaderFrame(parsed)
    const vaultEntry = this.vaultTokens.get(token)
    if (vaultEntry?.id === accountId)
      void this.vault.recordSnapshot(
        accountId,
        snapshot,
        complete,
        vaultEntry.receipt,
      )
    else if (accountId === FORMER_MAIN_ID)
      this.main.record(snapshot, token, complete)
    else this.pool.recordSnapshot(accountId, snapshot, token, complete)
  }

  /**
   * Records a `codex.rate_limits` frame that arrived on a WebSocket opened
   * with `token`, against the account the token belongs to. A WebSocket may
   * outlive the request that opened it, so the token, not the request,
   * names the account.
   */
  recordRateLimitFrame(token: string, snapshot: Record<string, unknown>): void {
    // A vault token first: in vault mode it may sign in as the same ChatGPT
    // account as Pi's own login, and the reading is the vault account's.
    const vaultEntry = this.vaultTokens.get(token)
    if (vaultEntry) {
      void this.vault.recordSnapshot(
        vaultEntry.id,
        snapshot,
        true,
        vaultEntry.receipt,
      )
      return
    }
    if (this.main.record(snapshot, token, true)) return
    const row = this.pool.rowForToken(token)
    if (row) this.pool.recordSnapshot(row.id, snapshot, token, true)
  }

  /** The handler a raw WebSocket hands its frames to. */
  observeWebSocketMessage(headers: Record<string, string>, data: string): void {
    if (!data.includes('codex.rate_limits')) return
    const token = bearerOf(headers)
    if (!token) return
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (
      !event ||
      typeof event !== 'object' ||
      (event as { type?: unknown }).type !== 'codex.rate_limits'
    )
      return
    this.recordRateLimitFrame(
      token,
      normalizeWsFrame(
        event as Parameters<typeof normalizeWsFrame>[0],
      ) as Record<string, unknown>,
    )
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
    void (async () => {
      try {
        const attempt = await this.route(model, context, options)
        if (attempt.kind === 'blocked') {
          outer.push(
            errorEvent(
              model,
              attempt.refusal
                ? VAULT_MODE_REFUSALS[attempt.refusal]
                : blockedMessage(attempt.block),
            ),
          )
          return
        }
        if (attempt.head) outer.push(attempt.head)
        if (attempt.rest) {
          for (;;) {
            const next = await attempt.rest.next()
            if (next.done) break
            outer.push(next.value)
          }
        }
      } catch (error) {
        outer.push(
          errorEvent(
            model,
            error instanceof Error ? error.message : String(error),
          ),
        )
      } finally {
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
  ): Promise<
    | ({ kind: 'sent' } & StreamAttempt)
    | { kind: 'blocked'; block: PoolBlock; refusal?: VaultModeRefusal }
  > {
    const vaultMode = this.vaultMode()
    const storage = await this.storage()
    if (vaultMode) {
      // Vault mode: Pi's login (the key Pi hands over) and the pool are not
      // used. Before the vault's first account list there is nothing to
      // route, so that is waited for, for a bounded time.
      await settleWithinBudget(
        this.vault.firstRoster().then(() => true),
        VAULT_REQUEST_ROSTER_WAIT_MS,
        () => false,
      )
    } else {
      this.main.observeToken(options?.apiKey)
      await this.pool.current()
      // Token refreshes of pool rows run in the background, so no request
      // waits on the pool store's locks; a row whose token ran out sits out
      // until its refresh lands.
      void this.pool.refreshDueTokens(this.pool.peek().rows, storage)
    }
    const mode: RoutingMode = storage?.routing?.mode ?? 'main-first'
    let vaultRefused = false
    let candidates = 0
    const run = () =>
      routePiRequest<StreamAttempt>({
        accounts: () => {
          const accounts = this.accounts(storage)
          candidates = accounts.length
          return accounts
        },
        storage,
        mode,
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
        send: (account) =>
          account.vault
            ? this.vaultAttempt(model, context, options, account.id).then(
                (attempt) => {
                  if (!attempt) vaultRefused = true
                  return attempt
                },
              )
            : account.token
              ? this.attempt(model, context, options, account.id, account.token)
              : Promise.resolve(undefined),
        placePin: placePiStickyPin,
      })
    let result = await run()
    if (
      result.kind === 'blocked' &&
      result.block.reason === 'quota-unknown' &&
      !vaultMode
    ) {
      const pending = this.main.pending()
      if (pending) {
        await settleWithinBudget(
          pending.then(() => true),
          this.deps.firstReadingWaitMs ?? FIRST_READING_WAIT_MS,
          () => false,
        )
        result = await run()
      }
    }
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
      if (vaultMode && result.block.reason === 'no-credential')
        return { ...result, refusal: 'vault-empty' }
      return result
    }
    return { kind: 'sent', ...result.attempt }
  }

  /**
   * Sends the request once with `token` and waits for its first event. An
   * attempt whose first event is an error has ended without streaming
   * anything, so the router may try another account.
   */
  private async attempt(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    accountId: string,
    token: string,
  ): Promise<StreamAttempt> {
    let status: number | undefined
    let inner: AssistantMessageEventStream
    try {
      inner = this.deps.streamSimple(model, context, {
        ...options,
        apiKey: token,
        onResponse: async (response, responseModel) => {
          status = response.status
          this.recordHeaders(accountId, token, response.headers)
          await options?.onResponse?.(response, responseModel)
        },
      })
    } catch (error) {
      return {
        head: errorEvent(
          model,
          error instanceof Error ? error.message : String(error),
        ),
        rest: undefined,
      }
    }
    const iterator = (inner as AsyncIterable<AssistantMessageEvent>)[
      Symbol.asyncIterator
    ]()
    const first = await iterator.next()
    const head = first.done ? undefined : first.value
    return {
      ...(status !== undefined ? { status } : {}),
      head,
      rest: first.done || head?.type === 'error' ? undefined : iterator,
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
  ): Promise<StreamAttempt | undefined> {
    let last: StreamAttempt | undefined
    const response = await this.vault.send(
      accountId,
      async (token, attempt) => {
        // Only the receipt's attribution fields are kept, never the token.
        this.rememberVaultToken(token, {
          id: accountId,
          receipt: {
            credentialId: attempt.credentialId,
            accountIdentitySource: attempt.accountIdentitySource,
            ...(attempt.accountIdentity !== undefined
              ? { accountIdentity: attempt.accountIdentity }
              : {}),
            ...(attempt.expectedAccountIdentity !== undefined
              ? { expectedAccountIdentity: attempt.expectedAccountIdentity }
              : {}),
          },
        })
        // An attempt the vault retries is dropped unread: it ended without
        // streaming, so nothing of it reached Pi.
        last = await this.attempt(model, context, options, accountId, token)
        return new Response(null, { status: last.status ?? 200 })
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
      // In vault mode Pi's login is not used, so it is not taken (taking a
      // new login starts a quota poll with it).
      observeLogin: (token) => {
        if (!this.vaultMode()) this.main.observeToken(token)
      },
      store: () => this.pool.poolStore(),
      mainIdentity: () => this.main.currentIdentity(),
      mainQuota: () => this.main.quotaSnapshot(),
      reload: () => this.pool.load(),
      vault: this.vault,
      refreshAllQuota: async () => {
        // Vault mode polls the vault's accounts alone.
        if (this.vaultMode())
          return (await this.vault.pollStale(0)).map((row) => ({
            account: row.id,
            ok: row.ok,
            ...(row.error ? { error: row.error } : {}),
          }))
        const storage = await this.storage()
        const [main, rows, vaultRows] = await Promise.all([
          this.main.currentToken() ? this.main.pollNow() : undefined,
          this.pool.pollRows(storage),
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
  /**
   * Whether Pi is in vault mode. Pi's own login is then not read: asking Pi
   * for its key would make Pi refresh and store that login.
   */
  vaultMode: () => boolean
  /** Takes the token Pi holds for its login now, as a request would. */
  observeLogin: (token: string | undefined) => void
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
