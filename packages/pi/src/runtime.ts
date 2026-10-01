// The request path of the Pi package: which OpenAI account each Pi request is
// sent with, and what the responses say about each account's quota.
//
// Pi hands every `openai-codex` request to this extension with the access
// token of Pi's own login. That login is routed as row `main`
// (`main-account.ts`); the rows of Pi's account pool (`pool-source.ts`) are
// the fallbacks. Each request is routed by the mode `/openai-routing` set
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

import { statSync } from 'node:fs'
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
  type RefreshAllQuotaResult,
  type RoutingMode,
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
}

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
      return 'Every OpenAI account is below its killswitch quota floor (see `/openai-routing`).'
    case 'mid-stream-rate-limit':
      return `Every OpenAI account is rate-limited.${reset}`
    case 'no-credential':
      return 'No OpenAI account holds a usable sign-in. Sign in with `/login` or add an account with `/openai-account add`.'
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
  private readonly deps: PiOpenAIRuntimeDeps
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
  }

  /** Reads the pool once, which starts every row's first quota poll. Never rejects. */
  start(): Promise<void> {
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

  /** The accounts one request may be sent with: Pi's login, then the pool rows. */
  private accounts(storage: AccountStorage | null): RouteAccount[] {
    const out: RouteAccount[] = []
    const mainToken = this.main.currentToken()
    const mainIdentity = this.main.currentIdentity()
    if (mainToken) {
      const quota = this.main.quotaMap()
      out.push({
        id: FORMER_MAIN_ID,
        token: mainToken,
        ...(mainIdentity ? { identity: mainIdentity } : {}),
        ...(quota ? { quota } : {}),
      })
    }
    const view = this.pool.peek()
    if (!view.active) return out
    const now = this.now()
    for (const row of routablePoolRows(view.rows, storage, now, mainIdentity)) {
      out.push({
        id: row.id,
        token: this.pool.usableToken(row, now),
        ...(row.identity ? { identity: row.identity } : {}),
        ...(row.quota !== undefined ? { quota: row.quota } : {}),
      })
    }
    return out
  }

  private poolRowById(id: string): PoolRow | undefined {
    return this.pool.peek().rows.find((row) => row.id === id)
  }

  private requestPull(id: string): void {
    if (id === FORMER_MAIN_ID) this.main.requestReading()
    else this.pool.requestReading(id)
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
    if (accountId === FORMER_MAIN_ID)
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
          outer.push(errorEvent(model, blockedMessage(attempt.block)))
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
    ({ kind: 'sent' } & StreamAttempt) | { kind: 'blocked'; block: PoolBlock }
  > {
    this.main.observeToken(options?.apiKey)
    const storage = await this.storage()
    await this.pool.current()
    // Token refreshes of pool rows run in the background, so no request waits
    // on the pool store's locks; a row whose token ran out sits out until its
    // refresh lands.
    void this.pool.refreshDueTokens(this.pool.peek().rows, storage)
    const mode: RoutingMode = storage?.routing?.mode ?? 'main-first'
    const run = () =>
      routePiRequest<StreamAttempt>({
        accounts: () => this.accounts(storage),
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
        send: (account, token) =>
          this.attempt(model, context, options, account.id, token),
        placePin: placePiStickyPin,
      })
    let result = await run()
    if (result.kind === 'blocked' && result.block.reason === 'quota-unknown') {
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
    if (result.kind === 'blocked') return result
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

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** What `/openai` reads and changes on the pool. */
  commandSupport(): PiPoolCommands {
    return {
      observeLogin: (token) => this.main.observeToken(token),
      store: () => this.pool.poolStore(),
      mainIdentity: () => this.main.currentIdentity(),
      mainQuota: () => this.main.quotaSnapshot(),
      reload: () => this.pool.load(),
      refreshAllQuota: async () => {
        const storage = await this.storage()
        const [main, rows] = await Promise.all([
          this.main.currentToken() ? this.main.pollNow() : undefined,
          this.pool.pollRows(storage),
        ])
        const results: RefreshAllQuotaResults = []
        if (main)
          results.push({
            account: FORMER_MAIN_ID,
            ok: main.ok,
            ...(main.error ? { error: main.error } : {}),
          })
        for (const row of rows)
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
  /** Polls the quota of Pi's login and every pool row now. */
  refreshAllQuota: () => Promise<RefreshAllQuotaResults>
}
