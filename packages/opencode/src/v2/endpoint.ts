/** A configured Responses URL becomes the base the host appends /responses to. */
export function codexBaseURL(endpoint: string): string {
  return endpoint.replace(/\/responses\/?$/, '').replace(/\/$/, '')
}

/** Move only the default platform Responses URL; custom endpoints stay intact. */
export function codexRequestURL(url: string, endpoint: string): string {
  const original = new URL(url)
  if (
    original.hostname !== 'api.openai.com' ||
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
