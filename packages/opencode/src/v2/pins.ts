// Sticky-balanced routing's session pins for one OpenCode 2 server process.
//
// A session is pinned to the pool row it was placed on and keeps it while the
// row can serve. On OpenCode 1 the pins live in the sidebar file, which the
// OpenCode 1 TUI reads; OpenCode 2 has no such sidebar yet, so the pins live
// in memory and a restarted server places its sessions again (the pool rows,
// their quota and their rate-limit marks are what carry over).

import {
  isPinValid,
  pendingBytesForPins,
  type StickyPin,
  type StickySelection,
} from '@cortexkit/common-auth/routing'

/** Most sessions whose pins are kept before the oldest is forgotten. */
export const MAX_SESSION_PINS = 1024

/** One sticky placement decision for a session. */
export interface SessionPinPlacement {
  sessionId: string
  requestBytes: number
  /** Rows a pin may stay on. */
  validPinnedAccountIds: readonly string[]
  /** Rows this decision must not place the session on. */
  excludeAccountIds: readonly string[]
  /** Each row's quota reading time, which the pending-byte count is keyed to. */
  quotaCheckedAtByAccount: Readonly<Record<string, number | undefined>>
  /** Each row's ChatGPT identity, so a pin never follows a row to another account. */
  wireAccountIdByAccount: Readonly<Record<string, string | undefined>>
  /** Chooses a row for an unpinned session, weighed by other sessions' bytes. */
  select: (
    pendingBytes: ReadonlyMap<string, number>,
  ) => StickySelection | undefined
  /** False for a decision that must not move the session's recorded pin. */
  persist: boolean
}

export class SessionPins {
  private readonly pins = new Map<string, StickyPin>()
  private readonly limit: number

  constructor(limit = MAX_SESSION_PINS) {
    this.limit = Math.max(1, limit)
  }

  get(sessionId: string): string | undefined {
    return this.pins.get(sessionId)?.accountId
  }

  forget(sessionId: string): void {
    this.pins.delete(sessionId)
  }

  get size(): number {
    return this.pins.size
  }

  private set(sessionId: string, pin: StickyPin): void {
    // Re-inserting keeps the map in least-recently-placed order, so the
    // oldest session is the one dropped when the bound is reached.
    this.pins.delete(sessionId)
    this.pins.set(sessionId, pin)
    while (this.pins.size > this.limit) {
      const oldest = this.pins.keys().next().value
      if (oldest === undefined) break
      this.pins.delete(oldest)
    }
  }

  /**
   * The row a session's request goes to: its pin while the pin is valid and
   * not excluded, otherwise the row `select` places it on. With `persist` the
   * result becomes the session's pin.
   */
  place(placement: SessionPinPlacement): { accountId: string } | undefined {
    const pin = this.pins.get(placement.sessionId)
    const valid = new Set(placement.validPinnedAccountIds)
    if (
      pin &&
      !placement.excludeAccountIds.includes(pin.accountId) &&
      isPinValid(pin, valid, placement.wireAccountIdByAccount[pin.accountId])
    ) {
      if (placement.persist) {
        const quotaCheckedAt = placement.quotaCheckedAtByAccount[pin.accountId]
        this.set(placement.sessionId, {
          accountId: pin.accountId,
          inputBytes: placement.requestBytes,
          ...(pin.wireIdentity !== undefined
            ? { wireIdentity: pin.wireIdentity }
            : {}),
          ...(quotaCheckedAt !== undefined ? { quotaCheckedAt } : {}),
        })
      }
      return { accountId: pin.accountId }
    }
    const checkedAt = new Map(Object.entries(placement.quotaCheckedAtByAccount))
    const pending = pendingBytesForPins(
      this.pins,
      checkedAt,
      placement.sessionId,
    )
    const selection = placement.select(pending)
    if (!selection) return undefined
    if (placement.persist) {
      const wireIdentity = placement.wireAccountIdByAccount[selection.accountId]
      this.set(placement.sessionId, {
        accountId: selection.accountId,
        inputBytes: placement.requestBytes,
        ...(wireIdentity !== undefined ? { wireIdentity } : {}),
        ...(selection.quotaCheckedAt !== undefined
          ? { quotaCheckedAt: selection.quotaCheckedAt }
          : {}),
      })
    }
    return { accountId: selection.accountId }
  }
}
