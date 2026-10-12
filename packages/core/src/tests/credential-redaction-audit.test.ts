import { expect, test } from 'bun:test'
import { redactStrings } from '../logger'
import {
  redactCredentialError,
  redactCredentialFrame,
  redactCredentialResponse,
  redactCredentialText,
} from '../util/credential-redaction'

const token = 'relay-attempt-credential-7f3e9a1c2b'
const escaped = (text: string) =>
  Array.from(
    text,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  ).join('')

test('audit duplicate keys cannot conceal credentials in HTTP or SSE errors', async () => {
  for (const secret of [token, escaped(token)]) {
    const body = `{"type":"error","message":"${secret}","message":"safe","error":{"code":"usage_limit_reached"}}`
    const http = await redactCredentialResponse(
      new Response(body, { status: 429 }),
      token,
    )
    const texts = [await http.text(), redactCredentialFrame(body, token)]
    for (const text of texts) {
      expect(text).not.toContain(token)
      expect(text).not.toContain(escaped(token))
      expect(JSON.parse(text).error.code).toBe('usage_limit_reached')
      expect(JSON.parse(text).message).toBe('safe')
    }
  }
})

test('audit raw and escape-decoded diagnostics are scanned independently', async () => {
  for (const material of [
    `bad ${escaped(token)}`,
    `event: error\ndata: {"error":"${escaped(token)}"}\n\n`,
    `bad relay\\u002dattempt-credential-7f3e9a1c2b`,
    `bad ${escaped('Bearer unrelated')}`,
    `bad ${escaped('eyJheader.payload.signature')}`,
  ]) {
    expect(redactCredentialText(material, token)).not.toContain(escaped(token))
    expect(redactCredentialText(material, token)).not.toContain(token)
    const response = await redactCredentialResponse(
      new Response(material, { status: 400 }),
      token,
    )
    const output = await response.text()
    expect(output).not.toContain(escaped(token))
    expect(output).not.toContain(token)
    expect(output).toContain('[credential]')
  }
})

test('audit non-ok header names cannot contain credentials', async () => {
  const response = await redactCredentialResponse(
    new Response('refused', {
      status: 429,
      headers: {
        [`x-${token}`]: 'diagnostic',
        'retry-after': '120',
        'x-safe': 'safe',
      },
    }),
    token,
  )
  expect(Array.from(response.headers.keys()).join(' ')).not.toContain(token)
  expect(response.headers.get('retry-after')).toBe('120')
  expect(response.headers.get('x-safe')).toBe('safe')
})

test('audit thrown objects become owned bounded data without executing caller code', () => {
  let calls = 0
  const getter = () => {
    calls++
    return token
  }
  const functionError = Object.assign(
    () => {
      calls++
      return token
    },
    { message: token },
  )
  const proxy = new Proxy(
    {},
    {
      get: getter,
      getPrototypeOf() {
        calls++
        return Error.prototype
      },
      ownKeys() {
        calls++
        return ['message']
      },
      getOwnPropertyDescriptor() {
        calls++
        return { configurable: true, value: token }
      },
    },
  )
  const inherited = Object.create({
    get message() {
      return getter()
    },
  })
  for (const source of [
    new Headers({ 'x-secret': token }),
    Object.assign(new Headers(), { token }),
    functionError,
    Object.assign(() => 0, { token }),
    inherited,
    Object.create({ token }),
    {
      get message() {
        return getter()
      },
    },
    { [Symbol('message')]: token },
    new URL(`https://example.invalid/?key=${token}`),
    proxy,
    Symbol(token),
    Object.assign(new Error(token), {
      detail: new Headers({ 'x-secret': token }),
    }),
  ]) {
    const safe = redactCredentialError(source, token)
    expect(Object.getPrototypeOf(safe)).toBe(Error.prototype)
    expect(safe).not.toBe(source)
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(safe),
    )) {
      expect('value' in descriptor).toBe(true)
      expect(typeof descriptor.value).not.toBe('function')
      expect(String(descriptor.value)).not.toContain(token)
      expect([
        'message',
        'name',
        'stack',
        'status',
        'code',
        'error',
        'responseHeaders',
        'isRetryable',
        'data',
      ]).toContain(key)
    }
    expect(Object.getOwnPropertySymbols(safe)).toEqual([])
  }
  expect(calls).toBe(0)
})

