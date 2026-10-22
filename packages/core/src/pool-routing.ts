// Routing decisions over the account pool, made with the pool's routing
// library (`@cortexkit/common-auth/routing`). Both hosts route with this one
// copy: OpenCode on a migrated install, Pi for every request (Pi's own login
// is routed as row `main`).
//
// The library decides which rows may serve a request (admission) and in what
// order (`routeOrdered`), routes sticky sessions (`routeSticky`: whether a
// session's pin serves, moves or is served around, and where a session is
// placed) and classifies when a sticky session must leave its row after a
// response (`decideStickyBreak`). openai-auth supplies what the library
// leaves to its caller: rate-limit marks, refresh backoff, killswitch
// verdicts, per-account reserve percentages (the killswitch thresholds),
// reset credits and the session pin ledger.
//
// Two openai-auth rules sit on top of the library's result here, because the
// library has no input that expresses them:
//
// - The last path. When admission leaves no row, openai-auth still sends to
//   an account it knows is exhausted (a window at 100% or a spent credit
//   budget) rather than deny the request without asking the provider: the
//   reading may be stale and the provider has the final say. The library
//   keeps that rule only for spent credit budgets, and only while some row
//   survives its first stage. Rows refused for UNKNOWN quota never take the
//   last path: unknown quota blocks.
// - The no-replay gate. A request that cannot be sent twice goes to one
//   account only (main when present), and is never retried on another: a second send
//   could repeat work the provider already did. The host decides what is
//   replayable: OpenCode marks anything but a buffered POST to `/responses`
//   as not replayable; Pi sends a request again only after its first attempt
//   failed before streaming anything, so it leaves the flag unset and every
//   request is replayable.
// - The prepaid-credits tier. A ChatGPT workspace can hold prepaid credits,
//   and the Codex backend keeps serving an account from them after its
//   rate-limit windows are used up. Credits cost money, so they are only a
//   fallback: an account with free quota left always serves first, and an
//   account whose windows are spent but whose credits are usable (see
//   `creditsUsable`) serves only when no account has free quota. The library
//   refuses such an account as exhausted, so this file puts it back between
//   the free accounts and the last path, for every routing mode and for
//   placing new sessions.

import {
  budgetExhaustedResetAt,
  isQuotaCredits,
  type ProjectedQuota,
  projectQuota,
  type QuotaCredits,
} from '@cortexkit/common-auth/quota'
import {
  type AdmissionRefusal,
  type AdmissionResult,
  admit,
  decideStickyBreak,
  type OrderedPlacement,
  orderForPlacement,
  QUOTA_STALENESS_MS,
  type RoutingRow,
  routeOrdered,
  routeSticky,
  type StickyBreakDecision,
  type StickyRoute,
  type StickySelection,
} from '@cortexkit/common-auth/routing'
import {
  type AccountStorage,
  isKillswitchEnabled,
  killswitchPassesPolicy,
} from './accounts'
import { windowsFromQuotaMap } from './pool-quota'

/**
 * The local main account's row: OpenCode keeps its initial login in pool row
 * `main`; Pi routes its own login under the same id. Ordered routing tries
 * this row first in main-first mode, last in fallback-first mode.
 */
export const FORMER_MAIN_ID = 'main'

/**
 * Only the vault credential named exactly `chatgpt:openai` plays main. Route
 * ids may include a vault-generated suffix, so use the credential name rather
 * than guessing from the route id. Null means no main, never a local row.
 */
export function vaultMainRouteId(
  routes: readonly { id: string; credentialId?: string }[],
): string | null {
  return (
    routes.find(
      (route) =>
        route.id.startsWith('vault:') &&
        route.credentialId === 'chatgpt:openai',
    )?.id ?? null
  )
}

/**
 * Per-account verdicts for the killswitch: the opt-in minimum share of quota
 * that must remain before an account is used. OpenCode and Pi both route with it.
 */
export function poolKillswitchVerdicts(
  accounts: readonly { id: string; quota?: unknown }[],
  storage: AccountStorage | null,
  now: number,
): Map<string, boolean> {
  const verdicts = new Map<string, boolean>()
  if (isKillswitchEnabled(storage)) {
    for (const account of accounts) {
      verdicts.set(
        account.id,
        killswitchPassesPolicy(
          windowsFromQuotaMap(account.quota),
          storage,
          account.id === FORMER_MAIN_ID ? undefined : account.id,
          now,
        ),
      )
    }
  }
  return verdicts
}

