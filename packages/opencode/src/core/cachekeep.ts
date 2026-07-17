import { sanitizeHttpFallbackInit } from '../codex-http'
import { normalizeQuotaHeaders } from '../quota-normalize'
import type { AccountStorage } from './accounts.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheKeepWindow = {
  startHour: number
  endHour: number
}

export interface Target {
  bodyText: string
  accountId: string | undefined
  chatgptAccountId?: string
  route: 'main'
  cacheExpiresAt: number
  ttlMs: number
  warmCount: number
  lastRealRequestAt: number
  lastWarmedAt?: number
  backoffUntil?: number
  replayHeaders: Record<string, string>
  isSubagent?: boolean
  // Captured from isGpt56Model(bodyText) at track() time. Cached on the target
  // so pruneStale and the warm cap don't have to re-parse the body (and so a
  // misconfig of TTL defaults can't silently flip 5.6-ness).
  is56: boolean
}

export interface CacheKeepManagerOptions {
  fetchImpl: typeof fetch
  getMainToken: () => Promise<string>
  refreshFallback: (accountId: string) => Promise<string>
  codexResponsesUrl: string
  logger: {
    info: (msg: string, data?: unknown) => void
    warn: (msg: string, data?: unknown) => void
    debug: (msg: string, data?: unknown) => void
    error: (msg: string, data?: unknown) => void
  }
  now: () => number
  ttlMs?: number
  leadMs?: number
  maxDurationMs?: number
  maxIdleWarmMs?: number
  maxSubagentIdleMs?: number
  tickIntervalMs?: number
  maxTargets?: number
  maxBytes?: number
  /** Returns the configured clock-hour window; undefined means always warm. */
  getWindow?: () => CacheKeepWindow | undefined
}

export interface CacheKeepStatus {
  running: boolean
  tracked: number
  generatedAt: number
  startedAt: number | null
  maxIdleWarmMs: number
  maxSubagentIdleMs: number
  ttlMs: number
  leadMs: number
  window?: CacheKeepWindow
  targets: Array<{
    sessionKey: string
    accountId: string | undefined
    route: 'main'
    cacheExpiresAt: number
    lastRealRequestAt: number
    lastWarmedAt?: number
    backoffUntil?: number
    bodyBytes: number
  }>
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function getCacheKeepWindow(
  storage: AccountStorage | null,
): CacheKeepWindow | undefined {
  const startHour = Number(storage?.cachekeep?.startHour)
  const endHour = Number(storage?.cachekeep?.endHour)
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return undefined
  }
  return { startHour, endHour }
}

export function isWithinCacheKeepWindow(
  window: CacheKeepWindow | undefined,
  now = new Date(),
): boolean {
  if (!window) return false
  const hour = now.getHours()
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour
  }
  // Overnight wrap (e.g. 22-6): hours are in window if at or after start, or before end.
  return hour >= window.startHour || hour < window.endHour
}

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 min
// gpt-5.6 prompts live on Codex's prompt cache for ~30 min, vs ~5 min for older
// models, so per-target TTL is raised to 30 min to match — keeps the warm
// cadence honest (warm just before the real 30-min eviction, not every 5 min).
const GPT_5_6_TTL_MS = 30 * 60 * 1000 // 30 min
// Long idle bound for 5.6 subagents — gives the session room for both warms on
// the happy path (~58 min) while still eventually reclaims a stuck target whose
// warms never reach the 2-warm cap.
const GPT_5_6_SUBAGENT_MAX_IDLE_MS = 2 * GPT_5_6_TTL_MS + 15 * 60 * 1000
const DEFAULT_MAX_IDLE_WARM_MS = 60 * 60 * 1000 // 1 h
const DEFAULT_MAX_SUBAGENT_IDLE_MS = 30 * 60 * 1000 // 30 min
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000 // 60 s
const DEFAULT_MAX_TARGETS = 32
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 // 8 MiB total
const BACKOFF_MS = 10 * 60 * 1000 // 10 min backoff after failure

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

// ---------------------------------------------------------------------------
// buildKeepwarmBody
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

export function ttlForModel(bodyText: string, defaultTtlMs: number): number {
  return isGpt56Model(bodyText) ? GPT_5_6_TTL_MS : defaultTtlMs
}

// ---------------------------------------------------------------------------
// extractKeepwarmUsage
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
// CacheKeepManager
// ---------------------------------------------------------------------------

