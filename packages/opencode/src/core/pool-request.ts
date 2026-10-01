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
// The OpenAI accounts the Claustrum vault serves this host (`ctx.vault`) are
// routed beside the pool rows, through the same admission and modes. A vault
// account holds no token: each send asks the vault for one. A pool row
// signing in as a ChatGPT account the vault holds is left out, so one account
// has one owner.

import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import { isQuotaMap } from '@cortexkit/common-auth/quota'
import {
  nextOrderedAttempt,
  type OrderedAttempt,
  type RoutingRow,
  type StickySelection,
} from '@cortexkit/common-auth/routing'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  getFallbackStatuses,
  getKillswitchThresholdsForAccount,
  isKillswitchEnabled,
  isShieldedMainRow,
  isTombstoned,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
  quotaSnapshotPassesPolicy,
  type RoutingMode,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolAccountSource } from './pool-account-source'
import { windowsFromQuotaMap } from './pool-quota'
import {
  admitSticky,
  FORMER_MAIN_ID,
  orderedPlacement,
  type PoolBlock,
  type PoolRoutingInput,
  planOrdered,
  routePinnedRow,
  type StickyAdmission,
  type StickyRouteOptions,
  selectStickyRow,
  stickyBreak,
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

/** The vault accounts, as a request routes them (see `OpenAiVault`). */
export interface PoolVaultRoutes {
  /** The vault accounts that may route now. */
  routes(): ReadonlyArray<{
    id: string
    kind: 'oauth' | 'api-key'
    identity?: string
    quota?: unknown
  }>
  /** Every ChatGPT account the vault holds for this host. */
  identities(): ReadonlySet<string>
  /**
   * Sends on a vault account with the token the vault serves for this
   * attempt; undefined when the vault refused before anything was sent.
   */
  send(
    id: string,
    dispatch: (token: string, attempt: QuotaReceipt) => Promise<Response>,
  ): Promise<Response | undefined>
  /** Asks for a quota reading of a vault account admission refused for want of one. */
  requestReading(id: string): void
}

export interface PoolRequestContext {
  source: PoolAccountSource
  /** The vault accounts; absent while this host has none. */
  vault?: PoolVaultRoutes
  /** The legacy settings this request reads (routing, killswitch, fallback statuses). */
  storage: AccountStorage | null
  mode: RoutingMode
  sessionId: string | undefined
  /** The buffered request body, when there is one. */
  body: string | undefined
  replayable: boolean
  now: () => number
  /** Sends the request with one account's token; rejects on a transport failure or abort. */
  send(target: PoolTarget, token: string): Promise<Response>
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
  blocked(block: PoolBlock, quotas: PoolBlockQuotas): Response
  /** Reset credits an account holds, for sticky placement's tie-break. */
  resetCredits(id: string): number | undefined
  /** Whether this send failure is the caller aborting the request. */
  isAbort(error: unknown): boolean
  log: {
    debug(message: string, meta?: Record<string, unknown>): void
  }
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
 * one.
 */
export function routableRows(
  rows: readonly PoolRow[],
  storage: AccountStorage | null,
  now: number,
  vaultIdentities: ReadonlySet<string> = new Set(),
): PoolRow[] {
  return rows.filter((row) => {
    if (!row.candidate || row.type !== 'oauth') return false
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

/** The accounts one request may be sent with now: the routable pool rows, then the vault's. */
function currentTargets(ctx: PoolRequestContext): PoolTarget[] {
  const vaultIdentities = ctx.vault?.identities() ?? new Set<string>()
  const rows = routableRows(
    ctx.source.peek().rows,
    ctx.storage,
    ctx.now(),
    vaultIdentities,
  )
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
    ...(ctx.vault?.routes() ?? []).map(
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
  const killswitch = new Map<string, boolean>()
  if (isKillswitchEnabled(ctx.storage)) {
    for (const target of targets) {
      killswitch.set(
        target.id,
        killswitchPassesPolicy(
          windowsFromQuotaMap(target.quota),
          ctx.storage,
          target.id === FORMER_MAIN_ID ? undefined : target.id,
          now,
        ),
      )
    }
  }
  const routingRows: RoutingRow[] = targets.map((target) => ({
    id: target.id,
    kind: target.kind,
    ...(isQuotaMap(target.quota) ? { quota: target.quota } : {}),
  }))
  const rows = poolRowsOf(targets)
  const vaultIds = new Set(
    targets.filter((target) => !target.row).map((target) => target.id),
  )
  return {
    rows: routingRows,
    now,
    rateLimitMarks: ctx.source.rateLimitMarks(rows),
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
    const response = await ctx.send(target, token)
    ctx.recordQuota(response, target, token, attempt)
    return response
  })
}

/** Reads the current rows, readies their tokens, and routes one request. */
export async function servePoolRequest(
  ctx: PoolRequestContext,
): Promise<PoolRequestResult> {
  await ctx.source.current()
  await ctx.source.prepareTokens(ctx.source.peek().rows, ctx.storage)
  const rows = currentTargets(ctx)

  if (
    ctx.mode === 'sticky-balanced' &&
    ctx.sessionId &&
    ctx.replayable &&
    ctx.body !== undefined
  ) {
    const sticky = await serveSticky(ctx, rows, ctx.sessionId, ctx.body)
    if (sticky) return sticky
  }
  return serveOrdered(ctx, rows)
}

async function serveOrdered(
  ctx: PoolRequestContext,
  rows: readonly PoolTarget[],
): Promise<PoolRequestResult> {
  const placement = orderedPlacement(ctx.mode)
  const plan = planOrdered({
    ...routingInput(ctx, rows),
    placement,
    replayable: ctx.replayable,
  })
  if (plan.kind === 'block') {
    ctx.log.debug('pool admission blocked the request', {
      pid: process.pid,
      reason: plan.block.reason,
    })
    return {
      response: ctx.blocked(plan.block, blockQuotas(rows)),
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
  const retryStatuses = getFallbackStatuses(ctx.storage)
  const attempts: OrderedAttempt[] = []
  // Accounts that had nothing to send with (a vault account the vault would
  // not serve, a row without a usable token). Nothing reached the provider,
  // so the next account in the order is tried as if this one were not there.
  const unsent = new Set<string>()
  let last: PoolRequestResult | undefined
  for (;;) {
    const id = nextOrderedAttempt(
      plan.order.filter((candidate) => !unsent.has(candidate)),
      attempts,
      retryStatuses,
    )
    const row = id === undefined ? undefined : byId.get(id)
    if (!row) break
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
      unsent.add(row.id)
      continue
    }
    // Only the response returned keeps its body; an earlier one is dropped
    // once a later attempt has produced a replacement.
    last?.response.body?.cancel().catch(() => {})
    last = { response, servedId: row.id }
    attempts.push({ id: row.id, status: response.status })
  }
  if (last) return last
  return {
    response: ctx.blocked({ reason: 'no-credential' }, blockQuotas(rows)),
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
        select: (pendingBytes) =>
          selectStickyRow(input, options, excluded, pendingBytes),
        persist,
      })
    }

  let place = placer(routing, sticky)
  const assignment = place([], true)
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
  let response = await sendTo(ctx, row)
  if (!response) return undefined

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
    if (after.action === 'migrate') {
      const from = id
      if (migrate(after.reason) && id !== from) {
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
  return { response, servedId: row.id }
}
