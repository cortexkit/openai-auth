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
//   `chatgpt-account-id`;
// - what a response says about the row: quota from the `x-codex-*` headers
//   and `codex.rate_limits` frames, refusals for a usage or rate limit, and
//   whether output has started (openai-auth's own rule, `isNonEmittingFrame`).
//
// The installer retries a request refused before any output on another
// account, and never after output; `attach` records the refusal as a
// rate-limit mark on the row first, so the next `chooseAccount` routes
// around it.

import type {
  ChooseAccountInput,
  EventVerdict,
  HeaderEdits,
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
import type { SessionPins } from './pins'

/** The provider (and integration) OpenCode 2 serves ChatGPT logins under. */
export const OPENAI_PROVIDER_ID = 'openai'

/**
 * How long a row stays marked after a refusal that named no reset and whose
 * window has no known reset either; the value OpenCode 1 uses
 * (`DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS` in the plugin entry).
 */
export const DEFAULT_LIMIT_MARK_MS = 60_000

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

export interface OpenAIAdapterDeps {
  source: PoolAccess
  /** The settings a request reads (routing mode, killswitch, quota policy). */
  storage: () => Promise<AccountStorage | null>
  pins: SessionPins
  now?: () => number
  log?: OpenAIAdapterLogger
}

export interface OpenAIAdapter {
  readonly adapter: OpenCode2AuthAdapter<CodexQuotaReading>
  /** Records quota and refusals from the installer's events on the pool. */
  attach(installation: OpenCode2AuthInstallation<CodexQuotaReading>): void
  /** Drops a session's pin and remembered account. */
  forgetSession(sessionId: string): void
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
  // The bearer last handed out per row: quota readings are attributed to a
  // row only when they came back for that row's own token.
  const tokens = new Map<string, string>()
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

  const routingInput = (
    rows: readonly PoolRow[],
    storage: AccountStorage | null,
    at: number,
  ): PoolRoutingInput => {
    const killswitch = new Map<string, boolean>()
    if (isKillswitchEnabled(storage)) {
      for (const row of rows) {
        killswitch.set(
          row.id,
          killswitchPassesPolicy(
            windowsFromQuotaMap(row.quota),
            storage,
            row.id === FORMER_MAIN_ID ? undefined : row.id,
            at,
          ),
        )
      }
    }
    const routingRows: RoutingRow[] = rows.map((row) => ({
      id: row.id,
      kind: 'oauth',
      ...(isQuotaMap(row.quota) ? { quota: row.quota } : {}),
    }))
    return {
      rows: routingRows,
      now: at,
      rateLimitMarks: source.rateLimitMarks(rows),
      refreshBackoff: source.refreshBackoffFor(rows),
      killswitch,
      requestPull: (id) => source.requestReading(id),
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
    rows: readonly PoolRow[],
    storage: AccountStorage | null,
    sessionId: string,
    excluded: ReadonlySet<string>,
    persist: boolean,
  ): string | undefined => {
    const options: StickyRouteOptions = {
      // OpenCode 2 hands the hooks no request body before the account is
      // chosen, so sessions are weighed by quota alone.
      requestBytes: 0,
      reservePercent: (id) =>
        getKillswitchThresholdsForAccount(
          storage,
          id === FORMER_MAIN_ID ? undefined : id,
        ),
      // Reset credits come from the quota poll's full reading, which only
      // OpenCode 1's in-memory quota cache keeps; no tie-break here.
      resetCredits: () => undefined,
    }
    const sticky = admitSticky(routing)
    const place = (exclude: readonly string[], keep: boolean) =>
      pins.place({
        sessionId,
        requestBytes: 0,
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
          rows.map((row) => [row.id, row.identity]),
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
      // No other row after all: a row that is only exhausted is still sent
      // to, as OpenCode 1 does; one below its killswitch floor never is.
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
    const rows = routableRows(source.peek().rows, storage, at)
    const routing = routingInput(rows, storage, at)
    const excluded = new Set<string>(
      input.rerouteFrom ? [input.rerouteFrom.accountId] : [],
    )
    const mode: RoutingMode = storage?.routing?.mode ?? 'main-first'
    const primary = input.kind === 'primary'
    let accountId: string | undefined
    if (mode === 'sticky-balanced') {
      accountId = chooseSticky(
        routing,
        rows,
        storage,
        input.sessionID,
        excluded,
        primary,
      )
    }
    accountId ??= chooseOrdered(
      routing,
      mode,
      excluded,
      primary ? undefined : sessionAccounts.get(input.sessionID),
    )
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

  const accountHeaders = ({
    accountId,
  }: {
    accountId: string
  }): HeaderEdits => {
    const row = source
      .peek()
      .rows.find((candidate) => candidate.id === accountId)
    const token = row ? source.usableToken(row) : undefined
    if (!row || !token) {
      // Never throw here: a throw in the WebSocket handshake switches the
      // session to HTTP for good. Removing the header sends the request
      // without a credential, which the provider refuses, rather than with
      // the host's placeholder.
      log?.warn('pool row holds no usable token; sending without one', {
        accountId,
      })
      return { authorization: null, 'chatgpt-account-id': null }
    }
    tokens.set(accountId, token)
    const identity = row.identity ?? identityOfToken(token)
    return {
      authorization: `Bearer ${token}`,
      'chatgpt-account-id': identity ?? null,
    }
  }

  const adapter: OpenCode2AuthAdapter<CodexQuotaReading> = {
    providerID: OPENAI_PROVIDER_ID,
    chooseAccount,
    accountHeaders,
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
  }

  const recordQuota = (accountId: string, reading: CodexQuotaReading) => {
    const token = tokens.get(accountId)
    if (!token) return
    source.recordSnapshot(accountId, reading.snapshot, token, reading.complete)
  }

  const markLimited = (accountId: string, limit: LimitSignal) => {
    const at = now()
    const row = source
      .peek()
      .rows.find((candidate) => candidate.id === accountId)
    const until = resolveMidStreamRateLimitResetAt(
      row ? windowsFromQuotaMap(row.quota) : undefined,
      limit.reason,
      at,
      DEFAULT_LIMIT_MARK_MS,
      limit.retryAfterMs !== undefined ? at + limit.retryAfterMs : undefined,
    )
    source.markRateLimited(accountId, until)
  }

  return {
    adapter,
    attach(installation) {
      installation.on('quota', (event) =>
        recordQuota(event.accountId, event.quota),
      )
      // The installer waits for this listener before it asks the host to
      // retry, so the mark is in place when `chooseAccount` runs again.
      installation.on('limit', (event) => {
        markLimited(event.accountId, event.limit)
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
    },
  }
}
