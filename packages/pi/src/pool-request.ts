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

import { isQuotaMap } from '@cortexkit/common-auth/quota'
import {
  nextOrderedAttempt,
  type OrderedAttempt,
  type RoutingRow,
} from '@cortexkit/common-auth/routing'
import {
  type AccountStorage,
  getFallbackStatuses,
  getKillswitchThresholdsForAccount,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  quotaSnapshotPassesPolicy,
  type RoutingMode,
} from '@cortexkit/openai-auth-core/internal'

import { windowsFromQuotaMap } from '@cortexkit/openai-auth-core/pool-quota'
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
} from '@cortexkit/openai-auth-core/pool-routing'
import type { PiPinPlacement } from './routing.ts'

/** One account a request may be sent with. */
export interface RouteAccount {
  id: string
  /** The account's ChatGPT identity, when known. */
  identity?: string
  /** Its pool quota map; undefined while no reading has arrived. */
  quota?: unknown
  /** The bearer to send with now, or undefined when it holds no usable one. */
  token: string | undefined
}

/** What one attempt reports back: the HTTP status, when a response arrived. */
export interface RouteAttempt {
  status?: number
}

export interface PiRouteContext<A extends RouteAttempt> {
  /** The routable accounts as they are now; read again after each response. */
  accounts: () => readonly RouteAccount[]
  /** The settings this request reads (killswitch, fallback statuses). */
  storage: AccountStorage | null
  mode: RoutingMode
  sessionId: string | undefined
  /** The request's size, which sticky placement weighs sessions by. */
  requestBytes: number
  now: () => number
  /** Account id to the time it may be tried again, for accounts that must sit out. */
  refreshBackoff: (accounts: readonly RouteAccount[]) => Map<string, number>
  /** Asks for a quota poll of an account admission refused for want of a reading. */
  requestPull: (id: string) => void
  /** Sends the request with one account's token. */
  send(account: RouteAccount, token: string): Promise<A>
  /** The session pin ledger: decides (and, when asked, records) a session's pin. */
  placePin(input: PiPinPlacement): { accountId: string } | undefined
  log?: { debug(message: string, meta?: Record<string, unknown>): void }
}

export type PiRouteResult<A> =
  | { kind: 'sent'; attempt: A; accountId: string }
  | { kind: 'blocked'; block: PoolBlock }

/**
 * Pool rows that may serve beside Pi's login: enabled OAuth rows holding a
 * credential that pass the quota policy (`quota.minimumRemaining`,
 * `failClosedOnUnknownQuota`), as a fallback account always had to. A row
 * holding the same ChatGPT account as Pi's login is left out: that account
 * already serves as `main`, and is refreshed by Pi alone.
 */
export function routablePoolRows<
  R extends {
    id: string
    type: 'oauth' | 'api'
    candidate: boolean
    identity?: string
    quota?: unknown
    credential?: { type: 'oauth' | 'api' }
  },
>(
  rows: readonly R[],
  storage: AccountStorage | null,
  now: number,
  mainIdentity: string | undefined,
): R[] {
  return rows.filter((row) => {
    if (!row.candidate || row.type !== 'oauth') return false
    if (row.credential?.type !== 'oauth') return false
    // Pi's login is routed as `main`; a pool row may not take its id.
    if (row.id === FORMER_MAIN_ID) return false
    if (mainIdentity && row.identity === mainIdentity) return false
    return quotaSnapshotPassesPolicy(
      windowsFromQuotaMap(row.quota),
      storage,
      now,
    )
  })
}

function routingInput<A extends RouteAttempt>(
  ctx: PiRouteContext<A>,
  accounts: readonly RouteAccount[],
): PoolRoutingInput {
  const now = ctx.now()
  const killswitch = new Map<string, boolean>()
  if (isKillswitchEnabled(ctx.storage)) {
    for (const account of accounts) {
      killswitch.set(
        account.id,
        killswitchPassesPolicy(
          windowsFromQuotaMap(account.quota),
          ctx.storage,
          account.id === FORMER_MAIN_ID ? undefined : account.id,
          now,
        ),
      )
    }
  }
  const rows: RoutingRow[] = accounts.map((account) => ({
    id: account.id,
    kind: 'oauth',
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
  const accounts = ctx.accounts()
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
  const placement =
    ctx.mode === 'fallback-first'
      ? 'fallback-first'
      : // `ordered` is plain roster order; anything else older readers
        // knew routes the main account first.
        ctx.mode === 'ordered'
        ? 'roster'
        : 'main-first'
  const plan = planOrdered({ ...routingInput(ctx, accounts), placement })
  if (plan.kind === 'block') {
    ctx.log?.debug('pool admission blocked the request', {
      reason: plan.block.reason,
    })
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
  let last: { attempt: A; accountId: string } | undefined
  for (;;) {
    const id = nextOrderedAttempt(plan.order, attempts, retryStatuses)
    const account = id === undefined ? undefined : byId.get(id)
    const token = account?.token
    if (!account || !token) break
    const attempt = await ctx.send(account, token)
    last = { attempt, accountId: account.id }
    attempts.push({
      id: account.id,
      ...(attempt.status !== undefined ? { status: attempt.status } : {}),
    })
  }
  if (last) return { kind: 'sent', ...last }
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
        select: (pendingBytes) =>
          selectStickyRow(input, options, excluded, pendingBytes),
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
  const token = account?.token
  if (!account || !token) return undefined
  let attempt = await ctx.send(account, token)

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
    if (after.action === 'migrate') {
      const from = id
      if (migrate(after.reason) && id !== from) {
        const replacement = current.find((candidate) => candidate.id === id)
        const replacementToken = replacement?.token
        if (replacement && replacementToken) {
          attempt = await ctx.send(replacement, replacementToken)
          account = replacement
        } else {
          id = from
        }
      }
    }
  }
  return { kind: 'sent', attempt, accountId: account.id }
}
