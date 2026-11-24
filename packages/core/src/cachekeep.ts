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
  type CacheKeepTrackInput,
  type CacheKeepWindow,
  normalizeCacheKeepWindow,
} from '@cortexkit/common-auth/cachekeep'
import type { QuotaReceipt } from '@cortexkit/common-auth/claustrum'
import type {
  AccountKey,
  SessionActivityStore,
} from '@cortexkit/common-auth/limits'
import type { AccountStorage } from './accounts'
import { orderCodexBody } from './codex-body'
import { sanitizeHttpFallbackInit } from './codex-http'
import { RESPONSES_LITE_HEADER } from './codex-lite'
import {
  inputTransformationsOf,
  logInputTransformations,
} from './input-transformations'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth'
import { normalizeQuotaHeaders } from './quota-normalize'
import {
  is30MinCacheSupportedModel,
  recordSessionCompletion,
  type SessionDispatch,
  ttlForModel,
} from './session-cache-activity'
import {
  reportSessionCacheWarmed,
  reportSessionCacheWarmStopped,
  sessionCacheKeepPlan,
} from './session-cache-policy'
import {
  redactCredentialError,
  redactCredentialResponse,
} from './util/credential-redaction'
import { isRecord } from './util/record'
import type { OpenAiVault } from './vault'

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
  /** Captured request headers; only cache identity and Lite can be replayed. */
  replayHeaders: Record<string, string>
  /** The ChatGPT account header sent by the captured request, if any. */
  chatgptAccountId?: string
  /** Identity from the sent bearer when the host did not send an account header. */
  effectiveAccountId?: string
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

/** The persisted `cachekeep` clock window, or undefined for "always warm". */
export function getCacheKeepWindow(
  storage: Pick<AccountStorage, 'cachekeep'> | null,
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
// HTTP replay
// ---------------------------------------------------------------------------

export function buildKeepwarmBody(bodyText: string): string {
  const parsed = JSON.parse(bodyText)
  const clone = parsed as Record<string, unknown>
  clone.store = false
  delete clone.max_output_tokens
  delete clone.max_tokens
  delete clone.max_completion_tokens
  return JSON.stringify(orderCodexBody(clone))
}

const KEEPWARM_REPLAY_HEADERS = new Set([
  'originator',
  'session-id',
  'thread-id',
  'user-agent',
  'version',
  'x-client-request-id',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-opencode-parent-session-id',
  'x-parent-session-id',
  'x-session-affinity',
  RESPONSES_LITE_HEADER,
])

/** Keep only the headers the warm can replay, without retaining credentials. */
export function keepwarmReplayHeaders(
  headers: Headers,
): Record<string, string> {
  return Object.fromEntries(
    [...headers].filter(([name]) => KEEPWARM_REPLAY_HEADERS.has(name)),
  )
}

/** Build the HTTP request from the prepared warm body and a verified credential. */
export function buildKeepwarmRequest(input: {
  body: string
  replayHeaders: Readonly<Record<string, string>>
  credential: { token: string; identity: string | undefined }
  signal: AbortSignal
}): RequestInit {
  const headers = new Headers()
  for (const [name, value] of Object.entries(input.replayHeaders)) {
    if (KEEPWARM_REPLAY_HEADERS.has(name.toLowerCase()))
      headers.set(name, value)
  }
  headers.set('authorization', `Bearer ${input.credential.token}`)
  if (input.credential.identity)
    headers.set('chatgpt-account-id', input.credential.identity)
  // The HTTP transport sets its own Accept and Content-Type and translates
  // any WebSocket Lite flag into the corresponding HTTP header.
  const request = {
    method: 'POST',
    headers,
    body: input.body,
    signal: input.signal,
  }
  return sanitizeHttpFallbackInit(request) ?? request
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

interface KeepwarmReply {
  usage: ReturnType<typeof emptyKeepwarmUsage>
  transformedResponse?: Record<string, unknown>
  isSse: boolean
}

function createKeepwarmSseReader() {
  let partialLine = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let usage: ReturnType<typeof emptyKeepwarmUsage> | undefined
  let transformedResponse: Record<string, unknown> | undefined

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
      if (type === 'response.completed' && inputTransformationsOf(response))
        transformedResponse ??= response
      usage = extractUsageObject(response?.usage ?? event.usage)
    } catch {
      // Ignore malformed diagnostic events and keep scanning.
    }
  }

  const readLine = (line: string) => {
    if (line === '') flushEvent()
    else if (line.startsWith('event:'))
      eventName = line.slice('event:'.length).trim()
    else if (line.startsWith('data:'))
      dataLines.push(line.slice('data:'.length).trim())
  }

  return {
    push(chunk: string) {
      const lines = (partialLine + chunk).split(/\r?\n/)
      partialLine = lines.pop() ?? ''
      for (const line of lines) readLine(line)
    },
    finish(): KeepwarmReply {
      readLine(partialLine)
      flushEvent()
      return {
        isSse: true,
        usage: usage ?? emptyKeepwarmUsage(),
        ...(transformedResponse && { transformedResponse }),
      }
    },
  }
}

