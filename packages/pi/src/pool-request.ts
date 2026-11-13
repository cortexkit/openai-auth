// Choosing the account(s) one Pi request is sent with.
//
// The accounts are Pi's own login, routed as row `main`, and the rows of
// Pi's account pool (`pool-source.ts`), the fallbacks; the decisions come
// from the core package's `pool-routing.ts`. Sending stays with the caller (`index.ts`), which
// owns Pi's stream; it is passed in.
//
// The modes:
// - `main-first` and `fallback-first`: the library's ordered routing with
//   `main` first or last; when an attempt fails before streaming anything
//   with one of the configured fallback statuses, the next admitted account
//   is tried.
// - `sticky-balanced`: a session keeps the account it was placed on. A pinned
//   account confirmed unable to serve (exhausted, spent budget, killed, or a
//   401/403 or an exhausting 429 on this request) loses the session for
//   good; a pinned account whose quota is not known yet serves elsewhere for
//   this request only. A request without a session id is routed main-first.
//
// While Pi is connected to the Claustrum vault (vault mode) the caller hands
// in the vault's accounts alone (`vault` accounts): they hold no token, the
// caller's `send` asks the vault for one per attempt.

import {
  type AccountKey,
  createRequestHistory,
  decideAfterLimit,
  type LimitCandidate,
  type LimitDecision,
  type LimitSignal,
  type PolicyFacts,
  type SessionActivity,
  sameAccount,
  sameAccountHoldFacts,
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
} from '@cortexkit/common-auth/routing'
import {
  type AccountStorage,
  decideOpenAiLimit,
  decideOpenAiTerminal,
  getFallbackStatuses,
  getKillswitchThresholdsForAccount,
  isTombstoned,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
  openAiConfirmedBlockers,
  openAiHoldFacts,
  openAiLimitAxes,
  openAiTerminalFacts,
  quotaSnapshotPassesPolicy,
  type RoutingMode,
  type StickyPinPlacement,
  startVaultRoutingWait,
} from '@cortexkit/openai-auth-core/internal'

import { windowsFromQuotaMap } from '@cortexkit/openai-auth-core/pool-quota'
import {
  type AdmissionTier,
  admitSticky,
  type CreditsServing,
  FIRST_QUOTA_READING_WAIT_MS,
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
  waitForFirstQuotaReading,
} from '@cortexkit/openai-auth-core/pool-routing'

/** One account a request may be sent with. */
export interface RouteAccount {
  id: string
  /** Tracks one login on a row/route; unknown identities cannot earn activity. */
  accountKey?: AccountKey
  /** The account's ChatGPT identity, when known. */
  identity?: string
  /** Its pool quota map; undefined while no reading has arrived. */
  quota?: unknown
  /** The bearer to send with now, or undefined when it holds no usable one. */
  token: string | undefined
  /** `api-key` for a static key the vault serves; Pi's own accounts are `oauth`. */
  kind?: 'oauth' | 'api-key'
  /** A vault account: no token here, the vault serves one per send. */
  vault?: true
}

/** Whether an account has something to send with: a token, or the vault. */
function sendable(account: RouteAccount | undefined): account is RouteAccount {
  return account !== undefined && (account.vault === true || !!account.token)
}

/** What one attempt reports back: the HTTP status, when a response arrived. */
export interface RouteAttempt {
  status?: number
  /** Captured before dispatch, so a replacement cannot inherit old evidence. */
  accountKey?: AccountKey
  signal?: LimitSignal
  /** Response headers may arrive before the vault updates its quota reading. */
  reading?: OAuthQuotaSnapshot
}

/** Internal policy interface used before Pi publishes the first stream event. */
export interface PiLimitPolicy {
  activity(): SessionActivity | undefined
  decide?: typeof decideOpenAiLimit
  onDecision?(decision: LimitDecision, facts: PolicyFacts): void
  /** Runtime execution is opt-in; callers without it can observe decisions only. */
  execute?: boolean
  canWait?: boolean
  effectiveModel?: string
  wake?: PiWake
}