/**
 * Retry-After for a request refused because no account has a quota reading
 * yet. The refusal itself asked for the readings, and a poll takes about a
 * second, so the client is told to come back shortly.
 */
export const POOL_QUOTA_UNKNOWN_RETRY_SECONDS = 5

/**
 * A first usage reading is one HTTP call and can take several seconds under
 * load. A short wait beats refusing the user's first request.
 */
export const FIRST_QUOTA_READING_WAIT_MS = 5_000

/**
 * Translate a configured mode to account try order. `ordered` keeps roster
 * order; `fallback-first` puts main last. `main-first` and missing or
 * unrecognized values put main first.
 */
export function orderedPlacement(
  mode: string | undefined,
): Extract<OrderedPlacement, 'roster' | 'main-first' | 'fallback-first'> {
  if (mode === 'ordered') return 'roster'
  return mode === 'fallback-first' ? 'fallback-first' : 'main-first'
}

/** Existing callbacks may return a promise for an in-progress quota poll. */
export type QuotaReadingRequest =
  | ((id: string) => void)
  | ((id: string) => Promise<unknown> | undefined)

export interface PoolRoutingInput {
  /** OAuth rows openai-auth can send with, in roster order. */
  rows: readonly RoutingRow[]
  now: number
  rateLimitMarks: ReadonlyMap<string, number>
  refreshBackoff: ReadonlyMap<string, number>
  /**
   * Killswitch verdict per row (the opt-in floor on remaining quota): `false`
   * means the row is below its floor and must not be spent on; `true` or a
   * missing row passes.
   */
  killswitch: ReadonlyMap<string, boolean>
  /** Asks for a quota poll of a row admission refused for want of a reading. */
  requestPull: QuotaReadingRequest
}

/**
 * Gives an otherwise eligible account's first quota poll a bounded startup
 * budget. Callers must reread their source after the wait: completing a poll
 * is not proof that it produced usable quota.
 * Present readings, including stale ones, stay on the normal admission path.
 */
export function waitForFirstQuotaReading(
  input: PoolRoutingInput,
  waitMs = FIRST_QUOTA_READING_WAIT_MS,
): Promise<void> | undefined {
  const rows = input.rows.filter(
    (row) =>
      row.kind === 'oauth' &&
      input.killswitch.get(row.id) !== false &&
      projectQuota(row.quota).limits.length === 0,
  )
  if (rows.length === 0) return undefined
  const current = admit({
    rows: input.rows,
    now: input.now,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    requestPull: () => {},
  })
  if (current.admitted.some((row) => input.killswitch.get(row.id) !== false))
    return undefined
  const pulls: Promise<unknown>[] = []
  admit({
    rows,
    now: input.now,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    requestPull: (id) => {
      const pending = input.requestPull(id)
      if (pending) pulls.push(pending.catch(() => {}))
    },
  })
  if (pulls.length === 0) return undefined
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    Promise.all(pulls),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    }),
  ])
    .then(() => {})
    .finally(() => clearTimeout(timer))
}

export type PoolBlockReason =
  | 'killswitch'
  | 'mid-stream-rate-limit'
  | 'quota-exhausted'
  | 'quota-unknown'
  | 'no-credential'

export interface PoolBlock {
  reason: PoolBlockReason
  /** The blocking account's own reset, when the reason has one. */
  resetAtMs?: number
}

export type OrderedPlan =
  | { kind: 'send'; order: string[]; lastPath: boolean }
  | { kind: 'block'; block: PoolBlock }

function isConfirmedExhaustion(refusal: AdmissionRefusal): boolean {
  return refusal.reason === 'exhausted' || refusal.reason === 'budget-spent'
}

/**
 * Whether an account's prepaid credits can pay for a request. The record must
 * be well formed and no older than the quota readings routing trusts
 * (`QUOTA_STALENESS_MS`, the age after which sticky routing stops trusting a
 * window reading). The overage allowance must not be used up, and the credits
 * must be unlimited or present with a balance above zero. A record that says
 * the account has credits but reports no balance counts as usable: the
 * backend said it has credits, and the Codex client reads it the same way. A
 * missing, stale or malformed record is never usable; nothing is inferred.
 */
