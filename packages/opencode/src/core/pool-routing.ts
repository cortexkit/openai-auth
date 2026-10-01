// Routing decisions for a migrated install, made with the account pool's
// routing library (`@cortexkit/common-auth/routing`).
//
// The library decides which rows may serve a request (admission) and in what
// order (`routeOrdered`), places sticky sessions (`selectStickyCandidate`)
// and classifies when a sticky session must leave its row
// (`decideStickyBreak`). openai-auth supplies what the library leaves to its
// caller: rate-limit marks, refresh backoff, killswitch verdicts, reserve
// percentages, reset credits and the session pin ledger.
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
// - The no-replay gate. A request that cannot be sent twice (anything but a
//   buffered POST to `/responses`) goes to one account only, row `main`
//   (the main account, as on a legacy install), and is never retried on
//   another: a second send could repeat work the provider already did.

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
  type StickyBreakDecision,
  type StickySelectionCandidate,
} from '@cortexkit/common-auth/routing'

/** The row the migration moved the main account into. */
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
 * `placement` puts the former main row first or last; a non-replayable
 * request always uses main-first and is sent to one account.
 */
export function planOrdered(
  input: PoolRoutingInput & {
    placement: Extract<OrderedPlacement, 'main-first' | 'fallback-first'>
    replayable: boolean
  },
): OrderedPlan {
  const placement = input.replayable ? input.placement : 'main-first'
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

  if (!input.replayable) {
    const hasMain = ids.includes(FORMER_MAIN_ID)
    const target = hasMain ? FORMER_MAIN_ID : (route.order[0] ?? lastPath[0])
    if (target !== undefined && route.order.includes(target))
      return { kind: 'send', order: [target], lastPath: false }
    if (target !== undefined && confirmed.has(target))
      return { kind: 'send', order: [target], lastPath: true }
    return {
      kind: 'block',
      block: hasMain
        ? blockFor(FORMER_MAIN_ID, route.admission, input.killswitch)
        : routeBlock(ids, route.admission, input.killswitch),
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

/** Admission for one sticky-balanced request, indexed for the placement steps. */
export interface StickyAdmission {
  admission: AdmissionResult
  projections: ReadonlyMap<string, ProjectedQuota>
  admitted: ReadonlySet<string>
  refused: ReadonlyMap<string, AdmissionRefusal>
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
    admission,
    projections,
    admitted: new Set(admission.admitted.map((row) => row.id)),
    refused: new Map(admission.refused.map((refusal) => [refusal.id, refusal])),
    excluded: new Set(admission.excluded.map((entry) => entry.id)),
  }
}

/**
 * The sticky placement candidates: admitted rows, minus `exclude`, with the
 * caller's reserves, reset credits and killswitch verdicts. A killed row
 * stays in the list so the library's selector can refuse it in both of its
 * branches, as it does for openai-auth's own roster.
 */
export function stickyCandidates(
  input: PoolRoutingInput,
  sticky: StickyAdmission,
  options: {
    exclude: ReadonlySet<string>
    reservePercent: (id: string) => Readonly<Record<string, number>>
    resetCredits: (id: string) => number | undefined
  },
): StickySelectionCandidate[] {
  const out: StickySelectionCandidate[] = []
  input.rows.forEach((row, configuredOrder) => {
    if (!sticky.admitted.has(row.id) || options.exclude.has(row.id)) return
    const killswitchPasses = input.killswitch.get(row.id)
    const credits = options.resetCredits(row.id)
    out.push({
      accountId: row.id,
      quota: sticky.projections.get(row.id),
      reservePercent: options.reservePercent(row.id),
      configuredOrder,
      ...(credits === undefined ? {} : { resetCreditsApplicable: credits }),
      ...(killswitchPasses === undefined ? {} : { killswitchPasses }),
    })
  })
  return out
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

/**
 * How a pinned row admission did not admit is treated. `migrate`: the
 * account is confirmed unable to serve (exhausted, spent budget, killed), so
 * the session moves for good. `detour`: its quota is unknown, so this one
 * request goes elsewhere and the pin stays, to be used again once a reading
 * arrives (the library's rule for a refused pin).
 */
export function pinnedRowRefusal(
  input: PoolRoutingInput,
  sticky: StickyAdmission,
  id: string,
): 'serve' | 'migrate' | 'detour' {
  if (input.killswitch.get(id) === false) return 'migrate'
  if (sticky.admitted.has(id)) return 'serve'
  const refusal = sticky.refused.get(id)
  if (refusal && isConfirmedExhaustion(refusal)) return 'migrate'
  return 'detour'
}
