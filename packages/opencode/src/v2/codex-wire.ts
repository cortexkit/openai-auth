// HTTP requests and WebSocket `response.create` frames both go through
// prepareCodexRequest, as on OpenCode 1. WebSocket handshakes keep the stable
// version, user-agent, originator and thread session-id headers: the host keys
// socket reuse by handshake headers, so a frame's turn metadata travels in the
// frame's `client_metadata`, never in a handshake header.

import {
  type CodexRequestRuntime,
  type CodexSessionMetadata,
  type FrameTurn,
  FrameTurnState,
  frameRequestMetadata,
  prepareCodexRequest,
  restoreReplayedCallStatus,
  supportsMidConversationEffort,
  uuidV7,
} from '@cortexkit/openai-auth-core/internal'
import { CodexPrimaryTurns } from '../codex-request'
import type { CodexSessionStore } from './codex-sessions'
import type { FrameMirrorCapture } from './frame-mirror'

const INSTALLATION_KEY = Symbol.for(
  '@cortexkit/openai-auth/opencode2/codex-installation',
)
function processInstallationID(): string {
  const registry = globalThis as typeof globalThis & {
    [INSTALLATION_KEY]?: string
  }
  registry[INSTALLATION_KEY] ??= crypto.randomUUID()
  return registry[INSTALLATION_KEY]
}

/**
 * HTTP requests and WebSocket cache keys share each host session's thread
 * identity. With a store, sessions are the store's process-wide map and new
 * or deleted sessions are saved to its file; without one they live only in
 * this object.
 */
export class CodexHttpState {
  readonly sessions: Map<string, CodexSessionMetadata>
  /**
   * Each session's WebSocket frame turn (see `frame-turn.ts`). With a store
   * this is the store's process-wide state; without a store it is this
   * object's own. Only primary WebSocket frames update it.
   */
  readonly frameTurns: FrameTurnState
  readonly primaryTurns: CodexPrimaryTurns
  readonly installationID: string
  constructor(
    readonly runtime?: CodexRequestRuntime,
    installationID?: string,
    readonly store?: CodexSessionStore,
  ) {
    this.installationID = installationID ?? processInstallationID()
    this.sessions = store?.sessions ?? new Map()
    this.frameTurns = store?.frameTurns ?? new FrameTurnState()
    this.primaryTurns = store?.primaryTurns ?? new CodexPrimaryTurns()
  }

  get(sessionID: string): CodexSessionMetadata {
    const uuid = this.runtime?.uuid ?? uuidV7
    if (this.store) return this.store.get(sessionID, uuid)
    let metadata = this.sessions.get(sessionID)
    if (!metadata) {
      const threadID = uuid()
      metadata = { threadID, turnID: uuid(), windowID: `${threadID}:0` }
      this.sessions.set(sessionID, metadata)
    }
    return metadata
  }

  /**
   * Applies the frame turn rule to one `response.create` frame the host is
   * about to send, as the host built it, and returns the frame's turn.
   */
  advanceFrame(sessionID: string, frame: Record<string, unknown>): FrameTurn {
    const turn = this.frameTurns.advance(sessionID, frame, this.runtime)
    this.primaryTurns.record(this.get(sessionID), turn)
    return turn
  }

  /**
   * Reads one WebSocket frame the server sent on an owned socket. A
   * `response.completed` marks the session's last sent frame as completed,
   * so resending that same full frame afterwards starts a new turn instead
   * of counting as a resend. Every other frame changes nothing.
   */
  frameReceived(sessionID: string, frame: string): void {
    // Most received frames are deltas; skip parsing those (a completed
    // frame repeats the whole response and can be large).
    if (!frame.includes('response.completed')) return
    if (parseObject(frame)?.type === 'response.completed')
      this.frameTurns.completed(sessionID)
  }

  /** Drops a deleted host session; a later request with its id starts a new thread. */
  forget(sessionID: string): void {
    if (this.store) this.store.delete(sessionID)
    else this.sessions.delete(sessionID)
    // An older shared store's delete method does not know about frame turns.
    this.frameTurns.forget(sessionID)
  }
}

export {
  CODEX_CLIENT_HEADERS,
  RESPONSES_LITE_HEADER,
  responsesLiteHttpBody,
} from '@cortexkit/openai-auth-core/internal'

/** At most this many sessions keep their pinned first effort; the oldest goes first. */
const MAX_PINNED_SESSIONS = 1024

