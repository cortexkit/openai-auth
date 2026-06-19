/**
 * Phase 4 — Error contract tests.
 *
 * Verifies:
 *  - Codex refreshFn throws ProviderHttpError with .status + .retryAfter
 *  - isTransientRefreshError duck-types .status (429/5xx=true, 401=false)
 *  - U-8: network errors STILL classified as transient
 *  - U-3: buildRefreshOperationError → 24h backoff on 401
 */

import { describe, expect, it, jest } from 'bun:test'
import {
  buildRefreshOperationError,
  isTransientRefreshError,
  NON_TRANSIENT_REFRESH_RETRY_DELAY_MS,
} from '../core/backoff.ts'
import { codexRefreshFn, type ProviderHttpError } from '../core/provider.ts'

describe('error contract', () => {
  // -------------------------------------------------------------------
  // M-4: Codex refreshFn throws ProviderHttpError carrying .status+.retryAfter
  // -------------------------------------------------------------------

  it('Codex refreshFn throws ProviderHttpError carrying .status + .retryAfter', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '12' }),
    })

    try {
      await codexRefreshFn({
        refreshToken: 'test-refresh',
        fetchImpl: mockFetch as unknown as typeof fetch,
        now: () => Date.now(),
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      const e = error as ProviderHttpError
      expect(e.status).toBe(429)
      expect(e.retryAfter).toBe(12)
      expect(e.message).toContain('Token refresh failed: 429')
    }
  })

  it('Codex refreshFn throws ProviderHttpError without retryAfter when header missing', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    })

    try {
      await codexRefreshFn({
        refreshToken: 'test-refresh',
        fetchImpl: mockFetch as unknown as typeof fetch,
        now: () => Date.now(),
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      const e = error as ProviderHttpError
      expect(e.status).toBe(500)
      expect(e.retryAfter).toBeUndefined()
    }
  })

  // -------------------------------------------------------------------
  // isTransientRefreshError duck-types .status
  // -------------------------------------------------------------------

  it('isTransientRefreshError: {status:429} → true', () => {
    expect(isTransientRefreshError({ status: 429 })).toBe(true)
  })

  it('isTransientRefreshError: {status:500} → true', () => {
    expect(isTransientRefreshError({ status: 500 })).toBe(true)
  })

  it('isTransientRefreshError: {status:503} → true', () => {
    expect(isTransientRefreshError({ status: 503 })).toBe(true)
  })

  it('isTransientRefreshError: {status:401} → false', () => {
    expect(isTransientRefreshError({ status: 401 })).toBe(false)
  })

  // -------------------------------------------------------------------
  // U-8: network errors still classified as transient
  // -------------------------------------------------------------------

  it("isTransientRefreshError: network Error('fetch failed') → true", () => {
    expect(isTransientRefreshError(new Error('fetch failed'))).toBe(true)
  })

  it('isTransientRefreshError: network error ECONNRESET → true', () => {
    const err = new Error('connect ECONNRESET')
    ;(err as Error & { code: string }).code = 'ECONNRESET'
    expect(isTransientRefreshError(err)).toBe(true)
  })

  it('isTransientRefreshError: network error ETIMEDOUT → true', () => {
    const err = new Error('ETIMEDOUT')
    ;(err as Error & { code: string }).code = 'ETIMEDOUT'
    expect(isTransientRefreshError(err)).toBe(true)
  })

  it('isTransientRefreshError: plain Error → false', () => {
    expect(isTransientRefreshError(new Error('some error'))).toBe(false)
  })

  it('isTransientRefreshError: non-object → false', () => {
    expect(isTransientRefreshError('string error')).toBe(false)
  })

  // -------------------------------------------------------------------
  // U-3: buildRefreshOperationError → 24h backoff on 401
  // -------------------------------------------------------------------

  it('U-3: buildRefreshOperationError applies 24h non-transient backoff when status===401', () => {
    const now = Date.now()
    const result = buildRefreshOperationError({
      error: { status: 401, message: 'unauthorized' },
      now,
      refreshToken: 'test-refresh',
    })
    expect(result.nextRetryAt).toBe(now + NON_TRANSIENT_REFRESH_RETRY_DELAY_MS)
    expect(result.retryCount).toBe(1)
  })

  it('buildRefreshOperationError uses retryAfter when present (numeric)', () => {
    const now = Date.now()
    const result = buildRefreshOperationError({
      error: { status: 429, retryAfter: 30, message: 'rate limited' },
      now,
      refreshToken: 'test-refresh',
    })
    expect(result.nextRetryAt).toBe(now + 30_000)
  })

  it('buildRefreshOperationError increments retryCount for same token', () => {
    const now = Date.now()
    const first = buildRefreshOperationError({
      error: { status: 500, message: 'server error' },
      now,
      refreshToken: 'test-refresh',
    })
    const second = buildRefreshOperationError({
      error: { status: 500, message: 'server error again' },
      now,
      refreshToken: 'test-refresh',
      previous: first,
    })
    expect(second.retryCount).toBe(2)
  })
})
