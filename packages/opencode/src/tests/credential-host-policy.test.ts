import { expect, test } from 'bun:test'
import { redactCredentialError } from '@cortexkit/openai-auth-core/internal'
import { APICallError } from 'ai'
import {
  loadHostPolicy,
  type Normalized,
} from './fixtures/opencode1-error-policy'

const host = loadHostPolicy()
const credential = 'opaque-classification-secret'
const oversized = 'x'.repeat(70_000)

function error(
  statusCode: number,
  body: string,
  headers?: Record<string, string>,
  isRetryable = false,
) {
  return new APICallError({
    message: 'Provider diagnostic',
    url: '',
    requestBodyValues: undefined,
    statusCode,
    responseBody: body,
    responseHeaders: headers,
    isRetryable,
  })
}

function decision(input: unknown) {
  expect(APICallError.isInstance(input)).toBe(true)
  if (!APICallError.isInstance(input))
    throw new Error('Projection lost real SDK identity')
  const parsed = host.parseAPICallError({ providerID: 'openai', error: input })
  const normalized: Normalized = {
    name:
      parsed.type === 'context_overflow' ? 'ContextOverflowError' : 'APIError',
    data: parsed,
  }
  return {
    overflow: parsed.type === 'context_overflow',
    retry: host.retryable(normalized, 'openai'),
    delay: host.delay(7, normalized, 0),
  }
}

for (const [name, source, retry, delay, overflow] of [
  [
    '429 millisecond header precedence',
    error(
      429,
      'refused',
      { 'retry-after-ms': '1250', 'retry-after': '120' },
      true,
    ),
    true,
    1250,
    false,
  ],
  [
    '429 seconds header',
    error(429, 'refused', { 'retry-after': '2.5' }, true),
    true,
    2500,
    false,
  ],
  [
    '429 no headers cap',
    error(429, 'refused', undefined, true),
    true,
    30_000,
    false,
  ],
  [
    '429 empty headers uncapped',
    error(429, 'refused', {}, true),
    true,
    128_000,
    false,
  ],
  [
    '429 unrelated headers retain presence',
    error(429, 'refused', { 'x-secret': credential }, true),
    true,
    128_000,
    false,
  ],
  [
    'free usage limit',
    error(429, '{"error":"FreeUsageLimitError"}', {}, true),
    true,
    128_000,
    false,
  ],
  [
    'go usage limit metadata',
    error(
      429,
      '{"error":"GoUsageLimitError","metadata":{"workspace":"workspace-1","limitName":"weekly"}}',
      { 'retry-after': '120' },
      true,
    ),
    true,
    120_000,
    false,
  ],
  [
    'context overflow code',
    error(
      400,
      '{"error":{"code":"context_length_exceeded","type":"invalid_request_error"}}',
    ),
    false,
    30_000,
    true,
  ],
  [
    'oversized late retry marker',
    error(400, `${oversized} rate limit`),
    true,
    30_000,
    false,
  ],
  [
    'oversized late overflow code',
    error(
      400,
      JSON.stringify({
        padding: oversized,
        error: {
          code: 'context_length_exceeded',
          type: 'invalid_request_error',
        },
      }),
    ),
    false,
    30_000,
    true,
  ],
  [
    'oversized go usage metadata',
    error(
      429,
      JSON.stringify({
        padding: oversized,
        error: 'GoUsageLimitError',
        metadata: { workspace: 'workspace-1', limitName: 'weekly' },
      }),
      { 'retry-after': '120' },
      true,
    ),
    true,
    120_000,
    false,
  ],
  ['non-retryable 400', error(400, 'Invalid argument'), false, 30_000, false],
] as const) {
  test(`real OpenCode 1 policy projection preserves ${name}`, () => {
    const before = decision(source)
    expect(Boolean(before.retry)).toBe(retry)
    expect(before.delay).toBe(delay)
    expect(before.overflow).toBe(overflow)
    const projected = redactCredentialError(source, credential)
    expect(decision(projected)).toEqual(before)
    if (!APICallError.isInstance(projected))
      throw new Error('Missing SDK identity')
    expect(
      Buffer.byteLength(projected.responseBody ?? '', 'utf8'),
    ).toBeLessThanOrEqual(65_536)
    expect(JSON.stringify(projected)).not.toContain(credential)
  })
}

test('small response bodies remain readable and scrubbed without changing numeric lexemes', () => {
  const body = `{"message":"${credential}","id":900719925474099312345,"reset":1e+005}`
  const source = error(400, body)
  const projected = redactCredentialError(source, credential)
  expect(APICallError.isInstance(projected)).toBe(true)
  if (!APICallError.isInstance(projected))
    throw new Error('Missing SDK identity')
  expect(projected.responseBody).toBe(body.replace(credential, '[credential]'))
  expect(source.responseBody).toBe(body)
})
