import { redactStrings } from '../logger'
import { errorMessage } from './error'

const escapedErrorField =
  /"(?:e|\\u0065)(?:r|\\u0072){2}(?:o|\\u006f)(?:r|\\u0072)"\s*:/i
const escapedErrorType =
  /"(?:t|\\u0074)(?:y|\\u0079)(?:p|\\u0070)(?:e|\\u0065)"\s*:\s*"(?:e|\\u0065)(?:r|\\u0072){2}(?:o|\\u006f)(?:r|\\u0072)"/i

/** A request bearer may have no recognizable token shape, so mask its exact value too. */
export function redactCredentialText(
  text: string,
  credential?: string,
): string {
  const masked = credential ? text.split(credential).join('[credential]') : text
  return (redactStrings(masked) as string).replaceAll(
    '***REDACTED***',
    '[credential]',
  )
}

/** Decode JSON string values before matching credentials hidden by Unicode escapes. */
function redactCredentialJsonText(
  text: string,
  value: unknown,
  credential?: string,
): string {
  let changed = false
  function scrub(value: unknown): unknown {
    if (typeof value === 'string') {
      const redacted = redactCredentialText(value, credential)
      if (redacted !== value) changed = true
      return redacted
    }
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, scrub(item)]),
      )
    return value
  }
  const redacted = scrub(value)
  return changed ? JSON.stringify(redacted) : text
}

/** Mask upstream diagnostics while preserving error types used for aborts and quota routing. */
export function redactCredentialError(
  error: unknown,
  credential?: string,
): Error {
  const message = redactCredentialText(
    error instanceof DOMException ? error.message : errorMessage(error),
    credential,
  )
  const scrub = (value: unknown, seen = new WeakSet<object>()): unknown => {
    if (typeof value === 'string')
      return redactCredentialText(value, credential)
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => scrub(item, seen))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'cause')
        .map(([key, item]) => [key, scrub(item, seen)]),
    )
  }
  if (error instanceof Error || error instanceof DOMException) {
    try {
      Object.defineProperty(error, 'message', {
        value: message,
        configurable: true,
        writable: true,
      })
      if (typeof error.stack === 'string')
        error.stack = redactCredentialText(error.stack, credential)
      if ('cause' in error) delete error.cause
      for (const key of Object.keys(error)) {
        const descriptor = Object.getOwnPropertyDescriptor(error, key)
        if (descriptor && 'value' in descriptor)
          Object.defineProperty(error, key, {
            ...descriptor,
            value: scrub(descriptor.value),
          })
      }
      return error
    } catch {
      // A frozen provider error cannot safely retain its original message.
    }
  }
  return new Error(message)
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
    return redactCredentialJsonText(frame, value, credential)
  return frame
}

/** Scrub HTTP errors and caller-declared SSE errors without buffering successful output. */
export async function redactCredentialResponse(
  response: Response,
  credential?: string,
  mode: 'event-stream' | 'http' = 'http',
): Promise<Response> {
  const init = {
    status: response.status,
    statusText: redactCredentialText(response.statusText, credential),
    headers: new Headers(response.headers),
  }
  if (!response.ok) {
    for (const [name, value] of response.headers) {
      try {
        init.headers.set(name, redactCredentialText(value, credential))
      } catch {
        // An unrepresentable diagnostic is safer to omit than to forward verbatim.
        init.headers.delete(name)
      }
    }
    init.headers.delete('content-length')
    const body = await response.text()
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      return new Response(redactCredentialText(body, credential), init)
    }
    return new Response(redactCredentialJsonText(body, value, credential), init)
  }
  // Hosts parse model streams as SSE even when a provider omits or mislabels the header.
  if (!response.body || mode === 'http') return response
  init.headers.delete('content-length')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  function scrub(event: string) {
    return event.replace(
      /^data: ?([^\r\n]*)/gm,
      (line, data: string) =>
        line.slice(0, line.length - data.length) +
        redactCredentialFrame(data, credential),
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
}
