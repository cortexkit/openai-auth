// Sticky-balanced routing's session pins for one OpenCode 2 server process.
//
// A session is pinned to the pool row it was placed on and keeps it while the
// row can serve. On OpenCode 1 the pins live in the sidebar file, which the
// OpenCode 1 TUI reads. OpenCode 2 projects its pins there for display, but keeps
// routing authority in memory: a restarted server places its sessions again (the pool rows,
// their quota and their rate-limit marks are what carry over).

import type { StickyPin } from '@cortexkit/common-auth/routing'
import {
  placeStickyPin,
  type StickyPinPlacement,
} from '@cortexkit/openai-auth-core/internal'

/** Most sessions whose pins are kept before the oldest is forgotten. */
export const MAX_SESSION_PINS = 1024

export interface PinReservation {
  readonly sessionId: string
  readonly previous: StickyPin | undefined
  readonly pin: StickyPin
}

export class SessionPins {
  private readonly pins = new Map<string, StickyPin>()
  private readonly reservations = new Map<string, PinReservation>()
  private readonly listeners = new Set<
    (sessionId: string, pin?: StickyPin) => void
  >()
  private readonly limit: number

  constructor(limit = MAX_SESSION_PINS) {
    this.limit = Math.max(1, limit)
  }

  get(sessionId: string): string | undefined {
    return this.pins.get(sessionId)?.accountId
  }

  forget(sessionId: string): void {
    this.reservations.delete(sessionId)
    this.pins.delete(sessionId)
    for (const listener of this.listeners) listener(sessionId)
  }

  subscribe(
    listener: (sessionId: string, pin?: StickyPin) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Published pins only; provisional choices live in the accounting view. */
  snapshot(): ReadonlyMap<string, StickyPin> {
    return new Map(this.pins)
  }

  /**
   * Live pending-byte accounting includes choices waiting for authorization or retry.
   * A chooser omits its own lease so auxiliary work still follows the committed pin.
   */
  placementSnapshot(
    excludeReservationFor?: string,
  ): ReadonlyMap<string, StickyPin> {
    const view = new Map(this.pins)
    for (const reservation of this.reservations.values())
      if (reservation.sessionId !== excludeReservationFor)
        view.set(reservation.sessionId, reservation.pin)
    return view
  }

  /** Reserve synchronously without publishing a pin or evicting another session. */
  reserve(sessionId: string, pin: StickyPin): PinReservation {
    const reservation = { sessionId, previous: this.pins.get(sessionId), pin }
    this.reservations.set(sessionId, reservation)
    return reservation
  }

  rollback(reservation: PinReservation): void {
    if (this.reservations.get(reservation.sessionId) === reservation)
      this.reservations.delete(reservation.sessionId)
  }

  /** Only the current reservation may turn its planned pin into committed state. */
  finish(reservation: PinReservation, pin?: StickyPin): void {
    if (this.reservations.get(reservation.sessionId) !== reservation) return
    this.rollback(reservation)
    if (pin && this.pins.get(reservation.sessionId) === reservation.previous)
      this.set(reservation.sessionId, pin)
  }

  /** The committed pin count; reservations do not consume the LRU's capacity. */
  get size(): number {
    return this.pins.size
  }

  private set(sessionId: string, pin: StickyPin): void {
    this.reservations.delete(sessionId)
    // Re-inserting keeps the map in least-recently-placed order, so the
    // oldest session is the one dropped when the bound is reached.
    this.pins.delete(sessionId)
    this.pins.set(sessionId, pin)
    for (const listener of this.listeners) listener(sessionId, pin)
    while (this.pins.size > this.limit) {
      const oldest = this.pins.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
  }

  /**
   * Which account a new session gets comes from the shared placement policy.
   * This ledger only limits how many session pins OpenCode 2 keeps, evicting the
   * least recently used past that limit.
   */
  place(placement: StickyPinPlacement): { accountId: string } | undefined {
    return placeStickyPin(
      this.placementSnapshot(placement.sessionId),
      placement,
      (sessionId, pin) => this.set(sessionId, pin),
    )
  }
}
