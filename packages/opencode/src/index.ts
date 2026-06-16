import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'

import { getConfigDir, getSettings } from './config'
import { DUMP_SESSION_HEADER, dumpCodexRequest } from './dump'
import { isRecord } from './util/record'
import { stableStringify } from './util/stable-json'
import { uuidV7 } from './util/uuid-v7'
import { PackageVersion } from './version'
import { OpenAIWebSocketPool } from './ws-pool'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const ALLOWED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
])
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key'
const USER_AGENT = `cortexkit-opencode-openai-auth/${PackageVersion}`
const CODEX_BETA_FEATURES = 'terminal_resize_reflow'
const CODEX_VERSION = '0.139.0'
const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
const CODEX_SANDBOX = 'seccomp'

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
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

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (!payload) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(
  claims: IdTokenClaims,
): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
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

function buildAuthorizeUrl(
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

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface CodexAuthPluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
}

interface CodexSessionMetadata {
  threadID: string
  turnID: string
  windowID: string
  turnStartedAt?: number
  input?: unknown[]
}

interface PersistedCodexSessions {
  version?: number
  sessions?: Record<string, { threadID?: unknown }>
}

interface PreparedCodexRequest {
  init: RequestInit | undefined
}

function parseJsonObject(input: unknown) {
  if (typeof input !== 'string') return undefined
  try {
    const parsed = JSON.parse(input)
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// Real Codex mints the session/thread id (which becomes prompt_cache_key,
// session-id, thread-id, x-client-request-id, window_id) as a UUIDv7 — a
// time-ordered id whose first 48 bits are the unix-ms timestamp. crypto.randomUUID()
// only produces UUIDv4 (uniform random). OpenAI's prompt_cache_key is a routing
// hint; matching Codex's v7 shape exactly removes the only remaining wire-level
// difference from the Codex client when probing prompt-cache routing behavior.
function getCodexSessionMetadata(
  sessions: Map<string, CodexSessionMetadata>,
  sessionID: string,
  persist?: () => void,
): CodexSessionMetadata {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const threadID = uuidV7()
  const next: CodexSessionMetadata = {
    threadID,
    turnID: uuidV7(),
    windowID: `${threadID}:0`,
  }
  sessions.set(sessionID, next)
  persist?.()
  return next
}

function codexSessionStatePath() {
  return join(getConfigDir(), 'openai-auth-sessions.json')
}

function loadCodexSessions(): Map<string, CodexSessionMetadata> {
  const sessions = new Map<string, CodexSessionMetadata>()
  try {
    const parsed = JSON.parse(
      readFileSync(codexSessionStatePath(), 'utf8'),
    ) as PersistedCodexSessions
    if (!isRecord(parsed.sessions)) return sessions
    for (const [sessionID, state] of Object.entries(parsed.sessions)) {
      if (!isRecord(state) || typeof state.threadID !== 'string') continue
      sessions.set(sessionID, {
        threadID: state.threadID,
        turnID: uuidV7(),
        windowID: `${state.threadID}:0`,
      })
    }
  } catch {
    // Missing or malformed state should not break auth.
  }
  return sessions
}

function saveCodexSessions(sessions: Map<string, CodexSessionMetadata>): void {
  const path = codexSessionStatePath()
  const tmp = `${path}.tmp-${process.pid}`
  try {
    mkdirSync(getConfigDir(), { recursive: true })
    const payload: PersistedCodexSessions = {
      version: 1,
      sessions: Object.fromEntries(
        [...sessions.entries()].map(([sessionID, state]) => [
          sessionID,
          { threadID: state.threadID },
        ]),
      ),
    }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // State persistence only improves cache continuity; never fail a request.
  }
}

function isMessageWithRole(item: unknown, role: string) {
  return (
    isRecord(item) &&
    (item.type === 'message' || 'role' in item) &&
    item.role === role
  )
}

function hasInputPrefix(prefix: unknown[], input: unknown[]) {
  if (prefix.length > input.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index]))
      return false
  }
  return true
}

