import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'

import {
  buildDialogPayload,
  type CommandContext,
  MODAL_COMMANDS,
  OPENAI_ACCOUNT_COMMAND_NAME,
  OPENAI_CACHEKEEP_COMMAND_NAME,
  OPENAI_DUMP_COMMAND_NAME,
  OPENAI_KILLSWITCH_COMMAND_NAME,
  OPENAI_LOGGING_COMMAND_NAME,
  OPENAI_QUOTA_COMMAND_NAME,
  OPENAI_ROUTING_COMMAND_NAME,
} from './commands'
import { getConfigDir, getConfigPath, getSettings } from './config'
import {
  type AccountStorage,
  type FallbackAccount,
  FallbackAccountManager,
  isCostZeroingEnabled,
  isKillswitchEnabled,
  isOAuthAccount,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  migrateIfNeeded,
  mutateAccounts,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type RoutingMode,
  shouldFallbackStatus,
} from './core/accounts'
import {
  BackgroundQuotaRefresh,
  refreshQuotaInBackground,
} from './core/background-quota-refresh'
import {
  buildRefreshOperationError,
  formatRefreshBackoffMessage,
  hashRefreshToken,
  refreshBackoffActive,
} from './core/backoff'
import {
  buildKeepwarmCapture,
  CacheKeepManager,
  getCacheKeepWindow,
} from './core/cachekeep'
import {
  base64UrlEncode,
  beginDeviceAuth,
  buildAuthorizeUrl,
  completeDeviceAuth,
  extractAccountId,
  extractAccountIdFromClaims,
  flowCleanup,
  generatePKCE,
  parseJwtClaims,
  startOAuthServer,
  USER_AGENT,
  waitForOAuthCallback,
} from './core/oauth'
import { codexRefreshFn, whamUsageFn } from './core/provider'
import {
  QuotaManager,
  resolveMidStreamRateLimitResetAt,
} from './core/quota-manager'
import { refreshAllQuota } from './core/refresh-all-quota'
import { acquireRefreshFileLock } from './core/refresh-file-lock'
import { DUMP_SESSION_HEADER, dumpCodexRequest } from './dump'
import {
  HostedWebSearchTool,
  rewriteHostedWebSearchReplay,
  translateHostedWebSearchResponse,
} from './hosted-web-search'
import { createLogger, setLogLevel } from './logger'
import { loadModelsDevCosts } from './model-costs'
import { resolvePromptContext } from './prompt-context'
import {
  isCompleteQuotaHeaderFrame,
  normalizeQuotaHeaders,
} from './quota-normalize'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
} from './rpc/notifications'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
} from './rpc/protocol'
import { getRpcDir } from './rpc/rpc-dir'
import { type RpcServerHandle, startRpcServer } from './rpc/rpc-server'
import {
  type AccountQuota,
  getSidebarState,
  getSidebarStateFile,
  type QuotaWindow,
  removeSidebarActiveRouting,
  type SidebarMachineState,
  type SidebarState,
  setSidebarLegacyRouting,
  setSidebarMachineState,
  upsertSidebarActiveRouting,
} from './sidebar-state'
import { errorMessage } from './util/error'
import { isRecord } from './util/record'
import { stableStringify } from './util/stable-json'
import { uuidV7 } from './util/uuid-v7'
import { OpenAIWebSocketPool, orderCodexBody } from './ws-pool'

const ALLOWED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
])
// The suffix-less gpt-5.6 model is rejected by the Codex OAuth backend
// ("not supported when using Codex with a ChatGPT account"); only the
// -luna/-sol/-terra variants work. Its -fast/-pro synthetics inherit the same
// api.id ("gpt-5.6"), so filtering on api.id drops them all at once while
// keeping the working variants (api.id gpt-5.6-luna, etc.).
const DISALLOWED_MODELS = new Set(['gpt-5.6'])
// Exact models currently marked `use_responses_lite` in Codex's catalog.
const RESPONSES_LITE_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
])
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key'
const CODEX_BETA_FEATURES = 'terminal_resize_reflow'
// gpt-5.6 requires Codex client >= 0.144.0 (older versions 400 with "requires a
// newer version of Codex"). 0.144.0 also works for gpt-5.4/5.5, so the bump is
// safe across the whole model range.
const CODEX_VERSION = '0.144.0'
const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
const CODEX_SANDBOX = 'seccomp'
const MAIN_REFRESH_LOCK_NAME = 'main-refresh'
export const MAIN_REFRESH_LOCK_TTL_MS = 2 * 60_000
export const MAIN_REFRESH_LEASE_TTL_MS = 90_000
const CONCURRENT_MAIN_REFRESH_WAIT_MS = 4_000
const CONCURRENT_MAIN_REFRESH_POLL_BASE_MS = 50
const AUTH_SET_MAX_ATTEMPTS = 3
const AUTH_SET_RETRY_BASE_MS = 25
// Fallback reset window for a mid-stream rate-limit mark when no cached quota
// snapshot resolves a real reset time. Conservative and short: if the account
// is still exhausted next turn, the next response.failed frame re-marks it.
const DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS = 60_000

const HANDLED_SENTINEL = '__OPENCODE_OPENAI_AUTH_COMMAND_HANDLED__'

let bootQuotaSeedStarted = false
const logModels = createLogger('models')
let loggedCostRestoration = false
let warnedCostCatalogUnavailable = false

export class AuthPersistError extends Error {
  readonly code = 'OPENAI_AUTH_PERSIST_FAILED'

  constructor(cause: unknown) {
    super(
      'OpenAI OAuth token refreshed but could not be persisted; re-login required',
      { cause },
    )
    this.name = 'AuthPersistError'
  }
}

function isAuthPersistError(error: unknown): error is AuthPersistError {
  return error instanceof AuthPersistError
}

function cleanAbort(): never {
  throw new Error(HANDLED_SENTINEL)
}

function jitterMs(baseMs: number) {
  return Math.floor(Math.random() * baseMs)
}

export {
  extractAccountIdFromClaims,
  type IdTokenClaims,
  parseJwtClaims,
} from './core/oauth'

interface CodexAuthPluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
  responsesLite?: boolean
}

interface CodexSessionMetadata {
  threadID: string
  turnID: string
  windowID: string
  turnStartedAt?: number
  input?: unknown[]
}

interface PersistedCodexSessions {
  version?: number
  sessions?: Record<string, { threadID?: unknown }>
}

interface PreparedCodexRequest {
  init: RequestInit | undefined
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

// Real Codex mints the session/thread id (which becomes prompt_cache_key,
// session-id, thread-id, x-client-request-id, window_id) as a UUIDv7 — a
// time-ordered id whose first 48 bits are the unix-ms timestamp. crypto.randomUUID()
// only produces UUIDv4 (uniform random). OpenAI's prompt_cache_key is a routing
// hint; matching Codex's v7 shape exactly removes the only remaining wire-level
// difference from the Codex client when probing prompt-cache routing behavior.
function getCodexSessionMetadata(
  sessions: Map<string, CodexSessionMetadata>,
  sessionID: string,
  persist?: () => void,
): CodexSessionMetadata {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const threadID = uuidV7()
  const next: CodexSessionMetadata = {
    threadID,
    turnID: uuidV7(),
    windowID: `${threadID}:0`,
  }
  sessions.set(sessionID, next)
  persist?.()
  return next
}

function codexSessionStatePath() {
  return join(getConfigDir(), 'openai-auth-sessions.json')
}

function loadCodexSessions(): Map<string, CodexSessionMetadata> {
  const sessions = new Map<string, CodexSessionMetadata>()
  try {
    const parsed = JSON.parse(
      readFileSync(codexSessionStatePath(), 'utf8'),
    ) as PersistedCodexSessions
    if (!isRecord(parsed.sessions)) return sessions
    for (const [sessionID, state] of Object.entries(parsed.sessions)) {
      if (!isRecord(state) || typeof state.threadID !== 'string') continue
      sessions.set(sessionID, {
        threadID: state.threadID,
        turnID: uuidV7(),
        windowID: `${state.threadID}:0`,
      })
    }
  } catch {
    // Missing or malformed state should not break auth.
  }
  return sessions
}

function saveCodexSessions(sessions: Map<string, CodexSessionMetadata>): void {
  const path = codexSessionStatePath()
  const tmp = `${path}.tmp-${process.pid}`
  try {
    mkdirSync(getConfigDir(), { recursive: true })
    const payload: PersistedCodexSessions = {
      version: 1,
      sessions: Object.fromEntries(
        [...sessions.entries()].map(([sessionID, state]) => [
          sessionID,
          { threadID: state.threadID },
        ]),
      ),
    }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // State persistence only improves cache continuity; never fail a request.
  }
}

function isMessageWithRole(item: unknown, role: string) {
  return (
    isRecord(item) &&
    (item.type === 'message' || 'role' in item) &&
    item.role === role
  )
}

function hasInputPrefix(prefix: unknown[], input: unknown[]) {
  if (prefix.length > input.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index]))
      return false
  }
  return true
}

function startsHttpUserTurn(metadata: CodexSessionMetadata, input: unknown[]) {
  if (!metadata.input) return input.length > 0
  if (!hasInputPrefix(metadata.input, input)) return true
  const suffix = input.slice(metadata.input.length)
  return suffix.some(
    (item) =>
      isMessageWithRole(item, 'user') || isMessageWithRole(item, 'developer'),
  )
}

function updateHttpTurnMetadata(
  metadata: CodexSessionMetadata,
  body: Record<string, unknown> | undefined,
) {
  const input = Array.isArray(body?.input) ? body.input : undefined
  if (input && (startsHttpUserTurn(metadata, input) || !metadata.turnID)) {
    metadata.turnID = uuidV7()
    metadata.turnStartedAt = Date.now()
  } else if (!metadata.turnStartedAt) {
    metadata.turnStartedAt = Date.now()
  }
  if (input) metadata.input = input
}

