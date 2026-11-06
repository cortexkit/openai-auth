import type {
  IdentityBinding,
  LimitsCommand,
} from '@cortexkit/common-auth/limits'
import type { OAuthQuotaSnapshot } from './accounts'
import { freshQuotaEvidence, type ParsedOpenAiLimit } from './limit-policy'
import type { LimitProvenance } from './limit-provenance'
import { resolveMidStreamRateLimitResetAt } from './quota-manager'

/** Keep explicit-reset, named-cache, then 60-second precedence for mark expiry. */
export function openAiRateLimitCommand(input: {
  binding: IdentityBinding
  baseRevision: number
  producerId: string
  operationId: string
  parsed: ParsedOpenAiLimit
  reading?: OAuthQuotaSnapshot
  now: number
  observedAt: number
  evidenceAt: number
  /** Retry-After can resolve a mark but is never terminal reset proof. */
  resetSource?: 'provider' | 'retry-after'
}): { command: LimitsCommand; provenance: LimitProvenance } {
  const expiry = resolveMidStreamRateLimitResetAt(
    input.reading,
    input.parsed.window,
    input.now,
    60000,
    input.parsed.resetAt,
  )
  const explicit =
    input.parsed.resetAt !== undefined &&
    Number.isFinite(input.parsed.resetAt) &&
    input.parsed.resetAt > input.now
  const named =
    input.parsed.window === 'primary' || input.parsed.window === 'secondary'
      ? input.reading?.[input.parsed.window]
      : undefined
  const borrowed =
    !explicit &&
    named &&
    named.resetsAt &&
    Date.parse(named.resetsAt) === expiry &&
    freshQuotaEvidence(named.checkedAt, input.now)
  const branch = explicit
    ? input.resetSource === 'retry-after'
      ? 'unproven'
      : 'provider'
    : borrowed
      ? 'reading'
      : 'unproven'
  return {
    command: {
      type: 'mark',
      binding: input.binding,
      baseRevision: input.baseRevision,
      producerId: input.producerId,
      operationId: input.operationId,
      scope: { kind: 'pool' },
      window: 'account',
      cause: 'rate-limit',
      until: expiry,
      evidenceAt: input.evidenceAt,
      mergeLaw: 'max-until',
    },
    provenance: {
      accountKey: input.binding.account,
      expiry,
      branch,
      observedAt: borrowed ? named.checkedAt : input.observedAt,
      evidenceAt: input.evidenceAt,
    },
  }
}
