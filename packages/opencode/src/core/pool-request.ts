// The request path of a migrated install: every account, main included, is a
// row of the account pool, and this module chooses the row(s) one request is
// sent with.
//
// It reads rows from `PoolAccountSource` (in memory; see that module for what
// may wait) and decides with `pool-routing.ts`. Sending, recording quota for
// a response and the sidebar pin ledger stay with the caller (`index.ts`),
// which owns the transport and the sidebar file; they are passed in.
//
// The modes:
// - `main-first` and `fallback-first`: the library's ordered routing with
//   row `main` first or last; on a response whose status is one of the
//   configured fallback statuses the next admitted row is tried.
// - `sticky-balanced`: a session keeps the row it was placed on. A pinned
//   row confirmed unable to serve (exhausted, spent budget, killed, or a
//   401/403 or an exhausting 429 on this request) loses the session for
//   good; a pinned row whose quota is not known yet serves elsewhere for this
//   request only. Requests that cannot be pinned (no session, not
//   replayable) are routed main-first.
//
// The OpenAI accounts the Claustrum vault serves this host (`ctx.vault`)
// replace the pool rows while this host is in vault mode (enrolled with the
// vault): the request is routed over the vault's accounts alone, through the
// same admission and modes, and no pool row is read, refreshed or sent with.
// A vault account holds no token: each send asks the vault for one. When no
// vault account can serve, the request is refused locally; it never falls
// back to a local row.

import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import {
  type AccountKey,
  createRequestHistory,
  type LimitCandidate,
  type LimitDecision,
  type LimitSignal,
  type PolicyFacts,
  type SessionActivity,
  sameAccount,
  type WaitCheckpoint,
} from '@cortexkit/common-auth/limits'
import {
  budgetExhaustedResetAt,
  isQuotaMap,
  projectQuota,
} from '@cortexkit/common-auth/quota'
import {
  nextOrderedAttempt,
  type OrderedAttempt,
  type RoutingRow,
  type StickySelection,
} from '@cortexkit/common-auth/routing'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  buildOpenAiQuotaRefusal,
  chooseVaultRouting,
  classifyOpenAiLimitBody,
  decideOpenAiLimit,
  decideOpenAiTerminal,
  getFallbackStatuses,
  getKillswitchThresholdsForAccount,
  isKillswitchEnabled,
  isRecord,
  isShieldedMainRow,
  isTombstoned,
  killswitchPassesPolicy,
  normalizeQuotaHeaders,
  type OAuthQuotaSnapshot,
  type OpenAiLimitsOwner,
  observeVaultRoutingResponse,
  openAiConfirmedBlockers,
  openAiHoldFacts,
  openAiTerminalFacts,
  quotaSnapshotPassesPolicy,
  type RoutingMode,
  VAULT_MODE_REFUSAL_CAUSES,
  VAULT_MODE_REFUSALS,
  type VaultModeRefusal,
  type VaultRoutingRequest,
} from '@cortexkit/openai-auth-core/internal'
import { parseRateLimitSignal } from '../ws'
import type { PoolAccountSource } from './pool-account-source'
import { windowsFromQuotaMap } from './pool-quota'
import {
  admitSticky,
  type CreditsServing,
  FORMER_MAIN_ID,
  orderedPlacement,
  type PoolBlock,
  type PoolRoutingInput,
  planOrdered,
  poolKillswitchVerdicts,
  routePinnedRow,
  type StickyAdmission,
  type StickyRouteOptions,
  selectStickyRow,
  stickyBreak,
  vaultMainRouteId,
  waitForFirstQuotaReading,
} from './pool-routing'

/** One sticky pin decision handed to the caller's pin ledger. */
export interface PoolPinPlacement {
  sessionId: string
  requestBytes: number
  now: number
  validPinnedAccountIds: readonly string[]
  excludeAccountIds: readonly string[]
  quotaCheckedAtByAccount: Readonly<Record<string, number | undefined>>
  wireAccountIdByAccount: Readonly<Record<string, string | undefined>>
  select: (
    pendingBytes: ReadonlyMap<string, number>,
  ) => StickySelection | undefined
  /** False for a decision that must not move the session's recorded pin. */
  persist: boolean
}

/** Quotas of the routable accounts, for a block's Retry-After. */
export interface PoolBlockQuotas {
  main: OAuthQuotaSnapshot | undefined
  fallbacks: Array<{ accountId: string; quota?: OAuthQuotaSnapshot }>
}

/** One account a request may be sent with: a pool row or a vault account. */
export interface PoolTarget {
  id: string
  /** The ChatGPT account it signs in as, when known. */
  identity?: string
  /** Its quota map; undefined while no reading has arrived. */
  quota?: unknown
  /** `api-key` for a static key the vault serves; every pool row is `oauth`. */
  kind: 'oauth' | 'api-key'
  /** The pool row; absent for a vault account. */
  row?: PoolRow
}

