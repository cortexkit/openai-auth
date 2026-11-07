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
  type CacheKeepTargetView,
  type CacheKeepWindow,
  normalizeCacheKeepWindow,
} from '@cortexkit/common-auth/cachekeep'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import type {
  AccountKey,
  SessionActivityStore,
} from '@cortexkit/common-auth/limits'
import {
  type AccountStorage,
  ttlForModel as coreTtlForModel,
  extractAccountIdFromClaims,
  is30MinCacheSupportedModel,
  normalizeQuotaHeaders,
  type OpenAiVault,
  parseJwtClaims,
  recordSessionCompletion,
  redactCredentialError,
  redactCredentialResponse,
  reportSessionCacheWarmed,
  reportSessionCacheWarmStopped,
  type SessionDispatch,
  sessionCacheKeepPlan,
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
  /**
   * Where the warm is sent. Absent means the manager's `codexResponsesUrl`.
   * OpenCode 2 sets it to the URL its captured request went to.
   */
  url?: string
  /**
   * Which store served the captured request: a local pool row or the vault.
   * Set by OpenCode 2, whose `verifyCredential` refuses a warm whose fresh
   * credential comes from the other store.
   */
  credentialMode?: 'local' | 'vault'
}

/**
 * The size bounds of a keep-warm manager: the most sessions tracked at once
 * and the most captured body bytes (UTF-8) held across them.
 *
 * `@cortexkit/common-auth/cachekeep` does not export its defaults, so these
 * equal them as read from the installed package, version 0.19.0:
 * `DEFAULT_MAX_TARGETS = 32` and `DEFAULT_MAX_BYTES = 8 * 1024 * 1024` in
 * `node_modules/@cortexkit/common-auth/dist/cachekeep/manager.js`. A test
 * checks that a manager built without caps still evicts at these bounds.
 * OpenCode 2 passes them to its manager explicitly; OpenCode 1 relies on the
 * package defaults.
 */
