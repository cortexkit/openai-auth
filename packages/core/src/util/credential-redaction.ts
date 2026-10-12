import { types } from 'node:util'
import { redactStrings } from '../logger'

const escapedErrorField =
  /"(?:e|\\u0065)(?:r|\\u0072){2}(?:o|\\u006f)(?:r|\\u0072)"\s*:/i
const escapedErrorType =
  /"(?:t|\\u0074)(?:y|\\u0079)(?:p|\\u0070)(?:e|\\u0065)"\s*:\s*"(?:e|\\u0065)(?:r|\\u0072){2}(?:o|\\u006f)(?:r|\\u0072)"/i

/** Decode diagnostic escapes without letting JSON.parse discard duplicate fields. */
function decodeEscapes(text: string): string {
  return text.replace(
    /\\(?:u([a-f\d]{4})|(["\\/bfnrt]))/gi,
    (sequence, hex: string | undefined, short: string) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16))
      return (
        (
          { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<
            string,
            string
          >
        )[short] ??
        short ??
        sequence
      )
    },
  )
}

/** Match a known token before generic Bearer masking can consume only its wrapped prefix. */
function maskKnownCredential(text: string, credential?: string): string {
  if (!credential) return text
  const literal = text.split(credential).join('[credential]')
  const needle = credential.replace(/\s/g, '')
  if (!needle) return literal
  const normalized = literal.replace(/\s/g, '')
  if (!normalized.includes(needle)) return literal
  const positions: number[] = []
  for (let index = 0; index < literal.length; index++) {
    const character = literal[index] ?? ''
    if (!/\s/.test(character)) positions.push(index)
  }
  const parts: string[] = []
  let copied = 0
  for (
    let from = normalized.indexOf(needle);
    from >= 0;
    from = normalized.indexOf(needle, from + needle.length)
  ) {
    const start = positions[from] ?? copied
    const end = (positions[from + needle.length - 1] ?? start) + 1
    parts.push(literal.slice(copied, start), '[credential]')
    copied = end
  }
  return parts.length ? parts.join('') + literal.slice(copied) : literal
}

function redactRawText(text: string, credential?: string): string {
  const masked = maskKnownCredential(text, credential)
  return (redactStrings(masked) as string).replaceAll(
    '***REDACTED***',
    '[credential]',
  )
}

/** Scan both spellings: decoding is independent of provider JSON parsing. */
export function redactCredentialText(
  text: string,
  credential?: string,
): string {
  const raw = redactRawText(text, credential)
  const decoded = decodeEscapes(raw)
  const safe = redactRawText(decoded, credential)
  return safe === decoded ? raw : safe
}

/** Compare decimal values without converting long ids to rounded floating-point numbers. */
function canonicalNumber(text: string): string | undefined {
  const parts = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!parts) return undefined
  const fraction = parts[3] ?? ''
  const digits = (parts[2] ?? '') + fraction
  let first = 0
  while (digits[first] === '0') first++
  if (first === digits.length) return '0'
  let end = digits.length
  while (digits[end - 1] === '0') end--
  const exponent = parts[4] ?? '0'
  let start = exponent.startsWith('-') || exponent.startsWith('+') ? 1 : 0
  while (exponent[start] === '0') start++
  const significant = exponent.slice(start) || '0'
  // A bounded exponent calculation avoids expensive BigInt parsing of hostile exponent strings.
  if (significant.length > 16) return undefined
  const scale =
    BigInt((exponent.startsWith('-') ? '-' : '') + significant) -
    BigInt(fraction.length) +
    BigInt(digits.length - end)
  return `${parts[1]}${digits.slice(first, end)}e${scale}`
}

/** Visit JSON scalar literals in place, preserving every unredacted numeric lexeme. */
function redactCredentialJsonText(text: string, credential?: string): string {
  const numericCredential = credential ? canonicalNumber(credential) : undefined
  return text.replace(
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    (literal) => {
      if (!literal.startsWith('"')) {
        const matches =
          credential &&
          (literal === credential ||
            (numericCredential !== undefined &&
              canonicalNumber(literal) === numericCredential) ||
            ((credential === 'Infinity' || credential === '-Infinity') &&
              /^[-\d]/.test(literal) &&
              String(Number(literal)) === credential))
        return matches ? '"[credential]"' : literal
      }
      const decoded = decodeEscapes(literal.slice(1, -1))
      const redacted = redactCredentialText(decoded, credential)
      return redacted === decoded ? literal : JSON.stringify(redacted)
    },
  )
}