export interface PiWake {
  facts: NonNullable<PolicyFacts['wake']>
  identity?: string
  signal?: LimitSignal
}

export type PiWaitDecision = Extract<
  LimitDecision,
  { action: 'hold' | 'wait-then-reselect' }
>

export interface PiRouteContext<A extends RouteAttempt> {
  /** The routable accounts as they are now; read again after each response. */
  accounts: () => readonly RouteAccount[]
  /** Resolved preferences captured for this request, not evidence of a store. */
  storage: AccountStorage | null
  mode: RoutingMode
  /** Unset uses Pi's local main; null means the vault has no default account. */
  mainId?: string | null
  sessionId: string | undefined
  /** The request's size, which sticky placement weighs sessions by. */
  requestBytes: number
  now: () => number
  /** Account id to the time it may be tried again, for accounts that must sit out. */
  refreshBackoff: (accounts: readonly RouteAccount[]) => Map<string, number>
  /** Asks for a quota poll of an account admission refused for want of a reading. */
  requestPull: PoolRoutingInput['requestPull']
  /** Optional override for tests or callers with their own first-reading wait budget. */
  firstReadingWaitMs?: number
  limitPolicy?: PiLimitPolicy
  /** Retain sticky admission tiers only when the host will report billing. */
  captureAdmissionTier?: boolean
  /**
   * Sends the request with one account. Undefined when nothing was sent: the
   * vault refused to serve a vault account.
   */
  send(account: RouteAccount, tier?: AdmissionTier): Promise<A | undefined>
  /** The session pin ledger: decides (and, when asked, records) a session's pin. */
  placePin(input: StickyPinPlacement): { accountId: string } | undefined
  /**
   * The accounts this process serves on prepaid credits, told about each
   * served request so it can log when an account starts serving on them.
   */
  creditsServing?: CreditsServing
  log?: {
    debug(message: string, meta?: Record<string, unknown>): void
    info?(message: string, meta?: Record<string, unknown>): void
  }
}

export type PiRouteResult<A> =
  | { kind: 'sent'; attempt: A; accountId: string; decision?: LimitDecision }
  | { kind: 'blocked'; block: PoolBlock }
  | {
      kind: 'policy'
      decision: PiWaitDecision | Extract<LimitDecision, { action: 'refuse' }>
      wake?: PiWake
    }

/**
 * Pool rows that may serve beside Pi's login: enabled OAuth rows holding a
 * credential that pass the quota policy (`quota.minimumRemaining`,
 * `failClosedOnUnknownQuota`), as a fallback account always had to. A row
 * holding the same ChatGPT account as Pi's login is left out: that account
 * already serves as `main`, and is refreshed by Pi alone. So is a row
 * signing in as a ChatGPT account the vault holds (`vaultIdentities`): the
 * vault owns it, and serves it through its own route.
 */
export function routablePoolRows<
  R extends {
    id: string
    type: 'oauth' | 'api'
    candidate: boolean
    identity?: string
    quota?: unknown
    credential?: { type: 'oauth' | 'api'; refresh?: string }
  },
>(
  rows: readonly R[],
  settings: AccountStorage | null,
  now: number,
  mainIdentity: string | undefined,
  vaultIdentities: ReadonlySet<string> = new Set(),
): R[] {
  return rows.filter((row) => {
    if (!row.candidate || row.type !== 'oauth') return false
    if (row.credential?.type !== 'oauth') return false
    if (isTombstoned(row.credential)) return false
    // Pi's login is routed as `main`; a pool row may not take its id.
    if (row.id === FORMER_MAIN_ID) return false
    if (mainIdentity && row.identity === mainIdentity) return false
    if (row.identity !== undefined && vaultIdentities.has(row.identity))
      return false
    return quotaSnapshotPassesPolicy(
      windowsFromQuotaMap(row.quota),
      settings,
      now,
    )
  })
}

