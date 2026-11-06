import type {
  AccountKey,
  IdentityBinding,
  LimitsNamespace,
  LimitsPersistenceSnapshot,
} from '@cortexkit/common-auth/limits'
import { limitAccountId } from './limit-identity'

export const RECOVERY_REMEMBERED_BOUND = 256
export const RECOVERY_STAGED_BOUND = 256
export const RECOVERY_CONSUMED_BOUND = 1024

type Evidence = {
  readonly account: AccountKey
  readonly until: number
  readonly evidenceAt: number
  readonly committedRevision: number
}
export type RecoveryEvidence = Evidence & { readonly generation: string }
export type RecoveryRead = {
  readonly token: number
  readonly view: LimitsPersistenceSnapshot
  readonly at: number
}

function evidenceId(evidence: Evidence): string {
  return JSON.stringify([
    limitAccountId(evidence.account),
    evidence.until,
    evidence.evidenceAt,
  ])
}

/** Evidence only: the latch never changes an envelope or makes an account ready. */
export class LimitRecoveryLatch {
  private generation: string | undefined
  private issued = 0
  private adopted = 0
  private readonly remembered = new Map<string, Evidence>()
  private readonly staged = new Map<string, Evidence>()
  private readonly consumed = new Map<string, Evidence>()
  private exhausted = false

  constructor(private readonly log: (message: string) => void = () => {}) {}

  capture(view: LimitsPersistenceSnapshot, at: number): RecoveryRead {
    return { token: ++this.issued, view, at }
  }

  adopt(read: RecoveryRead, current: LimitsNamespace): boolean {
    const { view, token, at } = read
    const raw = view.snapshot
    // A committed envelope is identified by namespace, generation and revision.
    // Revisions alone can coincide across replacements or unverifiable reads.
    // The per-call token also prevents a delayed read from undoing a later one.
    if (
      token <= this.adopted ||
      !view.authoritative ||
      view.degradedAgreement ||
      raw.namespace !== current.namespace ||
      raw.generation !== current.generation ||
      raw.revision !== current.revision
    )
      return false
    this.adopted = token
    if (this.generation !== raw.generation) {
      this.generation = raw.generation
      this.remembered.clear()
      this.staged.clear()
      this.consumed.clear()
    }
    const bindings = new Set(
      view.bindings.map((b) => limitAccountId(b.account)),
    )
    const observed = new Map<string, Evidence>()
    for (const mark of raw.marks) {
      if (mark.key.window !== 'account' || mark.key.scope.kind !== 'pool')
        continue
      if (!bindings.has(limitAccountId(mark.key.account))) continue
      for (const entry of mark.entries) {
        if (entry.cause !== 'rate-limit') continue
        const evidence = {
          account: mark.key.account,
          until: entry.until,
          evidenceAt: entry.evidenceAt,
          committedRevision: entry.committedRevision,
        }
        observed.set(evidenceId(evidence), evidence)
      }
    }
    for (const entries of [this.remembered, this.staged]) {
      for (const [id, evidence] of entries) {
        if (!bindings.has(limitAccountId(evidence.account))) {
          entries.delete(id)
          continue
        }
        if (observed.has(id)) continue
        const cleared = raw.tombstones.some(
          (clear) =>
            limitAccountId(clear.key.account) ===
              limitAccountId(evidence.account) &&
            clear.key.window === 'account' &&
            clear.key.scope.kind === 'pool' &&
            clear.revision >= evidence.committedRevision &&
            (clear.cause === undefined || clear.cause === 'rate-limit'),
        )
        if (entries === this.staged && !cleared) continue
        entries.delete(id)
        // A different account's commit may prune an expired mark. Retain its
        // evidence for the original account's next real probe, not B's success.
        if (!cleared && entries === this.remembered && evidence.until <= at)
          this.stage(evidence)
      }
    }
    for (const [id, evidence] of observed) {
      if (this.consumed.has(id)) continue
      if (evidence.until <= at) {
        this.remembered.delete(id)
        this.stage(evidence)
      } else if (
        this.remembered.has(id) ||
        this.remembered.size < RECOVERY_REMEMBERED_BOUND
      ) {
        this.remembered.set(id, evidence)
      }
    }
    return true
  }

  private stage(evidence: Evidence): void {
    const id = evidenceId(evidence)
    if (this.consumed.has(id) || this.exhausted) return
    let until = Number.NEGATIVE_INFINITY
    let evidenceAt = Number.NEGATIVE_INFINITY
    for (const previous of this.consumed.values()) {
      if (limitAccountId(previous.account) !== limitAccountId(evidence.account))
        continue
      until = Math.max(until, previous.until)
      evidenceAt = Math.max(evidenceAt, previous.evidenceAt)
    }
    if (evidence.until <= until && evidence.evidenceAt <= evidenceAt) return
    if (this.staged.has(id) || this.staged.size < RECOVERY_STAGED_BOUND)
      this.staged.set(id, evidence)
  }

  candidate(
    binding: IdentityBinding,
    now: number,
  ): RecoveryEvidence | undefined {
    if (this.exhausted || this.generation === undefined) return undefined
    const account = limitAccountId(binding.account)
    let result: Evidence | undefined
    for (const evidence of this.staged.values()) {
      if (limitAccountId(evidence.account) !== account || evidence.until > now)
        continue
      if (
        !result ||
        evidence.until > result.until ||
        (evidence.until === result.until &&
          evidence.evidenceAt > result.evidenceAt)
      )
        result = evidence
    }
    return result && { ...result, generation: this.generation }
  }

  consume(evidence: RecoveryEvidence): boolean {
    const id = evidenceId(evidence)
    if (
      this.exhausted ||
      evidence.generation !== this.generation ||
      !this.staged.has(id) ||
      this.consumed.has(id)
    )
      return false
    const sameAccount = [...this.staged].filter(
      ([, entry]) =>
        limitAccountId(entry.account) === limitAccountId(evidence.account),
    )
    if (this.consumed.size + sameAccount.length > RECOVERY_CONSUMED_BOUND) {
      this.exhausted = true
      this.staged.clear()
      this.log(
        'OpenAI limits recovery evidence is full; skipping further recovery clears.',
      )
      return false
    }
    // Consumed evidence is never evicted or re-armed by an unrelated revision.
    // Newer evidence has a different identity and can earn a later probe clear.
    for (const [key, entry] of sameAccount) {
      this.consumed.set(key, entry)
      this.staged.delete(key)
    }
    return true
  }
}
