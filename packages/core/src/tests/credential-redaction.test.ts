import { expect, spyOn, test } from 'bun:test'
import {
  redactCredentialError,
  redactCredentialFrame,
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

test('successful SSE output is byte-identical across arbitrary UTF-8 chunk boundaries', async () => {
  const source = new TextEncoder().encode(
    ': keepalive\r\n\r\n' +
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"café 🙂\\n"}\r\n\r\n' +
      'event: response.completed\ndata:  {"type":"response.completed","response":{"status":"completed","error":null}}\n\n',
  )
  const response = await redactCredentialResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < source.byteLength; index += 7)
            controller.enqueue(source.slice(index, index + 7))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
    'opaque-secret',
  )
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(source)
})

test('a non-error frame containing the literal word error is unchanged', () => {
  const frame =
    '{"type":"response.output_text.delta","delta":"error","response_id":"opaque-secret"}'
  expect(redactCredentialFrame(frame, 'opaque-secret')).toBe(frame)
})

test('ordinary delta frames bypass JSON parsing entirely', () => {
  const parse = spyOn(JSON, 'parse')
  try {
    const frame =
      '{"type":"response.output_text.delta","delta":"ordinary text"}'
    expect(redactCredentialFrame(frame, 'opaque-secret')).toBe(frame)
    expect(parse).not.toHaveBeenCalled()
  } finally {
    parse.mockRestore()
  }
})

for (const envelope of ['typed', 'top-level', 'response-failed'] as const) {
  test(`${envelope} error frame still redacts the exact attempt credential`, () => {
    const payload = { message: 'echo opaque-secret twice opaque-secret' }
    const frame = JSON.stringify(
      envelope === 'typed'
        ? { type: 'error', ...payload }
        : envelope === 'top-level'
          ? { error: payload }
          : { type: 'response.failed', response: { error: payload } },
    )
    const scrubbed = redactCredentialFrame(frame, 'opaque-secret')
    expect(scrubbed).toContain('echo [credential] twice [credential]')
    expect(scrubbed).not.toContain('opaque-secret')
  })
}
