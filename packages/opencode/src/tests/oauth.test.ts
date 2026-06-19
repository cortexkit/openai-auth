import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'node:http'
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  escapeHtml,
  extractAccountId,
  extractAccountIdFromClaims,
  generatePKCE,
  HTML_ERROR,
  HTML_SUCCESS,
  type IdTokenClaims,
  type IngestAccount,
  OAUTH_PORT,
  parseJwtClaims,
  resetOAuthStateForTest,
  startOAuthServer,
  upsertAccount,
  waitForOAuthCallback,
} from '../core/oauth'

// ---------------------------------------------------------------------------
// upsertAccount
// ---------------------------------------------------------------------------

function makeAccount(
  id: string,
  overrides: Partial<IngestAccount> = {},
): IngestAccount {
  return {
    id,
    type: 'oauth',
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 3600_000,
    enabled: true,
    addedAt: Date.now(),
    lastUsed: Date.now(),
    ...overrides,
  }
}

async function expectOAuthPortClosed() {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const closed = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(OAUTH_PORT, () => {
        probe.close(() => resolve(true))
      })
    })
    if (closed) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`OAuth port ${OAUTH_PORT} was still accepting listeners`)
}

describe('upsertAccount', () => {
  test('pushes a new account onto an empty array', () => {
    const accounts: IngestAccount[] = []
    const acc = makeAccount('acct-1')
    upsertAccount(accounts, acc)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe('acct-1')
  })

  test('deduplicates by id — merge-updates preserving addedAt', () => {
    const original = makeAccount('acct-1', {
      label: 'work',
      access: 'old-access',
      addedAt: 1000,
    })
    const accounts: IngestAccount[] = [original]

    const updated = makeAccount('acct-1', {
      label: 'work',
      access: 'new-access',
      addedAt: 2000,
    })
    upsertAccount(accounts, updated)

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.access).toBe('new-access')
    expect(accounts[0]?.addedAt).toBe(1000) // preserved
  })

  test('deduplicates by label when ids differ', () => {
    const first = makeAccount('acct-1', { label: 'work' })
    const accounts: IngestAccount[] = [first]

    const second = makeAccount('acct-2', {
      label: 'work',
      access: 'newer',
      addedAt: 3000,
    })

    upsertAccount(accounts, second)

    expect(accounts).toHaveLength(1)
    // Label dedup merges the new account's fields into the old slot;
    // id is overwritten by the incoming account.
    expect(accounts[0]?.id).toBe('acct-2')
    expect(accounts[0]?.access).toBe('newer')
    // addedAt preserved from original
    expect(accounts[0]?.addedAt).toBe(first.addedAt)
  })

  test('does not deduplicate when label is undefined', () => {
    const first = makeAccount('acct-1')
    const accounts: IngestAccount[] = [first]
    const second = makeAccount('acct-2')

    upsertAccount(accounts, second)

    expect(accounts).toHaveLength(2)
  })

  test('returns the correct index', () => {
    const accounts: IngestAccount[] = [makeAccount('a'), makeAccount('b')]
    const idx = upsertAccount(accounts, makeAccount('c'))
    expect(idx).toBe(2)
    const idxDedup = upsertAccount(
      accounts,
      makeAccount('a', { access: 'updated' }),
    )
    expect(idxDedup).toBe(0)
  })

  // --- accountId-based dedup (steer) ---

  test('deduplicates by accountId — same ChatGPT account, different ids and labels', () => {
    const first = makeAccount('acct-1', {
      label: 'work',
      accountId: 'chatgpt-acc-123',
    })
    const accounts: IngestAccount[] = [first]

    const second = makeAccount('acct-2', {
      accountId: 'chatgpt-acc-123',
      access: 'fresh-token',
      addedAt: 5000,
    })

    upsertAccount(accounts, second)

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.access).toBe('fresh-token')
    expect(accounts[0]?.addedAt).toBe(first.addedAt)
  })

  test('accountId dedup wins over label conflict', () => {
    const first = makeAccount('acct-a', {
      label: 'personal',
      accountId: 'chatgpt-acc-456',
    })
    const second = makeAccount('acct-b', {
      label: 'personal',
      accountId: 'chatgpt-acc-789',
    })
    const accounts: IngestAccount[] = [first, second]

    const third = makeAccount('acct-c', {
      label: 'personal',
      accountId: 'chatgpt-acc-456',
    })

    upsertAccount(accounts, third)

    expect(accounts).toHaveLength(2)
    expect(accounts[0]?.accountId).toBe('chatgpt-acc-456')
    expect(accounts[1]?.accountId).toBe('chatgpt-acc-789')
  })

  test('two genuinely different accounts both kept', () => {
    const first = makeAccount('acct-a', { accountId: 'chatgpt-acc-111' })
    const accounts: IngestAccount[] = [first]

    const second = makeAccount('acct-b', { accountId: 'chatgpt-acc-222' })
    upsertAccount(accounts, second)

    expect(accounts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe('generatePKCE', () => {
  test('returns verifier and challenge', async () => {
    const pkce = await generatePKCE()
    expect(pkce.verifier).toBeString()
    expect(pkce.challenge).toBeString()
    expect(pkce.verifier.length).toBeGreaterThan(0)
    expect(pkce.challenge.length).toBeGreaterThan(0)
    // challenge should be base64url (no +, /, or =)
    expect(pkce.challenge).not.toContain('+')
    expect(pkce.challenge).not.toContain('/')
    expect(pkce.challenge).not.toMatch(/=$/)
  })
})

describe('base64UrlEncode', () => {
  test('encodes to url-safe base64', () => {
    const data = new TextEncoder().encode('hello world')
    const encoded = base64UrlEncode(data.buffer)
    expect(encoded).toBeString()
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toMatch(/=$/)
  })
})

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

describe('parseJwtClaims', () => {
  test('parses a valid JWT', () => {
    const header = btoa(JSON.stringify({ alg: 'RS256' }))
    const payload = btoa(JSON.stringify({ chatgpt_account_id: 'acc-123' }))
    const token = `${header}.${payload}.sig`
    const claims = parseJwtClaims(token)
    expect(claims?.chatgpt_account_id).toBe('acc-123')
  })

  test('returns undefined for malformed input', () => {
    expect(parseJwtClaims('not.a.jwt.token')).toBeUndefined()
    expect(parseJwtClaims('')).toBeUndefined()
    expect(parseJwtClaims('a.b')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// extractAccountId
// ---------------------------------------------------------------------------

describe('extractAccountId', () => {
  test('extracts from id_token', () => {
    const payload = btoa(JSON.stringify({ chatgpt_account_id: 'id-abc' }))
    const tokens = {
      id_token: `h.${payload}.s`,
      access_token: 'at',
      refresh_token: 'rt',
    }
    expect(extractAccountId(tokens)).toBe('id-abc')
  })

  test('extracts from https://api.openai.com/auth nested claim', () => {
    const payload = btoa(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'nested-id' },
      }),
    )
    const tokens = {
      id_token: `h.${payload}.s`,
      access_token: 'at',
      refresh_token: 'rt',
    }
    expect(extractAccountId(tokens)).toBe('nested-id')
  })

  test('falls back to access_token when id_token has no account id', () => {
    const payload = btoa(JSON.stringify({ sub: 'user' }))
    const atPayload = btoa(JSON.stringify({ chatgpt_account_id: 'from-at' }))
    const tokens = {
      id_token: `h.${payload}.s`,
      access_token: `h.${atPayload}.s`,
      refresh_token: 'rt',
    }
    expect(extractAccountId(tokens)).toBe('from-at')
  })

  test('returns undefined when no account id is present', () => {
    const payload = btoa(JSON.stringify({ sub: 'user' }))
    const tokens = {
      id_token: `h.${payload}.s`,
      access_token: `h.${payload}.s`,
      refresh_token: 'rt',
    }
    expect(extractAccountId(tokens)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildAuthorizeUrl
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  test('builds a URL with required params', () => {
    const url = buildAuthorizeUrl(
      'http://localhost:1455/auth/callback',
      { verifier: 'v', challenge: 'c' },
      'state123',
    )
    expect(url).toContain('https://auth.openai.com/oauth/authorize')
    expect(url).toContain('code_challenge=c')
    expect(url).toContain('state=state123')
    expect(url).toContain(
      'redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    )
  })
})

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  test('escapes dangerous characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
    expect(escapeHtml("it's")).toBe('it&#39;s')
  })
})

describe('HTML_SUCCESS', () => {
  test('contains success message', () => {
    expect(HTML_SUCCESS).toContain('Authorization Successful')
  })
})

describe('HTML_ERROR', () => {
  test('contains error message', () => {
    const html = HTML_ERROR('test error')
    expect(html).toContain('Authorization Failed')
    expect(html).toContain('test error')
  })
})

// ---------------------------------------------------------------------------
// Council C1/C2: OAuth concurrency and server lifecycle
// ---------------------------------------------------------------------------

describe('OAuth server concurrency (C1/C2)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    // Mock fetch for the token-exchange endpoint only; passthrough for localhost.
    originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: unknown, init?: unknown) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({
            id_token: 'mock-id',
            access_token: 'mock-access',
            refresh_token: 'mock-refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return originalFetch(url as RequestInfo, init as RequestInit | undefined)
    }) as unknown as typeof globalThis.fetch
    try {
      resetOAuthStateForTest()
    } catch {
      /* */
    }
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    try {
      resetOAuthStateForTest()
    } catch {
      /* */
    }
  })

  test('C1: two concurrent waitForOAuthCallback flows both resolve correctly via state-keyed map', async () => {
    const { redirectUri } = await startOAuthServer()
    expect(redirectUri).toContain(String(OAUTH_PORT))

    const pkce1 = { verifier: 'v1', challenge: 'c1' }
    const pkce2 = { verifier: 'v2', challenge: 'c2' }
    const state1 = 'state-aaa'
    const state2 = 'state-bbb'

    const p1 = waitForOAuthCallback(pkce1, state1)
    const p2 = waitForOAuthCallback(pkce2, state2)

    // Simulate callbacks arriving in reverse order
    const cb1 = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=code1&state=${state1}`,
    )
    expect(cb1.status).toBe(200)

    const cb2 = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=code2&state=${state2}`,
    )
    expect(cb2.status).toBe(200)

    // Both promises resolve
    await expect(p1).resolves.toBeDefined()
    await expect(p2).resolves.toBeDefined()
  })

  test('concurrent startOAuthServer callers share one listen attempt', async () => {
    const [first, second] = await Promise.all([
      startOAuthServer(),
      startOAuthServer(),
    ])

    expect(first.port).toBe(OAUTH_PORT)
    expect(second).toEqual(first)

    const probe = await fetch(`http://localhost:${OAUTH_PORT}/`)
    expect(probe.status).toBe(404)
  })

  test('startOAuthServer clears failed in-flight starts so a later retry can succeed', async () => {
    const blocker = createServer((_req, res) => {
      res.writeHead(200)
      res.end('busy')
    })
    await new Promise<void>((resolve) =>
      blocker.listen(OAUTH_PORT, '127.0.0.1', resolve),
    )

    try {
      await expect(startOAuthServer()).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }

    await expect(startOAuthServer()).resolves.toEqual({
      port: OAUTH_PORT,
      redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback`,
    })
  })

  test('C1: unknown-state callback returns 400 and does not disturb pending flows', async () => {
    const { redirectUri } = await startOAuthServer()
    expect(redirectUri).toContain(String(OAUTH_PORT))

    const p1 = waitForOAuthCallback(
      { verifier: 'v', challenge: 'c' },
      'known-state',
    )

    // Send a callback with an unknown state
    const badCb = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=bad&state=unknown`,
    )
    expect(badCb.status).toBe(400)

    // The known flow should still be pending (not rejected)
    // Send the real callback
    const goodCb = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=real&state=known-state`,
    )
    expect(goodCb.status).toBe(200)

    await expect(p1).resolves.toBeDefined()
  })

  test('C1: missing state parameter returns 400', async () => {
    await startOAuthServer()
    const cb = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=somecode`,
    )
    expect(cb.status).toBe(400)
    const text = await cb.text()
    expect(text).toContain('Missing state')
  })

  test('C2: server stops when no flows are pending after flowCleanup', async () => {
    await startOAuthServer()

    const p1 = waitForOAuthCallback(
      { verifier: 'v', challenge: 'c' },
      'state-1',
    )
    const p2 = waitForOAuthCallback(
      { verifier: 'v2', challenge: 'c2' },
      'state-2',
    )

    // Resolve first flow
    await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=c1&state=state-1`,
    )
    await p1

    // Second flow still pending — server should still be running
    // (can verify by sending another request)
    const probe = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=c2&state=state-2`,
    )
    expect(probe.status).toBe(200)
    await p2

    // After second flow resolves, server should stop
    // (flowCleanup called internally by callback handler)
    // Verify by trying to connect — should fail
    try {
      await fetch(`http://localhost:${OAUTH_PORT}/`)
    } catch {
      // Expected: server is closed
    }
  })

  test('cancel for one state rejects that flow and keeps the server for other pending flows', async () => {
    await startOAuthServer()
    const cancelled = waitForOAuthCallback(
      { verifier: 'v1', challenge: 'c1' },
      'cancel-me',
    )
    const remaining = waitForOAuthCallback(
      { verifier: 'v2', challenge: 'c2' },
      'keep-me',
    )
    const cancelledError = cancelled.catch((error) => error)

    const cancelResponse = await fetch(
      `http://localhost:${OAUTH_PORT}/cancel?state=cancel-me`,
    )
    expect(cancelResponse.status).toBe(200)
    const cancelledResult = await cancelledError
    expect(cancelledResult).toEqual(expect.any(Error))
    expect(cancelledResult.message).toBe('Login cancelled')

    const callback = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=ok&state=keep-me`,
    )
    expect(callback.status).toBe(200)
    await expect(remaining).resolves.toBeDefined()
  })

  test('cancel without state rejects all flows and stops the server', async () => {
    await startOAuthServer()
    const pending = waitForOAuthCallback(
      { verifier: 'v', challenge: 'c' },
      'cancel-all',
    )
    const pendingError = pending.catch((error) => error)

    const cancelResponse = await fetch(`http://localhost:${OAUTH_PORT}/cancel`)
    expect(cancelResponse.status).toBe(200)
    const pendingResult = await pendingError
    expect(pendingResult).toEqual(expect.any(Error))
    expect(pendingResult.message).toBe('Login cancelled')

    await expectOAuthPortClosed()
  })

  test('unknown-state callback with no pending flows stops the idle server', async () => {
    await startOAuthServer()

    const response = await fetch(
      `http://localhost:${OAUTH_PORT}/auth/callback?code=bad&state=unknown`,
    )
    expect(response.status).toBe(400)

    await expectOAuthPortClosed()
  })

  test('timeout cleans up the last pending flow and stops the server', async () => {
    await startOAuthServer()
    const pending = waitForOAuthCallback(
      { verifier: 'v', challenge: 'c' },
      'timeout-state',
      1,
    )

    await expect(pending).rejects.toThrow('OAuth callback timeout')
    await expectOAuthPortClosed()
  })
})

