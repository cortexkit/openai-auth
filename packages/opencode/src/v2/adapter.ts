// openai-auth's half of the OpenCode 2 hooks recipe: everything OpenAI- and
// pool-specific that `@cortexkit/common-auth/opencode2` leaves to its caller.
//
// OpenCode 2 sends every model request itself, through its own OpenAI driver
// (HTTP or its WebSocket). The installer in common-auth edits those requests
// at fixed points and asks this adapter:
//
// - which pool row a request goes to (`chooseAccount`): the same routing the
//   OpenCode 1 request path uses on a migrated install (`core/pool-request.ts`
//   over `@cortexkit/openai-auth-core/pool-routing`), with the session pins in
//   memory (`pins.ts`). A request of another kind than the agent loop (title,
//   compaction, generate) follows the session's account;
// - the row's credential (`accountHeaders`): its bearer and its
//   `chatgpt-account-id`, with the Codex client identity (`codex-wire.ts`);
// - the request body and WebSocket frame rewrites that keep OpenCode 1's
//   wire behaviour (`rewriteRequest`, `rewriteWebSocketFrame`, see
//   `codex-wire.ts`): mid-conversation effort and Responses Lite;
// - what a response says about the row: quota from the `x-codex-*` headers
//   and `codex.rate_limits` frames, refusals for a usage or rate limit, and
//   whether output has started (openai-auth's own rule, `isNonEmittingFrame`).
//
// The installer retries a request refused before any output on another
// account, and never after output; `attach` records the refusal as a
// rate-limit mark on the row first, so the next `chooseAccount` routes
// around it.
//
// The OpenAI accounts the Claustrum vault serves this host are routed beside
// the pool rows, through the same admission and modes, by OpenCode 1's rules
// (`core/pool-request.ts`): a pool row signing in as a ChatGPT account the
// vault holds is left out, and only ChatGPT logins are admitted, never API
// keys. A vault account holds no token: when routing picks one, the vault is
// asked to authorize that one send, and a refusal moves the request to the
// next account before anything is sent. The receipt (served token and record
// version) becomes the attempt's `data`, never a header, and a 401 on that
// attempt is reported to the vault against that record version.

import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import type {
  AccountHeadersResult,
  AccountRequest,
  Attempt,
  ChooseAccountInput,
  EventVerdict,
  HostError,
  LimitSignal,
  OpenCode2AuthAdapter,
  OpenCode2AuthInstallation,
} from '@cortexkit/common-auth/opencode2'
import { isQuotaMap } from '@cortexkit/common-auth/quota'
import type { RoutingRow } from '@cortexkit/common-auth/routing'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  extractAccountIdFromClaims,
  getKillswitchThresholdsForAccount,
  isCompleteQuotaHeaderFrame,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  normalizeQuotaHeaders,
  normalizeWsFrame,
  type OpenAiVault,
  parseJwtClaims,
  type RoutingMode,
  resolveMidStreamRateLimitResetAt,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolAccountSource } from '../core/pool-account-source'
import { windowsFromQuotaMap } from '../core/pool-quota'
import { routableRows } from '../core/pool-request'
import {
  admitSticky,
  FORMER_MAIN_ID,
  orderedPlacement,
  type PoolRoutingInput,
  planOrdered,
  routePinnedRow,
  type StickyRouteOptions,
  selectStickyRow,
} from '../core/pool-routing'
import { isNonEmittingFrame, parseRateLimitSignal } from '../ws'
import {
  CODEX_CLIENT_HEADERS,
  MidConversationEffort,
  rewriteCodexFrame,
  rewriteCodexHttpRequest,
} from './codex-wire'
import type { SessionPins } from './pins'

/** The provider (and integration) OpenCode 2 serves ChatGPT logins under. */
export const OPENAI_PROVIDER_ID = 'openai'

/**
 * How long a row stays marked after a refusal that named no reset and whose
 * window has no known reset either; the value OpenCode 1 uses
 * (`DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS` in `src/index.ts`).
 */
export const DEFAULT_LIMIT_MARK_MS = 60_000

/**
 * The size every request counts for in sticky placement. OpenCode 2 hands
 * the hooks no request body before the account is chosen, so each session
 * counts the same: placement then weighs the number of sessions on a row
 * against the row's spendable quota. It must be above zero: placement scores
 * a row as (other sessions' bytes + this request's bytes) / weight, and with
 * zero everywhere every row ties and the roster order alone decides.
 */
