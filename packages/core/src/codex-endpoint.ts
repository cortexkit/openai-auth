/** A configured Responses URL becomes the base the host appends /responses to. */
export function codexBaseURL(endpoint: string): string {
  return endpoint.replace(/\/responses\/?$/, '').replace(/\/$/, '')
}

/** Move only the default platform Responses URL; custom endpoints stay intact. */
export function codexRequestURL(url: string, endpoint: string): string {
  const original = new URL(url)
  if (
    (original.origin !== 'https://api.openai.com' &&
      original.origin !== 'wss://api.openai.com') ||
    !/\/responses\/?$/.test(original.pathname)
  )
    return url
  const destination = new URL(`${codexBaseURL(endpoint)}/responses`)
  destination.search = original.search
  if (original.protocol === 'ws:' || original.protocol === 'wss:') {
    destination.protocol = destination.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  return destination.href
}

export const DEFAULT_CODEX_API_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'

export function resolveCodexEndpoint(
  configured: unknown,
  override = process.env.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT,
): string {
  return (
    override?.trim() ||
    (typeof configured === 'string' && configured.trim()) ||
    DEFAULT_CODEX_API_ENDPOINT
  )
}
