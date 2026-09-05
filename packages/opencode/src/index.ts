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
  OPENAI_RESET_COMMAND_NAME,
  OPENAI_ROUTING_COMMAND_NAME,
  type ResetTargetIdentity,
} from './commands'
import { getConfigDir, getConfigPath, getSettings } from './config'
import {
  type AccountStorage,
  claustrumMode,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  type FallbackAccount,
  FallbackAccountManager,
  fallbackRefreshLockName,
  getKillswitchThresholdsForAccount,
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
  withAccountStoreTransaction,
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
  CUSTODY_EXCLUDED,
  CUSTODY_REFUSE,
  CustodyTombstoneRefreshError,
  refreshInert,
  resolveFallbackAccess,
  stampVaultProvenance,
  tombstoned,
  type VaultProvenance,
} from './core/custody.ts'
import {
  type CustodyBootstrap,
  classifyMainAuthSlot,
  mainAccountIdFromServedCredential,
  reconcileMainSlotBeforeHooks,
} from './core/custody-host-slot.ts'
import {
  CUSTODY_OWNING_PROVIDER,
  custodyManifestHandles,
  readCustodyManifest,
} from './core/custody-manifest.ts'
import {
  acquireCustodyTransitionMutex,
  enterClaustrumMode,
  leaveClaustrumMode,
  MAIN_REFRESH_LOCK_NAME,
  releaseCustodyLoginLeaseAfterHostWrite,
} from './core/custody-transition.ts'
import {
  base64UrlEncode,
  beginAccountLogin,
  beginDeviceAuth,
  buildAuthorizeUrl,
  completeDeviceAuth,
  extractAccountId,
  extractAccountIdFromClaims,
  flowCleanup,
  generatePKCE,
  parseJwtClaims,
  startOAuthServer,
  type TokenResponse,
  USER_AGENT,
  waitForOAuthCallback,
} from './core/oauth'
import { codexRefreshFn, whamUsageFn } from './core/provider'
import {
  type QuotaEntry,
  QuotaManager,
  resolveMidStreamRateLimitResetAt,
} from './core/quota-manager'
import { refreshAllQuota } from './core/refresh-all-quota'
import { acquireRefreshFileLock } from './core/refresh-file-lock'
import {
  decideStickyBreak,
  type StickyBreakDecision,
  selectStickyCandidate,
} from './core/sticky-routing'
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
import { resolveRpcDir } from './rpc/rpc-dir'
import { type RpcServerHandle, startRpcServer } from './rpc/rpc-server'
import {
  type AccountQuota,
  clearSidebarStickyAssignment,
  exhaustedQuotaResetAt,
  getSidebarState,
  getSidebarStateFile,
  hashSidebarSessionId,
  isQuotaExhausted,
  projectCustodyForSidebar,
  type QuotaWindow,
  removeSidebarActiveRouting,
  resolveSessionStickyAccount,
  resolveSidebarStickyAssignment,
  type SidebarAccountCustody,
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
// Same shape for gpt-6: the backend rejects the bare id ("not supported when
// using Codex with a ChatGPT account") and serves only the named gpt-6-astra
// variant, so any -fast/-pro synthetics inheriting api.id "gpt-6" drop with it.
const DISALLOWED_MODELS = new Set(['gpt-5.6', 'gpt-6'])
// Exact models currently marked `use_responses_lite` in Codex's catalog. Read
// from the backend's own model list rather than assumed:
//   GET /backend-api/codex/models?client_version=<v>
// reports `use_responses_lite` per model, and gpt-6-astra is marked true.
const RESPONSES_LITE_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
])
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key'
const CODEX_BETA_FEATURES = 'terminal_resize_reflow'
// gpt-6-astra requires Codex client >= 0.153.0; below that the backend 400s with
// "requires a newer version of Codex". Measured against the live backend: 0.152.0
// is refused and 0.153.0 is accepted. Verified non-regressive for every model we
// surface (gpt-5.3-codex-spark, 5.4, 5.4-mini, 5.5, and the three 5.6 variants),
// so one version serves the whole range.
const CODEX_VERSION = '0.153.0'
const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
const CODEX_SANDBOX = 'seccomp'
export const getMainRefreshLockName = () => MAIN_REFRESH_LOCK_NAME
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

export function __resetBootQuotaSeedForTest(): void {
  bootQuotaSeedStarted = false
}

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

export type ResetTargetResolutionErrorKind =
  | 'unknown_account'
  | 'disabled_account'
  | 'non_oauth_account'
  | 'token_unavailable'

export class ResetTargetResolutionError extends Error {
  readonly code: ResetTargetResolutionErrorKind

  constructor(code: ResetTargetResolutionErrorKind, message: string) {
    super(message)
    this.name = 'ResetTargetResolutionError'
    this.code = code
  }
}

interface ResetTargetResolverDeps {
  getAuth: () => Promise<{
    type: string
    access?: string
    refresh?: string
    expires?: number
  }>
  refreshMainWithLease: () => Promise<{
    access: string
    refresh: string
    expires: number
  }>
  refreshFallbackAccount: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<OAuthAccount>
  loadAccounts: typeof loadAccounts
  accountStoragePath: string
  now: () => number
  isFallbackRefreshInert?: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<boolean>
  resolveFallbackAccess?: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => ReturnType<typeof resolveFallbackAccess>
  reportAuthFailure?: (params: {
    handle: string
    providerStatus: number
    recordVersion: number
  }) => Promise<void>
}

function resetTargetNeedsRefresh(
  access: string | undefined,
  expires: number | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  const refreshBeforeExpiryMs =
    (storage?.refresh?.refreshBeforeExpiryMinutes ?? 240) * 60_000
  return !access || !expires || expires - now <= refreshBeforeExpiryMs
}

export function createResetTargetResolver(deps: ResetTargetResolverDeps) {
  return async (accountKey: string): Promise<ResetTargetIdentity> => {
    if (accountKey === 'main') {
      const storage = await deps.loadAccounts(deps.accountStoragePath)
      let auth = await deps.getAuth()
      if (auth.type !== 'oauth') {
        throw new ResetTargetResolutionError(
          'non_oauth_account',
          'Main OpenAI account is not authenticated with OAuth.',
        )
      }
      if (
        resetTargetNeedsRefresh(auth.access, auth.expires, storage, deps.now())
      ) {
        auth = { type: 'oauth', ...(await deps.refreshMainWithLease()) }
      }
      if (!auth.access) {
        throw new ResetTargetResolutionError(
          'token_unavailable',
          'Main OpenAI account has no usable access token.',
        )
      }
      // The access token's claims reflect the account authenticated right
      // now; the persisted mainAccountId lags a re-login until the next
      // storage write. Prefer the live identity, falling back to storage for
      // token shapes that carry no account claim.
      const claims = parseJwtClaims(auth.access)
      const liveAccountId = claims
        ? extractAccountIdFromClaims(claims)
        : undefined
      const freshStorage = await deps.loadAccounts(deps.accountStoragePath)
      return {
        accountKey,
        label: 'Main account',
        accessToken: auth.access,
        chatgptAccountId: liveAccountId ?? freshStorage?.mainAccountId,
      }
    }

    const storage = await deps.loadAccounts(deps.accountStoragePath)
    const account = storage?.accounts.find(
      (candidate) => candidate.id === accountKey,
    )
    if (!storage || !account) {
      throw new ResetTargetResolutionError(
        'unknown_account',
        `Fallback account ${accountKey} was not found.`,
      )
    }
    if (account.enabled === false) {
      throw new ResetTargetResolutionError(
        'disabled_account',
        `Fallback account ${accountKey} is disabled.`,
      )
    }
    if (!isOAuthAccount(account)) {
      throw new ResetTargetResolutionError(
        'non_oauth_account',
        `Fallback account ${accountKey} is not an OAuth account.`,
      )
    }

    let resolved = account
    if (
      !(await deps.isFallbackRefreshInert?.(resolved, storage)) &&
      resetTargetNeedsRefresh(
        resolved.access,
        resolved.expires,
        storage,
        deps.now(),
      )
    ) {
      resolved = await deps.refreshFallbackAccount(resolved, storage)
    }
    const accessResolution = deps.resolveFallbackAccess
      ? await deps.resolveFallbackAccess(resolved, storage)
      : resolved.access
        ? { token: resolved.access, provenance: 'local' as const }
        : CUSTODY_REFUSE
    if (
      accessResolution === CUSTODY_REFUSE ||
      accessResolution === CUSTODY_EXCLUDED
    ) {
      throw new ResetTargetResolutionError(
        'token_unavailable',
        `Fallback account ${accountKey} has no usable access token.`,
      )
    }

    const freshStorage = await deps.loadAccounts(deps.accountStoragePath)
    const freshAccount = freshStorage?.accounts.find(
      (candidate) => candidate.id === accountKey,
    )
    if (!freshStorage || !freshAccount) {
      throw new ResetTargetResolutionError(
        'unknown_account',
        `Fallback account ${accountKey} was not found.`,
      )
    }
    if (freshAccount.enabled === false) {
      throw new ResetTargetResolutionError(
        'disabled_account',
        `Fallback account ${accountKey} is disabled.`,
      )
    }
    if (!isOAuthAccount(freshAccount)) {
      throw new ResetTargetResolutionError(
        'non_oauth_account',
        `Fallback account ${accountKey} is not an OAuth account.`,
      )
    }
    return {
      accountKey,
      label: resolved.label ?? accountKey,
      accessToken: accessResolution.token,
      chatgptAccountId: freshAccount.accountId,
      onAuthFailure:
        accessResolution.provenance === 'local'
          ? undefined
          : async (status: number) => {
              await deps.reportAuthFailure?.({
                handle: accessResolution.provenance.handle,
                providerStatus: status,
                recordVersion: accessResolution.provenance.recordVersion,
              })
            },
    }
  }
}

