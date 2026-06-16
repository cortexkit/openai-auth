import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import os from "node:os"
import { appendFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { createServer } from "http"
import { OpenAIWebSocketPool } from "./ws-pool"
import { PackageVersion } from "./version"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const ALLOWED_MODELS = new Set(["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"])
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"
const USER_AGENT = `cortexkit-opencode-openai-auth/${PackageVersion}`
const DEFAULT_MIN_CODEX_HTTP_RESPONSE_GAP_MS = 0
const CODEX_BETA_FEATURES = "terminal_resize_reflow"
const CODEX_VERSION = "0.139.0"
const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
const CODEX_SANDBOX = "seccomp"
// CORTEXKIT_OPENAI_AUTH_RETEST8_SHAPE=1: reproduce retest8's exact HTTP request shape (pre-WS-work)
// to test whether codex-identity changes we added during WS testing regressed the HTTP cache path.
const RETEST8_SHAPE = !!process.env.CORTEXKIT_OPENAI_AUTH_RETEST8_SHAPE
function cryptoRandomUUID(): string {
  return (globalThis.crypto as Crypto).randomUUID()
}
// Optional request self-log (CORTEXKIT_OPENAI_AUTH_REQ_LOG=path): one JSON line per outbound
// codex/responses request with its on-wire headers + body-shape, so a run can self-verify the
// request shape without a MITM proxy.
function logCodexRequest(headers: Headers, body: Record<string, unknown> | undefined) {
  const p = process.env.CORTEXKIT_OPENAI_AUTH_REQ_LOG
  if (!p || !body) return
  try {
    const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : []
    const hdr: Record<string, string> = {}
    headers.forEach((v, k) => {
      if (k.toLowerCase() === "authorization") return
      hdr[k] = v
    })
    appendFileSync(
      p,
      JSON.stringify({
        t: Date.now(),
        headers: hdr,
        bodyKeys: Object.keys(body),
        store: body.store,
        nInput: Array.isArray(body.input) ? body.input.length : undefined,
        tool0Keys: tools[0] ? Object.keys(tools[0]) : [],
        tool0HasSchema: tools[0] ? "$schema" in ((tools[0].parameters as Record<string, unknown>) || {}) : undefined,
        tool0Strict: tools[0]?.strict,
        toolTypes: [...new Set(tools.map((t) => t.type))],
      }) + "\n",
    )
  } catch {}
}

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
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

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
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
  lastResponseCompletedAt?: number
  /** True once the codex_thread_initialized ping has been sent for this session. */
  threadInitialized?: boolean
  /** Cloudflare affinity cookies (`__cflb`/`__cf_bm`/`_cfuvid`) captured from the
   *  thread-init response, replayed on subsequent requests to pin the edge/origin. */
  affinityCookie?: string
}

interface PreparedCodexRequest {
  init: RequestInit | undefined
}