function startsHttpUserTurn(metadata: CodexSessionMetadata, input: unknown[]) {
  if (!metadata.input) return input.length > 0
  if (!hasInputPrefix(metadata.input, input)) return true
  const suffix = input.slice(metadata.input.length)
  return suffix.some(
    (item) =>
      isMessageWithRole(item, 'user') || isMessageWithRole(item, 'developer'),
  )
}

function updateHttpTurnMetadata(
  metadata: CodexSessionMetadata,
  body: Record<string, unknown> | undefined,
) {
  const input = Array.isArray(body?.input) ? body.input : undefined
  if (input && (startsHttpUserTurn(metadata, input) || !metadata.turnID)) {
    metadata.turnID = uuidV7()
    metadata.turnStartedAt = Date.now()
  } else if (!metadata.turnStartedAt) {
    metadata.turnStartedAt = Date.now()
  }
  if (input) metadata.input = input
}

function prepareCodexRequest(input: {
  init: RequestInit | undefined
  headers: Headers
  metadata: CodexSessionMetadata | undefined
  installationID: string
  websocket: boolean
  dumpSessionID?: string
}): PreparedCodexRequest {
  if (!input.metadata) return { init: input.init }
  const body = parseJsonObject(input.init?.body)
  if (!input.websocket) updateHttpTurnMetadata(input.metadata, body)
  else if (!input.metadata.turnStartedAt)
    input.metadata.turnStartedAt = Date.now()
  if (!input.metadata.turnStartedAt) input.metadata.turnStartedAt = Date.now()
  // Base turn-metadata. HTTP sends full replay bodies, so we detect fresh user turns from append-only
  // input growth above. The WebSocket path still overrides turn_id/turn_started_at in ws-pool.ts
  // after continuation trimming/prewarm selection.
  // Codex turn-metadata schema (exact field set + order; no request_id/originator):
  // { session_id, thread_id, thread_source, turn_id, sandbox, turn_started_at_unix_ms, request_kind, window_id }
  const turnMetadata = JSON.stringify({
    session_id: input.metadata.threadID,
    thread_id: input.metadata.threadID,
    thread_source: 'user',
    turn_id: input.metadata.turnID,
    sandbox: CODEX_SANDBOX,
    turn_started_at_unix_ms: input.metadata.turnStartedAt,
    request_kind: 'turn',
    window_id: input.metadata.windowID,
  })
  input.headers.set('originator', 'codex_exec')
  if (input.websocket) {
    // Codex's WebSocket upgrade carries neither Accept nor Content-Type.
    input.headers.delete('accept')
    input.headers.delete('content-type')
  } else {
    input.headers.set('accept', 'text/event-stream')
  }
  input.headers.set('session-id', input.metadata.threadID)
  input.headers.delete('x-session-id')
  input.headers.delete('x-session-affinity')
  input.headers.set('thread-id', input.metadata.threadID)
  input.headers.set('x-codex-window-id', input.metadata.windowID)
  // Codex uses the session/thread UUID as x-client-request-id (not a fresh per-request id).
  input.headers.set('x-client-request-id', input.metadata.threadID)
  input.headers.set('x-codex-beta-features', CODEX_BETA_FEATURES)
  input.headers.set('x-codex-turn-metadata', turnMetadata)
  input.headers.set('user-agent', CODEX_USER_AGENT)
  input.headers.set('version', CODEX_VERSION)
  if (input.dumpSessionID)
    input.headers.set(DUMP_SESSION_HEADER, input.dumpSessionID)

  const parsed = body
  if (!parsed) return { init: input.init }
  parsed.prompt_cache_key = input.metadata.threadID
  parsed.parallel_tool_calls ??= true
  if (Array.isArray(parsed.tools))
    parsed.tools = parsed.tools.map(normalizeCodexTool)
  maybeInjectCacheStabilizerTool(parsed)
  maybeInjectImageGenerationTool(parsed)
  const clientMetadata: Record<string, unknown> = {
    ...(typeof parsed.client_metadata === 'object' &&
    parsed.client_metadata !== null
      ? parsed.client_metadata
      : {}),
    'x-codex-installation-id': input.installationID,
    'x-codex-window-id': input.metadata.windowID,
  }
  if (input.websocket) {
    clientMetadata['x-codex-turn-metadata'] = turnMetadata
    clientMetadata['x-codex-ws-stream-request-start-ms'] = String(Date.now())
  }
  parsed.client_metadata = clientMetadata
  input.headers.delete('content-length')
  input.headers.delete('Content-Length')
  return { init: { ...input.init, body: JSON.stringify(parsed) } }
}

