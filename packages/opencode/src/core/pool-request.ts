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

export interface PoolRequestContext {
  source: PoolAccountSource
  /** The legacy settings this request reads (routing, killswitch, fallback statuses). */
  storage: AccountStorage | null
  mode: RoutingMode
  sessionId: string | undefined
  /** The buffered request body, when there is one. */
  body: string | undefined
  replayable: boolean
  now: () => number
  /** Sends the request with one row's token; rejects on a transport failure or abort. */
  send(row: PoolRow, token: string): Promise<Response>
  /** Records the quota a response carried for the row that served it. */
  recordQuota(response: Response, row: PoolRow, token: string): void
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
): PoolRow[] {
  return rows.filter((row) => {
    if (!row.candidate || row.type !== 'oauth') return false
    if (row.credential?.type !== 'oauth') return false
    if (row.id === FORMER_MAIN_ID) return true
    if (isShieldedMainRow(storage, { accountId: row.identity })) return false
    return quotaSnapshotPassesPolicy(
      windowsFromQuotaMap(row.quota),
      storage,
      now,
    )
  })
}

function routingInput(
  ctx: PoolRequestContext,
  rows: readonly PoolRow[],
): PoolRoutingInput {
  const now = ctx.now()
  const killswitch = new Map<string, boolean>()
  if (isKillswitchEnabled(ctx.storage)) {
    for (const row of rows) {
      killswitch.set(
        row.id,
        killswitchPassesPolicy(
          windowsFromQuotaMap(row.quota),
          ctx.storage,
          row.id === FORMER_MAIN_ID ? undefined : row.id,
          now,
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
    now,
    rateLimitMarks: ctx.source.rateLimitMarks(rows),
    refreshBackoff: ctx.source.refreshBackoffFor(rows),
    killswitch,
    requestPull: (id) => ctx.source.requestReading(id),
  }
}

function blockQuotas(rows: readonly PoolRow[]): PoolBlockQuotas {
  const main = rows.find((row) => row.id === FORMER_MAIN_ID)
  return {
    main: main ? windowsFromQuotaMap(main.quota) : undefined,
    fallbacks: rows
      .filter((row) => row.id !== FORMER_MAIN_ID)
      .map((row) => {
        const quota = windowsFromQuotaMap(row.quota)
        return { accountId: row.id, ...(quota ? { quota } : {}) }
      }),
  }
}

/** Reads the current rows, readies their tokens, and routes one request. */
export async function servePoolRequest(
  ctx: PoolRequestContext,
): Promise<PoolRequestResult> {
  await ctx.source.current()
  await ctx.source.prepareTokens(ctx.source.peek().rows, ctx.storage)
  const rows = routableRows(ctx.source.peek().rows, ctx.storage, ctx.now())

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
  rows: readonly PoolRow[],
): Promise<PoolRequestResult> {
  const placement =
    ctx.mode === 'fallback-first' ? 'fallback-first' : 'main-first'
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
  let last: PoolRequestResult | undefined
  for (;;) {
    const id = nextOrderedAttempt(plan.order, attempts, retryStatuses)
    const row = id === undefined ? undefined : byId.get(id)
    const token = row ? ctx.source.usableToken(row) : undefined
    if (!row || !token) break
    let response: Response
    try {
      response = await ctx.send(row, token)
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
    ctx.recordQuota(response, row, token)
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
  rows: readonly PoolRow[],
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
    // Should the ledger find no other row after all, a pinned row that is
    // only exhausted is still sent to (see `last-path`); a row the
    // killswitch blocks never is.
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
  let token = row ? ctx.source.usableToken(row) : undefined
  if (!row || !token) return undefined
  let response = await ctx.send(row, token)
  ctx.recordQuota(response, row, token)

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 429
  ) {
    // The response's own quota has just been recorded, so judge the break on
    // the rows as they are now.
    const current = routableRows(ctx.source.peek().rows, ctx.storage, ctx.now())
    routing = routingInput(ctx, current)
    sticky = admitSticky(routing)
    place = placer(routing, sticky)
    const after = stickyBreak(routing, sticky, id, response.status)
    if (after.action === 'migrate') {
      const from = id
      if (migrate(after.reason) && id !== from) {
        const replacement = current.find((candidate) => candidate.id === id)
        const replacementToken = replacement
          ? ctx.source.usableToken(replacement)
          : undefined
        if (replacement && replacementToken) {
          const previous = response
          response = await ctx.send(replacement, replacementToken)
          previous.body?.cancel().catch(() => {})
          row = replacement
          token = replacementToken
          ctx.recordQuota(response, row, token)
        } else {
          id = from
        }
      }
    }
  }
  return { response, servedId: row.id }
}