function prepareCodexRequest(input: {
  init: RequestInit | undefined
  headers: Headers
  metadata: CodexSessionMetadata | undefined
  installationID: string
  websocket: boolean
  responsesLite: boolean
  dumpSessionID?: string
}): PreparedCodexRequest {
  if (!input.metadata) return { init: input.init }
  const body = parseJsonObject(input.init?.body)
  if (!input.websocket) updateHttpTurnMetadata(input.metadata, body)
  else if (!input.metadata.turnStartedAt)
    input.metadata.turnStartedAt = Date.now()
  if (!input.metadata.turnStartedAt) input.metadata.turnStartedAt = Date.now()
  // Base turn-metadata. HTTP sends full replay bodies, so we detect fresh user turns from append-only
  // input growth above. The WebSocket path still overrides turn_id/turn_started_at in ws-pool.ts
  // after continuation trimming/prewarm selection.
  // Codex turn-metadata schema (exact field set + order; no request_id/originator):
  // { session_id, thread_id, thread_source, turn_id, sandbox, turn_started_at_unix_ms, request_kind, window_id }
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
  } else {
    input.headers.set('accept', 'text/event-stream')
  }
  input.headers.set('session-id', input.metadata.threadID)
  input.headers.delete('x-session-id')
  input.headers.delete('x-session-affinity')
  input.headers.set('thread-id', input.metadata.threadID)
  input.headers.set('x-codex-window-id', input.metadata.windowID)
  // Codex uses the session/thread UUID as x-client-request-id (not a fresh per-request id).
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
  removeHostedWebSearchFunctionTool(parsed)
  removeExaWebSearchFunctionTool(parsed)
  rewriteHostedWebSearchReplay(parsed)
  maybeInjectCacheStabilizerTool(parsed)
  if (useResponsesLite) rewriteResponsesLiteBody(parsed)
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
    clientMetadata['x-codex-ws-stream-request-start-ms'] = String(Date.now())
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

export function findCachekeepFallbackAccount(
  accounts: FallbackAccount[],
  accountId: string,
): OAuthAccount | undefined {
  return accounts.find(
    (a): a is OAuthAccount =>
      a.enabled !== false &&
      isOAuthAccount(a) &&
      (a.id === accountId || a.accountId === accountId),
  )
}

// wham is the only source that reports reset-credit counts; header/WS pushes
// never carry the field. An incoming push that omits it inherits the last
// known count for the same account so the sidebar does not flicker it away
// on every per-turn header/WS update — but an explicit incoming value
// (including 0) always wins over a stale cached one.
export function mergePushedQuotaMetadata(
  incoming: OAuthQuotaSnapshot,
  previous: OAuthQuotaSnapshot | undefined,
): OAuthQuotaSnapshot {
  if (
    incoming.resetCreditsAvailable !== undefined ||
    previous?.resetCreditsAvailable === undefined
  ) {
    return incoming
  }
  return {
    ...incoming,
    resetCreditsAvailable: previous.resetCreditsAvailable,
  }
}

// Returns the window unchanged when it already carries a usable checkedAt, or
// the same window with the entry timestamp stamped onto it when it does not.
// Absent windows are returned unchanged so we never fabricate a slot the wire
// did not report. The stamp keeps mergeQuotaByWindow's per-window freshness
// comparison meaningful against files written without window stamps (old code
// only wrote the snapshot-level checkedAt).
function stampWindowCheckedAt(
  window: QuotaWindow | undefined,
  entryCheckedAt: number,
): QuotaWindow | undefined {
  if (!window) return window
  if (
    typeof window.checkedAt === 'number' &&
    Number.isFinite(window.checkedAt)
  ) {
    return window
  }
  return { ...window, checkedAt: entryCheckedAt }
}

export function buildSidebarMachineState(
  qm: QuotaManager,
  store: AccountStorage,
  now = Date.now(),
): SidebarMachineState {
  const mainEntry = qm.getMain()
  const mainQuota = mainEntry?.quota
  return {
    main: {
      quota: mainQuota
        ? {
            ...(mainQuota as AccountQuota),
            checkedAt: mainEntry.checkedAt,
            primary: stampWindowCheckedAt(
              mainQuota.primary,
              mainEntry.checkedAt,
            ),
            secondary: stampWindowCheckedAt(
              mainQuota.secondary,
              mainEntry.checkedAt,
            ),
          }
        : null,
      mainAccountId: store.mainAccountId,
      killed: false,
      ...(mainQuota?.resetCreditsAvailable !== undefined
        ? { resetCredits: mainQuota.resetCreditsAvailable }
        : {}),
    },
    fallbacks: store.accounts
      .filter((account) => account.enabled)
      .map((account) => {
        const fallbackEntry = qm.getFallback(account.id)
        const fallbackQuota = fallbackEntry?.quota
        return {
          id: account.id,
          label: (account as { label?: string }).label,
          // Identity follows the cached snapshot (the identity that quota was
          // captured under), falling back to the live account — so a re-login
          // never pairs the previous identity's stale quota with the new one.
          accountId:
            fallbackEntry?.accountId ?? (account as OAuthAccount).accountId,
          quota: fallbackQuota
            ? {
                ...(fallbackQuota as AccountQuota),
                checkedAt: fallbackEntry.checkedAt,
                primary: stampWindowCheckedAt(
                  fallbackQuota.primary,
                  fallbackEntry.checkedAt,
                ),
                secondary: stampWindowCheckedAt(
                  fallbackQuota.secondary,
                  fallbackEntry.checkedAt,
                ),
              }
            : null,
          killed: false,
          enabled: true,
          ...(fallbackQuota?.resetCreditsAvailable !== undefined
            ? { resetCredits: fallbackQuota.resetCreditsAvailable }
            : {}),
        }
      }),
    route: store.routing?.mode ?? 'main-first',
    lastUpdated: now,
  }
}

export function buildSidebarState(
  qm: QuotaManager,
  store: AccountStorage,
  activeId: string,
  now = Date.now(),
): SidebarState {
  return { ...buildSidebarMachineState(qm, store, now), activeId }
}

function effectiveRequestHeaders(
  requestInput: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers)
  if (requestInput instanceof Request) return new Headers(requestInput.headers)
  return new Headers()
}

async function materializeRequestInit(
  requestInput: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
  if (!(requestInput instanceof Request)) return init
  const request = new Request(requestInput, init)
  const method = request.method.toUpperCase()
  const body =
    method === 'GET' || method === 'HEAD' || request.body === null
      ? undefined
      : await request.text()
  return {
    method: request.method,
    headers: new Headers(request.headers),
    body,
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  }
}

export function resolveSidebarSessionId(headers: Headers): string | undefined {
  return (
    headers.get('x-session-affinity') ??
    headers.get('x-opencode-session') ??
    headers.get('x-session-id') ??
    headers.get('session-id') ??
    undefined
  )
}

// Prompt-cache stabilizer (ON by default; opt out via config `webSearch: false` or
// CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH=1 — env wins over config).
//
// The Codex `responses` backend only puts a request on the STABLE prompt-cache path when its
// OpenAI's prompt-cache path for tool-continuation requests is hashed against
// the tool type set. Requests carrying only custom `function` tools can
// intermittently fail to hit the cache, dropping cached_tokens to 0.
// Appending a native `web_search` tool — which executes server-side and is
// never actually invoked by the model on coding tasks — redirects every
// tool-bearing request onto the stable cache path. Only injected when the
// request already carries tools (agentic turns); tool-less requests have no
// cache-continuation risk and are left untouched.
function maybeInjectCacheStabilizerTool(parsed: Record<string, unknown>) {
  if (!getSettings().webSearch) return
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return
  if (parsed.tools.some((t) => isRecord(t) && t.type === 'web_search')) return
  parsed.tools = [
    ...parsed.tools,
    {
      type: 'web_search',
      external_web_access: false,
      search_content_types: ['text', 'image'],
    },
  ]
}

function stripResponsesLiteImageDetails(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) stripResponsesLiteImageDetails(item)
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'input_image') delete value.detail
  for (const nested of Object.values(value))
    stripResponsesLiteImageDetails(nested)
}

// Responses Lite trades capabilities for Codex's compact request shape. It is
// opt-in because it disables parallel tool calls and excludes hosted tools.
function rewriteResponsesLiteBody(parsed: Record<string, unknown>) {
  const reasoning = isRecord(parsed.reasoning) ? { ...parsed.reasoning } : {}
  reasoning.context = 'all_turns'
  parsed.reasoning = reasoning
  parsed.parallel_tool_calls = false

  const input = Array.isArray(parsed.input) ? parsed.input : []
  stripResponsesLiteImageDetails(input)
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter(
        (tool) => !(isRecord(tool) && tool.type === 'web_search'),
      )
    : []
  const prefix: unknown[] = [
    { type: 'additional_tools', role: 'developer', tools },
  ]
  if (
    typeof parsed.instructions === 'string' &&
    parsed.instructions.length > 0
  ) {
    prefix.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: parsed.instructions }],
    })
  }
  parsed.input = [...prefix, ...input]
  delete parsed.tools
  delete parsed.instructions
}

function removeHostedWebSearchFunctionTool(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.tools)) return
  parsed.tools = parsed.tools.filter(
    (item) =>
      !(
        isRecord(item) &&
        item.type === 'function' &&
        item.name === 'web_search'
      ),
  )
}

function removeExaWebSearchFunctionTool(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.tools)) return
  parsed.tools = parsed.tools.filter(
    (item) =>
      !(
        isRecord(item) &&
        item.type === 'function' &&
        item.name === 'websearch_web_search_exa'
      ),
  )
}

