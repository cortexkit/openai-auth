import { orderCodexBody } from './codex-body'
import { restoreReplayedCallStatus } from './codex-call-status'
import { type CodexEffortState, isMessageWithRole } from './codex-effort'
import { moveInstructionsToDeveloperMessage } from './codex-instructions'
import {
  RESPONSES_LITE_HEADER,
  rewriteResponsesLiteBody,
  supportsResponsesLite,
} from './codex-lite'
import { DUMP_SESSION_HEADER } from './dump'
import {
  type CanonicalInput,
  canonicalInput,
  canonicalPrefixLength,
  retainedInput,
} from './util/canonical-input'
import { isRecord } from './util/record'
import { uuidV7 } from './util/uuid-v7'

const CODEX_BETA_FEATURES = 'terminal_resize_reflow'
// gpt-6.2-sol and gpt-6.2-astra require Codex client >= 0.166.0: a request
// answers 400 ("not supported when using Codex with a ChatGPT account") at
// 0.165.0 and completes at 0.166.0, measured 2026-11-18. Older models need
// less: gpt-6.1-sol 0.159.0 (its catalog `minimal_client_version` says
// 0.153.0, which is wrong, so a real request is the evidence, not that field),
// gpt-6-sol and gpt-6-luna 0.155.0, gpt-6-astra 0.153.0. Verified at 0.166.0
// that both 6.2 models, gpt-6.1-sol, gpt-6.1-terra, the three gpt-6 models and
// the three 5.6 variants all complete, so one version serves the whole range.
// gpt-5.5, gpt-5.4, gpt-5.4-mini and gpt-5.3-codex-spark answer 400 at every
// version ("not supported when using Codex with a ChatGPT account") - a
// backend retirement, not something this version causes.
export const CODEX_VERSION = '0.166.0'
export const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
export const CODEX_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  version: CODEX_VERSION,
  'user-agent': CODEX_USER_AGENT,
  originator: 'codex_exec',
}
const CODEX_SANDBOX = 'seccomp'
export const OPENAI_AGENT_HEADER = 'x-openai-auth-agent'

export interface CodexSessionMetadata extends CodexEffortState {
  threadID: string
  turnID: string
  windowID: string
  turnStartedAt?: number
  input?: unknown[]
  canonicalInput?: CanonicalInput
}

export interface CodexRequestRuntime {
  now: () => number
  uuid: () => string
}

