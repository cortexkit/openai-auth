import {
  type AccountKey,
  type BuiltRefusal,
  buildRefusal,
  formatReset,
  type LimitDecision,
  type LimitWindow,
  type MessageParameters,
  type PolicyFacts,
  readMaxSameAccountWait,
  registerLimitMessages,
  type SessionActivity,
  sameAccount,
  scanTerminalReset,
  type TerminalCandidate,
  type TerminalFacts,
  type TerminalScanFacts,
  type TerminalWindow,
} from '@cortexkit/common-auth/limits'
import type { OAuthQuotaSnapshot } from './accounts'
import {
  decideOpenAiLimit,
  freshQuotaEvidence,
  QUOTA_STALENESS_MS,
  quotaResetAt,
} from './limit-policy'
import type { LimitProvenanceStore } from './limit-provenance'

export type OpenAiQuotaCause = 'killswitch' | 'quota' | 'timed-mark'
export const OPENAI_FINAL_CAUSES = {
  quota: 'Every OpenAI account has used up its quota.',
  killswitch:
    'Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`).',
  'timed-mark': 'Every OpenAI account is paused by OpenAI for now.',
} as const
export const OPENAI_RETRYABLE_CAUSES = {
  quota: 'OpenAI quota exhausted — retrying on another account.',
  killswitch:
    'Killswitch: all OpenAI accounts are below their configured quota threshold.',
  'timed-mark': 'OpenAI rate limit reached — retrying on another account.',
  hold: "OpenAI usage limit reached on this account. Waiting for it keeps the conversation's prompt cache.",
} as const

function template(cause: string) {
  return ({ retryIn, reset }: MessageParameters) =>
    `${cause}${retryIn ? ` Retry in ${retryIn}.` : ''}${reset ? ` Resets in ${reset}.` : ''}`
}

export const openAiLimitMessages = registerLimitMessages({
  refusals: Object.fromEntries(
    Object.entries(OPENAI_FINAL_CAUSES).map(([key, cause]) => [
      key,
      template(cause),
    ]),
  ),
  retryable: Object.fromEntries(
    Object.entries(OPENAI_RETRYABLE_CAUSES).map(([key, cause]) => [
      key,
      template(cause),
    ]),
  ),
  formatReset,
})

export interface OpenAiTerminalAccount {
  account: AccountKey
  readingAccount?: AccountKey
  identity?: string
  readingIdentity?: string
  reading?: OAuthQuotaSnapshot
  /** Whether credentials may be used, separate from exhaustion and killswitch admission. */
  usable?: boolean
  floors?: Partial<Record<'primary' | 'secondary', number>>
  confirmedBlockers?: readonly LimitWindow[]
  marks?: readonly { until: number; evidenceAt: number }[]
}

