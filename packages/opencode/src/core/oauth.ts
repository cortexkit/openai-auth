import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { PackageVersion } from '../version'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const ISSUER = 'https://auth.openai.com'
export const OAUTH_PORT = 1455
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
export const USER_AGENT = `cortexkit-opencode-openai-auth/${PackageVersion}`

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkceCodes {
  verifier: string
  challenge: string
}

export function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generatePKCE(): Promise<PkceCodes> {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join('')
  const challenge = base64UrlEncode(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  )
  return { verifier, challenge }
}

// ---------------------------------------------------------------------------
// JWT / account ID
// ---------------------------------------------------------------------------

export interface IdTokenClaims {
  chatgpt_account_id?: string
  email?: string
  organizations?: Array<{ id: string }>
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  if (token.length > 16384) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (!payload || payload.length > 8192) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(
  claims: IdTokenClaims,
): string | undefined {
  const direct = claims.chatgpt_account_id
  if (typeof direct === 'string' && direct.length > 0) return direct

  const nested = claims['https://api.openai.com/auth']
  if (
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    typeof nested.chatgpt_account_id === 'string' &&
    nested.chatgpt_account_id.length > 0
  ) {
    return nested.chatgpt_account_id
  }

  const orgs = claims.organizations
  if (Array.isArray(orgs)) {
    const first = orgs[0]
    if (
      first &&
      typeof first === 'object' &&
      !Array.isArray(first) &&
      typeof first.id === 'string' &&
      first.id.length > 0
    ) {
      return first.id
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// OAuth URL builder
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'opencode',
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>CortexKit OpenAI Auth - Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

export const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>CortexKit OpenAI Auth - Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${escapeHtml(error)}</div>
    </div>
  </body>
</html>`

// ---------------------------------------------------------------------------
// OAuth server (browser flow)
// ---------------------------------------------------------------------------

export interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let serverStarting:
  | Promise<{
      port: number
      redirectUri: string
    }>
  | undefined

/**
 * Map of in-flight OAuth flows, keyed by the opaque state parameter.
 * Multiple concurrent flows share the same loopback HTTP server;
 * each callback is routed to the correct flow via the state query param.
 */
const pendingFlows = new Map<string, PendingOAuth>()

function flowCount(): number {
  return pendingFlows.size
}

export function flowCleanup(state: string) {
  pendingFlows.delete(state)
  if (flowCount() === 0) {
    stopOAuthServer()
  }
}

export async function startOAuthServer(): Promise<{
  port: number
  redirectUri: string
}> {
  const redirectUri = `http://127.0.0.1:${OAUTH_PORT}/auth/callback`
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri }
  }
  if (serverStarting) return serverStarting

  serverStarting = (async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${OAUTH_PORT}`)

      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const errorDescription = url.searchParams.get('error_description')

        if (error) {
          const errorMsg = errorDescription || error
          if (state) {
            const entry = pendingFlows.get(state)
            if (entry) {
              entry.reject(new Error(errorMsg))
              flowCleanup(state)
            } else if (flowCount() === 0) {
              stopOAuthServer()
            }
          } else if (flowCount() === 0) {
            stopOAuthServer()
          }
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(HTML_ERROR(errorMsg))
          return
        }

        if (!code || !state) {
          const errorMsg = !code
            ? 'Missing authorization code'
            : 'Missing state parameter'
          if (state) {
            const entry = pendingFlows.get(state)
            if (entry) {
              entry.reject(new Error(errorMsg))
              flowCleanup(state)
            } else if (flowCount() === 0) {
              stopOAuthServer()
            }
          } else if (flowCount() === 0) {
            stopOAuthServer()
          }
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(HTML_ERROR(errorMsg))
          return
        }

        const entry = pendingFlows.get(state)
        if (!entry) {
          // Unknown state does not match an in-flight login; close an idle listener.
          const errorMsg = 'Unknown state — authorization may have expired'
          if (flowCount() === 0) stopOAuthServer()
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(HTML_ERROR(errorMsg))
          return
        }

        flowCleanup(state)

        exchangeCodeForTokens(code, redirectUri, entry.pkce)
          .then((tokens) => entry.resolve(tokens))
          .catch((err) => entry.reject(err))

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(HTML_SUCCESS)
        return
      }

      if (url.pathname === '/cancel') {
        const state = url.searchParams.get('state')
        const states = state ? [state] : [...pendingFlows.keys()]
        res.writeHead(200)
        res.end('Login cancelled')
        for (const flowState of states) {
          const entry = pendingFlows.get(flowState)
          if (!entry) continue
          entry.reject(new Error('Login cancelled'))
          flowCleanup(flowState)
        }
        if (flowCount() === 0) stopOAuthServer()
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(OAUTH_PORT, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    // Assign only after listen succeeds so a failed bind can be retried cleanly.
    oauthServer = server

    return { port: OAUTH_PORT, redirectUri }
  })()

  try {
    return await serverStarting
  } finally {
    serverStarting = undefined
  }
}

export function stopOAuthServer() {
  if (oauthServer) {
    const server = oauthServer
    oauthServer = undefined
    server.close(() => {})
    server.closeIdleConnections?.()
    const closeConnections = setTimeout(() => {
      server.closeAllConnections?.()
    }, 25)
    closeConnections.unref?.()
  }
}

export function resetOAuthStateForTest() {
  pendingFlows.clear()
  stopOAuthServer()
}

export function waitForOAuthCallback(
  pkce: PkceCodes,
  state: string,
  timeoutMs = 5 * 60 * 1000,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      flowCleanup(state)
      reject(new Error('Login cancelled'))
      return
    }

    const timeout = setTimeout(() => {
      const entry = pendingFlows.get(state)
      if (entry) {
        flowCleanup(state)
        reject(
          new Error('OAuth callback timeout — authorization took too long'),
        )
      }
    }, timeoutMs)

    const onAbort = () => {
      clearTimeout(timeout)
      const entry = pendingFlows.get(state)
      if (entry) {
        flowCleanup(state)
        reject(new Error('Login cancelled'))
      }
    }

    if (signal) {
      signal.addEventListener('abort', onAbort)
    }

    pendingFlows.set(state, {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
        reject(error)
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Device code flow (headless)
// ---------------------------------------------------------------------------

export interface DeviceAuthInit {
  device_auth_id: string
  user_code: string
  interval: string
  expires_in?: number | string
}

export async function beginDeviceAuth(): Promise<{
  deviceData: DeviceAuthInit
  url: string
  instructions: string
}> {
  const deviceResponse = await fetch(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    },
  )

  if (!deviceResponse.ok)
    throw new Error('Failed to initiate device authorization')

  const deviceData = (await deviceResponse.json()) as DeviceAuthInit

  return {
    deviceData,
    url: `${ISSUER}/codex/device`,
    instructions: `Enter code: ${deviceData.user_code}`,
  }
}

export async function completeDeviceAuth(
  deviceData: DeviceAuthInit,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const interval = Math.max(parseInt(deviceData.interval, 10) || 5, 1) * 1000
  const expires_in =
    typeof deviceData.expires_in === 'number'
      ? deviceData.expires_in
      : parseInt(deviceData.expires_in || '', 10)
  const maxDurationMs =
    !Number.isNaN(expires_in) && expires_in > 0
      ? expires_in * 1000
      : 15 * 60 * 1000 // default 15 minutes
  const startTime = Date.now()

  while (true) {
    if (signal?.aborted) {
      throw new Error('Device authorization cancelled')
    }
    if (Date.now() - startTime > maxDurationMs) {
      throw new Error('Device authorization expired')
    }

    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    })

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string
        code_verifier: string
      }

      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      })

      if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed: ${tokenResponse.status}`)
      }

