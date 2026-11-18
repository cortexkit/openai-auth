import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import {
  type AskRoutingInput,
  askRouting,
  type RoutingRefusal,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import { windowsFromQuotaMap } from './pool-quota'
import { type PoolRoutingInput, planOrdered } from './pool-routing'
import { type RoutingWaitInput, routingHoldWaitMaxS } from './routing-wait'
import { isRecord } from './util/record'

export interface VaultRoutingRequest {
  modelId: string
  kind: string
  retry?: boolean
}

interface VaultRoutingRoute {
  id: string
  identity?: string
  credentialId?: string
}

type VaultRoutingExhausted = Extract<
  NonNullable<AskRoutingInput['exhausted']>,
  { limitWindow: 'five_hour' | 'seven_day' }
>

export type VaultRoutingFeedback =
  | { kind: 'exhausted'; exhausted: VaultRoutingExhausted }
  | {
      kind: 'backoff'
      retryAtMs: number
      credentialId: string
      accountIdentity?: string
    }

// Hosts match error text to decide retries; never include routing's details.
export const VAULT_ROUTING_REFUSAL_MESSAGE =
  'Thalamus routing declined this request, so it was not sent.'

/** Only short selection refusals may be retried, before a first placement. */
export function vaultRoutingPlacementRetryMs(
  answer: RoutingRefusal | { holdMs: number },
): number | undefined {
  if (!('refused' in answer)) return undefined
  const { code, retryAfterSecs } = answer.refused
  if (
    code === 'account_selection_refused' &&
    typeof retryAfterSecs === 'number' &&
    retryAfterSecs > 0 &&
    retryAfterSecs <= 5
  )
    return retryAfterSecs * 1000
  return undefined
}

/** The process-global routing accessor can change after plugin load; check it each time. */
export function hasVaultRoutingAccessor(): boolean {
  try {
    return (
      typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) ===
      'function'
    )
  } catch {
    return false
  }
}

export const ROUTING_WAIT_MESSAGES = {
  account_limit: 'Waiting for the account limit to reset',
  account_free: 'Waiting for an account to come free',
  quota_reading: 'Checking account quota',
} as const

/** Routing reports are advisory and must not delay a request when reporting is unavailable or slow. */
export function startVaultRoutingWait(input: {
  sessionId: string | undefined
  reason: keyof typeof ROUTING_WAIT_MESSAGES
  now: number
  nextMs?: number
  /** Planned duration bound used only for the short-wait filter, not a wake time. */
  boundMs?: number
  attempt?: number
}): ((outcome: 'resumed' | 'cancelled' | 'abandoned') => void) | undefined {
  const boundMs =
    input.nextMs === undefined ? (input.boundMs ?? 0) : input.nextMs - input.now
  if (!input.sessionId || !hasVaultRoutingAccessor() || boundMs < 2_000)
    return undefined
  const report = {
    sessionId: input.sessionId,
    kind: 'wait' as const,
    waitId: crypto.randomUUID(),
    reason: input.reason,
    ...(input.nextMs === undefined ? {} : { nextMs: input.nextMs }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    message: ROUTING_WAIT_MESSAGES[input.reason],
  }
  reportRouting({ ...report, phase: 'start' })
  let ended = false
  return (outcome) => {
    if (ended) return
    ended = true
    reportRouting({ ...report, phase: 'end', outcome })
  }
}

/**
 * Optional routing advice can choose only accounts allowed by the routing plan
 * and the request's eligibility filter.
 * The Pi host adapter is not wired because its provider stream gives no reliable request purpose.
 */
export async function chooseVaultRouting(input: {
  vaultMode: boolean
  fresh: boolean
  sessionId: string | undefined
  request: VaultRoutingRequest | undefined
  routes: readonly VaultRoutingRoute[]
  routing: PoolRoutingInput
  eligibleIds?: readonly string[]
  continuation?: { previousId: string; exhausted: VaultRoutingExhausted }
  wait?: RoutingWaitInput
  warmAccountId?: string
}): Promise<string | RoutingRefusal | { holdMs: number } | undefined> {
  const { request, sessionId, continuation } = input
  if (
    !input.vaultMode ||
    !hasVaultRoutingAccessor() ||
    !sessionId ||
    !request?.modelId ||
    (!continuation && (!input.fresh || request.retry))
  )
    return undefined
  const plan = planOrdered({
    ...input.routing,
    rows:
      continuation && input.eligibleIds
        ? input.routing.rows.filter((row) =>
            input.eligibleIds?.includes(row.id),
          )
        : input.routing.rows,
    placement: 'roster',
    mainId: null,
  })
  if (plan.kind === 'block' && !continuation) return undefined
  const order =
    plan.kind === 'send'
      ? plan.order.filter(
          (id) => !continuation || plan.tiers[id] !== 'last-path',
        )
      : []
  const eligible = new Set(input.eligibleIds ?? order)
  const candidates = input.routes.flatMap((route) =>
    route.id !== continuation?.previousId &&
    order.includes(route.id) &&
    eligible.has(route.id) &&
    route.identity &&
    route.credentialId
      ? [
          {
            accountId: route.identity,
            credentialId: route.credentialId,
            id: route.id,
          },
        ]
      : [],
  )
  if (continuation) {
    const { accountId, credentialId } = continuation.exhausted
    // Routing must be able to name the exhausted account in a same-account hold.
    candidates.push({ accountId, credentialId, id: continuation.previousId })
  }
  if (candidates.length === 0) return undefined
  const holdWaitMaxS = routingHoldWaitMaxS({
    ...input.wait,
    sessionId,
    now: input.routing.now,
  })
  const ask = {
    sessionId,
    provider: 'openai',
    modelId: request.modelId,
    candidates,
    warmCredentialId: input.routes.find(
      (route) => route.id === input.warmAccountId,
    )?.credentialId,
    refusals: true as const,
    holdWaitMaxS,
  }
  const answer = continuation
    ? await askRouting({
        ...ask,
        mode: 'continue',
        exhausted: continuation.exhausted,
        requestId: crypto.randomUUID(),
      })
    : await askRouting(ask)
  if (!answer || 'refused' in answer) return answer
  if (answer.candidate.id !== continuation?.previousId)
    return answer.candidate.id
  if (!answer.hold) return { holdMs: 0 }
  const holdMs = answer.hold.retry_after_ms
  // A shorter wait would resend to an account routing still considers exhausted.
  if (!holdWaitMaxS || holdMs > holdWaitMaxS * 1000)
    return { refused: { code: 'account_selection_refused' } }
  return { holdMs }
}

const RATE_LIMIT_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-primary-window-minutes',
  'x-codex-primary-reset-at',
  'x-codex-secondary-used-percent',
  'x-codex-secondary-window-minutes',
  'x-codex-secondary-reset-at',
  'retry-after',
  'retry-after-ms',
] as const

