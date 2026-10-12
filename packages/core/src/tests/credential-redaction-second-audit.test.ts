import { expect, test } from 'bun:test'
import {
  redactCredentialError,
  redactCredentialFrame,
  redactCredentialResponse,
  redactCredentialText,
} from '../util/credential-redaction'

const credential = 'relay-attempt-credential-7f3e9a1c2b'

test('known credentials wrapped across whitespace are removed completely from error text', () => {
  for (const whitespace of ['\n', '\r\n', ' \n ']) {
    for (const input of [
      `Rejected Bearer${whitespace}${credential}`,
      `Rejected Bearer ${credential.slice(0, 14)}${whitespace}${credential.slice(14)}`,
      `Rejected ${credential.slice(0, 14)}${whitespace}${credential.slice(14)}`,
    ]) {
      const safe = redactCredentialText(input, credential)
      expect(safe).toContain('[credential]')
      expect(safe).not.toContain(credential.slice(0, 14))
      expect(safe).not.toContain(credential.slice(14))
    }
  }
})

test('JSON diagnostic rewrites preserve unrelated numeric literal spelling exactly', async () => {
  const source = `{"type":"error","message":"${credential}","id":900719925474099312345,"usage":1.2300,"reset":1e+005}`
  const expected = source.replace(credential, '[credential]')
  expect(redactCredentialFrame(source, credential)).toBe(expected)
  const response = await redactCredentialResponse(
    new Response(source, { status: 429 }),
    credential,
  )
  expect(await response.text()).toBe(expected)
})

test('numeric-looking credentials become JSON strings without rounding other numbers', async () => {
  const token = '900719925474099312345'
  const source = `{"type":"error","secret":${token},"id":123456789012345678901,"reset":1e+005}`
  const expected =
    '{"type":"error","secret":"[credential]","id":123456789012345678901,"reset":1e+005}'
  expect(redactCredentialFrame(source, token)).toBe(expected)
  const response = await redactCredentialResponse(
    new Response(source, { status: 400 }),
    token,
  )
  expect(await response.text()).toBe(expected)
})

test('owned error projection preserves scrubbed provider request ids from headers and body', () => {
  for (const source of [
    Object.assign(new Error('Refused'), {
      responseHeaders: { 'x-request-id': 'req-header-123' },
    }),
    Object.assign(new Error('Refused'), {
      responseBody: '{"request_id":"req-body-123"}',
    }),
    Object.assign(new Error('Refused'), { request_id: 'req-own-123' }),
  ]) {
    const safe = redactCredentialError(source, credential)
    const id = Object.getOwnPropertyDescriptor(safe, 'request_id')
    expect(id && 'value' in id).toBe(true)
    expect(id?.value).toMatch(/^req-(header|body|own)-123$/)
  }
  const safe = redactCredentialError(
    Object.assign(new Error('Refused'), {
      responseHeaders: { 'x-request-id': credential },
    }),
    credential,
  )
  expect(Object.getOwnPropertyDescriptor(safe, 'request_id')?.value).toBe(
    '[credential]',
  )
})

test('numeric provider request ids retain their source digits as an owned string', () => {
  const source = Object.assign(new Error('Refused'), {
    responseBody: '{"request_id":900719925474099312345}',
  })
  const safe = redactCredentialError(source)
  expect(Object.getOwnPropertyDescriptor(safe, 'request_id')?.value).toBe(
    '900719925474099312345',
  )
})

test('rebuilt SSE errors never retain credential-equal scalar retry metadata', () => {
  for (const token of ['12345', 'true', 'false', 'null']) {
    const source = `{"type":"error","message":"Rejected ${token}","retry":{"value":${token},"other":67890}}`
    const safe = JSON.parse(redactCredentialFrame(source, token))
    expect(safe.message).toBe('Rejected [credential]')
    expect(String(safe.retry.value)).not.toBe(token)
    expect(safe.retry.value).toBe('[credential]')
    expect(safe.retry.other).toBe(67890)
  }
})

test('numeric scalar aliases are scrubbed without rounding or masking unrelated numeric ids', () => {
  for (const [token, number] of [
    ['100000', '1e+005'],
    ['100000', '100000.00'],
    ['1.23', '123e-2'],
  ] as const) {
    const source = `{"type":"error","value":${number},"other":900719925474099312346}`
    const safe = redactCredentialFrame(source, token)
    expect(JSON.parse(safe).value).toBe('[credential]')
    expect(safe).toContain('"other":900719925474099312346')
  }
  expect(redactCredentialFrame('{"type":"error","id":12345}', '123')).toBe(
    '{"type":"error","id":12345}',
  )
})
