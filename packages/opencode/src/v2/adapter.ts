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
// account; `attach` records the refusal before the next choice. After output,
// continuation needs proof of an interrupted read: an HTTP body-reader failure,
// or inspected WebSocket output without a terminal frame followed by a transport
// error (the host never writes to the socket after output). Either may continue
// with the host's delay and the same live ChatGPT account identity, after
// rechecking routing and quota admission, never after a limit or provider failure.
//
// While this host is enrolled with the Claustrum vault (vault mode), the
// OpenAI accounts the vault serves it are the only accounts routed, through
// the same admission and modes, by OpenCode 1's rules (`core/pool-request.ts`):
// no pool row is read, refreshed or sent with, and only ChatGPT logins are
// admitted, never API keys. A vault account holds no token: when routing
// picks one, the vault is asked to authorize that one send, and a refusal
// moves the request to the next vault account before anything is sent; with
// none left the request is refused locally with a fixed vault-mode message. The receipt (served token and record
// version) becomes the attempt's `data`, never a header, and a 401 on that
// attempt is reported to the vault against that record version.

import { randomUUID } from 'node:crypto'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  createRequestHistory,
  type LimitCandidate,
  type LimitWindow,
  type PolicyFacts,
  readMaxSameAccountWait,
  sameAccount,
} from '@cortexkit/common-auth/limits'
import type {
  AccountHeadersResult,
  AccountRequest,
  Attempt,
  ChooseAccountInput,
  ChooseAccountResult,
  EventVerdict,
  HostError,
  LimitSignal,
  OpenCode2AuthAdapter,
  OpenCode2AuthInstallation,
} from '@cortexkit/common-auth/opencode2'
import {
  DEFAULT_MAX_RECORDS,
  MAX_RETRY_HOLD_MS,
  OpenCode2AuthError,
} from '@cortexkit/common-auth/opencode2'
import {
  budgetExhaustedResetAt,
  isQuotaMap,
  projectQuota,
} from '@cortexkit/common-auth/quota'
import type { RoutingRow, StickyPin } from '@cortexkit/common-auth/routing'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  buildOpenAiQuotaRefusal,
  chooseVaultRouting,
  decideOpenAiLimit,
  decideOpenAiTerminal,
  extractAccountIdFromClaims,
  getKillswitchThresholdsForAccount,
  hasVaultRoutingAccessor,
  isCompleteQuotaHeaderFrame,
  isKillswitchEnabled,
  type LimitsProbe,
  normalizeQuotaHeaders,
  normalizeWsFrame,
  type OpenAiLimitsOwner,
  type OpenAiLimitsRequest,
  type OpenAiVault,
  openAiConfirmedBlockers,
  openAiHoldFacts,
  openAiRateLimitCommand,
  openAiSignalWindows,
  openAiTerminalFacts,
  parseJwtClaims,
  placeStickyPin,
  quotaSnapshotPassesPolicy,
  type RoutingMode,
  recordSessionCompletion,
  reportVaultRouting,
  reportVaultRoutingLimit,
  type SessionDispatch,
  startVaultRoutingWait,
  ttlForModel,
  VAULT_ROUTING_REFUSAL_MESSAGE,
  VaultBillingAttempt,
  type VaultBillingWarming,
  type VaultModeRefusal,
  type VaultRoutingResponse,
  vaultModeNoRouteCause,
  vaultModeRefusalText,
  vaultRoutingStreamFailed,
  vaultRoutingStreamMayFail,
} from '@cortexkit/openai-auth-core/internal'
import { getResolvedSettingsView } from '../config'
import type { OpenCodeLimitSource } from '../core/limit-source'
import type { PoolAccountSource } from '../core/pool-account-source'
import { VAULT_FIRST_ROSTER_WAIT_MS } from '../core/pool-account-source'
import { POOL_LOGIN_REQUIRED_MESSAGE } from '../core/pool-main'
import { windowsFromQuotaMap } from '../core/pool-quota'
import { routableRows } from '../core/pool-request'
import {
  type AdmissionTier,
  admitSticky,
  CreditsServing,
  FIRST_QUOTA_READING_WAIT_MS,
  FORMER_MAIN_ID,
  orderedPlacement,
  type PoolRoutingInput,
  planOrdered,
  poolKillswitchVerdicts,
  routePinnedRow,
  type StickyRouteOptions,
  selectStickyRow,
  vaultMainRouteId,
  waitForFirstQuotaReading,
} from '../core/pool-routing'
import { isNonEmittingFrame, parseRateLimitSignal } from '../ws'
import {
  CODEX_CLIENT_HEADERS,
  type CodexHttpState,
  MidConversationEffort,
  rewriteCodexFrame,
  rewriteCodexHttpRequest,
} from './codex-wire'
import { codexRequestURL } from './endpoint'
import type { PinReservation, SessionPins } from './pins'
import { SessionAccounts } from './session-accounts'

/** The provider (and integration) OpenCode 2 serves ChatGPT logins under. */
export const OPENAI_PROVIDER_ID = 'openai'

/** Retry-attempt limit used by both the installer and the policy; a hold uses one attempt. */
export const OPENAI_HOST_RETRY_LIMIT = 10

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

/**
 * The message of the local refusal raised when the chosen account has nothing
 * to send with. It is fixed text and names no account, provider or vault, so
 * the error, which the host shows and logs, carries no detail of the pool.
 */
export const NO_ACCOUNT_REFUSAL =
  'request refused: no account with a usable credential'

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
  | 'refreshBackoffFor'
  | 'requestReading'
  | 'recordSnapshot'
>

