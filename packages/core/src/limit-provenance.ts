import {
  type AccountKey,
  type LimitsNamespace,
  sameAccount,
} from '@cortexkit/common-auth/limits'
import { limitAccountId } from './limit-identity'

export type ResetProvenance = 'unproven' | 'reading' | 'provider'
export interface LimitProvenance {
  readonly accountKey: AccountKey
  readonly expiry: number
  readonly branch: ResetProvenance
  readonly observedAt: number
  readonly evidenceAt: number
}

const strength = { unproven: 0, reading: 1, provider: 2 } as const

/** Local evidence annotates a surviving mark; it never authorizes a mark. */
export class LimitProvenanceStore {
  private readonly entries = new Map<string, LimitProvenance>()
  constructor(readonly namespace: string) {}

  record(entry: LimitProvenance, now: number): void {
    if (entry.accountKey.namespace !== this.namespace) return
    if (
      ![entry.expiry, entry.observedAt, entry.evidenceAt, now].every(
        Number.isFinite,
      )
    )
      return
    this.prune(now)
    if (entry.expiry <= now) return
    const id = limitAccountId(entry.accountKey)
    const previous = this.entries.get(id)
    if (previous?.expiry === entry.expiry) {
      // An equal deadline cannot upgrade a timer that was originally a guess.
      if (strength[previous.branch] <= strength[entry.branch]) return
    }
    this.entries.set(id, entry)
    if (this.entries.size <= 256) return
    let oldest: string | undefined
    let observedAt = Infinity
    for (const [key, value] of this.entries) {
      if (value.observedAt < observedAt) {
        oldest = key
        observedAt = value.observedAt
      }
    }
    if (oldest !== undefined) this.entries.delete(oldest)
  }

  read(
    account: AccountKey,
    expiry: number,
    evidenceAt: number,
    now: number,
  ): LimitProvenance | undefined {
    this.prune(now)
    const entry = this.entries.get(limitAccountId(account))
    return entry?.expiry === expiry && entry.evidenceAt === evidenceAt
      ? entry
      : undefined
  }

  retire(account: AccountKey): void {
    this.entries.delete(limitAccountId(account))
  }

  clear(): void {
    this.entries.clear()
  }

  /** Rejected writes, clears and replacement must not lend proof to later marks. */
  reconcile(snapshot: LimitsNamespace, now: number): void {
    this.prune(now)
    for (const [id, entry] of this.entries) {
      if (
        !snapshot.marks.some(
          (mark) =>
            sameAccount(mark.key.account, entry.accountKey) &&
            mark.key.window === 'account' &&
            mark.key.scope.kind === 'pool' &&
            mark.entries.some(
              (value) =>
                value.cause === 'rate-limit' &&
                value.until === entry.expiry &&
                value.evidenceAt === entry.evidenceAt,
            ),
        )
      )
        this.entries.delete(id)
    }
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries)
      if (entry.expiry <= now) this.entries.delete(id)
  }
}