export function buildResetRedemptionDeps() {
  return {
    fetchImpl: fetch,
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
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
  custody?: {
    /** Test seam: the transport backing the loader-owned runtime. */
    transport: ClaustrumCacheTransportLike
    /** Test seam: override the connection-file detection result. */
    detection?: 'available' | 'absent'
    /** Test seam: observes the loader-owned runtime for explicit ticks. */
    onRuntime?: (runtime: CustodyRuntime) => void
    /** Test seam: controls the runtime clock for expiry-bound scenarios. */
    now?: () => number
    /** Test seam: controls bounded host-write observation without real timers. */
    sleep?: (ms: number) => Promise<void>
    /** Test seam: replaces external OAuth I/O while preserving the hook callback. */
    authorize?: {
      browser?: () => Promise<{
        url: string
        tokens: Promise<TokenResponse>
        cleanup?: () => void
      }>
      headless?: () => Promise<{
        url: string
        instructions: string
        tokens: Promise<TokenResponse>
      }>
    }
  }
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
// never carry the fields. An incoming push that omits them inherits the last
// known counts for the same account so the sidebar and the reset dialog do
// not lose them on every per-turn header/WS update — but an explicit incoming
// value (including 0) always wins over a stale cached one.
export function mergePushedQuotaMetadata(
  incoming: OAuthQuotaSnapshot,
  previous: OAuthQuotaSnapshot | undefined,
): OAuthQuotaSnapshot {
  if (!previous) return incoming
  const merged: OAuthQuotaSnapshot = { ...incoming }
  for (const key of [
    'resetCreditsAvailable',
    'resetCreditsApplicable',
  ] as const) {
    const carried = previous[key]
    if (merged[key] === undefined && carried !== undefined) {
      merged[key] = carried
    }
  }
  return merged
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

import {
  __createCustodyRuntimeForTest,
  type ClaustrumCacheTransportLike,
  type CustodyRuntime,
  custodyMinTtlMs,
} from './core/custody-runtime.ts'

export {
  __createCustodyRuntimeForTest,
  __resetSweepFailureLogDedupeForTest,
  type ClaustrumCacheTransportLike,
  type CustodyRuntime,
  type CustodyRuntimeOptions,
} from './core/custody-runtime.ts'

function lookupManifestHandle(
  manifest: ReturnType<typeof readCustodyManifest> extends Promise<infer R>
    ? R
    : never,
  accountId: string,
): string | undefined {
  return custodyManifestHandles(manifest).get(accountId)
}

export function buildSidebarMachineState(
  qm: QuotaManager,
  store: AccountStorage,
  now = Date.now(),
  mainAccountIdentity = store.mainAccountId,
  projectCustody?: (
    account: FallbackAccount,
    now: number,
  ) => SidebarAccountCustody | undefined,
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
      ...(typeof mainAccountIdentity === 'string'
        ? { mainAccountId: mainAccountIdentity }
        : {}),
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
        // Sync projection: the loader pre-resolves custody state once per write
        // (cache peek is async; the runtime owns the map) and threads a sync
        // lookup in. An absent callback leaves `custody` unset, which is the
        // pre-custody shape — the normalizer drops it without rendering.
        const custodyProjection = projectCustody?.(account, now)
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
          ...(custodyProjection ? { custody: custodyProjection } : {}),
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
  const hostAuth = input.client.auth as unknown as {
    all(): Promise<Record<string, unknown>>
    get(input: { path: { id: string } }): Promise<unknown>
    set(input: {
      path: { id: string }
      body: { type: 'oauth'; access: string; refresh: string; expires: number }
    }): Promise<unknown>
  }
  let activeRpcServer: RpcServerHandle | null = null
  let sidebarStateFileForEvents: string | undefined
  // Custody runtime — assigned inside the loader so dispose can close the
  // vendored client and clear the custody tick timer after the loader has
  // returned. Built unconditionally so a custody-disabled process still has
  // a runtime to dispose (no-op tick + close).
  let custodyRuntimeRef: CustodyRuntime | undefined
  // The runtime accepts this factory-owned bootstrap rather than opening a second connection.
  // allowing the runtime path to open a second Claustrum connection.
  const custodyBootstrap: CustodyBootstrap = {}
  const custodyOptions = options.custody
  const custodyLogger = createLogger('custody')

  function createCustodyRuntime(
    storage: AccountStorage | null,
  ): CustodyRuntime {
    return __createCustodyRuntimeForTest({
      storage,
      configPath: getConfigPath(),
      loadAccounts,
      mutateAccounts,
      readCustodyManifest,
      acquireRefreshFileLock,
      ...(custodyOptions
        ? {
            detectClaustrumConnection: async () =>
              custodyOptions.detection === 'absent'
                ? { status: 'absent' as const, path: 'test' }
                : {
                    status: 'available' as const,
                    schema: 1,
                    wireVersion: 1,
                    endpoints: [],
                  },
            cacheConnector: async () => custodyOptions.transport,
          }
        : {}),
      logger: {
        info: (msg, meta) =>
          custodyLogger.info(msg, meta ?? {}) as unknown as undefined,
        warn: (msg, meta) =>
          custodyLogger.warn(msg, meta ?? {}) as unknown as undefined,
        debug: (msg, meta) =>
          custodyLogger.debug(msg, meta ?? {}) as unknown as undefined,
        error: (msg, meta) =>
          custodyLogger.error(msg, meta ?? {}) as unknown as undefined,
      },
      now: custodyOptions?.now,
    })
  }

  const factoryStorage = await loadAccounts(getConfigPath())
  const factoryManifest = await readCustodyManifest()
  const factoryAuth = input.client.auth as {
    get?: (input: { path: { id: string } }) => Promise<unknown>
    all?: () => Promise<Record<string, unknown>>
  }
  if (factoryAuth.get && factoryAuth.all) {
    if (claustrumMode(factoryStorage ?? {}) === 'claustrum') {
      custodyRuntimeRef = createCustodyRuntime(factoryStorage)
      custodyOptions?.onRuntime?.(custodyRuntimeRef)
      await custodyRuntimeRef.boot()
    }
    const factoryCache = custodyRuntimeRef?.getCache()
    if (factoryCache) custodyBootstrap.cache = factoryCache
    custodyBootstrap.mainVerdict = await reconcileMainSlotBeforeHooks({
      client: { auth: factoryAuth },
      mode: claustrumMode(factoryStorage ?? {}),
      manifest: factoryManifest,
      mainAccountId: factoryStorage?.mainAccountId,
      getCredential: factoryCache
        ? async (handle) => {
            const credential = await factoryCache.get(
              handle,
              custodyMinTtlMs(factoryStorage),
            )
            return { access: credential.payload.access }
          }
        : undefined,
      isReauth: factoryCache
        ? (handle) => factoryCache.isReauth(handle)
        : undefined,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    if (custodyBootstrap.mainVerdict?.kind === 'INERT') {
      const sidebar = await getSidebarState()
      await setSidebarMachineState({
        ...sidebar,
        main: {
          ...sidebar.main,
          custody: projectCustodyForSidebar(custodyBootstrap.mainVerdict),
        },
      })
    }
  }

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
      custodyRuntimeRef?.dispose()
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
        const accounts = (await loadAccounts(getConfigPath()))?.accounts
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
              // The minor is optional: a major-only id like gpt-6-astra carries
              // no decimal, and requiring one silently dropped it from the
              // catalogue even though the backend serves it.
              const match = model.api.id.match(/^gpt-(\d+(?:\.\d+)?)/)
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
                  : // gpt-6-astra pays no long-context surcharge on the Codex
                    // backend, so it keeps the full window that backend reports.
                    // Per OpenAI's enterprise rate card, read 2026-09-05 at
                    // help.openai.com/en/articles/20001415 — section "GPT-6 Astra
                    // — Codex long-context exception": "GPT-6 Astra usage in
                    // Codex does not incur additional long-context multipliers
                    // above 272K input tokens." The exemption is per-surface:
                    // the same model billed through the platform API does pay it
                    // (developers.openai.com/api/docs/models/gpt-6-astra).
                    //
                    // That makes this correct for the DEFAULT endpoint. A
                    // `codexApiEndpoint` override pointed at a relay or a
                    // differently-billed surface inherits this window without
                    // inheriting the exemption, which is the operator's to
                    // re-check.
                    //
                    // 872k is the Codex backend's own reported
                    // max_context_window, from
                    // GET /backend-api/codex/models?client_version=<v>. The
                    // configured window follows that reported number rather than
                    // the hard ceiling probing found just above it (876,934
                    // input tokens accepted on 2026-09-04), since the reported
                    // number is the one the backend maintains. Input and output
                    // draw on one shared budget, so `input` is that window minus
                    // the 128k output reserve.
                    model.id.includes('gpt-6-astra')
                    ? {
                        context: 872_000,
                        input: 744_000,
                        output: 128_000,
                      }
                    : // The 5.6 family is NOT exempt — same rate card, same date:
                      // above 272k input tokens it costs 2x input and 1.5x
                      // output ON THE WHOLE REQUEST, so
                      // `input` is held under that line at 244k and `context` is
                      // that cap plus the 128k output reserve. This is a cost
                      // decision, never a capability one — gpt-5.6-sol accepted
                      // 861,550 input tokens when measured — so do not "correct"
                      // these numbers upward to that ceiling without re-reading
                      // the rate card first.
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

        const mainSlot = classifyMainAuthSlot(auth)
        const recognizedMainTombstone =
          mainSlot.kind === 'tombstone' || mainSlot.kind === 'empty'

        // Migration: seed the multi-account store from the existing token (idempotent)
        if (!recognizedMainTombstone) {
          await migrateIfNeeded(
            {
              type: 'oauth',
              access: auth.access ?? '',
              refresh: auth.refresh ?? '',
              expires: auth.expires ?? 0,
            },
            getConfigPath(),
          )
        }

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
        if (storage && auth.access && !recognizedMainTombstone) {
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
          custody: { readManifest: readCustodyManifest },
          onFallbackStorageChanged: invalidateRequestStorageCache,
        })
        // -------------------------------------------------------------------
        // Custody runtime — vendored client, cache, completion sweep, tick.
        // Constructed unconditionally so the boot sweep can resolve before
        // the background refresh is armed and so dispose() can close the
        // cache + transport regardless of whether custody is enabled.
        // -------------------------------------------------------------------
        const custodyRuntime =
          custodyRuntimeRef ?? createCustodyRuntime(storage)
        if (!custodyRuntimeRef) {
          custodyOptions?.onRuntime?.(custodyRuntime)
          await custodyRuntime.boot()
          custodyRuntimeRef = custodyRuntime
        }
        if (recognizedMainTombstone) {
          const manifest = await readCustodyManifest()
          const handle = lookupManifestHandle(manifest, 'main')
          const cache = custodyRuntime.getCache()
          if (handle && cache) {
            try {
              const credential = await cache.get(
                handle,
                custodyMinTtlMs(storage),
              )
              const servedMainAccountId = mainAccountIdFromServedCredential(
                credential.payload.access,
              )
              if (
                servedMainAccountId &&
                servedMainAccountId !== storage?.mainAccountId
              ) {
                await mutateAccounts((current) => {
                  current.mainAccountId = servedMainAccountId
                  return current
                }, getConfigPath())
                if (storage) storage.mainAccountId = servedMainAccountId
                custodyBootstrap.mainAccountId = servedMainAccountId
                invalidateRequestStorageCache()
              }
            } catch {
              // The factory verdict already records vault cold/reauth; the loader
              // must preserve its inert state instead of turning it into a crash.
            }
          }
        }
        // The loader owns the detached first tick so direct runtime callers
        // can observe boot completion without background work racing them.
        void custodyRuntime.runTick().catch((error) =>
          custodyLogger.warn('custody first tick failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        custodyRuntimeRef = custodyRuntime
        // Start background refresh only when fallback accounts are configured;
        // single-account paths must not create extra token refresh traffic.
        // The boot order above guarantees the initial completion sweep has
        // resolved — any `enrolling` account has been tombstoned before the
        // background loop starts gating on `refreshInert`.
        if (storage && storage.accounts.length > 0) {
          fallbackManager.startBackgroundRefresh()
        }

        // -------------------------------------------------------------------
        // Custody deps for the four quota constructions (spec §6.6). One
        // builder, used everywhere; omission at any one site fails closed
        // via `custody-deps-incomplete` (the poller's own guard). Each
        // closure captures `storage` and the live custodyRuntime so the
        // resolver and reporter see fresh state per invocation.
        // -------------------------------------------------------------------
        const custodyRuntimeForDeps = custodyRuntime
        async function isFallbackAccountRefreshInert(
          account: OAuthAccount,
          _currentStorage: AccountStorage,
        ): Promise<boolean> {
          const manifest = await readCustodyManifest()
          return refreshInert(account, manifest, CUSTODY_OWNING_PROVIDER)
        }
        async function resolveAccountAccessForCustody(
          account: OAuthAccount,
          currentStorage: AccountStorage,
        ): ReturnType<typeof resolveFallbackAccess> {
          const manifest = await readCustodyManifest()
          const cache = custodyRuntimeForDeps.getCache()
          const handle = lookupManifestHandle(manifest, account.id)
          if (!cache || !handle) {
            return resolveFallbackAccess(account, currentStorage, manifest)
          }
          return resolveFallbackAccess(account, currentStorage, manifest, {
            cache,
            manifestHandle: handle,
            requestPath: true,
            now: custodyOptions?.now ?? Date.now,
            refreshBeforeExpiryMs:
              (currentStorage.refresh?.refreshBeforeExpiryMinutes ?? 240) *
              60_000,
            completeEnrollmentDeps: {
              loadAccounts,
              readCustodyManifest,
              acquireRefreshFileLock,
              configPath: getConfigPath(),
              cache,
              minTtlMs: custodyMinTtlMs(currentStorage),
              mutateAccounts,
              provider: CUSTODY_OWNING_PROVIDER,
              now: Date.now,
            },
          })
        }
        async function reportAuthFailureForCustody(params: {
          handle: string
          providerStatus: number
          recordVersion: number
        }): Promise<void> {
          const cache = custodyRuntimeForDeps.getCache()
          if (!cache) return
          await cache.reportAuthFailure({
            handle: params.handle,
            providerStatus: params.providerStatus,
            recordVersion: params.recordVersion,
          })
        }
        function buildRefreshAllQuotaDeps(
          overrides: Partial<
            Pick<
              Parameters<typeof refreshAllQuota>[0],
              'respectBackoff' | 'skipFresherThanMs' | 'readSidebarState'
            >
          > = {},
        ): Parameters<typeof refreshAllQuota>[0] {
          return {
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
            isFallbackRefreshInert: isFallbackAccountRefreshInert,
            resolveFallbackAccess: resolveAccountAccessForCustody,
            reportCustodyAuthFailure: reportAuthFailureForCustody,
            ...overrides,
          }
        }

        // -------------------------------------------------------------------
        // CacheKeepManager — prompt-cache warmer for idle main-agent sessions
        // -------------------------------------------------------------------
        const cacheKeepLogger = createLogger('cachekeep')
        let cacheKeepEnabled = storage?.cachekeep?.enabled === true
        let cacheKeepSubagents = storage?.cachekeep?.subagents === true
        let cacheKeepSustain = storage?.cachekeep?.sustain === true
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
              if (
                tombstoned(
                  {
                    id: 'main',
                    type: 'oauth',
                    access: freshAuth.access ?? '',
                    refresh: freshAuth.refresh ?? '',
                    expires: freshAuth.expires ?? 0,
                    addedAt: 0,
                  },
                  CUSTODY_OWNING_PROVIDER,
                )
              ) {
                throw new CustodyTombstoneRefreshError(CUSTODY_OWNING_PROVIDER)
              }
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
            const currentStorage = fbStorage ?? {
              version: 1 as const,
              accounts: [account],
            }
            let resolved = account
            if (
              !(await isFallbackAccountRefreshInert(account, currentStorage))
            ) {
              resolved = await fallbackManager.refreshAccount(
                account,
                currentStorage,
              )
            }
            const access = await resolveAccountAccessForCustody(
              resolved,
              currentStorage,
            )
            if (access === CUSTODY_REFUSE || access === CUSTODY_EXCLUDED)
              throw new Error(`no access token for ${accountId}`)
            return {
              token: access.token,
              onAuthFailure:
                access.provenance === 'local'
                  ? undefined
                  : async (status: number) => {
                      await reportAuthFailureForCustody({
                        handle: access.provenance.handle,
                        providerStatus: status,
                        recordVersion: access.provenance.recordVersion,
                      })
                    },
            }
          },
          codexResponsesUrl: codexApiEndpoint,
          logger: cacheKeepLogger,
          now: Date.now,
          getWindow: () => cacheKeepWindow,
          getSustain: () => cacheKeepSustain,
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
          let resolvedMainIdentity: string | undefined
          if (accountId && accountId !== 'main') {
            // Bind the pushed snapshot to the ChatGPT identity of the token
            // that carried it (same derivation as main below), so a re-login on
            // this stable id stays detectable and the sidebar never pairs a
            // stale identity's quota with the new one.
            const fallbackClaims = accessToken
              ? parseJwtClaims(accessToken)
              : null
            const fallbackIdentity = fallbackClaims
              ? extractAccountIdFromClaims(fallbackClaims)
              : undefined
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
              fallbackIdentity,
            )
          } else {
            resolvedMainIdentity = mainAccountIdentity
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
          await writeMachineSidebarState(
            quotaManager,
            latestStorage,
            accountId && accountId !== 'main'
              ? latestStorage?.mainAccountId
              : resolvedMainIdentity,
          )
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
          mainAccountIdentity = store?.mainAccountId,
        ) {
          if (!store) return
          await setSidebarMachineState(
            buildSidebarMachineState(
              qm,
              store,
              Date.now(),
              mainAccountIdentity,
              runtimeCustodyProjection,
            ),
            boundSidebarFile,
          )
        }
        // Closure-resolved once per loader; the runtime owns the cached
        // projection map, the writer reads it sync.
        function runtimeCustodyProjection(
          account: FallbackAccount,
          currentNow: number,
        ): SidebarAccountCustody | undefined {
          if (account.type !== 'oauth') return undefined
          return custodyRuntimeForDeps.getCustodyProjection(account, currentNow)
        }

        async function writeRequestSidebarRouting(
          sessionId: string | undefined,
          parentSessionId: string | undefined,
          activeId: string,
          route: RoutingMode,
          accounts: readonly { id: string; enabled?: boolean }[] | undefined,
        ) {
          const input = { activeId, route, updatedAt: Date.now() }
          if (sessionId) {
            await upsertSidebarActiveRouting(
              { sessionId, ...input },
              accounts,
              boundSidebarFile,
            )
            if (parentSessionId && parentSessionId !== sessionId) {
              if (route === 'sticky-balanced') {
                const parentPinnedId = (await getSidebarState(boundSidebarFile))
                  .stickyAssignments?.[hashSidebarSessionId(parentSessionId)]
                  ?.accountId
                const parentPinIsUsable =
                  accounts === undefined ||
                  parentPinnedId === 'main' ||
                  accounts.some(
                    (account) =>
                      account.enabled !== false &&
                      account.id === parentPinnedId,
                  )
                if (!parentPinnedId || !parentPinIsUsable) return
                await upsertSidebarActiveRouting(
                  {
                    sessionId: parentSessionId,
                    activeId: parentPinnedId,
                    route,
                    updatedAt: Date.now(),
                  },
                  accounts,
                  boundSidebarFile,
                )
                return
              }
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
        const withFallbackAccountLock = async <T>(
          accountId: string,
          action: () => Promise<T>,
        ): Promise<T> => {
          const lock = await acquireRefreshFileLock({
            name: fallbackRefreshLockName(accountId),
            ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
            path: getConfigPath(),
            renew: true,
          })
          if (!lock) throw new Error('Fallback account lock unavailable')
          try {
            return await action()
          } finally {
            await lock.release()
          }
        }
        const checkUsableCustodyBinding = async (account: OAuthAccount) => {
          const manifest = await readCustodyManifest()
          if (!manifest.ok) {
            return {
              ready: false as const,
              reason: 'manifest-unreadable' as const,
            }
          }
          const handle = lookupManifestHandle(manifest, account.id)
          if (!handle)
            return { ready: false as const, reason: 'no-handle' as const }
          const cache = custodyRuntime.getCache()
          if (!cache || cache.isBlocked(handle)) {
            return { ready: false as const, reason: 'vault-cold' as const }
          }
          if (cache.isReauth(handle, custodyOptions?.now?.() ?? Date.now())) {
            return { ready: false as const, reason: 'vault-reauth' as const }
          }
          try {
            const credential = await cache.get(handle, custodyMinTtlMs(storage))
            const accountId = mainAccountIdFromServedCredential(
              credential.payload.access,
            )
            if (
              !accountId ||
              (account.accountId && account.accountId !== accountId)
            ) {
              return {
                ready: false as const,
                reason: 'identity-mismatch' as const,
              }
            }
            return { ready: true as const, accountId }
          } catch {
            return {
              ready: false as const,
              reason: cache.isReauth(
                handle,
                custodyOptions?.now?.() ?? Date.now(),
              )
                ? ('vault-reauth' as const)
                : ('vault-cold' as const),
            }
          }
        }
        cmdCtx = {
          accountStoragePath: getConfigPath(),
          quotaManager,
          loadAccounts,
          client: input.client as CommandContext['client'],
          beginAccountLogin,
          withFallbackAccountLock,
          checkUsableCustodyBinding,
          enterClaustrumMode: async () => {
            const current = await loadAccounts(getConfigPath())
            const accountIds = (current?.accounts ?? [])
              .filter(
                (account): account is OAuthAccount =>
                  account.type === 'oauth' && account.enabled !== false,
              )
              .map((account) => account.id)
            return enterClaustrumMode({
              accountIds,
              acquireLock: ({ name, renew }) =>
                acquireRefreshFileLock({
                  name,
                  ttlMs:
                    name === MAIN_REFRESH_LOCK_NAME
                      ? MAIN_REFRESH_LOCK_TTL_MS
                      : FALLBACK_REFRESH_LOCK_TTL_MS,
                  path: getConfigPath(),
                  renew,
                }),
              withStoreTransaction: (action) =>
                withAccountStoreTransaction(action, getConfigPath()),
              readManifest: readCustodyManifest,
              preflight: async ({ accountId, handle }) => {
                const cache = custodyRuntime.getCache()
                if (!cache || cache.isBlocked(handle)) return 'vault-cold'
                if (
                  cache.isReauth(handle, custodyOptions?.now?.() ?? Date.now())
                ) {
                  return 'vault-reauth'
                }
                try {
                  const credential = await cache.get(
                    handle,
                    custodyMinTtlMs(current),
                  )
                  const servedAccountId = mainAccountIdFromServedCredential(
                    credential.payload.access,
                  )
                  if (
                    !servedAccountId ||
                    (accountId && accountId !== servedAccountId)
                  ) {
                    return 'identity-mismatch'
                  }
                  return 'ready'
                } catch {
                  return cache.isReauth(
                    handle,
                    custodyOptions?.now?.() ?? Date.now(),
                  )
                    ? 'vault-reauth'
                    : 'vault-cold'
                }
              },
              auth: {
                all: () => hostAuth.all(),
                get: (value) => hostAuth.get(value),
                set: async (value) => {
                  await hostAuth.set(value)
                },
              },
              warn: (message) => custodyLogger.warn(message),
            })
          },
          leaveClaustrumMode: () =>
            leaveClaustrumMode({
              acquireLock: ({ name, renew }) =>
                acquireRefreshFileLock({
                  name,
                  ttlMs: MAIN_REFRESH_LOCK_TTL_MS,
                  path: getConfigPath(),
                  renew,
                }),
              withStoreTransaction: (action) =>
                withAccountStoreTransaction(action, getConfigPath()),
            }),
          resolveResetTarget: createResetTargetResolver({
            getAuth,
            refreshMainWithLease,
            refreshFallbackAccount: (account, currentStorage) =>
              fallbackManager.refreshAccount(account, currentStorage),
            loadAccounts,
            accountStoragePath: getConfigPath(),
            now: Date.now,
            isFallbackRefreshInert: isFallbackAccountRefreshInert,
            resolveFallbackAccess: resolveAccountAccessForCustody,
            reportAuthFailure: reportAuthFailureForCustody,
          }),
          ...buildResetRedemptionDeps(),
          cacheKeepManager,
          setCacheKeepEnabled: (enabled) => {
            cacheKeepEnabled = enabled
          },
          setCacheKeepSubagents: (enabled) => {
            cacheKeepSubagents = enabled
          },
          setCacheKeepSustain: (enabled) => {
            cacheKeepSustain = enabled
          },
          setCacheKeepWindow: (window) => {
            cacheKeepWindow = window
          },
          clearStickyRouting: (sessionId) =>
            clearSidebarStickyAssignment(sessionId, boundSidebarFile),
          getStickyRouting: async (sessionId) =>
            resolveSessionStickyAccount(
              await getSidebarState(boundSidebarFile),
              sessionId,
            ),
          refreshSidebar: async () => {
            const store = await loadAccounts(getConfigPath())
            await writeMachineSidebarState(quotaManager, store)
          },
          refreshAllQuota: async () =>
            refreshAllQuota(buildRefreshAllQuotaDeps()),
          refreshResetTargetQuota: async (accountKey) => {
            const results = await refreshAllQuota(
              buildRefreshAllQuotaDeps({ respectBackoff: false }),
              { accountKey },
            )
            return (
              results.find((result) => result.account === accountKey) ?? {
                account: accountKey,
                ok: false,
                error: 'targeted quota refresh returned no result',
              }
            )
          },
        }

        let rpcServer: RpcServerHandle | null = null
        if (input.directory) {
          const rpcDir = await resolveRpcDir(input.directory)
          const rpcGlobal = globalThis as {
            __openaiAuthRpcServer?: RpcServerHandle
          }
          if (rpcGlobal.__openaiAuthRpcServer) {
            await rpcGlobal.__openaiAuthRpcServer.stop().catch(() => {})
            rpcGlobal.__openaiAuthRpcServer = undefined
          }
          try {
            rpcServer = await startRpcServer({
              dir: rpcDir.dir,
              secureDir: rpcDir.secureDir,
              sweepRoot: rpcDir.sweepRoot,
              drain: drainNotifications,
              apply: async (request: ApplyRequest): Promise<ApplyResult> => {
                const callCtx: CommandContext = {
                  // biome-ignore lint/style/noNonNullAssertion: cmdCtx is set in the loader before RPC server starts, and command.execute.before has a null guard
                  ...cmdCtx!,
                  sessionId: request.sessionId,
                }
                const payload = await buildDialogPayload(
                  request.command,
                  request.arguments,
                  callCtx,
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
        const responseVaultProvenance = new WeakMap<Response, VaultProvenance>()

        function observeVaultAuthFailure(response: Response, url: URL): void {
          const provenance = responseVaultProvenance.get(response)
          if (
            !provenance ||
            url.hostname !== 'chatgpt.com' ||
            !url.pathname.startsWith('/backend-api/codex/')
          ) {
            return
          }
          if (response.status >= 200 && response.status < 300) {
            custodyRuntimeForDeps
              .getCache()
              ?.markVaultSuccess(provenance.handle)
            return
          }
          if (response.status !== 401) return
          void reportAuthFailureForCustody({
            handle: provenance.handle,
            providerStatus: response.status,
            recordVersion: provenance.recordVersion,
          }).catch(() => {})
        }

        async function sendWithAccessToken(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          accessToken: string,
          accountId?: string,
          keepwarmAccountKey: string = 'main',
          provenance?: VaultProvenance | 'local',
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
          const stamp = (response: Response) => {
            const stamped = stampVaultProvenance(
              response,
              provenance,
              responseVaultProvenance,
            )
            observeVaultAuthFailure(stamped, url)
            return stamped
          }

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
              accountId: keepwarmAccountKey,
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
            return stamp(await websocketFetch(url, requestInit))
          }
          const finalInit =
            OpenAIWebSocketPool.withoutInternalHeaders(requestInit)
          if (typeof finalInit?.body !== 'string') {
            return stamp(await fetch(url, finalInit))
          }

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
            accountId: keepwarmAccountKey,
          })
          try {
            const response = await fetch(url, finalInit)
            await dumpCodexRequest({
              sessionID,
              transport: 'http',
              phase: 'http',
              bodyText: finalInit.body,
              accountId: keepwarmAccountKey,
              url: url.toString(),
              method: finalInit.method,
              headers: finalInit.headers,
              status: response.status,
            })
            return stamp(translateHostedWebSearchResponse(response))
          } catch (error) {
            await dumpCodexRequest({
              sessionID,
              transport: 'http',
              phase: 'http',
              bodyText: finalInit.body,
              accountId: keepwarmAccountKey,
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

        // -----------------------------------------------------------------
        // Admission quota consultation: before probing an account, check the
        // shared sidebar file (written by every plugin process on the machine)
        // against the in-process cache, so a fresh process never spends a
        // doomed request on an account already known to be at 100%.
        // -----------------------------------------------------------------
        type AdmissionQuotaDecision =
          | { exhausted: false }
          | {
              exhausted: true
              source: 'memory' | 'file'
              resetsAt: string
              resetAtMs: number
            }

        // Freshness key for a quota snapshot: each window's own checkedAt,
        // then the snapshot-level checkedAt, then the cache entry's checkedAt.
        // Both primary and secondary windows are consulted — an account whose
        // only fresh window is the secondary must not be judged on the older
        // primary timestamp.
        function quotaCheckedAt(
          quota: AccountQuota | null | undefined,
          entryCheckedAt?: number,
        ): number | undefined {
          for (const checkedAt of [
            quota?.primary?.checkedAt,
            quota?.secondary?.checkedAt,
            quota?.checkedAt,
            entryCheckedAt,
          ]) {
            if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
              return checkedAt
            }
          }
          return undefined
        }

        // Picks the fresher of the in-process cache and the shared sidebar file
        // for one account, and reports which side won. The file is only
        // eligible when its row asserts the SAME identity the caller is acting
        // as: a differing id belongs to another account, and an unstamped row
        // (pre-upgrade or partially written) cannot be attributed to a known
        // identity that happens to reuse the same internal slot.
        function freshestQuotaSnapshot(
          quota: AccountQuota | null | undefined,
          entryCheckedAt: number | undefined,
          fileQuota: AccountQuota | null | undefined,
          fileAccountId?: string,
          currentAccountId?: string,
        ): {
          quota: AccountQuota | null | undefined
          quotaCheckedAt: number | undefined
          source: 'memory' | 'file'
        } {
          const memoryCheckedAt = quotaCheckedAt(quota, entryCheckedAt)
          const fileCheckedAt = quotaCheckedAt(fileQuota)
          const useFile =
            fileAccountId === currentAccountId &&
            fileQuota != null &&
            (quota === undefined ||
              (fileCheckedAt !== undefined &&
                (memoryCheckedAt === undefined ||
                  fileCheckedAt > memoryCheckedAt)))
          return {
            quota: useFile ? fileQuota : quota,
            quotaCheckedAt: useFile ? fileCheckedAt : memoryCheckedAt,
            source: useFile ? 'file' : 'memory',
          }
        }

        // Selects the fresher quota source and judges it. The file wins only
        // when strictly newer; memory wins ties; empty memory defers to a
        // valid file. A file row stamped with a DIFFERENT account identity is
        // treated as absent (fail-open) — a re-login must never be judged by
        // the previous account's exhaustion. An unstamped row (no accountId)
        // is also treated as absent when the live caller has a known identity,
        // so a pre-upgrade or partially-written row cannot misattribute its
        // exhaustion to a new account that reuses the same internal slot.
        function admissionQuotaDecision(
          memoryEntry: QuotaEntry | null,
          fileQuota: AccountQuota | null | undefined,
          now: number,
          fileAccountId?: string,
          currentAccountId?: string,
        ): AdmissionQuotaDecision {
          const memoryQuota = memoryEntry?.quota as AccountQuota | undefined
          const freshest = freshestQuotaSnapshot(
            memoryQuota,
            memoryEntry?.checkedAt,
            fileQuota,
            fileAccountId,
            currentAccountId,
          )
          const source = freshest.source
          const quota = freshest.quota
          if (!isQuotaExhausted(quota, now)) return { exhausted: false }

          const reset = exhaustedQuotaResetAt(quota, now)
          if (!reset) return { exhausted: false }
          return { exhausted: true, source, ...reset }
        }

        function logAdmissionQuotaSkip(
          accountId: string,
          decision: Extract<AdmissionQuotaDecision, { exhausted: true }>,
        ) {
          logQ.debug('admission skip: exhausted account', {
            accountId,
            source: decision.source,
            resetsAt: decision.resetsAt,
          })
        }

        // Synthetic provider-shaped 429 with a Retry-After derived from the
        // earliest known quota reset across all accounts. Returned when the
        // killswitch blocks the primary and no surviving account can serve, or
        // when admission knows the primary is temporarily unavailable for one
        // of the unconditional quota reasons.
        //
        // markResetAtMs carries the blocking account's own reset when the reason
        // has one. A known-exhausted quota uses that reset exactly; a transient
        // mid-stream mark takes the sooner of its bounded reset and any cached
        // quota reset so a missing quota snapshot cannot overstate the wait.
        function killswitchBlockedResponse(
          storage: AccountStorage | null,
          reason:
            | 'killswitch'
            | 'mid-stream-rate-limit'
            | 'quota-exhausted' = 'killswitch',
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
          if (reason === 'quota-exhausted' && markResetAtMs !== undefined) {
            retryAfter = Math.max(1, Math.ceil((markResetAtMs - now) / 1000))
          } else if (
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
              : reason === 'quota-exhausted'
                ? `OpenAI quota exhausted — retrying on another account. Retry in ${mins}m ${secs}s.`
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
          provenance: VaultProvenance | 'local'
          accountId?: string
          keepwarmAccountKey: string
          quotaAccountId: string
          fallback: FallbackAccount
        }

        type FallbackCandidateSelection = {
          current: FallbackCandidate[]
          retained: FallbackCandidate[]
          skipped: Array<{
            candidate: FallbackCandidate
            decision: Extract<AdmissionQuotaDecision, { exhausted: true }>
          }>
        }

        type StickyRouteCandidate = {
          accountId: string
          wireAccountId?: string
          access: string
          provenance?: VaultProvenance | 'local'
          keepwarmAccountKey: string
          fallback?: FallbackAccount
          quota: AccountQuota | null | undefined
          quotaCheckedAt?: number
          reservePercent: { primary: number; secondary: number }
          configuredOrder: number
          resetCreditsApplicable?: number
          // Killswitch gate resolved at roster build, using the non-invalidating
          // policy peek so a routine token refresh does not flip a killed
          // account to "unknown". `false` excludes the candidate from both
          // weighted placement and the mode-fallback fail-open branch.
          killswitchPasses?: boolean
        }

        function resetCreditsApplicable(value: unknown): number | undefined {
          // Field key fix: the storage shape is `resetCreditsAvailable` on
          // both OAuthQuotaSnapshot (core/accounts.ts:88) and AccountQuota
          // (sidebar-state.ts:13). The previous read of
          // `resetCreditsApplicable` was always undefined and the
          // credit-priority sort in selectStickyCandidate never fired in
          // production. The candidate field stays named
          // `resetCreditsApplicable` so the sort comparator downstream is
          // unchanged.
          const credits = (value as { resetCreditsAvailable?: unknown } | null)
            ?.resetCreditsAvailable
          return typeof credits === 'number' && Number.isFinite(credits)
            ? credits
            : undefined
        }

        async function buildStickyRouteRoster(input: {
          storage: Awaited<ReturnType<typeof loadAccounts>>
          sidebarState: SidebarState
          primaryAccess: string
          mainAccountIdentity?: string
        }): Promise<StickyRouteCandidate[]> {
          const killswitchEnabled = isKillswitchEnabled(input.storage)
          const killswitchNow = Date.now()
          const mainMemory = quotaManager.peekMainForPolicy(
            input.mainAccountIdentity,
          )
          const mainFreshest = freshestQuotaSnapshot(
            mainMemory?.quota as AccountQuota | undefined,
            mainMemory?.checkedAt,
            input.sidebarState.main.quota,
            input.sidebarState.main.mainAccountId,
            input.mainAccountIdentity,
          )
          // Killswitch (opt-in): pre-resolve the gate for each candidate so the
          // placement selector (weighted + mode-fallback) and the break decision
          // can both honour it without redoing the read. Undefined = passes —
          // the dominant path with killswitch disabled is byte-identical.
          const mainKillswitchPasses = killswitchEnabled
            ? killswitchPassesPolicy(
                mainMemory?.quota,
                input.storage,
                undefined,
                killswitchNow,
              )
            : undefined
          const roster: StickyRouteCandidate[] = [
            {
              accountId: 'main',
              wireAccountId: input.mainAccountIdentity,
              access: input.primaryAccess,
              keepwarmAccountKey: 'main',
              quota: mainFreshest.quota,
              quotaCheckedAt: mainFreshest.quotaCheckedAt,
              reservePercent: getKillswitchThresholdsForAccount(input.storage),
              configuredOrder: 0,
              resetCreditsApplicable: resetCreditsApplicable(
                mainFreshest.quota,
              ),
              killswitchPasses: mainKillswitchPasses,
            },
          ]
          const usableFallbacks =
            await fallbackManager.getUsableFallbackAccounts(input.storage)
          if (!input.storage) return roster
          for (const fallback of usableFallbacks) {
            const access = await resolveAccountAccessForCustody(
              fallback,
              input.storage,
            )
            if (access === CUSTODY_REFUSE || access === CUSTODY_EXCLUDED)
              continue
            const fileEntry = input.sidebarState.fallbacks.find(
              (account) => account.id === fallback.id,
            )
            const memoryEntry = quotaManager.peekFallbackForPolicy(
              fallback.id,
              fallback.accountId,
            )
            const freshest = freshestQuotaSnapshot(
              memoryEntry?.quota as AccountQuota | undefined,
              memoryEntry?.checkedAt,
              fileEntry?.quota,
              fileEntry?.accountId,
              fallback.accountId,
            )
            const fallbackKillswitchPasses = killswitchEnabled
              ? killswitchPassesPolicy(
                  memoryEntry?.quota,
                  input.storage,
                  fallback.id,
                  killswitchNow,
                )
              : undefined
            roster.push({
              accountId: fallback.id,
              wireAccountId: fallback.accountId,
              access: access.token,
              provenance: access.provenance,
              keepwarmAccountKey: fallback.id,
              fallback,
              quota: freshest.quota,
              quotaCheckedAt: freshest.quotaCheckedAt,
              reservePercent: getKillswitchThresholdsForAccount(
                input.storage,
                fallback.id,
              ),
              configuredOrder: roster.length,
              resetCreditsApplicable: resetCreditsApplicable(freshest.quota),
              killswitchPasses: fallbackKillswitchPasses,
            })
          }
          return roster
        }

        function stickyBreakDecision(
          candidate: StickyRouteCandidate,
          sidebarState: SidebarState,
          status: number | undefined,
          now: number,
          storage: Awaited<ReturnType<typeof loadAccounts>> | null,
        ): StickyBreakDecision {
          // Pre-resolved by the roster builder using the non-invalidating
          // policy peek. Pass it through so a retained pin whose account has
          // fallen below floor since the pin was created migrates the same
          // way an exhausted pin does. Undefined = passes (killswitch
          // disabled or no quota seen).
          const killswitchPasses = isKillswitchEnabled(storage)
            ? candidate.killswitchPasses
            : undefined
          if (candidate.accountId === 'main') {
            const memoryEntry = quotaManager.peekMainForPolicy(
              candidate.wireAccountId,
            )
            const freshest = freshestQuotaSnapshot(
              memoryEntry?.quota as AccountQuota | undefined,
              memoryEntry?.checkedAt,
              sidebarState.main.quota,
              sidebarState.main.mainAccountId,
              candidate.wireAccountId,
            )
            return decideStickyBreak({
              quota: freshest.quota,
              quotaCheckedAt: freshest.quotaCheckedAt,
              status,
              now,
              killswitchPasses,
            })
          }
          const fileEntry = sidebarState.fallbacks.find(
            (account) => account.id === candidate.accountId,
          )
          const memoryEntry = quotaManager.peekFallbackForPolicy(
            candidate.accountId,
            candidate.wireAccountId,
          )
          const freshest = freshestQuotaSnapshot(
            memoryEntry?.quota as AccountQuota | undefined,
            memoryEntry?.checkedAt,
            fileEntry?.quota,
            fileEntry?.accountId,
            candidate.wireAccountId,
          )
          return decideStickyBreak({
            quota: freshest.quota,
            quotaCheckedAt: freshest.quotaCheckedAt,
            status,
            now,
            killswitchPasses,
          })
        }

        function stickyRateLimitKey(candidate: StickyRouteCandidate): string {
          return candidate.accountId === 'main'
            ? 'main'
            : candidate.keepwarmAccountKey
        }

        function isStickyRouteCandidateRateLimited(
          candidate: StickyRouteCandidate,
        ): boolean {
          return quotaManager.isRateLimited(stickyRateLimitKey(candidate))
        }

        async function resolveStickyRouteCandidate(input: {
          sessionId: string
          requestBytes: number
          candidates: readonly StickyRouteCandidate[]
          excludeAccountIds?: readonly string[]
          now: number
        }): Promise<StickyRouteCandidate | undefined> {
          const eligibleCandidates = input.candidates.filter(
            (candidate) => !isStickyRouteCandidateRateLimited(candidate),
          )
          const candidatesById = new Map(
            eligibleCandidates.map((candidate) => [
              candidate.accountId,
              candidate,
            ]),
          )
          const quotaCheckedAtByAccount = Object.fromEntries(
            eligibleCandidates.map((candidate) => [
              candidate.accountId,
              candidate.quotaCheckedAt,
            ]),
          )
          const wireAccountIdByAccount = Object.fromEntries(
            eligibleCandidates.map((candidate) => [
              candidate.accountId,
              candidate.wireAccountId,
            ]),
          )
          const excluded = new Set(input.excludeAccountIds)
          let placement:
            | {
                accountId: string
                source: 'weighted' | 'mode-fallback'
                pendingBytes: number
              }
            | undefined
          const assignment = await resolveSidebarStickyAssignment(
            {
              sessionId: input.sessionId,
              requestBytes: input.requestBytes,
              now: input.now,
              validPinnedAccountIds: [...candidatesById.keys()],
              excludeAccountIds: input.excludeAccountIds,
              quotaCheckedAtByAccount,
              wireAccountIdByAccount,
              choose: (pendingBytes) => {
                const eligible = eligibleCandidates.filter(
                  (candidate) => !excluded.has(candidate.accountId),
                )
                if (eligible.length === 0) return undefined
                const selected = selectStickyCandidate({
                  candidates: eligible,
                  pendingBytes,
                  requestBytes: input.requestBytes,
                  now: input.now,
                  onEmptyWeightedSet: () => {
                    logA.debug(
                      'sticky routing: no fresh weighted candidates; using configured order',
                    )
                  },
                })
                // Every candidate killed by the killswitch filter. The caller
                // will translate the placed-pin absence into the shared
                // `killswitchBlockedResponse`, the same shape the ordered
                // modes produce.
                if (!selected) return undefined
                placement = {
                  accountId: selected.accountId,
                  source: selected.source,
                  pendingBytes: pendingBytes.get(selected.accountId) ?? 0,
                }
                return selected
              },
            },
            boundSidebarFile,
          )
          if (placement && assignment?.accountId === placement.accountId) {
            logA.debug('sticky routing: placed session pin', {
              pid: process.pid,
              sessionHash: hashSidebarSessionId(input.sessionId),
              accountId: placement.accountId,
              source: placement.source,
              requestBytes: input.requestBytes,
              pendingBytes: placement.pendingBytes,
            })
          }
          return assignment
            ? candidatesById.get(assignment.accountId)
            : undefined
        }

        async function usableFallbackCandidates(
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
          sidebarState: SidebarState,
        ): Promise<FallbackCandidateSelection> {
          const usableFallbacks =
            await fallbackManager.getUsableFallbackAccounts(fallbackStorage)
          const candidates: FallbackCandidate[] = []
          if (!fallbackStorage)
            return { current: [], retained: [], skipped: [] }
          for (const fb of usableFallbacks) {
            const access = await resolveAccountAccessForCustody(
              fb,
              fallbackStorage,
            )
            if (access === CUSTODY_REFUSE || access === CUSTODY_EXCLUDED)
              continue
            candidates.push({
              access: access.token,
              provenance: access.provenance,
              accountId: fb.accountId,
              keepwarmAccountKey: fb.id,
              quotaAccountId: fb.id,
              fallback: fb,
            })
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
          const current = isKillswitchEnabled(fallbackStorage)
            ? notRateLimited.filter((c) =>
                killswitchPassesPolicy(
                  quotaManager.peekFallbackForPolicy(
                    c.quotaAccountId,
                    c.accountId,
                  )?.quota,
                  fallbackStorage,
                  c.quotaAccountId,
                  Date.now(),
                ),
              )
            : notRateLimited
          // Admission: drop candidates whose freshest known quota (memory or
          // the shared sidebar file) is exhausted, so a doomed probe is never
          // spent on them.
          const fileQuotas = new Map(
            sidebarState.fallbacks.map((account) => [
              account.id,
              { quota: account.quota, accountId: account.accountId },
            ]),
          )
          const retained: FallbackCandidate[] = []
          const skipped: FallbackCandidateSelection['skipped'] = []
          const now = Date.now()
          for (const candidate of current) {
            const fileEntry = fileQuotas.get(candidate.quotaAccountId)
            const decision = admissionQuotaDecision(
              quotaManager.peekFallbackForPolicy(
                candidate.quotaAccountId,
                candidate.accountId,
              ),
              fileEntry?.quota,
              now,
              fileEntry?.accountId,
              candidate.accountId,
            )
            if (decision.exhausted) {
              skipped.push({ candidate, decision })
            } else {
              retained.push(candidate)
            }
          }
          return { current, retained, skipped }
        }

        function applyAdmissionQuotaSafety(
          selection: FallbackCandidateSelection,
          mainRemainsCandidate: boolean,
        ): FallbackCandidate[] {
          // The shared file is advisory. If filtering it would remove the last
          // admission path, keep probing in the original wire-authority order —
          // a stale or corrupt file can never brick routing.
          if (selection.retained.length === 0 && !mainRemainsCandidate) {
            return selection.current
          }
          for (const { candidate, decision } of selection.skipped) {
            logAdmissionQuotaSkip(candidate.quotaAccountId, decision)
          }
          return selection.retained
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
          candidates: FallbackCandidate[],
        ): Promise<
          | {
              response: Response
              accessToken: string
              quotaAccountId: string
              activeId: string
            }
          | undefined
        > {
          for (const candidate of candidates) {
            let response: Response
            try {
              response = await sendWithAccessToken(
                requestInput,
                init,
                candidate.access,
                candidate.accountId,
                candidate.keepwarmAccountKey,
                candidate.provenance,
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
              // Not awaited: the response is already in hand, and this only
              // stamps a telemetry timestamp nothing reads. Awaiting it puts a
              // contended store write between the provider's answer and the
              // user's screen — measured at 3.6s median and 15s worst case on a
              // busy host. markUsed swallows its own failures, so a dropped
              // stamp cannot surface as an unhandled rejection.
              void fallbackManager.markUsed(candidate.fallback)
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
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
          candidates: FallbackCandidate[],
        ) {
          if (!isReplayableRequest(requestInput, init)) {
            return { response: primaryResponse }
          }

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
                candidate.provenance,
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
              // See the fallback-first path above: telemetry only, never awaited
              // on the request path.
              void fallbackManager.markUsed(candidate.fallback)
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
          void refreshAllQuota(
            buildRefreshAllQuotaDeps({ respectBackoff: true }),
          ).catch((error) =>
            logQ.warn('boot quota seed failed', {
              pid: process.pid,
              error: errorMessage(error),
            }),
          )
        }

        backgroundQuotaRefresh.start(
          async () => {
            const results = await refreshQuotaInBackground(
              buildRefreshAllQuotaDeps({
                readSidebarState: () => getSidebarState(boundSidebarFile),
              }),
            )
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
            // Main-first and fallback-first select per request; sticky-balanced
            // resolves a per-session pin from sidebar state before sending.
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
            // One shared sidebar read per request: admission decisions for main
            // and the fallbacks must all judge the same snapshot.
            let requestSidebarStatePromise: Promise<SidebarState> | undefined
            const requestSidebarState = () => {
              requestSidebarStatePromise ??= getSidebarState(boundSidebarFile)
              return requestSidebarStatePromise
            }
            const sidebarState = await requestSidebarState()

            if (
              mode === 'sticky-balanced' &&
              sidebarSessionId &&
              isReplayableRequest(requestInput, init) &&
              typeof init?.body === 'string'
            ) {
              const requestBytes = Buffer.byteLength(init.body, 'utf8')
              const stickyRoster = await buildStickyRouteRoster({
                storage: reqStorage,
                sidebarState,
                primaryAccess,
                mainAccountIdentity,
              })
              let stickyCandidate = await resolveStickyRouteCandidate({
                sessionId: sidebarSessionId,
                requestBytes,
                candidates: stickyRoster,
                now: Date.now(),
              })

              if (stickyCandidate) {
                const preSendBreak = isStickyRouteCandidateRateLimited(
                  stickyCandidate,
                )
                  ? { action: 'migrate' as const, reason: 'exhausted' as const }
                  : stickyBreakDecision(
                      stickyCandidate,
                      sidebarState,
                      undefined,
                      Date.now(),
                      reqStorage,
                    )
                if (preSendBreak.action === 'migrate') {
                  const replacement = await resolveStickyRouteCandidate({
                    sessionId: sidebarSessionId,
                    requestBytes,
                    candidates: stickyRoster,
                    excludeAccountIds: [stickyCandidate.accountId],
                    now: Date.now(),
                  })
                  if (replacement) {
                    logA.debug('sticky routing: migrated session pin', {
                      pid: process.pid,
                      sessionHash: hashSidebarSessionId(sidebarSessionId),
                      fromAccountId: stickyCandidate.accountId,
                      toAccountId: replacement.accountId,
                      reason: preSendBreak.reason,
                    })
                    stickyCandidate = replacement
                  }
                }

                let stickyResponse = await sendWithAccessToken(
                  requestInput,
                  init,
                  stickyCandidate.access,
                  stickyCandidate.wireAccountId,
                  stickyCandidate.keepwarmAccountKey,
                  stickyCandidate.provenance,
                )

                const pushStickyQuota = async (
                  response: Response,
                  candidate: StickyRouteCandidate,
                ) => {
                  try {
                    const snapshot = normalizeQuotaHeaders(response.headers)
                    await pushQuota(
                      snapshot as Record<string, unknown>,
                      candidate.access,
                      candidate.accountId === 'main'
                        ? undefined
                        : candidate.accountId,
                      candidate.accountId === 'main'
                        ? candidate.wireAccountId
                        : undefined,
                      isCompleteQuotaHeaderFrame(response.headers),
                    )
                  } catch {
                    // Quota push is advisory; preserve the provider response.
                  }
                }

                await pushStickyQuota(stickyResponse, stickyCandidate)
                const responseBreak = stickyBreakDecision(
                  stickyCandidate,
                  sidebarState,
                  stickyResponse.status,
                  Date.now(),
                  reqStorage,
                )
                const retryableStickyFailure =
                  stickyResponse.status === 401 ||
                  stickyResponse.status === 403 ||
                  stickyResponse.status === 429
                if (
                  retryableStickyFailure &&
                  responseBreak.action === 'migrate'
                ) {
                  const replacement = await resolveStickyRouteCandidate({
                    sessionId: sidebarSessionId,
                    requestBytes,
                    candidates: stickyRoster,
                    excludeAccountIds: [stickyCandidate.accountId],
                    now: Date.now(),
                  })
                  if (replacement) {
                    logA.debug('sticky routing: migrated session pin', {
                      pid: process.pid,
                      sessionHash: hashSidebarSessionId(sidebarSessionId),
                      fromAccountId: stickyCandidate.accountId,
                      toAccountId: replacement.accountId,
                      reason: responseBreak.reason,
                    })
                    const previousResponse = stickyResponse
                    stickyResponse = await sendWithAccessToken(
                      requestInput,
                      init,
                      replacement.access,
                      replacement.wireAccountId,
                      replacement.keepwarmAccountKey,
                      replacement.provenance,
                    )
                    previousResponse.body?.cancel().catch(() => {})
                    stickyCandidate = replacement
                    await pushStickyQuota(stickyResponse, stickyCandidate)
                  }
                }

                if (
                  stickyCandidate.fallback &&
                  !shouldFallbackStatus(stickyResponse.status, reqStorage)
                ) {
                  // See the fallback-first path above: telemetry only, never
                  // awaited on the request path.
                  void fallbackManager.markUsed(stickyCandidate.fallback)
                }
                await writeRequestSidebarRouting(
                  sidebarSessionId,
                  sidebarParentSessionId,
                  stickyCandidate.accountId,
                  mode,
                  reqStorage?.accounts,
                ).catch(() => {})
                return stickyResponse
              }
            }

            const mainQuotaDecision = admissionQuotaDecision(
              quotaManager.peekMainForPolicy(mainAccountIdentity),
              sidebarState.main.quota,
              Date.now(),
              sidebarState.main.mainAccountId,
              mainAccountIdentity,
            )
            const killswitchBlocksMain =
              isKillswitchEnabled(reqStorage) &&
              !killswitchPassesPolicy(
                killswitchMainQuota(mainAccountIdentity),
                reqStorage,
                undefined,
                Date.now(),
              )
            const mainRateLimited = quotaManager.isRateLimited('main')
            let fallbackSelectionPromise:
              | Promise<FallbackCandidateSelection>
              | undefined
            const requestFallbackSelection = () => {
              fallbackSelectionPromise ??= usableFallbackCandidates(
                reqStorage,
                sidebarState,
              )
              return fallbackSelectionPromise
            }

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
            let fallbackCandidates: FallbackCandidate[] | undefined
            if (
              mode === 'fallback-first' &&
              isReplayableRequest(requestInput, init)
            ) {
              fallbacksAlreadyTried = true
              const selection = await requestFallbackSelection()
              fallbackCandidates = applyAdmissionQuotaSafety(
                selection,
                !killswitchBlocksMain &&
                  !mainRateLimited &&
                  !mainQuotaDecision.exhausted,
              )
              const pre = await tryFallbackFirst(
                requestInput,
                init,
                reqStorage,
                fallbackCandidates,
              )
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
              // Admission: a main the shared data already knows to be exhausted
              // is blocked only when the request is replayable AND a
              // non-exhausted fallback survives to serve. Otherwise the probe
              // stands — blocking a non-replayable request with no usable
              // fallback would be a hard denial with no wire check anywhere in
              // the request, so the wire gets the final say.
              const quotaBlocksMain =
                mainQuotaDecision.exhausted &&
                isReplayableRequest(requestInput, init) &&
                (await requestFallbackSelection()).retained.length > 0
              if (killswitchBlocksMain || mainRateLimited || quotaBlocksMain) {
                const blockReason = killswitchBlocksMain
                  ? 'killswitch'
                  : mainRateLimited
                    ? 'mid-stream-rate-limit'
                    : 'quota-exhausted'
                if (
                  blockReason === 'quota-exhausted' &&
                  mainQuotaDecision.exhausted
                ) {
                  logAdmissionQuotaSkip('main', mainQuotaDecision)
                }
                logA.debug('admission blocked primary', {
                  pid: process.pid,
                  activeId: 'main',
                  reason: blockReason,
                })
                response = killswitchBlockedResponse(
                  reqStorage,
                  blockReason,
                  blockReason === 'quota-exhausted' &&
                    mainQuotaDecision.exhausted
                    ? mainQuotaDecision.resetAtMs
                    : mainRateLimited
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
                  undefined,
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
              // Main already failed, so it is no longer a surviving candidate
              // for the admission safety valve.
              fallbackCandidates ??= applyAdmissionQuotaSafety(
                await requestFallbackSelection(),
                false,
              )
              const fallbackResult = await tryFallbackAccounts(
                requestInput,
                init,
                response,
                reqStorage,
                fallbackCandidates,
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
              reqStorage?.accounts,
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
            const mutex = await acquireCustodyTransitionMutex()
            try {
              const flow = custodyOptions?.authorize?.browser
                ? await custodyOptions.authorize.browser()
                : await (async () => {
                    const { redirectUri } = await startOAuthServer()
                    const pkce = await generatePKCE()
                    const state = base64UrlEncode(
                      crypto.getRandomValues(new Uint8Array(32)).buffer,
                    )
                    return {
                      url: buildAuthorizeUrl(redirectUri, pkce, state),
                      tokens: waitForOAuthCallback(pkce, state),
                      cleanup: () => flowCleanup(state),
                    }
                  })()

              return {
                url: flow.url,
                instructions:
                  'Complete authorization in your browser. This window will close automatically.',
                method: 'auto' as const,
                callback: async () => {
                  try {
                    const tokens = await flow.tokens
                    const result = {
                      type: 'success' as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires:
                        (custodyOptions?.now ?? Date.now)() +
                        (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                    void releaseCustodyLoginLeaseAfterHostWrite({
                      accessToken: tokens.access_token,
                      getAuth: async () => {
                        const auth = await hostAuth.get({
                          path: { id: 'openai' },
                        })
                        return isRecord(auth) && typeof auth.access === 'string'
                          ? { access: auth.access }
                          : undefined
                      },
                      release: () => mutex.release(),
                      warn: (message) => custodyLogger.warn(message),
                      now: custodyOptions?.now ?? Date.now,
                      sleep: custodyOptions?.sleep ?? ((ms) => Bun.sleep(ms)),
                    }).catch(() => mutex.release())
                    return result
                  } catch (error) {
                    await mutex.release()
                    throw error
                  } finally {
                    flow.cleanup?.()
                  }
                },
              }
            } catch (error) {
              await mutex.release()
              throw error
            }
          },
        },
        {
          label: 'ChatGPT Pro/Plus (headless)',
          type: 'oauth',
          authorize: async () => {
            const mutex = await acquireCustodyTransitionMutex()
            try {
              const flow = custodyOptions?.authorize?.headless
                ? await custodyOptions.authorize.headless()
                : await (async () => {
                    const { deviceData, url, instructions } =
                      await beginDeviceAuth()
                    return {
                      url,
                      instructions,
                      tokens: completeDeviceAuth(deviceData),
                    }
                  })()
              return {
                url: flow.url,
                instructions: flow.instructions,
                method: 'auto' as const,
                async callback() {
                  try {
                    const tokens = await flow.tokens
                    const result = {
                      type: 'success' as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires:
                        (custodyOptions?.now ?? Date.now)() +
                        (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                    void releaseCustodyLoginLeaseAfterHostWrite({
                      accessToken: tokens.access_token,
                      getAuth: async () => {
                        const auth = await hostAuth.get({
                          path: { id: 'openai' },
                        })
                        return isRecord(auth) && typeof auth.access === 'string'
                          ? { access: auth.access }
                          : undefined
                      },
                      release: () => mutex.release(),
                      warn: (message) => custodyLogger.warn(message),
                      now: custodyOptions?.now ?? Date.now,
                      sleep: custodyOptions?.sleep ?? ((ms) => Bun.sleep(ms)),
                    }).catch(() => mutex.release())
                    return result
                  } catch {
                    await mutex.release()
                    return { type: 'failed' as const }
                  }
                },
              }
            } catch (error) {
              await mutex.release()
              throw error
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
            'Show or change OpenAI account routing between main-first, fallback-first, and sticky-balanced.',
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
        [OPENAI_RESET_COMMAND_NAME]: {
          template: OPENAI_RESET_COMMAND_NAME,
          description: 'Spend one reset credit on an exhausted Codex account.',
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
