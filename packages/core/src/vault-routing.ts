import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import {
  askRouting,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import { type PoolRoutingInput, planOrdered } from './pool-routing'

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

/** Report only the served receipt's identity and explicitly allowed rate headers. */
export function reportVaultRouting(
  sessionId: string | undefined,
  receipt: QuotaReceipt | undefined,
  headers: Headers,
): void {
  if (!sessionId || !receipt?.accountIdentity) return
  const rateHeaders: Record<string, string> = {}
  for (const name of RATE_LIMIT_HEADERS) {
    const value = headers.get(name)
    if (value !== null) rateHeaders[name] = value
  }
  reportRouting({
    sessionId,
    accountId: receipt.accountIdentity,
    credentialId: receipt.credentialId,
    outcome: 'served',
    headers: rateHeaders,
  })
}