export interface OpenAIAdapterLogger {
  debug(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  info?(message: string, data?: Record<string, unknown>): void
}

/** The parts of this host's vault (`OpenAiVault`) the adapter uses. */
export type VaultAccess = Pick<
  OpenAiVault,
  | 'routes'
  | 'identities'
  | 'enrolled'
  | 'authority'
  | 'snapshot'
  | 'authorize'
  | 'reportFailure'
  | 'reportUsage'
  | 'recordSnapshot'
  | 'requestReading'
  | 'grantReach'
  | 'name'
> &
  // The roster file names the vault whose rate-limit marks this host shares.
  Partial<Pick<OpenAiVault, 'paths'>>

/**
 * What one send went out with, carried as the attempt's `data`: the pool
 * row's token and credential epoch, or the vault's receipt for that send. A
 * quota reading that arrives with the send's response is recorded only while
 * the row still holds that credential: the epoch changes when the row's
 * credential is replaced (a new login, possibly of another account), and the
 * pool drops a reading whose token is not the row's own.
 */
export type OpenAIAttemptData =
  | {
      readonly kind: 'pool'
      readonly token: string
      readonly credentialEpoch: number | undefined
      readonly identity?: string
    }
  | {
      readonly kind: 'vault'
      readonly routeId: string
      readonly receipt: ClaustrumScopedAttempt
      readonly freeQuota?: boolean
    }

export interface OpenAIAdapterDeps {
  /** Reads this account store's live keep-warm state at the end of a served call. */
  cacheWarming?: (sessionId: string) => VaultBillingWarming
  /** Supplies limit ownership and waits for account readiness; always supplied by setup. */
  limits?: OpenCodeLimitSource
  codex?: CodexHttpState
  /** Projects a primary request's actual route without affecting account choice. */
  onRoute?: (sessionId: string, accountId: string, route: string) => void
  source: PoolAccess
  /**
   * True when OpenCode's login slot holds the placeholder while this store has
   * no `main` row and no transfer of its own in progress, so another store
   * holds the login. The migration's own check, read without locks.
   */
  slotPlaceholderWithoutMain?: () => Promise<boolean>
  /** The settings a request reads (routing mode, killswitch, quota policy). */
  storage: () => Promise<AccountStorage | null>
  /** The config identity shared by this location's store and settings authority. */
  configPath?: string
  pins: SessionPins
  /**
   * Where each session's latest agent-loop account is recorded. Setup passes
   * the process-wide registry for the account store, so every location reads
   * and writes the same map; without it the adapter keeps a private one.
   */
  sessionAccounts?: SessionAccounts
  /**
   * This host's vault accounts. While it is enrolled (vault mode) they are
   * the only accounts a request may use: no pool row is read, refreshed or
   * sent with, and a request no vault account can serve is refused.
   */
  vault?: VaultAccess
  /**
   * Waits, bounded, for the vault's first account list in this process; a
   * vault-mode request waits for it before choosing. Never rejects.
   */
  awaitVaultRoster?: () => Promise<void>
  /** Whether the Responses Lite shape is on (the `responsesLite` setting). */
  responsesLite?: () => boolean
  /** The configured Codex destination, applied only after transport ownership. */
  codexEndpoint?: () => string
  now?: () => number
  log?: OpenAIAdapterLogger
}

export interface OpenAIAdapter {
  readonly adapter: OpenCode2AuthAdapter<
    CodexQuotaReading,
    OpenAIAttemptData,
    ChooseAccountResult
  >
  /** Records quota and refusals from the installer's events on the pool. */
  attach(
    installation: OpenCode2AuthInstallation<
      CodexQuotaReading,
      OpenAIAttemptData
    >,
  ): void
  /** A user prompt starts a new turn; retries and auxiliary requests do not. */
  beginTurn(sessionId: string): void
  dispose(): void
  /** Drops a session's pin and remembered account. */
  forgetSession(sessionId: string): void
  /**
   * The account of the session's latest agent-loop request, read from the
   * session-account registry without changing it.
   */
  activeAccount(sessionId: string): string | undefined
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

/**
 * The reset-credit balance a pool row's or vault account's quota map holds
 * (`counters.resetCredits.value`), kept only when it is a finite number, as
 * OpenCode 1 reads its own saved balance. An explicit 0 stays 0; a missing or
 * malformed count is undefined.
 */
export function resetCreditsOfQuota(quota: unknown): number | undefined {
  const counters = isRecord(quota) ? quota.counters : undefined
  const resetCredits = isRecord(counters) ? counters.resetCredits : undefined
  const credits = isRecord(resetCredits) ? resetCredits.value : undefined
  return typeof credits === 'number' && Number.isFinite(credits)
    ? credits
    : undefined
}

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

/** Carry core's window facts so the next retry decision need not classify the error again. */
export interface OpenAILimitSignal extends LimitSignal {
  readonly windows: LimitWindow[]
  readonly observedAt: number
  readonly resetAt?: number
  readonly resetSource?: 'provider' | 'retry-after'
}

export interface CodexEventVerdict extends EventVerdict<CodexQuotaReading> {
  readonly limit?: OpenAILimitSignal
}

function toLimit(
  signal: { window: string; resetAt?: number },
  now: number,
  status?: number,
  reading?: ReturnType<typeof windowsFromQuotaMap>,
): OpenAILimitSignal {
  return {
    reason: signal.window,
    windows: openAiSignalWindows(signal, now, reading, now),
    observedAt: now,
    ...(signal.resetAt !== undefined
      ? { resetAt: signal.resetAt, resetSource: 'provider' as const }
      : {}),
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
  reading?: ReturnType<typeof windowsFromQuotaMap>,
): OpenAILimitSignal | undefined {
  // A failed envelope's own type is not the provider error code, even when
  // the envelope also carries HTTP status 429.
  if (event.type !== 'response.failed') {
    const signal = parseRateLimitSignal(event, now)
    const status = typeof event.status === 'number' ? event.status : undefined
    return signal ? toLimit(signal, now, status, reading) : undefined
  }
  if (!isRecord(event.response)) return undefined
  const failed = event.response.failed
  if (isRecord(failed) && typeof failed.rate_limit_reached_type === 'string')
    return toLimit(
      { window: failed.rate_limit_reached_type },
      now,
      undefined,
      reading,
    )
  const error = event.response.error
  if (isRecord(error)) {
    const code =
      typeof error.code === 'string'
        ? error.code
        : typeof error.type === 'string'
          ? error.type
          : undefined
    if (code && ACCOUNT_LIMIT_CODES.has(code)) {
      const status = typeof event.status === 'number' ? event.status : undefined
      const parsed = parseRateLimitSignal(
        { error: { ...error, type: code }, status },
        now,
      )
      return toLimit(parsed ?? { window: code }, now, status, reading)
    }
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
  reading?: ReturnType<typeof windowsFromQuotaMap>,
): CodexEventVerdict | undefined {
  return inspectParsedCodexEvent(parseJson(data), now, reading)
}

function inspectParsedCodexEvent(
  event: unknown,
  now: number,
  reading?: ReturnType<typeof windowsFromQuotaMap>,
): CodexEventVerdict | undefined {
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
  const limit = limitOfEvent(event, now, reading)
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
  const seconds = value.trim() ? Number(value) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export function createOpenAIAdapter(deps: OpenAIAdapterDeps): OpenAIAdapter {
  const routingResponses = new WeakMap<
    Attempt<OpenAIAttemptData>,
    VaultRoutingResponse
  >()
  const routingFailures = new WeakSet<Attempt<OpenAIAttemptData>>()
  let routingLimitBodies:
    | WeakMap<Attempt<OpenAIAttemptData>, unknown>
    | undefined
  let routingLimitsHandled: WeakSet<Attempt<OpenAIAttemptData>> | undefined
  const billing = new WeakMap<Attempt<OpenAIAttemptData>, VaultBillingAttempt>()
  const billingCounts = new Map<string, number>()
  const observeBillingModel = (
    attempt: Attempt<OpenAIAttemptData> | undefined,
  ) => {
    if (
      attempt?.data?.kind !== 'vault' ||
      !attempt.data.receipt.credentialId ||
      !hasVaultRoutingAccessor()
    )
      return undefined
    const receipt = attempt.data.receipt
    return (model: string) => {
      const key = `${attempt.sessionID}\u0000${attempt.kind}`
      const count = (billingCounts.get(key) ?? 0) + 1
      billingCounts.set(key, count)
      if (billingCounts.size > DEFAULT_MAX_RECORDS) {
        const oldest = billingCounts.keys().next().value
        if (oldest !== undefined) billingCounts.delete(oldest)
      }
      billing.set(
        attempt,
        new VaultBillingAttempt(
          attempt.sessionID,
          receipt,
          attempt.kind,
          model,
          count,
          deps.cacheWarming,
          attempt.data?.kind === 'vault' && attempt.data.freeQuota,
        ),
      )
    }
  }
  const { source, pins } = deps
  const now = deps.now ?? Date.now
  const log = deps.log
  const vault = deps.vault
  const limits = deps.limits
  const producerId = randomUUID()
  const feedback = new WeakMap<
    OpenAIAttemptData,
    {
      owner: OpenAiLimitsOwner | undefined
      probe: LimitsProbe | undefined
      dispatch: SessionDispatch | undefined
      failed: boolean
      completed: boolean
    }
  >()
  const currentDispatch = new Map<string, SessionDispatch>()
  const quotaFor = (accountId: string, fromVault: boolean) =>
    windowsFromQuotaMap(
      fromVault
        ? vault?.routes().find((route) => route.id === accountId)?.quota
        : source.peek().rows.find((row) => row.id === accountId)?.quota,
    )
  const effort = new MidConversationEffort(deps.codex)
  // The installer passes a hold's reset checkpoint only to the next request,
  // not to a later refusal. Keep the consumed wait until a new user prompt.
  const heldTurns = new Map<string, string>()
  const waitCounts = new Map<string, number>()
  const pendingWaits = new Map<
    string,
    {
      checkpoint?: string
      nextMs: number
      end: NonNullable<ReturnType<typeof startVaultRoutingWait>>
    }
  >()
  const startWait = (
    input: ChooseAccountInput,
    reason: 'account_limit' | 'account_free' | 'quota_reading',
    at: number,
    delayMs: number,
  ) => {
    if (!hasVaultRoutingAccessor()) return undefined
    const attempt = (waitCounts.get(input.sessionID) ?? 0) + 1
    const end = startVaultRoutingWait({
      sessionId: input.sessionID,
      reason,
      now: at,
      nextMs: at + delayMs,
      attempt,
    })
    if (end) waitCounts.set(input.sessionID, attempt)
    return end
  }
  const clearTurn = (sessionId: string) => {
    waitCounts.delete(sessionId)
    for (const key of pendingWaits.keys())
      if (JSON.parse(key)[0] === sessionId) pendingWaits.delete(key)
    for (const key of billingCounts.keys())
      if (key.startsWith(`${sessionId}\u0000`)) billingCounts.delete(key)
    for (const [key, session] of heldTurns)
      if (session === sessionId) heldTurns.delete(key)
  }
  // Vault receipts authorized while choosing an account, kept until the
  // installer's `accountHeaders` call for the same session, request kind and
  // account consumes them. A kept retry choice may wait until a later attempt.
  const receipts = new Map<
    string,
    { receipt: ClaustrumScopedAttempt; freeQuota: boolean }
  >()
  // A read failure may be continued only as the identity that received its
  // output. Keep the send's identity, never its old admission decision.
  const interrupted = new Map<
    string,
    Pick<Attempt, 'accountId' | 'modelID' | 'agent' | 'sessionID'> & {
      data:
        | { kind: 'pool'; identity: string | undefined }
        | {
            kind: 'vault'
            credentialId: string
            accountIdentity: string | undefined
            wireIdentity: string | undefined
          }
    }
  >()
  const requestKey = (scope: AccountRequest) =>
    `${scope.sessionID}\u0000${scope.kind}`
  // Retry choices reserve live pending bytes, but publish their pin and active
  // account only when accountHeaders consumes them. A discard releases the lease.
  const keptChoices = new Map<string, { commit(): void; drop(): void }>()
  const requestHandoffs = new Map<
    string,
    {
      request: OpenAiLimitsRequest
      sessionID: string
      expiresAt: number
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const dropRequestHandoff = (key: string) => {
    const entry = requestHandoffs.get(key)
    if (entry) clearTimeout(entry.timer)
    requestHandoffs.delete(key)
  }
  const keepRequestHandoff = (
    input: ChooseAccountInput,
    accountId: string,
    request: OpenAiLimitsRequest,
  ) => {
    const key = receiptKey({ ...input, accountId })
    dropRequestHandoff(key)
    // Selection and credential preparation share one five-second deadline
    // for reloading account bindings. Release requests from unused choices.
    const entry = {
      request,
      sessionID: input.sessionID,
      expiresAt: performance.now() + 5000,
      timer: setTimeout(() => {
        if (requestHandoffs.get(key) === entry) dropRequestHandoff(key)
      }, 5000),
    }
    entry.timer.unref()
    requestHandoffs.set(key, entry)
    if (requestHandoffs.size > DEFAULT_MAX_RECORDS) {
      const oldest = requestHandoffs.keys().next().value
      if (oldest !== undefined) dropRequestHandoff(oldest)
    }
  }
  const takeRequestHandoff = (key: string) => {
    const entry = requestHandoffs.get(key)
    dropRequestHandoff(key)
    return entry && performance.now() < entry.expiresAt
      ? entry.request
      : undefined
  }
  const receiptKey = (scope: AccountRequest) =>
    `${scope.sessionID}\u0000${scope.kind}\u0000${scope.accountId}`
  // The row each session's latest agent-loop request went to, which its
  // title, compaction and generate requests follow in the ordered modes.
  const sessionAccounts = deps.sessionAccounts ?? new SessionAccounts()
  // Which accounts this host serves on prepaid credits, so the info line is
  // written once when an account starts serving on them.
  const creditsServing = new CreditsServing()

  /**
   * The accounts one request may be sent with now: the routable pool rows,
   * then the vault's ChatGPT logins. In vault mode the vault's logins alone;
   * the pool rows are not read.
   */
  const currentTargets = (
    storage: AccountStorage | null,
    at: number,
    vaultMode: boolean,
  ): Target[] => {
    const rows = vaultMode
      ? []
      : routableRows(
          source.peek().rows,
          storage,
          at,
          vault?.identities() ?? new Set<string>(),
          deps.configPath,
        )
    const routes = (vault?.routes() ?? []).filter(
      (route) =>
        route.kind === 'oauth' &&
        quotaSnapshotPassesPolicy(
          windowsFromQuotaMap(route.quota),
          storage,
          at,
        ),
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
    const killswitch = poolKillswitchVerdicts(targets, storage, at)
    const routingRows: RoutingRow[] = targets.map((target) => ({
      id: target.id,
      kind: 'oauth',
      ...(isQuotaMap(target.quota) ? { quota: target.quota } : {}),
    }))
    const rows = targets.flatMap((target) => (target.row ? [target.row] : []))
    const vaultIds = new Set(
      targets.filter((target) => !target.row).map((target) => target.id),
    )
    const rateLimitMarks = limits?.marks() ?? new Map<string, number>()
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
    mainId: string | null | undefined,
    admissionTiers?: Map<string, AdmissionTier>,
  ): string | undefined => {
    const plan = planOrdered({
      ...routing,
      rows: routing.rows.filter((row) => !excluded.has(row.id)),
      placement: orderedPlacement(mode),
      mainId,
    })
    if (plan.kind === 'block') {
      log?.debug('pool admission refused the request', {
        reason: plan.block.reason,
      })
      return undefined
    }
    const order = plan.order.filter((id) => !excluded.has(id))
    if (admissionTiers)
      for (const id of order) {
        const tier = plan.tiers[id]
        if (tier) admissionTiers.set(id, tier)
      }
    if (follow !== undefined && order.includes(follow)) return follow
    return order[0]
  }

  const stickyOptions = (
    targets: readonly Target[],
    storage: AccountStorage | null,
  ): StickyRouteOptions => {
    const quotaById = new Map(
      targets.map((target) => [target.id, target.quota]),
    )
    return {
      requestBytes: NOMINAL_REQUEST_BYTES,
      reservePercent: (id) =>
        getKillswitchThresholdsForAccount(
          storage,
          id === FORMER_MAIN_ID ? undefined : id,
        ),
      // Reset credits only rank placement when no account has fresh free quota
      // to weigh. Reading the saved balance never asks for a credential.
      resetCredits: (id) => resetCreditsOfQuota(quotaById.get(id)),
    }
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
    plannedPins: Map<string, StickyPin>,
    preferred?: string,
    admissionTiers?: Map<string, AdmissionTier>,
  ): string | undefined => {
    const options = stickyOptions(targets, storage)
    const sticky = admitSticky(routing)
    const place = (exclude: readonly string[], keep: boolean) =>
      placeStickyPin(
        plannedPins,
        {
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
          select: (pendingBytes) => {
            const selection = preferred
              ? {
                  accountId: preferred,
                  source: 'mode-fallback' as const,
                  quotaCheckedAt: sticky.projections.get(preferred)?.checkedAt,
                }
              : selectStickyRow(
                  routing,
                  options,
                  new Set(exclude),
                  pendingBytes,
                )
            if (selection && 'tier' in selection)
              admissionTiers?.set(selection.accountId, selection.tier)
            return selection
          },
          persist: keep,
        },
        (sessionId, pin) => plannedPins.set(sessionId, pin),
      )
    const base = [...excluded]
    const assignment = place(base, persist)
    if (!assignment) return undefined
    const id = assignment.accountId
    const pinned = routePinnedRow(routing, options, id)
    if (pinned.kind === 'serve') admissionTiers?.set(id, pinned.tier)
    else admissionTiers?.delete(id)
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
  ): Promise<ChooseAccountResult> => {
    let ready: OpenAiLimitsRequest | undefined
    const modeAuthority = await vault?.authority()
    const storage = getResolvedSettingsView(
      await deps.storage(),
      deps.configPath,
    )
    // Vault mode: only the vault's accounts serve this host.
    const vaultMode = modeAuthority !== undefined && modeAuthority !== 'local'
    const refuseMissingLogin = () => {
      throw new OpenCode2AuthError({
        kind: 'no-account',
        providerID: OPENAI_PROVIDER_ID,
        sessionID: input.sessionID,
        requestKind: input.kind,
        message: POOL_LOGIN_REQUIRED_MESSAGE,
      })
    }
    if (vaultMode) {
      const deadline = performance.now() + VAULT_FIRST_ROSTER_WAIT_MS
      await deps.awaitVaultRoster?.()
      ready = await limits?.forRequest(deadline)
    } else {
      // Wait for the initial account-source read before checking its current
      // view, which may otherwise appear empty. Registry acquisition also waits.
      ready = await limits?.forRequest()
      const view = await source.current()
      if (!view.active) {
        if (await deps.slotPlaceholderWithoutMain?.()) refuseMissingLogin()
        log?.warn(
          'the account pool does not serve requests yet; refusing the request',
          { kind: input.kind },
        )
        return undefined
      }
      await source.prepareTokens(source.peek().rows, storage)
    }
    let at = now()
    let targets = currentTargets(storage, at, vaultMode)
    const firstReading = waitForFirstQuotaReading(
      routingInput(
        targets.filter((target) => target.id !== input.rerouteFrom?.accountId),
        storage,
        at,
      ),
    )
    if (firstReading) {
      const end = startWait(
        input,
        'quota_reading',
        at,
        FIRST_QUOTA_READING_WAIT_MS,
      )
      await firstReading
      at = now()
      targets = currentTargets(storage, at, vaultMode)
      if (end)
        end(
          planOrdered({
            ...routingInput(targets, storage, at),
            // Reporting admission must not trigger another quota poll.
            requestPull: () => {},
            placement: 'roster',
            mainId: null,
          }).kind === 'block'
            ? 'abandoned'
            : 'resumed',
        )
    }
    const byId = new Map(targets.map((target) => [target.id, target]))
    let routing = routingInput(targets, storage, at)
    const admissionTiers = hasVaultRoutingAccessor()
      ? new Map<string, AdmissionTier>()
      : undefined
    const setting = storage?.routing?.maxSameAccountWait
    const turnKey = JSON.stringify([input.sessionID, input.kind])
    const pendingWait = pendingWaits.get(turnKey)
    if (
      input.phase === 'request' &&
      pendingWait &&
      (pendingWait.checkpoint
        ? JSON.stringify(input.wake?.checkpoint) === pendingWait.checkpoint
        : at >= pendingWait.nextMs)
    ) {
      pendingWait.end('resumed')
      pendingWaits.delete(turnKey)
    }
    // Auxiliary requests belong to the same user turn and share its wait budget.
    const alreadyHeld = [...heldTurns.values()].includes(input.sessionID)
    const activity = limits?.activity.get(input.sessionID)
    const activityKey =
      activity && limits?.accountKey(activity.accountKey.accountId)
    const previousId = input.previousAccountId ?? input.rerouteFrom?.accountId
    const previousKey = previousId && limits?.accountKey(previousId)
    const signal = input.rerouteFrom?.limit as OpenAILimitSignal | undefined
    const candidates: LimitCandidate[] = targets.flatMap((target) => {
      const account = limits?.accountKey(target.id)
      if (!account) return []
      const reading = windowsFromQuotaMap(target.quota)
      const confirmedBlockers = openAiConfirmedBlockers(
        signal && target.id === previousId
          ? {
              account,
              kind: 'rate-limit',
              reason: signal.reason,
              scope: { kind: 'pool' },
              windows: signal.windows ?? [],
              observedAt: signal.observedAt ?? at,
            }
          : undefined,
        reading,
        at,
      )
      const hard = routing.rateLimitMarks.get(target.id)
      const backoff = routing.refreshBackoff.get(target.id)
      const blockers = [
        ...(hard && hard > at
          ? [
              {
                kind: 'hard' as const,
                until: hard,
                cause: 'rate-limit' as const,
              },
            ]
          : []),
        ...(backoff && backoff > at
          ? [{ kind: 'cooldown' as const, until: backoff }]
          : []),
      ]
      const admitted =
        routing.killswitch.get(target.id) !== false &&
        !!(reading?.primary || reading?.secondary) &&
        !budgetExhaustedResetAt(
          projectQuota(isQuotaMap(target.quota) ? target.quota : undefined),
          at,
        ) &&
        !(backoff && backoff > at) &&
        (!target.row || !!source.usableToken(target.row))
      return [
        {
          account,
          admitted,
          placementEligible: admitted,
          ready: admitted && !blockers.length && !confirmedBlockers.length,
          blockers,
          confirmedBlockers,
        },
      ]
    })
    const facts: PolicyFacts = {
      phase: input.phase === 'retry' ? 'after-limit' : 'pre-send',
      host: 'opencode2',
      hostPhase: input.phase,
      now: at,
      clockNow: at,
      sessionId: input.sessionID,
      requestScope: { kind: 'pool' },
      history: createRequestHistory({
        requestId: input.sessionID,
        originalUrl: 'https://api.openai.com/v1/responses',
        clockNow: at,
      }),
      delivery: { owned: true, attributable: true, replayable: true },
      candidates,
      ...(input.phase === 'retry' && previousKey
        ? { attempted: previousKey }
        : {}),
      ...(input.phase === 'retry' && previousKey && signal
        ? {
            signal: {
              account: previousKey,
              kind: 'rate-limit' as const,
              reason: signal.reason,
              scope: { kind: 'pool' as const },
              windows: signal.windows ?? [],
              observedAt: signal.observedAt ?? at,
            },
            status: signal.status,
          }
        : {}),
      remainingRetries:
        OPENAI_HOST_RETRY_LIMIT -
        (input.hostAttempt ?? OPENAI_HOST_RETRY_LIMIT),
    }
    const terminalFacts = () => {
      const owner = limits?.owner()
      return openAiTerminalFacts({
        accounts: candidates.flatMap((candidate) => {
          const target = byId.get(candidate.account.accountId)
          if (!target) return []
          return [
            {
              account: candidate.account,
              reading: windowsFromQuotaMap(target.quota),
              usable: !target.row || !!source.usableToken(target.row),
              confirmedBlockers: candidate.confirmedBlockers,
              floors: isKillswitchEnabled(storage)
                ? getKillswitchThresholdsForAccount(
                    storage,
                    target.id === FORMER_MAIN_ID ? undefined : target.id,
                  )
                : undefined,
              marks: owner
                ?.snapshot()
                ?.marks.filter(
                  (mark) =>
                    mark.key.window === 'account' &&
                    mark.key.scope.kind === 'pool' &&
                    sameAccount(mark.key.account, candidate.account),
                )
                .flatMap((mark) =>
                  mark.entries.map((entry) => ({
                    until: entry.until,
                    evidenceAt: entry.evidenceAt,
                  })),
                ),
            },
          ]
        }),
        now: at,
        effectiveModel: input.modelID,
        maxSameAccountWait: setting,
        activity,
        currentAccountKey: activityKey,
        provenance: owner?.provenance,
      })
    }
    const previous = candidates.find(
      (candidate) => previousKey && sameAccount(candidate.account, previousKey),
    )
    if (input.phase === 'retry' && signal && previous) {
      const hold = openAiHoldFacts({
        candidate: previous,
        activity,
        maxSameAccountWait: setting,
        now: at,
        maxDelayMs: MAX_RETRY_HOLD_MS,
      })
      const ordinary = decideOpenAiLimit({ ...facts, hold }, { mode: 'sticky' })
      if (ordinary?.action === 'hold' && !alreadyHeld) {
        heldTurns.set(turnKey, input.sessionID)
        const end = startWait(input, 'account_limit', at, ordinary.delayMs)
        if (end)
          pendingWaits.set(turnKey, {
            checkpoint: JSON.stringify(ordinary.checkpoint),
            nextMs: at + ordinary.delayMs,
            end,
          })
        return {
          hold: {
            delayMs: ordinary.delayMs,
            target: ordinary.target,
            checkpoint: ordinary.checkpoint,
            kind: 'hold',
          },
        }
      }
      // This check must precede the chooser's temporary all-marked escape.
      // A single account always keeps the host's original delayed retry.
      const others = targets.filter((target) => target.id !== previousId)
      const terminal =
        previous.confirmedBlockers?.some((window) => window.confirmed) &&
        others.length > 0 &&
        others.every((target) => {
          const candidate = candidates.find(
            (value) => value.account.accountId === target.id,
          )
          return (
            candidate &&
            (!candidate.admitted ||
              (routing.rateLimitMarks.get(target.id) ?? 0) > at)
          )
        })
      if (terminal) {
        if (alreadyHeld) return { hostRetry: 'veto' }
        const decision = decideOpenAiTerminal(facts, terminalFacts())
        if (readMaxSameAccountWait(setting) === 0) return { hostRetry: 'veto' }
        const delayMs =
          'delayMs' in decision
            ? decision.delayMs
            : 'retryAfterMs' in decision
              ? decision.retryAfterMs
              : undefined
        if (
          (facts.remainingRetries ?? 0) < 1 ||
          delayMs === undefined ||
          delayMs > MAX_RETRY_HOLD_MS
        )
          return { hostRetry: 'leave' }
        if (
          decision.action === 'hold' &&
          sameAccount(decision.account, previous.account)
        ) {
          heldTurns.set(turnKey, input.sessionID)
          const end = startWait(input, 'account_limit', at, delayMs)
          if (end)
            pendingWaits.set(turnKey, {
              checkpoint: JSON.stringify(decision.checkpoint),
              nextMs: at + delayMs,
              end,
            })
          return {
            hold: {
              delayMs,
              target: decision.target,
              checkpoint: decision.checkpoint,
              kind: 'terminal',
            },
          }
        }
        heldTurns.set(turnKey, input.sessionID)
        const end = startWait(input, 'account_free', at, delayMs)
        if (end) pendingWaits.set(turnKey, { nextMs: at + delayMs, end })
        return { waitThenReselect: { delayMs } }
      }
    }
    let wakeAccount: string | undefined
    if (
      input.phase === 'request' &&
      input.wake?.checkpoint &&
      previous &&
      (input.hostAttempt ?? OPENAI_HOST_RETRY_LIMIT) <
        OPENAI_HOST_RETRY_LIMIT &&
      readMaxSameAccountWait(setting) !== 0 &&
      sameAccount(previous.account, input.wake.checkpoint.accountKey)
    ) {
      const checkpoint = input.wake.checkpoint
      const windows = new Map<string, LimitWindow>(
        checkpoint.blockers.map((blocker) => [
          blocker.window,
          {
            ...blocker,
            confirmed: true,
            confirmedByReading: false,
            observedAt: checkpoint.decidedAt,
            provenance: 'provider' as const,
          },
        ]),
      )
      for (const blocker of previous.confirmedBlockers ?? [])
        windows.set(blocker.window, blocker)
      const held = { ...previous, confirmedBlockers: [...windows.values()] }
      const hold = openAiHoldFacts({
        candidate: held,
        activity,
        maxSameAccountWait: setting,
        now: at,
        maxDelayMs: MAX_RETRY_HOLD_MS,
      })
      const decision = decideOpenAiLimit(
        {
          ...facts,
          attempted: previous.account,
          candidates: candidates.map((candidate) =>
            candidate === previous ? held : candidate,
          ),
          hold,
          wake: { ...input.wake, checkpoint },
        },
        { mode: 'sticky' },
      )
      if (decision?.action === 'retain')
        wakeAccount = previous.account.accountId
    }
    const excluded = new Set<string>(
      input.rerouteFrom ? [input.rerouteFrom.accountId] : [],
    )
    const mode: RoutingMode = storage?.routing?.mode ?? 'main-first'
    const primary = input.kind === 'primary'
    // Accounts that have nothing to send this request with: a pool row
    // without a usable token (its refresh failed, or it was signed out), or a
    // vault account the vault refused to authorize. Nothing was sent with
    // them, so the choice runs again without them, as the OpenCode 1 request
    // path moves on to the next account.
    const refused = new Set<string>()
    let plannedPin: StickyPin | undefined
    let reservation: PinReservation | undefined
    let accountId: string | undefined
    let routingConsulted = false
    const reserveAccount = (id: string) => {
      const checkedAt = admitSticky(routing).projections.get(id)?.checkedAt
      const identity = byId.get(id)?.identity
      return pins.reserve(input.sessionID, {
        accountId: id,
        inputBytes: NOMINAL_REQUEST_BYTES,
        ...(checkedAt !== undefined ? { quotaCheckedAt: checkedAt } : {}),
        ...(identity !== undefined ? { wireIdentity: identity } : {}),
      })
    }
    try {
      for (;;) {
        const skip = new Set([...excluded, ...refused])
        accountId = undefined
        admissionTiers?.clear()
        plannedPin = undefined
        let cold = mode !== 'sticky-balanced'
        if (wakeAccount && !skip.has(wakeAccount)) {
          accountId = wakeAccount
          wakeAccount = undefined
        } else if (mode === 'sticky-balanced') {
          const plannedPins = new Map(pins.placementSnapshot(input.sessionID))
          const previous = plannedPins.get(input.sessionID)
          cold = previous === undefined
          accountId = chooseSticky(
            routing,
            targets,
            storage,
            input.sessionID,
            skip,
            // A missing token or a vault refusal may be temporary (a refresh
            // that succeeds later, the vault unreachable for a moment), so
            // choosing again after one does not move the session's sticky pin.
            primary && refused.size === 0,
            plannedPins,
            undefined,
            admissionTiers,
          )
          if (
            accountId !== undefined &&
            plannedPins.get(input.sessionID) !== previous
          )
            plannedPin = plannedPins.get(input.sessionID)
        }
        accountId ??= chooseOrdered(
          routing,
          mode,
          skip,
          primary ? undefined : sessionAccounts.activeAccount(input.sessionID),
          vaultMode
            ? mode === 'sticky-balanced'
              ? null
              : vaultMainRouteId(vault?.routes() ?? [])
            : undefined,
          admissionTiers,
        )
        if (accountId === undefined || refused.has(accountId)) {
          // With no alternative, keep the refused account for the host's own
          // delayed retry. common-auth's OpenCode 2 installer consumes this choice
          // without asking the adapter to choose twice.
          if (excluded.size > 0) {
            // Ignore the refusal only for this last-account decision. The live
            // rate-limit mark stays in place, and the host still owns the wait.
            const rateLimitMarks = new Map(routing.rateLimitMarks)
            for (const id of excluded) rateLimitMarks.delete(id)
            routing = { ...routing, rateLimitMarks }
            excluded.clear()
            continue
          }
          // Rate-limit marks only steer requests to other accounts; they never
          // leave a request with no account to try. OpenCode 1 answers such a
          // request locally with a 429 whose Retry-After is the mark's end, but
          // OpenCode 2 gives a fresh request no way to carry a delay: an empty
          // choice ends the turn with a no-account error the host never
          // retries. So when every remaining account is marked, choose again
          // without the marks and let the provider answer; a 429 from it goes
          // through the host's retry, which can wait. The marks stay in place for
          // the requests after this one. An account below its killswitch floor
          // (the minimum remaining quota the user set), or one the vault
          // refused, is still never used: those are decisions, not hints.
          if (routing.rateLimitMarks.size > 0) {
            routing = { ...routing, rateLimitMarks: new Map() }
            continue
          }
          accountId = undefined
          break
        }
        if (primary && mode === 'sticky-balanced') {
          // Reserve this request's bytes before optional routing or authorization
          // yields, so other sessions include it when balancing account choices.
          reservation = reserveAccount(accountId)
        }
        if (!routingConsulted) {
          routingConsulted = true
          const preferred = input.wake
            ? undefined
            : await chooseVaultRouting({
                vaultMode,
                fresh: cold,
                sessionId: input.sessionID,
                request: {
                  modelId: input.modelID,
                  kind: input.kind,
                  retry:
                    input.phase === 'retry' || input.rerouteFrom !== undefined,
                },
                routes: vault?.routes() ?? [],
                warmAccountId:
                  mode === 'sticky-balanced'
                    ? pins.get(input.sessionID)
                    : sessionAccounts.activeAccount(input.sessionID),
                routing,
                wait: {
                  activity,
                  accountKey: activityKey,
                  maxSameAccountWait: setting,
                },
                eligibleIds: targets
                  .filter((target) => !skip.has(target.id))
                  .map((target) => target.id),
              })
          if (preferred && typeof preferred !== 'string')
            throw new OpenCode2AuthError({
              kind: 'no-account',
              providerID: OPENAI_PROVIDER_ID,
              sessionID: input.sessionID,
              requestKind: input.kind,
              message: VAULT_ROUTING_REFUSAL_MESSAGE,
            })
          if (preferred && preferred !== accountId) {
            if (reservation) pins.rollback(reservation)
            reservation = undefined
            if (mode === 'sticky-balanced') {
              const stickyPins = new Map(
                pins.placementSnapshot(input.sessionID),
              )
              accountId =
                chooseSticky(
                  routing,
                  targets,
                  storage,
                  input.sessionID,
                  skip,
                  primary,
                  stickyPins,
                  preferred,
                  admissionTiers,
                ) ?? accountId
              plannedPin = stickyPins.get(input.sessionID) ?? plannedPin
            } else accountId = preferred
            if (primary && mode === 'sticky-balanced')
              reservation = reserveAccount(accountId)
          }
        }
        const row = byId.get(accountId)?.row
        if (row) {
          if (source.usableToken(row) !== undefined) break
          log?.debug('pool row holds no usable token; choosing again', {
            accountId,
          })
        } else {
          if (!vault) break
          const receipt = await vault.authorize(accountId)
          if (receipt) {
            receipts.set(receiptKey({ ...input, accountId }), {
              receipt,
              freeQuota: admissionTiers?.get(accountId) === 'free',
            })
            break
          }
          log?.debug('the vault refused to serve an account; choosing again', {
            accountId,
          })
        }
        if (reservation) pins.rollback(reservation)
        reservation = undefined
        refused.add(accountId)
      }
      // No row could serve and the login lives in another store. Without this,
      // the installer turns an empty choice into its generic no-account error;
      // give the same sign-in instructions OpenCode 1 gives instead. Only after
      // routing found no row, so a setup with other accounts still uses them.
      if (
        accountId === undefined &&
        !vaultMode &&
        targets.length === 0 &&
        (await deps.slotPlaceholderWithoutMain?.())
      )
        refuseMissingLogin()
      // Vault mode never falls back to a local account. When no vault account
      // could be tried, or the vault refused every one it was asked for, the
      // request is refused here with a fixed text naming the cause and the
      // remedy. An admission refusal (quota) keeps the installer's own.
      if (
        accountId === undefined &&
        vaultMode &&
        vault &&
        (targets.length === 0 || refused.size > 0)
      ) {
        const cause: VaultModeRefusal =
          refused.size > 0 ? 'vault-refused' : vaultModeNoRouteCause(vault)
        log?.warn(
          'vault mode: no vault account can serve; refusing the request',
          {
            cause,
          },
        )
        throw new OpenCode2AuthError({
          kind: 'no-account',
          providerID: OPENAI_PROVIDER_ID,
          sessionID: input.sessionID,
          requestKind: input.kind,
          message: vaultModeRefusalText(cause, vault.name),
        })
      }
      if (accountId !== undefined) {
        if (ready) keepRequestHandoff(input, accountId, ready)
        const chosenId = accountId
        const heldReservation = reservation
        const nextPin = plannedPin
        const commit = () => {
          if (heldReservation) pins.finish(heldReservation, nextPin)
          if (primary) {
            sessionAccounts.record(input.sessionID, chosenId)
            deps.onRoute?.(input.sessionID, chosenId, mode)
          }
        }
        if (input.phase === 'retry') {
          keptChoices.set(receiptKey({ ...input, accountId }), {
            commit,
            drop: () => {
              if (heldReservation) pins.rollback(heldReservation)
            },
          })
          reservation = undefined
        } else commit()
        const info = log?.info
        creditsServing.served(
          routing,
          accountId,
          log && info
            ? { info: (message, data) => info.call(log, message, data) }
            : undefined,
        )
      }
      if (
        accountId === undefined &&
        input.phase === 'request' &&
        candidates.length > 0 &&
        candidates.every((candidate) => !candidate.admitted) &&
        candidates.some(
          (candidate) =>
            routing.killswitch.get(candidate.account.accountId) === false ||
            candidate.confirmedBlockers?.length,
        )
      ) {
        const decision = decideOpenAiTerminal(facts, terminalFacts())
        const wire = buildOpenAiQuotaRefusal({
          decision,
          now: at,
          host: 'opencode2',
          requestThrow: true,
          maxSameAccountWait: setting,
        })
        if (wire.kind === 'http') {
          const body = JSON.parse(wire.body) as { error: { message: string } }
          throw new OpenCode2AuthError({
            kind: 'no-account',
            providerID: OPENAI_PROVIDER_ID,
            sessionID: input.sessionID,
            requestKind: input.kind,
            message: body.error.message,
          })
        }
      }
      log?.debug('pool account chosen', {
        kind: input.kind,
        accountId,
        mode,
        ...(input.rerouteFrom
          ? { rerouteFrom: input.rerouteFrom.accountId }
          : {}),
      })
      return accountId
    } finally {
      if (reservation) pins.rollback(reservation)
    }
  }

  const accountHeaders = async (
    request: AccountRequest,
  ): Promise<AccountHeadersResult<OpenAIAttemptData>> => {
    const { accountId } = request
    interrupted.delete(requestKey(request))
    const choiceKey = receiptKey(request)
    const keptChoice = keptChoices.get(choiceKey)
    keptChoices.delete(choiceKey)
    const commitChoice = () => {
      keptChoice?.commit()
    }
    try {
      // An account chosen a moment ago may have nothing to send with by now
      // (its token cleared or expired since, or the vault refusing this send).
      // The request is then refused here with the installer's own no-account
      // refusal, the one it raises when no account is chosen at all, so the
      // host stops before sending. It is never sent without a credential, nor
      // with the host's placeholder.
      const refuse = () =>
        new OpenCode2AuthError({
          kind: 'no-account',
          providerID: OPENAI_PROVIDER_ID,
          sessionID: request.sessionID,
          requestKind: request.kind,
          message: NO_ACCOUNT_REFUSAL,
        })
      const prepareFeedback = async (data: OpenAIAttemptData) => {
        if (!limits) return
        const ready =
          takeRequestHandoff(choiceKey) ?? (await limits.forRequest())
        if (data.kind === 'pool') {
          const currentRow = source
            .peek()
            .rows.find((candidate) => candidate.id === accountId)
          if (
            !currentRow ||
            currentRow.credentialEpoch !== data.credentialEpoch ||
            source.usableToken(currentRow) !== data.token
          )
            throw refuse()
        }
        const binding = limits
          .bindings()
          .find((candidate) => candidate.account.accountId === accountId)
        const dispatch = await ready?.beforeDispatch(
          binding,
          () => limits.ownershipBindings(),
          accountId,
        )
        const current = limits.accountKey(accountId)
        if (
          (dispatch && dispatch.status !== 'ready') ||
          (binding && (!current || !sameAccount(binding.account, current)))
        )
          throw refuse()
        const owner = limits.owner()
        const sample = binding
          ? {
              sessionId: request.sessionID,
              accountKey: binding.account,
              dispatchedAt: now(),
              ttlMs: ttlForModel(JSON.stringify({ model: request.modelID })),
            }
          : undefined
        if (sample) {
          currentDispatch.delete(sample.sessionId)
          currentDispatch.set(sample.sessionId, sample)
          if (currentDispatch.size > DEFAULT_MAX_RECORDS) {
            const oldest = currentDispatch.keys().next().value
            if (oldest !== undefined) currentDispatch.delete(oldest)
          }
        }
        feedback.set(data, {
          owner,
          probe: owner?.observe(binding),
          dispatch: sample,
          failed: false,
          completed: false,
        })
      }
      // In vault mode no pool row is sent with, so only the vault is asked.
      const row =
        vault && (await vault.authority()) !== 'local'
          ? undefined
          : source.peek().rows.find((candidate) => candidate.id === accountId)
      if (!row && vault) {
        const key = receiptKey(request)
        const choice = receipts.get(key)
        const receipt = choice?.receipt ?? (await vault.authorize(accountId))
        receipts.delete(key)
        if (!receipt) {
          log?.warn(
            'the vault refused to serve an account; refusing the request',
            {
              accountId,
            },
          )
          throw refuse()
        }
        const data: OpenAIAttemptData = {
          kind: 'vault',
          routeId: accountId,
          receipt,
          ...(choice?.freeQuota ? { freeQuota: true } : {}),
        }
        await prepareFeedback(data)
        commitChoice()
        return {
          headers: {
            ...CODEX_CLIENT_HEADERS,
            'session-id': request.sessionID,
            authorization: `Bearer ${receipt.accessToken}`,
            'chatgpt-account-id':
              receipt.accountIdentity ??
              identityOfToken(receipt.accessToken) ??
              null,
          },
          attempt: data,
        }
      }
      const token = row ? source.usableToken(row) : undefined
      if (!row || !token) {
        log?.warn('pool row holds no usable token; refusing the request', {
          accountId,
        })
        throw refuse()
      }
      const identity = row.identity ?? identityOfToken(token)
      const data: OpenAIAttemptData = {
        kind: 'pool',
        token,
        credentialEpoch: row.credentialEpoch,
        ...(identity !== undefined ? { identity } : {}),
      }
      await prepareFeedback(data)
      commitChoice()
      return {
        headers: {
          ...CODEX_CLIENT_HEADERS,
          'session-id': request.sessionID,
          authorization: `Bearer ${token}`,
          'chatgpt-account-id': identity ?? null,
        },
        attempt: data,
      }
    } finally {
      keptChoice?.drop()
    }
  }

  const adapter: OpenCode2AuthAdapter<
    CodexQuotaReading,
    OpenAIAttemptData,
    ChooseAccountResult
  > = {
    providerID: OPENAI_PROVIDER_ID,
    async retrySameAccount(input) {
      if (input.continuation !== 'interrupted-read') return undefined
      const previous = interrupted.get(requestKey(input))
      interrupted.delete(requestKey(input))
      if (
        !previous ||
        previous.accountId !== input.accountId ||
        previous.modelID !== input.modelID ||
        previous.agent !== input.agent ||
        input.limit
      )
        return undefined
      const vaultMode =
        vault !== undefined && (await vault.authority()) !== 'local'
      const storage = getResolvedSettingsView(
        await deps.storage(),
        deps.configPath,
      )
      if (!vaultMode && !(await source.current()).active) return undefined
      const at = now()
      const targets = currentTargets(storage, at, vaultMode)
      const target = targets.find(
        (candidate) => candidate.id === input.accountId,
      )
      if (!target) return undefined
      const routing = routingInput(targets, storage, at)
      const mode = storage?.routing?.mode ?? 'main-first'
      if (mode === 'sticky-balanced') {
        const pinned = routePinnedRow(
          routing,
          stickyOptions(targets, storage),
          input.accountId,
        )
        if (pinned.kind !== 'serve' && pinned.kind !== 'last-path')
          return undefined
      } else {
        const plan = planOrdered({
          ...routing,
          placement: orderedPlacement(mode),
          ...(vaultMode
            ? { mainId: vaultMainRouteId(vault?.routes() ?? []) }
            : {}),
        })
        if (plan.kind === 'block' || !plan.order.includes(input.accountId))
          return undefined
      }
      const data = previous.data
      if (target.row) {
        if (data?.kind !== 'pool') return undefined
        const token = source.usableToken(target.row)
        const identity =
          target.row.identity ?? (token && identityOfToken(token))
        if (!token || !data.identity || identity !== data.identity)
          return undefined
      } else {
        if (data?.kind !== 'vault' || !vault) return undefined
        const receipt = await vault.authorize(input.accountId)
        if (
          !receipt ||
          receipt.credentialId !== data.credentialId ||
          receipt.accountIdentity !== data.accountIdentity ||
          (receipt.accountIdentity ?? identityOfToken(receipt.accessToken)) !==
            data.wireIdentity ||
          (target.identity !== undefined &&
            target.identity !== data.wireIdentity)
        )
          return undefined
      }
      return { accountId: input.accountId }
    },
    dropSameAccountRetry() {},
    dropChoice(input) {
      const key = receiptKey(input)
      dropRequestHandoff(key)
      keptChoices.get(key)?.drop()
      keptChoices.delete(key)
      receipts.delete(key)
    },
    chooseAccount,
    accountHeaders,
    async rewriteRequest({ request, sessionID, kind, attempt }) {
      const url = deps.codexEndpoint
        ? codexRequestURL(request.url, deps.codexEndpoint())
        : request.url
      const routed = url === request.url ? request : new Request(url, request)
      const rewritten =
        (await rewriteCodexHttpRequest(
          routed,
          { sessionID, kind },
          effort,
          deps.responsesLite?.() ?? false,
          undefined,
          observeBillingModel(attempt),
        )) ?? routed
      return rewritten
    },
    rewriteHandshakeURL: ({ url }) =>
      deps.codexEndpoint
        ? codexRequestURL(url, deps.codexEndpoint())
        : undefined,
    rewriteWebSocketFrame: ({ frame, sessionID, kind, attempt }) =>
      rewriteCodexFrame(
        frame,
        { sessionID, kind },
        effort,
        observeBillingModel(attempt),
      ),
    quotaFromHeaders: (headers, status, attempt) => {
      if (attempt.data?.kind === 'vault')
        vault?.reportUsage(
          attempt.data.routeId,
          { headers },
          attempt.data.receipt,
        )
      if (
        attempt.data?.kind === 'vault' &&
        hasVaultRoutingAccessor() &&
        status >= 200 &&
        status < 300
      )
        routingResponses.set(attempt, { status, headers })
      return quotaFromCodexHeaders(headers)
    },
    async limitFromResponse({ status, headers, body, attempt }) {
      if (status < 400) return undefined
      const parsed = parseJson(await body().catch(() => ''))
      const at = now()
      const signal = parseRateLimitSignal(
        {
          ...(isRecord(parsed) ? parsed : {}),
          status,
        },
        at,
      )
      if (attempt.data?.kind === 'vault' && hasVaultRoutingAccessor()) {
        reportVaultRouting(attempt.sessionID, attempt.data.receipt, {
          status,
          headers,
          body: parsed,
          limit: signal,
          quota: vault?.routes().find((route) => route.id === attempt.accountId)
            ?.quota,
          now: now(),
        })
        // The HTTP refusal was handled here; attempt-end must not report it again.
        routingLimitsHandled ??= new WeakSet()
        routingLimitsHandled.add(attempt)
      }
      if (!signal) return undefined
      const limit = toLimit(
        signal,
        at,
        status,
        quotaFor(attempt.accountId, attempt.data?.kind === 'vault'),
      )
      if (limit.retryAfterMs !== undefined) return limit
      const after = retryAfterMs(headers)
      return after === undefined
        ? limit
        : {
            ...limit,
            retryAfterMs: after,
            resetAt: at + after,
            resetSource: 'retry-after',
          }
    },
    inspectEvent: ({ data, transport, attempt }) => {
      const event = parseJson(data)
      let billingDone = false
      const state = attempt.data && feedback.get(attempt.data)
      if (
        state &&
        isRecord(event) &&
        (event.type === 'response.failed' || event.type === 'error')
      )
        state.failed = true
      if (state && isRecord(event) && event.type === 'response.completed')
        state.completed = true
      if (
        attempt.data?.kind === 'vault' &&
        data.includes('codex.rate_limits')
      ) {
        const frame = parseJson(data)
        if (isRecord(frame) && frame.type === 'codex.rate_limits')
          vault?.reportUsage(
            attempt.data.routeId,
            { frame },
            attempt.data.receipt,
          )
      }
      if (attempt.data?.kind === 'vault' && hasVaultRoutingAccessor()) {
        const record = billing.get(attempt)
        if (record) {
          record.event(event)
          billingDone =
            transport === 'ws' &&
            isRecord(event) &&
            (event.type === 'response.incomplete' ||
              event.type === 'response.failed' ||
              event.type === 'error')
        }
        if (
          vaultRoutingStreamMayFail(data) ||
          (transport === 'ws' && data.includes('"response.completed"'))
        ) {
          if (vaultRoutingStreamFailed(event)) routingFailures.add(attempt)
          // WebSocket completions have no HTTP header hook to report their outcome.
          if (
            transport === 'ws' &&
            isRecord(event) &&
            event.type === 'response.completed'
          )
            reportVaultRouting(attempt.sessionID, attempt.data.receipt, {
              status: 200,
              headers: new Headers(),
              failed: routingFailures.has(attempt),
            })
        }
      }
      const verdict = inspectParsedCodexEvent(
        event,
        now(),
        quotaFor(attempt.accountId, attempt.data?.kind === 'vault'),
      )
      if (
        attempt.data?.kind === 'vault' &&
        hasVaultRoutingAccessor() &&
        verdict?.limit
      ) {
        routingLimitBodies ??= new WeakMap()
        routingLimitBodies.set(attempt, event)
      }
      // HTTP acceptance belongs to the body reader, not an SSE lifecycle
      // frame. A WebSocket has no body end, so its completion is explicit.
      return billingDone ||
        (transport === 'ws' &&
          isRecord(event) &&
          event.type === 'response.completed')
        ? { ...verdict, done: true }
        : verdict
    },
    limitFromError(error: HostError, attempt) {
      const parsed = parseJson(error.message)
      const at = now()
      const reading = quotaFor(
        attempt.accountId,
        attempt.data?.kind === 'vault',
      )
      const limit =
        limitOfEvent(
          {
            ...(isRecord(parsed) ? parsed : {}),
            ...(error.status !== undefined ? { status: error.status } : {}),
          },
          at,
          reading,
        ) ??
        (error.message.includes('usage_limit_reached')
          ? toLimit(
              { window: 'usage_limit_reached' },
              at,
              error.status,
              reading,
            )
          : undefined)
      if (
        attempt.data?.kind === 'vault' &&
        hasVaultRoutingAccessor() &&
        limit
      ) {
        routingLimitBodies ??= new WeakMap()
        routingLimitBodies.set(attempt, parsed)
      }
      return limit
    },
    // A 401 on a send the vault authorized is reported to the vault against
    // the record version in that send's receipt; no other status is
    // reported. Only an HTTP response gives a status here: OpenCode 2 runs no
    // plugin hook for a WebSocket handshake the server refuses.
    async onAttemptEnd(attempt, outcome) {
      const record =
        attempt.data?.kind === 'vault' && hasVaultRoutingAccessor()
          ? billing.get(attempt)
          : undefined
      if (record) {
        billing.delete(attempt)
        record.end(
          outcome.outputStarted,
          !outcome.error,
          outcome.status,
          outcome.error?.reason === 'cancelled',
        )
      }
      const data = attempt.data
      const state = data && feedback.get(data)
      if (state) {
        const clean =
          !outcome.error &&
          !outcome.limit &&
          !state.failed &&
          (attempt.transport === 'ws'
            ? state.completed
            : outcome.status !== undefined &&
              outcome.status >= 200 &&
              outcome.status < 300)
        if (clean && state.dispatch && limits) {
          const current = currentDispatch.get(state.dispatch.sessionId)
          recordSessionCompletion(
            limits.activity,
            state.dispatch,
            current === state.dispatch
              ? limits.accountKey(attempt.accountId)
              : undefined,
            attempt.transport === 'ws'
              ? { kind: 'ws', event: 'response.completed', aborted: false }
              : {
                  kind: 'http',
                  completed: true,
                  failed: false,
                  aborted: false,
                },
          )
        }
        state.owner?.afterProbe(state.probe, clean, Boolean(outcome.limit))
      }
      if (data && outcome.outputStarted && outcome.error?.reason === 'failed') {
        interrupted.set(requestKey(attempt), {
          accountId: attempt.accountId,
          modelID: attempt.modelID,
          agent: attempt.agent,
          sessionID: attempt.sessionID,
          data:
            data.kind === 'pool'
              ? { kind: 'pool', identity: data.identity }
              : {
                  kind: 'vault',
                  credentialId: data.receipt.credentialId,
                  accountIdentity: data.receipt.accountIdentity,
                  wireIdentity:
                    data.receipt.accountIdentity ??
                    identityOfToken(data.receipt.accessToken),
                },
        })
        if (interrupted.size > DEFAULT_MAX_RECORDS) {
          const oldest = interrupted.keys().next().value
          if (oldest !== undefined) interrupted.delete(oldest)
        }
      }
      const response =
        data?.kind === 'vault' && hasVaultRoutingAccessor()
          ? routingResponses.get(attempt)
          : undefined
      routingResponses.delete(attempt)
      if (
        data?.kind === 'vault' &&
        hasVaultRoutingAccessor() &&
        outcome.limit &&
        routingLimitBodies?.has(attempt) &&
        !routingLimitsHandled?.has(attempt)
      ) {
        routingLimitsHandled ??= new WeakSet()
        routingLimitsHandled.add(attempt)
        const limit = outcome.limit as OpenAILimitSignal
        if (limit.windows?.some((window) => window.confirmed))
          reportVaultRoutingLimit(
            attempt.sessionID,
            data.receipt,
            {
              window: limit.reason,
              resetAt: limit.resetAt,
            },
            {
              body: routingLimitBodies?.get(attempt),
              headers: response?.headers,
              quota: vault
                ?.routes()
                .find((route) => route.id === attempt.accountId)?.quota,
              now: limit.observedAt,
            },
          )
      }
      routingLimitBodies?.delete(attempt)
      // HTTP success is reported only after the body ends without an error or cancellation.
      if (
        data?.kind === 'vault' &&
        response &&
        !outcome.error &&
        !outcome.limit
      )
        reportVaultRouting(attempt.sessionID, data.receipt, {
          ...response,
          failed: routingFailures.has(attempt),
        })
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
    if (data?.kind !== 'pool') return
    // A reading that arrives after the row's credential was replaced
    // describes the credential the send went out with, not the row's.
    const row = source
      .peek()
      .rows.find((candidate) => candidate.id === accountId)
    if (row?.credentialEpoch !== data.credentialEpoch) {
      log?.debug('quota reading dropped: the row holds another credential', {
        accountId,
      })
      return
    }
    // The pool drops a reading whose token is not the row's own any more.
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
    if (limits) {
      const state = handle.data && feedback.get(handle.data)
      const owner = state?.owner ?? limits.owner()
      if (!owner) return
      if (!state?.probe || owner.registry !== state.probe.registry) {
        owner.dropSignal()
        return
      }
      const signal = limit as Partial<OpenAILimitSignal>
      const { command, provenance } = openAiRateLimitCommand({
        binding: state.probe.binding,
        baseRevision: state.probe.baseRevision,
        producerId,
        operationId: randomUUID(),
        parsed: {
          window: limit.reason,
          resetAt:
            signal.resetAt ??
            (limit.retryAfterMs !== undefined
              ? at + limit.retryAfterMs
              : undefined),
        },
        reading: quotaFor(accountId, fromVault),
        now: at,
        observedAt: signal.observedAt ?? at,
        evidenceAt: at,
        resetSource: signal.resetSource,
      })
      owner.enqueue(command, provenance)
      return
    }
    // Without registry ownership neither custody mode stores fallback marks.
  }

  return {
    adapter,
    beginTurn: clearTurn,
    dispose: () => {
      heldTurns.clear()
      waitCounts.clear()
      pendingWaits.clear()
      billingCounts.clear()
    },
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
      clearTurn(sessionId)
      for (const [key, entry] of requestHandoffs) {
        if (entry.sessionID === sessionId) dropRequestHandoff(key)
      }
      currentDispatch.delete(sessionId)
      limits?.forget(sessionId)
      for (const [key, attempt] of interrupted) {
        if (attempt.sessionID === sessionId) interrupted.delete(key)
      }
      pins.forget(sessionId)
      sessionAccounts.forget(sessionId)
      effort.forget(sessionId)
    },
    activeAccount: (sessionId) => sessionAccounts.activeAccount(sessionId),
  }
}