function redactDiagnosticBody(body: string, credential?: string): string {
  const lexical = redactCredentialJsonText(body, credential)
  try {
    JSON.parse(body)
    return lexical
  } catch {
    // Non-JSON HTTP diagnostics can contain SSE or unquoted escaped text.
    return redactCredentialText(lexical, credential)
  }
}

const diagnosticLimit = 16_384
const responseBodyLimit = 64 * 1024

// OpenCode 1's session retry policy (session/retry.ts) matches these patterns
// against an API error's responseBody and retries on a match, even when
// isRetryable is false. A body cut down to the size limit must still contain
// any marker the original had, or a retryable failure would stop retrying.
const retryBodyPatterns = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

/** Numeric request ids are quoted from their source lexeme, not a rounded JS number. */
function requestIdFromBody(body: string): string | undefined {
  try {
    const value = ownData(JSON.parse(body), 'request_id')
    if (typeof value === 'string') return value
    if (typeof value !== 'number') return undefined
    let depth = 0
    let key: string | undefined
    let atKey = true
    let atValue = false
    let requestId: string | undefined
    for (const match of body.matchAll(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]:,]/g,
    )) {
      const token = match[0]
      if (token === '{' || token === '[') {
        depth++
        continue
      }
      if (token === '}' || token === ']') {
        depth--
        continue
      }
      if (depth !== 1) continue
      if (token === ',') {
        atKey = true
        atValue = false
        key = undefined
        continue
      }
      if (token === ':') {
        atValue = true
        continue
      }
      if (atKey && token.startsWith('"')) {
        key = JSON.parse(token) as string
        atKey = false
        continue
      }
      if (atValue && key === 'request_id' && !token.startsWith('"'))
        requestId = token
      atValue = false
    }
    return requestId
  } catch {
    return undefined
  }
}

/** Keep small bodies readable; reduce large bodies to error codes, retry phrases and usage-limit metadata. */
function projectResponseBody(body: string, credential?: string): string {
  const safe = redactDiagnosticBody(body, credential)
  if (Buffer.byteLength(safe, 'utf8') <= responseBodyLimit) return safe
  const markers = retryBodyPatterns.flatMap(
    (pattern) => pattern.exec(safe)?.[0] ?? [],
  )
  for (const marker of ['FreeUsageLimitError', 'GoUsageLimitError']) {
    if (safe.includes(marker)) markers.push(marker)
  }
  const compact: Record<string, unknown> = { retry: markers }
  try {
    const parsed: unknown = JSON.parse(safe)
    if (ownData(parsed, 'type') === 'error') compact.type = 'error'
    const source = ownData(parsed, 'error')
    const error: Record<string, string> = {}
    for (const key of ['code', 'type']) {
      const value = ownData(source, key)
      if (typeof value === 'string') error[key] = value.slice(0, 256)
    }
    if (Object.keys(error).length) compact.error = error
    const metadata: Record<string, string> = {}
    for (const key of ['workspace', 'limitName']) {
      const value = ownData(ownData(parsed, 'metadata'), key)
      if (typeof value === 'string') metadata[key] = value.slice(0, 256)
    }
    if (Object.keys(metadata).length) compact.metadata = metadata
  } catch {
    // Invalid JSON cannot supply error.code=context_length_exceeded, but retry phrases still matter.
  }
  return JSON.stringify(compact)
}

/** Descriptor reads on proxies run caller code, including proxies in a prototype chain. */
function safeObject(value: unknown): value is object {
  if (!value || typeof value !== 'object') return false
  let prototype: object | null = value
  for (let depth = 0; prototype && depth < 16; depth++) {
    if (types.isProxy(prototype)) return false
    prototype = Object.getPrototypeOf(prototype)
  }
  return prototype === null
}