export interface VaultRoutingResponse {
  status: number
  headers: Headers
  limit?: { window: string; resetAt?: number }
  body?: unknown
  quota?: unknown
  failed?: boolean
  now?: number
  backoff?: boolean
}

const USAGE_LIMIT_CODES = new Set([
  'usage_limit_reached',
  'insufficient_quota',
  'quota_exceeded',
])

function resetFromRetryAfter(
  headers: Headers,
  now: number,
): number | undefined {
  const milliseconds = headers.get('retry-after-ms')
  if (
    milliseconds?.trim() &&
    Number.isFinite(Number(milliseconds)) &&
    Number(milliseconds) >= 0
  )
    return now + Number(milliseconds)
  const value = headers.get('retry-after')
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

function providerResetAt(absolute: unknown, relative: unknown, now: number) {
  return typeof absolute === 'number' &&
    Number.isFinite(absolute) &&
    absolute > 0
    ? absolute * 1000
    : typeof relative === 'number' && Number.isFinite(relative) && relative > 0
      ? now + relative * 1000
      : undefined
}

/** Report only classified account exhaustion, never an HTTP status or error text alone. */
export function reportVaultRoutingLimit(
  sessionId: string | undefined,
  receipt: QuotaReceipt | undefined,
  limit: { window: string; resetAt?: number },
  options: Pick<VaultRoutingResponse, 'body' | 'quota' | 'now'> & {
    headers?: Headers
  } = {},
): VaultRoutingExhausted | undefined {
  if (!hasVaultRoutingAccessor() || !sessionId || !receipt?.accountIdentity)
    return undefined
  if (
    !USAGE_LIMIT_CODES.has(limit.window) &&
    !['primary', 'secondary', '5h', '7d'].includes(limit.window)
  )
    return undefined
  const body = isRecord(options.body) ? options.body : undefined
  const response = isRecord(body?.response) ? body.response : body
  const detail = isRecord(response?.error) ? response.error : response
  const failed = isRecord(response?.failed) ? response.failed : undefined
  const named =
    typeof failed?.rate_limit_reached_type === 'string'
      ? failed.rate_limit_reached_type
      : typeof detail?.rate_limit_reached_type === 'string'
        ? detail.rate_limit_reached_type
        : typeof detail?.window === 'string'
          ? detail.window
          : limit.window
  const snapshot = windowsFromQuotaMap(options.quota)
  const slot = named === 'primary' || named === 'secondary' ? named : undefined
  const minutes = slot
    ? Number(
        options.headers?.get(`x-codex-${slot}-window-minutes`) ??
          snapshot?.[slot]?.windowMinutes,
      )
    : undefined
  const window = minutes === 300 ? '5h' : minutes === 10080 ? '7d' : named
  if (window !== '5h' && window !== '7d') return undefined
  const headerReset = slot
    ? Number(options.headers?.get(`x-codex-${slot}-reset-at`)) * 1000
    : NaN
  const absolute = detail?.resets_at ?? failed?.resets_at
  const relative = detail?.resets_in_seconds ?? failed?.resets_in_seconds
  const now = options.now ?? Date.now()
  const providerReset = providerResetAt(absolute, relative, now)
  const reset = limit.resetAt ?? providerReset
  const resetsAt =
    reset !== undefined && Number.isFinite(reset) && reset > 0
      ? reset
      : Number.isFinite(headerReset) && headerReset > 0
        ? headerReset
        : options.headers
          ? resetFromRetryAfter(options.headers, now)
          : undefined
  reportRouting({
    sessionId,
    accountId: receipt.accountIdentity,
    credentialId: receipt.credentialId,
    outcome: 'exhausted',
    window,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  })
  return {
    accountId: receipt.accountIdentity,
    credentialId: receipt.credentialId,
    limitWindow: window === '5h' ? 'five_hour' : 'seven_day',
    observedAtMs: now,
    ...(resetsAt !== undefined ? { resetsAtMs: resetsAt } : {}),
  }
}

/** Classify a provider response without forwarding its body or error message. */
export function reportVaultRouting(
  sessionId: string | undefined,
  receipt: QuotaReceipt | undefined,
  response: VaultRoutingResponse,
): VaultRoutingFeedback | undefined {
  if (!sessionId || !receipt || response.failed || !hasVaultRoutingAccessor())
    return
  const { status, headers } = response
  const identity = receipt.accountIdentity
    ? {
        sessionId,
        accountId: receipt.accountIdentity,
        credentialId: receipt.credentialId,
      }
    : undefined
  if (status === 429 || status === 403) {
    const envelope = isRecord(response.body) ? response.body : undefined
    const body = isRecord(envelope?.response) ? envelope.response : envelope
    const detail = isRecord(body?.error) ? body.error : body
    const reason = response.limit?.window
    const code = typeof detail?.code === 'string' ? detail.code : undefined
    const type =
      typeof detail?.type === 'string' &&
      !['error', 'response.failed'].includes(detail.type)
        ? detail.type
        : undefined
    const usage = [reason, code, type].find(
      (value) => value !== undefined && USAGE_LIMIT_CODES.has(value),
    )
    const frameWindow =
      envelope?.type === 'response.failed' &&
      isRecord(body?.failed) &&
      typeof body.failed.rate_limit_reached_type === 'string'
        ? body.failed.rate_limit_reached_type
        : undefined
    const provedWindow = frameWindow ?? usage
    if (status === 429 && provedWindow) {
      const named =
        frameWindow ??
        (typeof detail?.rate_limit_reached_type === 'string'
          ? detail.rate_limit_reached_type
          : typeof detail?.window === 'string'
            ? detail.window
            : provedWindow)
      const exhausted = reportVaultRoutingLimit(
        sessionId,
        receipt,
        { window: named, resetAt: response.limit?.resetAt },
        { headers, quota: response.quota, now: response.now, body: envelope },
      )
      if (exhausted) return { kind: 'exhausted', exhausted }
    }
    if (response.backoff) {
      const now = response.now ?? Date.now()
      const retryAtMs = Math.ceil(
        resetFromRetryAfter(headers, now) ??
          response.limit?.resetAt ??
          providerResetAt(detail?.resets_at, detail?.resets_in_seconds, now) ??
          now + 5_000,
      )
      if (identity)
        reportRouting({
          ...identity,
          kind: 'transient_backoff',
          retryAtMs,
          providerCode: code || type || `http_${status}`,
        })
      return {
        kind: 'backoff',
        retryAtMs,
        credentialId: receipt.credentialId,
        ...(receipt.accountIdentity !== undefined
          ? { accountIdentity: receipt.accountIdentity }
          : {}),
      }
    }
    return
  }
  if (!identity || status < 200 || status >= 300) return
  const rateHeaders: Record<string, string> = {}
  for (const name of RATE_LIMIT_HEADERS) {
    const value = headers.get(name)
    if (value !== null) rateHeaders[name] = value
  }
  reportRouting({
    ...identity,
    outcome: 'served',
    headers: rateHeaders,
  })
}

export function vaultRoutingStreamFailed(event: unknown): boolean {
  return (
    isRecord(event) &&
    (event.type === 'error' ||
      event.type === 'response.failed' ||
      (isRecord(event.response) && event.response.status === 'failed'))
  )
}

/** Most SSE lines are token deltas; parse only possible failures. */
export function vaultRoutingStreamMayFail(data: string): boolean {
  return (
    data.includes('"response.failed"') ||
    data.includes('"type":"error"') ||
    (data.includes('"error"') && /"type"\s*:\s*"error"/.test(data)) ||
    (data.includes('"failed"') && /"status"\s*:\s*"failed"/.test(data))
  )
}