function parseJsonObject(input: unknown) {
  if (typeof input !== "string") return undefined
  try {
    const parsed = JSON.parse(input)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Real Codex mints the session/thread id (which becomes prompt_cache_key,
// session-id, thread-id, x-client-request-id, window_id) as a UUIDv7 — a
// time-ordered id whose first 48 bits are the unix-ms timestamp. crypto.randomUUID()
// only produces UUIDv4 (uniform random). OpenAI's prompt_cache_key is a routing
// hint; matching Codex's v7 shape exactly removes the only remaining wire-level
// difference from the Codex client when probing prompt-cache routing behavior.
function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const ms = Date.now()
  // 48-bit big-endian millisecond timestamp
  bytes[0] = (ms / 2 ** 40) & 0xff
  bytes[1] = (ms / 2 ** 32) & 0xff
  bytes[2] = (ms / 2 ** 24) & 0xff
  bytes[3] = (ms / 2 ** 16) & 0xff
  bytes[4] = (ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff
  // version 7 in the high nibble of byte 6
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  // RFC 4122 variant (10xx) in the high bits of byte 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function getCodexSessionMetadata(
  sessions: Map<string, CodexSessionMetadata>,
  sessionID: string,
): CodexSessionMetadata {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const threadID = uuidV7()
  const next: CodexSessionMetadata = { threadID, turnID: crypto.randomUUID(), windowID: `${threadID}:0` }
  sessions.set(sessionID, next)
  return next
}

function prepareCodexRequest(input: {
  init: RequestInit | undefined
  headers: Headers
  metadata: CodexSessionMetadata | undefined
  installationID: string
  websocket: boolean
}): PreparedCodexRequest {
  if (!input.metadata) return { init: input.init }
  const body = parseJsonObject(input.init?.body)
  if (!input.metadata.turnStartedAt) input.metadata.turnStartedAt = Date.now()
  // Base turn-metadata. NOTE: for the WebSocket path, ws-pool.ts overrides turn_id/turn_started_at
  // per *actual* turn (it alone sees the post-continuation-trim input). Codex keeps ONE turn_id +
  // turn_started_at across a user turn's whole tool-loop; deciding that here is impossible because
  // OpenCode's untrimmed body always still contains the user message.
  // Codex turn-metadata schema (exact field set + order; no request_id/originator):
  // { session_id, thread_id, thread_source, turn_id, sandbox, turn_started_at_unix_ms, request_kind, window_id }
  // RETEST8_SHAPE: reproduce the EXACT request shape from the retest8 HTTP run (which measured
  // 0 cliffs without web_search), to test whether a change we made during WS testing regressed
  // the HTTP cache path. Differences from current: SDK default User-Agent (no codex UA / no
  // `version` header), fresh-per-request x-client-request-id (= request_id), the older
  // turn-metadata schema {session_id, request_id, request_kind, thread_id, thread_source,
  // turn_id, window_id, originator}, and NO tool normalization ($schema kept, no strict).
  const perRequestId = RETEST8_SHAPE ? cryptoRandomUUID() : undefined
  const turnMetadata = RETEST8_SHAPE
    ? JSON.stringify({
        session_id: input.metadata.threadID,
        request_id: perRequestId,
        request_kind: "turn",
        thread_id: input.metadata.threadID,
        thread_source: "user",
        turn_id: input.metadata.turnID,
        window_id: input.metadata.windowID,
        originator: "codex_exec",
      })
    : JSON.stringify({
        session_id: input.metadata.threadID,
        thread_id: input.metadata.threadID,
        thread_source: "user",
        turn_id: input.metadata.turnID,
        sandbox: CODEX_SANDBOX,
        turn_started_at_unix_ms: input.metadata.turnStartedAt,
        request_kind: "turn",
        window_id: input.metadata.windowID,
      })
  input.headers.set("originator", "codex_exec")
  if (input.websocket) {
    // Codex's WebSocket upgrade carries neither Accept nor Content-Type.
    input.headers.delete("accept")
    input.headers.delete("content-type")
  } else {
    input.headers.set("accept", "text/event-stream")
  }
  input.headers.set("session-id", input.metadata.threadID)
  input.headers.delete("x-session-id")
  input.headers.delete("x-session-affinity")
  input.headers.set("thread-id", input.metadata.threadID)
  input.headers.set("x-codex-window-id", input.metadata.windowID)
  input.headers.set("x-codex-beta-features", CODEX_BETA_FEATURES)
  input.headers.set("x-codex-turn-metadata", turnMetadata)
  if (RETEST8_SHAPE) {
    // retest8: fresh per-request id (matches request_id), SDK default UA, no `version` header.
    input.headers.set("x-client-request-id", perRequestId!)
    input.headers.delete("version")
  } else {
    // Codex uses the session/thread UUID as x-client-request-id (not a fresh per-request id).
    input.headers.set("x-client-request-id", input.metadata.threadID)
    input.headers.set("user-agent", CODEX_USER_AGENT)
    input.headers.set("version", CODEX_VERSION)
  }

  const parsed = body
  if (!parsed) return { init: input.init }
  parsed.prompt_cache_key = input.metadata.threadID
  parsed.parallel_tool_calls ??= true
  // retest8 sent tools UNNORMALIZED ($schema present, no `strict`). Skip normalization in that mode.
  if (Array.isArray(parsed.tools) && !RETEST8_SHAPE) parsed.tools = parsed.tools.map(normalizeCodexTool)
  maybeInjectCacheStabilizerTool(parsed)
  maybeInjectImageGenerationTool(parsed)
  const clientMetadata: Record<string, unknown> = {
    ...(typeof parsed.client_metadata === "object" && parsed.client_metadata !== null ? parsed.client_metadata : {}),
    "x-codex-installation-id": input.installationID,
    "x-codex-window-id": input.metadata.windowID,
  }
  if (input.websocket) {
    clientMetadata["x-codex-turn-metadata"] = turnMetadata
    clientMetadata["x-codex-ws-stream-request-start-ms"] = String(Date.now())
  }
  parsed.client_metadata = clientMetadata
  input.headers.delete("content-length")
  input.headers.delete("Content-Length")
  logCodexRequest(input.headers, parsed)
  return { init: { ...input.init, body: JSON.stringify(parsed) } }
}

// Prompt-cache stabilizer (ON by default; opt out with CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH=1).
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
// and 0% on native Bun WS too (0/49) — the fix is transport-independent. The stabilizer also
// ~doubles the steady cached prefix (~3-5.6k -> ~8-10k tokens), so it is a net cost win.
//
// web_search executes server-side, so a model invocation would run a real OpenAI web search, but
// across the end-to-end runs the model never once invoked it on a coding task (websearch_calls=0).
// Only injected when the request already carries tools (agentic turns); empty/tool-less requests
// have no continuation cliff to fix and are left untouched.
function maybeInjectCacheStabilizerTool(parsed: Record<string, unknown>) {
  if (process.env.CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH) return
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return
  if (parsed.tools.some((t) => isRecord(t) && t.type === "web_search")) return
  parsed.tools = [...parsed.tools, { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] }]
}

// Optional native image generation (opt-in: CORTEXKIT_OPENAI_AUTH_IMAGE_GENERATION=1).
//
// Declares Codex's native `image_generation` tool so the model can produce images. This is a
// FEATURE knob, not the cache fix — image_generation does NOT stabilize the prompt cache (mimic:
// +image_generation = 8.3% cliffs, no help; web_search is the cache lever). It is server-executed:
// when invoked, OpenAI generates the image and returns `image_generation_call` items + partial_image
// events on the wire, which the plugin currently forwards verbatim to OpenCode's parser. Rendering/
// saving the resulting PNG is a separate, still-unverified piece — keep this opt-in until the
// end-to-end image round-trip through OpenCode is confirmed.
function maybeInjectImageGenerationTool(parsed: Record<string, unknown>) {
  if (!process.env.CORTEXKIT_OPENAI_AUTH_IMAGE_GENERATION) return
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return
  if (parsed.tools.some((t) => isRecord(t) && t.type === "image_generation")) return
  parsed.tools = [...parsed.tools, { type: "image_generation", output_format: "png" }]
}

// Match Codex's function-tool shape: drop the JSON-Schema `$schema` dialect marker
// (Codex omits it) and mark function tools `strict: false` as Codex does.
function normalizeCodexTool(tool: unknown) {
  if (!isRecord(tool)) return tool
  if (tool.type !== "function") return tool
  const parameters =
    isRecord(tool.parameters) && "$schema" in tool.parameters
      ? (() => {
          const { $schema: _schema, ...rest } = tool.parameters as Record<string, unknown>
          return rest
        })()
      : tool.parameters
  // Codex function-tool key order: type, name, description, strict, parameters (+ any extras).
  const { type, name, description, strict, parameters: _p, ...extra } = tool
  return { type, name, description, strict: strict ?? false, parameters, ...extra }
}

async function waitForCodexHttpTurn(metadata: CodexSessionMetadata | undefined) {
  if (!metadata?.lastResponseCompletedAt) return
  const wait = minCodexHttpResponseGapMs() - (Date.now() - metadata.lastResponseCompletedAt)
  if (wait > 0) await sleep(wait)
}

function minCodexHttpResponseGapMs() {
  const value = Number(process.env.MIN_CODEX_HTTP_RESPONSE_GAP_MS)
  if (Number.isFinite(value) && value >= 0) return value
  return DEFAULT_MIN_CODEX_HTTP_RESPONSE_GAP_MS
}

function trackCodexHttpCompletion(
  response: Response,
  metadata: CodexSessionMetadata | undefined,
) {
  if (!metadata || !response.body) return response
  const reader = response.body.getReader()
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const next = await reader.read()
        if (next.done) {
          metadata.lastResponseCompletedAt = Date.now()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      },
      async cancel(reason) {
        metadata.lastResponseCompletedAt = Date.now()
        await reader.cancel(reason)
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
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

async function refreshAccessToken(refreshToken: string, issuer = ISSUER): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
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
      <div class="error">${error}</div>
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

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HTML_SUCCESS)
      return
    }

    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end("Login cancelled")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => {
      resolve()
    })
    oauthServer!.on("error", reject)
  })

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {})
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
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

