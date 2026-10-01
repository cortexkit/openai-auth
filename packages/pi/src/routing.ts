// Sticky-balanced routing's session pins for this Pi process.
//
// A session is pinned to the account it was placed on and keeps it while the
// account can serve; the pins live in this process only, so a restarted Pi
// places its sessions again. `/openai-routing` reads and clears them.

import {
  isPinValid,
  pendingBytesForPins,
  type StickyPin,
  type StickySelection,
} from '@cortexkit/common-auth/routing'

const stickyRoutingBySession = new Map<string, StickyPin>()

export function getPiStickyRouting(sessionId: string): string | undefined {
  return stickyRoutingBySession.get(sessionId)?.accountId
}

export function clearPiStickyRouting(sessionId: string): boolean {
  return stickyRoutingBySession.delete(sessionId)
}

export function setPiStickyRouting(sessionId: string, accountId: string): void {
  stickyRoutingBySession.set(sessionId, { accountId })
}

/** One sticky placement decision for a session. */
export interface PiPinPlacement {
  sessionId: string
  requestBytes: number
  /** Accounts a pin may stay on. */
  validPinnedAccountIds: readonly string[]
  /** Accounts this decision must not place the session on. */
  excludeAccountIds: readonly string[]
  /** Each account's quota reading time, which the pending-byte count is keyed to. */
  quotaCheckedAtByAccount: Readonly<Record<string, number | undefined>>
  /** Each account's ChatGPT identity, so a pin never follows a row to another account. */
  wireAccountIdByAccount: Readonly<Record<string, string | undefined>>
  /** Chooses an account for an unpinned session, weighed by other sessions' bytes. */
  select: (
    pendingBytes: ReadonlyMap<string, number>,
  ) => StickySelection | undefined
  /** False for a decision that must not move the session's recorded pin. */
  persist: boolean
}

/**
 * The account a session's request goes to: its pin while the pin is valid and
 * not excluded, otherwise the account `select` places it on. With `persist`
 * the result becomes the session's pin.
 */
export function placePiStickyPin(
  placement: PiPinPlacement,
): { accountId: string } | undefined {
  const pin = stickyRoutingBySession.get(placement.sessionId)
  const valid = new Set(placement.validPinnedAccountIds)
  if (
    pin &&
    !placement.excludeAccountIds.includes(pin.accountId) &&
    isPinValid(pin, valid, placement.wireAccountIdByAccount[pin.accountId])
  ) {
    if (placement.persist) {
      const quotaCheckedAt = placement.quotaCheckedAtByAccount[pin.accountId]
      stickyRoutingBySession.set(placement.sessionId, {
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
    stickyRoutingBySession,
    checkedAt,
    placement.sessionId,
  )
  const selection = placement.select(pending)
  if (!selection) return undefined
  if (placement.persist) {
    const wireIdentity = placement.wireAccountIdByAccount[selection.accountId]
    stickyRoutingBySession.set(placement.sessionId, {
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