/**
 * The models OpenCode 2's own OpenAI driver already carries an effort change
 * for: it records the change in the session's history, sends it as a
 * `configuration_update` item and keeps the request-level effort at the
 * session's first value, on HTTP and WebSocket alike (`supportsEffortUpdates`
 * in its Responses protocol: on 2.0.21 a model id ending in `gpt-6-astra`,
 * `gpt-6-sol` or `gpt-6-luna`, unless the model's own settings say
 * otherwise). The rewrite leaves these models to the host, so the two never
 * both act on one request.
 *
 * OpenCode 2.0.22 also carries `gpt-6.1-sol` itself, measured with the real
 * host: the request-level effort stays pinned, the turn whose effort changed
 * carries one update item and stays chained. `gpt-6.1-sol` is still left out
 * of this list so a 2.0.21 host keeps getting the rewrite; on 2.0.22 the
 * rewrite then has nothing to do, because the host's request already carries
 * the pinned effort and the update sits right before the user message.
 */
const HOST_EFFORT_UPDATE_MODEL = /(?:^|\/)gpt-6-(?:astra|sol|luna)$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUserMessage = (item: unknown) =>
  isRecord(item) &&
  (item.type === 'message' || 'role' in item) &&
  item.role === 'user'

const isConfigurationUpdate = (item: unknown) =>
  isRecord(item) && item.type === 'configuration_update'

/** The transport a request body is sent over. */
export type WireForm = 'http' | 'ws'

/**
 * Keep mid-conversation effort changes on supported GPT-6 and later models
 * in the input, except when the host already carries the change itself.
 *
 * The backend keys its prompt cache on the request-level
 * `reasoning.effort`, so a session that changes effort part-way would have
 * the whole conversation read again uncached. Instead the request-level
 * value stays at the effort the session opened with, and the new effort goes
 * in as `{type: 'configuration_update', reasoning: {effort}}` immediately
 * before the user message that starts the current turn (the last user
 * message of the input). Only the agent loop's requests (`kind` `primary`)
 * take part; a session's first one with an effort pins it.
 *
 * The rule only ever adds to what the host built: it sets the request-level
 * effort back to the pinned value and inserts the one item. It never drops,
 * reorders or edits anything else, and never touches `previous_response_id`.
 * Given the session's pinned effort, the result depends on the body alone.
 *
 * Per form:
 *
 * - HTTP: every request replays the whole conversation, so the item rides
 *   on every request after a change, before the turn's user message; the
 *   tool steps of a turn keep it at the same place, so their prefix stays
 *   cached from one step to the next.
 * - WebSocket: the host chains turns with `previous_response_id` and sends
 *   only the new input items, comparing against its own request as it was
 *   before this rewrite. The server keeps the items it has seen, the
 *   inserted update among them, so the item goes only on a frame whose
 *   input holds a user message (a new turn, or a full resend); a frame that
 *   carries only tool output keeps the pinned request-level effort and
 *   relies on the update already in the server's history. On 2.0.21, when
 *   the user changes effort the host itself sends that turn as a full frame
 *   (its request changed); the frame keeps the pinned effort, so the server
 *   reads the replayed conversation from its cache, and the following
 *   turns go out incremental again.
 *
 * An update is never placed right after another one (the API refuses two in
 * a row), and an input with no user message gets no item. The response
 * keeps reporting the request-level (pinned) effort, as on OpenCode 1.
 */
export class MidConversationEffort {
  readonly #pinned = new Map<string, string>()
  constructor(readonly http = new CodexHttpState()) {}

  /**
   * Applies the rule to one parsed body in place. Returns whether the body
   * changed.
   */
  apply(
    body: Record<string, unknown>,
    scope: { sessionID: string; kind: string },
    form: WireForm,
  ): boolean {
    if (scope.kind !== 'primary') return false
    const model = typeof body.model === 'string' ? body.model : ''
    if (!supportsMidConversationEffort(model)) return false
    if (HOST_EFFORT_UPDATE_MODEL.test(model)) return false
    const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined
    const effort =
      typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
    if (!effort) return false
    const pinned = this.#pinned.get(scope.sessionID)
    if (pinned === undefined) {
      this.#pin(scope.sessionID, effort)
      return false
    }
    if (effort === pinned) return false
    const input = Array.isArray(body.input) ? body.input : undefined
    // With nothing to sit in front of, an update would be the whole request;
    // let the request-level value stand, as OpenCode 1 does.
    if (!input || input.length === 0) return false
    const at = input.findLastIndex(isUserMessage)
    if (at < 0) {
      // On WebSocket this is a frame with only tool output, and the update
      // is already in the server's history from the turn's first frame. Over
      // HTTP every request must carry the update for the new effort to
      // apply, so with no user message to place it before, the host's
      // request-level effort stands.
      if (form === 'http') return false
      body.reasoning = { ...reasoning, effort: pinned }
      return true
    }
    body.reasoning = { ...reasoning, effort: pinned }
    // A full resend after a new user turn moves the single item to the newest
    // user message, so the tail after the old change point is read uncached.
    if (!isConfigurationUpdate(input[at - 1]))
      input.splice(at, 0, {
        type: 'configuration_update',
        reasoning: { effort },
      })
    return true
  }

