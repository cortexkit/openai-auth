import { redactStrings } from '../logger'
import { errorMessage } from './error'

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
  // Codex error envelopes name an error field or type; ordinary deltas need no parse.
  if (!frame.includes('"error"')) return frame
  try {
    const value = JSON.parse(frame)
    if (value?.type === 'error' || value?.error || value?.response?.error) {
      return redactCredentialText(frame, credential)
    }
  } catch {
    // Non-JSON frames are not provider error envelopes.
  }
  return frame
}

/** Scrub HTTP errors and streamed error events without buffering successful output. */
export async function redactCredentialResponse(
  response: Response,
  credential?: string,
): Promise<Response> {
  const init = {
    status: response.status,
    statusText: redactCredentialText(response.statusText, credential),
    headers: new Headers(response.headers),
  }
  if (!response.ok) {
    init.headers.delete('content-length')
    return new Response(
      redactCredentialText(await response.text(), credential),
      init,
    )
  }
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    return response
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
      cancel(reason) {
        return reader.cancel(reason)
      },
    }),
    init,
  )
}
