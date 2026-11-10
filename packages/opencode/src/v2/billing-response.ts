import { watchServerSentEvents } from '@cortexkit/common-auth/opencode2'
import type { VaultBillingAttempt } from '@cortexkit/openai-auth-core/internal'
import { inspectCodexEvent } from './adapter'

/** Keep-warm bypasses the host's request-end callbacks; observe only the bytes its reader consumes. */
export function observeBillingResponse(
  record: VaultBillingAttempt,
  response: Response,
): Response {
  if (!response.ok || !response.body) {
    record.end(false, true, response.status)
    return response
  }
  let outputStarted = false
  const body = response.body.pipeThrough(
    watchServerSentEvents(
      (event) => {
        outputStarted ||=
          inspectCodexEvent(event.data, Date.now())?.outputStarted === true
        try {
          record.event(JSON.parse(event.data))
        } catch {}
      },
      () => {},
    ),
  )
  const reader = body.getReader()
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            controller.close()
            record.end(outputStarted, true, response.status)
          } else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
          record.end(outputStarted, false, response.status)
        }
      },
      cancel(reason) {
        record.end(outputStarted, false, response.status)
        return reader.cancel(reason)
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}