  forget(sessionID: string): void {
    this.#pinned.delete(sessionID)
    this.http.forget(sessionID)
  }

  #pin(sessionID: string, effort: string) {
    this.#pinned.set(sessionID, effort)
    while (this.#pinned.size > MAX_PINNED_SESSIONS) {
      const oldest = this.#pinned.keys().next().value
      if (oldest === undefined) break
      this.#pinned.delete(oldest)
    }
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export interface CodexRewriteScope {
  readonly sessionID: string
  readonly kind: string
}

/**
 * Shape every Responses HTTP request routed through the pool placeholder.
 * Capture the host's input before rewrites inject or replace items, so
 * a later tool continuation compares against host history, not injected items.
 */
export async function rewriteCodexHttpRequest(
  request: Request,
  scope: CodexRewriteScope,
  effort: MidConversationEffort,
  lite: boolean,
  state: CodexHttpState = effort.http,
  /** Reuse the shaping parse rather than reading the request body again for accounting. */
  onModel?: (model: string) => void,
): Promise<Request | undefined> {
  if (request.method.toUpperCase() !== 'POST') return undefined
  if (!/\/responses\/?$/.test(new URL(request.url).pathname)) return undefined
  const text = await request.clone().text()
  const body = parseObject(text)
  // Codex does not accept output caps. Remove them only after the transport
  // has established that this request belongs to the account pool.
  if (body) delete body.max_output_tokens
  const headers = new Headers(request.headers)
  const session = state.get(scope.sessionID)
  const primary = scope.kind === 'primary'
  const prepared = prepareCodexRequest({
    init: {
      body: body
        ? JSON.stringify(body)
        : request.body === null
          ? undefined
          : text,
    },
    headers,
    metadata: primary
      ? session
      : state.primaryTurns.forAuxiliary(session, state.runtime),
    installationID: state.installationID,
    runtime: state.runtime,
    websocket: false,
    skipTurnUpdate: !primary,
    responsesLite: lite,
    applyEffort: (parsed) => {
      effort.apply(parsed, scope, 'http')
      if (onModel && typeof parsed.model === 'string') onModel(parsed.model)
    },
  })
  if (primary) state.primaryTurns.record(session)
  return new Request(request, { headers, body: prepared.init?.body })
}

/** Replay the conversation through the last completed WebSocket response over HTTP. */
export function codexReplayRequest(
  capture: FrameMirrorCapture,
  url: string,
  socketHeaders: Headers,
  state: CodexHttpState,
): Request | undefined {
  const session = state.sessions.get(capture.sessionID)
  const turn = state.frameTurns.get(capture.sessionID)
  if (!session || !turn) return undefined
  const metadata = frameRequestMetadata(session, turn)
  // Keep routing identity and the host's parent hint, not the handshake bearer.
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const name of [
    'chatgpt-account-id',
    'x-opencode-parent-session-id',
    'x-parent-session-id',
  ]) {
    const value = socketHeaders.get(name)
    if (value !== null) headers.set(name, value)
  }
  // Prepare only HTTP headers. FrameMirrorCapture.bodyText already contains the
  // completed conversation and the WebSocket request's other body fields.
  prepareCodexRequest({
    init: { body: capture.bodyText },
    headers,
    metadata,
    installationID: state.installationID,
    runtime: state.runtime,
    websocket: false,
    skipTurnUpdate: true,
    preserveInstructions: true,
    responsesLite: false,
  })
  const endpoint = new URL(url)
  if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:'
  if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:'
  return new Request(endpoint, {
    method: 'POST',
    headers,
    body: capture.bodyText,
  })
}