/** Consider all blocked accounts, not just the first account in routing order. */
export function openAiTerminalFacts(input: {
  accounts: readonly OpenAiTerminalAccount[]
  effectiveModel: string
  familyOf?: TerminalScanFacts['familyOf']
  now: number
  maxSameAccountWait?: unknown
  activity?: SessionActivity
  currentAccountKey?: AccountKey
  provenance?: LimitProvenanceStore
}): TerminalFacts {
  const unproven: number[] = []
  let quota = false
  let killswitch = false
  const familyOf = input.familyOf ?? (() => undefined)
  const candidates: TerminalCandidate[] = input.accounts.flatMap((row) => {
    if (row.usable === false) return []
    const readingMatches =
      sameAccount(row.account, row.readingAccount ?? row.account) &&
      !(
        row.identity &&
        row.readingIdentity &&
        row.identity !== row.readingIdentity
      )
    const windows: TerminalWindow[] = []
    if (readingMatches) {
      for (const name of ['primary', 'secondary'] as const) {
        const window = row.reading?.[name]
        if (!window) continue
        const fresh = freshQuotaEvidence(window.checkedAt, input.now)
        const floor = row.floors?.[name]
        const blockedBy =
          floor !== undefined && window.remainingPercent < floor
            ? 'killswitch-floor'
            : fresh && window.usedPercent >= 100
              ? 'exhausted'
              : undefined
        if (!blockedBy) continue
        if (blockedBy === 'killswitch-floor') killswitch = true
        else quota = true
        const at = fresh ? quotaResetAt(window.resetsAt) : undefined
        windows.push({
          window: name,
          scope: { kind: 'pool' },
          blockedBy,
          ...(at === undefined
            ? {}
            : { reset: { at, checkedAt: window.checkedAt } }),
        })
      }
      for (const blocker of row.confirmedBlockers ?? []) {
        if (
          !blocker.confirmed ||
          !freshQuotaEvidence(blocker.observedAt, input.now)
        )
          continue
        quota = true
        windows.push({
          window: blocker.window,
          scope: { kind: 'pool' },
          blockedBy: 'exhausted',
          ...(blocker.resetAt === undefined
            ? {}
            : {
                reset: { at: blocker.resetAt, observedAt: blocker.observedAt },
              }),
        })
      }
    }
    for (const mark of row.marks ?? []) {
      if (!Number.isFinite(mark.until) || mark.until <= input.now) continue
      const annotation = input.provenance?.read(
        row.account,
        mark.until,
        mark.evidenceAt,
        input.now,
      )
      const proven =
        annotation &&
        annotation.branch !== 'unproven' &&
        freshQuotaEvidence(annotation.observedAt, input.now)
      if (!proven) unproven.push(mark.until)
      windows.push({
        window: 'account',
        scope: { kind: 'pool' },
        blockedBy: 'exhausted',
        ...(proven
          ? { reset: { at: mark.until, observedAt: annotation.observedAt } }
          : {}),
      })
    }
    // A quota reading from an earlier login cannot invalidate a current mark's evidence.
    return [{ account: row.account, readingAccount: row.account, windows }]
  })
  const activity =
    input.activity &&
    input.currentAccountKey &&
    sameAccount(input.activity.accountKey, input.currentAccountKey)
      ? input.activity
      : undefined
  let scan: TerminalScanFacts = {
    candidates,
    effectiveModel: input.effectiveModel,
    familyOf,
    maxAgeMs: QUOTA_STALENESS_MS,
    maxSameAccountWait: readMaxSameAccountWait(input.maxSameAccountWait),
    activity,
    accountKey: activity?.accountKey,
  }
  const selected = scanTerminalReset(scan, input.now)
  // A sooner unproven release makes a later known release misleading. Suppress
  // the scan before reduction, so both wire metadata and real waits stay unknown.
  if (selected && unproven.some((until) => until < selected.resetAt))
    scan = { ...scan, candidates: [] }
  return {
    source: 'pool',
    reason: 'quota',
    messageKey: killswitch ? 'killswitch' : quota ? 'quota' : 'timed-mark',
    scan,
  }
}

/** Pre-send callers invoke this only after the planner has no permitted escape. */
export function decideOpenAiTerminal(
  facts: PolicyFacts,
  terminal: TerminalFacts,
): LimitDecision {
  const normalized =
    facts.phase === 'pre-send'
      ? {
          ...facts,
          attempted: undefined,
          selection: undefined,
          hold: undefined,
        }
      : facts
  const decision = decideOpenAiLimit(
    { ...normalized, terminal },
    { mode: 'sticky' },
  )
  if (!decision) throw new Error('Missing OpenAI terminal decision')
  return decision
}

export function buildOpenAiQuotaRefusal(input: {
  decision: LimitDecision
  now: number
  maxSameAccountWait?: unknown
  cause?: OpenAiQuotaCause
  host?: PolicyFacts['host']
  /** OpenCode 2 request throws carry message text only, with no retry metadata. */
  requestThrow?: boolean
}): BuiltRefusal {
  const decision = input.decision
  const hold =
    input.host !== 'pi' &&
    decision.action === 'hold' &&
    decision.waitKind !== 'terminal'
  const retryable =
    input.host !== 'pi' &&
    !input.requestThrow &&
    (hold ||
      (readMaxSameAccountWait(input.maxSameAccountWait) !== 0 &&
        decision.retryable))
  const key = hold
    ? 'hold'
    : (input.cause ??
      (decision.action === 'refuse' ? decision.messageKey : 'quota'))
  return buildRefusal({
    family:
      input.host === 'pi'
        ? 'pi-final'
        : input.requestThrow
          ? 'json-412'
          : hold
            ? 'openai-429'
            : decision.action === 'refuse'
              ? decision.family === 'pi-final'
                ? 'pi-final'
                : retryable
                  ? 'openai-429'
                  : 'json-412'
              : retryable
                ? 'openai-429'
                : 'pi-final',
    messageKey: key,
    messages: openAiLimitMessages,
    now: input.now,
    ...(retryable && 'retryAfterMs' in decision
      ? { retryAfterMs: decision.retryAfterMs }
      : {}),
    ...('resetAt' in decision && decision.resetAt !== undefined
      ? { resetAt: decision.resetAt }
      : {}),
  })
}
