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
export {
  buildKeepwarmBody,
  CACHE_KEEP_CAPS,
  createCacheKeepManager,
  createOpenAICacheKeepAdapter,
  getCacheKeepWindow,
  type OpenAICacheKeepAdapterOptions,
  type OpenAICacheKeepManager,
  type OpenAICacheKeepMeta,
  openaiCacheKeepProfile,
  ttlForModel,
} from '@cortexkit/openai-auth-core/internal'

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
