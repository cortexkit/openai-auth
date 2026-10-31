import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import {
  askRouting,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import { windowsFromQuotaMap } from './pool-quota'
import { type PoolRoutingInput, planOrdered } from './pool-routing'
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

/** Title generation and history maintenance must not choose a new vault account. */
export function vaultRoutingKind(agent: string | undefined): string {
  return agent && !['title', 'compaction', 'summary'].includes(agent)
    ? 'primary'
    : 'auxiliary'
}

export function vaultRoutingRequestFromBody(
  body: unknown,
  agent: string | undefined,
): VaultRoutingRequest | undefined {
  if (typeof body !== 'string') return undefined
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.model === 'string'
      ? { modelId: parsed.model, kind: vaultRoutingKind(agent) }
      : undefined
  } catch {
    return undefined
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
}): Promise<string | undefined> {
  const { request, sessionId } = input
  if (
    !input.vaultMode ||
    !input.fresh ||
    !sessionId ||
    !request?.modelId ||
    request.kind !== 'primary' ||
    request.retry
  )
    return undefined
  const plan = planOrdered({
    ...input.routing,
    placement: 'roster',
    mainId: null,
  })
  if (plan.kind === 'block') return undefined
  const eligible = new Set(input.eligibleIds ?? plan.order)
  const candidates = input.routes.flatMap((route) =>
    plan.order.includes(route.id) &&
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
  if (candidates.length === 0) return undefined
  // askRouting enforces its own deadline; ignore suggested delays to stay within it.
  const answer = await askRouting({
    sessionId,
    provider: 'openai',
    modelId: request.modelId,
    candidates,
  })
  return answer?.candidate.id
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
    milliseconds !== null &&
    Number.isFinite(Number(milliseconds)) &&
    Number(milliseconds) >= 0
  )
    return now + Number(milliseconds)
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

/** Only successful responses and classified account exhaustion reach routing. */
export function reportVaultRouting(
  sessionId: string | undefined,
  receipt: QuotaReceipt | undefined,
  response: VaultRoutingResponse,
): void {
  if (
    !sessionId ||
    !receipt?.accountIdentity ||
    response.failed ||
    !hasVaultRoutingAccessor()
  )
    return
  const { status, headers } = response
  const identity = {
    sessionId,
    accountId: receipt.accountIdentity,
    credentialId: receipt.credentialId,
  }
  if (status === 429) {
    const body = isRecord(response.body) ? response.body : undefined
    const detail = isRecord(body?.error) ? body.error : body
    const reason = response.limit?.window
    const code = typeof detail?.code === 'string' ? detail.code : undefined
    const usage =
      reason && USAGE_LIMIT_CODES.has(reason)
        ? reason
        : code && USAGE_LIMIT_CODES.has(code)
          ? code
          : undefined
    if (!usage) return
    const named =
      typeof detail?.rate_limit_reached_type === 'string'
        ? detail.rate_limit_reached_type
        : typeof detail?.window === 'string'
          ? detail.window
          : usage
    const snapshot = windowsFromQuotaMap(response.quota)
    const slot =
      named === 'primary' || named === 'secondary' ? named : undefined
    const minutes = slot
      ? Number(
          headers.get(`x-codex-${slot}-window-minutes`) ??
            snapshot?.[slot]?.windowMinutes,
        )
      : undefined
    const window = minutes === 300 ? '5h' : minutes === 10080 ? '7d' : named
    const headerReset = slot
      ? Number(headers.get(`x-codex-${slot}-reset-at`)) * 1000
      : NaN
    const reset = response.limit?.resetAt
    const resetsAt =
      reset !== undefined && Number.isFinite(reset) && reset > 0
        ? reset
        : Number.isFinite(headerReset) && headerReset > 0
          ? headerReset
          : resetFromRetryAfter(headers, response.now ?? Date.now())
    reportRouting({
      ...identity,
      outcome: 'exhausted',
      window,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })
    return
  }
  if (status < 200 || status >= 300) return
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

/** Observe completion without reading ahead of, delaying, or changing the response bytes. */
export function observeVaultRoutingResponse(
  sessionId: string | undefined,
  receipt: QuotaReceipt,
  response: Response,
  options: {
    parseLimit: (body: unknown) => VaultRoutingResponse['limit']
    quota?: unknown
    now?: () => number
  },
): Response {
  if (!hasVaultRoutingAccessor() || !sessionId || !receipt.accountIdentity)
    return response
  const outcome = {
    status: response.status,
    headers: response.headers,
    quota: options.quota,
  }
  if (response.status === 429) {
    // Inspect a copy only for refused requests; the caller retains its unread body.
    try {
      void response
        .clone()
        .json()
        .then((body: unknown) => {
          reportVaultRouting(sessionId, receipt, {
            ...outcome,
            body,
            limit: options.parseLimit(body),
            now: options.now?.(),
          })
        })
        .catch(() => {})
    } catch {}
    return response
  }
  if (!response.ok) return response
  if (!response.body) {
    reportVaultRouting(sessionId, receipt, outcome)
    return response
  }
  const sse = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
  const decoder = new TextDecoder()
  let pending = ''
  let failed = false
  const inspect = (line: string) => {
    if (failed) return
    if (line.startsWith('event:') && line.slice(6).trim() === 'error')
      failed = true
    if (!line.startsWith('data:') || !vaultRoutingStreamMayFail(line)) return
    try {
      failed ||= vaultRoutingStreamFailed(JSON.parse(line.slice(5)))
    } catch {}
  }
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (sse && !failed) {
          pending += decoder.decode(chunk, { stream: true })
          let newline = pending.indexOf('\n')
          while (newline >= 0) {
            inspect(pending.slice(0, newline))
            pending = pending.slice(newline + 1)
            newline = pending.indexOf('\n')
          }
          // An unbounded or malformed event cannot establish successful completion.
          if (pending.length > 1024 * 1024) {
            failed = true
            pending = ''
          }
        }
        controller.enqueue(chunk)
      },
      flush() {
        if (sse) inspect(pending + decoder.decode())
        reportVaultRouting(sessionId, receipt, { ...outcome, failed })
      },
    }),
  )
  const observed = new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(observed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  })
  return observed
}