function policyCandidates<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  key?: AccountKey,
  attempt?: RouteAttempt,
): LimitCandidate[] {
  const now = ctx.now()
  const accounts = ctx.accounts()
  const routing = routingInput(ctx, accounts)
  return accounts.flatMap((account) => {
    if (!account.accountKey) return []
    const ownsAttempt = key && sameAccount(account.accountKey, key)
    const reading = {
      ...windowsFromQuotaMap(account.quota),
      ...(ownsAttempt ? attempt?.reading : undefined),
    }
    const confirmedBlockers = openAiConfirmedBlockers(
      ownsAttempt ? attempt?.signal : undefined,
      reading,
      now,
    )
    const backoff = routing.refreshBackoff.get(account.id)
    const admitted =
      sendable(account) &&
      !(backoff !== undefined && backoff > now) &&
      killswitchPassesPolicy(
        reading,
        ctx.storage,
        account.id === FORMER_MAIN_ID ? undefined : account.id,
        now,
      ) &&
      !budgetExhaustedResetAt(
        projectQuota(isQuotaMap(account.quota) ? account.quota : undefined),
        now,
      )
    return [
      {
        account: account.accountKey,
        admitted,
        placementEligible: admitted,
        ready:
          admitted &&
          !!(reading.primary || reading.secondary) &&
          !confirmedBlockers.length,
        blockers: [],
        confirmedBlockers,
      },
    ]
  })
}

function terminalFacts<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  key?: AccountKey,
  attempt?: RouteAttempt,
) {
  const candidates = policyCandidates(ctx, key, attempt)
  const activity = ctx.limitPolicy?.activity()
  return openAiTerminalFacts({
    accounts: ctx.accounts().flatMap((account) => {
      if (!account.accountKey) return []
      const accountKey = account.accountKey
      const ownsAttempt = key && sameAccount(account.accountKey, key)
      return [
        {
          account: account.accountKey,
          usable: sendable(account),
          reading: {
            ...windowsFromQuotaMap(account.quota),
            ...(ownsAttempt ? attempt?.reading : undefined),
          },
          confirmedBlockers: candidates.find((value) =>
            sameAccount(value.account, accountKey),
          )?.confirmedBlockers,
          floors:
            ctx.storage?.killswitch?.enabled === true
              ? getKillswitchThresholdsForAccount(
                  ctx.storage,
                  account.id === FORMER_MAIN_ID ? undefined : account.id,
                )
              : undefined,
        },
      ]
    }),
    effectiveModel: ctx.limitPolicy?.effectiveModel ?? '',
    now: ctx.now(),
    maxSameAccountWait:
      ctx.limitPolicy?.canWait === false
        ? 0
        : ctx.storage?.routing?.maxSameAccountWait,
    activity,
    currentAccountKey: candidates.find(
      (candidate) =>
        activity && sameAccount(candidate.account, activity.accountKey),
    )?.account,
  })
}

function baseFacts<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
): PolicyFacts {
  const now = ctx.now()
  return {
    phase: 'pre-send',
    host: 'pi',
    now,
    clockNow: now,
    sessionId: ctx.sessionId ?? '',
    requestScope: { kind: 'pool' },
    history: createRequestHistory({
      requestId: ctx.sessionId ?? 'request',
      originalUrl: 'https://chatgpt.com/backend-api/codex/responses',
      clockNow: now,
    }),
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: policyCandidates(ctx),
  }
}

function policyResult<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  decision: LimitDecision | undefined,
  signal?: LimitSignal,
): PiRouteResult<A> | undefined {
  if (!ctx.limitPolicy?.execute || !decision) return undefined
  if (decision.action === 'refuse') return { kind: 'policy', decision }
  if (decision.action !== 'hold' && decision.action !== 'wait-then-reselect')
    return undefined
  const key = decision.checkpoint.accountKey
  return {
    kind: 'policy',
    decision,
    wake: {
      facts: {
        checkpoint: decision.checkpoint,
        target: decision.target,
        kind: decision.waitKind ?? 'hold',
      },
      identity: ctx
        .accounts()
        .find(
          (account) =>
            account.accountKey && sameAccount(account.accountKey, key),
        )?.identity,
      signal: signal && sameAccount(signal.account, key) ? signal : undefined,
    },
  }
}