// Prompt-cache stabilizer (ON by default; opt out via config `webSearch: false` or
// CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH=1 — env wins over config).
//
// The Codex `responses` backend only puts a request on the STABLE prompt-cache path when its
// `tools` array carries an OpenAI-native tool type. OpenCode declares only custom `function`
// tools, so its tool-continuation requests land on a flaky best-effort cache and intermittently
// drop cached_tokens to 0 ("cliffs"). We append a single native `web_search` tool to flip every
// tool-bearing request onto the stable cache path.
//
// Evidence: standalone Bun mimic (size-controlled 24000c prefix) — +web_search 10.6%->0% cliffs;
// image_generation (8.3%) and tool_search (4.5%) do NOT fully fix it, so it is web_search-specific.
// End-to-end in real OpenCode (no-AFT, same-session A/B): control 20% cliffs (10/50) -> 0% (0/42),
// and 0% on native WS too (0/49) — the fix is transport-independent. The stabilizer also
// ~doubles the steady cached prefix (~3-5.6k -> ~8-10k tokens), so it is a net cost win.
//
// web_search executes server-side, so a model invocation would run a real OpenAI web search, but
// across the end-to-end runs the model never once invoked it on a coding task (websearch_calls=0).
// Only injected when the request already carries tools (agentic turns); empty/tool-less requests
// have no continuation cliff to fix and are left untouched.
function maybeInjectCacheStabilizerTool(parsed: Record<string, unknown>) {
  if (!getSettings().webSearch) return
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return
  if (parsed.tools.some((t) => isRecord(t) && t.type === 'web_search')) return
  parsed.tools = [
    ...parsed.tools,
    {
      type: 'web_search',
      external_web_access: true,
      search_content_types: ['text', 'image'],
    },
  ]
}

// Optional native image generation (opt-in via config `imageGeneration: true` or
// CORTEXKIT_OPENAI_AUTH_IMAGE_GENERATION=1 — env wins over config).
//
// Declares Codex's native `image_generation` tool so the model can produce images. This is a
// FEATURE knob, not the cache fix — image_generation does NOT stabilize the prompt cache (mimic:
// +image_generation = 8.3% cliffs, no help; web_search is the cache lever). It is server-executed:
// when invoked, OpenAI generates the image and returns `image_generation_call` items + partial_image
// events on the wire, which the plugin currently forwards verbatim to OpenCode's parser. Rendering/
// saving the resulting PNG is a separate, still-unverified piece — keep this opt-in until the
// end-to-end image round-trip through OpenCode is confirmed.
function maybeInjectImageGenerationTool(parsed: Record<string, unknown>) {
  if (!getSettings().imageGeneration) return
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return
  if (parsed.tools.some((t) => isRecord(t) && t.type === 'image_generation'))
    return
  parsed.tools = [
    ...parsed.tools,
    { type: 'image_generation', output_format: 'png' },
  ]
}

// Match Codex's function-tool shape: drop the JSON-Schema `$schema` dialect marker
// (Codex omits it) and mark function tools `strict: false` as Codex does.
function normalizeCodexTool(tool: unknown) {
  if (!isRecord(tool)) return tool
  if (tool.type !== 'function') return tool
  const parameters =
    isRecord(tool.parameters) && '$schema' in tool.parameters
      ? (() => {
          const { $schema: _schema, ...rest } = tool.parameters as Record<
            string,
            unknown
          >
          return rest
        })()
      : tool.parameters
  // Codex function-tool key order: type, name, description, strict, parameters (+ any extras).
  const { type, name, description, strict, parameters: _p, ...extra } = tool
  return {
    type,
    name,
    description,
    strict: strict ?? false,
    parameters,
    ...extra,
  }
}

