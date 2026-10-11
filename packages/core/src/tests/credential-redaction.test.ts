import { expect, test } from 'bun:test'
import {
  redactCredentialError,
  redactCredentialResponse,
  redactCredentialText,
} from '../util/credential-redaction'

test('credential error masking is literal complete and uses a non-retryable marker', () => {
  const token = 'opaque-429-rate_limit.[secret]'
  const safe = redactCredentialText(
    `Invalid key ${token} twice ${token}; Bearer unrelated; eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature`,
    token,
  )
  expect(safe).toBe(
    'Invalid key [credential] twice [credential]; [credential]; [credential]',
  )
  expect(safe).not.toMatch(/429|rate_limit|usage_limit|Too Many/)
  const error = redactCredentialError(
    new Error(token, { cause: new Error(token) }),
    token,
  )
  expect(error.message).toBe('[credential]')
  expect(error.cause).toBeUndefined()
})

test('streamed errors redact split bearer chunks without rewriting normal model output', async () => {
  const token = 'opaque-secret'
  const normal = `data: {"type":"response.output_text.delta","delta":"${token}"}\r\n\r\n`
  const failed = `data: {"type":"response.failed","response":{"error":{"message":"key ${token}"}}}\r\n\r\n`
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = encoder.encode(normal + failed)
      for (let index = 0; index < bytes.length; index += 7)
        controller.enqueue(bytes.slice(index, index + 7))
      controller.close()
    },
  })
  const response = await redactCredentialResponse(
    new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    token,
  )
  expect(await response.text()).toBe(
    normal + failed.replace(token, '[credential]'),
  )
})

test('stream transport failures do not retain an opaque bearer in the host error', async () => {
  const token = 'opaque-secret'
  const response = await redactCredentialResponse(
    new Response(
      new ReadableStream({
        pull() {
          throw new Error(`transport ${token}`)
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
    token,
  )
  await expect(response.text()).rejects.toThrow('transport [credential]')
})

test('credential scrubbing preserves typed quota errors and native aborts', () => {
  class QuotaError extends Error {
    resetAt = 123
    detail = { message: 'opaque-secret' }
  }
  const quota = redactCredentialError(
    new QuotaError('blocked opaque-secret'),
    'opaque-secret',
  )
  expect(quota).toBeInstanceOf(QuotaError)
  expect((quota as QuotaError).resetAt).toBe(123)
  expect((quota as QuotaError).detail.message).toBe('[credential]')
  const abort = redactCredentialError(
    new DOMException('opaque-secret', 'AbortError'),
    'opaque-secret',
  )
  expect(abort).toBeInstanceOf(DOMException)
  expect(abort.name).toBe('AbortError')
  expect(abort.message).toBe('[credential]')
})
