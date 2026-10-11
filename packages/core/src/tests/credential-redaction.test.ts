import { expect, spyOn, test } from 'bun:test'
import {
  redactCredentialError,
  redactCredentialFrame,
  redactCredentialResponse,
  redactCredentialText,
} from '../util/credential-redaction'

const echoedCredentials = [
  'opaque-429-rate_limit.[secret]',
  'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature',
]

function escapedJsonValue(value: string): string {
  return value
    .split('')
    .map(
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    .join('')
}

test('failed HTTP JSON bodies redact decoded credential JWT and Bearer values without changing classification', async () => {
  for (const token of echoedCredentials) {
    const body = ` { "error": { "code": "usage_limit_reached", "reset_at": 123, "message": "Invalid key: ${escapedJsonValue(token)}", "details": ["${escapedJsonValue(echoedCredentials[1]!)}", {"message":"${escapedJsonValue('Bearer unrelated')}"}] } } `
    const response = await redactCredentialResponse(
      new Response(body, {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '120' },
      }),
      token,
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('120')
    expect(await response.json()).toEqual({
      error: {
        code: 'usage_limit_reached',
        reset_at: 123,
        message: 'Invalid key: [credential]',
        details: ['[credential]', { message: '[credential]' }],
      },
    })
  }
  const unchanged =
    ' { "error": { "message": "\\u4f60\\u597d", "code": "usage_limit_reached" } } '
  const response = await redactCredentialResponse(
    new Response(unchanged, { status: 429 }),
    'opaque-secret',
  )
  expect(await response.text()).toBe(unchanged)
})

test('SSE error frames redact decoded credential JWT and Bearer values without changing classification', async () => {
  for (const token of echoedCredentials) {
    const frame = ` { "type": "response.failed", "response": { "error": { "code": "usage_limit_reached", "message": "Invalid key: ${escapedJsonValue(token)}", "details": ["${escapedJsonValue(echoedCredentials[1]!)}", "${escapedJsonValue('Bearer unrelated')}"] }, "usage": { "input_tokens": 123, "output_tokens": 4 } } } `
    const source = new TextEncoder().encode(`data: ${frame}\r\n\r\n`)
    const response = await redactCredentialResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < source.length; index += 7)
              controller.enqueue(source.slice(index, index + 7))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      token,
    )
    expect(JSON.parse((await response.text()).slice(6).trim())).toEqual({
      type: 'response.failed',
      response: {
        error: {
          code: 'usage_limit_reached',
          message: 'Invalid key: [credential]',
          details: ['[credential]', '[credential]'],
        },
        usage: { input_tokens: 123, output_tokens: 4 },
      },
    })
  }
  const unchanged = ' { "type": "error", "message": "\\u4f60\\u597d" } '
  expect(redactCredentialFrame(unchanged, 'opaque-secret')).toBe(unchanged)
})

test('non-ok response headers redact exact credentials and JWTs while preserving retry metadata', async () => {
  for (const token of echoedCredentials) {
    const response = await redactCredentialResponse(
      new Response(`Rejected ${token}`, {
        status: 429,
        statusText: `Rejected ${token}`,
        headers: {
          'content-type': 'application/json',
          'retry-after': '120',
          'content-length': '999',
          'x-provider-diagnostic': `Rejected ${token} twice ${token}`,
          'x-provider-jwt': echoedCredentials[1]!,
        },
      }),
      token,
    )
    expect(response.headers.get('x-provider-diagnostic')).toBe(
      'Rejected [credential] twice [credential]',
    )
    expect(response.headers.get('x-provider-jwt')).toBe('[credential]')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBe('120')
    expect(response.headers.has('content-length')).toBe(false)
    expect(response.status).toBe(429)
    expect(response.statusText).toBe('Rejected [credential]')
    expect(await response.text()).toBe('Rejected [credential]')
  }
})