function createKeepwarmReplyReader(contentType: string) {
  let sse = contentType.includes('text/event-stream')
    ? createKeepwarmSseReader()
    : undefined
  let text = ''
  return {
    push(chunk: string) {
      if (sse) sse.push(chunk)
      else {
        text += chunk
        if (/(^|\n)(data:|event:)/.test(text.slice(0, 200))) {
          sse = createKeepwarmSseReader()
          sse.push(text)
          text = ''
        }
      }
    },
    finish(): KeepwarmReply {
      if (sse) return sse.finish()
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        return {
          isSse: false,
          usage: extractUsageObject(parsed.usage),
          ...(inputTransformationsOf(parsed) && {
            transformedResponse: parsed,
          }),
        }
      } catch {
        return { isSse: false, usage: emptyKeepwarmUsage() }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Adapter and manager
// ---------------------------------------------------------------------------

type CacheKeepLocalAccess =
  | string
  | {
      token: string
      /**
       * The ChatGPT account the token signs in as, when the caller knows it;
       * otherwise it is read from the token.
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
  host?: 'opencode1' | 'opencode2' | 'pi'
  /** Optional vault billing observer; absent on OpenCode 1 and local sends. */
  observeBillingSend?: (
    target: CacheKeepTargetView<OpenAICacheKeepMeta>,
    body: string,
    receipt: QuotaReceipt,
    attempt: number,
  ) => { response(response: Response): Response; failed(): void } | undefined
  /** Session policy activity is committed only after a successful warm is consumed. */
  activity?: {
    store: SessionActivityStore
    /** Current session binding, including whether its account was replaced; never derive it from a bearer alone. */
    accountKey: (
      check: CacheKeepCredentialCheck,
    ) => AccountKey | undefined | Promise<AccountKey | undefined>
  }
  now?: () => number
  /** Read the identity from the bearer when the host's wire header uses a specific claim. */
  credentialIdentity?: (token: string) => string | undefined
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
      getMainToken: () => Promise<CacheKeepLocalAccess>
      /**
       * Resolve the local fallback row identified by `accountId` to a bearer for
       * this replay. `onAuthFailure` handles a 401 on that resolved credential.
       */
      refreshFallback: (accountId: string) => Promise<CacheKeepLocalAccess>
      resolveLocal?: never
    }
  | {
      getMainToken?: never
      refreshFallback?: never
      /** The bearer for the target's own account; a throw backs it off. */
      resolveLocal: (
        target: CacheKeepTargetView<OpenAICacheKeepMeta>,
      ) => Promise<CacheKeepLocalAccess>
    }

export type OpenAICacheKeepAdapterOptions = OpenAICacheKeepAdapterBaseOptions &
  CacheKeepLocalCredentialOptions

export function resolveCacheKeepAccountIdentity(
  token: string,
  knownIdentity?: string,
): string | undefined {
  if (knownIdentity !== undefined) return knownIdentity
  const claims = parseJwtClaims(token)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

export function createOpenAICacheKeepAdapter(
  options: OpenAICacheKeepAdapterOptions,
  dropTarget?: (sessionKey: string, diagnostic: string) => void,
  transformedWarms = new Set<string>(),
): CacheKeepAdapter<OpenAICacheKeepMeta> {
  const log = options.logger
  const activeAccount = options.activeAccount
  const observedReplies = new WeakMap<Response, KeepwarmReply>()
  return {
    plan: sessionCacheKeepPlan,
    onWarmed(sessionKey, input) {
      if (!transformedWarms.delete(sessionKey))
        reportSessionCacheWarmed(sessionKey, input)
    },
    onWarmStopped: reportSessionCacheWarmStopped,
    buildBody: (target) => buildKeepwarmBody(target.bodyText),

    async send({ target, body, signal }) {
      let physicalAttempt = 0
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
          identity: options.credentialIdentity
            ? options.credentialIdentity(accessToken)
            : resolveCacheKeepAccountIdentity(
                accessToken,
                vaultAttempt ? vaultAttempt.accountIdentity : localIdentity,
              ),
        }
        await options.verifyCredential?.(check)
        const capturedIdentity =
          target.meta.chatgptAccountId ?? target.meta.effectiveAccountId
        if (check.identity !== capturedIdentity) {
          dropTarget?.(
            target.sessionKey,
            'the account signs in as another login now',
          )
          throw new Error('the account signs in as another login now')
        }
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

        let warmBodyShape: Record<string, unknown> | undefined
        const billing =
          vaultAttempt && options.observeBillingSend
            ? options.observeBillingSend(
                target,
                body,
                vaultAttempt,
                ++physicalAttempt,
              )
            : undefined
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
        try {
          // Matching the account does not mean the foreground sent a header.
          // Preserve that omission even when the fresh token names the account.
          const headerIdentity =
            target.meta.chatgptAccountId === undefined
              ? undefined
              : check.identity
          const request = buildKeepwarmRequest({
            body,
            replayHeaders: target.meta.replayHeaders,
            credential: { token: accessToken, identity: headerIdentity },
            signal,
          })
          log?.debug('cachekeep warm request', {
            ...warmBodyShape,
            headerKeys: [...new Headers(request.headers).keys()],
            hasChatGptAccountId: headerIdentity !== undefined,
          })
          const received = await options.fetchImpl(
            target.meta.url ?? options.codexResponsesUrl,
            request,
          )
          const response = billing ? billing.response(received) : received
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
          const decoder = new TextDecoder()
          const reply = createKeepwarmReplyReader(
            redacted.headers.get('content-type') ?? '',
          )
          const observed = new Response(
            new ReadableStream({
              async pull(controller) {
                try {
                  const chunk = await reader.read()
                  if (chunk.done) {
                    reply.push(decoder.decode())
                    const result = reply.finish()
                    observedReplies.set(observed, result)
                    if (!result.transformedResponse) await accept()
                    controller.close()
                  } else {
                    reply.push(decoder.decode(chunk.value, { stream: true }))
                    controller.enqueue(chunk.value)
                  }
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
          return observed
        } catch (error) {
          billing?.failed()
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

    readUsage({ response, text, target }) {
      const contentType = response.headers.get('content-type') ?? ''
      let reply = observedReplies.get(response)
      if (!reply) {
        const reader = createKeepwarmReplyReader(contentType)
        reader.push(text)
        reply = reader.finish()
      }
      if (reply.transformedResponse) {
        if (dropTarget) {
          // Common-auth's CacheKeepManager calls onWarmed even after readUsage
          // removes the target. Remember which warm touch to suppress.
          transformedWarms.add(target.sessionKey)
          dropTarget(target.sessionKey, 'provider transformed input')
        }
        let chained: boolean | undefined
        try {
          const request: unknown = JSON.parse(target.bodyText)
          if (isRecord(request)) chained = 'previous_response_id' in request
        } catch {
          // A non-JSON capture cannot establish whether the request chained.
        }
        logInputTransformations(
          reply.transformedResponse,
          'http',
          options.host ?? 'opencode1',
          {
            warm: true,
            chained,
          },
        )
      }
      log?.debug('cachekeep warm response', {
        status: response.status,
        contentType,
        bodyLen: text.length,
        isSse: reply.isSse,
      })
      const quota = normalizeQuotaHeaders(response.headers)
      return {
        ...reply.usage,
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
    host = 'opencode1',
    observeBillingSend,
    credentialIdentity,
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
  const transformedWarms = new Set<string>()
  class ReplayManager extends CacheKeepManager<OpenAICacheKeepMeta> {
    override track(input: CacheKeepTrackInput<OpenAICacheKeepMeta>) {
      const result = super.track(input)
      if (result.tracked) transformedWarms.delete(input.sessionKey)
      return result
    }
  }
  const manager: OpenAICacheKeepManager = new ReplayManager({
    ...managerOptions,
    logger,
    adapter: createOpenAICacheKeepAdapter(
      {
        fetchImpl,
        host,
        observeBillingSend,
        credentialIdentity,
        ...local,
        vault,
        codexResponsesUrl,
        activeAccount,
        verifyCredential,
        activity,
        now: options.now,
        logger,
      },
      (sessionKey, diagnostic) => {
        manager.remove(sessionKey)
        logger?.debug(`cachekeep dropped target (${diagnostic})`, {
          sessionKey,
        })
      },
      transformedWarms,
    ),
  })
  return manager
}
