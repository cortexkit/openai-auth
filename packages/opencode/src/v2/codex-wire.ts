// What openai-auth changes in the requests OpenCode 2's own OpenAI driver
// sends, so they match what it sends from OpenCode 1 (`prepareCodexRequest`
// in `src/index.ts`):
//
// - the Codex client identity (`version`, `user-agent`, `originator`), sent
//   as header edits with the account headers. They never change within a
//   session: the host keys a session's WebSocket on its handshake headers,
//   so a header that changed between requests would open a new socket and
//   resend the whole conversation;
// - a mid-conversation reasoning-effort change carried as a
//   `configuration_update` item while the request-level effort stays at the
//   session's first value (`MidConversationEffort`), on HTTP bodies and on
//   WebSocket frames;
// - the Responses Lite body for the models marked Lite, on HTTP only
//   (`responsesLiteHttpBody`; why not on WebSocket is explained there).

import {
  CODEX_USER_AGENT,
  CODEX_VERSION,
  MID_CONVERSATION_EFFORT_MODELS,
  RESPONSES_LITE_MODELS,
  rewriteResponsesLiteBody,
} from '../index'

/** The Codex client identity, sent with every request of the provider. */
export const CODEX_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  version: CODEX_VERSION,
  'user-agent': CODEX_USER_AGENT,
  originator: 'codex_exec',
  'x-codex-beta-features': 'terminal_resize_reflow',
}

/** The header OpenCode 1 sends on an HTTP request in the Lite shape. */
export const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'

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
 * OpenCode 1's mid-conversation effort rule (`applyMidConversationEffort`),
 * for the models where a `configuration_update` item is known to change
 * effort (`MID_CONVERSATION_EFFORT_MODELS`) and the host does not carry the
 * change itself (`HOST_EFFORT_UPDATE_MODEL`): `gpt-6.1-sol`, which only
 * 2.0.21 needs it for.
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
    if (!MID_CONVERSATION_EFFORT_MODELS.has(model)) return false
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
    if (!isConfigurationUpdate(input[at - 1]))
      input.splice(at, 0, {
        type: 'configuration_update',
        reasoning: { effort },
      })
    return true
  }

  forget(sessionID: string): void {
    this.#pinned.delete(sessionID)
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

/**
 * The Responses Lite request shape (`rewriteResponsesLiteBody`, opt-in with
 * the `responsesLite` setting) for a model marked Lite, applied to an HTTP
 * body in place. Returns whether the body was rewritten; the caller then
 * adds `RESPONSES_LITE_HEADER`.
 *
 * Not applied to WebSocket frames: the Lite shape moves `tools` and
 * `instructions` into input items and strips image `detail` from the input,
 * which takes away and changes what the host put in the frame. The host
 * chains turns from its own request as it was before the frame rewrite, so
 * the server would hold a conversation the host's next incremental frame no
 * longer lines up with. A Lite model on WebSocket is sent in the standard
 * shape, which the backend serves as well.
 */
export function responsesLiteHttpBody(body: Record<string, unknown>): boolean {
  if (typeof body.model !== 'string' || !RESPONSES_LITE_MODELS.has(body.model))
    return false
  rewriteResponsesLiteBody(body)
  return true
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
 * The HTTP rewrite: the effort rule, then the Lite shape when `lite` is on.
 * Returns the request to send, or undefined to send the host's own.
 */
export async function rewriteCodexHttpRequest(
  request: Request,
  scope: CodexRewriteScope,
  effort: MidConversationEffort,
  lite: boolean,
): Promise<Request | undefined> {
  if (request.method.toUpperCase() !== 'POST' || request.body === null)
    return undefined
  if (!/\/responses\/?$/.test(new URL(request.url).pathname)) return undefined
  const body = parseObject(await request.clone().text())
  if (!body) return undefined
  const effortChanged = effort.apply(body, scope, 'http')
  const liteApplied = lite && responsesLiteHttpBody(body)
  if (!effortChanged && !liteApplied) return undefined
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  if (liteApplied) headers.set(RESPONSES_LITE_HEADER, 'true')
  return new Request(request, { headers, body: JSON.stringify(body) })
}

/** The WebSocket frame rewrite: the effort rule. Undefined keeps the frame. */
export function rewriteCodexFrame(
  frame: string,
  scope: CodexRewriteScope,
  effort: MidConversationEffort,
): string | undefined {
  const body = parseObject(frame)
  if (body?.type !== 'response.create') return undefined
  return effort.apply(body, scope, 'ws') ? JSON.stringify(body) : undefined
}