test('audit cancellation after completion cannot reject with a raw credential', async () => {
  let canceled = 0
  const source = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {}\n\n'))
        controller.close()
      },
      cancel() {
        canceled++
        throw new Error(token)
      },
    }),
  )
  const response = await redactCredentialResponse(source, token, 'event-stream')
  expect(await response.text()).toBe('data: {}\n\n')
  await expect(response.body!.cancel()).resolves.toBeUndefined()
  expect(canceled).toBe(0)
})

test('audit BOM success bytes stay identical at start and inside stream under every header', async () => {
  for (const contentType of [undefined, 'text/plain', 'text/event-stream']) {
    for (const text of [
      '\ufeffdata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"a\ufeffb"}\n\n',
      'data: {}\n\n\ufeffdata: {}\n\n',
      `:\n\n\ufeffevent: error\ndata: ${token}\n\n`,
    ]) {
      const bytes = new TextEncoder().encode(text)
      const response = await redactCredentialResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
              controller.close()
            },
          }),
          { headers: contentType ? { 'content-type': contentType } : {} },
        ),
        token,
        'event-stream',
      )
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    }
  }
  const error = await redactCredentialResponse(
    new Response(`\ufeffdata: {"type":"error","message":"${token}"}\n\n`),
    token,
    'event-stream',
  )
  expect(await error.text()).not.toContain(token)
})

test('audit Response subclasses and reused bodies do not run getters or leak', async () => {
  let calls = 0
  class ProviderResponse extends Response {
    override get status(): number {
      calls++
      throw new Error(token)
    }
    override get headers(): Headers {
      calls++
      throw new Error(token)
    }
    override get body(): Response['body'] {
      calls++
      throw new Error(token)
    }
    override text(): Promise<string> {
      calls++
      throw new Error(token)
    }
  }
  const response = await redactCredentialResponse(
    new ProviderResponse(token, { status: 400 }),
    token,
  )
  expect(await response.text()).toBe('[credential]')
  expect(calls).toBe(0)
  const used = new Response(token, { status: 400 })
  await used.text()
  try {
    await redactCredentialResponse(used, token)
    throw new Error('Expected consumed body rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(token)
  }
  const nested = redactCredentialError(
    Object.assign(new Error(token), { response: new ProviderResponse(token) }),
    token,
  )
  expect(Object.hasOwn(nested, 'response')).toBe(false)
  expect(calls).toBe(0)
})

test('audit JWT scan is bounded on long incomplete and overlapping candidates', () => {
  const samples: number[] = []
  for (const count of [2_000, 8_000, 32_000]) {
    const material = `eyJ${'a'.repeat(count)}.${'b'.repeat(count)}`
    const start = performance.now()
    expect(redactStrings(material)).not.toContain('eyJ')
    samples.push(performance.now() - start)
  }
  console.log('JWT pathological milliseconds', JSON.stringify(samples))
  expect(samples[2]!).toBeLessThan(100)
  const repeated = `eyJ${'eyJ'.repeat(20_000)}.${'b'.repeat(20_000)}`
  const start = performance.now()
  expect(redactStrings(repeated)).not.toContain('eyJ')
  expect(performance.now() - start).toBeLessThan(100)
})

test('audit proxied Error prototype does not execute traps', () => {
  let calls = 0
  const prototype = new Proxy(Error.prototype, {
    getPrototypeOf() {
      calls++
      return null
    },
  })
  redactCredentialError(Object.create(prototype), token)
  expect(calls).toBe(0)
})

test('audit thrown stream slot cannot carry a credential out', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(token))
      controller.close()
    },
  })
  const out = redactCredentialError({ body }, token)
  expect(Object.getOwnPropertyDescriptor(out, 'body')).toBeUndefined()
})

for (const [id, text] of [
  ['literal', `{"m":"${token}","m":"ok"}`],
  ['escaped', `{"m":"${escaped(token)}","m":"ok"}`],
  ['http-sse', `event: error\ndata: {"error":"${escaped(token)}"}\n\n`],
  ['sse', `event: error\ndata: {"error":"${escaped(token)}","error":"ok"}\n\n`],
] as const) {
  test(`peer duplicate and escaped ${id}`, async () => {
    const out = await redactCredentialResponse(
      new Response(text, { status: id === 'sse' ? 200 : 401 }),
      token,
      id === 'sse' ? 'event-stream' : 'http',
    )
    const result = await out.text()
    expect(result).not.toContain(token)
    expect(result).not.toContain(escaped(token))
  })
}