/**
 * Whether a frame's `input` as sent matches the host's parsed `input`. The
 * effort rule may insert one `configuration_update` before a user message.
 * On a full frame for GPT-6.2 or later, replayed function calls may also regain
 * their missing `status: 'completed'`.
 *
 * The host computes its next continuation from its own history. The status
 * restoration preserves item count and order, and a continuation sends only
 * new items, so it won't resend the calls whose status was restored.
 */
export function frameInputKept(
  host: unknown,
  sent: unknown,
  fullFrameModel?: unknown,
): boolean {
  if (frameInputMatches(host, sent)) return true
  const restored = restoreReplayedCallStatus(host, fullFrameModel)
  return restored !== host && frameInputMatches(restored, sent)
}

function frameInputMatches(host: unknown, sent: unknown): boolean {
  if (JSON.stringify(host) === JSON.stringify(sent)) return true
  if (
    !Array.isArray(host) ||
    !Array.isArray(sent) ||
    sent.length !== host.length + 1
  )
    return false
  const at = sent.findIndex(
    (item, index) => JSON.stringify(item) !== JSON.stringify(host[index]),
  )
  return (
    at >= 0 &&
    isConfigurationUpdate(sent[at]) &&
    isUserMessage(sent[at + 1]) &&
    JSON.stringify(sent.slice(at + 1)) === JSON.stringify(host.slice(at))
  )
}

/**
 * Shapes one owned `response.create` frame with OpenCode 1's WebSocket request
 * builder (`prepareCodexRequest` with `websocket: true`): the thread cache
 * key, `parallel_tool_calls`, Codex tool shapes, the Codex `client_metadata`
 * (installation, window, turn metadata, send time) and Codex's body key
 * order, with output caps removed. Primary frames use the frame turn and
 * helpers borrow the latest primary turn, even when it was sent over HTTP.
 * Shaping never writes the session's HTTP turn state.
 *
 * `input` keeps the host's items except for the effort rule's
 * `configuration_update` and completed call status restored on full frames
 * for GPT-6.2 or later. The host's next continuation sends only new items;
 * the server keeps the restored calls without any change to their count or
 * order. If anything else changed `input`, the host's input goes out instead.
 * Lite changes the host's input, so it is not applied to a frame the host may chain from.
 */
export function rewriteCodexFrame(
  frame: string,
  scope: CodexRewriteScope,
  effort: MidConversationEffort,
  /** The model is observed from the final frame already parsed for input preservation. */
  onModel?: (model: string) => void,
): string | undefined {
  const body = parseObject(frame)
  if (body?.type !== 'response.create') return undefined
  // The turn rule reads the frame as the host built it, before the effort
  // rule below may insert its item.
  const state = effort.http
  const turn =
    scope.kind === 'primary'
      ? state.advanceFrame(scope.sessionID, body)
      : undefined
  const session = state.get(scope.sessionID)
  const chained = 'previous_response_id' in body
  // Codex does not accept output caps.
  delete body.max_output_tokens
  const prepared = prepareCodexRequest({
    init: { body: JSON.stringify(body) },
    // The socket's handshake headers were fixed when it opened, and the host
    // reuses a socket only while they stay the same. The builder's header
    // edits go to this unused set; the frame's turn metadata travels in its
    // client_metadata.
    headers: new Headers(),
    metadata: turn
      ? frameRequestMetadata(session, turn)
      : state.primaryTurns.forAuxiliary(session, state.runtime),
    installationID: state.installationID,
    runtime: state.runtime,
    websocket: true,
    skipTurnUpdate: !turn,
    responsesLite: false,
    // Hosts before 2.3.2 build incremental frames against their own request
    // shape. Leave instructions where the host put them; 2.3.2 moves the
    // system prompt into input before it computes continuations.
    preserveInstructions: true,
    skipCallStatusRestore: chained,
    applyEffort: (parsed) => {
      effort.apply(parsed, scope, 'ws')
    },
  })
  const sent = parseObject(String(prepared.init?.body))
  if (!sent) return undefined
  if (onModel && typeof sent.model === 'string') onModel(sent.model)
  // `body` is still the host's frame: the builder parsed its own copy.
  if (
    !frameInputKept(body.input, sent.input, chained ? undefined : body.model)
  ) {
    if ('input' in body) sent.input = body.input
    else delete sent.input
    return JSON.stringify(sent)
  }
  return String(prepared.init?.body)
}