export class CacheKeepManager {
  private readonly targets = new Map<string, Target>()
  private readonly fetchImpl: typeof fetch
  private readonly getMainToken: () => Promise<string>
  private readonly refreshFallback: (accountId: string) => Promise<string>
  private readonly codexResponsesUrl: string
  private readonly log: CacheKeepManagerOptions['logger']
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly leadMs: number
  private readonly maxIdleWarmMs: number
  private readonly maxSubagentIdleMs: number
  private readonly tickIntervalMs: number
  private readonly maxTargets: number
  private readonly maxBytes: number
  private readonly getWindow?: () => CacheKeepWindow | undefined

  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt: number | null = null
  private totalBytes = 0
  private tickInFlight = false
  private disposed = false
  private abortController = new AbortController()

  private logPayload(
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { pid: process.pid, ...fields }
  }

  constructor(options: CacheKeepManagerOptions) {
    this.fetchImpl = options.fetchImpl
    this.getMainToken = options.getMainToken
    this.refreshFallback = options.refreshFallback
    this.codexResponsesUrl = options.codexResponsesUrl
    this.log = options.logger
    this.now = options.now
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.leadMs = options.leadMs ?? this.tickIntervalMs + 15_000
    const maxIdleWarmMs = options.maxIdleWarmMs ?? options.maxDurationMs
    this.maxIdleWarmMs =
      typeof maxIdleWarmMs === 'number' &&
      Number.isFinite(maxIdleWarmMs) &&
      maxIdleWarmMs > 0
        ? maxIdleWarmMs
        : DEFAULT_MAX_IDLE_WARM_MS
    const maxSubagentIdleMs =
      options.maxSubagentIdleMs ?? DEFAULT_MAX_SUBAGENT_IDLE_MS
    this.maxSubagentIdleMs =
      typeof maxSubagentIdleMs === 'number' &&
      Number.isFinite(maxSubagentIdleMs) &&
      maxSubagentIdleMs > 0
        ? maxSubagentIdleMs
        : DEFAULT_MAX_SUBAGENT_IDLE_MS
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.getWindow = options.getWindow
  }

  // -- public API ------------------------------------------------------------

  track(
    sessionKey: string,
    bodyText: string,
    accountId: string | undefined,
    chatgptAccountId?: string,
    replayHeaders: Record<string, string> = {},
    isSubagent = false,
  ): void {
    // Prune targets abandoned beyond the idle warm cap.
    this.pruneStale()

    const bodyBytes = bodyText.length
    if (bodyBytes > this.maxBytes) {
      this.log.debug(
        'cachekeep track skipped (body exceeds maxBytes)',
        this.logPayload({
          sessionKey,
          bodyBytes,
          maxBytes: this.maxBytes,
        }),
      )
      return
    }

    // Outside a configured clock window the manager doesn't capture or fire.
    // Undefined window means "always warm" — the legacy behavior.
    const window = this.getWindow?.()
    if (window && !isWithinCacheKeepWindow(window, new Date(this.now()))) {
      this.log.debug(
        'cachekeep track skipped (outside window)',
        this.logPayload({
          sessionKey,
          startHour: window.startHour,
          endHour: window.endHour,
        }),
      )
      return
    }

    // Replace existing entry for same session (delete+re-add so freshest body wins)
    if (this.targets.has(sessionKey)) {
      const old = this.targets.get(sessionKey)
      if (old) this.totalBytes -= old.bodyText.length
      this.targets.delete(sessionKey)
    } else {
      this.log.debug(
        'cachekeep captured target',
        this.logPayload({ sessionKey, accountId }),
      )
    }

    // Enforce size cap before adding
    while (
      this.targets.size >= this.maxTargets ||
      (this.totalBytes + bodyBytes > this.maxBytes && this.targets.size > 0)
    ) {
      let evictKey: string | undefined
      let evictTouchedAt = Number.POSITIVE_INFINITY
      for (const [key, target] of this.targets) {
        const touchedAt = Math.max(
          target.lastRealRequestAt,
          target.lastWarmedAt ?? 0,
        )
        if (touchedAt < evictTouchedAt) {
          evictKey = key
          evictTouchedAt = touchedAt
        }
      }
      if (evictKey === undefined) break
      const old = this.targets.get(evictKey)
      if (old) this.totalBytes -= old.bodyText.length
      this.targets.delete(evictKey)
    }

    const ttlMs = ttlForModel(bodyText, this.ttlMs)
    const target: Target = {
      bodyText,
      accountId: accountId || undefined,
      chatgptAccountId,
      route: 'main',
      ttlMs,
      cacheExpiresAt: this.now() + ttlMs,
      warmCount: 0,
      lastRealRequestAt: this.now(),
      replayHeaders,
      isSubagent,
      is56: isGpt56Model(bodyText),
    }
    this.targets.set(sessionKey, target)
    this.totalBytes += bodyBytes
    this.start()
  }