// Match Codex's function-tool shape: drop the JSON-Schema `$schema` dialect marker
// (Codex omits it) and mark function tools `strict: false` as Codex does.
function normalizeCodexTool(tool: unknown) {
  if (!isRecord(tool)) return tool
  if (tool.type !== 'function') return tool
  const parameters =
    isRecord(tool.parameters) && '$schema' in tool.parameters
      ? (() => {
          const { $schema: _schema, ...rest } = tool.parameters as Record<
            string,
            unknown
          >
          return rest
        })()
      : tool.parameters
  // Codex function-tool key order: type, name, description, strict, parameters (+ any extras).
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

export async function CodexAuthPlugin(
  input: PluginInput,
  options: CodexAuthPluginOptions = {},
): Promise<Hooks> {
  const codexApiEndpoint =
    options.codexApiEndpoint ?? getSettings().codexApiEndpoint
  const installationID = crypto.randomUUID()
  const codexSessions = loadCodexSessions()
  const persistCodexSessions = () => saveCodexSessions(codexSessions)
  let websocketFetchInstalled = false
  const websocketFetches: Array<
    ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>
  > = []

  // Command context holder — filled by the auth loader on first run.
  // command.execute.before reads this; if null (auth not loaded yet),
  // the command is rejected with a message.
  let cmdCtx: CommandContext | null = null
  let activeRpcServer: RpcServerHandle | null = null
  let sidebarStateFileForEvents: string | undefined

  // Per-loader poller: each plugin invocation owns its timer and callback, so
  // one loader disposing or re-starting never stops or overwrites another's
  // background refresh (a module-level singleton let the last loader win and
  // let any disposal kill the shared poller).
  const backgroundQuotaRefresh = new BackgroundQuotaRefresh()

  async function sendIgnoredMessage(sessionId: string, text: string) {
    const session = input.client.session as
      | { promptAsync?: (req: unknown) => Promise<unknown> }
      | undefined
    if (typeof session?.promptAsync === 'function') {
      // OpenCode records this hidden noReply message as a user message. Without
      // the previous model/variant, its next real prompt inherits the synthetic
      // default and can silently drop a selected reasoning variant. Thread the
      // last assistant's model/agent/variant so the user's selection is kept.
      const promptContext = await resolvePromptContext(input.client, sessionId)
      const body: Record<string, unknown> = {
        noReply: true,
        parts: [{ type: 'text', text, ignored: true }],
      }
      if (promptContext?.agent) body.agent = promptContext.agent
      if (promptContext?.model) body.model = promptContext.model
      if (promptContext?.variant) body.variant = promptContext.variant
      await session.promptAsync({ path: { id: sessionId }, body })
      return
    }
    // Fallback: log it. The user won't see the dialog if TUI is not running.
  }

  return {
    async dispose() {
      backgroundQuotaRefresh.stop()
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
      if (activeRpcServer) {
        await activeRpcServer.stop().catch(() => {})
        const rpcGlobal = globalThis as {
          __openaiAuthRpcServer?: RpcServerHandle
        }
        if (rpcGlobal.__openaiAuthRpcServer === activeRpcServer) {
          rpcGlobal.__openaiAuthRpcServer = undefined
        }
        activeRpcServer = null
      }
    },
    async event(input) {
      if (input.event.type !== 'session.deleted') return
      const info = input.event.properties.info
      const meta = codexSessions.get(info.id)
      if (meta) {
        cmdCtx?.cacheKeepManager?.remove(meta.threadID)
      }
      if (codexSessions.delete(info.id)) persistCodexSessions()
      if (sidebarStateFileForEvents) {
        const accounts = (await loadAccounts(getConfigPath()))?.accounts ?? []
        await removeSidebarActiveRouting(
          info.id,
          accounts,
          sidebarStateFileForEvents,
        )
      }
      for (const websocketFetch of websocketFetches)
        websocketFetch.remove(info.id)
    },
    provider: {
      id: 'openai',
      async models(provider, ctx) {
        if (ctx.auth?.type !== 'oauth') return provider.models

        const storage = await loadAccounts(getConfigPath())
        const zeroCosts = !storage || isCostZeroingEnabled(storage)
        const catalog = zeroCosts ? null : await loadModelsDevCosts()
        if (!zeroCosts && catalog && !loggedCostRestoration) {
          loggedCostRestoration = true
          logModels.debug('restoring OAuth model costs from models.dev catalog')
        }
        if (!zeroCosts && !catalog && !warnedCostCatalogUnavailable) {
          warnedCostCatalogUnavailable = true
          logModels.warn(
            'models.dev catalog unavailable; OAuth model costs could not be restored',
          )
        }

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (model.options.reasoningMode === 'pro') return false
              if (ALLOWED_MODELS.has(model.api.id)) return true
              if (DISALLOWED_MODELS.has(model.api.id)) return false
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
              const version = match?.[1]
              return version ? parseFloat(version) > 5.4 : false
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: zeroCosts
                  ? { input: 0, output: 0, cache: { read: 0, write: 0 } }
                  : (catalog?.[model.api.id] ??
                    catalog?.[modelID] ??
                    model.cost),
                limit: model.id.includes('gpt-5.5')
                  ? {
                      context: 400_000,
                      input: 272_000,
                      output: 128_000,
                    }
                  : // gpt-5.6 (luna/sol/terra) real context window is 372k on
                    // the Codex backend, not the 1.05M models.dev reports.
                    model.id.includes('gpt-5.6')
                    ? {
                        context: 372_000,
                        input: 244_000,
                        output: 128_000,
                      }
                    : model.limit,
              },
            ]),
        )
      },
    },
    tool: {
      web_search: HostedWebSearchTool,
    },
    auth: {
      provider: 'openai',
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== 'oauth') return {}

        // Migration: seed the multi-account store from the existing token (idempotent)
        await migrateIfNeeded(
          {
            type: 'oauth',
            access: auth.access ?? '',
            refresh: auth.refresh ?? '',
            expires: auth.expires ?? 0,
          },
          getConfigPath(),
        )

        // Construct managers for push-only quota updates from response headers.
        // Wrap the first boot-time read so a corrupt store surfaces a clear,
        // actionable message instead of a raw JSON.parse SyntaxError.
        const storage = await loadAccounts(getConfigPath()).catch((err) => {
          const path = getConfigPath()
          throw new Error(
            `OpenAI auth store at ${path} is corrupt or unreadable: ${err instanceof Error ? err.message : String(err)}. Fix or remove it to continue.`,
            { cause: err },
          )
        })

        let requestStorageCache:
          | {
              path: string
              mtimeMs: number
              size: number
              storage: Awaited<ReturnType<typeof loadAccounts>>
            }
          | undefined

        async function loadRequestAccounts() {
          const path = getConfigPath()
          try {
            const stat = statSync(path)
            if (
              requestStorageCache?.path === path &&
              requestStorageCache.mtimeMs === stat.mtimeMs &&
              requestStorageCache.size === stat.size
            ) {
              return requestStorageCache.storage
            }
            const next = await loadAccounts(path)
            requestStorageCache = {
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              storage: next,
            }
            return next
          } catch {
            requestStorageCache = undefined
            return loadAccounts(path)
          }
        }

        function invalidateRequestStorageCache() {
          requestStorageCache = undefined
        }

        // Derive the main account's stable ChatGPT identity from the live
        // token on every invocation so storage.mainAccountId stays current
        // (migrateIfNeeded only sets it once on first run). The CLI add path
        // rejects against the persisted value — acceptable because the plugin
        // refreshes it here each time the auth loader runs.
        if (storage && auth.access) {
          const liveAccountId = extractAccountId({
            id_token: '',
            access_token: auth.access,
            refresh_token: auth.refresh ?? '',
          })
          if (liveAccountId && liveAccountId !== storage.mainAccountId) {
            // Authoritative RMW: a stale saveAccounts here would union this
            // loader's snapshot back over disk and could resurrect a
            // concurrently-removed account (and its secrets in the state file).
            await mutateAccounts((current) => {
              current.mainAccountId = liveAccountId
              return current
            }, getConfigPath())
            storage.mainAccountId = liveAccountId
            invalidateRequestStorageCache()
          }
        }

        // Restore persisted log level from stored config.
        const storedLevel = storage?.logging?.level
        if (storedLevel && typeof storedLevel === 'string') {
          setLogLevel(storedLevel as Parameters<typeof setLogLevel>[0])
        }

        // Transport logging follows the persisted runtime log level.
        const logT = createLogger('transport')
        const logQ = createLogger('quota')
        const logR = createLogger('refresh')
        const logA = createLogger('accounts')

        // One-line resolved-config marker so the active endpoint/transport is
        // observable in the file log without enabling request dumps.
        logT.info('codex auth loader ready', {
          codexApiEndpoint,
          transport: getSettings().rawWebSocket
            ? 'raw-websocket'
            : getSettings().webSockets
              ? 'websocket'
              : 'http',
          webSearch: getSettings().webSearch,
        })

        const quotaManager = new QuotaManager({
          storage,
          fetchQuotaFn: undefined, // push-only: quota comes from HTTP headers / WS frames
        })
        let currentMainIdentity: string | undefined
        let mainIdentityGeneration = 0
        const fallbackManager = new FallbackAccountManager({
          refreshFn: (opts) =>
            codexRefreshFn({
              refreshToken: opts.refreshToken,
              fetchImpl: opts.fetchImpl,
              now: opts.now,
            }),
          quotaManager,
          onFallbackStorageChanged: invalidateRequestStorageCache,
        })
        // Start background refresh only when fallback accounts are configured;
        // single-account paths must not create extra token refresh traffic.
        if (storage && storage.accounts.length > 0) {
          fallbackManager.startBackgroundRefresh()
        }

        // -------------------------------------------------------------------
        // CacheKeepManager — prompt-cache warmer for idle main-agent sessions
        // -------------------------------------------------------------------
        const cacheKeepLogger = createLogger('cachekeep')
        let cacheKeepEnabled = storage?.cachekeep?.enabled === true
        let cacheKeepSubagents = storage?.cachekeep?.subagents === true
        let cacheKeepWindow = getCacheKeepWindow(storage)
        let mainRefreshPromise:
          | Promise<{ access: string; refresh: string; expires: number }>
          | undefined

        async function sleep(ms: number) {
          await new Promise((resolve) => setTimeout(resolve, ms))
        }

        async function persistMainAuthTokens(tokens: {
          access: string
          refresh: string
          expires: number
        }) {
          let lastError: unknown
          for (let attempt = 1; attempt <= AUTH_SET_MAX_ATTEMPTS; attempt++) {
            try {
              await input.client.auth.set({
                path: { id: 'openai' },
                body: {
                  type: 'oauth',
                  refresh: tokens.refresh,
                  access: tokens.access,
                  expires: tokens.expires,
                },
              })
              return
            } catch (error) {
              lastError = error
              if (attempt < AUTH_SET_MAX_ATTEMPTS) {
                await sleep(AUTH_SET_RETRY_BASE_MS * attempt)
              }
            }
          }
          throw new AuthPersistError(lastError)
        }

        async function updateMainRefreshState(
          update: (storage: AccountStorage) => void,
        ) {
          // Authoritative RMW under the store lock so persisting the main-refresh
          // lease can never union a stale account list back over disk (which
          // would resurrect a concurrently-removed account's secrets in state).
          await mutateAccounts((current) => {
            current.refresh = current.refresh ?? {}
            update(current)
            return current
          }, getConfigPath())
          invalidateRequestStorageCache()
        }

        async function waitForConcurrentMainRefresh(previous: {
          access?: string
          refresh?: string
          expires?: number
        }) {
          const deadline = Date.now() + CONCURRENT_MAIN_REFRESH_WAIT_MS
          while (Date.now() < deadline) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                CONCURRENT_MAIN_REFRESH_POLL_BASE_MS +
                  jitterMs(CONCURRENT_MAIN_REFRESH_POLL_BASE_MS),
              ),
            )
            const latest = await getAuth()
            if (latest.type !== 'oauth' || !latest.access) continue
            const changed =
              latest.access !== previous.access ||
              latest.refresh !== previous.refresh ||
              (latest.expires ?? 0) > (previous.expires ?? 0) + 60_000
            if (changed && (!latest.expires || latest.expires > Date.now())) {
              logR.debug('joined concurrent main refresh', {
                pid: process.pid,
                expiresInMs: latest.expires
                  ? latest.expires - Date.now()
                  : undefined,
              })
              return {
                access: latest.access,
                refresh: latest.refresh ?? previous.refresh ?? '',
                expires: latest.expires ?? 0,
              }
            }
          }
          return null
        }

        async function refreshMainWithLease() {
          if (!mainRefreshPromise) {
            mainRefreshPromise = (async () => {
              const freshAuth = await getAuth()
              if (freshAuth.type !== 'oauth') throw new Error('not oauth')
              if (!freshAuth.refresh) {
                throw new Error('Token refresh failed: missing refresh token')
              }

              const refreshTokenHash = hashRefreshToken(freshAuth.refresh)
              const latestStorage = await loadAccounts(getConfigPath())
              const mainError = latestStorage?.refresh?.mainLastRefreshError
              if (
                mainError &&
                refreshBackoffActive(mainError, freshAuth.refresh, Date.now())
              ) {
                throw new Error(
                  formatRefreshBackoffMessage(mainError, Date.now()),
                )
              }

              if (
                latestStorage?.refresh?.mainRefreshLeaseUntil &&
                latestStorage.refresh.mainRefreshLeaseUntil > Date.now() &&
                latestStorage.refresh.mainRefreshLeaseTokenHash ===
                  refreshTokenHash
              ) {
                const concurrent = await waitForConcurrentMainRefresh(freshAuth)
                if (concurrent) return concurrent
                throw new Error('Codex OAuth refresh is already in progress')
              }

              const fileLock = await acquireRefreshFileLock({
                name: MAIN_REFRESH_LOCK_NAME,
                ttlMs: MAIN_REFRESH_LOCK_TTL_MS,
                path: getConfigPath(),
                renew: true,
              })
              if (!fileLock) {
                const concurrent = await waitForConcurrentMainRefresh(freshAuth)
                if (concurrent) return concurrent
                throw new Error('Codex OAuth refresh is already in progress')
              }

              const leaseId = crypto.randomUUID()
              let leaseTokenHash: string | undefined = refreshTokenHash
              try {
                await updateMainRefreshState((nextStorage) => {
                  nextStorage.refresh = nextStorage.refresh ?? {}
                  nextStorage.refresh.mainRefreshLeaseId = leaseId
                  nextStorage.refresh.mainRefreshLeaseUntil =
                    Date.now() + MAIN_REFRESH_LEASE_TTL_MS
                  nextStorage.refresh.mainRefreshLeaseTokenHash =
                    refreshTokenHash
                })

                const latestLease = await loadAccounts(getConfigPath())
                if (
                  latestLease?.refresh?.mainRefreshLeaseId !== leaseId ||
                  latestLease.refresh.mainRefreshLeaseTokenHash !==
                    refreshTokenHash
                ) {
                  throw new Error('Codex OAuth refresh is already in progress')
                }

                const tokens = await codexRefreshFn({
                  refreshToken: freshAuth.refresh,
                  fetchImpl: fetch,
                  now: Date.now,
                })
                await persistMainAuthTokens(tokens)
                await updateMainRefreshState((nextStorage) => {
                  nextStorage.refresh = nextStorage.refresh ?? {}
                  nextStorage.refresh.mainLastRefreshError = undefined
                  if (nextStorage.refresh.mainRefreshLeaseId === leaseId) {
                    nextStorage.refresh.mainRefreshLeaseId = undefined
                    nextStorage.refresh.mainRefreshLeaseUntil = undefined
                    nextStorage.refresh.mainRefreshLeaseTokenHash = undefined
                  }
                }).catch(() => {})
                leaseTokenHash = undefined
                return tokens
              } catch (error) {
                if (freshAuth.refresh && !isAuthPersistError(error)) {
                  await updateMainRefreshState((nextStorage) => {
                    nextStorage.refresh = nextStorage.refresh ?? {}
                    nextStorage.refresh.mainLastRefreshError =
                      buildRefreshOperationError({
                        error,
                        now: Date.now(),
                        refreshToken: freshAuth.refresh ?? '',
                        previous: nextStorage.refresh.mainLastRefreshError,
                      })
                  }).catch(() => {})
                }
                throw error
              } finally {
                if (leaseTokenHash) {
                  await updateMainRefreshState((nextStorage) => {
                    if (
                      nextStorage.refresh?.mainRefreshLeaseId === leaseId &&
                      nextStorage.refresh.mainRefreshLeaseTokenHash ===
                        leaseTokenHash
                    ) {
                      nextStorage.refresh.mainRefreshLeaseId = undefined
                      nextStorage.refresh.mainRefreshLeaseUntil = undefined
                      nextStorage.refresh.mainRefreshLeaseTokenHash = undefined
                    }
                  }).catch(() => {})
                }
                await fileLock.release().catch(() => {})
              }
            })().finally(() => {
              mainRefreshPromise = undefined
            })
          }
          return mainRefreshPromise
        }
        const cacheKeepGlobal = globalThis as {
          __openaiAuthCacheKeepManager?: CacheKeepManager
        }
        cacheKeepGlobal.__openaiAuthCacheKeepManager?.stop()
        const cacheKeepManager = new CacheKeepManager({
          fetchImpl: fetch,
          getMainToken: async () => {
            const auth = await getAuth()
            if (auth.type !== 'oauth') throw new Error('not oauth')
            if (!auth.access || (auth.expires ?? 0) < Date.now()) {
              try {
                return (await refreshMainWithLease()).access
              } catch (error) {
                if (isAuthPersistError(error)) throw error
                if (auth.access) return auth.access
                throw new Error('main token refresh failed')
              }
            }
            return auth.access
          },
          refreshFallback: async (accountId: string) => {
            const fbStorage = await loadRequestAccounts()
            const account = fbStorage
              ? findCachekeepFallbackAccount(fbStorage.accounts, accountId)
              : undefined
            if (!account)
              throw new Error(`fallback account ${accountId} not found`)
            const refreshed = await fallbackManager.refreshAccount(
              account,
              fbStorage ?? { version: 1 as const, accounts: [account] },
            )
            if (!refreshed.access)
              throw new Error(`no access token for ${accountId}`)
            return refreshed.access
          },
          codexResponsesUrl: codexApiEndpoint,
          logger: cacheKeepLogger,
          now: Date.now,
          getWindow: () => cacheKeepWindow,
        })
        cacheKeepGlobal.__openaiAuthCacheKeepManager = cacheKeepManager

        async function pushQuota(
          snapshot: Record<string, unknown>,
          accessToken: string,
          accountId?: string,
          // ChatGPT account identity for the MAIN account, so the killswitch's
          // policy read survives a token refresh but still drops on a switch.
          mainAccountIdentity?: string,
          completeSnapshot = false,
        ) {
          if (Object.keys(snapshot).length === 0 && !completeSnapshot) return
          const now = Date.now()
          const quota = snapshot as OAuthQuotaSnapshot
          let entry: Parameters<typeof quotaManager.setMain>[1] = {
            quota,
            refreshAfter: now + 5 * 60 * 1000,
            checkedAt: now,
          }
          if (accountId && accountId !== 'main') {
            // Quota-bearing transports report every live window rather than a
            // partial subset, so an absent slot means the wire dropped it.
            // Only the wham-only reset-credit metadata carries forward.
            const previousForMetadata =
              quotaManager.peekFallbackForPolicy(accountId)?.quota
            const mergedQuota = mergePushedQuotaMetadata(
              quota,
              previousForMetadata,
            )
            entry = { ...entry, quota: mergedQuota }
            quotaManager.setFallback(
              accountId,
              entry,
              accessToken,
              completeSnapshot,
            )
          } else {
            let resolvedMainIdentity = mainAccountIdentity
            if (!resolvedMainIdentity && accessToken) {
              const claims = parseJwtClaims(accessToken)
              resolvedMainIdentity = claims
                ? extractAccountIdFromClaims(claims)
                : undefined
            }
            if (
              resolvedMainIdentity &&
              currentMainIdentity &&
              resolvedMainIdentity !== currentMainIdentity
            ) {
              logQ.debug('stale main quota frame dropped', {
                pid: process.pid,
                frameAccountId: resolvedMainIdentity,
                currentMainIdentity,
              })
              return
            }
            const previousForMetadata =
              quotaManager.peekMainForPolicy(resolvedMainIdentity)?.quota
            const mergedQuota = mergePushedQuotaMetadata(
              quota,
              previousForMetadata,
            )
            entry = { ...entry, quota: mergedQuota }
            quotaManager.setMain(
              accessToken,
              entry,
              resolvedMainIdentity,
              completeSnapshot,
            )
          }
          logQ.debug('quota pushed', {
            pid: process.pid,
            accountId: accountId ?? 'main',
            snapshot: entry.quota,
          })
          const latestStorage = await loadRequestAccounts()
          await writeMachineSidebarState(quotaManager, latestStorage)
        }

        // The pure resolver prefers an admission error's explicit reset and
        // otherwise uses this account's cached named-window quota.
        function midStreamRateLimitResetAt(
          accountKey: string,
          window: string,
          explicitResetAt?: number,
        ): number {
          const quota =
            accountKey === 'main'
              ? quotaManager.peekMainForPolicy()?.quota
              : quotaManager.peekFallbackForPolicy(accountKey)?.quota
          return resolveMidStreamRateLimitResetAt(
            quota,
            window,
            Date.now(),
            DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS,
            explicitResetAt,
          )
        }

        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({
              httpFetch: fetch,
              rawWebSocket: getSettings().rawWebSocket,
              // Per-request account identity is captured at send time by the
              // pool and threaded here so the frame is attributed to the
              // connection's own account, not the shared mutable globals.
              onQuota: (s, accessToken, accountId, servedChatgptAccountId) => {
                const isMainBucket = !accountId || accountId === 'main'
                void pushQuota(
                  s,
                  accessToken,
                  accountId,
                  isMainBucket ? servedChatgptAccountId : undefined,
                  true,
                )
              },
              // WS quota exhaustion is authoritative without a quota-API call.
              // Admission errors supply their own reset; response.failed uses
              // the cached named-window reset or the bounded default.
              onRateLimitReached: (window, accountId, explicitResetAt) => {
                if (!accountId) {
                  // The loader always sets the internal quota-account header,
                  // so this should never fire today — but a future call site
                  // that bypasses it would otherwise misattribute the mark
                  // onto main's bucket with zero signal.
                  logQ.warn(
                    'mid-stream rate-limit mark missing internal account id; defaulting to main',
                    { pid: process.pid, window },
                  )
                }
                const accountKey = accountId ?? 'main'
                const resetAt = midStreamRateLimitResetAt(
                  accountKey,
                  window,
                  explicitResetAt,
                )
                quotaManager.markRateLimited(accountKey, resetAt)
                logQ.debug('mid-stream rate limit mark', {
                  pid: process.pid,
                  accountId: accountKey,
                  window,
                })
              },
            })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }

        // -------------------------------------------------------------------
        // Machine snapshots refresh shared quota and routing configuration;
        // request writers record only the account that served that request.
        //
        // The sidebar path is resolved ONCE here (at loader-run time) and
        // captured in boundSidebarFile. All writes from this loader instance
        // — including fire-and-forget boot-seed and background timer callbacks
        // — pass the bound path explicitly so they cannot re-resolve
        // getSidebarStateFile() if the env changes underneath them (e.g.
        // during tests where afterEach restores the env floor).
        // -------------------------------------------------------------------
        const boundSidebarFile = getSidebarStateFile()
        sidebarStateFileForEvents = boundSidebarFile

        async function writeMachineSidebarState(
          qm: QuotaManager,
          store: Awaited<ReturnType<typeof loadAccounts>>,
        ) {
          if (!store) return
          await setSidebarMachineState(
            buildSidebarMachineState(qm, store),
            boundSidebarFile,
          )
        }

        async function writeRequestSidebarRouting(
          sessionId: string | undefined,
          parentSessionId: string | undefined,
          activeId: string,
          route: RoutingMode,
          accounts: readonly { id: string; enabled?: boolean }[],
        ) {
          const input = { activeId, route, updatedAt: Date.now() }
          if (sessionId) {
            await upsertSidebarActiveRouting(
              { sessionId, ...input },
              accounts,
              boundSidebarFile,
            )
            if (parentSessionId && parentSessionId !== sessionId) {
              await upsertSidebarActiveRouting(
                { sessionId: parentSessionId, ...input },
                accounts,
                boundSidebarFile,
              )
            }
            return
          }
          await setSidebarLegacyRouting(input, boundSidebarFile)
        }

        // -------------------------------------------------------------------
        // Start the loopback RPC server so the TUI can drain notifications and
        // dispatch apply commands.
        // -------------------------------------------------------------------
        cmdCtx = {
          accountStoragePath: getConfigPath(),
          quotaManager,
          loadAccounts,
          client: input.client as CommandContext['client'],
          cacheKeepManager,
          setCacheKeepEnabled: (enabled) => {
            cacheKeepEnabled = enabled
          },
          setCacheKeepSubagents: (enabled) => {
            cacheKeepSubagents = enabled
          },
          setCacheKeepWindow: (window) => {
            cacheKeepWindow = window
          },
          refreshSidebar: async () => {
            const store = await loadAccounts(getConfigPath())
            await writeMachineSidebarState(quotaManager, store)
          },
          refreshAllQuota: async () =>
            refreshAllQuota({
              getAuth,
              codexRefreshFn,
              refreshMainWithLease,
              fallbackManager,
              quotaManager,
              loadAccounts,
              writeSidebarState: writeMachineSidebarState,
              client: input.client as CommandContext['client'],
              fetchImpl: fetch,
              now: Date.now,
              configPath: getConfigPath(),
              storageMainAccountId: storage?.mainAccountId,
              isOAuthAccountFn: isOAuthAccount,
              whamFn: whamUsageFn,
            }),
        }

        let rpcServer: RpcServerHandle | null = null
        if (input.directory) {
          const rpcGlobal = globalThis as {
            __openaiAuthRpcServer?: RpcServerHandle
          }
          if (rpcGlobal.__openaiAuthRpcServer) {
            await rpcGlobal.__openaiAuthRpcServer.stop().catch(() => {})
            rpcGlobal.__openaiAuthRpcServer = undefined
          }
          try {
            rpcServer = await startRpcServer({
              dir: getRpcDir(input.directory),
              drain: drainNotifications,
              apply: async (request: ApplyRequest): Promise<ApplyResult> => {
                const payload = await buildDialogPayload(
                  request.command,
                  request.arguments,
                  // biome-ignore lint/style/noNonNullAssertion: cmdCtx is set in the loader before RPC server starts, and command.execute.before has a null guard
                  cmdCtx!,
                )
                return { text: payload.text, knobs: payload.knobs }
              },
            })
            rpcGlobal.__openaiAuthRpcServer = rpcServer
            activeRpcServer = rpcServer
          } catch {
            // RPC is best-effort; the plugin must not fail if the port file
            // can't be written (e.g. missing directory in test environments).
          }
        }

        // -------------------------------------------------------------------
        // sendWithAccessToken — the one primitive that both main and fallback
        // sends call.  Wraps the existing Codex transform + send.
        // -------------------------------------------------------------------
        async function sendWithAccessToken(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          accessToken: string,
          accountId?: string,
          keepwarmAccountKey: string = 'main',
        ): Promise<Response> {
          const headers = effectiveRequestHeaders(requestInput, init)
          headers.delete('x-api-key')
          headers.delete('api-key')
          headers.set('authorization', `Bearer ${accessToken}`)
          if (accountId) {
            headers.set('ChatGPT-Account-Id', accountId)
          }
          // Thread the internal quota STORAGE key ('main' or a fallback id) so the
          // WS pool attributes codex.rate_limits frames to the right bucket instead
          // of the wire chatgpt-account-id. Stripped before the wire as an internal
          // header. The HTTP path attributes quota directly at pushQuota.
          headers.set(
            OpenAIWebSocketPool.QUOTA_ACCOUNT_HEADER,
            keepwarmAccountKey,
          )

          const sessionID = resolveSidebarSessionId(headers)

          const codexMetadata = sessionID
            ? getCodexSessionMetadata(
                codexSessions,
                sessionID,
                persistCodexSessions,
              )
            : undefined

          const parsed =
            requestInput instanceof URL
              ? requestInput
              : new URL(
                  typeof requestInput === 'string'
                    ? requestInput
                    : requestInput.url,
                )
          const url =
            parsed.pathname.includes('/v1/responses') ||
            parsed.pathname.includes('/chat/completions')
              ? new URL(codexApiEndpoint)
              : parsed

          const prepared = prepareCodexRequest({
            init: {
              ...init,
              headers,
            },
            headers,
            metadata: codexMetadata,
            installationID,
            websocket: Boolean(
              websocketFetch && parsed.pathname.endsWith('/responses'),
            ),
            responsesLite: options.responsesLite ?? false,
            dumpSessionID: sessionID,
          })
          const requestInit = prepared.init
          const keepwarmEnabled = cacheKeepEnabled
          const keepwarmHeaders = new Headers(requestInit?.headers)
          const keepwarmCapture = buildKeepwarmCapture({
            enabled: keepwarmEnabled,
            includeSubagents: cacheKeepSubagents,
            headers: keepwarmHeaders,
            body: requestInit?.body,
          })
          if (keepwarmEnabled) {
            cacheKeepLogger.trace('cachekeep headers', {
              pid: process.pid,
              hasParent: keepwarmHeaders.has('x-parent-session-id'),
              sessionKey: keepwarmCapture?.sessionKey,
              captured: Boolean(keepwarmCapture),
              affinity: keepwarmHeaders.get('x-session-affinity'),
              opencodeSession: keepwarmHeaders.get('x-opencode-session'),
              sessionId: keepwarmHeaders.get('session-id'),
            })
          }
          if (websocketFetch && parsed.pathname.endsWith('/responses')) {
            logT.debug('WS transport', {
              pid: process.pid,
              pathname: parsed.pathname,
            })
            if (keepwarmCapture) {
              cacheKeepManager.track(
                keepwarmCapture.sessionKey,
                keepwarmCapture.bodyText,
                keepwarmAccountKey,
                accountId,
                keepwarmCapture.replayHeaders,
                keepwarmCapture.isSubagent,
              )
            }
            return websocketFetch(url, requestInit)
          }
          const finalInit =
            OpenAIWebSocketPool.withoutInternalHeaders(requestInit)
          if (typeof finalInit?.body !== 'string') return fetch(url, finalInit)

          // Keepwarm capture: track every request body for idle
          // prompt-cache warming. Cheap — stores the already-serialized string.
          if (keepwarmCapture) {
            cacheKeepManager.track(
              keepwarmCapture.sessionKey,
              keepwarmCapture.bodyText,
              keepwarmAccountKey,
              accountId,
              keepwarmCapture.replayHeaders,
              keepwarmCapture.isSubagent,
            )
          }

          logT.debug('HTTP transport', {
            pid: process.pid,
            pathname: parsed.pathname,
          })
          try {
            const response = await fetch(url, finalInit)
            await dumpCodexRequest({
              sessionID,
              transport: 'http',
              phase: 'http',
              bodyText: finalInit.body,
              url: url.toString(),
              method: finalInit.method,
              headers: finalInit.headers,
              status: response.status,
            })
            return translateHostedWebSearchResponse(response)
          } catch (error) {
            await dumpCodexRequest({
              sessionID,
              transport: 'http',
              phase: 'http',
              bodyText: finalInit.body,
              url: url.toString(),
              method: finalInit.method,
              headers: finalInit.headers,
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        }

        // -------------------------------------------------------------------
        // Replayability guard: only Codex generation POSTs with a buffered body
        // can be retried — skip fallback and return the primary response intact.
        // -------------------------------------------------------------------
        function isReplayableRequest(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
        ) {
          const method =
            init?.method ??
            (requestInput instanceof Request ? requestInput.method : 'GET')
          if (method.toUpperCase() !== 'POST') return false
          if (typeof init?.body !== 'string') return false
          try {
            const rawUrl =
              requestInput instanceof URL
                ? requestInput.toString()
                : typeof requestInput === 'string'
                  ? requestInput
                  : requestInput.url
            return new URL(rawUrl).pathname.endsWith('/responses')
          } catch {
            return false
          }
        }

        // -------------------------------------------------------------------
        // Killswitch helpers (opt-in hard circuit-breaker on cached quota).
        // -------------------------------------------------------------------

        // Last-seen pushed quota for the MAIN account (the primary is always
        // main). Push-only: no network fetch here. Uses the NON-invalidating
        // policy peek (bound to stable account identity) so a routine token
        // refresh does not turn a known-exhausted account into "unknown" (which
        // would fail open and spend). A genuine account switch still drops it.
        function killswitchMainQuota(mainAccountIdentity: string | undefined) {
          return quotaManager.peekMainForPolicy(mainAccountIdentity)?.quota
        }

        // Synthetic provider-shaped 429 with a Retry-After derived from the
        // earliest known quota reset across all accounts. Returned when the
        // killswitch blocks the primary and no surviving account can serve —
        // or when a mid-stream rate-limit mark blocks it instead (killswitch
        // may be OFF in that case), hence the parametrized reason: the
        // retry-after math is the same earliest-known-reset computation
        // either way, only the human-readable message differs.
        //
        // markResetAtMs carries the mid-stream mark's OWN stored reset (~60s,
        // DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS) when the block is a mark, not
        // a killswitch decision. killswitchRetryAfterSeconds falls back to a
        // 300s default when no account reset is known — without this, a bare
        // mid-stream block (no cached quota yet) would tell the client to wait
        // 4 extra minutes past the mark's actual expiry. The sooner of the two
        // always wins — this only ever tightens the wait, never lengthens it.
        function killswitchBlockedResponse(
          storage: AccountStorage | null,
          reason: 'killswitch' | 'mid-stream-rate-limit' = 'killswitch',
          markResetAtMs?: number,
        ): Response {
          const now = Date.now()
          const mainQuota = quotaManager.getMain()?.quota
          const fallbackAccounts = (storage?.accounts ?? [])
            .filter(
              (a): a is OAuthAccount =>
                a.enabled !== false && isOAuthAccount(a),
            )
            .map((a) => ({
              accountId: a.id,
              quota: quotaManager.getFallback(a.id)?.quota,
            }))
          let retryAfter = killswitchRetryAfterSeconds(
            mainQuota,
            fallbackAccounts,
            now,
            storage,
          )
          if (
            reason === 'mid-stream-rate-limit' &&
            markResetAtMs !== undefined
          ) {
            const markRetryAfter = Math.max(
              1,
              Math.ceil((markResetAtMs - now) / 1000),
            )
            retryAfter = Math.min(retryAfter, markRetryAfter)
          }
          const mins = Math.floor(retryAfter / 60)
          const secs = retryAfter % 60
          const message =
            reason === 'mid-stream-rate-limit'
              ? `OpenAI rate limit reached — retrying on another account. Retry in ${mins}m ${secs}s.`
              : `Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in ${mins}m ${secs}s.`
          return new Response(
            JSON.stringify({
              error: {
                message,
                type: 'rate_limit_exceeded',
                code: 'rate_limit_exceeded',
              },
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after': String(retryAfter),
              },
            },
          )
        }

        // -------------------------------------------------------------------
        // Fallback candidate building (shared by the proactive fallback-first
        // gate and the reactive main-error path). The primary is ALWAYS main, so
        // main is never a fallback candidate here.
        // -------------------------------------------------------------------
        type FallbackCandidate = {
          access: string
          accountId?: string
          keepwarmAccountKey: string
          quotaAccountId: string
          fallback: FallbackAccount
        }

        async function usableFallbackCandidates(
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
        ): Promise<FallbackCandidate[]> {
          const usableFallbacks =
            await fallbackManager.getUsableFallbackAccounts(fallbackStorage)
          const candidates: FallbackCandidate[] = []
          for (const fb of usableFallbacks) {
            if (fb.access) {
              candidates.push({
                access: fb.access,
                accountId: fb.accountId,
                keepwarmAccountKey: fb.id,
                quotaAccountId: fb.id,
                fallback: fb,
              })
            }
          }
          // Mid-stream rate-limit mark: never re-try a fallback a prior request
          // just exhausted mid-generation. Unlike the killswitch quota filter
          // below, this applies unconditionally — the mark comes from the
          // account's own response.failed frame, not an opt-in policy.
          const notRateLimited = candidates.filter(
            (c) => !quotaManager.isRateLimited(c.quotaAccountId),
          )
          // Killswitch: drop any candidate whose last-seen quota is below its
          // threshold so routing never spends on a killed account. Opt-in — a
          // no-op when disabled. Non-invalidating peek so a token refresh does
          // not flip a killed account to "unknown".
          if (!isKillswitchEnabled(fallbackStorage)) return notRateLimited
          return notRateLimited.filter((c) =>
            killswitchPassesPolicy(
              quotaManager.peekFallbackForPolicy(c.quotaAccountId, c.accountId)
                ?.quota,
              fallbackStorage,
              c.quotaAccountId,
              Date.now(),
            ),
          )
        }

        async function pushFailedFallbackQuota(
          response: Response,
          candidate: FallbackCandidate,
        ) {
          try {
            const snapshot = normalizeQuotaHeaders(response.headers)
            await pushQuota(
              snapshot as Record<string, unknown>,
              candidate.access,
              candidate.quotaAccountId,
              undefined,
              isCompleteQuotaHeaderFrame(response.headers),
            )
          } catch {
            // Quota headers from a failed candidate are advisory; routing must continue.
          }
        }

        // -------------------------------------------------------------------
        // tryFallbackFirst — proactive (fallback-first mode): try usable
        // fallbacks BEFORE main. Returns the first fallback that serves, or
        // undefined if none serve so the caller falls through to main.
        // -------------------------------------------------------------------
        async function tryFallbackFirst(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
        ): Promise<
          | {
              response: Response
              accessToken: string
              quotaAccountId: string
              activeId: string
            }
          | undefined
        > {
          const candidates = await usableFallbackCandidates(fallbackStorage)
          for (const candidate of candidates) {
            let response: Response
            try {
              response = await sendWithAccessToken(
                requestInput,
                init,
                candidate.access,
                candidate.accountId,
                candidate.keepwarmAccountKey,
              )
            } catch (error) {
              // A caller abort and an indeterminate transport failure both
              // stop routing: the failed send may already have generated or
              // billed, so trying another account could duplicate the request.
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                throw error
              }
              if ((init?.signal as AbortSignal | undefined | null)?.aborted) {
                throw error
              }
              logA.debug(
                'fallback-first transport failed; request not replayed',
                {
                  pid: process.pid,
                  accountId: candidate.quotaAccountId,
                },
              )
              throw error
            }
            if (!shouldFallbackStatus(response.status, fallbackStorage)) {
              await fallbackManager.markUsed(candidate.fallback)
              return {
                response,
                accessToken: candidate.access,
                quotaAccountId: candidate.quotaAccountId,
                activeId: candidate.keepwarmAccountKey,
              }
            }
            await pushFailedFallbackQuota(response, candidate)
            // This fallback failed — discard its body and try the next.
            response.body?.cancel().catch(() => {})
          }
          return undefined
        }

        // -------------------------------------------------------------------
        // tryFallbackAccounts — reactive: main returned a fallback status, so
        // retry with each usable fallback's access token.
        // -------------------------------------------------------------------
        async function tryFallbackAccounts(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          primaryResponse: Response,
          _unused?: string,
        ) {
          if (!isReplayableRequest(requestInput, init)) {
            return { response: primaryResponse }
          }

          const fallbackStorage = await loadRequestAccounts()
          const candidates = await usableFallbackCandidates(fallbackStorage)
          if (!candidates.length) return { response: primaryResponse }

          // Keep the returned response body live; only cancel a response after a
          // later retry has produced a replacement.
          let lastResponse: Response = primaryResponse
          let lastQuotaTarget:
            | { accessToken: string; accountId?: string }
            | undefined

          for (const candidate of candidates) {
            let response: Response
            try {
              response = await sendWithAccessToken(
                requestInput,
                init,
                candidate.access,
                candidate.accountId,
                candidate.keepwarmAccountKey,
              )
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                throw error
              }
              if ((init?.signal as AbortSignal | undefined | null)?.aborted) {
                throw error
              }
              logA.debug('reactive fallback candidate threw; stopping', {
                pid: process.pid,
                accountId: candidate.quotaAccountId,
              })
              return { response: lastResponse, ...lastQuotaTarget }
            }

            // Cancel the PREVIOUS response body now that we have a new one.
            // Only the LAST (returned) response keeps its body intact.
            lastResponse.body?.cancel().catch(() => {})
            lastResponse = response
            lastQuotaTarget = {
              accessToken: candidate.access,
              accountId: candidate.quotaAccountId,
            }

            if (!shouldFallbackStatus(response.status, fallbackStorage)) {
              await fallbackManager.markUsed(candidate.fallback)
              return { response, ...lastQuotaTarget }
            }
            await pushFailedFallbackQuota(response, candidate)
          }

          // All fallbacks exhausted. Return the last response — its body is
          // always intact (never cancelled here).
          return { response: lastResponse, ...lastQuotaTarget }
        }

        // -------------------------------------------------------------------
        // Boot-time quota seed: fire refreshAllQuota once per process so the
        // sidebar shows real numbers shortly after start instead of "checking…".
        // Non-blocking, best-effort — a failure must never crash the loader.
        // -------------------------------------------------------------------
        if (!bootQuotaSeedStarted) {
          bootQuotaSeedStarted = true

          // Seed fallback quota from persisted account.quota so the immediate
          // The immediate machine snapshot shows last-known fallback numbers.
          if (storage) {
            const oauthAccts: OAuthAccount[] = []
            for (const a of storage.accounts) {
              if (isOAuthAccount(a)) oauthAccts.push(a)
            }
            quotaManager.seedFallbacksFromAccounts(oauthAccts)
          }

          // Immediate: show persisted quota so the sidebar isn't blank
          void writeMachineSidebarState(quotaManager, storage).catch(() => {})

          // Background: refresh from the API, then the sidebar shows fresh numbers
          void refreshAllQuota({
            getAuth,
            codexRefreshFn,
            refreshMainWithLease,
            fallbackManager,
            quotaManager,
            loadAccounts,
            writeSidebarState: writeMachineSidebarState,
            client: input.client as Parameters<
              typeof refreshAllQuota
            >[0]['client'],
            fetchImpl: fetch,
            now: Date.now,
            configPath: getConfigPath(),
            storageMainAccountId: storage?.mainAccountId,
            isOAuthAccountFn: isOAuthAccount,
            whamFn: whamUsageFn,
            respectBackoff: true,
          }).catch((error) =>
            logQ.warn('boot quota seed failed', {
              pid: process.pid,
              error: errorMessage(error),
            }),
          )
        }

        backgroundQuotaRefresh.start(
          async () => {
            const results = await refreshQuotaInBackground({
              getAuth,
              codexRefreshFn,
              refreshMainWithLease,
              fallbackManager,
              quotaManager,
              loadAccounts,
              writeSidebarState: (qm, store) =>
                backgroundQuotaRefresh.isStopped()
                  ? Promise.resolve()
                  : writeMachineSidebarState(qm, store),
              client: input.client as Parameters<
                typeof refreshAllQuota
              >[0]['client'],
              fetchImpl: fetch,
              now: Date.now,
              configPath: getConfigPath(),
              storageMainAccountId: storage?.mainAccountId,
              isOAuthAccountFn: isOAuthAccount,
              whamFn: whamUsageFn,
              readSidebarState: () => getSidebarState(boundSidebarFile),
            })
            const failures = results.filter((result) => !result.ok)
            if (failures.length > 0) {
              logQ.warn('background quota refresh completed with failures', {
                pid: process.pid,
                failures,
              })
            }
          },
          (error) => {
            logQ.warn('background quota refresh failed', {
              pid: process.pid,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )

        // -------------------------------------------------------------------
        // Fetch override that selects the active account, refreshes if
        // needed, sends the transformed Codex request, and records quota.
        // -------------------------------------------------------------------
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const requestHeaders = effectiveRequestHeaders(requestInput, init)
            const sidebarSessionId = resolveSidebarSessionId(requestHeaders)
            const sidebarParentSessionId =
              requestHeaders.get('x-parent-session-id')?.trim() || undefined
            // Routing is purely mode-driven. The primary is ALWAYS the main
            // account; fallback-first is handled by a proactive gate below that
            // tries usable fallbacks before main. There is no per-account pin.
            const reqStorage = await loadRequestAccounts()

            // Main primary uses opencode's auth slot.
            const currentAuth: {
              type: string
              access?: string
              refresh?: string
              expires?: number
            } = await getAuth()
            const myGeneration = ++mainIdentityGeneration
            if (currentAuth.type !== 'oauth') return fetch(requestInput, init)
            init = await materializeRequestInit(requestInput, init)
            let primaryAccess: string = currentAuth.access ?? ''

            // Refresh expired main tokens and mirror them into opencode's slot.
            if (
              !currentAuth.access ||
              (currentAuth.expires ?? 0) < Date.now()
            ) {
              logR.debug('token refresh triggered', {
                pid: process.pid,
                hasAccess: Boolean(currentAuth.access),
                expiresInMs: currentAuth.expires
                  ? currentAuth.expires - Date.now()
                  : undefined,
              })
              try {
                const refreshed = await refreshMainWithLease()
                currentAuth.access = refreshed.access
                currentAuth.refresh = refreshed.refresh
                currentAuth.expires = refreshed.expires
              } catch (error) {
                if (isAuthPersistError(error)) throw error
                // Use stale token on refresh failure
              }
            }
            primaryAccess = currentAuth.access ?? ''

            const authWithAccount = currentAuth as typeof currentAuth & {
              accountId?: string
            }
            // Stable ChatGPT identity of the CURRENT main account. Prefer the
            // auth slot's accountId, but fall back to decoding it from the live
            // access-token JWT so the killswitch/quota reads can still detect a
            // main-account SWITCH (a loader that outlives a re-auth would
            // otherwise judge account B by account A's cached quota).
            const mainAccountIdentity =
              authWithAccount.accountId ??
              (primaryAccess
                ? extractAccountIdFromClaims(
                    parseJwtClaims(primaryAccess) ?? {},
                  )
                : undefined)
            if (myGeneration === mainIdentityGeneration) {
              currentMainIdentity = mainAccountIdentity
            }
            const mode: RoutingMode = reqStorage?.routing?.mode ?? 'main-first'

            // fallback-first (proactive): try usable fallbacks BEFORE main. If one
            // serves, use it and skip main entirely; otherwise fall through to the
            // main send below. Only replayable requests can be routed to a
            // fallback (the body must survive a re-send).
            let response: Response | undefined
            let servedFallback:
              | { accessToken: string; accountId?: string; activeId: string }
              | undefined
            // True when the proactive gate already tried every usable fallback,
            // so the reactive path below must not re-try (and re-spend on) them.
            let fallbacksAlreadyTried = false
            if (
              mode === 'fallback-first' &&
              isReplayableRequest(requestInput, init)
            ) {
              fallbacksAlreadyTried = true
              const pre = await tryFallbackFirst(requestInput, init, reqStorage)
              if (pre) {
                response = pre.response
                servedFallback = {
                  accessToken: pre.accessToken,
                  accountId: pre.quotaAccountId,
                  activeId: pre.activeId,
                }
              }
            }

            // Killswitch (opt-in): act on last-seen cached quota, push-only — no
            // network fetch on the hot path. If main is below its threshold, do
            // NOT spend on it: synthesize a 429 so the reactive-fallback path can
            // reroute to a surviving account, and if none survive (or the body is
            // non-replayable so a fallback is impossible) the 429 stands as the
            // hard block (with a Retry-After). Blocking is independent of
            // replayability — the killswitch's contract is "never spend below
            // threshold", so a non-replayable request hard-fails.
            //
            // Same treatment for a mid-stream rate-limit mark (a prior request on
            // main hit response.failed/rate_limit_reached_type on the WS
            // transport): main is exhausted right now even though the killswitch's
            // cached quota may not yet reflect it, so block main here too until
            // the mark's reset passes.
            if (!response) {
              const killswitchBlocksMain =
                isKillswitchEnabled(reqStorage) &&
                !killswitchPassesPolicy(
                  killswitchMainQuota(mainAccountIdentity),
                  reqStorage,
                  undefined,
                  Date.now(),
                )
              const mainRateLimited = quotaManager.isRateLimited('main')
              if (killswitchBlocksMain || mainRateLimited) {
                const blockReason =
                  mainRateLimited && !killswitchBlocksMain
                    ? 'mid-stream-rate-limit'
                    : 'killswitch'
                logA.debug('killswitch blocked primary', {
                  pid: process.pid,
                  activeId: 'main',
                  reason: blockReason,
                })
                response = killswitchBlockedResponse(
                  reqStorage,
                  blockReason,
                  mainRateLimited
                    ? quotaManager.rateLimitedUntil('main')
                    : undefined,
                )
              } else {
                // Send through the main account.
                response = await sendWithAccessToken(
                  requestInput,
                  init,
                  primaryAccess,
                  mainAccountIdentity,
                  'main',
                )
              }
            }

            // A fallback served proactively (fallback-first) — attribute quota
            // to it and mark it the display-active account. Its response is a
            // success, so no reactive retry is needed.
            let fallbackServed = Boolean(servedFallback)
            let finalResponse = response
            let fallbackQuotaAccess =
              servedFallback?.accessToken ?? primaryAccess
            let fallbackQuotaAccountId = servedFallback?.accountId
            let servedActiveId = servedFallback?.activeId ?? 'main'

            // main-first (or fallback-first that fell through to main): on a
            // 401/403/429 from main, reactively try usable fallbacks — unless the
            // proactive gate already tried them all (fallback-first), in which
            // case re-trying would just re-spend on the same exhausted accounts.
            if (
              !servedFallback &&
              !fallbacksAlreadyTried &&
              shouldFallbackStatus(response.status, reqStorage)
            ) {
              logA.debug('reactive fallback triggered', {
                pid: process.pid,
                status: response.status,
              })
              const fallbackResult = await tryFallbackAccounts(
                requestInput,
                init,
                response,
                undefined,
              )
              const fallbackResponse = fallbackResult.response
              if (fallbackResponse !== response) {
                fallbackServed = true
                finalResponse = fallbackResponse
                fallbackQuotaAccess =
                  fallbackResult.accessToken ?? primaryAccess
                fallbackQuotaAccountId = fallbackResult.accountId
                if (fallbackResult.accountId)
                  servedActiveId = fallbackResult.accountId
              }
            }

            try {
              const snapshot = normalizeQuotaHeaders(finalResponse.headers)
              if (fallbackServed) {
                await pushQuota(
                  snapshot as Record<string, unknown>,
                  fallbackQuotaAccess,
                  fallbackQuotaAccountId,
                  undefined,
                  isCompleteQuotaHeaderFrame(finalResponse.headers),
                )
              } else {
                await pushQuota(
                  snapshot as Record<string, unknown>,
                  primaryAccess,
                  undefined,
                  mainAccountIdentity,
                  isCompleteQuotaHeaderFrame(finalResponse.headers),
                )
              }
            } catch {
              // Quota push is best-effort — never break the response
            }

            await writeRequestSidebarRouting(
              sidebarSessionId,
              sidebarParentSessionId,
              servedActiveId,
              mode,
              reqStorage?.accounts ?? [],
            ).catch(() => {})
            return finalResponse
          },
          async dispose() {
            backgroundQuotaRefresh.stop()
            cacheKeepManager.stop()
            if (
              cacheKeepGlobal.__openaiAuthCacheKeepManager === cacheKeepManager
            ) {
              cacheKeepGlobal.__openaiAuthCacheKeepManager = undefined
            }
            fallbackManager.stopBackgroundRefresh()
            if (activeRpcServer) {
              await activeRpcServer.stop().catch(() => {})
              const rpcGlobal = globalThis as {
                __openaiAuthRpcServer?: RpcServerHandle
              }
              if (rpcGlobal.__openaiAuthRpcServer === activeRpcServer) {
                rpcGlobal.__openaiAuthRpcServer = undefined
              }
              activeRpcServer = null
            }
          },
        }
      },
      methods: [
        {
          label: 'ChatGPT Pro/Plus (browser)',
          type: 'oauth',
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = base64UrlEncode(
              crypto.getRandomValues(new Uint8Array(32)).buffer,
            )
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions:
                'Complete authorization in your browser. This window will close automatically.',
              method: 'auto' as const,
              callback: async () => {
                try {
                  const tokens = await callbackPromise
                  const accountId = extractAccountId(tokens)
                  return {
                    type: 'success' as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId,
                  }
                } finally {
                  flowCleanup(state)
                }
              },
            }
          },
        },
        {
          label: 'ChatGPT Pro/Plus (headless)',
          type: 'oauth',
          authorize: async () => {
            const { deviceData, url, instructions } = await beginDeviceAuth()

            return {
              url,
              instructions,
              method: 'auto' as const,
              async callback() {
                try {
                  const tokens = await completeDeviceAuth(deviceData)
                  return {
                    type: 'success' as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId: extractAccountId(tokens),
                  }
                } catch {
                  return { type: 'failed' as const }
                }
              },
            }
          },
        },
        {
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      output.headers.originator = 'opencode'
      output.headers['User-Agent'] =
        `${USER_AGENT} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers['session-id'] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === 'title')
        output.headers[OpenAIWebSocketPool.TITLE_HEADER] = 'true'
    },
    'chat.params': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
    config: async (config: { command?: Record<string, unknown> }) => {
      config.command = {
        ...(config.command ?? {}),
        [OPENAI_QUOTA_COMMAND_NAME]: {
          template: OPENAI_QUOTA_COMMAND_NAME,
          description:
            'Show current OpenAI Codex OAuth quota usage for all accounts.',
        },
        [OPENAI_ACCOUNT_COMMAND_NAME]: {
          template: OPENAI_ACCOUNT_COMMAND_NAME,
          description:
            'Manage OpenAI accounts — add, switch, remove, or reorder.',
        },
        [OPENAI_ROUTING_COMMAND_NAME]: {
          template: OPENAI_ROUTING_COMMAND_NAME,
          description:
            'Show or change OpenAI account routing between main-first and fallback-first.',
        },
        [OPENAI_KILLSWITCH_COMMAND_NAME]: {
          template: OPENAI_KILLSWITCH_COMMAND_NAME,
          description:
            'Manage killswitch — hard-block requests when quota drops below per-account thresholds.',
        },
        [OPENAI_DUMP_COMMAND_NAME]: {
          template: OPENAI_DUMP_COMMAND_NAME,
          description:
            'Show or toggle OpenAI Codex request dump capture for debugging.',
        },
        [OPENAI_LOGGING_COMMAND_NAME]: {
          template: OPENAI_LOGGING_COMMAND_NAME,
          description:
            'Show or change the plugin log level (error, warn, info, debug, trace).',
        },
        [OPENAI_CACHEKEEP_COMMAND_NAME]: {
          template: OPENAI_CACHEKEEP_COMMAND_NAME,
          description:
            'Keep Codex prompt cache alive during idle by shadow-replaying the last request.',
        },
      }
    },
    'command.execute.before': async (input: {
      command: string
      arguments: string
      sessionID: string
    }) => {
      if (!MODAL_COMMANDS.includes(input.command as CommandModalName)) return
      if (!cmdCtx) {
        await sendIgnoredMessage(
          input.sessionID,
          'OpenAI auth plugin is still initializing. Send a request first, then try again.',
        )
        cleanAbort()
      }
      const command = input.command as CommandModalName
      // Build a PER-INVOCATION context that threads this request's session id and
      // notifier. Mutating the shared cmdCtx would race across concurrent sessions:
      // the detached add-flow snapshots ctx.sessionId only after an await, so a
      // second session's modal command in that window could misroute the first
      // session's OAuth feedback. A per-call copy is never mutated by another turn.
      const callCtx: CommandContext = {
        // biome-ignore lint/style/noNonNullAssertion: guarded above (cleanAbort throws when cmdCtx is null)
        ...cmdCtx!,
        sessionId: input.sessionID,
        notify: (payload) => {
          pushNotification(payload, input.sessionID)
        },
      }
      const payload = await buildDialogPayload(
        command,
        input.arguments,
        callCtx,
      )
      if (isTuiConnected(input.sessionID)) {
        pushNotification(payload, input.sessionID)
      } else {
        await sendIgnoredMessage(input.sessionID, payload.text)
      }
      cleanAbort()
    },
  }
}

export const OpenAIAuthPlugin: Plugin = async (input) => {
  const settings = getSettings()
  return CodexAuthPlugin(input, {
    codexApiEndpoint: settings.codexApiEndpoint,
    experimentalWebSockets: settings.webSockets,
    responsesLite: settings.responsesLite,
  })
}

export default {
  id: 'cortexkit-openai-auth',
  server: OpenAIAuthPlugin,
}