function terminalResult<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  key?: AccountKey,
  attempt?: RouteAttempt,
): PiRouteResult<A> {
  const facts = baseFacts(ctx)
  const decision = decideOpenAiTerminal(facts, terminalFacts(ctx, key, attempt))
  ctx.limitPolicy?.onDecision?.(decision, facts)
  const result = policyResult(ctx, decision, attempt?.signal)
  if (!result) throw new Error('Missing Pi terminal result')
  return result
}

function afterLimit<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  attempted: RouteAccount,
  attempt: A,
  mode: 'ordered' | 'sticky',
  next?: string,
): LimitDecision | undefined {
  const policy = ctx.limitPolicy
  const key = attempt.accountKey ?? attempted.accountKey
  if (!policy || !key || attempt.status === undefined) return undefined
  // Ordered out-of-list responses bypass even the decision observer.
  if (
    mode === 'ordered' &&
    !getFallbackStatuses(ctx.storage).includes(attempt.status)
  )
    return undefined
  const now = ctx.now()
  const candidates = policyCandidates(ctx, key, attempt)
  const candidate = candidates.find((value) => sameAccount(value.account, key))
  const selection = candidates.find((value) => value.account.accountId === next)
  const facts: PolicyFacts = {
    phase: 'after-limit',
    host: 'pi',
    now,
    clockNow: now,
    sessionId: ctx.sessionId ?? '',
    requestScope: { kind: 'pool' },
    history: createRequestHistory({
      requestId: ctx.sessionId ?? 'request',
      originalUrl: 'https://chatgpt.com/backend-api/codex/responses',
      clockNow: now,
    }),
    attempted: key,
    status: attempt.status,
    signal: attempt.signal,
    affinity: mode === 'sticky' ? 'sticky' : 'none',
    delivery: { owned: true, attributable: true, replayable: true },
    candidates,
    ...(selection
      ? { selection: { account: selection.account, pin: 'preserve' } }
      : {}),
    hold:
      candidate && ctx.sessionId && policy.canWait !== false
        ? openAiHoldFacts({
            candidate,
            status: attempt.status,
            activity: policy.activity(),
            maxSameAccountWait: ctx.storage?.routing?.maxSameAccountWait,
            now,
          })
        : undefined,
  }
  // Terminal quota metadata is meaningful only after the configured status gate
  // and confirmed exhaustion, never for a generic provider error or auth failure.
  if (
    policy.execute &&
    !next &&
    attempt.status === 429 &&
    candidate?.confirmedBlockers?.length
  )
    Object.assign(facts, { terminal: terminalFacts(ctx, key, attempt) })
  const decision = (policy.decide ?? decideOpenAiLimit)(facts, {
    mode,
    fallbackOn: ctx.storage?.fallbackOn,
  })
  if (decision) policy.onDecision?.(decision, facts)
  if (policy.execute && decision?.action === 'refuse' && !facts.terminal)
    return undefined
  return decision
}

function routingInput<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  accounts: readonly RouteAccount[],
): PoolRoutingInput {
  const now = ctx.now()
  const killswitch = poolKillswitchVerdicts(accounts, ctx.storage, now)
  const rows: RoutingRow[] = accounts.map((account) => ({
    id: account.id,
    kind: account.kind ?? 'oauth',
    ...(isQuotaMap(account.quota) ? { quota: account.quota } : {}),
  }))
  return {
    rows,
    now,
    rateLimitMarks: new Map(),
    refreshBackoff: ctx.refreshBackoff(accounts),
    killswitch,
    requestPull: ctx.requestPull,
  }
}

