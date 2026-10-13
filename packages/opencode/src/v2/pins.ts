// Sticky-balanced routing's session pins for one OpenCode 2 server process.
//
// A session is pinned to the pool row it was placed on and keeps it while the
// row can serve. On OpenCode 1 the pins live in the sidebar file, which the
// OpenCode 1 TUI reads; OpenCode 2 has no such sidebar yet, so the pins live
// in memory and a restarted server places its sessions again (the pool rows,
// their quota and their rate-limit marks are what carry over).

import type { StickyPin } from '@cortexkit/common-auth/routing'
import {
  placeStickyPin,
  type StickyPinPlacement,
} from '@cortexkit/openai-auth-core/internal'

/** Most sessions whose pins are kept before the oldest is forgotten. */
export const MAX_SESSION_PINS = 1024

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

  /** Placement policy is shared; this ledger alone enforces the host's LRU bound. */
  place(placement: StickyPinPlacement): { accountId: string } | undefined {
    return placeStickyPin(this.pins, placement, (sessionId, pin) =>
      this.set(sessionId, pin),
    )
  }
}