export function creditsUsable(credits: unknown, now: number): boolean {
  if (!isQuotaCredits(credits)) return false
  const record: QuotaCredits = credits
  // Written so a non-finite age also reads as stale.
  if (!(now - record.checkedAt <= QUOTA_STALENESS_MS)) return false
  if (record.overageLimitReached === true) return false
  if (record.unlimited) return true
  return (
    record.hasCredits && (record.balance === undefined || record.balance > 0)
  )
}

/** The rows of one request split into the free-quota and credits tiers. */
interface CreditsTiers {
  /**
   * Rows with free quota: admitted without the library's last-path exception
   * for spent credit budgets, and not below a killswitch floor.
   */
  free: ReadonlySet<string>
  /**
   * Rows that can serve only on prepaid credits, in roster order: refused
   * for a spent window with a future reset, holding usable credits, with the
   * workspace's spending cap not reached and the killswitch passing.
   */
  credits: readonly string[]
}

function creditsTiers(
  rows: readonly RoutingRow[],
  input: PoolRoutingInput,
  admission: AdmissionResult,
): CreditsTiers {
  const passes = (id: string) => input.killswitch.get(id) !== false
  const free = new Set(
    admission.admitted
      .filter((row) => row.lastPath !== true && passes(row.id))
      .map((row) => row.id),
  )
  const refusals = new Map(
    admission.refused.map((refusal) => [refusal.id, refusal]),
  )
  const credits = rows
    .filter((row) => {
      if (row.kind !== 'oauth' || !passes(row.id)) return false
      if (refusals.get(row.id)?.reason !== 'exhausted') return false
      const projection = projectQuota(row.quota)
      // A reached spending cap blocks the account whatever credits it holds.
      if (budgetExhaustedResetAt(projection, input.now)) return false
      return creditsUsable(projection.credits, input.now)
    })
    .map((row) => row.id)
  return { free, credits }
}

function admitQuietly(
  input: PoolRoutingInput,
  rows: readonly RoutingRow[] = input.rows,
): AdmissionResult {
  return admit({
    rows,
    now: input.now,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    requestPull: () => {},
  })
}

/**
 * The rows that would serve this request only on prepaid credits, in roster
 * order. Hosts use it to tell, after a request was served, whether it was
 * served on credits.
 */
export function creditsFallbackIds(input: PoolRoutingInput): string[] {
  return [...creditsTiers(input.rows, input, admitQuietly(input)).credits]
}

/** The logger `CreditsServing` writes its info line to. */
export interface CreditsServingLog {
  info(message: string, data?: Record<string, unknown>): void
}

/**
 * Which accounts this process is currently serving on prepaid credits. A
 * host reports each served request with `served`; the first request an
 * account serves on credits is logged at info (account key and reason only),
 * and the account stays marked, without further lines, until it serves on
 * free quota again or stops qualifying for credits. A request served on free
 * quota clears every mark: free quota exists, so sessions pinned to a credits
 * account move off it at their next request.
 */
export class CreditsServing {
  readonly #ids = new Set<string>()