test('SSE cancellation rejection redacts credentials without changing the reason and releases the reader', async () => {
  for (const token of echoedCredentials) {
    const reason = new DOMException(`Caller stopped ${token}`, 'AbortError')
    let receivedReason: unknown
    const source = new Response(
      new ReadableStream<Uint8Array>({
        cancel(value) {
          receivedReason = value
          throw new Error(`Cancel rejected ${token}; ${echoedCredentials[1]}`)
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const response = await redactCredentialResponse(source, token)
    expect(source.body!.locked).toBe(true)
    await expect(response.body!.cancel(reason)).rejects.toThrow(
      'Cancel rejected [credential]; [credential]',
    )
    expect(receivedReason).toBe(reason)
    expect(reason.message).toBe(`Caller stopped ${token}`)
    expect(source.body!.locked).toBe(false)
  }
})

test('an unrewritable diagnostic header is dropped without skipping the next header', async () => {
  const token = echoedCredentials[0]!
  const source = new Response('Rejected', {
    status: 400,
    headers: {
      'content-type': 'application/json',
      'retry-after': '120',
      'x-a-diagnostic': token,
      'x-b-diagnostic': token,
    },
  })
  const set = Headers.prototype.set
  const rewrite = spyOn(Headers.prototype, 'set').mockImplementation(function (
    this: Headers,
    name: string,
    value: string,
  ) {
    if (name === 'x-a-diagnostic') throw new TypeError('Cannot rewrite header')
    return set.call(this, name, value)
  })
  try {
    const response = await redactCredentialResponse(source, token)
    expect(response.headers.has('x-a-diagnostic')).toBe(false)
    expect(response.headers.get('x-b-diagnostic')).toBe('[credential]')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBe('120')
  } finally {
    rewrite.mockRestore()
  }
})

test('escaped JSON error keys redact exact credentials and JWTs through the SSE wrapper', async () => {
  for (const token of echoedCredentials) {
    for (const envelope of [
      `{"\\u0074ype":"\\u0065rror","message":"Rejected ${token}; ${echoedCredentials[1]}"}`,
      `{"\\u0065\\u0072\\u0072\\u006f\\u0072":{"message":"Rejected ${token}; ${echoedCredentials[1]}"}}`,
      `{"type":"response.failed","response":{"\\u0065rror":{"message":"Rejected ${token}; ${echoedCredentials[1]}"}}}`,
      `{"err\\u006Fr":{"message":"Rejected ${token}; ${echoedCredentials[1]}"}}`,
      `{"t\\u0079pe":"err\\u006fr","message":"Rejected ${token}; ${echoedCredentials[1]}"}`,
      `{"type":"\\u0065rror","message":"Rejected ${token}; ${echoedCredentials[1]}"}`,
    ]) {
      const source = new TextEncoder().encode(`data: ${envelope}\r\n\r\n`)
      const response = await redactCredentialResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < source.length; index += 7)
                controller.enqueue(source.slice(index, index + 7))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
        token,
      )
      const result = await response.text()
      expect(result).toContain('Rejected [credential]; [credential]')
      expect(result).not.toContain(token)
      expect(JSON.parse(result.slice(6).trim())).toEqual(
        JSON.parse(
          envelope
            .replaceAll(token, '[credential]')
            .replaceAll(echoedCredentials[1]!, '[credential]'),
        ),
      )
    }
  }
})

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
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"\\u4f60\\u597d \\ud83d\\ude42 opaque-secret"}\n\n' +
      `data: {"type":"response.output_text.delta","delta":"${escapedJsonValue('opaque-secret')}"}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","delta":"${escapedJsonValue('{"error":"opaque-secret"}')}"}\n\n` +
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

test('escaped Unicode delta frames bypass JSON parsing and remain byte-identical', () => {
  const parse = spyOn(JSON, 'parse')
  try {
    const frame =
      '{"type":"response.output_text.delta","delta":"\\u4f60\\u597d \\ud83d\\ude42 \\u0065\\u0072\\u0074 opaque-secret"}'
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