/** Routes one request and sends it with the chosen account(s). */
export async function routePiRequest<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
): Promise<PiRouteResult<A>> {
  let accounts = ctx.accounts()
  const firstReading = waitForFirstQuotaReading(
    routingInput(ctx, accounts),
    ctx.firstReadingWaitMs,
  )
  if (firstReading) {
    const at = ctx.now()
    const end = startVaultRoutingWait({
      sessionId: ctx.sessionId,
      reason: 'quota_reading',
      now: at,
      boundMs: ctx.firstReadingWaitMs ?? FIRST_QUOTA_READING_WAIT_MS,
    })
    await firstReading
    accounts = ctx.accounts()
    if (end)
      end(
        planOrdered({
          ...routingInput(ctx, accounts),
          // Reporting admission must not trigger another quota poll.
          requestPull: () => {},
          placement: 'roster',
          mainId: null,
        }).kind === 'block'
          ? 'abandoned'
          : 'resumed',
      )
  }
  const policy = ctx.limitPolicy
  const wake = policy?.wake
  if (policy?.execute && wake) {
    const key = wake.facts.checkpoint.accountKey
    const account = accounts.find(
      (value) =>
        value.accountKey &&
        sameAccount(value.accountKey, key) &&
        value.identity === wake.identity,
    )
    const facts: PolicyFacts = {
      ...baseFacts(ctx),
      candidates: policyCandidates(ctx, key, { signal: wake.signal }).map(
        (candidate) =>
          sameAccount(candidate.account, key) && !account
            ? { ...candidate, admitted: false }
            : candidate,
      ),
      wake: wake.facts,
      hold: account
        ? sameAccountHoldFacts({
            activity: policy.activity(),
            accountKey: key,
            maxSameAccountWait: ctx.storage?.routing?.maxSameAccountWait,
          })
        : undefined,
    }
    // The after-limit wrapper suppresses holds without an attempted account.
    // Waking has no new attempt, so let the decision function check the saved
    // reset evidence and whether the session's prompt cache remains usable.
    const decision = policy.decide
      ? policy.decide(facts, { mode: 'sticky' })
      : decideAfterLimit(facts, openAiLimitAxes(ctx.storage?.fallbackOn))
    if (decision) policy.onDecision?.(decision, facts)
    if (
      decision?.action === 'retain' &&
      decision.reason === 'wait-elapsed' &&
      account
    ) {
      const attempt = await ctx.send(account)
      if (attempt) {
        const after = afterLimit(
          ctx,
          account,
          attempt,
          ctx.mode === 'sticky-balanced' ? 'sticky' : 'ordered',
        )
        return (
          policyResult(ctx, after, attempt.signal) ?? {
            kind: 'sent',
            attempt,
            accountId: account.id,
            decision: after,
          }
        )
      }
    }
    // After a capped terminal wait, fresh alternatives may serve; unchanged
    // exhaustion must finish without another wait or provider request.
    const current = policyCandidates(ctx, key, { signal: wake.signal })
    if (current.length && !current.some((candidate) => candidate.ready)) {
      // Expired response evidence cannot hide a freshly observed later blocker
      // in the final scan. Reusing the held account still requires the saved
      // exhaustion windows to match and expire, as checked above.
      const signal = wake.signal
        ? {
            ...wake.signal,
            windows: wake.signal.windows.filter(
              (window) =>
                window.resetAt === undefined || window.resetAt > ctx.now(),
            ),
          }
        : undefined
      if (terminalFacts(ctx, key, { signal }).messageKey !== 'timed-mark')
        return terminalResult(ctx, key, { signal })
    }
    if (
      current.some(
        (candidate) => candidate.ready && !sameAccount(candidate.account, key),
      )
    )
      accounts = accounts.filter(
        (value) => !value.accountKey || !sameAccount(value.accountKey, key),
      )
  }
  if (ctx.mode === 'sticky-balanced' && ctx.sessionId) {
    const sticky = await routeSticky(ctx, accounts, ctx.sessionId)
    if (sticky) return sticky
  }
  return routeOrdered(ctx, accounts)
}

