/**
 * OpenAI's half of prompt-cache keep-warm.
 *
 * The scheduling (targets, idle and size caps, the clock window, backoff,
 * coalesced ticks) is the shared `CacheKeepManager` from
 * `@cortexkit/common-auth/cachekeep`. What stays here is everything that knows
 * about Codex: which request headers identify a session and must be replayed,
 * how a captured Responses body becomes a warm request, the gpt-5.6 cache
 * lifetime and subagent policy, how an account's bearer is resolved, and how
 * usage is read back from a JSON or SSE response.
 */
import {
  type CacheKeepAdapter,
  type CacheKeepLogger,
  CacheKeepManager,
  type CacheKeepManagerOptions,
  type CacheKeepProfile,
  type CacheKeepWindow,
  normalizeCacheKeepWindow,
} from '@cortexkit/common-auth/cachekeep'
import {
  type AccountStorage,
  normalizeQuotaHeaders,
} from '@cortexkit/openai-auth-core/internal'
import { sanitizeHttpFallbackInit } from '../codex-http'
import {
  hashSidebarSessionId,
  type SidebarState,
  STICKY_ASSIGNMENT_MAX_AGE_MS,
} from '../sidebar-state'

export {
  CacheKeepManager,
  type CacheKeepStatus,
  type CacheKeepWindow,
  isWithinCacheKeepWindow,
} from '@cortexkit/common-auth/cachekeep'

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Plugin data stored with each target and handed back on every warm. */
export interface OpenAICacheKeepMeta {
  /** Cache-relevant request headers, replayed verbatim on the warm request. */
  replayHeaders: Record<string, string>
  /** The ChatGPT account id sent as `ChatGPT-Account-Id`; absent for none. */
  chatgptAccountId?: string
  /**
   * The session id the router keyed this request's routing by. It can differ
   * from the target's session key: the captured body is the prepared request,
   * whose `session-id` header may already be the Codex thread id.
   */
  routingSessionId?: string
}

export interface KeepwarmCapture {
  sessionKey: string
  bodyText: string
  replayHeaders: Record<string, string>
  isSubagent: boolean
}

export function buildKeepwarmCapture(input: {
  enabled: boolean
  includeSubagents: boolean
  headers: Headers
  body: unknown
}): KeepwarmCapture | undefined {
  if (!input.enabled || typeof input.body !== 'string') return undefined

  const isSubagent = input.headers.has('x-parent-session-id')
  if (isSubagent && !input.includeSubagents) return undefined

  const sessionKey =
    input.headers.get('session-id') ??
    input.headers.get('x-opencode-session') ??
    input.headers.get('x-session-affinity') ??
    undefined
  if (!sessionKey) return undefined

  const replayHeaders: Record<string, string> = {}
  for (const name of [
    'session-id',
    'x-session-affinity',
    'x-parent-session-id',
    'user-agent',
    'version',
    'x-codex-beta-features',
    'x-codex-turn-metadata',
    'x-codex-window-id',
    'x-client-request-id',
    'thread-id',
    'x-openai-internal-codex-responses-lite',
  ]) {
    const value = input.headers.get(name)
    if (value) replayHeaders[name] = value
  }

  return { sessionKey, bodyText: input.body, replayHeaders, isSubagent }
}

/** The persisted `cachekeep` clock window, or undefined for "always warm". */
export function getCacheKeepWindow(
  storage: AccountStorage | null,
): CacheKeepWindow | undefined {
  return normalizeCacheKeepWindow(storage?.cachekeep)
}

// ---------------------------------------------------------------------------
// Per-model profile
// ---------------------------------------------------------------------------

// gpt-5.6 prompts live on Codex's prompt cache for ~30 min, vs ~5 min for older
// models, so per-target TTL is raised to 30 min to match — keeps the warm
// cadence honest (warm just before the real 30-min eviction, not every 5 min).
const GPT_5_6_TTL_MS = 30 * 60 * 1000 // 30 min
// Subagent sessions are short-lived: two ~30-min warms give about an hour of
// cache coverage without over-warming a one-off session.
const GPT_5_6_SUBAGENT_MAX_WARMS = 2
// Long idle bound for 5.6 subagents — gives the session room for both warms on
// the happy path (~58 min) while still eventually reclaiming a stuck target
// whose warms never reach the 2-warm cap. The default 30-min subagent bound
// would reclaim it before its first warm.
const GPT_5_6_SUBAGENT_MAX_IDLE_MS = 2 * GPT_5_6_TTL_MS + 15 * 60 * 1000

// Single source of truth for "is this body a gpt-5.6 request?". Exact-match
// or `gpt-5.6-` prefix so a hypothetical sibling id (gpt-5.60, gpt-5.6x,
// legacy-gpt-5.6-revival) doesn't pick up the long-TTL treatment.
function isGpt56Model(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const model = parsed.model
    if (typeof model !== 'string') return false
    return model === 'gpt-5.6' || model.startsWith('gpt-5.6-')
  } catch {
    return false
  }
}