function ownData(value: unknown, key: PropertyKey): unknown {
  if (!safeObject(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function boundedText(text: string, credential?: string): string {
  // Scrub before truncating so a credential crossing the limit cannot survive as a prefix.
  return redactCredentialText(text, credential).slice(0, diagnosticLimit)
}

function nativeGetter(
  prototype: object,
  key: string,
): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get
  if (!getter) throw new Error(`Missing native ${key} accessor`)
  return getter
}

const domMessage = nativeGetter(DOMException.prototype, 'message')
const domName = nativeGetter(DOMException.prototype, 'name')

/** Return a fresh Error with only size-limited, scrubbed data needed for abort, quota and host retry decisions. */
export function redactCredentialError(
  error: unknown,
  credential?: string,
): Error {
  let message = ownData(error, 'message')
  let name = ownData(error, 'name')
  if (safeObject(error) && error instanceof DOMException) {
    try {
      message = domMessage.call(error)
      name = domName.call(error)
    } catch {
      // An object inheriting DOMException.prototype need not have native exception slots.
    }
  }
  const result = new Error(
    boundedText(
      typeof message === 'string'
        ? message
        : typeof error === 'string'
          ? error
          : 'Provider request failed',
      credential,
    ),
  )
  for (const key of Object.getOwnPropertyNames(result)) {
    if (key !== 'message') Reflect.deleteProperty(result, key)
  }
  Object.defineProperty(result, 'name', {
    value: typeof name === 'string' ? boundedText(name, credential) : 'Error',
    configurable: true,
    writable: true,
  })
  const copy = (source: unknown, target: object, key: string) => {
    const value = ownData(source, key)
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    )
      Object.defineProperty(target, key, {
        value:
          typeof value === 'string' ? boundedText(value, credential) : value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
  }
  for (const key of [
    'status',
    'statusCode',
    'status_code',
    'resets_at',
    'resets_in_seconds',
  ]) {
    const value = ownData(error, key)
    if (typeof value === 'number' && Number.isFinite(value))
      copy(error, result, key)
  }
  for (const key of ['code', 'type', 'isRetryable']) copy(error, result, key)
  for (const key of ['error', 'data']) {
    const source = ownData(error, key)
    const fields = Object.create(null) as Record<string, unknown>
    for (const field of [
      'type',
      'code',
      'message',
      'resets_at',
      'resets_in_seconds',
    ])
      copy(source, fields, field)
    const nested = ownData(source, 'error')
    if (safeObject(nested)) {
      const classification = Object.create(null) as Record<string, unknown>
      for (const field of [
        'type',
        'code',
        'message',
        'resets_at',
        'resets_in_seconds',
      ])
        copy(nested, classification, field)
      fields.error = classification
    }
    if (Object.keys(fields).length)
      Object.defineProperty(result, key, { value: fields, enumerable: true })
  }
  const headers = ownData(error, 'responseHeaders')
  if (headers && typeof headers === 'object') {
    const ownedHeaders: Record<string, string> = {}
    for (const key of ['retry-after-ms', 'retry-after']) {
      const value = ownData(headers, key)
      if (typeof value === 'string')
        ownedHeaders[key] = boundedText(value, credential)
    }
    Object.defineProperty(result, 'responseHeaders', {
      value: ownedHeaders,
      enumerable: true,
    })
  }
  const body = ownData(error, 'responseBody')
  if (typeof body === 'string')
    Object.defineProperty(result, 'responseBody', {
      value: projectResponseBody(body, credential),
      enumerable: true,
    })
  const directId = ownData(error, 'request_id')
  const headerId = ownData(headers, 'x-request-id')
  const requestId =
    typeof directId === 'string'
      ? directId
      : typeof headerId === 'string'
        ? headerId
        : typeof body === 'string'
          ? requestIdFromBody(redactDiagnosticBody(body, credential))
          : undefined
  if (typeof requestId === 'string')
    Object.defineProperty(result, 'request_id', {
      value: boundedText(requestId, credential),
      enumerable: true,
    })
  // The AI SDK recognizes API errors by these Boolean brands, not by instanceof.
  for (const marker of ['vercel.ai.error', 'vercel.ai.error.AI_APICallError']) {
    const key = Symbol.for(marker)
    if (ownData(error, key) === true)
      Object.defineProperty(result, key, { value: true })
  }
  return result
}

/** Only error frames are rewritten; normal model output must remain byte-identical. */
export function redactCredentialFrame(
  frame: string,
  credential?: string,
): string {
  // Parse only frames that can be an error envelope: any frame containing the
  // word, or one that spells the error key or type with Unicode escapes.
  // Ordinary deltas, including escaped non-ASCII text, skip the parse.
  if (
    !frame.includes('error') &&
    (!frame.includes('\\u00') ||
      (!escapedErrorField.test(frame) && !escapedErrorType.test(frame)))
  )
    return frame
  let value: ReturnType<typeof JSON.parse>
  try {
    value = JSON.parse(frame)
  } catch {
    // Non-JSON frames are not provider error envelopes.
    return frame
  }
  if (value?.type === 'error' || value?.error || value?.response?.error)
    return redactCredentialJsonText(frame, credential)
  return frame
}

const responseStatus = nativeGetter(Response.prototype, 'status')
const responseStatusText = nativeGetter(Response.prototype, 'statusText')
const responseHeaders = nativeGetter(Response.prototype, 'headers')
const responseBody = nativeGetter(Response.prototype, 'body')
const responseText = Response.prototype.text
const headerEntries = Headers.prototype.entries

/** Scrub HTTP errors and caller-declared SSE errors without buffering successful output. */
export async function redactCredentialResponse(
  response: Response,
  credential?: string,
  mode: 'event-stream' | 'http' = 'http',
): Promise<Response> {
  try {
    if (!safeObject(response)) throw new Error('Invalid provider response')
    const status = responseStatus.call(response) as number
    const headers = responseHeaders.call(response) as Headers
    const bodyStream = responseBody.call(
      response,
    ) as ReadableStream<Uint8Array> | null
    const ownedHeaders = new Headers()
    for (const [name, value] of headerEntries.call(headers))
      ownedHeaders.append(name, value)
    const init = {
      status,
      statusText: redactCredentialText(
        responseStatusText.call(response) as string,
        credential,
      ),
      headers: ownedHeaders,
    }
    if (status < 200 || status > 299) {
      for (const [name, value] of headerEntries.call(headers)) {
        if (redactCredentialText(name, credential?.toLowerCase()) !== name) {
          init.headers.delete(name)
          continue
        }
        try {
          init.headers.set(name, redactCredentialText(value, credential))
        } catch {
          // An unrepresentable diagnostic is safer to omit than to forward verbatim.
          init.headers.delete(name)
        }
      }
      init.headers.delete('content-length')
      const body = await responseText.call(response)
      // Scan lexical strings even in malformed JSON or HTTP bodies containing SSE.
      return new Response(redactDiagnosticBody(body, credential), init)
    }
    // Hosts parse model streams as SSE even when a provider omits or mislabels the header.
    if (!bodyStream || mode === 'http') return response
    init.headers.delete('content-length')
    const reader = ReadableStream.prototype.getReader.call(
      bodyStream,
    ) as ReadableStreamDefaultReader<Uint8Array>
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const encoder = new TextEncoder()
    let pending = ''
    let atStart = true
    function scrub(event: string) {
      const bom = atStart && event.startsWith('\ufeff') ? '\ufeff' : ''
      atStart = false
      return (
        bom +
        event
          .slice(bom.length)
          .replace(
            /^data: ?([^\r\n]*)/gm,
            (line, data: string) =>
              line.slice(0, line.length - data.length) +
              redactCredentialFrame(data, credential),
          )
      )
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            for (;;) {
              const chunk = await reader.read()
              pending += decoder.decode(chunk.value, { stream: !chunk.done })
              let emitted = false
              for (;;) {
                const boundary = /\r?\n\r?\n/.exec(pending)
                if (!boundary) break
                const end = boundary.index + boundary[0].length
                controller.enqueue(encoder.encode(scrub(pending.slice(0, end))))
                pending = pending.slice(end)
                emitted = true
              }
              if (chunk.done) {
                if (pending) controller.enqueue(encoder.encode(scrub(pending)))
                controller.close()
                return
              }
              if (emitted) return
            }
          } catch (error) {
            controller.error(redactCredentialError(error, credential))
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } catch (error) {
            throw redactCredentialError(error, credential)
          } finally {
            reader.releaseLock()
          }
        },
      }),
      init,
    )
  } catch (error) {
    throw redactCredentialError(error, credential)
  }
}