async function routeOrdered<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  accounts: readonly RouteAccount[],
): Promise<PiRouteResult<A>> {
  const placement = orderedPlacement(ctx.mode)
  const routing = routingInput(ctx, accounts)
  const plan = planOrdered({
    ...routing,
    placement,
    mainId: ctx.mainId,
  })
  if (plan.kind === 'block') {
    ctx.log?.debug('pool admission blocked the request', {
      reason: plan.block.reason,
    })
    if (
      ctx.limitPolicy?.execute &&
      (plan.block.reason === 'quota-exhausted' ||
        plan.block.reason === 'killswitch')
    )
      return terminalResult(ctx)
    return { kind: 'blocked', block: plan.block }
  }
  if (plan.lastPath) {
    ctx.log?.debug(
      'pool admission: every account is exhausted; probing anyway',
      { order: plan.order },
    )
  }

  const byId = new Map(accounts.map((account) => [account.id, account]))
  const retryStatuses = getFallbackStatuses(ctx.storage)
  const attempts: OrderedAttempt[] = []
  // Accounts that had nothing to send with (a vault account the vault would
  // not serve, an account without a token). Nothing reached the provider, so
  // the next account in the order is tried as if this one were not there.
  const unsent = new Set<string>()
  let last:
    | { attempt: A; accountId: string; decision?: LimitDecision }
    | undefined
  for (;;) {
    const id = nextOrderedAttempt(
      plan.order.filter((candidate) => !unsent.has(candidate)),
      attempts,
      retryStatuses,
    )
    if (id === undefined) break
    const account = byId.get(id)
    if (!sendable(account)) {
      unsent.add(id)
      continue
    }
    const attempt = await ctx.send(account, plan.tiers[id])
    if (!attempt) {
      unsent.add(id)
      continue
    }
    last = { attempt, accountId: account.id }
    attempts.push({
      id: account.id,
      ...(attempt.status !== undefined ? { status: attempt.status } : {}),
    })
    const next = nextOrderedAttempt(
      plan.order.filter((candidate) => !unsent.has(candidate)),
      attempts,
      retryStatuses,
    )
    const decision = afterLimit(ctx, account, attempt, 'ordered', next)
    if (decision) last.decision = decision
    const execution = policyResult(ctx, decision, attempt.signal)
    if (execution) return execution
  }
  if (last) {
    noteServed(ctx, routing, last.accountId)
    return { kind: 'sent', ...last }
  }
  return { kind: 'blocked', block: { reason: 'no-credential' } }
}

