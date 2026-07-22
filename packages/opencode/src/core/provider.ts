/**
 * Provider injection seam — shared types and the 2 Codex provider fns.
 *
 * Both fns are constructor-injected into FallbackAccountManager and
 * QuotaManager so the generic core never imports provider specifics
 * directly.
 */

import { createLogger } from '../logger.ts'
import { errorMessage } from '../util/error.ts'
import type { OAuthQuotaSnapshot } from './accounts.ts'
import { parseRetryAfter } from './backoff.ts'

const log = createLogger('quota')
type QuotaLogger = Pick<typeof log, 'debug' | 'warn'>

// ---------------------------------------------------------------------------
// Window names are widen-able strings (not an enum) so multi-family
// rate-limit windows (additional_rate_limits / metered_limit_name) can be
// stored without casts.
// ---------------------------------------------------------------------------

export type QuotaWindowName = string
export const PRIMARY: QuotaWindowName = 'primary'
export const SECONDARY: QuotaWindowName = 'secondary'

// ---------------------------------------------------------------------------
// Error carrying an HTTP status and optional retry-after so callers can
// classify transient vs fatal failures and honor backoff.
// ---------------------------------------------------------------------------

export interface ProviderHttpError extends Error {
  status?: number
  retryAfter?: number
  /** True when this error originated from a token-refresh call (not a quota fetch). */
  isRefreshError?: boolean
}

// ---------------------------------------------------------------------------
// Provider function types (design §6)
// ---------------------------------------------------------------------------

export type ProviderRefreshFn = (input: {
  refreshToken: string
  fetchImpl: typeof fetch
  now: () => number
}) => Promise<{
  access: string
  refresh: string
  expires: number
  expiresIn: number
}>

export type ProviderQuotaFn = (input: {
  accessToken: string
  fetchImpl: typeof fetch
  now: () => number
}) => Promise<OAuthQuotaSnapshot>

// ---------------------------------------------------------------------------
// OAuth constants (moved from index.ts to avoid circular dependency)
// ---------------------------------------------------------------------------

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_ISSUER = 'https://auth.openai.com'

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

// ---------------------------------------------------------------------------
// Codex OAuth token refresh; throws ProviderHttpError carrying the HTTP
// status so callers can classify the failure.
// ---------------------------------------------------------------------------

/**
 * Core Codex OAuth refresh — the single entry point for refreshing an
 * OpenAI OAuth token.  Used by both the legacy refreshAccessToken in
 * index.ts AND the FallbackAccountManager (via constructor injection).
 *
 * Throws a ProviderHttpError carrying `.status` (from the HTTP response)
 * and `.retryAfter` (parsed from Retry-After) so backoff machinery can
 * duck-type them without instanceof checks.
 */
export async function codexRefreshFn(input: {
  refreshToken: string
  fetchImpl: typeof fetch
  now: () => number
}): Promise<{
  access: string
  refresh: string
  expires: number
  expiresIn: number
}> {
  const response = await input.fetchImpl(`${CODEX_ISSUER}/oauth/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    throw Object.assign(new Error(`Token refresh failed: ${response.status}`), {
      status: response.status,
      retryAfter,
      isRefreshError: true,
    }) as ProviderHttpError
  }
  const tokens = (await response.json()) as TokenResponse
  if (
    !tokens ||
    typeof tokens.access_token !== 'string' ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== 'string' ||
    !tokens.refresh_token ||
    typeof tokens.expires_in !== 'number'
  ) {
    throw Object.assign(new Error('Token refresh failed: malformed response'), {
      status: response.status,
      isRefreshError: true,
    }) as ProviderHttpError
  }
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: input.now() + tokens.expires_in * 1000,
    expiresIn: tokens.expires_in,
  }
}

// ---------------------------------------------------------------------------
// Codex whamUsageFn — OPTIONAL supplement quota-fetch (§7)
// ---------------------------------------------------------------------------

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

export async function whamUsageFn(input: {
  accessToken: string
  fetchImpl: typeof fetch
  now: () => number
  accountId?: string
  accountKey?: string
  logger?: QuotaLogger
}): Promise<OAuthQuotaSnapshot> {
  const logger = input.logger ?? log
  const accountId = input.accountKey ?? 'unknown'
  const startedAt = Date.now()
  logger.debug('wham usage fetch started', { pid: process.pid, accountId })
  try {
    const res = await input.fetchImpl(WHAM_USAGE_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'chatgpt-account-id': input.accountId ?? '',
        'oai-client-platform': 'web',
        'oai-client-version': '0',
        'x-openai-target-path': '/backend-api/wham/usage',
      },
    })
    if (!res.ok) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
      throw Object.assign(new Error(`wham usage check failed: ${res.status}`), {
        status: res.status,
        retryAfter,
      }) as ProviderHttpError
    }
    const { normalizeWham } = await import('../quota-normalize.ts')
    const snapshot = normalizeWham(await res.json())
    logger.debug('wham usage fetch succeeded', {
      pid: process.pid,
      accountId,
      status: res.status,
      elapsedMs: Date.now() - startedAt,
    })
    return snapshot
  } catch (error) {
    logger.warn('wham usage fetch failed', {
      pid: process.pid,
      accountId,
      status:
        typeof (error as { status?: unknown } | null)?.status === 'number'
          ? (error as { status: number }).status
          : 'error',
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error),
    })
    throw error
  }
}