async function exchangeCodeForTokens(
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

async function refreshAccessToken(
  refreshToken: string,
  issuer = ISSUER,
): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

const HTML_SUCCESS = `<!doctype html>
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const HTML_ERROR = (error: string) => `<!doctype html>
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

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{
  port: number
  redirectUri: string
}> {
  if (oauthServer) {
    return {
      port: OAUTH_PORT,
      redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback`,
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = 'Missing authorization code'
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = 'Invalid state - potential CSRF attack'
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(
        code,
        `http://localhost:${OAUTH_PORT}/auth/callback`,
        current.pkce,
      )
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(HTML_SUCCESS)
      return
    }

    if (url.pathname === '/cancel') {
      pendingOAuth?.reject(new Error('Login cancelled'))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end('Login cancelled')
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  oauthServer = server

  await new Promise<void>((resolve, reject) => {
    server.listen(OAUTH_PORT, () => {
      resolve()
    })
    server.on('error', reject)
  })

  return {
    port: OAUTH_PORT,
    redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback`,
  }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {})
    oauthServer = undefined
  }
}

function waitForOAuthCallback(
  pkce: PkceCodes,
  state: string,
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(
            new Error('OAuth callback timeout - authorization took too long'),
          )
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function CodexAuthPlugin(
  input: PluginInput,
  options: CodexAuthPluginOptions = {},
): Promise<Hooks> {
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  const installationID = crypto.randomUUID()
  const codexSessions = loadCodexSessions()
  const persistCodexSessions = () => saveCodexSessions(codexSessions)
  let websocketFetchInstalled = false
  const websocketFetches: Array<
    ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>
  > = []

  return {
    async dispose() {
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
    },
    async event(input) {
      if (input.event.type !== 'session.deleted') return
      if (codexSessions.delete(input.event.properties.info.id))
        persistCodexSessions()
      for (const websocketFetch of websocketFetches)
        websocketFetch.remove(input.event.properties.info.id)
    },
    provider: {
      id: 'openai',
      async models(provider, ctx) {
        if (ctx.auth?.type !== 'oauth') return provider.models

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (ALLOWED_MODELS.has(model.api.id)) return true
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
              const version = match?.[1]
              return version ? parseFloat(version) > 5.4 : false
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: {
                  input: 0,
                  output: 0,
                  cache: { read: 0, write: 0 },
                },
                limit: model.id.includes('gpt-5.5')
                  ? {
                      context: 400_000,
                      input: 272_000,
                      output: 128_000,
                    }
                  : model.limit,
              },
            ]),
        )
      },
    },
    auth: {
      provider: 'openai',
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== 'oauth') return {}

        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({
              httpFetch: fetch,
              rawWebSocket: getSettings().rawWebSocket,
            })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }

        let refreshPromise:
          | Promise<{
              access: string
              accountId: string | undefined
            }>
          | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== 'oauth') return fetch(requestInput, init)

            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete('authorization')
                init.headers.delete('Authorization')
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => String(key).toLowerCase() !== 'authorization',
                )
              } else {
                delete init.headers.authorization
                delete init.headers.Authorization
              }
            }

            const authWithAccount = currentAuth as typeof currentAuth & {
              accountId?: string
            }

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(currentAuth.refresh, issuer)
                  .then(async (tokens) => {
                    const accountId =
                      extractAccountId(tokens) || authWithAccount.accountId
                    await input.client.auth.set({
                      path: { id: 'openai' },
                      body: {
                        type: 'oauth',
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires:
                          Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        ...(accountId && { accountId }),
                      },
                    })
                    return {
                      access: tokens.access_token,
                      accountId,
                    }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }

              const refreshed = await refreshPromise
              currentAuth.access = refreshed.access
              authWithAccount.accountId = refreshed.accountId
            }

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => {
                  headers.set(key, value)
                })
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }
            headers.set('authorization', `Bearer ${currentAuth.access}`)
            if (authWithAccount.accountId) {
              headers.set('ChatGPT-Account-Id', authWithAccount.accountId)
            }
            const sessionID =
              headers.get('x-session-affinity') ??
              headers.get('x-session-id') ??
              headers.get('session-id') ??
              undefined
            const codexMetadata = sessionID
              ? getCodexSessionMetadata(
                  codexSessions,
                  sessionID,
                  persistCodexSessions,
                )
              : undefined

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(
                    typeof requestInput === 'string'
                      ? requestInput
                      : requestInput.url,
                  )
            const url =
              parsed.pathname.includes('/v1/responses') ||
              parsed.pathname.includes('/chat/completions')
                ? new URL(codexApiEndpoint)
                : parsed

            const prepared = prepareCodexRequest({
              init: {
                ...init,
                headers,
              },
              headers,
              metadata: codexMetadata,
              installationID,
              websocket: Boolean(
                websocketFetch && parsed.pathname.endsWith('/responses'),
              ),
              dumpSessionID: sessionID,
            })
            const requestInit = prepared.init
            if (websocketFetch && parsed.pathname.endsWith('/responses'))
              return websocketFetch(url, requestInit)
            const finalInit =
              OpenAIWebSocketPool.withoutInternalHeaders(requestInit)
            if (typeof finalInit?.body !== 'string')
              return fetch(url, finalInit)
            try {
              const response = await fetch(url, finalInit)
              await dumpCodexRequest({
                sessionID,
                transport: 'http',
                phase: 'http',
                bodyText: finalInit.body,
                url: url.toString(),
                method: finalInit.method,
                headers: finalInit.headers,
                status: response.status,
              })
              return response
            } catch (error) {
              await dumpCodexRequest({
                sessionID,
                transport: 'http',
                phase: 'http',
                bodyText: finalInit.body,
                url: url.toString(),
                method: finalInit.method,
                headers: finalInit.headers,
                error: error instanceof Error ? error.message : String(error),
              })
              throw error
            }
          },
        }
      },
      methods: [
        {
          label: 'ChatGPT Pro/Plus (browser)',
          type: 'oauth',
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = base64UrlEncode(
              crypto.getRandomValues(new Uint8Array(32)).buffer,
            )
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions:
                'Complete authorization in your browser. This window will close automatically.',
              method: 'auto' as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: 'success' as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                }
              },
            }
          },
        },
        {
          label: 'ChatGPT Pro/Plus (headless)',
          type: 'oauth',
          authorize: async () => {
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

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval =
              Math.max(parseInt(deviceData.interval, 10) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: 'auto' as const,
              async callback() {
                while (true) {
                  const response = await fetch(
                    `${ISSUER}/api/accounts/deviceauth/token`,
                    {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': USER_AGENT,
                      },
                      body: JSON.stringify({
                        device_auth_id: deviceData.device_auth_id,
                        user_code: deviceData.user_code,
                      }),
                    },
                  )

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
                      throw new Error(
                        `Token exchange failed: ${tokenResponse.status}`,
                      )
                    }

                    const tokens = (await tokenResponse.json()) as TokenResponse

                    return {
                      type: 'success' as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: 'failed' as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      output.headers.originator = 'opencode'
      output.headers['User-Agent'] =
        `${USER_AGENT} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers['session-id'] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === 'title')
        output.headers[OpenAIWebSocketPool.TITLE_HEADER] = 'true'
    },
    'chat.params': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}

export const OpenAIAuthPlugin: Plugin = async (input) =>
  CodexAuthPlugin(input, { experimentalWebSockets: getSettings().webSockets })

export default {
  id: 'cortexkit-openai-auth',
  server: OpenAIAuthPlugin,
}