// Experiment (CORTEXKIT_OPENAI_AUTH_THREAD_INIT=1): real Codex POSTs a
// `codex_thread_initialized` analytics event to chatgpt.com over the
// cookie-bearing HTTP lane before opening the responses WebSocket, registering
// the thread/cache-key id with the backend and establishing Cloudflare edge
// state. OpenCode's first contact with the cache key is the WS request itself.
// This probe replicates that ping and replays the captured CF affinity cookies
// (`__cflb`/`__cf_bm`/`_cfuvid`) on the WS upgrade to pin our single socket.
function threadInitEnabled(): boolean {
  return Boolean(process.env.CORTEXKIT_OPENAI_AUTH_THREAD_INIT)
}

function affinityCookiesFromResponse(res: Response): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : []
  const jar: string[] = []
  for (const cookie of raw) {
    const m = cookie.match(/^(__cflb|__cf_bm|_cfuvid)=([^;]+)/)
    if (m) jar.push(`${m[1]}=${m[2]}`)
  }
  return jar.length ? jar.join("; ") : undefined
}

async function sendCodexThreadInit(input: {
  access: string
  accountId: string | undefined
  metadata: CodexSessionMetadata
  analyticsEndpoint: string
}): Promise<void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.access}`,
    "content-type": "application/json",
    accept: "*/*",
    originator: "codex_exec",
    "user-agent": CODEX_USER_AGENT,
  }
  if (input.accountId) headers["chatgpt-account-id"] = input.accountId
  const body = JSON.stringify({
    events: [
      {
        event_type: "codex_thread_initialized",
        event_params: {
          thread_id: input.metadata.threadID,
          session_id: input.metadata.threadID,
          app_server_client: {
            product_client_id: "codex_exec",
            client_name: "codex_exec",
            client_version: CODEX_VERSION,
            rpc_transport: "in_process",
            experimental_api_enabled: true,
          },
          runtime: {
            codex_rs_version: CODEX_VERSION,
            runtime_os: os.platform(),
            runtime_os_version: os.release(),
            runtime_arch: os.arch(),
          },
          model: "gpt-5.5",
          ephemeral: true,
          thread_source: "user",
          initialization_mode: "new",
          subagent_source: null,
          parent_thread_id: null,
          forked_from_thread_id: null,
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    ],
  })
  const res = await fetch(input.analyticsEndpoint, { method: "POST", headers, body })
  const cookie = affinityCookiesFromResponse(res)
  if (cookie) input.metadata.affinityCookie = cookie
  await res.arrayBuffer().catch(() => {})
}

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  const installationID = crypto.randomUUID()
  const codexSessions = new Map<string, CodexSessionMetadata>()
  let websocketFetchInstalled = false
  const websocketFetches: Array<ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>> = []

  return {
    async dispose() {
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
    },
    async event(input) {
      if (input.event.type !== "session.deleted") return
      for (const websocketFetch of websocketFetches) websocketFetch.remove(input.event.properties.info.id)
    },
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (ALLOWED_MODELS.has(model.api.id)) return true
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
              return match ? parseFloat(match[1]!) > 5.4 : false
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
                limit: model.id.includes("gpt-5.5")
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
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }
        if (auth.type !== "oauth") return websocketFetch ? { fetch: websocketFetch } : {}

        let refreshPromise:
          | Promise<{
              access: string
              accountId: string | undefined
            }>
          | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => String(key).toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth")
              return websocketFetch ? websocketFetch(requestInput, init) : fetch(requestInput, init)

            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(currentAuth.refresh, issuer)
                  .then(async (tokens) => {
                    const accountId = extractAccountId(tokens) || authWithAccount.accountId
                    await input.client.auth.set({
                      path: { id: "openai" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
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
                init.headers.forEach((value, key) => headers.set(key, value))
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
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }
            const sessionID = headers.get("x-session-affinity") ?? headers.get("x-session-id") ?? headers.get("session-id") ?? undefined
            const codexMetadata = sessionID ? getCodexSessionMetadata(codexSessions, sessionID) : undefined

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const url =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
                ? new URL(codexApiEndpoint)
                : parsed

            // Thread-init probe: before the first responses request for this session,
            // register the thread/cache-key over the cookie-bearing HTTP lane (as real
            // Codex does), capturing CF affinity cookies to replay on the WS upgrade.
            if (
              threadInitEnabled() &&
              codexMetadata &&
              !codexMetadata.threadInitialized &&
              parsed.pathname.endsWith("/responses")
            ) {
              codexMetadata.threadInitialized = true
              await sendCodexThreadInit({
                access: currentAuth.access,
                accountId: authWithAccount.accountId,
                metadata: codexMetadata,
                analyticsEndpoint: codexApiEndpoint.replace(/\/responses$/, "/analytics-events/events"),
              }).catch(() => {})
            }
            if (codexMetadata?.affinityCookie) headers.set("cookie", codexMetadata.affinityCookie)

            const prepared = prepareCodexRequest({
              init: {
                ...init,
                headers,
              },
              headers,
              metadata: codexMetadata,
              installationID,
              websocket: Boolean(websocketFetch && parsed.pathname.endsWith("/responses")),
            })
            const requestInit = prepared.init
            if (websocketFetch && parsed.pathname.endsWith("/responses")) return websocketFetch(url, requestInit)
            if (parsed.pathname.endsWith("/responses")) {
              await waitForCodexHttpTurn(codexMetadata)
              return trackCodexHttpCompletion(
                await fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit)),
                codexMetadata,
              )
            }
            return fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit))
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: "success" as const,
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
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                  "User-Agent": USER_AGENT,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
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
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens = (await tokenResponse.json()) as TokenResponse

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `${USER_AGENT} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers["session-id"] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === "title") output.headers[OpenAIWebSocketPool.TITLE_HEADER] = "true"
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}

export const OpenAIAuthPlugin: Plugin = async (input) => CodexAuthPlugin(input, { experimentalWebSockets: true })

export default {
  id: "cortexkit-openai-auth",
  server: OpenAIAuthPlugin,
}