      return (await tokenResponse.json()) as TokenResponse
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device authorization failed: ${response.status}`)
    }

    const remainingMs = maxDurationMs - (Date.now() - startTime)
    if (remainingMs <= 0) {
      throw new Error('Device authorization expired')
    }
    const sleepMs = Math.min(
      interval + OAUTH_POLLING_SAFETY_MARGIN_MS,
      remainingMs,
    )
    try {
      await sleep(sleepMs, undefined, { signal })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Device authorization cancelled')
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Shared ingestion core
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a fallback OAuth account for ingestion. Matches the
 * fields used by upsertAccount and beginAccountLogin, compatible with
 * the full OAuthAccount type in accounts.ts.
 */
export interface IngestAccount {
  id: string
  label?: string
  type: 'oauth'
  access?: string
  refresh: string
  expires?: number
  enabled: boolean
  addedAt: number
  lastUsed: number
  /**
   * When the token was obtained. Stamped at login so a freshly added account
   * carries a refresh marker — without it, the runtime-state merge cannot tell a
   * rotated token from a stale one (both default to 0) and a concurrent stale
   * save could roll the token back.
   */
  lastRefreshedAt?: number
  /** Stable ChatGPT account identifier from the OAuth token claims. */
  accountId?: string
}

export interface AccountStorageLike {
  version: 1
  mainAccountId?: string
  accounts: IngestAccount[]
}

/**
 * Dedup by stable accountId first (strongest signal — same ChatGPT account
 * added twice with different labels must merge), then by id, then by label.
 * If found, merge-update preserving addedAt. Otherwise push.
 * Re-running `add --label work` is idempotent.
 *
 * Accepts the accounts array directly (not the whole storage object) to
 * avoid coupling to any particular storage shape.
 */
export function upsertAccount<
  T extends {
    id: string
    label?: string
    accountId?: string
    addedAt?: number
  },
>(accounts: T[], account: T): number {
  let index = -1

  // Strongest: dedup by stable ChatGPT accountId
  if (account.accountId) {
    index = accounts.findIndex(
      (candidate) =>
        candidate.accountId && candidate.accountId === account.accountId,
    )
  }

  // Fallback: dedup by id
  if (index < 0) {
    index = accounts.findIndex((candidate) => candidate.id === account.id)
  }

  // Last resort: dedup by label (only when the incoming account has no
  // stable accountId — if we know the identity, label-dedup could silently
  // merge over a different ChatGPT account).
  if (index < 0 && account.label && !account.accountId) {
    index = accounts.findIndex((candidate) => candidate.label === account.label)
  }

  if (index >= 0) {
    accounts[index] = {
      ...accounts[index],
      ...account,
      addedAt: accounts[index]?.addedAt ?? account.addedAt,
    }
    return index
  }
  accounts.push(account)
  return accounts.length - 1
}

export interface BeginAccountLoginOptions {
  label?: string
  headless?: boolean
  signal?: AbortSignal
}

export interface BeginAccountLoginResult {
  url: string
  instructions: string
  /** Resolves after the user completes the OAuth flow with a ready-to-ingest account. */
  completion: Promise<IngestAccount>
}

/**
 * Split-return OAuth flow entry point.
 *
 * Browser flow (default):
 *   1. Start OAuth server, generate PKCE, build authorize URL
 *   2. Return { url, instructions, completion } — url is ready immediately
 *   3. completion resolves after browser callback + token exchange
 *
 * Headless flow:
 *   1. Begin device auth
 *   2. Return { url, instructions, completion }
 *   3. completion polls device endpoint + exchanges for tokens
 *
 * The split return allows the TUI command to show the URL before the
 * (potentially 30-60s) wait, avoiding a deadlock.
 */
export async function beginAccountLogin(
  opts: BeginAccountLoginOptions = {},
): Promise<BeginAccountLoginResult> {
  const { label, headless = false, signal } = opts

  if (headless) {
    const { deviceData, url, instructions } = await beginDeviceAuth()

    const completion = (async (): Promise<IngestAccount> => {
      const tokens = await completeDeviceAuth(deviceData, signal)
      const now = Date.now()
      return {
        id: label || extractAccountId(tokens) || crypto.randomUUID(),
        label: label || undefined,
        type: 'oauth',
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: now + (tokens.expires_in ?? 3600) * 1000,
        enabled: true,
        addedAt: now,
        lastUsed: now,
        lastRefreshedAt: now,
        accountId: extractAccountId(tokens),
      }
    })()

    return { url, instructions, completion }
  }

  // Browser flow
  const { redirectUri } = await startOAuthServer()
  const pkce = await generatePKCE()
  const state = base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(32)).buffer,
  )
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

  const completion = (async (): Promise<IngestAccount> => {
    try {
      if (signal?.aborted) {
        throw new Error('Login cancelled')
      }
      const tokens = await waitForOAuthCallback(pkce, state, undefined, signal)
      const now = Date.now()
      return {
        id: label || extractAccountId(tokens) || crypto.randomUUID(),
        label: label || undefined,
        type: 'oauth',
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: now + (tokens.expires_in ?? 3600) * 1000,
        enabled: true,
        addedAt: now,
        lastUsed: now,
        lastRefreshedAt: now,
        accountId: extractAccountId(tokens),
      }
    } finally {
      // Clean up this flow's entry. The shared server is stopped only when
      // no other flow is still in flight.
      flowCleanup(state)
    }
  })()

  return {
    url: authUrl,
    instructions:
      'Complete authorization in your browser. This window will close automatically.',
    completion,
  }
}
