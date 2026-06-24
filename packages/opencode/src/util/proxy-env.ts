function proxyEnv(name: string) {
  return process.env[name] ?? process.env[name.toLowerCase()]
}

function shouldBypassProxy(url: URL): boolean {
  const noProxy = proxyEnv('NO_PROXY')
  if (!noProxy) return false

  const host = url.hostname.toLowerCase()
  const entries = noProxy
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  for (const entry of entries) {
    if (entry === '*') return true

    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) {
        return true
      }
    } else {
      if (host === entry || host.endsWith('.' + entry)) {
        return true
      }
    }
  }

  return false
}

export function getProxyForUrl(url: string) {
  const parsed = new URL(url)
  if (shouldBypassProxy(parsed)) return undefined

  if (parsed.protocol === 'http:') return proxyEnv('HTTP_PROXY')
  if (parsed.protocol === 'https:')
    return proxyEnv('HTTPS_PROXY') ?? proxyEnv('HTTP_PROXY')
  return undefined
}

export const ProxyEnv = { getProxyForUrl }