test('peer healthy HTTP lazy, visible stream bytes, and plain error scrub', async () => {
  const source = new Response(token)
  expect(await redactCredentialResponse(source, token, 'http')).toBe(source)
  expect(source.bodyUsed).toBe(false)
  expect(await source.text()).toBe(token)
  const text = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: token } })}\n\n`
  const stream = await redactCredentialResponse(
    new Response(text),
    token,
    'event-stream',
  )
  expect(await stream.text()).toBe(text)
  expect(redactCredentialError(new Error(token), token).message).toBe(
    '[credential]',
  )
})

test('peer hostile getter and callable coercion are never executed', () => {
  let calls = 0
  const source = {
    get message() {
      calls++
      return token
    },
    toJSON() {
      calls++
      return { message: token }
    },
  }
  const safe = redactCredentialError(source, token)
  expect(calls).toBe(0)
  expect(safe.message).not.toContain(token)
})

test('peer direct Proxy traps are never executed', () => {
  let calls = 0
  const source = new Proxy(
    {},
    {
      get() {
        calls++
        return token
      },
      getPrototypeOf() {
        calls++
        return Error.prototype
      },
      ownKeys() {
        calls++
        return ['message']
      },
      getOwnPropertyDescriptor() {
        calls++
        return { configurable: true, value: token }
      },
    },
  )
  redactCredentialError(source, token)
  expect(calls).toBe(0)
})

for (const [label, source] of [
  ['headers-expando', Object.assign(new Headers(), { token })],
  ['callable-expando', Object.assign(() => 0, { token })],
  ['inherited-data', Object.create({ token })],
  ['thrown-url-slot', new URL(`https://example.invalid/?key=${token}`)],
  ['thrown-symbol', Symbol(token)],
] as const) {
  test(`peer ${label}`, () => {
    const out = redactCredentialError(source, token)
    expect(Object.getOwnPropertyDescriptor(out, 'token')?.value).not.toBe(token)
    expect(out).not.toBe(source)
    expect(out.message).not.toContain(token)
  })
}

test('audit non-ok body read rejections are scrubbed', async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`Read rejected ${token}`)
      },
    }),
    { status: 401 },
  )
  await expect(redactCredentialResponse(response, token)).rejects.toThrow(
    'Read rejected [credential]',
  )
})

test('audit projection is bounded and drops nested getters, symbols, causes and platform slots', () => {
  let calls = 0
  const source = Object.assign(new Error(`${'x'.repeat(16_380)}${token}`), {
    status: 429,
    code: 'usage_limit_reached',
    cause: new Error(token),
    error: {
      type: 'usage_limit_reached',
      get code() {
        calls++
        return token
      },
      [Symbol('secret')]: token,
    },
    responseHeaders: { 'retry-after': '120', 'x-secret': token },
    body: new ReadableStream(),
  })
  const safe = redactCredentialError(source, token)
  expect(safe.message.length).toBeLessThanOrEqual(16_384)
  expect(safe.message).not.toContain('relay')
  expect(Object.getOwnPropertyDescriptor(safe, 'status')?.value).toBe(429)
  expect(Object.getOwnPropertyDescriptor(safe, 'code')?.value).toBe(
    'usage_limit_reached',
  )
  expect(Object.getOwnPropertyDescriptor(safe, 'error')?.value).toEqual({
    type: 'usage_limit_reached',
  })
  expect(
    Object.getOwnPropertyDescriptor(safe, 'responseHeaders')?.value,
  ).toEqual({ 'retry-after': '120' })
  expect(Object.hasOwn(safe, 'cause')).toBe(false)
  expect(Object.hasOwn(safe, 'body')).toBe(false)
  expect(calls).toBe(0)
})

test('peer later-frame BOM preserves healthy visible bytes', async () => {
  const text = `:\n\n\ufeffevent: error\ndata: ${token}\n\n`
  const out = await redactCredentialResponse(
    new Response(text),
    token,
    'event-stream',
  )
  expect(await out.text()).toBe(text)
})

test('audit inherited Error accessors and Symbol-keyed messages are not retained or executed', () => {
  let calls = 0
  const inherited = Object.create(
    Object.create(Error.prototype, {
      message: {
        get() {
          calls++
          return token
        },
      },
      name: {
        get() {
          calls++
          return token
        },
      },
    }),
  )
  const safe = redactCredentialError(inherited, token)
  expect(calls).toBe(0)
  expect(Object.getPrototypeOf(safe)).toBe(Error.prototype)
  expect(safe.name).toBe('Error')
  const symbol = redactCredentialError({ [Symbol('message')]: token }, token)
  expect(Object.getOwnPropertySymbols(symbol)).toEqual([])
  expect(symbol.message).not.toContain(token)
})