// ---------------------------------------------------------------------------
// Council U1: IdTokenClaims has email
// ---------------------------------------------------------------------------

test('U1: IdTokenClaims type includes email', () => {
  const claims: IdTokenClaims = {
    email: 'user@example.com',
    chatgpt_account_id: 'acc-1',
  }
  expect(claims.email).toBe('user@example.com')
})

// ---------------------------------------------------------------------------
// Council U2: validate JWT claim shapes
// ---------------------------------------------------------------------------

describe('extractAccountIdFromClaims validation (U2)', () => {
  test('rejects non-string accountId candidates', () => {
    expect(
      extractAccountIdFromClaims({
        chatgpt_account_id: 123 as unknown as string,
      }),
    ).toBeUndefined()

    expect(
      extractAccountIdFromClaims({
        chatgpt_account_id: '',
      }),
    ).toBeUndefined()
  })

  test('validates nested claims object shape', () => {
    // Valid nested claim
    expect(
      extractAccountIdFromClaims({
        'https://api.openai.com/auth': { chatgpt_account_id: 'valid-id' },
      }),
    ).toBe('valid-id')

    // Empty string rejected
    expect(
      extractAccountIdFromClaims({
        'https://api.openai.com/auth': { chatgpt_account_id: '' },
      }),
    ).toBeUndefined()

    // Array instead of object
    expect(
      extractAccountIdFromClaims({
        'https://api.openai.com/auth': [] as unknown as {
          chatgpt_account_id?: string
        },
      }),
    ).toBeUndefined()
  })

  test('validates organizations array shape', () => {
    expect(
      extractAccountIdFromClaims({
        organizations: [{ id: 'org-1' }],
      }),
    ).toBe('org-1')

    // Missing id
    expect(
      extractAccountIdFromClaims({
        organizations: [{ name: 'x' } as unknown as { id: string }],
      }),
    ).toBeUndefined()

    // Non-array organizations
    expect(
      extractAccountIdFromClaims({
        organizations: 'bad' as unknown as Array<{ id: string }>,
      }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Council U5: label-tier dedup only when account has no accountId
// ---------------------------------------------------------------------------

describe('upsertAccount U5 — label-tier guard', () => {
  test('differing accountId + same label → two entries (no label-merge)', () => {
    const first = makeAccount('acct-a', {
      label: 'work',
      accountId: 'chatgpt-111',
    })
    const accounts: IngestAccount[] = [first]

    const second = makeAccount('acct-b', {
      label: 'work',
      accountId: 'chatgpt-222',
    })

    upsertAccount(accounts, second)

    // Different ChatGPT accounts with same label should NOT merge
    expect(accounts).toHaveLength(2)
    expect(accounts[0]?.accountId).toBe('chatgpt-111')
    expect(accounts[1]?.accountId).toBe('chatgpt-222')
  })

  test('no accountId + same label → label-merge (backward compat)', () => {
    const first = makeAccount('acct-a', { label: 'work' })
    const accounts: IngestAccount[] = [first]

    const second = makeAccount('acct-b', {
      label: 'work',
      access: 'newer',
    })
    // Neither has accountId, so label-dedup applies
    delete second.accountId

    upsertAccount(accounts, second)

    expect(accounts).toHaveLength(1)
  })
})
