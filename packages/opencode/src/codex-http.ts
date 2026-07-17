import { isRecord } from './util/record'

// Codex marks Responses Lite per transport. WebSocket requests carry a
// request-scoped client_metadata key; HTTP requests carry a header instead.
export function hasWebSocketResponsesLiteMetadata(
  body: BodyInit | null | undefined,
) {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body)
    return (
      isRecord(parsed) &&
      isRecord(parsed.client_metadata) &&
      parsed.client_metadata
        .ws_request_header_x_openai_internal_codex_responses_lite === 'true'
    )
  } catch {
    return false
  }
}

export function sanitizeHttpFallbackBody(body: BodyInit | null | undefined) {
  if (typeof body !== 'string') return body
  try {
    const parsed = JSON.parse(body)
    if (!isRecord(parsed) || !isRecord(parsed.client_metadata)) return body
    if (
      !(
        'x-codex-turn-metadata' in parsed.client_metadata ||
        'x-codex-ws-stream-request-start-ms' in parsed.client_metadata ||
        'ws_request_header_x_openai_internal_codex_responses_lite' in
          parsed.client_metadata
      )
    ) {
      return body
    }
    const clientMetadata = { ...parsed.client_metadata }
    delete clientMetadata['x-codex-turn-metadata']
    delete clientMetadata['x-codex-ws-stream-request-start-ms']
    delete clientMetadata.ws_request_header_x_openai_internal_codex_responses_lite
    return JSON.stringify({ ...parsed, client_metadata: clientMetadata })
  } catch {
    return body
  }
}

export function sanitizeHttpFallbackInit(init: RequestInit | undefined) {
  if (init?.method?.toUpperCase() !== 'POST') return init
  const headers = new Headers(init.headers)
  headers.set('accept', 'text/event-stream')
  headers.set('content-type', 'application/json')
  if (hasWebSocketResponsesLiteMetadata(init.body)) {
    headers.set('x-openai-internal-codex-responses-lite', 'true')
  }
  return {
    ...init,
    headers,
    body: sanitizeHttpFallbackBody(init.body),
  }
}
