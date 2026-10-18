import { isRecord } from '@cortexkit/openai-auth-core/internal'
import { orderCodexBody } from './codex-body'
import { DUMP_SESSION_HEADER } from './dump'
import {
  type CanonicalInput,
  canonicalInput,
  canonicalPrefixLength,
  retainedInput,
} from './util/canonical-input'
import { uuidV7 } from './util/uuid-v7'

// Models whose Codex catalog entry supports the compact Responses Lite shape.
export const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
])
const CODEX_BETA_FEATURES = 'terminal_resize_reflow'
// gpt-6.1-sol requires Codex client >= 0.159.0: the backend's model catalog
// lists it from 0.159.0 and a request answers 400 ("not supported when using
// Codex with a ChatGPT account") at 0.158.0, measured 2026-09-29. Its catalog
// `minimal_client_version` says 0.153.0, which is wrong, so the catalog listing
// and a real request are the evidence, not that field. gpt-6-sol and gpt-6-luna
// need 0.155.0 and gpt-6-astra 0.153.0. Verified at 0.159.0 that gpt-6.1-sol,
// the three gpt-6 models, gpt-5.5 and the three 5.6 variants all complete, so
// one version serves the whole range. gpt-5.4, gpt-5.4-mini and
// gpt-5.3-codex-spark answer 400 at every version ("not supported when using
// Codex with a ChatGPT account") - a backend retirement, not something this
// version causes.
export const CODEX_VERSION = '0.159.0'
export const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
const CODEX_SANDBOX = 'seccomp'
export const OPENAI_AGENT_HEADER = 'x-openai-auth-agent'

export interface CodexSessionMetadata {
  threadID: string
  turnID: string
  windowID: string
  turnStartedAt?: number
  input?: unknown[]
  canonicalInput?: CanonicalInput
  /** Keep the opening effort fixed while later changes travel as input items. */
  pinnedEffort?: string
  effortUpdates?: Array<{ anchor: number; fingerprint: string; effort: string }>
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

export function isMessageWithRole(item: unknown, role: string) {
  return (
    isRecord(item) &&
    (item.type === 'message' || 'role' in item) &&
    item.role === role
  )
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
  // Copy host history before effort or Lite rewrites, so tool continuations do
  // not mistake injected input items for the beginning of another user turn.
  if (input && canonical) {
    metadata.input = input.slice()
    metadata.canonicalInput = retainedInput(canonical)
  }
}

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
  /** Each host owns its effort policy; it runs once, after host-history capture. */
  applyEffort?: (
    body: Record<string, unknown>,
    metadata: CodexSessionMetadata,
    agent: string | null,
  ) => void
  rewriteLite: (body: Record<string, unknown>) => void
}): { init: RequestInit | undefined } {
  // Remove the private agent tag even when no session metadata is available.
  const agent = input.headers.get(OPENAI_AGENT_HEADER)
  input.headers.delete(OPENAI_AGENT_HEADER)
  if (!input.metadata) return { init: input.init }
  const body = parseJsonObject(input.init?.body)
  const now = input.runtime?.now ?? Date.now
  if (!input.skipTurnUpdate) {
    if (!input.websocket)
      updateHttpTurnMetadata(input.metadata, body, input.runtime)
    else if (!input.metadata.turnStartedAt) input.metadata.turnStartedAt = now()
    if (!input.metadata.turnStartedAt) input.metadata.turnStartedAt = now()
  }
  // HTTP compares the host's full conversation history to find a new user turn.
  // WebSocket turn identity is finalized by the pool after choosing which input
  // suffix to send, including its optional cache-warming request.
  const turnMetadata = JSON.stringify({
    session_id: input.metadata.threadID,
    thread_id: input.metadata.threadID,
    thread_source: 'user',
    turn_id: input.metadata.turnID,
    sandbox: CODEX_SANDBOX,
    turn_started_at_unix_ms: input.metadata.turnStartedAt,
    request_kind: 'turn',
    window_id: input.metadata.windowID,
  })
  input.headers.set('originator', 'codex_exec')
  if (input.websocket) {
    // Codex's WebSocket upgrade carries neither Accept nor Content-Type.
    input.headers.delete('accept')
    input.headers.delete('content-type')
  } else input.headers.set('accept', 'text/event-stream')
  input.headers.set('session-id', input.metadata.threadID)
  input.headers.delete('x-session-id')
  input.headers.delete('x-session-affinity')
  input.headers.set('thread-id', input.metadata.threadID)
  input.headers.set('x-codex-window-id', input.metadata.windowID)
  // Codex uses the thread UUID, not a new per-request UUID.
  input.headers.set('x-client-request-id', input.metadata.threadID)
  input.headers.set('x-codex-beta-features', CODEX_BETA_FEATURES)
  input.headers.set('x-codex-turn-metadata', turnMetadata)
  input.headers.set('user-agent', CODEX_USER_AGENT)
  input.headers.set('version', CODEX_VERSION)
  if (input.dumpSessionID)
    input.headers.set(DUMP_SESSION_HEADER, input.dumpSessionID)

  const parsed = body
  if (!parsed) return { init: input.init }
  const useResponsesLite =
    input.responsesLite &&
    typeof parsed.model === 'string' &&
    RESPONSES_LITE_MODELS.has(parsed.model)
  if (useResponsesLite && !input.websocket)
    input.headers.set('x-openai-internal-codex-responses-lite', 'true')
  parsed.prompt_cache_key = input.metadata.threadID
  parsed.parallel_tool_calls ??= true
  if (Array.isArray(parsed.tools))
    parsed.tools = parsed.tools.map(normalizeCodexTool)
  input.applyEffort?.(parsed, input.metadata, agent)
  if (useResponsesLite) input.rewriteLite(parsed)
  const clientMetadata: Record<string, unknown> = {
    ...(typeof parsed.client_metadata === 'object' &&
    parsed.client_metadata !== null
      ? parsed.client_metadata
      : {}),
    'x-codex-installation-id': input.installationID,
    'x-codex-window-id': input.metadata.windowID,
  }
  if (input.websocket) {
    clientMetadata['x-codex-turn-metadata'] = turnMetadata
    clientMetadata['x-codex-ws-stream-request-start-ms'] = String(now())
    if (useResponsesLite)
      clientMetadata.ws_request_header_x_openai_internal_codex_responses_lite =
        'true'
  }
  parsed.client_metadata = clientMetadata
  input.headers.delete('content-length')
  input.headers.delete('Content-Length')
  return {
    init: { ...input.init, body: JSON.stringify(orderCodexBody(parsed)) },
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
