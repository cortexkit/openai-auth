import type { CacheKeepPlan } from '@cortexkit/common-auth/cachekeep'
import {
  reportCacheTouch,
  reportCacheWarmStopped,
  sessionCachePolicy,
} from '@cortexkit/common-auth/routing-accessor'

/** Codex chooses its cache lifetime; session TTL requests cannot change it. */
export function sessionCacheKeepPlan(
  sessionId: string,
): CacheKeepPlan | undefined {
  const policy = sessionCachePolicy(sessionId)
  if (!policy?.keep_warm) return undefined
  return { mode: policy.keep_warm, hours: policy.hours }
}

export function shouldCaptureSessionCache(
  sessionId: string,
  enabled: boolean,
): boolean {
  const plan = sessionCacheKeepPlan(sessionId)
  return plan ? plan.mode !== 'off' : enabled
}

export function reportSessionCacheWarmed(
  sessionId: string,
  input: { at: number },
) {
  reportCacheTouch(sessionId, { ...input, ttlMs: 'implicit', source: 'warm' })
}

export function reportSessionCacheWarmStopped(
  sessionId: string,
  input: { at: number; reason: string },
) {
  reportCacheWarmStopped(sessionId, input)
}

export function deferSessionCacheResponseTouch(sessionId: string, at: number) {
  // A timer also covers bodyless replies and WebSocket frames: the host must
  // receive the reply before even a synchronous bridge report can run.
  setTimeout(() => {
    reportCacheTouch(sessionId, { at, ttlMs: 'implicit', source: 'response' })
  }, 0)
}

/** Observe consumption, not headers: failed or cancelled bodies never refresh cache. */
export function reportSessionCacheResponse(
  response: Response,
  sessionId: string | undefined,
  now: () => number = Date.now,
): Response {
  if (!sessionId || !response.ok) return response
  const completed = () => {
    deferSessionCacheResponseTouch(sessionId, now())
  }
  if (!response.body) {
    completed()
    return response
  }
  const reader = response.body.getReader()
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              controller.close()
              completed()
            } else controller.enqueue(chunk.value)
          } catch (error) {
            controller.error(error)
          }
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      },
      // Do not drain a response before the host starts reading it.
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}