export function ttlForModel(bodyText: string, defaultTtlMs: number): number {
  return isGpt56Model(bodyText) ? GPT_5_6_TTL_MS : defaultTtlMs
}

/**
 * The per-target overrides for a captured request: gpt-5.6 gets its longer
 * cache lifetime, and a gpt-5.6 subagent is retired after two warms with an
 * idle bound long enough for both. Everything else keeps the manager's
 * defaults.
 */
export function openaiCacheKeepProfile(input: {
  bodyText: string
  isSubagent: boolean
}): CacheKeepProfile | undefined {
  if (!isGpt56Model(input.bodyText)) return undefined
  if (!input.isSubagent) return { ttlMs: GPT_5_6_TTL_MS }
  return {
    ttlMs: GPT_5_6_TTL_MS,
    maxWarms: GPT_5_6_SUBAGENT_MAX_WARMS,
    maxIdleMs: GPT_5_6_SUBAGENT_MAX_IDLE_MS,
  }
}

// ---------------------------------------------------------------------------
// Replay body
// ---------------------------------------------------------------------------

export function buildKeepwarmBody(bodyText: string): string {
  const parsed = JSON.parse(bodyText)
  const clone = parsed as Record<string, unknown>
  clone.store = false
  delete clone.max_output_tokens
  delete clone.max_tokens
  delete clone.max_completion_tokens
  return JSON.stringify(clone)
}

// ---------------------------------------------------------------------------
// Usage parsing
// ---------------------------------------------------------------------------

function emptyKeepwarmUsage(): {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  hit_rate: number | null
} {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    hit_rate: null,
  }
}

function extractUsageObject(
  usage: unknown,
): ReturnType<typeof emptyKeepwarmUsage> {
  if (!usage || typeof usage !== 'object') return emptyKeepwarmUsage()
  const usageRecord = usage as Record<string, unknown>
  const input_tokens =
    Number(usageRecord.input_tokens) || Number(usageRecord.prompt_tokens) || 0
  const output_tokens =
    Number(usageRecord.output_tokens) ||
    Number(usageRecord.completion_tokens) ||
    0
  const details =
    (usageRecord.input_tokens_details as Record<string, unknown> | undefined) ??
    (usageRecord.prompt_tokens_details as Record<string, unknown> | undefined)
  const cached_tokens =
    Number(details?.cached_tokens) || Number(usageRecord.cached_tokens) || 0

  const hit_rate = input_tokens > 0 ? cached_tokens / input_tokens : null
  return { input_tokens, output_tokens, cached_tokens, hit_rate }
}

function extractKeepwarmUsage(
  bodyText: string,
): ReturnType<typeof emptyKeepwarmUsage> {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    return extractUsageObject(parsed.usage)
  } catch {
    return emptyKeepwarmUsage()
  }
}

function extractKeepwarmSseUsage(
  bodyText: string,
): ReturnType<typeof emptyKeepwarmUsage> {
  let eventName: string | undefined
  let dataLines: string[] = []
  let usage: ReturnType<typeof emptyKeepwarmUsage> | undefined

  const flushEvent = () => {
    if (!dataLines.length) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    const currentEvent = eventName
    eventName = undefined
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data) as Record<string, unknown>
      const type = event.type ?? currentEvent
      if (type !== 'response.completed' && type !== 'response.done') return
      const response = event.response as Record<string, unknown> | undefined
      usage = extractUsageObject(response?.usage ?? event.usage)
    } catch {
      // Ignore malformed diagnostic events and keep scanning.
    }
  }

  for (const line of bodyText.split(/\r?\n/)) {
    if (line === '') {
      flushEvent()
      continue
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:'))
      dataLines.push(line.slice('data:'.length).trim())
  }
  flushEvent()
  return usage ?? emptyKeepwarmUsage()
}

// ---------------------------------------------------------------------------
// Session routing
// ---------------------------------------------------------------------------

/**
 * The account a session is bound to now, read from sidebar state (with this
 * process's unsaved sticky pins already applied by the caller), or undefined
 * when the session has no binding.
 *
 * In sticky-balanced mode the binding is the session's pin: a session moved to
 * another account (re-pinned, or its pin cleared and placed elsewhere) no
 * longer uses the cache on the account that captured it. In the ordered modes
 * the binding is the per-session route the request path records for the
 * account that last served the session, and only while it was recorded under
 * the current mode; a route from an earlier mode says nothing about where the
 * next request goes.
 */
export function routedAccountForSession(
  state: SidebarState,
  sessionId: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!sessionId) return undefined
  if (state.route === 'sticky-balanced') {
    const assignment =
      state.stickyAssignments?.[hashSidebarSessionId(sessionId)]
    if (!assignment) return undefined
    if (assignment.lastSeenAt < now - STICKY_ASSIGNMENT_MAX_AGE_MS)
      return undefined
    return assignment.accountId
  }
  const entry = state.activeRouting?.[sessionId]
  if (!entry || entry.route !== state.route) return undefined
  return entry.activeId
}