async function routeSticky<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  accounts: readonly RouteAccount[],
  sessionId: string,
): Promise<PiRouteResult<A> | undefined> {
  const requestBytes = ctx.requestBytes
  const byId = new Map(accounts.map((account) => [account.id, account]))
  let routing = routingInput(ctx, accounts)
  let sticky = admitSticky(routing)
  const tiers = ctx.captureAdmissionTier
    ? new Map<string, AdmissionTier>()
    : undefined
  const options: StickyRouteOptions = {
    requestBytes,
    // Each account's killswitch thresholds are its reserve: placement weighs
    // only the quota above the floor the killswitch would stop it at.
    reservePercent: (id) =>
      getKillswitchThresholdsForAccount(
        ctx.storage,
        id === FORMER_MAIN_ID ? undefined : id,
      ),
    resetCredits: () => undefined,
    onEmptyWeightedSet: () => {
      ctx.log?.debug(
        'sticky routing: no fresh weighted candidates; using configured order',
      )
    },
  }

  const placer =
    (
      input: PoolRoutingInput,
      admission: StickyAdmission,
      current: readonly RouteAccount[],
      selectionOptions = options,
    ) =>
    (exclude: readonly string[], persist: boolean) => {
      const excluded = new Set(exclude)
      return ctx.placePin({
        sessionId,
        requestBytes,
        // Every routable account that is not backed off may hold a pin,
        // whether or not admission let it serve this request: a pin on an
        // account waiting for its first reading must survive until the
        // reading comes.
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
          current.map((account) => [account.id, account.identity]),
        ),
        select: (pendingBytes) => {
          const selection = selectStickyRow(
            input,
            selectionOptions,
            excluded,
            pendingBytes,
          )
          if (selection) tiers?.set(selection.accountId, selection.tier)
          return selection
        },
        persist,
      })
    }

  let place = placer(routing, sticky, accounts)
  const assignment = place([], true)
  if (!assignment) return undefined
  let id = assignment.accountId

  const migrate = (reason: string) => {
    const replacement = place([id], true)
    if (!replacement) return false
    ctx.log?.debug('sticky routing: migrated session pin', {
      fromAccountId: id,
      toAccountId: replacement.accountId,
      reason,
    })
    id = replacement.accountId
    return true
  }

  const pinned = routePinnedRow(routing, options, id)
  if (pinned.kind === 'serve') tiers?.set(id, pinned.tier)
  else tiers?.delete(id)
  if (pinned.kind === 'none') return undefined
  if (pinned.kind === 'move') {
    // The pin ledger re-places the session with its own pending bytes. If it
    // finds no other account after all, a pinned account that is only
    // exhausted is still sent to (as on the `last-path` route); one below
    // its killswitch floor never is.
    if (!migrate(pinned.reason) && pinned.reason === 'killswitch')
      return undefined
  } else if (pinned.kind === 'detour') {
    const detour = place([id], false)
    if (!detour) return undefined
    ctx.log?.debug('sticky routing: pinned account awaits a quota reading', {
      pinnedAccountId: id,
      servedAccountId: detour.accountId,
    })
    id = detour.accountId
  }

  let account = byId.get(id)
  if (!sendable(account)) return undefined
  let attempt = await ctx.send(account, tiers?.get(id))
  if (!attempt) return undefined
  let decision: LimitDecision | undefined

  if (
    attempt.status === 401 ||
    attempt.status === 403 ||
    attempt.status === 429
  ) {
    // The response's own quota has just been recorded, so judge the break on
    // the accounts as they are now.
    const current = ctx.accounts()
    routing = routingInput(ctx, current)
    sticky = admitSticky(routing)
    place = placer(routing, sticky, current)
    const after = stickyBreak(routing, sticky, id, attempt.status)
    // A proposed alternative is evidence only: no extra quota poll or placement log.
    const alternative = ctx.limitPolicy
      ? placer({ ...routing, requestPull: () => {} }, sticky, current, {
          ...options,
          onEmptyWeightedSet: () => {},
        })([id], false)
      : undefined
    decision = afterLimit(
      ctx,
      account,
      attempt,
      'sticky',
      alternative?.accountId,
    )
    const execution = policyResult(ctx, decision, attempt.signal)
    if (execution) return execution
    if (after.action === 'migrate') {
      const from = id
      if (migrate(after.reason) && id !== from) {
        const replacement = current.find((candidate) => candidate.id === id)
        const replaced = sendable(replacement)
          ? await ctx.send(replacement, tiers?.get(id))
          : undefined
        if (replacement && replaced) {
          attempt = replaced
          account = replacement
          decision = undefined
        } else {
          id = from
        }
      }
    }
  }
  noteServed(ctx, routing, account.id)
  return {
    kind: 'sent',
    attempt,
    accountId: account.id,
    ...(decision ? { decision } : {}),
  }
}

/** Tells the credits tracker which account served, on the accounts routed over. */
function noteServed<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  routing: PoolRoutingInput,
  id: string,
): void {
  const log = ctx.log
  const info = log?.info
  ctx.creditsServing?.served(
    routing,
    id,
    log && info
      ? { info: (message, data) => info.call(log, message, data) }
      : undefined,
  )
}
