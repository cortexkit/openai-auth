import { randomUUID } from 'node:crypto'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import {
  type BillingRequestKind,
  type BillingUsage,
  isCacheWarmStopReason,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import { isRecord } from './util/record'

export interface VaultBillingWarming {
  on: boolean
  stopReason?: string
}

/** Codex input includes cache hits and measured cache writes; billing input does not. */
export function codexBillingUsage(value: unknown): BillingUsage | undefined {
  if (!isRecord(value)) return undefined
  const details = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined
  const cached = details?.cached_tokens
  const written = details?.cache_write_tokens
  const reasoning = isRecord(value.output_tokens_details)
    ? value.output_tokens_details.reasoning_tokens
    : undefined
  return {
    ...(typeof value.input_tokens === 'number'
      ? {
          input: Math.max(
            0,
            value.input_tokens -
              (typeof cached === 'number' ? cached : 0) -
              (typeof written === 'number' && written > 0 ? written : 0),
          ),
        }
      : {}),
    ...(typeof cached === 'number' ? { cacheRead: cached } : {}),
    ...(typeof written === 'number' && written > 0
      ? { cacheWrite: written }
      : {}),
    ...(typeof value.output_tokens === 'number'
      ? { output: value.output_tokens }
      : {}),
    ...(typeof reasoning === 'number' ? { reasoning } : {}),
    reasoningIncludedInOutput: true,
  }
}

/** One vault-served physical send; construct only when Thalamus's global routing accessor is present. */
export class VaultBillingAttempt {
  private readonly attemptId = randomUUID()
  private reported = false
  private completed = false
  private failed = false
  private responseId: string | undefined
  private usage: BillingUsage | undefined

  constructor(
    private readonly sessionId: string,
    private readonly receipt: QuotaReceipt,
    private readonly requestKind: BillingRequestKind,
    private readonly model: string,
    private readonly attempt: number,
    private readonly warming?: (sessionId: string) => VaultBillingWarming,
  ) {}

  event(event: unknown): void {
    if (!isRecord(event)) return
    if (event.type === 'error' || event.type === 'response.failed')
      this.failed = true
    if (
      event.type !== 'response.completed' &&
      event.type !== 'response.incomplete' &&
      event.type !== 'response.failed'
    )
      return
    this.completed = event.type !== 'response.failed'
    if (isRecord(event.response)) {
      if (typeof event.response.id === 'string')
        this.responseId = event.response.id
      this.usage = codexBillingUsage(event.response.usage)
    }
  }

  /** Pi already separates uncached input from cache hits in its final message. */
  piCompleted(responseId: string | undefined, value: unknown): void {
    this.completed = true
    this.piResponseId(responseId)
    if (!isRecord(value)) return
    const usage: BillingUsage = { reasoningIncludedInOutput: true }
    for (const key of ['input', 'output', 'cacheRead', 'reasoning'] as const)
      if (typeof value[key] === 'number') usage[key] = value[key]
    if (typeof value.cacheWrite === 'number' && value.cacheWrite > 0)
      usage.cacheWrite = value.cacheWrite
    this.usage = usage
  }

  piResponseId(responseId: string | undefined): void {
    this.responseId = responseId
  }

  end(outputStarted: boolean, ended: boolean, status?: number): void {
    if (this.reported) return
    this.reported = true
    let warming: VaultBillingWarming | undefined
    try {
      warming = this.warming?.(this.sessionId)
    } catch {
      // Optional accounting cannot interrupt the host if a manager was released.
    }
    reportRouting({
      sessionId: this.sessionId,
      kind: 'billing',
      attemptId: this.attemptId,
      requestKind: this.requestKind,
      credentialId: this.receipt.credentialId,
      ...(this.receipt.accountIdentity
        ? { accountId: this.receipt.accountIdentity }
        : {}),
      provider: 'openai',
      model: this.model,
      attempt: this.attempt,
      cache: {
        implicit: true,
        warming: warming?.on
          ? { on: true }
          : {
              on: false,
              ...(isCacheWarmStopReason(warming?.stopReason)
                ? { stopReason: warming.stopReason }
                : {}),
            },
      },
      outcome:
        this.failed || (status !== undefined && (status < 200 || status >= 300))
          ? 'failed'
          : this.completed && ended
            ? 'completed'
            : outputStarted
              ? 'cut'
              : 'failed',
      ...(status !== undefined ? { status } : {}),
      ...(this.responseId ? { providerResponseId: this.responseId } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
    })
  }
}