function parseJsonObject(input: unknown) {
  if (typeof input !== 'string') return undefined
  try {
    const parsed = JSON.parse(input)
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function startsHttpUserTurn(
  metadata: CodexSessionMetadata,
  input: unknown[],
  canonical: CanonicalInput,
) {
  if (!metadata.input) return input.length > 0
  const prior = metadata.canonicalInput ?? canonicalInput(metadata.input)
  if (canonicalPrefixLength(prior, canonical) === undefined) return true
  const suffix = input.slice(metadata.input.length)
  return suffix.some(
    (item) =>
      isMessageWithRole(item, 'user') || isMessageWithRole(item, 'developer'),
  )
}

export function updateHttpTurnMetadata(
  metadata: CodexSessionMetadata,
  body: Record<string, unknown> | undefined,
  runtime?: CodexRequestRuntime,
) {
  const input = Array.isArray(body?.input) ? body.input : undefined
  const canonical = input
    ? canonicalInput(input, metadata.canonicalInput)
    : undefined
  if (
    input &&
    canonical &&
    (startsHttpUserTurn(metadata, input, canonical) || !metadata.turnID)
  ) {
    metadata.turnID = (runtime?.uuid ?? uuidV7)()
    metadata.turnStartedAt = (runtime?.now ?? Date.now)()
  } else if (!metadata.turnStartedAt) {
    metadata.turnStartedAt = (runtime?.now ?? Date.now)()
  }
  // Copy host history before rewriting input, so tool continuations do
  // not mistake injected input items for the beginning of another user turn.
  if (input && canonical) {
    metadata.input = input.slice()
    metadata.canonicalInput = retainedInput(canonical)
  }
}

export interface CodexShapeInput {
  body?: Record<string, unknown>
  headers: Headers
  /** The selected credential's ChatGPT account id, if not already in headers. */
  accountId?: string
  websocket?: boolean
  responsesLite?: boolean
}

/** Set the transport, Codex client and account headers, without session identity. */
export function applyCodexClientHeaders(
  input: Omit<CodexShapeInput, 'body' | 'responsesLite'>,
) {
  for (const [name, value] of Object.entries(CODEX_CLIENT_HEADERS))
    input.headers.set(name, value)
  input.headers.set('x-codex-beta-features', CODEX_BETA_FEATURES)
  if (input.accountId) input.headers.set('chatgpt-account-id', input.accountId)
  if (input.websocket) {
    // A Codex WebSocket upgrade has neither Accept nor Content-Type.
    input.headers.delete('accept')
    input.headers.delete('content-type')
  } else input.headers.set('accept', 'text/event-stream')
}

/**
 * Shape an owned Responses body in place and return it in wire key order. This
 * does not mint session or turn identifiers. For a primary send, stamp the
 * session first so its cache key can be used to identify the developer message.
 */
export function shapeCodexRequest(
  input: CodexShapeInput,
): Record<string, unknown> | undefined {
  applyCodexClientHeaders(input)
  if (!input.body) return undefined
  const chained = input.websocket && 'previous_response_id' in input.body
  shapeCodexBody(input.body, input.headers, {
    useResponsesLite:
      !input.websocket &&
      Boolean(input.responsesLite) &&
      supportsResponsesLite(input.body.model),
    restoreCallStatus: !chained,
    instructions: chained ? 'drop' : 'move',
  })
  return orderCodexBody(input.body)
}

function shapeCodexBody(
  body: Record<string, unknown>,
  headers: Headers,
  policy: {
    useResponsesLite: boolean
    websocket?: boolean
    restoreCallStatus: boolean
    instructions: 'move' | 'drop' | 'preserve'
    beforePlacement?: () => void
    rewriteLite?: (body: Record<string, unknown>) => void
  },
) {
  if (policy.restoreCallStatus && 'input' in body)
    body.input = restoreReplayedCallStatus(body.input, body.model)
  if (policy.useResponsesLite && !policy.websocket)
    headers.set(RESPONSES_LITE_HEADER, 'true')
  body.parallel_tool_calls ??= true
  if (Array.isArray(body.tools)) body.tools = body.tools.map(normalizeCodexTool)
  policy.beforePlacement?.()
  if (policy.useResponsesLite)
    (policy.rewriteLite ?? rewriteResponsesLiteBody)(body)
  else if (policy.instructions === 'move')
    moveInstructionsToDeveloperMessage(body)
  else if (policy.instructions === 'drop') delete body.instructions
  headers.delete('content-length')
}

export interface CodexSessionStamp {
  body?: Record<string, unknown>
  headers: Headers
  metadata: Readonly<
    Pick<
      CodexSessionMetadata,
      'threadID' | 'turnID' | 'windowID' | 'turnStartedAt'
    >
  >
  installationID: string
  websocket?: boolean
  now?: () => number
}

/** Stamp an already-chosen turn without advancing it or recording host history. */
export function stampCodexSession(input: CodexSessionStamp): void {
  const turnMetadata = stampCodexSessionIdentity(input)
  stampCodexBodyMetadata(input, turnMetadata)
}

function stampCodexSessionIdentity(input: CodexSessionStamp): string {
  const { headers, metadata, body } = input
  const turnMetadata = JSON.stringify({
    session_id: metadata.threadID,
    thread_id: metadata.threadID,
    thread_source: 'user',
    turn_id: metadata.turnID,
    sandbox: CODEX_SANDBOX,
    turn_started_at_unix_ms: metadata.turnStartedAt,
    request_kind: 'turn',
    window_id: metadata.windowID,
  })
  headers.set('session-id', metadata.threadID)
  headers.delete('x-session-id')
  headers.delete('x-session-affinity')
  headers.set('thread-id', metadata.threadID)
  headers.set('x-codex-window-id', metadata.windowID)
  // Codex uses the thread UUID, not a new per-request UUID.
  headers.set('x-client-request-id', metadata.threadID)
  headers.set('x-codex-turn-metadata', turnMetadata)
  if (body) body.prompt_cache_key = metadata.threadID
  return turnMetadata
}

function stampCodexBodyMetadata(
  input: CodexSessionStamp,
  turnMetadata: string,
  useResponsesLite = false,
) {
  if (!input.body) return
  const prior = input.body.client_metadata
  const clientMetadata: Record<string, unknown> = {
    ...(typeof prior === 'object' && prior !== null ? prior : {}),
    'x-codex-installation-id': input.installationID,
    'x-codex-window-id': input.metadata.windowID,
  }
  if (input.websocket) {
    clientMetadata['x-codex-turn-metadata'] = turnMetadata
    clientMetadata['x-codex-ws-stream-request-start-ms'] = String(
      (input.now ?? Date.now)(),
    )
    if (useResponsesLite)
      clientMetadata.ws_request_header_x_openai_internal_codex_responses_lite =
        'true'
  }
  input.body.client_metadata = clientMetadata
}

/** OpenCode's request policy, including the legacy unstamped pass-through. */
export function prepareCodexRequest(input: {
  init: RequestInit | undefined
  headers: Headers
  metadata: CodexSessionMetadata | undefined
  installationID: string
  websocket: boolean
  responsesLite: boolean
  dumpSessionID?: string
  runtime?: CodexRequestRuntime
  /** Background replays read the turn without recording history. Defaults to false. */
  skipTurnUpdate?: boolean
  preserveInstructions?: boolean
  /** OpenCode 2 owns the history of frames it sends with previous_response_id. */
  skipCallStatusRestore?: boolean
  /** Each host owns its effort policy; it runs once, after host-history capture. */
  applyEffort?: (
    body: Record<string, unknown>,
    metadata: CodexSessionMetadata,
    agent: string | null,
  ) => void
  rewriteLite?: (body: Record<string, unknown>) => void
}): { init: RequestInit | undefined } {
  // Remove the private agent tag even when no session metadata is available.
  const agent = input.headers.get(OPENAI_AGENT_HEADER)
  input.headers.delete(OPENAI_AGENT_HEADER)
  const metadata = input.metadata
  if (!metadata) return { init: input.init }
  const body = parseJsonObject(input.init?.body)
  const now = input.runtime?.now ?? Date.now
  if (!input.skipTurnUpdate) {
    if (!input.websocket) updateHttpTurnMetadata(metadata, body, input.runtime)
    else if (!metadata.turnStartedAt) metadata.turnStartedAt = now()
    if (!metadata.turnStartedAt) metadata.turnStartedAt = now()
  }
  applyCodexClientHeaders(input)
  const stamp = { ...input, metadata, body, now }
  const turnMetadata = stampCodexSessionIdentity(stamp)
  if (input.dumpSessionID)
    input.headers.set(DUMP_SESSION_HEADER, input.dumpSessionID)

  if (!body) return { init: input.init }
  const useResponsesLite =
    input.responsesLite && supportsResponsesLite(body.model)
  shapeCodexBody(body, input.headers, {
    // OpenCode 1's pool already knows how to carry Lite on WebSocket frames.
    useResponsesLite,
    websocket: input.websocket,
    restoreCallStatus: !input.skipCallStatusRestore,
    instructions: input.preserveInstructions ? 'preserve' : 'move',
    beforePlacement: () => input.applyEffort?.(body, metadata, agent),
    rewriteLite: input.rewriteLite,
  })
  stampCodexBodyMetadata(stamp, turnMetadata, useResponsesLite)
  return {
    init: { ...input.init, body: JSON.stringify(orderCodexBody(body)) },
  }
}

// Match Codex's function-tool shape, preserving third-party extensions.
export function normalizeCodexTool(tool: unknown) {
  if (!isRecord(tool) || tool.type !== 'function') return tool
  const parameters =
    isRecord(tool.parameters) && '$schema' in tool.parameters
      ? (() => {
          const { $schema: _schema, ...rest } = tool.parameters
          return rest
        })()
      : tool.parameters
  const { type, name, description, strict, parameters: _p, ...extra } = tool
  return {
    type,
    name,
    description,
    strict: strict ?? false,
    parameters,
    ...extra,
  }
}
