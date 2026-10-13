// Shared placement policy; the host owns the pin map and its eviction policy.

import {
  isPinValid,
  pendingBytesForPins,
  type StickyPin,
  type StickySelection,
} from '@cortexkit/common-auth/routing'

/** One sticky placement decision for a session. */
export interface StickyPinPlacement {
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

/** Returns the valid pin or a new selection, persisting only when requested. */
export function placeStickyPin(
  pins: ReadonlyMap<string, StickyPin>,
  placement: StickyPinPlacement,
  set: (sessionId: string, pin: StickyPin) => void,
): { accountId: string } | undefined {
  const pin = pins.get(placement.sessionId)
  const valid = new Set(placement.validPinnedAccountIds)
  if (
    pin &&
    !placement.excludeAccountIds.includes(pin.accountId) &&
    isPinValid(pin, valid, placement.wireAccountIdByAccount[pin.accountId])
  ) {
    if (placement.persist) {
      const quotaCheckedAt = placement.quotaCheckedAtByAccount[pin.accountId]
      set(placement.sessionId, {
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
  const pending = pendingBytesForPins(pins, checkedAt, placement.sessionId)
  const selection = placement.select(pending)
  if (!selection) return undefined
  if (placement.persist) {
    const wireIdentity = placement.wireAccountIdByAccount[selection.accountId]
    set(placement.sessionId, {
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
