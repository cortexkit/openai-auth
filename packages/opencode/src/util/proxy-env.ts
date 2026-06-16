function proxyEnv(name: string) {
  return process.env[name] ?? process.env[name.toLowerCase()]
}

export function getProxyForUrl(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol === "http:") return proxyEnv("HTTP_PROXY")
  if (parsed.protocol === "https:") return proxyEnv("HTTPS_PROXY") ?? proxyEnv("HTTP_PROXY")
  return undefined
}

export const ProxyEnv = { getProxyForUrl }