export const CACHE_KEEP_CAPS: Readonly<{
  maxTargets: number
  maxBytes: number
}> = Object.freeze({ maxTargets: 32, maxBytes: 8 * 1024 * 1024 })

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
  sessionID?: string
}): KeepwarmCapture | undefined {
  if (!input.enabled || typeof input.body !== 'string') return undefined

  const isSubagent = input.headers.has('x-parent-session-id')
  if (isSubagent && !input.includeSubagents) return undefined

  const sessionKey =
    input.sessionID ??
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

// Schedule against the conservative model TTL, not longer observed cache tails.
const THIRTY_MIN_CACHE_TTL_MS = 30 * 60 * 1000
// Subagent sessions are short-lived: two ~30-min warms give about an hour of
// cache coverage without over-warming a one-off session.
const THIRTY_MIN_CACHE_SUBAGENT_MAX_WARMS = 2
// Idle bound for a subagent on these models: room for both warms on the happy
// path (~58 min) while still eventually reclaiming a stuck target whose warms
// never reach the 2-warm cap. The default 30-min subagent bound would reclaim
// it before its first warm.
const THIRTY_MIN_CACHE_SUBAGENT_MAX_IDLE_MS =
  2 * THIRTY_MIN_CACHE_TTL_MS + 15 * 60 * 1000

export function ttlForModel(bodyText: string, defaultTtlMs: number): number {
  return coreTtlForModel(bodyText, defaultTtlMs)
}

/**
 * The per-target overrides for a captured request: a model with the 30-minute
 * policy TTL gets that lifetime, and a subagent on one is retired after
 * two warms with an idle bound long enough for both. Everything else keeps
 * the manager's defaults.
 */
export function openaiCacheKeepProfile(input: {
  bodyText: string
  isSubagent: boolean
}): CacheKeepProfile | undefined {
  if (!is30MinCacheSupportedModel(input.bodyText)) return undefined
  if (!input.isSubagent) return { ttlMs: THIRTY_MIN_CACHE_TTL_MS }
  return {
    ttlMs: THIRTY_MIN_CACHE_TTL_MS,
    maxWarms: THIRTY_MIN_CACHE_SUBAGENT_MAX_WARMS,
    maxIdleMs: THIRTY_MIN_CACHE_SUBAGENT_MAX_IDLE_MS,
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
      /**
       * The ChatGPT account the token signs in as, when the caller knows it;
       * otherwise it is read from the token. Only `verifyCredential` uses it.
       */
      identity?: string
      onAuthFailure?: (status: number) => Promise<void>
    }

/** What `verifyCredential` is shown of a warm's fresh credential. */
export interface CacheKeepCredentialCheck {
  target: CacheKeepTargetView<OpenAICacheKeepMeta>
  /** Which store the credential came from. */
  mode: 'local' | 'vault'
  /** The ChatGPT account the credential signs in as, when known. */
  identity: string | undefined
}

export interface OpenAICacheKeepAdapterBaseOptions {
  fetchImpl: typeof fetch
  /** Session policy activity is committed only after a successful warm is consumed. */
  activity?: {
    store: SessionActivityStore
    /** Current session binding, including whether its account was replaced; never derive it from a bearer alone. */
    accountKey: (
      check: CacheKeepCredentialCheck,
    ) => AccountKey | undefined | Promise<AccountKey | undefined>
  }
  now?: () => number
  /**
   * Called with each warm's fresh credential just before the warm is sent.
   * A throw sends nothing and backs the target off, unless the callback has
   * removed the target from the manager, which drops it without a warning.
   */
  verifyCredential?: (check: CacheKeepCredentialCheck) => void | Promise<void>
  /**
   * Replays on vault accounts obtain a bearer through the vault's send path.
   * While enrolled, a replay captured on a local account sends nothing and
   * does not read or refresh that account's token.
   */
  vault?: Pick<OpenAiVault, 'owns' | 'send' | 'authority' | 'reportUsage'>
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

/**
 * Where a local-mode warm gets its bearer: either OpenCode 1's pair, split by
 * main account and fallback row, or one resolver that is given the whole
 * target (OpenCode 2, whose targets carry the store that served them).
 */
export type CacheKeepLocalCredentialOptions =
  | {
      /** The main account's bearer; a throw (no token) backs the target off. */
      getMainToken: () => Promise<string>
      /**
       * Resolve the local fallback row identified by `accountId` to a bearer for
       * this replay. `onAuthFailure` handles a 401 on that resolved credential.
       */
      refreshFallback: (accountId: string) => Promise<CacheKeepFallbackAccess>
      resolveLocal?: never
    }
  | {
      getMainToken?: never
      refreshFallback?: never
      /** The bearer for the target's own account; a throw backs it off. */
      resolveLocal: (
        target: CacheKeepTargetView<OpenAICacheKeepMeta>,
      ) => Promise<CacheKeepFallbackAccess>
    }

export type OpenAICacheKeepAdapterOptions = OpenAICacheKeepAdapterBaseOptions &
  CacheKeepLocalCredentialOptions

function identityOfToken(token: string): string | undefined {
  const claims = parseJwtClaims(token)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

export function createOpenAICacheKeepAdapter(
  options: OpenAICacheKeepAdapterOptions,
): CacheKeepAdapter<OpenAICacheKeepMeta> {
  const log = options.logger
  const activeAccount = options.activeAccount
  return {
    plan: sessionCacheKeepPlan,
    onWarmed: reportSessionCacheWarmed,
    onWarmStopped: reportSessionCacheWarmStopped,
    buildBody: (target) => buildKeepwarmBody(target.bodyText),

    async send({ target, body, signal }) {
      // `vaultAttempt` is the vault's receipt when the vault sends (it calls
      // this with the served token and the receipt); a local send passes the
      // row's known identity instead.
      const dispatch = async (
        accessToken: string,
        vaultAttempt?: QuotaReceipt,
        localIdentity?: string,
      ) => {
        // Stopped, or the warm timed out, while the token resolved: send nothing.
        signal.throwIfAborted()
        const check: CacheKeepCredentialCheck = {
          target,
          mode: vaultAttempt ? 'vault' : 'local',
          identity:
            (vaultAttempt ? vaultAttempt.accountIdentity : localIdentity) ??
            identityOfToken(accessToken),
        }
        await options.verifyCredential?.(check)
        const accountKey = await options.activity?.accountKey(check)
        signal.throwIfAborted()
        const dispatched: SessionDispatch | undefined = accountKey
          ? {
              sessionId: target.meta.routingSessionId ?? target.sessionKey,
              accountKey,
              dispatchedAt: (options.now ?? Date.now)(),
              ttlMs: ttlForModel(target.bodyText, target.ttlMs),
            }
          : undefined

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

        try {
          const response = await options.fetchImpl(
            target.meta.url ?? options.codexResponsesUrl,
            sanitizeHttpFallbackInit({
              method: 'POST',
              headers,
              body,
              signal,
            }),
          )
          if (vaultAttempt && target.accountId)
            options.vault?.reportUsage(
              target.accountId,
              { headers: response.headers },
              vaultAttempt,
            )
          // The shared manager reads and logs diagnostics after this attempt's token leaves scope.
          const redacted = await redactCredentialResponse(
            response,
            accessToken,
            'event-stream',
          )
          if (!redacted.ok || !dispatched || !options.activity) return redacted
          const activity = options.activity
          const accept = async () => {
            const active = await activeAccount?.(target.meta.routingSessionId)
            if (activeAccount && active !== target.accountId) return
            const current = await activity.accountKey(check)
            recordSessionCompletion(activity.store, dispatched, current, {
              kind: 'keep-warm',
              status: redacted.status,
              aborted: signal.aborted,
            })
          }
          if (!redacted.body) {
            await accept()
            return redacted
          }
          // Completion, not response headers, accepts the warm. A cancelled or
          // failed body must not extend the session's cache lifetime.
          const reader = redacted.body.getReader()
          return new Response(
            new ReadableStream({
              async pull(controller) {
                try {
                  const chunk = await reader.read()
                  if (chunk.done) {
                    await accept()
                    controller.close()
                  } else controller.enqueue(chunk.value)
                } catch (error) {
                  controller.error(error)
                }
              },
              cancel(reason) {
                return reader.cancel(reason)
              },
            }),
            {
              status: redacted.status,
              statusText: redacted.statusText,
              headers: redacted.headers,
            },
          )
        } catch (error) {
          throw redactCredentialError(error, accessToken)
        }
      }

      if (target.accountId && options.vault?.owns(target.accountId)) {
        // The vault owns both the per-attempt authorization and 401 reporting;
        // a refusal before dispatch must not be reported as a provider failure.
        const response = await options.vault.send(target.accountId, dispatch, {
          site: 'cachekeep',
          signal,
        })
        if (!response)
          throw new Error(`vault refused warm for ${target.accountId}`)
        return response
      }

      // A target captured on a local account before this host connected to
      // the vault: vault mode warms no local account. The throw backs the
      // target off like any failed warm; nothing was sent.
      if (options.vault && (await options.vault.authority()) !== 'local')
        throw new Error(
          'local accounts are not warmed while this host is connected to the vault',
        )

      let accessToken: string
      let identity: string | undefined
      let onAuthFailure: ((status: number) => Promise<void>) | undefined
      const resolved = options.resolveLocal
        ? await options.resolveLocal(target)
        : target.accountId && target.accountId !== 'main'
          ? await options.refreshFallback(target.accountId)
          : await options.getMainToken()
      if (typeof resolved === 'string') {
        accessToken = resolved
      } else {
        accessToken = resolved.token
        identity = resolved.identity
        onAuthFailure = resolved.onAuthFailure
      }
      // Enrollment can finish during token resolution; do not dispatch the
      // resolved local bearer after authority has switched away from local.
      if (options.vault && (await options.vault.authority()) !== 'local')
        throw new Error(
          'local accounts are not warmed while this host is connected to the vault',
        )
      const response = await dispatch(accessToken, undefined, identity)
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
    getMainToken: _getMainToken,
    refreshFallback: _refreshFallback,
    resolveLocal: _resolveLocal,
    vault,
    codexResponsesUrl,
    activeAccount,
    verifyCredential,
    activity,
    logger,
    ...managerOptions
  } = options
  const local: CacheKeepLocalCredentialOptions =
    options.resolveLocal !== undefined
      ? { resolveLocal: options.resolveLocal }
      : {
          getMainToken: options.getMainToken,
          refreshFallback: options.refreshFallback,
        }
  return new CacheKeepManager<OpenAICacheKeepMeta>({
    ...managerOptions,
    logger,
    adapter: createOpenAICacheKeepAdapter({
      fetchImpl,
      ...local,
      vault,
      codexResponsesUrl,
      activeAccount,
      verifyCredential,
      activity,
      now: options.now,
      logger,
    }),
  })
}