/**
 * The vault accounts, as a request routes them (see `OpenAiVault`). Present
 * exactly while this host is in vault mode; the request then routes over
 * these accounts and nothing else.
 */
export interface PoolVaultRoutes {
  /** The vault accounts that may route now. */
  routes(): ReadonlyArray<{
    id: string
    credentialId?: string
    kind: 'oauth' | 'api-key'
    identity?: string
    quota?: unknown
  }>
  /**
   * Waits for the vault's first account list in this process, for a bounded
   * time, and returns either way. Never rejects.
   */
  awaitRoster(): Promise<void>
  /**
   * Why no vault account could be tried: the vault has not listed its
   * accounts (unreachable), or it lists none that may serve (empty).
   */
  noRouteCause(): Exclude<VaultModeRefusal, 'vault-refused'>
  /**
   * Sends on a vault account with the token the vault serves for this
   * attempt; undefined when the vault refused before anything was sent.
   */
  send(
    id: string,
    dispatch: (token: string, attempt: QuotaReceipt) => Promise<Response>,
  ): Promise<Response | undefined>
  /** Asks for a quota reading of a vault account admission refused for want of one. */
  requestReading: PoolRoutingInput['requestPull']
  /**
   * Vault account id to the time (ms) until which that account counts as
   * rate-limited, from rate-limit signals a WebSocket stream received
   * mid-response. Routing treats the account as rate-limited until then.
   */
  rateLimitMarks?(): ReadonlyMap<string, number>
}

export type NoCredentialCause =
  | 'no-accounts'
  | 'unusable'
  | 'missing-main'
  | VaultModeRefusal

// Keep these texts unchanged: OpenCode decides whether to retry a failed
// request by matching the error message, so a reworded message could change
// whether it retries. The vault-mode texts are shared with the other hosts;
// `vault-no-grant` names this host's enrollment, so it is built by
// `vaultModeRefusalText` instead of being listed here.
export const LOCAL_CREDENTIAL_REFUSALS: Record<
  Exclude<NoCredentialCause, 'vault-no-grant'>,
  string
> = {
  'missing-main':
    'Request refused locally: this setup has no main login in its account store. Sign in with opencode auth login.',
  'no-accounts':
    'Request refused locally: no eligible account is configured. Sign in with opencode auth login.',
  unusable:
    'Request refused locally: no usable account credential. Sign in with opencode auth login.',
  ...VAULT_MODE_REFUSALS,
}

/** Whether a refusal cause is one of vault mode's. */
export function isVaultModeRefusal(
  cause: NoCredentialCause | undefined,
): cause is VaultModeRefusal {
  return (
    cause !== undefined &&
    (VAULT_MODE_REFUSAL_CAUSES as readonly string[]).includes(cause)
  )
}

export interface PoolRequestContext {
  source: PoolAccountSource
  /** The host's mark authority; omitted by callers still using the source map. */
  rateLimitMarks?: () => Map<string, number>
  /** Process-local HTTP holds; transport streams have no Retry-After channel. */
  limitPolicy?: PoolLimitPolicy
  /** Do not create a new hold for a reissue whose pending hold was discarded. */
  suppressHold?: boolean
  /** The vault accounts; present exactly while this host is in vault mode. */
  vault?: PoolVaultRoutes
  /** The legacy settings this request reads (routing, killswitch, fallback statuses). */
  storage: AccountStorage | null
  mode: RoutingMode
  sessionId: string | undefined
  /** Separates endpoint and conversation/auxiliary retries within a session. */
  requestKind?: string
  routingRequest?: VaultRoutingRequest
  /** The buffered request body, when there is one. */
  body: string | undefined
  replayable: boolean
  now: () => number
  /** Sends the request with one account's token; rejects on a transport failure or abort. */
  send(
    target: PoolTarget,
    token: string,
    attempt?: QuotaReceipt,
  ): Promise<Response>
  /**
   * Records the quota a response carried for the account that served it.
   * `attempt` is the vault's receipt for a vault account: the reading is kept
   * only while the account still signs in as the same ChatGPT account.
   */
  recordQuota(
    response: Response,
    target: PoolTarget,
    token: string,
    attempt?: QuotaReceipt,
  ): void
  /** The session pin ledger: decides (and, when asked, records) a session's pin. */
  placePin(input: PoolPinPlacement): { accountId: string } | undefined
  /** A provider-shaped refusal for a request no account may serve. */
  blocked(
    block: PoolBlock,
    quotas: PoolBlockQuotas,
    cause?: NoCredentialCause,
  ): Response
  /** Reset credits an account holds, for sticky placement's tie-break. */
  resetCredits(id: string): number | undefined
  /** Whether this send failure is the caller aborting the request. */
  isAbort(error: unknown): boolean
  /**
   * The accounts this process serves on prepaid credits, told about each
   * served request so it can log when an account starts serving on them.
   */
  creditsServing?: CreditsServing
  log: {
    debug(message: string, meta?: Record<string, unknown>): void
    info?(message: string, meta?: Record<string, unknown>): void
  }
}

