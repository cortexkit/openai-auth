import { describe, expect, it, jest, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildQuotaOperationError,
  isTransientQuotaError,
  isTransientRefreshError,
} from '../core/backoff.ts'
import {
  codexRefreshFn,
  type ProviderHttpError,
  whamUsageFn,
} from '../core/provider.ts'

function fetchUntilAborted() {
  const fetchMock = mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('missing timeout signal'))
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      }),
  )
  return fetchMock as unknown as typeof fetch & typeof fetchMock
}

describe('buildQuotaOperationError retryAfter threading', () => {
  it('honors positive retryAfter on quota error', () => {
    const error = Object.assign(new Error('Rate limit exceeded'), {
      status: 429,
      retryAfter: 3600,
    })
    const now = 1000000
    const result = buildQuotaOperationError({
      error,
      now,
    })
    expect(result.nextRetryAt).toBe(now + 3600 * 1000)
  })

  it('falls back to transient backoff when retryAfter is missing', () => {
    const error = Object.assign(new Error('Rate limit exceeded'), {
      status: 429,
    })
    const now = 1000000
    const result = buildQuotaOperationError({
      error,
      now,
    })
    // Transient quota error delay starts at MIN_QUOTA_RETRY_DELAY_MS (60_000)
    expect(result.nextRetryAt).toBe(now + 60_000)
  })
})

describe('codexRefreshFn token validation', () => {
  const mockNow = () => 1000000

  it('returns tokens when response is valid', async () => {
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'valid-access',
          refresh_token: 'valid-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    })

    const result = await codexRefreshFn({
      refreshToken: 'some-refresh',
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: mockNow,
    })

    expect(result.access).toBe('valid-access')
    expect(result.refresh).toBe('valid-refresh')
    expect(result.expiresIn).toBe(3600)
    expect(result.expires).toBe(mockNow() + 3600 * 1000)
  })

  it('refuses any custody tombstone prefix before touching transport', async () => {
    const fetchSpy = mock(async () => new Response('{}', { status: 200 }))

    await expect(
      codexRefreshFn({
        refreshToken: 'claustrum-tombstone:v1:anthropic',
        fetchImpl: fetchSpy as unknown as typeof fetch,
        now: mockNow,
      }),
    ).rejects.toThrow('custody tombstone')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('places custody refusal before every refresh transport operation', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../core/provider.ts', import.meta.url)),
      'utf8',
    )
    const start = source.indexOf('export async function codexRefreshFn')
    const end = source.indexOf('export async function whamUsageFn')
    const fn = source.slice(start, end)
    const refusal = fn.indexOf(
      'assertNoCustodyTombstoneMaterial(input.refreshToken)',
    )
    const firstTransport = Math.min(
      ...['new URL', 'URLSearchParams', 'await', 'input.fetchImpl']
        .map((token) => fn.indexOf(token))
        .filter((index) => index >= 0),
    )

    expect(refusal).toBeGreaterThanOrEqual(0)
    expect(refusal).toBeLessThan(firstTransport)
  })

  it('throws structured refresh error when access_token is missing', async () => {
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          refresh_token: 'valid-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    })

    let thrown: ProviderHttpError | undefined
    try {
      await codexRefreshFn({
        refreshToken: 'some-refresh',
        fetchImpl: mockFetch as unknown as typeof fetch,
        now: mockNow,
      })
    } catch (e) {
      thrown = e as ProviderHttpError
    }

    expect(thrown).toBeDefined()
    expect(thrown?.message).toContain('malformed response')
    expect(thrown?.status).toBe(200)
    expect(thrown?.isRefreshError).toBe(true)
  })

  it('keeps the input refresh token when the response omits refresh_token', async () => {
    // OpenAI's refresh grant rotates the refresh token single-use. An absent
    // refresh_token on a successful exchange therefore means "keep using
    // the current refresh token" — throwing 'malformed response' here would
    // arm refresh backoff across every account on the first non-rotating
    // response.
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'valid-access',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    })

    const result = await codexRefreshFn({
      refreshToken: 'kept-input-refresh',
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: mockNow,
    })

    expect(result.access).toBe('valid-access')
    expect(result.refresh).toBe('kept-input-refresh')
    expect(result.expiresIn).toBe(3600)
    expect(result.expires).toBe(mockNow() + 3600 * 1000)
  })

  it('throws structured refresh error when expires_in is missing or not a number', async () => {
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'valid-access',
          refresh_token: 'valid-refresh',
          expires_in: '3600', // string instead of number
        }),
        { status: 200 },
      )
    })

    let thrown: ProviderHttpError | undefined
    try {
      await codexRefreshFn({
        refreshToken: 'some-refresh',
        fetchImpl: mockFetch as unknown as typeof fetch,
        now: mockNow,
      })
    } catch (e) {
      thrown = e as ProviderHttpError
    }

    expect(thrown).toBeDefined()
    expect(thrown?.message).toContain('malformed response')
    expect(thrown?.status).toBe(200)
    expect(thrown?.isRefreshError).toBe(true)
  })
})

describe('provider fetch timeouts', () => {
  it('bounds a stalled quota fetch and classifies the timeout as transient', async () => {
    jest.useFakeTimers()
    try {
      const fetchImpl = fetchUntilAborted()
      const pending = whamUsageFn({
        accessToken: 'access-token',
        fetchImpl,
        now: () => 1_000_000,
        accountId: 'account-1',
      })

      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
      jest.advanceTimersByTime(15_000)

      const error = await pending.catch((caught) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('TimeoutError')
      expect(isTransientQuotaError(error)).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('bounds a stalled token refresh and classifies the timeout as transient', async () => {
    jest.useFakeTimers()
    try {
      const fetchImpl = fetchUntilAborted()
      const pending = codexRefreshFn({
        refreshToken: 'refresh-token',
        fetchImpl,
        now: () => 1_000_000,
      })

      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
      jest.advanceTimersByTime(15_000)

      const error = await pending.catch((caught) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('TimeoutError')
      expect(isTransientRefreshError(error)).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('quota fetch logging', () => {
  it('warns with account context when the usage fetch rejects', async () => {
    const logger = {
      debug: mock(() => {}),
      warn: mock(() => {}),
    }
    const failure = new Error('upstream unavailable')
    const input = {
      accessToken: 'access-token',
      fetchImpl: mock(async () => {
        throw failure
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
      accountId: 'account-1',
      accountKey: 'account-1',
      logger,
    }

    const caught = await whamUsageFn(input).catch((error) => error)
    expect(caught).toBe(failure)
    expect(logger.warn).toHaveBeenCalledWith(
      'wham usage fetch failed',
      expect.objectContaining({
        accountId: 'account-1',
        error: 'upstream unavailable',
      }),
    )
  })
})