  private isGpt56Subagent(target: Target): boolean {
    return target.isSubagent === true && target.is56
  }

  private pruneStale(): void {
    const now = this.now()
    const mainStaleBound = now - this.maxIdleWarmMs
    const subStaleBound = now - this.maxSubagentIdleMs
    const gpt56SubStaleBound = now - GPT_5_6_SUBAGENT_MAX_IDLE_MS
    for (const [key, target] of this.targets) {
      // gpt-5.6 subagents are governed by the 2-warm cap on the happy path
      // (~58 min), so the default 30-min subagent idle bound would reclaim
      // them before the first warm. Use the longer 5.6-subagent bound so
      // both warms can complete on a working session, while a stuck one
      // (warms persistently failing → warmCount < 2 → cap never fires) is
      // eventually reclaimed here.
      let bound: number
      let maxIdleMs: number
      if (this.isGpt56Subagent(target)) {
        bound = gpt56SubStaleBound
        maxIdleMs = GPT_5_6_SUBAGENT_MAX_IDLE_MS
      } else {
        bound = target.isSubagent ? subStaleBound : mainStaleBound
        maxIdleMs = target.isSubagent
          ? this.maxSubagentIdleMs
          : this.maxIdleWarmMs
      }
      if (target.lastRealRequestAt < bound) {
        this.log.debug(
          'cachekeep pruned idle target',
          this.logPayload({
            sessionKey: key,
            accountId: target.accountId ?? 'main',
            lastRealRequestAt: target.lastRealRequestAt,
            maxIdleWarmMs: maxIdleMs,
          }),
        )
        this.totalBytes -= target.bodyText.length
        this.targets.delete(key)
      }
    }
  }

  start(): void {
    this.disposed = false
    if (this.timer) return
    this.startedAt = this.now()
    this.log.debug(
      'cachekeep started',
      this.logPayload({
        ttlMs: this.ttlMs,
        leadMs: this.leadMs,
        maxIdleWarmMs: this.maxIdleWarmMs,
      }),
    )

    this.timer = setInterval(() => {
      void this.tick().catch(() => {})
    }, this.tickIntervalMs)
    if ('unref' in this.timer) this.timer.unref()
  }

  stop(): void {
    this.disposed = true
    this.abortController.abort()
    this.abortController = new AbortController()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.startedAt = null
    this.targets.clear()
    this.totalBytes = 0
    this.log.debug('cachekeep stopped', this.logPayload())
  }

  remove(sessionKey: string): void {
    const old = this.targets.get(sessionKey)
    if (old) {
      this.totalBytes -= old.bodyText.length
      this.targets.delete(sessionKey)
      this.log.debug(
        'cachekeep removed target',
        this.logPayload({ sessionKey }),
      )
    }
  }

  status(): CacheKeepStatus {
    const generatedAt = this.now()

    const targets = Array.from(this.targets.entries()).map(
      ([sessionKey, t]) => ({
        sessionKey,
        accountId: t.accountId,
        route: t.route,
        cacheExpiresAt: t.cacheExpiresAt,
        lastRealRequestAt: t.lastRealRequestAt,
        lastWarmedAt: t.lastWarmedAt,
        backoffUntil: t.backoffUntil,
        bodyBytes: t.bodyText.length,
      }),
    )

    return {
      running: this.timer != null,
      tracked: this.targets.size,
      generatedAt,
      startedAt: this.startedAt,
      maxIdleWarmMs: this.maxIdleWarmMs,
      maxSubagentIdleMs: this.maxSubagentIdleMs,
      ttlMs: this.ttlMs,
      leadMs: this.leadMs,
      window: this.getWindow?.(),
      targets,
    }
  }