export interface PendingPoolHold {
  sessionId: string
  accountKey: AccountKey
  model: string
  target: number
  checkpoint: WaitCheckpoint
  decidedAt: number
  decision: Extract<LimitDecision, { action: 'hold' }>
}

export interface PoolLimitPolicy {
  pending: Map<string, PendingPoolHold>
  accountKey(id: string): AccountKey | undefined
  activity(): SessionActivity | undefined
  currentAccountKey(): AccountKey | undefined
  owner(): OpenAiLimitsOwner | undefined
  /** Tests can observe reducer calls to distinguish provider pass-through from a local hold. */
  decide?: typeof decideOpenAiLimit
}

function requestModel(ctx: PoolRequestContext): string {
  try {
    const body = JSON.parse(ctx.body ?? '{}')
    return typeof body.model === 'string' ? body.model : ''
  } catch {
    return ''
  }
}

function pendingKey(ctx: PoolRequestContext): string | undefined {
  return (
    ctx.sessionId &&
    (ctx.requestKind === undefined
      ? ctx.sessionId
      : JSON.stringify([ctx.sessionId, ctx.requestKind]))
  )
}

function policyCandidates(
  ctx: PoolRequestContext,
  rows: readonly PoolTarget[],
  signal?: LimitSignal,
  latest?: { id: string; reading: OAuthQuotaSnapshot },
): LimitCandidate[] {
  const routing = routingInput(ctx, rows)
  return rows.flatMap((row) => {
    const account = ctx.limitPolicy?.accountKey(row.id)
    if (!account) return []
    const reading =
      latest?.id === row.id ? latest.reading : windowsFromQuotaMap(row.quota)
    const confirmedBlockers = openAiConfirmedBlockers(
      signal && sameAccount(signal.account, account) ? signal : undefined,
      reading,
      routing.now,
    )
    const hard = routing.rateLimitMarks.get(row.id)
    const backoff = routing.refreshBackoff.get(row.id)
    const blockers = [
      ...(hard && hard > routing.now
        ? [{ kind: 'hard' as const, until: hard }]
        : []),
      ...(backoff && backoff > routing.now
        ? [{ kind: 'cooldown' as const, until: backoff }]
        : []),
    ]
    const admitted =
      killswitchPassesPolicy(
        reading,
        ctx.storage,
        row.id === FORMER_MAIN_ID ? undefined : row.id,
        routing.now,
      ) &&
      !!(reading?.primary || reading?.secondary) &&
      !budgetExhaustedResetAt(
        projectQuota(isQuotaMap(row.quota) ? row.quota : undefined),
        routing.now,
      ) &&
      (!row.row || !!ctx.source.usableToken(row.row))
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
}

function policyFacts(
  ctx: PoolRequestContext,
  candidates: LimitCandidate[],
): PolicyFacts {
  const now = ctx.now()
  return {
    phase: 'after-limit',
    host: 'opencode1',
    hostPhase: 'request',
    now,
    clockNow: now,
    sessionId: ctx.sessionId ?? '',
    requestScope: { kind: 'pool' },
    history: createRequestHistory({
      requestId: ctx.sessionId ?? 'request',
      originalUrl: 'https://api.openai.com/v1/responses',
      clockNow: now,
    }),
    delivery: { owned: true, attributable: true, replayable: ctx.replayable },
    candidates,
  }
}

function policyResponse(
  ctx: PoolRequestContext,
  decision: LimitDecision,
): Response {
  const wire = buildOpenAiQuotaRefusal({
    decision,
    now: ctx.now(),
    host: 'opencode1',
    maxSameAccountWait: ctx.storage?.routing?.maxSameAccountWait,
  })
  if (wire.kind !== 'http')
    throw new Error('Expected an OC1 HTTP quota refusal')
  return new Response(wire.body, { status: wire.status, headers: wire.headers })
}

async function afterLimit(
  ctx: PoolRequestContext,
  row: PoolTarget,
  response: Response,
  mode: 'ordered' | 'sticky',
  next?: string,
  attempted?: AccountKey,
): Promise<{ hold?: Response; confirmed: boolean }> {
  const policy = ctx.limitPolicy
  // Classify only replayable failed HTTP responses, never consume a successful stream.
  if (
    !policy ||
    !ctx.replayable ||
    (mode === 'ordered' &&
      !getFallbackStatuses(ctx.storage).includes(response.status)) ||
    (mode === 'sticky' && ![401, 403, 429].includes(response.status))
  )
    return { confirmed: false }
  const account = attempted
  if (!account) return { confirmed: false }
  const rows = currentTargets(ctx)
  const current = rows.find((target) => target.id === row.id)
  // Vault quota publication is detached. Judge the response's own headers now,
  // without waiting for its roster write or losing a still-present sibling window.
  const reading = {
    ...windowsFromQuotaMap(current?.quota),
    ...normalizeQuotaHeaders(response.headers),
  }
  const signal =
    response.status === 429
      ? classifyOpenAiLimitBody({
          account,
          status: response.status,
          headers: response.headers,
          body: await response.clone().text(),
          now: ctx.now(),
          reading,
        })
      : undefined
  const candidates = policyCandidates(ctx, rows, signal, {
    id: row.id,
    reading,
  })
  const candidate = candidates.find((value) =>
    sameAccount(value.account, account),
  )
  const selection =
    next && candidates.find((value) => value.account.accountId === next)
  const currentAccount = policy.currentAccountKey()
  const decision = (policy.decide ?? decideOpenAiLimit)(
    {
      ...policyFacts(ctx, candidates),
      attempted: account,
      status: response.status,
      signal,
      affinity: mode === 'sticky' ? 'sticky' : 'none',
      ...(selection
        ? { selection: { account: selection.account, pin: 'preserve' } }
        : {}),
      hold:
        candidate &&
        ctx.sessionId &&
        !ctx.suppressHold &&
        currentAccount &&
        sameAccount(currentAccount, candidate.account)
          ? openAiHoldFacts({
              candidate,
              status: response.status,
              activity: policy.activity(),
              now: ctx.now(),
              maxSameAccountWait: ctx.storage?.routing?.maxSameAccountWait,
            })
          : undefined,
    },
    { mode, fallbackOn: ctx.storage?.fallbackOn },
  )
  const key = pendingKey(ctx)
  if (decision?.action === 'hold' && ctx.sessionId && key) {
    policy.pending.set(key, {
      sessionId: ctx.sessionId,
      accountKey: account,
      model: requestModel(ctx),
      target: decision.target,
      checkpoint: decision.checkpoint,
      decidedAt: ctx.now(),
      decision,
    })
    if (policy.pending.size > 256) {
      const oldest = policy.pending.keys().next().value
      if (oldest) policy.pending.delete(oldest)
    }
    response.body?.cancel().catch(() => {})
    return { hold: policyResponse(ctx, decision), confirmed: true }
  }
  return {
    confirmed:
      !!candidate?.confirmedBlockers?.length && response.status === 429,
  }
}

async function consumeHold(
  ctx: PoolRequestContext,
  rows: readonly PoolTarget[],
): Promise<PoolRequestResult | undefined> {
  const policy = ctx.limitPolicy
  const session = ctx.sessionId
  const key = pendingKey(ctx)
  const pending = key && policy?.pending.get(key)
  if (!pending || !policy || !session || !key) return undefined
  const candidates = policyCandidates(ctx, rows)
  const candidate = candidates.find((value) =>
    sameAccount(value.account, pending.accountKey),
  )
  const windows = new Map<
    string,
    NonNullable<LimitCandidate['confirmedBlockers']>[number]
  >(
    pending.checkpoint.blockers.map((blocker) => [
      blocker.window,
      {
        ...blocker,
        confirmed: true,
        confirmedByReading: false,
        observedAt: pending.decidedAt,
        provenance: 'provider',
      },
    ]),
  )
  for (const blocker of candidate?.confirmedBlockers ?? [])
    windows.set(blocker.window, blocker)
  const hold =
    candidate &&
    openAiHoldFacts({
      candidate: { ...candidate, confirmedBlockers: [...windows.values()] },
      activity: policy.activity(),
      now: ctx.now(),
      maxSameAccountWait: ctx.storage?.routing?.maxSameAccountWait,
    })
  policy.pending.delete(key)
  const currentAccount = policy.currentAccountKey()
  if (
    !ctx.replayable ||
    requestModel(ctx) !== pending.model ||
    !currentAccount ||
    !sameAccount(currentAccount, pending.accountKey) ||
    !candidate?.admitted ||
    !hold ||
    hold.maxWaitMs <= 0 ||
    ctx.now() > hold.cacheExpiresAt ||
    pending.target > Math.min(hold.cacheExpiresAt, ctx.now() + hold.maxWaitMs)
  )
    return undefined
  if (ctx.now() < pending.target) {
    policy.pending.set(key, pending)
    return {
      response: policyResponse(ctx, {
        ...pending.decision,
        delayMs: pending.target - ctx.now(),
        retryAfterMs: pending.target - ctx.now(),
      }),
      servedId: candidate.account.accountId,
    }
  }
  // Retain checkpoint evidence even when its reading is stale at wake. Current
  // windows replace the checkpoint, so new or extended exhaustion cannot be waived.
  const decision = (policy.decide ?? decideOpenAiLimit)(
    {
      ...policyFacts(
        ctx,
        candidates.map((value) =>
          value === candidate
            ? { ...value, confirmedBlockers: [...windows.values()] }
            : value,
        ),
      ),
      phase: 'pre-send',
      attempted: candidate.account,
      hold,
      wake: {
        target: pending.target,
        checkpoint: pending.checkpoint,
        kind: 'hold',
      },
    },
    { mode: 'sticky' },
  )
  if (decision?.action !== 'retain' || decision.reason !== 'wait-elapsed')
    return undefined
  const row = rows.find((value) => value.id === candidate.account.accountId)
  const response = row && (await sendTo(ctx, row))
  return response && row ? { response, servedId: row.id } : undefined
}

function terminalResponse(
  ctx: PoolRequestContext,
  rows: readonly PoolTarget[],
  block: PoolBlock,
): Response | undefined {
  if (
    !ctx.limitPolicy ||
    !['quota-exhausted', 'killswitch', 'mid-stream-rate-limit'].includes(
      block.reason,
    )
  )
    return undefined
  const policy = ctx.limitPolicy
  const now = ctx.now()
  const owner = policy.owner()
  const accounts = rows.flatMap((row) => {
    const account = policy.accountKey(row.id)
    if (!account) return []
    return [
      {
        account,
        reading: windowsFromQuotaMap(row.quota),
        floors: isKillswitchEnabled(ctx.storage)
          ? getKillswitchThresholdsForAccount(
              ctx.storage,
              row.id === FORMER_MAIN_ID ? undefined : row.id,
            )
          : undefined,
        marks: owner
          ?.snapshot()
          ?.marks.filter(
            (mark) =>
              mark.key.window === 'account' &&
              mark.key.scope.kind === 'pool' &&
              sameAccount(mark.key.account, account),
          )
          .flatMap((mark) =>
            mark.entries.map((entry) => ({
              until: entry.until,
              evidenceAt: entry.evidenceAt,
            })),
          ),
      },
    ]
  })
  const terminal = openAiTerminalFacts({
    accounts,
    now,
    effectiveModel: requestModel(ctx),
    maxSameAccountWait: ctx.storage?.routing?.maxSameAccountWait,
    activity: policy.activity(),
    currentAccountKey: policy.currentAccountKey(),
    provenance: owner?.provenance,
  })
  return policyResponse(
    ctx,
    decideOpenAiTerminal(
      {
        ...policyFacts(ctx, policyCandidates(ctx, rows)),
        phase: 'pre-send',
      },
      accounts.length
        ? terminal
        : {
            ...terminal,
            messageKey:
              block.reason === 'killswitch'
                ? 'killswitch'
                : block.reason === 'quota-exhausted'
                  ? 'quota'
                  : 'timed-mark',
          },
    ),
  )
}

export interface PoolRequestResult {
  response: Response
  /** The row that served, or `main` for a blocked request, for the routing display. */
  servedId: string
}

/**
 * The rows openai-auth may send with: enabled OAuth rows holding a
 * credential. A row other than main must also pass the legacy quota policy
 * (`quota.minimumRemaining`, `failClosedOnUnknownQuota`) and must not be the
 * shielded copy of a main credential still in the slot, exactly as a fallback
 * had to. API-key rows are left out: the request path has never sent with
 * one. Outside vault mode `vaultIdentities` is empty; callers in vault mode
 * route no pool row at all.
 */
export function routableRows(
  rows: readonly PoolRow[],
  storage: AccountStorage | null,
  now: number,
  vaultIdentities: ReadonlySet<string> = new Set(),
): PoolRow[] {
  return rows.filter((row) => {
    if (!row.enabled || !row.candidate || row.type !== 'oauth') return false
    if (row.credential?.type !== 'oauth') return false
    if (isTombstoned(row.credential)) return false
    // The vault owns this ChatGPT account; its vault route serves it.
    if (row.identity !== undefined && vaultIdentities.has(row.identity))
      return false
    if (row.id === FORMER_MAIN_ID) return true
    if (isShieldedMainRow(storage, { accountId: row.identity })) return false
    return quotaSnapshotPassesPolicy(
      windowsFromQuotaMap(row.quota),
      storage,
      now,
    )
  })
}

/**
 * The accounts one request may be sent with now. In vault mode these are the
 * vault's accounts alone, and the pool rows are not even read; otherwise the
 * routable pool rows.
 */
function currentTargets(ctx: PoolRequestContext): PoolTarget[] {
  const vault = ctx.vault
  const rows = vault
    ? []
    : routableRows(ctx.source.peek().rows, ctx.storage, ctx.now())
  return [
    ...rows.map(
      (row): PoolTarget => ({
        id: row.id,
        kind: 'oauth',
        ...(row.identity !== undefined ? { identity: row.identity } : {}),
        ...(row.quota !== undefined ? { quota: row.quota } : {}),
        row,
      }),
    ),
    ...(vault?.routes() ?? [])
      .filter((route) =>
        quotaSnapshotPassesPolicy(
          windowsFromQuotaMap(route.quota),
          ctx.storage,
          ctx.now(),
        ),
      )
      .map(
        (route): PoolTarget => ({
          id: route.id,
          kind: route.kind,
          ...(route.identity !== undefined ? { identity: route.identity } : {}),
          ...(route.quota !== undefined ? { quota: route.quota } : {}),
        }),
      ),
  ]
}

function poolRowsOf(targets: readonly PoolTarget[]): PoolRow[] {
  return targets.flatMap((target) => (target.row ? [target.row] : []))
}

function routingInput(
  ctx: PoolRequestContext,
  targets: readonly PoolTarget[],
): PoolRoutingInput {
  const now = ctx.now()
  const killswitch = poolKillswitchVerdicts(targets, ctx.storage, now)
  const routingRows: RoutingRow[] = targets.map((target) => ({
    id: target.id,
    kind: target.kind,
    ...(isQuotaMap(target.quota) ? { quota: target.quota } : {}),
  }))
  const rows = poolRowsOf(targets)
  const vaultIds = new Set(
    targets.filter((target) => !target.row).map((target) => target.id),
  )
  const rateLimitMarks = ctx.rateLimitMarks
    ? ctx.rateLimitMarks()
    : ctx.source.rateLimitMarks(rows)
  for (const [id, until] of ctx.vault?.rateLimitMarks?.() ?? []) {
    if (vaultIds.has(id) && until > now) rateLimitMarks.set(id, until)
  }
  return {
    rows: routingRows,
    now,
    rateLimitMarks,
    refreshBackoff: ctx.source.refreshBackoffFor(rows),
    killswitch,
    requestPull: (id) =>
      vaultIds.has(id)
        ? ctx.vault?.requestReading(id)
        : ctx.source.requestReading(id),
  }
}

function blockQuotas(targets: readonly PoolTarget[]): PoolBlockQuotas {
  const main = targets.find((target) => target.id === FORMER_MAIN_ID)
  return {
    main: main ? windowsFromQuotaMap(main.quota) : undefined,
    fallbacks: targets
      .filter((target) => target.id !== FORMER_MAIN_ID)
      .map((target) => {
        const quota = windowsFromQuotaMap(target.quota)
        return { accountId: target.id, ...(quota ? { quota } : {}) }
      }),
  }
}

/**
 * Sends the request with one account and records the quota its response
 * carried. Undefined when the account had nothing to send with: a pool row
 * without a usable token, or a vault account the vault refused to serve.
 */
async function sendTo(
  ctx: PoolRequestContext,
  target: PoolTarget,
): Promise<Response | undefined> {
  if (target.row) {
    const token = ctx.source.usableToken(target.row)
    if (!token) return undefined
    const response = await ctx.send(target, token)
    ctx.recordQuota(response, target, token)
    return response
  }
  return ctx.vault?.send(target.id, async (token, attempt) => {
    const response = await ctx.send(target, token, attempt)
    ctx.recordQuota(response, target, token, attempt)
    return observeVaultRoutingResponse(ctx.sessionId, attempt, response, {
      parseLimit: (body) =>
        parseRateLimitSignal({
          ...(isRecord(body) ? body : {}),
          status: response.status,
        }),
      quota: target.quota,
      now: ctx.now,
    })
  })
}

/** Reads the current rows, readies their tokens, and routes one request. */
export async function servePoolRequest(
  ctx: PoolRequestContext,
): Promise<PoolRequestResult> {
  if (ctx.vault) {
    // Vault mode: no pool row is read or refreshed. Before the vault's first
    // account list there is nothing to route, so that is waited for (bounded).
    await ctx.vault.awaitRoster()
  } else {
    await ctx.source.current()
    await ctx.source.prepareTokens(ctx.source.peek().rows, ctx.storage)
  }
  let rows = currentTargets(ctx)
  const firstReadingRows =
    ctx.replayable === false && rows.some((row) => row.id === FORMER_MAIN_ID)
      ? rows.filter((row) => row.id === FORMER_MAIN_ID)
      : rows
  const firstReading = waitForFirstQuotaReading(
    routingInput(ctx, firstReadingRows),
  )
  if (firstReading) {
    await firstReading
    rows = currentTargets(ctx)
  }
  const key = pendingKey(ctx)
  const hadPending = key && ctx.limitPolicy?.pending.has(key)
  const held = await consumeHold(ctx, rows)
  if (held) return held
  if (hadPending) ctx = { ...ctx, suppressHold: true }

  if (
    ctx.mode === 'sticky-balanced' &&
    ctx.sessionId &&
    ctx.replayable &&
    ctx.body !== undefined
  ) {
    const sticky = await serveSticky(ctx, rows, ctx.sessionId, ctx.body)
    if (sticky) return sticky
    return serveOrdered({ ...ctx, routingRequest: undefined }, rows)
  }
  return serveOrdered(ctx, rows)
}

async function serveOrdered(
  ctx: PoolRequestContext,
  rows: readonly PoolTarget[],
): Promise<PoolRequestResult> {
  const placement = orderedPlacement(ctx.mode)
  const routing = routingInput(ctx, rows)
  const plan = planOrdered({
    ...routing,
    placement,
    mainId: ctx.vault
      ? ctx.mode === 'sticky-balanced'
        ? null
        : vaultMainRouteId(ctx.vault.routes())
      : undefined,
    replayable: ctx.replayable,
  })
  if (plan.kind === 'block') {
    ctx.log.debug('pool admission blocked the request', {
      pid: process.pid,
      reason: plan.block.reason,
    })
    return {
      response:
        terminalResponse(ctx, rows, plan.block) ??
        ctx.blocked(
          plan.block,
          blockQuotas(rows),
          ctx.vault
            ? rows.length === 0
              ? ctx.vault.noRouteCause()
              : undefined
            : rows.length === 0
              ? 'no-accounts'
              : 'unusable',
        ),
      servedId: FORMER_MAIN_ID,
    }
  }
  if (plan.lastPath) {
    ctx.log.debug(
      'pool admission: every account is exhausted; probing anyway',
      {
        pid: process.pid,
        order: plan.order,
      },
    )
  }

  const byId = new Map(rows.map((row) => [row.id, row]))
  const preferred = await chooseVaultRouting({
    vaultMode: ctx.vault !== undefined,
    fresh: true,
    sessionId: ctx.sessionId,
    request: ctx.routingRequest,
    routes: ctx.vault?.routes() ?? [],
    routing,
    eligibleIds: plan.order,
  })
  const order = preferred
    ? [preferred, ...plan.order.filter((id) => id !== preferred)]
    : plan.order
  const retryStatuses = getFallbackStatuses(ctx.storage)
  const attempts: OrderedAttempt[] = []
  // Accounts that had nothing to send with (a vault account the vault would
  // not serve, a row without a usable token). Nothing reached the provider,
  // so the next account in the order is tried as if this one were not there.
  const unsent = new Set<string>()
  let last: PoolRequestResult | undefined
  let vaultRefused = false
  for (;;) {
    const id = nextOrderedAttempt(
      order.filter((candidate) => !unsent.has(candidate)),
      attempts,
      retryStatuses,
    )
    const row = id === undefined ? undefined : byId.get(id)
    if (!row) break
    const attempted = ctx.limitPolicy?.accountKey(row.id)
    let response: Response | undefined
    try {
      response = await sendTo(ctx, row)
    } catch (error) {
      // A failed send may already have reached the provider (generated, or
      // billed), so it is never repeated on another account. The previous
      // account's answer stands when there is one, except after a
      // fallback-first probe, which always surfaced the failure.
      if (ctx.isAbort(error) || !last || ctx.mode === 'fallback-first')
        throw error
      ctx.log.debug('pool fallback attempt threw; stopping', {
        pid: process.pid,
        accountId: row.id,
      })
      return last
    }
    if (!response) {
      if (!row.row) vaultRefused = true
      unsent.add(row.id)
      continue
    }
    // Only the response returned keeps its body; an earlier one is dropped
    // once a later attempt has produced a replacement.
    last?.response.body?.cancel().catch(() => {})
    last = { response, servedId: row.id }
    attempts.push({ id: row.id, status: response.status })
    const next = nextOrderedAttempt(
      order.filter((candidate) => !unsent.has(candidate)),
      attempts,
      retryStatuses,
    )
    const outcome = await afterLimit(
      ctx,
      row,
      response,
      'ordered',
      next,
      attempted,
    )
    if (outcome.hold) return { response: outcome.hold, servedId: row.id }
  }
  if (last) {
    noteServed(ctx, routing, last.servedId)
    return last
  }
  return {
    response: ctx.blocked(
      { reason: 'no-credential' },
      blockQuotas(rows),
      vaultRefused ? 'vault-refused' : ctx.vault ? 'vault-empty' : 'unusable',
    ),
    servedId: FORMER_MAIN_ID,
  }
}

async function serveSticky(
  ctx: PoolRequestContext,
  rows: readonly PoolTarget[],
  sessionId: string,
  body: string,
): Promise<PoolRequestResult | undefined> {
  const requestBytes = Buffer.byteLength(body, 'utf8')
  const byId = new Map(rows.map((row) => [row.id, row]))
  let routing = routingInput(ctx, rows)
  let sticky = admitSticky(routing)
  const options: StickyRouteOptions = {
    requestBytes,
    // Each account's killswitch thresholds are its reserve: placement weighs
    // only the quota above the floor the killswitch would stop it at.
    reservePercent: (id) =>
      getKillswitchThresholdsForAccount(
        ctx.storage,
        id === FORMER_MAIN_ID ? undefined : id,
      ),
    resetCredits: ctx.resetCredits,
    onEmptyWeightedSet: () => {
      ctx.log.debug(
        'sticky routing: no fresh weighted candidates; using configured order',
      )
    },
  }

  let preferred: StickySelection | undefined
  let cold = false
  const placer =
    (input: PoolRoutingInput, admission: StickyAdmission) =>
    (exclude: readonly string[], persist: boolean) => {
      const excluded = new Set(exclude)
      return ctx.placePin({
        sessionId,
        requestBytes,
        now: input.now,
        // Every routable row that is not marked or backed off may hold a pin,
        // whether or not admission let it serve this request: a pin on a row
        // waiting for its first reading must survive until the reading comes.
        validPinnedAccountIds: input.rows
          .map((row) => row.id)
          .filter((id) => !admission.excluded.has(id)),
        excludeAccountIds: exclude,
        quotaCheckedAtByAccount: Object.fromEntries(
          input.rows.map((row) => [
            row.id,
            admission.projections.get(row.id)?.checkedAt,
          ]),
        ),
        wireAccountIdByAccount: Object.fromEntries(
          rows.map((row) => [row.id, row.identity]),
        ),
        select: (pendingBytes) => {
          if (!persist && exclude.length === 0) cold = true
          const selected =
            preferred ?? selectStickyRow(input, options, excluded, pendingBytes)
          return selected
        },
        persist,
      })
    }

  let place = placer(routing, sticky)
  const preview = ctx.vault && ctx.routingRequest ? place([], false) : undefined
  if (preview && cold) {
    const advised = await chooseVaultRouting({
      vaultMode: ctx.vault !== undefined,
      fresh: true,
      sessionId,
      request: ctx.routingRequest,
      routes: ctx.vault?.routes() ?? [],
      routing,
    })
    preferred = advised
      ? {
          accountId: advised,
          source: 'mode-fallback',
          quotaCheckedAt: sticky.projections.get(advised)?.checkedAt,
        }
      : undefined
  }
  const assignment = place([], true)
  preferred = undefined
  if (!assignment) return undefined
  let id = assignment.accountId

  const migrate = (reason: string) => {
    const replacement = place([id], true)
    if (!replacement) return false
    ctx.log.debug('sticky routing: migrated session pin', {
      pid: process.pid,
      fromAccountId: id,
      toAccountId: replacement.accountId,
      reason,
    })
    id = replacement.accountId
    return true
  }

  const pinned = routePinnedRow(routing, options, id)
  if (pinned.kind === 'none') return undefined
  if (pinned.kind === 'move') {
    // The pin ledger re-places the session with its own pending bytes. If it
    // finds no other row after all, a pinned row that is only exhausted is
    // still sent to (as on the `last-path` route); a row below its
    // killswitch floor never is.
    if (!migrate(pinned.reason) && pinned.reason === 'killswitch')
      return undefined
  } else if (pinned.kind === 'detour') {
    const detour = place([id], false)
    if (!detour) return undefined
    ctx.log.debug('sticky routing: pinned account awaits a quota reading', {
      pid: process.pid,
      pinnedAccountId: id,
      servedAccountId: detour.accountId,
    })
    id = detour.accountId
  }

  let row = byId.get(id)
  if (!row) return undefined
  const attempted = ctx.limitPolicy?.accountKey(row.id)
  let response = await sendTo(ctx, row)
  if (!response) return undefined
  const outcome = await afterLimit(
    ctx,
    row,
    response,
    'sticky',
    undefined,
    attempted,
  )
  if (outcome.hold) return { response: outcome.hold, servedId: row.id }

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 429
  ) {
    // The response's own quota has just been recorded, so judge the break on
    // the rows as they are now.
    const current = currentTargets(ctx)
    routing = routingInput(ctx, current)
    sticky = admitSticky(routing)
    place = placer(routing, sticky)
    const after = stickyBreak(routing, sticky, id, response.status)
    if (after.action === 'migrate' || outcome.confirmed) {
      const from = id
      if (
        migrate(outcome.confirmed ? 'exhausted' : after.reason) &&
        id !== from
      ) {
        const replacement = current.find((candidate) => candidate.id === id)
        const replaced = replacement
          ? await sendTo(ctx, replacement)
          : undefined
        if (replacement && replaced) {
          const previous = response
          response = replaced
          previous.body?.cancel().catch(() => {})
          row = replacement
        } else {
          id = from
        }
      }
    }
  }
  noteServed(ctx, routing, row.id)
  return { response, servedId: row.id }
}

/** Tells the credits tracker which account served, on the rows routed over. */
function noteServed(
  ctx: PoolRequestContext,
  routing: PoolRoutingInput,
  id: string,
): void {
  const info = ctx.log.info
  ctx.creditsServing?.served(
    routing,
    id,
    info
      ? { info: (message, data) => info.call(ctx.log, message, data) }
      : undefined,
  )
}
