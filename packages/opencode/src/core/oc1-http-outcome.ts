import { normalizeWsFrame } from '@cortexkit/openai-auth-core/internal'
import {
  observeHttpCompletion,
  parseRateLimitSignal,
  RATE_LIMIT_WINDOW,
} from '../ws'
import { retryAfterMs } from './http-retry-after'

function oc1HttpLimit(body: string, headers: Headers, now: number) {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    // An empty or malformed HTTP 429 still represents a generic rate limit.
  }
  const parsed = parseRateLimitSignal(
    { ...(value && typeof value === 'object' ? value : {}), status: 429 },
    now,
  ) ?? { window: RATE_LIMIT_WINDOW }
  // A past positive body reset yields a zero hint, not the header's hint.
  // Preserve the actual reset for the mark resolver's named-cache fallback.
  if (parsed.resetAt !== undefined)
    return {
      parsed,
      retryAfterMs: Math.max(0, parsed.resetAt - now),
      resetSource: 'provider' as const,
    }
  const hint = retryAfterMs(headers)
  if (hint === undefined) return { parsed }
  return {
    parsed: { ...parsed, resetAt: now + hint },
    retryAfterMs: hint,
    resetSource: 'retry-after' as const,
  }
}

const httpLimits = new WeakMap<
  Response,
  { body: string; limit: ReturnType<typeof oc1HttpLimit>; observedAt: number }
>()

/** The replay policy uses the same body and clock sample as the HTTP mark. */
export function oc1HttpLimitFeedback(response: Response) {
  return httpLimits.get(response)
}

export function createOc1HttpObserver(input: {
  classifyLimits: boolean
  onComplete: () => void
  onCleanRead?: () => void
  onQuota: (
    reading: ReturnType<typeof normalizeWsFrame>,
    frame: unknown,
  ) => void
  onLimit?: (limit: ReturnType<typeof oc1HttpLimit>, now: number) => void
}) {
  let http429 = false
  return {
    observe(response: Response): Response {
      // Only an actual HTTP response can supply a Retry-After hint. A raw
      // WebSocket admission error is handled by the socket's own observer.
      http429 = input.classifyLimits && response.status === 429
      return observeHttpCompletion(
        response,
        (clean) => {
          if (clean) input.onComplete()
        },
        {
          onReadEnd: input.onCleanRead,
          onRateLimits: (frame) => {
            input.onQuota(normalizeWsFrame(frame), frame)
          },
        },
      )
    },
    async finish(response: Response): Promise<Response> {
      if (http429 && response.status === 429) {
        // Inspect the buffered, redacted refusal. The original response is
        // still readable and routing still owns the decision to hold or move.
        const body = await response
          .clone()
          .text()
          .catch(() => '')
        const at = Date.now()
        const limit = oc1HttpLimit(body, response.headers, at)
        httpLimits.set(response, { body, limit, observedAt: at })
        input.onLimit?.(limit, at)
      }
      return response
    },
  }
}
