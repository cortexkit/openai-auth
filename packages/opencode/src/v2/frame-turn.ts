// The turn a WebSocket `response.create` frame belongs to, kept apart from
// the session's HTTP turn state.
//
// OpenCode 1 does the same: its WebSocket pool entry owns its own turn id and
// turn start (`advanceTurn` in ws-pool.ts), so a title or compaction request
// sent over HTTP never moves a WebSocket turn. Here the HTTP turn lives in
// `CodexSessionMetadata` (written by `prepareCodexRequest` for every HTTP
// request kind, exactly as on OpenCode 1) and the frame turn lives in
// `FrameTurnState`. Only the frame rule below advances a frame turn.
//
// The state per session is fixed-size and holds no message text: the turn id,
// its start time, whether the last frame completed, a SHA-256 fingerprint of
// the conversation's last user message and the conversation's user-message
// count. No message size changes its size.

import { createHash } from 'node:crypto'
import {
  type CodexRequestRuntime,
  type CodexSessionMetadata,
  isMessageWithRole,
} from '../codex-request'
import { uuidV7 } from '../util/uuid-v7'

/** The turn a frame is sent in. */
export interface FrameTurn {
  readonly turnID: string
  readonly turnStartedAt: number
}

/** What is kept for one session; exposed read-only for tests and diagnostics. */
export interface FrameTurnRecord extends FrameTurn {
  /** Whether the session's last frame got `response.completed`. */
  readonly completed: boolean
  /** SHA-256 (hex) of `JSON.stringify` of the conversation's last user message. */
  readonly fingerprint: string | undefined
  /** The conversation's user-message count; undefined when not known. */
  readonly userCount: number | undefined
}

/** At most this many sessions keep a frame turn; the least recently used goes first. */
export const MAX_FRAME_TURN_SESSIONS = 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUserMessage = (item: unknown) => isMessageWithRole(item, 'user')

/**
 * An item the model produced or a tool returned: an assistant message, or
 * any typed item that is not a message (reasoning, a tool call, a tool
 * output). The effort rule's `configuration_update` sits before the user
 * message it belongs to and is neither.
 */
const isModelOrToolItem = (item: unknown) =>
  isRecord(item) &&
  (item.role === 'assistant' ||
    (typeof item.type === 'string' &&
      item.type !== 'message' &&
      item.type !== 'configuration_update'))

/**
 * The fingerprint `FrameTurnState` records for a user message. Two user
 * messages count as equal when deciding whether a full frame is a resend
 * exactly when their fingerprints are equal.
 */
export function userMessageFingerprint(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex')
}

/**
 * The frame turn of each session.
 *
 * Call `advance` once for every `response.create` frame sent, with the
 * host's frame body, and `completed` when that frame's `response.completed`
 * arrives. The rule:
 *
 * - A chained frame (one with `previous_response_id`) starts a new turn
 *   exactly when its `input` holds a user message. The host's deltas carry
 *   only newly appended items, so two consecutive identical user messages
 *   each start a turn, and a delta of tool outputs never does.
 * - A full frame starts a new turn when its last user message comes after
 *   every model and tool item, unless it is a resend: the session's previous
 *   frame got no `response.completed`, and the frame's last user message has
 *   the recorded fingerprint and its user-message count equals the recorded
 *   count. A full frame with no recorded state is not a resend.
 * - A full frame that ends on tool output keeps the current turn.
 * - A session with no turn yet (new, forgotten or evicted) starts one on its
 *   first frame.
 *
 * A full frame records its own fingerprint and count. A chained frame
 * records its delta's last user message, if any, and adds its delta's user
 * messages to the recorded count; an unknown count stays unknown.
 */
export class FrameTurnState {
  readonly #sessions = new Map<string, FrameTurnRecord>()

  constructor(
    readonly runtime?: CodexRequestRuntime,
    readonly maxSessions = MAX_FRAME_TURN_SESSIONS,
  ) {}

  /**
   * Applies the rule to one frame about to be sent and returns its turn.
   * `runtime` mints a new turn's id and start time; it defaults to the one
   * given to the constructor, so a process-wide instance can serve callers
   * that each bring their own clock.
   */
  advance(
    sessionID: string,
    frame: Record<string, unknown>,
    runtime: CodexRequestRuntime | undefined = this.runtime,
  ): FrameTurn {
    const prior = this.#sessions.get(sessionID)
    const input = Array.isArray(frame.input) ? frame.input : []
    const users = input.filter(isUserMessage)
    const lastUser = input.findLastIndex(isUserMessage)
    const lastFingerprint =
      lastUser < 0 ? undefined : userMessageFingerprint(input[lastUser])
    const chained =
      typeof frame.previous_response_id === 'string' &&
      frame.previous_response_id.length > 0
    let startsTurn: boolean
    let fingerprint: string | undefined
    let userCount: number | undefined
    if (chained) {
      startsTurn = users.length > 0
      fingerprint = lastFingerprint ?? prior?.fingerprint
      userCount =
        prior?.userCount === undefined
          ? undefined
          : prior.userCount + users.length
    } else {
      fingerprint = lastFingerprint
      userCount = users.length
      const opensTurn =
        lastUser >= 0 && lastUser > input.findLastIndex(isModelOrToolItem)
      const resend =
        prior !== undefined &&
        !prior.completed &&
        prior.fingerprint === fingerprint &&
        prior.userCount === userCount
      startsTurn = opensTurn && !resend
    }
    const turn =
      startsTurn || !prior
        ? {
            turnID: (runtime?.uuid ?? uuidV7)(),
            turnStartedAt: (runtime?.now ?? Date.now)(),
          }
        : { turnID: prior.turnID, turnStartedAt: prior.turnStartedAt }
    this.#set(sessionID, {
      ...turn,
      completed: false,
      fingerprint,
      userCount,
    })
    return turn
  }

  /** Records that the session's last frame got `response.completed`. */
  completed(sessionID: string): void {
    const record = this.#sessions.get(sessionID)
    if (record) this.#set(sessionID, { ...record, completed: true })
  }

  get(sessionID: string): FrameTurnRecord | undefined {
    return this.#sessions.get(sessionID)
  }

  /** Drops a deleted host session; its next frame starts a new turn. */
  forget(sessionID: string): void {
    this.#sessions.delete(sessionID)
  }

  #set(sessionID: string, record: FrameTurnRecord) {
    this.#sessions.delete(sessionID)
    this.#sessions.set(sessionID, record)
    while (this.#sessions.size > this.maxSessions) {
      const oldest = this.#sessions.keys().next().value
      if (oldest === undefined) break
      this.#sessions.delete(oldest)
    }
  }
}

/**
 * The session metadata a WebSocket frame is shaped with (for
 * `prepareCodexRequest` with `websocket: true`): the session's thread and
 * window, with the frame's turn, never the HTTP turn. It is a new object, so
 * shaping a frame never writes the session's HTTP turn state (`turnID`,
 * `turnStartedAt`, `input`, `canonicalInput`).
 */
export function frameRequestMetadata(
  session: CodexSessionMetadata,
  turn: FrameTurn,
): CodexSessionMetadata {
  return {
    threadID: session.threadID,
    windowID: session.windowID,
    turnID: turn.turnID,
    turnStartedAt: turn.turnStartedAt,
  }
}
