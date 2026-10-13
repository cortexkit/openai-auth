// Sticky-balanced routing's session pins for this Pi process.
//
// A session is pinned to the account it was placed on and keeps it while the
// account can serve; the pins live in this process only, so a restarted Pi
// places its sessions again. The `/openai` menu reads and clears them.

import type { StickyPin } from '@cortexkit/common-auth/routing'
import {
  placeStickyPin,
  type StickyPinPlacement,
} from '@cortexkit/openai-auth-core/internal'

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

/** Places a session using this Pi process's in-memory pin ledger. */
export function placePiStickyPin(
  placement: StickyPinPlacement,
): { accountId: string } | undefined {
  return placeStickyPin(stickyRoutingBySession, placement, (sessionId, pin) =>
    stickyRoutingBySession.set(sessionId, pin),
  )
}
