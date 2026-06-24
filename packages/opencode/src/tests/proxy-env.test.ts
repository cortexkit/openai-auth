import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getProxyForUrl } from '../util/proxy-env'

describe('proxy-env', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    }
    // Clear proxy env vars
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.NO_PROXY
    delete process.env.no_proxy
  })

  afterEach(() => {
    // Restore proxy env vars
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = val
      }
    }
  })

  test('returns HTTP_PROXY for http URLs', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    expect(getProxyForUrl('http://example.com')).toBe('http://localhost:8080')
  })

  test('returns HTTPS_PROXY for https URLs, falling back to HTTP_PROXY', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    expect(getProxyForUrl('https://example.com')).toBe('http://localhost:8080')

    process.env.HTTPS_PROXY = 'http://localhost:8443'
    expect(getProxyForUrl('https://example.com')).toBe('http://localhost:8443')
  })

  test('returns undefined if no proxy is set', () => {
    expect(getProxyForUrl('http://example.com')).toBeUndefined()
    expect(getProxyForUrl('https://example.com')).toBeUndefined()
  })

  test('bypasses proxy if NO_PROXY is *', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    process.env.NO_PROXY = '*'
    expect(getProxyForUrl('http://example.com')).toBeUndefined()
    expect(getProxyForUrl('http://chatgpt.com')).toBeUndefined()
  })

  test('bypasses proxy for exact domain match in NO_PROXY', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    process.env.NO_PROXY = 'chatgpt.com,example.org'

    expect(getProxyForUrl('http://chatgpt.com')).toBeUndefined()
    expect(getProxyForUrl('http://example.org')).toBeUndefined()
    expect(getProxyForUrl('http://example.com')).toBe('http://localhost:8080')
  })

  test('bypasses proxy for subdomains when domain is in NO_PROXY', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    process.env.NO_PROXY = 'example.com'

    expect(getProxyForUrl('http://example.com')).toBeUndefined()
    expect(getProxyForUrl('http://sub.example.com')).toBeUndefined()
    expect(getProxyForUrl('http://deep.sub.example.com')).toBeUndefined()
    expect(getProxyForUrl('http://notexample.com')).toBe(
      'http://localhost:8080',
    )
  })

  test('bypasses proxy for subdomains and domain itself when leading dot is used in NO_PROXY', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    process.env.NO_PROXY = '.example.com'

    expect(getProxyForUrl('http://example.com')).toBeUndefined()
    expect(getProxyForUrl('http://sub.example.com')).toBeUndefined()
    expect(getProxyForUrl('http://notexample.com')).toBe(
      'http://localhost:8080',
    )
  })

  test('handles whitespace and case insensitivity in NO_PROXY', () => {
    process.env.HTTP_PROXY = 'http://localhost:8080'
    process.env.NO_PROXY = '  CHATGPT.COM ,  .Example.Org  '

    expect(getProxyForUrl('http://chatgpt.com')).toBeUndefined()
    expect(getProxyForUrl('http://sub.chatgpt.com')).toBeUndefined()
    expect(getProxyForUrl('http://example.org')).toBeUndefined()
    expect(getProxyForUrl('http://sub.example.org')).toBeUndefined()
  })
})
