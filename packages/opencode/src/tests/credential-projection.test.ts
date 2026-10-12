import { expect, spyOn, test } from 'bun:test'
import {
  redactCredentialError,
  redactCredentialFrame,
} from '@cortexkit/openai-auth-core/internal'
import { APICallError } from 'ai'
import { ResponseStreamError } from '../response-stream-error'
import {
  OVERSIZED_FRAME_MESSAGE,
  parseRateLimitSignal,
  TERMINAL_AFTER_OUTPUT_MESSAGE,
} from '../ws'

const credential = 'opaque-projection-secret'

test('owned projection preserves SDK retry brands, retry-after, and usage-limit classification', () => {
  const source = new APICallError({
    message: `Quota rejected ${credential}`,
    url: `https://example.invalid/${credential}`,
    requestBodyValues: { credential },
    statusCode: 429,
    responseHeaders: { 'retry-after': '120', 'x-secret': credential },
    data: {
      error: {
        type: 'usage_limit_reached',
        code: 'usage_limit_reached',
        message: credential,
      },
    },
  })
  const safe = redactCredentialError(source, credential)
  expect(Object.getPrototypeOf(safe)).toBe(Error.prototype)
  expect(safe).not.toBe(source)
  expect(APICallError.isInstance(safe)).toBe(true)
  if (!APICallError.isInstance(safe))
    throw new Error('Missing SDK classification')
  expect(safe.isRetryable).toBe(source.isRetryable)
  expect(safe.statusCode).toBe(source.statusCode)
  expect(safe.responseHeaders).toEqual({ 'retry-after': '120' })
  expect(safe.data).toEqual({
    error: {
      type: 'usage_limit_reached',
      code: 'usage_limit_reached',
      message: '[credential]',
    },
  })
  expect(Object.hasOwn(safe, 'url')).toBe(false)
  expect(Object.hasOwn(safe, 'requestBodyValues')).toBe(false)
  expect(source.message).toContain(credential)
})

test('owned projection preserves retryable pre-output and exact terminal and overflow controls', () => {
  for (const [message, retryable] of [
    ['Connection lost before output', true],
    [TERMINAL_AFTER_OUTPUT_MESSAGE, false],
    [OVERSIZED_FRAME_MESSAGE, false],
  ] as const) {
    const source = new ResponseStreamError(message, {
      retryable,
      cause: new Error(credential),
    })
    const safe = redactCredentialError(source, credential)
    expect(APICallError.isInstance(safe)).toBe(true)
    if (!APICallError.isInstance(safe))
      throw new Error('Missing SDK classification')
    expect(safe.isRetryable).toBe(retryable)
    expect(safe.message).toBe(message)
    expect(safe.name).toBe('ProviderResponseStreamError')
    expect(safe.cause).toBeUndefined()
    expect(Object.getPrototypeOf(safe)).toBe(Error.prototype)
  }
})

test('lexical frame projection keeps the existing usage-limit reroute and reset controls', () => {
  const now = spyOn(Date, 'now').mockReturnValue(1_000)
  try {
    for (const frame of [
      {
        type: 'error',
        error: {
          type: 'usage_limit_reached',
          resets_at: 200,
          message: credential,
        },
      },
      {
        type: 'error',
        status: 429,
        error: { resets_in_seconds: 120, message: credential },
      },
    ]) {
      const safe = JSON.parse(
        redactCredentialFrame(JSON.stringify(frame), credential),
      )
      expect(parseRateLimitSignal(safe)).toEqual(parseRateLimitSignal(frame))
      expect(parseRateLimitSignal(safe)).toBeDefined()
      expect(JSON.stringify(safe)).not.toContain(credential)
    }
  } finally {
    now.mockRestore()
  }
})

test('owned Error projection preserves usage-limit window and reset decisions', () => {
  const source = Object.assign(new Error(credential), {
    status: 429,
    error: {
      type: 'usage_limit_reached',
      code: 'usage_limit_reached',
      resets_at: 200,
      message: credential,
    },
  })
  const safe = redactCredentialError(source, credential)
  expect(parseRateLimitSignal(source)).toEqual({
    window: 'usage_limit_reached',
    resetAt: 200_000,
  })
  expect(parseRateLimitSignal(safe)).toEqual(parseRateLimitSignal(source))
  expect(JSON.stringify(safe)).not.toContain(credential)
})
