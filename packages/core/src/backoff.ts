import { createHash } from 'node:crypto'

export const NON_TRANSIENT_REFRESH_RETRY_DELAY_MS = 24 * 60 * 60_000

const MIN_REFRESH_RETRY_DELAY_MS = 5 * 60_000
const MAX_REFRESH_RETRY_DELAY_MS = 60 * 60_000
const MIN_QUOTA_RETRY_DELAY_MS = 60_000
const MAX_QUOTA_RETRY_DELAY_MS = 15 * 60_000
const NON_TRANSIENT_QUOTA_RETRY_DELAY_MS = 5 * 60_000

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function isTransientRefreshError(error: unknown) {
  const status = (error as { status?: number } | null | undefined)?.status
  if (typeof status === 'number') {
    return status === 429 || status >= 500
  }
  if (!(error instanceof Error)) return false
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.message.includes('fetch failed') ||
    ('code' in error &&
      (error.code === 'ECONNRESET' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'UND_ERR_CONNECT_TIMEOUT'))
  )
}

export function isTransientQuotaError(error: unknown) {
  const message = formatErrorMessage(error)
  const status = (error as { status?: number } | null | undefined)?.status
  if (typeof status === 'number') {
    return status === 429 || status >= 500
  }
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    message.includes('fetch failed') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

export function hashRefreshToken(refreshToken: string) {
  return createHash('sha256').update(refreshToken).digest('hex')
}

export function buildRefreshOperationError(input: {
  error: unknown
  now: number
  refreshToken: string
  previous?: {
    message: string
    checkedAt: number
    nextRetryAt?: number
    retryCount?: number
    tokenHash?: string
  }
}): {
  message: string
  checkedAt: number
  nextRetryAt: number
  retryCount: number
  tokenHash: string
} {
  const tokenHash = hashRefreshToken(input.refreshToken)
  const previousRetryCount =
    input.previous?.tokenHash === tokenHash
      ? (input.previous.retryCount ?? 0)
      : 0
  const retryCount = previousRetryCount + 1
  let delay: number
  const retryAfter = (input.error as { retryAfter?: number } | null | undefined)
    ?.retryAfter
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    delay = retryAfter * 1000
  } else if (isTransientRefreshError(input.error)) {
    delay = Math.min(
      MAX_REFRESH_RETRY_DELAY_MS,
      MIN_REFRESH_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
    )
  } else {
    delay = NON_TRANSIENT_REFRESH_RETRY_DELAY_MS
  }
  return {
    message: formatErrorMessage(input.error),
    checkedAt: input.now,
    nextRetryAt: input.now + delay,
    retryCount,
    tokenHash,
  }
}

export function refreshBackoffActive(
  error: { nextRetryAt?: number; tokenHash?: string } | undefined,
  refreshToken: string | undefined,
  now: number,
) {
  if (!error?.nextRetryAt || error.nextRetryAt <= now) return false
  if (!refreshToken) return true
  return error.tokenHash === hashRefreshToken(refreshToken)
}

export function formatRefreshBackoffMessage(
  error: { message: string; nextRetryAt?: number },
  now: number,
) {
  const seconds = Math.max(
    1,
    Math.ceil(((error.nextRetryAt ?? now) - now) / 1000),
  )
  return `Codex OAuth refresh is backed off for ${seconds}s after: ${error.message}`
}

export function buildQuotaOperationError(input: {
  error: unknown
  now: number
  previous?: {
    message: string
    checkedAt: number
    nextRetryAt?: number
    retryCount?: number
  }
}): {
  message: string
  checkedAt: number
  nextRetryAt: number
  retryCount: number
} {
  const previousRetryCount = input.previous?.retryCount ?? 0
  const retryCount = previousRetryCount + 1
  let delay: number
  const retryAfter = (input.error as { retryAfter?: number } | null | undefined)
    ?.retryAfter
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    delay = retryAfter * 1000
  } else if (isTransientQuotaError(input.error)) {
    delay = Math.min(
      MAX_QUOTA_RETRY_DELAY_MS,
      MIN_QUOTA_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
    )
  } else {
    delay = NON_TRANSIENT_QUOTA_RETRY_DELAY_MS
  }
  return {
    message: formatErrorMessage(input.error),
    checkedAt: input.now,
    nextRetryAt: input.now + delay,
    retryCount,
  }
}

export function quotaBackoffActive(
  error: { nextRetryAt?: number } | undefined,
  now: number,
): boolean {
  if (!error?.nextRetryAt || error.nextRetryAt <= now) return false
  return true
}

export function formatQuotaBackoffMessage(
  error: { message: string; nextRetryAt?: number },
  now: number,
): string {
  const seconds = Math.max(
    1,
    Math.ceil(((error.nextRetryAt ?? now) - now) / 1000),
  )
  return `Quota API backed off for ${seconds}s after: ${error.message}`
}

export function parseRetryAfter(
  value: string | undefined | null,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000)
    return delta > 0 ? delta : undefined
  }
  return undefined
}
