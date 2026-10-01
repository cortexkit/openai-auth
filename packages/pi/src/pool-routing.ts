// Routing decisions for a Pi request, made with the account pool's routing
// library (`@cortexkit/common-auth/routing`).
//
// The routed rows are Pi's own `openai-codex` login, routed as row `main`
// (see `main-account.ts`), and the rows of Pi's account pool, the fallbacks.
//
// The library decides which rows may serve a request (admission) and in what
// order (`routeOrdered`), routes sticky sessions (`routeSticky`: whether a
// session's pin serves, moves or is served around, and where a session is
// placed) and classifies when a sticky session must leave its row after a
// response (`decideStickyBreak`). openai-auth supplies what the library
// leaves to its caller: refresh backoff, killswitch verdicts, per-account
// reserve percentages (the killswitch thresholds) and the session pin ledger.
//
// One openai-auth rule sits on top of the library's result here, because the
// library has no input that expresses it: the last path. When admission
// leaves no row, openai-auth still sends to an account it knows is exhausted
// (a window at 100% or a spent credit budget) rather than deny the request
// without asking the provider: the reading may be stale and the provider has
// the final say. The library keeps that rule only for spent credit budgets,
// and only while some row survives its first stage. Rows refused for UNKNOWN
// quota never take the last path: unknown quota blocks.
//
// The OpenCode package's `core/pool-routing.ts` makes the same decisions; it
// also has a no-replay gate, which Pi does not need: a Pi request is only
// ever sent again after its first attempt failed before streaming anything.

import { type ProjectedQuota, projectQuota } from '@cortexkit/common-auth/quota'
import {
  type AdmissionRefusal,
  type AdmissionResult,
  admit,
  decideStickyBreak,
  type OrderedPlacement,
  orderForPlacement,
  type RoutingRow,
  routeOrdered,
  routeSticky,
  type StickyBreakDecision,
  type StickyRoute,
  type StickySelection,
} from '@cortexkit/common-auth/routing'

/** The id Pi's own login is routed under: first in main-first, last in fallback-first. */
export const FORMER_MAIN_ID = 'main'

/**
 * Retry-After for a request refused because no account has a quota reading
 * yet. The refusal itself asked for the readings, and a poll takes about a
 * second, so the client is told to come back shortly.
 */
export const POOL_QUOTA_UNKNOWN_RETRY_SECONDS = 5

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
  requestPull: (id: string) => void
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
 * The accounts to try, in order, for `main-first` and `fallback-first`.
 * `placement` puts row `main` (Pi's login) first or last.
 */
export function planOrdered(
  input: PoolRoutingInput & {
    placement: Extract<OrderedPlacement, 'main-first' | 'fallback-first'>
  },
): OrderedPlan {
  const placement = input.placement
  const route = routeOrdered({
    rows: input.rows,
    placement,
    formerMainId: FORMER_MAIN_ID,
    killswitch: input.killswitch,
    rateLimitMarks: input.rateLimitMarks,
    refreshBackoff: input.refreshBackoff,
    now: input.now,
    requestPull: input.requestPull,
  })
  const ids = orderForPlacement(
    input.rows.map((row) => row.id),
    placement,
    FORMER_MAIN_ID,
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
 * sessions committed to each row. Undefined when no row is admissible.
 */
export function selectStickyRow(
  input: PoolRoutingInput,
  options: StickyRouteOptions,
  exclude: ReadonlySet<string>,
  pendingBytes: ReadonlyMap<string, number>,
): StickySelection | undefined {
  const route = routePoolSticky(input, options, { exclude, pendingBytes })
  // With no pin passed in, the library never dispatches by pin.
  if (route.outcome !== 'dispatch' || route.source === 'pin') return undefined
  return {
    accountId: route.accountId,
    source: route.source,
    ...(route.quotaCheckedAt === undefined
      ? {}
      : { quotaCheckedAt: route.quotaCheckedAt }),
  }
}

/**
 * What a session pinned to row `id` does with this request.
 *
 * - `serve`: the pinned row serves.
 * - `move`: the row is confirmed unable to serve (killed, a spent window, a
 *   spent credit budget) and another row can, so the session moves for good.
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
  const route = routePoolSticky(input, options, { pin: id })
  if (route.outcome === 'dispatch') {
    if (route.pin.action === 'assign')
      return { kind: 'move', reason: killed ? 'killswitch' : 'exhausted' }
    return route.accountId === id ? { kind: 'serve' } : { kind: 'detour' }
  }
  const refusal = route.admission.refused.find((entry) => entry.id === id)
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