const NOMINAL_REQUEST_BYTES = 1

/** Most sessions whose last agent-loop account is remembered. */
const MAX_SESSION_ACCOUNTS = 1024

/** One quota reading, as the OpenCode 1 request path records it. */
export interface CodexQuotaReading {
  /** `OAuthQuotaSnapshot` fields, as the normalizers produce them. */
  snapshot: Record<string, unknown>
  /** Whether the reading covers every window (see `isCompleteQuotaHeaderFrame`). */
  complete: boolean
}

/** The parts of the pool source the adapter uses. */
export type PoolAccess = Pick<
  PoolAccountSource,
  | 'current'
  | 'peek'
  | 'prepareTokens'
  | 'usableToken'
  | 'rateLimitMarks'
  | 'refreshBackoffFor'
  | 'requestReading'
  | 'recordSnapshot'
  | 'markRateLimited'
>

export interface OpenAIAdapterLogger {
  debug(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

/** The parts of this host's vault (`OpenAiVault`) the adapter uses. */
export type VaultAccess = Pick<
  OpenAiVault,
  | 'routes'
  | 'identities'
  | 'authorize'
  | 'reportFailure'
  | 'recordSnapshot'
  | 'requestReading'
>

/**
 * What one send went out with, carried as the attempt's `data`: the pool
 * row's token (a quota reading is recorded only with the token it was taken
 * under), or the vault's receipt for that send.
 */
export type OpenAIAttemptData =
  | { readonly kind: 'pool'; readonly token: string }
  | {
      readonly kind: 'vault'
      readonly routeId: string
      readonly receipt: ClaustrumScopedAttempt
    }

export interface OpenAIAdapterDeps {
  source: PoolAccess
  /** The settings a request reads (routing mode, killswitch, quota policy). */
  storage: () => Promise<AccountStorage | null>
  pins: SessionPins
  /** This host's vault accounts; absent when none are routed. */
  vault?: VaultAccess
  /** Whether the Responses Lite shape is on (the `responsesLite` setting). */
  responsesLite?: () => boolean
  now?: () => number
  log?: OpenAIAdapterLogger
}

export interface OpenAIAdapter {
  readonly adapter: OpenCode2AuthAdapter<CodexQuotaReading, OpenAIAttemptData>
  /** Records quota and refusals from the installer's events on the pool. */
  attach(
    installation: OpenCode2AuthInstallation<
      CodexQuotaReading,
      OpenAIAttemptData
    >,
  ): void
  /** Drops a session's pin and remembered account. */
  forgetSession(sessionId: string): void
}

/** One account a request may go to: a pool row or a vault account. */
interface Target {
  id: string
  /** The ChatGPT account it signs in as, when known. */
  identity?: string
  quota: unknown
  /** The pool row; absent for a vault account. */
  row?: PoolRow
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function identityOfToken(token: string): string | undefined {
  const claims = parseJwtClaims(token)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

/**
 * Error codes the Responses API uses for an account that may not be served
 * now. Seen in `response.failed` frames as `response.error.code`/`type`.
 */
const ACCOUNT_LIMIT_CODES = new Set([
  'usage_limit_reached',
  'rate_limit_exceeded',
])

function toLimit(
  signal: { window: string; resetAt?: number },
  now: number,
  status?: number,
): LimitSignal {
  return {
    reason: signal.window,
    ...(status !== undefined ? { status } : {}),
    ...(signal.resetAt !== undefined
      ? { retryAfterMs: Math.max(0, signal.resetAt - now) }
      : {}),
  }
}

/**
 * An account-level refusal carried by one streamed event or WebSocket frame,
 * by the rules OpenCode 1's WebSocket transport (`ws.ts`) applies: an error
 * with `usage_limit_reached` or status 429 (`parseRateLimitSignal`), or a
 * `response.failed` naming the rate-limit window it hit.
 */
export function limitOfEvent(
  event: Record<string, unknown>,
  now: number,
): LimitSignal | undefined {
  const signal = parseRateLimitSignal(event)
  if (signal) {
    const status = typeof event.status === 'number' ? event.status : undefined
    return toLimit(signal, now, status)
  }
  if (event.type !== 'response.failed' || !isRecord(event.response))
    return undefined
  const failed = event.response.failed
  if (isRecord(failed) && typeof failed.rate_limit_reached_type === 'string')
    return { reason: failed.rate_limit_reached_type }
  const error = event.response.error
  if (isRecord(error)) {
    const code =
      typeof error.code === 'string'
        ? error.code
        : typeof error.type === 'string'
          ? error.type
          : undefined
    if (code && ACCOUNT_LIMIT_CODES.has(code)) return { reason: code }
  }
  return undefined
}

/**
 * What one SSE event's `data` or one WebSocket frame says: quota
 * (`codex.rate_limits`), an account-level refusal, or output the user has
 * seen. Output follows OpenCode 1's rule: every frame counts except
 * `response.created`, `response.in_progress` and `codex.*`; an `error` frame
 * and a refusal are never output.
 */
export function inspectCodexEvent(
  data: string,
  now: number,
): EventVerdict<CodexQuotaReading> | undefined {
  const event = parseJson(data)
  if (!isRecord(event)) return undefined
  const type = typeof event.type === 'string' ? event.type : undefined
  if (type === 'codex.rate_limits') {
    return {
      quota: {
        snapshot: normalizeWsFrame(event as never) as Record<string, unknown>,
        complete: true,
      },
    }
  }
  const limit = limitOfEvent(event, now)
  if (limit) return { limit }
  if (type === undefined || type === 'error') return undefined
  return isNonEmittingFrame(type) ? undefined : { outputStarted: true }
}

/** Quota from the `x-codex-*` response headers; undefined when there are none. */
export function quotaFromCodexHeaders(
  headers: Headers,
): CodexQuotaReading | undefined {
  let any = false
  for (const name of headers.keys()) {
    if (name.toLowerCase().startsWith('x-codex-')) {
      any = true
      break
    }
  }
  if (!any) return undefined
  return {
    snapshot: normalizeQuotaHeaders(headers) as Record<string, unknown>,
    complete: isCompleteQuotaHeaderFrame(headers),
  }
}

/** Seconds from a `Retry-After` header, when it holds a number. */
function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export function createOpenAIAdapter(deps: OpenAIAdapterDeps): OpenAIAdapter {
  const { source, pins } = deps
  const now = deps.now ?? Date.now
  const log = deps.log
  const vault = deps.vault
  const effort = new MidConversationEffort()
  // Vault receipts authorized while choosing an account, waiting for the
  // `accountHeaders` call that follows for the same request and account.
  const receipts = new Map<string, ClaustrumScopedAttempt>()
  const receiptKey = (scope: AccountRequest) =>
    `${scope.sessionID}\u0000${scope.kind}\u0000${scope.accountId}`
  // Rate-limit marks of vault accounts (the pool source marks only its own
  // rows): account id to the mark's expiry time.
  const vaultMarks = new Map<string, number>()
  // The row each session's latest agent-loop request went to, which its
  // title, compaction and generate requests follow in the ordered modes.
  const sessionAccounts = new Map<string, string>()

  const rememberSessionAccount = (sessionId: string, accountId: string) => {
    sessionAccounts.delete(sessionId)
    sessionAccounts.set(sessionId, accountId)
    while (sessionAccounts.size > MAX_SESSION_ACCOUNTS) {
      const oldest = sessionAccounts.keys().next().value
      if (oldest === undefined) break
      sessionAccounts.delete(oldest)
    }
  }

  /**
   * The accounts one request may be sent with now: the routable pool rows,
   * then the vault's ChatGPT logins.
   */
  const currentTargets = (
    storage: AccountStorage | null,
    at: number,
  ): Target[] => {
    const rows = routableRows(
      source.peek().rows,
      storage,
      at,
      vault?.identities() ?? new Set<string>(),
    )
    const routes = (vault?.routes() ?? []).filter(
      (route) => route.kind === 'oauth',
    )
    return [
      ...rows.map(
        (row): Target => ({
          id: row.id,
          ...(row.identity !== undefined ? { identity: row.identity } : {}),
          quota: row.quota,
          row,
        }),
      ),
      ...routes.map(
        (route): Target => ({
          id: route.id,
          ...(route.identity !== undefined ? { identity: route.identity } : {}),
          quota: route.quota,
        }),
      ),
    ]
  }

  const routingInput = (
    targets: readonly Target[],
    storage: AccountStorage | null,
    at: number,
  ): PoolRoutingInput => {
    const killswitch = new Map<string, boolean>()
    if (isKillswitchEnabled(storage)) {
      for (const target of targets) {
        killswitch.set(
          target.id,
          killswitchPassesPolicy(
            windowsFromQuotaMap(target.quota),
            storage,
            target.id === FORMER_MAIN_ID ? undefined : target.id,
            at,
          ),
        )
      }
    }
    const routingRows: RoutingRow[] = targets.map((target) => ({
      id: target.id,
      kind: 'oauth',
      ...(isQuotaMap(target.quota) ? { quota: target.quota } : {}),
    }))
    const rows = targets.flatMap((target) => (target.row ? [target.row] : []))
    const vaultIds = new Set(
      targets.filter((target) => !target.row).map((target) => target.id),
    )
    const rateLimitMarks = source.rateLimitMarks(rows)
    for (const id of vaultIds) {
      const until = vaultMarks.get(id)
      if (until === undefined) continue
      if (until <= at) vaultMarks.delete(id)
      else rateLimitMarks.set(id, until)
    }
    return {
      rows: routingRows,
      now: at,
      rateLimitMarks,
      refreshBackoff: source.refreshBackoffFor(rows),
      killswitch,
      requestPull: (id) =>
        vaultIds.has(id)
          ? vault?.requestReading(id)
          : source.requestReading(id),
    }
  }

  /** main-first, fallback-first and roster order: the first admitted row. */
  const chooseOrdered = (
    routing: PoolRoutingInput,
    mode: RoutingMode | string,
    excluded: ReadonlySet<string>,
    follow: string | undefined,
  ): string | undefined => {
    const plan = planOrdered({ ...routing, placement: orderedPlacement(mode) })
    if (plan.kind === 'block') {
      log?.debug('pool admission refused the request', {
        reason: plan.block.reason,
      })
      return undefined
    }
    const order = plan.order.filter((id) => !excluded.has(id))
    if (follow !== undefined && order.includes(follow)) return follow
    return order[0]
  }

  /**
   * sticky-balanced: the session's pin while its row can serve; a row
   * confirmed unable to serve loses the pin for good, a row whose quota is
   * not known yet is served around for this request only. Requests of
   * another kind than the agent loop never move the pin.
   */
  const chooseSticky = (
    routing: PoolRoutingInput,
    targets: readonly Target[],
    storage: AccountStorage | null,
    sessionId: string,
    excluded: ReadonlySet<string>,
    persist: boolean,
  ): string | undefined => {
    const options: StickyRouteOptions = {
      requestBytes: NOMINAL_REQUEST_BYTES,
      reservePercent: (id) =>
        getKillswitchThresholdsForAccount(
          storage,
          id === FORMER_MAIN_ID ? undefined : id,
        ),
      // OpenCode 1 breaks placement ties by the reset credits an account
      // holds, which only its in-memory quota cache records; nothing here
      // records them, so ties fall to the roster order.
      resetCredits: () => undefined,
    }
    const sticky = admitSticky(routing)
    const place = (exclude: readonly string[], keep: boolean) =>
      pins.place({
        sessionId,
        requestBytes: NOMINAL_REQUEST_BYTES,
        validPinnedAccountIds: routing.rows
          .map((row) => row.id)
          .filter((id) => !sticky.excluded.has(id)),
        excludeAccountIds: exclude,
        quotaCheckedAtByAccount: Object.fromEntries(
          routing.rows.map((row) => [
            row.id,
            sticky.projections.get(row.id)?.checkedAt,
          ]),
        ),
        wireAccountIdByAccount: Object.fromEntries(
          targets.map((target) => [target.id, target.identity]),
        ),
        select: (pendingBytes) =>
          selectStickyRow(routing, options, new Set(exclude), pendingBytes),
        persist: keep,
      })
    const base = [...excluded]
    const assignment = place(base, persist)
    if (!assignment) return undefined
    const id = assignment.accountId
    const pinned = routePinnedRow(routing, options, id)
    if (pinned.kind === 'none') return undefined
    if (pinned.kind === 'move') {
      const replacement = place([...base, id], persist)
      if (replacement) return replacement.accountId
      // No other row can take the session: a row whose quota reads spent is
      // still sent to, as OpenCode 1 does (the reading may be stale and the
      // provider decides); a row below its killswitch floor never is.
      return pinned.reason === 'killswitch' ? undefined : id
    }
    if (pinned.kind === 'detour') {
      const detour = place([...base, id], false)
      return detour?.accountId
    }
    return id
  }

  const chooseAccount = async (
    input: ChooseAccountInput,
  ): Promise<string | undefined> => {
    const storage = await deps.storage()
    const view = await source.current()
    if (!view.active) {
      log?.warn(
        'the account pool does not serve requests yet; refusing the request',
        { kind: input.kind },
      )
      return undefined
    }
    await source.prepareTokens(source.peek().rows, storage)
    const at = now()
    const targets = currentTargets(storage, at)
    const byId = new Map(targets.map((target) => [target.id, target]))
    const routing = routingInput(targets, storage, at)
    const excluded = new Set<string>(
      input.rerouteFrom ? [input.rerouteFrom.accountId] : [],
    )
    const mode: RoutingMode = storage?.routing?.mode ?? 'main-first'
    const primary = input.kind === 'primary'
    // Vault accounts the vault would not serve for this request. Nothing was
    // sent with them, so the choice runs again as if they were not there.
    const refused = new Set<string>()
    let accountId: string | undefined
    for (;;) {
      const skip = new Set([...excluded, ...refused])
      accountId = undefined
      if (mode === 'sticky-balanced') {
        accountId = chooseSticky(
          routing,
          targets,
          storage,
          input.sessionID,
          skip,
          // A vault refusal may be passing (the vault unreachable for a
          // moment), so it does not move the session's pin.
          primary && refused.size === 0,
        )
      }
      accountId ??= chooseOrdered(
        routing,
        mode,
        skip,
        primary ? undefined : sessionAccounts.get(input.sessionID),
      )
      if (accountId === undefined || refused.has(accountId)) {
        accountId = undefined
        break
      }
      if (!vault || byId.get(accountId)?.row) break
      const receipt = await vault.authorize(accountId)
      if (receipt) {
        receipts.set(receiptKey({ ...input, accountId }), receipt)
        break
      }
      log?.debug('the vault refused to serve an account; choosing again', {
        accountId,
      })
      refused.add(accountId)
    }
    if (accountId !== undefined && primary)
      rememberSessionAccount(input.sessionID, accountId)
    log?.debug('pool account chosen', {
      kind: input.kind,
      accountId,
      mode,
      ...(input.rerouteFrom
        ? { rerouteFrom: input.rerouteFrom.accountId }
        : {}),
    })
    return accountId
  }

  const accountHeaders = async (
    request: AccountRequest,
  ): Promise<AccountHeadersResult<OpenAIAttemptData>> => {
    const { accountId } = request
    // Never throw here: a throw in the WebSocket handshake switches the
    // session to HTTP for good. Removing the credential sends the request
    // without one, which the provider refuses, rather than with the host's
    // placeholder.
    const none = {
      headers: {
        ...CODEX_CLIENT_HEADERS,
        authorization: null,
        'chatgpt-account-id': null,
      },
    }
    const row = source
      .peek()
      .rows.find((candidate) => candidate.id === accountId)
    if (!row && vault) {
      const key = receiptKey(request)
      const receipt = receipts.get(key) ?? (await vault.authorize(accountId))
      receipts.delete(key)
      if (!receipt) {
        log?.warn('the vault refused to serve an account; sending without', {
          accountId,
        })
        return none
      }
      return {
        headers: {
          ...CODEX_CLIENT_HEADERS,
          authorization: `Bearer ${receipt.accessToken}`,
          'chatgpt-account-id':
            receipt.accountIdentity ??
            identityOfToken(receipt.accessToken) ??
            null,
        },
        attempt: { kind: 'vault', routeId: accountId, receipt },
      }
    }
    const token = row ? source.usableToken(row) : undefined
    if (!row || !token) {
      log?.warn('pool row holds no usable token; sending without one', {
        accountId,
      })
      return none
    }
    const identity = row.identity ?? identityOfToken(token)
    return {
      headers: {
        ...CODEX_CLIENT_HEADERS,
        authorization: `Bearer ${token}`,
        'chatgpt-account-id': identity ?? null,
      },
      attempt: { kind: 'pool', token },
    }
  }

  const adapter: OpenCode2AuthAdapter<CodexQuotaReading, OpenAIAttemptData> = {
    providerID: OPENAI_PROVIDER_ID,
    chooseAccount,
    accountHeaders,
    rewriteRequest: ({ request, sessionID, kind }) =>
      rewriteCodexHttpRequest(
        request,
        { sessionID, kind },
        effort,
        deps.responsesLite?.() ?? false,
      ),
    rewriteWebSocketFrame: ({ frame, sessionID, kind }) =>
      rewriteCodexFrame(frame, { sessionID, kind }, effort),
    quotaFromHeaders: (headers) => quotaFromCodexHeaders(headers),
    async limitFromResponse({ status, headers, body }) {
      if (status < 400) return undefined
      const parsed = parseJson(await body().catch(() => ''))
      const signal = parseRateLimitSignal({
        ...(isRecord(parsed) ? parsed : {}),
        status,
      })
      if (!signal) return undefined
      const at = now()
      const limit = toLimit(signal, at, status)
      if (limit.retryAfterMs !== undefined) return limit
      const after = retryAfterMs(headers)
      return after === undefined ? limit : { ...limit, retryAfterMs: after }
    },
    inspectEvent: ({ data }) => inspectCodexEvent(data, now()),
    limitFromError(error: HostError) {
      const parsed = parseJson(error.message)
      const signal =
        parseRateLimitSignal({
          ...(isRecord(parsed) ? parsed : {}),
          ...(error.status !== undefined ? { status: error.status } : {}),
        }) ??
        (error.message.includes('usage_limit_reached')
          ? { window: 'usage_limit_reached' }
          : undefined)
      return signal ? toLimit(signal, now(), error.status) : undefined
    },
    // A 401 on a send the vault authorized is reported against the record
    // version that send used; nothing else is reported. Only an HTTP
    // response has a status here: a refused WebSocket handshake reaches no
    // hook.
    async onAttemptEnd(attempt, outcome) {
      const data = attempt.data
      if (data?.kind !== 'vault' || outcome.status !== 401) return
      log?.warn('a vault account answered 401; reporting it to the vault', {
        accountId: attempt.accountId,
      })
      await vault?.reportFailure(data.receipt, 401)
    },
  }

  const recordQuota = (
    accountId: string,
    reading: CodexQuotaReading,
    handle: Attempt<OpenAIAttemptData>,
  ) => {
    const data = handle.data
    if (data?.kind === 'vault') {
      // A vault account's quota lives in the vault roster, kept only while
      // the account still signs in as the one this send was served for.
      void vault?.recordSnapshot(
        accountId,
        reading.snapshot,
        reading.complete,
        data.receipt,
      )
      return
    }
    // The pool drops a reading whose token is not the row's own any more.
    if (data?.kind === 'pool')
      source.recordSnapshot(
        accountId,
        reading.snapshot,
        data.token,
        reading.complete,
      )
  }

  const markLimited = (
    accountId: string,
    limit: LimitSignal,
    handle: Attempt<OpenAIAttemptData>,
  ) => {
    const at = now()
    const fromVault = handle.data?.kind === 'vault'
    const quota = fromVault
      ? vault?.routes().find((route) => route.id === accountId)?.quota
      : source.peek().rows.find((candidate) => candidate.id === accountId)
          ?.quota
    const until = resolveMidStreamRateLimitResetAt(
      windowsFromQuotaMap(quota),
      limit.reason,
      at,
      DEFAULT_LIMIT_MARK_MS,
      limit.retryAfterMs !== undefined ? at + limit.retryAfterMs : undefined,
    )
    if (!fromVault) {
      source.markRateLimited(accountId, until)
      return
    }
    const existing = vaultMarks.get(accountId)
    if (existing === undefined || existing < until)
      vaultMarks.set(accountId, until)
  }

  return {
    adapter,
    attach(installation) {
      installation.on('quota', (event) =>
        recordQuota(event.accountId, event.quota, event.handle),
      )
      // The installer waits for this listener before it asks the host to
      // retry, so the mark is in place when `chooseAccount` runs again.
      installation.on('limit', (event) => {
        markLimited(event.accountId, event.limit, event.handle)
        log?.debug('pool row refused the request', {
          accountId: event.accountId,
          via: event.via,
          reason: event.limit.reason,
          outputStarted: event.outputStarted,
        })
      })
    },
    forgetSession(sessionId) {
      pins.forget(sessionId)
      sessionAccounts.delete(sessionId)
      effort.forget(sessionId)
    },
  }
}