// ---------------------------------------------------------------------------
// Adapter and manager
// ---------------------------------------------------------------------------

type CacheKeepFallbackAccess =
  | string
  | {
      token: string
      onAuthFailure?: (status: number) => Promise<void>
    }

export interface OpenAICacheKeepAdapterOptions {
  fetchImpl: typeof fetch
  /** The main account's bearer; a throw (no token) backs the target off. */
  getMainToken: () => Promise<string>
  /**
   * A fallback account's bearer by storage id. `onAuthFailure` reports a 401
   * on a vault-served credential back to its custodian.
   */
  refreshFallback: (accountId: string) => Promise<CacheKeepFallbackAccess>
  codexResponsesUrl: string
  /**
   * The account the target's session routes to now (see
   * `routedAccountForSession`), or undefined when it has no binding.
   */
  activeAccount?: (
    routingSessionId: string | undefined,
  ) => string | undefined | Promise<string | undefined>
  logger?: CacheKeepLogger
}

export function createOpenAICacheKeepAdapter(
  options: OpenAICacheKeepAdapterOptions,
): CacheKeepAdapter<OpenAICacheKeepMeta> {
  const log = options.logger
  const activeAccount = options.activeAccount
  return {
    buildBody: (target) => buildKeepwarmBody(target.bodyText),

    async send({ target, body, signal }) {
      let accessToken: string
      let onAuthFailure: ((status: number) => Promise<void>) | undefined
      if (target.accountId && target.accountId !== 'main') {
        const resolved = await options.refreshFallback(target.accountId)
        if (typeof resolved === 'string') {
          accessToken = resolved
        } else {
          accessToken = resolved.token
          onAuthFailure = resolved.onAuthFailure
        }
      } else {
        accessToken = await options.getMainToken()
      }
      // Stopped, or the warm timed out, while the token resolved: send nothing.
      signal.throwIfAborted()

      const headers: Record<string, string> = {
        ...target.meta.replayHeaders,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      }
      if (target.meta.chatgptAccountId) {
        headers['ChatGPT-Account-Id'] = target.meta.chatgptAccountId
      } else {
        delete headers['ChatGPT-Account-Id']
      }

      let warmBodyShape: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        warmBodyShape = {
          warmBodyKeys: Object.keys(parsed),
          stream: parsed.stream,
          max_output_tokens: parsed.max_output_tokens,
          store: parsed.store,
          has_stream_options: 'stream_options' in parsed,
          has_max_tokens: 'max_tokens' in parsed,
          model: parsed.model,
        }
      } catch {
        // Diagnostic logging must never block the warm.
      }
      log?.debug('cachekeep warm request', {
        ...warmBodyShape,
        headerKeys: Object.keys(headers),
        hasChatGptAccountId: 'ChatGPT-Account-Id' in headers,
      })

      const response = await options.fetchImpl(
        options.codexResponsesUrl,
        sanitizeHttpFallbackInit({
          method: 'POST',
          headers,
          body,
          signal,
        }),
      )
      if (response.status === 401) await onAuthFailure?.(response.status)
      return response
    },

    readUsage({ response, text }) {
      const contentType = response.headers.get('content-type') ?? ''
      const isSse =
        contentType.includes('text/event-stream') ||
        /(^|\n)(data:|event:)/.test(text.slice(0, 200))
      log?.debug('cachekeep warm response', {
        status: response.status,
        contentType,
        bodyLen: text.length,
        isSse,
      })
      const usage = isSse
        ? extractKeepwarmSseUsage(text)
        : extractKeepwarmUsage(text)
      const quota = normalizeQuotaHeaders(response.headers)
      return {
        ...usage,
        quota_primary_pct: quota.primary?.usedPercent ?? null,
        quota_secondary_pct: quota.secondary?.usedPercent ?? null,
      }
    },

    profile: openaiCacheKeepProfile,

    ...(activeAccount
      ? {
          activeAccount: (_sessionKey, target) =>
            activeAccount(target.meta.routingSessionId),
        }
      : {}),
  }
}

export type OpenAICacheKeepManager = CacheKeepManager<OpenAICacheKeepMeta>

export type OpenAICacheKeepManagerOptions = OpenAICacheKeepAdapterOptions &
  Omit<CacheKeepManagerOptions<OpenAICacheKeepMeta>, 'adapter' | 'logger'>

/** A keep-warm manager with OpenAI's adapter and per-model profile. */
export function createCacheKeepManager(
  options: OpenAICacheKeepManagerOptions,
): OpenAICacheKeepManager {
  const {
    fetchImpl,
    getMainToken,
    refreshFallback,
    codexResponsesUrl,
    activeAccount,
    logger,
    ...managerOptions
  } = options
  return new CacheKeepManager<OpenAICacheKeepMeta>({
    ...managerOptions,
    logger,
    adapter: createOpenAICacheKeepAdapter({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl,
      activeAccount,
      logger,
    }),
  })
}
