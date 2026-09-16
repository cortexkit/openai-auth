import { afterEach, describe, expect, it } from 'bun:test'
import {
  beginDeviceAuth,
  buildUserAgent,
} from '@cortexkit/openai-auth-core/internal'
import { PackageVersion } from '../version'

/**
 * The `User-Agent` this plugin sends is wire-visible, so a change to it is a
 * change the provider sees. Moving the OAuth code into the shared core turned
 * the value from a constant this package built into an argument it passes, and
 * this pins the result to the exact string it was before that move:
 * `cortexkit-opencode-openai-auth/<this package's version>`.
 */
const EXPECTED_USER_AGENT = `cortexkit-opencode-openai-auth/${PackageVersion}`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OpenCode OAuth User-Agent', () => {
  it('builds the same value this package sent before the core extraction', () => {
    expect(buildUserAgent(PackageVersion)).toBe(EXPECTED_USER_AGENT)
  })

  it('sends that exact value on the device-authorization request', async () => {
    const seen: Array<string | null> = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('user-agent'))
      return Response.json({
        device_auth_id: 'device-id',
        user_code: 'ABCD-EFGH',
        interval: '5',
      })
    }) as unknown as typeof globalThis.fetch

    await beginDeviceAuth(PackageVersion)

    expect(seen).toEqual([EXPECTED_USER_AGENT])
  })
})