  served(input: PoolRoutingInput, id: string, log?: CreditsServingLog): void {
    const admission = admitQuietly(input)
    const tiers = creditsTiers(input.rows, input, admission)
    const credits = new Set(tiers.credits)
    if (tiers.free.has(id)) {
      this.#ids.clear()
      return
    }
    for (const marked of [...this.#ids])
      if (!credits.has(marked)) this.#ids.delete(marked)
    if (!credits.has(id) || this.#ids.has(id)) return
    this.#ids.add(id)
    log?.info('serving requests on prepaid credits', {
      accountId: id,
      reason: 'free quota used up',
    })
  }

  /** Whether `id` is currently marked as serving on credits. */
  has(id: string): boolean {
    return this.#ids.has(id)
  }

  /** The accounts currently marked as serving on credits. */
  ids(): ReadonlySet<string> {
    return new Set(this.#ids)
  }
}

/** Why one row cannot serve, read from the admission result and killswitch. */
export function blockFor(
  id: string | undefined,
  admission: AdmissionResult,
  killswitch: ReadonlyMap<string, boolean>,
): PoolBlock {
  if (id === undefined) return { reason: 'no-credential' }
  if (killswitch.get(id) === false) return { reason: 'killswitch' }
  const exclusion = admission.excluded.find((entry) => entry.id === id)
  if (exclusion?.reason === 'rate-limited')
    return { reason: 'mid-stream-rate-limit', resetAtMs: exclusion.until }
  if (exclusion) return { reason: 'no-credential' }
  const refusal = admission.refused.find((entry) => entry.id === id)
  if (refusal && 'resetAtMs' in refusal)
    return { reason: 'quota-exhausted', resetAtMs: refusal.resetAtMs }
  if (refusal) return { reason: 'quota-unknown' }
  return { reason: 'no-credential' }
}

/**
 * The block for a request no row can serve. A row waiting for its first
 * quota reading is named first: its poll is already under way, so the
 * shortest honest answer is to try again shortly. Otherwise the reason is
 * that of the first row in placement order, the account the request would
 * have gone to (row `main` in main-first), as a legacy install reports
 * main's reason.
 */
function routeBlock(
  ids: readonly string[],
  admission: AdmissionResult,
  killswitch: ReadonlyMap<string, boolean>,
): PoolBlock {
  const unknown = admission.refused.find(
    (refusal) =>
      !isConfirmedExhaustion(refusal) && killswitch.get(refusal.id) !== false,
  )
  if (unknown) return { reason: 'quota-unknown' }
  return blockFor(ids[0], admission, killswitch)
}

/**
 * The accounts to try, in order, for the ordered modes. `placement` keeps
 * the roster order (`roster`) or puts the main account first or last; a request
 * that cannot be replayed goes to main alone when present.
 */
export function planOrdered(
  input: PoolRoutingInput & {
    /** `roster` keeps the roster order (the menu's `ordered` mode). */
    placement: OrderedPlacement
    /** Local callers omit this to use row `main`; vault callers pass vaultMainRouteId, including null when absent. */
    mainId?: string | null
    /** False sends the request to one account only (see the no-replay gate); unset means true. */
    replayable?: boolean
  },
): OrderedPlan {
  const replayable = input.replayable !== false
  const mainId =
    input.mainId === undefined ? FORMER_MAIN_ID : (input.mainId ?? '')
  const placement = replayable ? input.placement : 'main-first'
  const route = routeOrdered({
    rows: input.rows,
    placement,
    formerMainId: mainId,
    killswitch: input.killswitch,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    now: input.now,
    requestPull: input.requestPull,
  })
  const ids = orderForPlacement(
    input.rows.map((row) => row.id),
    placement,
    mainId,
  )
  const confirmed = new Set(
    route.admission.refused
      .filter(
        (refusal) =>
          isConfirmedExhaustion(refusal) &&
          input.killswitch.get(refusal.id) !== false,
      )
      .map((refusal) => refusal.id),
  )
  const lastPath = ids.filter((id) => confirmed.has(id))
  const tiers = creditsTiers(input.rows, input, route.admission)
  const free = route.order.filter((id) => tiers.free.has(id))
  // Credits rows in placement order, whatever their place in the roster
  // relative to rows that hold no credits.
  const credits = ids.filter((id) => tiers.credits.includes(id))

  if (!replayable) {
    // The gate keeps main whatever its tier; without main, free quota comes
    // before credits and credits before the last path.
    const hasMain = ids.includes(mainId)
    const target = hasMain
      ? mainId
      : (free[0] ?? credits[0] ?? route.order[0] ?? lastPath[0])
    if (target !== undefined && route.order.includes(target))
      return { kind: 'send', order: [target], lastPath: false }
    if (target !== undefined && credits.includes(target))
      return { kind: 'send', order: [target], lastPath: false }
    if (target !== undefined && confirmed.has(target))
      return { kind: 'send', order: [target], lastPath: true }
    return {
      kind: 'block',
      block: hasMain
        ? blockFor(mainId, route.admission, input.killswitch)
        : routeBlock(ids, route.admission, input.killswitch),
    }
  }

  if (free.length > 0) return { kind: 'send', order: free, lastPath: false }
  // No free quota: credits rows first, then whatever today's last path would
  // try (rows the library keeps for spent credit budgets, else every row
  // confirmed exhausted), in case a credits row is refused after all.
  if (credits.length > 0) {
    const rest = route.order.length > 0 ? route.order : lastPath
    return {
      kind: 'send',
      order: [...credits, ...rest.filter((id) => !credits.includes(id))],
      lastPath: false,
    }
  }
  if (route.order.length > 0)
    return { kind: 'send', order: route.order, lastPath: false }
  if (lastPath.length > 0)
    return { kind: 'send', order: lastPath, lastPath: true }
  return {
    kind: 'block',
    block: routeBlock(ids, route.admission, input.killswitch),
  }
}

/**
 * Admission for one sticky-balanced request, as the pin ledger and the
 * response-time break decision read it.
 */
export interface StickyAdmission {
  /** Each row's quota as admission projected it (a refused row's own projection otherwise). */
  projections: ReadonlyMap<string, ProjectedQuota>
  /** Rows a rate-limit mark or refresh backoff keeps from this request. */
  excluded: ReadonlySet<string>
}

export function admitSticky(input: PoolRoutingInput): StickyAdmission {
  const admission = admit({
    rows: input.rows,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    now: input.now,
    requestPull: input.requestPull,
  })
  const projections = new Map<string, ProjectedQuota>()
  for (const row of input.rows) projections.set(row.id, projectQuota(row.quota))
  for (const row of admission.admitted) {
    if (row.projection) projections.set(row.id, row.projection)
  }
  return {
    projections,
    excluded: new Set(admission.excluded.map((entry) => entry.id)),
  }
}

/** What sticky routing needs beyond the routing input. */
export interface StickyRouteOptions {
  requestBytes: number
  /** Reserve percent per window label for one row: its killswitch thresholds. */
  reservePercent: (id: string) => Readonly<Record<string, number>>
  resetCredits: (id: string) => number | undefined
  onEmptyWeightedSet?: () => void
}

/**
 * The library's sticky routing over the routing input. A pin moves when its
 * row is confirmed unable to serve (a spent window with a future reset, a
 * spent credit budget, or a killswitch verdict) and stays while its row only
 * waits for a reading or is briefly excluded. The killswitch verdict is fed
 * for every reading, stale or fresh, as the ordered modes and the placement
 * of new sessions use it: a row below its floor is never spent on.
 */
function routePoolSticky(
  input: PoolRoutingInput,
  options: StickyRouteOptions,
  extra: {
    pin?: string
    exclude?: ReadonlySet<string>
    pendingBytes?: ReadonlyMap<string, number>
  },
): StickyRoute {
  const exclude = extra.exclude
  const rows = exclude
    ? input.rows.filter((row) => !exclude.has(row.id))
    : input.rows
  const resetCredits = new Map<string, number>()
  for (const row of rows) {
    const credits = options.resetCredits(row.id)
    if (credits !== undefined) resetCredits.set(row.id, credits)
  }
  return routeSticky({
    rows,
    now: input.now,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    requestPull: input.requestPull,
    killswitch: input.killswitch,
    requestBytes: options.requestBytes,
    ...(extra.pendingBytes ? { pendingBytes: extra.pendingBytes } : {}),
    rowReservePercent: (row) => options.reservePercent(row.id),
    refusedPinPolicy: 'move-on-confirmed-exhaustion',
    resetCreditsApplicable: resetCredits,
    ...(extra.pin === undefined ? {} : { pin: { accountId: extra.pin } }),
    ...(options.onEmptyWeightedSet
      ? { onEmptyWeightedSet: options.onEmptyWeightedSet }
      : {}),
  })
}

/**
 * Places a session that holds no usable pin: the row the library routes a
 * pinless request to, leaving out `exclude`, weighed by the bytes other
 * sessions committed to each row. When no row has free quota, the first row
 * in roster order that can serve on prepaid credits takes the session before
 * any row the library would place on its last path. Undefined when no row is
 * admissible.
 */
export function selectStickyRow(
  input: PoolRoutingInput,
  options: StickyRouteOptions,
  exclude: ReadonlySet<string>,
  pendingBytes: ReadonlyMap<string, number>,
): StickySelection | undefined {
  const route = routePoolSticky(input, options, { exclude, pendingBytes })
  const rows = input.rows.filter((row) => !exclude.has(row.id))
  const tiers = creditsTiers(rows, input, route.admission)
  // With no pin passed in, the library never dispatches by pin.
  const selected =
    route.outcome === 'dispatch' && route.source !== 'pin'
      ? {
          accountId: route.accountId,
          source: route.source,
          ...(route.quotaCheckedAt === undefined
            ? {}
            : { quotaCheckedAt: route.quotaCheckedAt }),
        }
      : undefined
  if (selected && tiers.free.has(selected.accountId)) return selected
  const credits = tiers.credits[0]
  if (credits === undefined) return selected
  const checkedAt = projectQuota(
    rows.find((row) => row.id === credits)?.quota,
  ).checkedAt
  return {
    accountId: credits,
    source: 'mode-fallback',
    ...(checkedAt === undefined ? {} : { quotaCheckedAt: checkedAt }),
  }
}

/**
 * What a session pinned to row `id` does with this request.
 *
 * - `serve`: the pinned row serves.
 * - `move`: the row is confirmed unable to serve (killed, a spent window, a
 *   spent credit budget) and another row can, so the session moves for good.
 *   A row serving on prepaid credits moves too once another row has free
 *   quota, and a spent row moves to a credits row when no row has free quota.
 * - `detour`: the row's quota is not known yet, so this one request goes
 *   elsewhere and the pin stays, to be used again once a reading arrives.
 * - `last-path`: no other row can serve and the pinned row is refused only
 *   as confirmed exhausted (not killed). openai-auth still sends to it: the
 *   reading may be stale and the provider has the final say. The library
 *   keeps the pin here but dispatches nothing, so this rule is openai-auth's.
 * - `none`: nothing can serve; the request is routed like an unpinned one.
 */
export type PinnedRowRoute =
  | { kind: 'serve' }
  | { kind: 'move'; reason: 'killswitch' | 'exhausted' }
  | { kind: 'detour' }
  | { kind: 'last-path' }
  | { kind: 'none' }

export function routePinnedRow(
  input: PoolRoutingInput,
  options: StickyRouteOptions,
  id: string,
): PinnedRowRoute {
  const killed = input.killswitch.get(id) === false
  const move = {
    kind: 'move',
    reason: killed ? 'killswitch' : 'exhausted',
  } as const
  const route = routePoolSticky(input, options, { pin: id })
  const tiers = creditsTiers(input.rows, input, route.admission)
  const onCredits = tiers.credits.includes(id)
  const othersOnCredits = tiers.credits.some((other) => other !== id)
  if (route.outcome === 'dispatch') {
    // The library only sends to a row it admitted. When that row has no free
    // quota (the library's last path for spent credit budgets), credits come
    // first: a credits pin keeps serving, any other pin moves to credits.
    const toLastPath = !tiers.free.has(route.accountId)
    if (route.pin.action === 'assign') {
      if (toLastPath && onCredits) return { kind: 'serve' }
      return move
    }
    if (route.accountId !== id) return { kind: 'detour' }
    if (toLastPath && othersOnCredits) return move
    return { kind: 'serve' }
  }
  const refusal = route.admission.refused.find((entry) => entry.id === id)
  const confirmed =
    killed || (refusal !== undefined && isConfirmedExhaustion(refusal))
  // No row has free quota. A credits pin serves on its credits; a pin
  // confirmed unable to serve moves to a credits row; a pin still waiting
  // for a reading keeps its pin and this one request goes to credits.
  if (onCredits) return { kind: 'serve' }
  if (othersOnCredits) return confirmed ? move : { kind: 'detour' }
  if (!killed && refusal && isConfirmedExhaustion(refusal))
    return { kind: 'last-path' }
  return { kind: 'none' }
}

/** Whether a sticky session must leave row `id`, judged on its current quota. */
export function stickyBreak(
  input: PoolRoutingInput,
  sticky: StickyAdmission,
  id: string,
  status?: number,
): StickyBreakDecision {
  const killswitchPasses = input.killswitch.get(id)
  return decideStickyBreak({
    quota: sticky.projections.get(id),
    now: input.now,
    ...(status === undefined ? {} : { status }),
    ...(killswitchPasses === undefined ? {} : { killswitchPasses }),
  })
}