  // -- tick ------------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = true
    try {
      this.pruneStale()
      // Skip the fire loop when outside a configured clock window — captured
      // targets stay in the map and will warm again when the window reopens.
      const window = this.getWindow?.()
      if (window && !isWithinCacheKeepWindow(window, new Date(this.now()))) {
        return
      }
      const now = this.now()
      const leadBound = now + this.leadMs

      for (const [sessionKey, target] of this.targets) {
        if (
          target.backoffUntil &&
          now >= target.backoffUntil &&
          target.cacheExpiresAt <= leadBound
        ) {
          await this.prewarm(sessionKey, target)
        }
      }

      for (const [sessionKey, target] of this.targets) {
        // Skip if in backoff
        if (target.backoffUntil && now < target.backoffUntil) continue

        // Fire prewarm if within LEAD window
        if (target.cacheExpiresAt <= leadBound) {
          await this.prewarm(sessionKey, target)
        }
      }
    } finally {
      this.tickInFlight = false
    }
  }

  // -- prewarm ---------------------------------------------------------------

  private async prewarm(sessionKey: string, target: Target): Promise<void> {
    // Resolve token
    let accessToken: string
    try {
      if (target.accountId && target.accountId !== 'main') {
        accessToken = await this.refreshFallback(target.accountId)
      } else {
        accessToken = await this.getMainToken()
      }
    } catch (err) {
      if (!this.disposed && this.targets.get(sessionKey) === target) {
        target.backoffUntil = this.now() + BACKOFF_MS
      }
      this.log.debug(
        'cachekeep skip (no token)',
        this.logPayload({
          sessionKey,
          accountId: target.accountId ?? 'main',
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      return
    }

    if (this.disposed || this.targets.get(sessionKey) !== target) return

    const headers: Record<string, string> = {
      ...target.replayHeaders,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    }
    if (target.chatgptAccountId) {
      headers['ChatGPT-Account-Id'] = target.chatgptAccountId
    } else {
      delete headers['ChatGPT-Account-Id']
    }

    try {
      const warmBody = buildKeepwarmBody(target.bodyText)
      let warmBodyShape: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(warmBody) as Record<string, unknown>
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
      this.log.debug(
        'cachekeep warm request',
        this.logPayload({
          ...warmBodyShape,
          headerKeys: Object.keys(headers),
          hasChatGptAccountId: 'ChatGPT-Account-Id' in headers,
        }),
      )
      const requestInit = sanitizeHttpFallbackInit({
        method: 'POST',
        headers,
        body: warmBody,
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          this.abortController.signal,
        ]),
      })
      const response = await this.fetchImpl(this.codexResponsesUrl, requestInit)

      // Read the response body for usage
      let responseText = ''
      try {
        responseText = await response.text()
      } catch {
        // body already consumed or error
      }

      if (this.disposed || this.targets.get(sessionKey) !== target) return

      if (!response.ok) {
        target.backoffUntil = this.now() + BACKOFF_MS
        this.log.warn(
          'cachekeep failed',
          this.logPayload({
            session: sessionKey,
            accountId: target.accountId ?? 'main',
            status: response.status,
            error: `HTTP ${response.status}`,
            responseBody: responseText.slice(0, 600),
          }),
        )
        return
      }

      const contentType = response.headers.get('content-type') ?? ''
      const isSse =
        contentType.includes('text/event-stream') ||
        /(^|\n)(data:|event:)/.test(responseText.slice(0, 200))
      this.log.debug(
        'cachekeep warm response',
        this.logPayload({
          status: response.status,
          contentType,
          bodyLen: responseText.length,
          isSse,
        }),
      )
      const usage = isSse
        ? extractKeepwarmSseUsage(responseText)
        : extractKeepwarmUsage(responseText)
      const quota = normalizeQuotaHeaders(response.headers)
      const quotaPrimaryPct = quota.primary?.usedPercent ?? null
      const quotaSecondaryPct = quota.secondary?.usedPercent ?? null

      this.log.debug(
        'cachekeep fired',
        this.logPayload({
          session: sessionKey,
          accountId: target.accountId ?? 'main',
          input_tokens: usage.input_tokens,
          cached_tokens: usage.cached_tokens,
          hit_rate: usage.hit_rate,
          output_tokens: usage.output_tokens,
          quota_primary_pct: quotaPrimaryPct,
          quota_secondary_pct: quotaSecondaryPct,
        }),
      )

      // Reset expiry on success — preserves the per-target TTL (e.g. 30 min for
      // gpt-5.6 sessions whose prompt cache lives longer than the default 5 min).
      target.cacheExpiresAt = this.now() + target.ttlMs
      target.lastWarmedAt = this.now()
      target.backoffUntil = undefined
      target.warmCount += 1

      // gpt-5.6 subagent cap: after 2 successful warms the target is done —
      // subagent sessions are short-lived, and 2× ~30-min warms give ~1h of
      // cache coverage without over-warming a one-off session.
      if (this.isGpt56Subagent(target) && target.warmCount >= 2) {
        if (this.targets.get(sessionKey) === target) {
          this.totalBytes -= target.bodyText.length
          this.targets.delete(sessionKey)
        }
        return
      }
    } catch (err) {
      if (this.disposed || this.targets.get(sessionKey) !== target) return
      target.backoffUntil = this.now() + BACKOFF_MS
      this.log.warn(
        'cachekeep failed',
        this.logPayload({
          session: sessionKey,
          accountId: target.accountId ?? 'main',
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
}
