import { zstdDecompressSync } from 'node:zlib'
import {
  applyCodexClientHeaders,
  type FrameTurn,
  isRecord,
  shapeCodexRequest,
  stampCodexSession,
  stampCodexThreadHeaders,
} from '@cortexkit/openai-auth-core/internal'
import type {
  OpenAICodexResponsesOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'

export const PI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

// Match pi-ai's URL derivation before applying any plugin wire changes.
export function piCodexHttpUrl(baseUrl: string): string {
  const base = (baseUrl?.trim() ? baseUrl : PI_CODEX_BASE_URL).replace(
    /\/+$/,
    '',
  )
  if (base.endsWith('/codex/responses')) return base
  return `${base}${base.endsWith('/codex') ? '/responses' : '/codex/responses'}`
}

export function piCodexWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.href
}

export interface PiCodexWireSession {
  threadID: string
  windowID: string
  installationID: string
  now: () => number
  turn: (body: Record<string, unknown>) => FrameTurn
}

export function omitPiCodexDefaults(
  payload: unknown,
  options?: SimpleStreamOptions &
    Pick<OpenAICodexResponsesOptions, 'textVerbosity'>,
): unknown {
  if (!isRecord(payload)) return payload
  const body = { ...payload }
  // Do this before the caller's hook so writing even 'auto' or 'low' there
  // counts as explicit. pi-ai's simple provider does not forward textVerbosity.
  if (options?.toolChoice == null && body.tool_choice === 'auto')
    delete body.tool_choice
  if (options?.textVerbosity) {
    body.text = {
      ...(isRecord(body.text) ? body.text : {}),
      verbosity: options.textVerbosity,
    }
  } else if (
    isRecord(body.text) &&
    body.text.verbosity === 'low' &&
    Object.keys(body.text).length === 1
  ) {
    delete body.text
  }
  return body
}

function clearPiCodexSession(headers: Headers, body?: Record<string, unknown>) {
  for (const name of [
    'session-id',
    'thread-id',
    'x-session-id',
    'x-session-affinity',
    'x-client-request-id',
    'x-codex-window-id',
    'x-codex-turn-metadata',
  ])
    headers.delete(name)
  if (!body) return
  delete body.prompt_cache_key
  if (!isRecord(body.client_metadata)) return
  for (const name of [
    'x-codex-installation-id',
    'x-codex-window-id',
    'x-codex-turn-metadata',
    'x-codex-ws-stream-request-start-ms',
  ])
    delete body.client_metadata[name]
  if (Object.keys(body.client_metadata).length === 0)
    delete body.client_metadata
}

export function shapePiCodexUpgrade(
  suppliedHeaders: Record<string, string>,
  session: PiCodexWireSession | undefined,
): Record<string, string> {
  const headers = new Headers(suppliedHeaders)
  clearPiCodexSession(headers)
  if (session) stampCodexThreadHeaders(headers, session)
  // pi-ai already sets the bearer and account header from the selected token.
  applyCodexClientHeaders({ headers, websocket: true })
  return Object.fromEntries(headers)
}

function shapePiCodexBody(
  body: Record<string, unknown>,
  headers: Headers,
  session: PiCodexWireSession | undefined,
  websocket: boolean,
) {
  if (session) {
    stampCodexSession({
      body,
      headers,
      metadata: {
        threadID: session.threadID,
        windowID: session.windowID,
        ...session.turn(body),
      },
      installationID: session.installationID,
      now: session.now,
      websocket,
    })
  } else {
    clearPiCodexSession(headers, body)
  }
  return shapeCodexRequest({ body, headers, websocket })
}

export function shapePiCodexWebSocketFrame(
  data: string,
  session: PiCodexWireSession | undefined,
): string {
  // pi-ai has already compared its logical input and chosen full or delta.
  const frame: unknown = JSON.parse(data)
  if (!isRecord(frame) || frame.type !== 'response.create') return data
  return JSON.stringify(shapePiCodexBody(frame, new Headers(), session, true))
}

export function shapePiCodexHttpRequest(
  init: RequestInit | undefined,
  session: PiCodexWireSession | undefined,
): RequestInit | undefined {
  if (!init?.body) return init
  const headers = new Headers(init.headers)
  const encoding = headers.get('content-encoding')
  const compressed = encoding === 'zstd'
  let json: string
  if (compressed && ArrayBuffer.isView(init.body)) {
    const { buffer, byteOffset, byteLength } = init.body
    json = zstdDecompressSync(
      Buffer.from(buffer, byteOffset, byteLength),
    ).toString('utf8')
  } else if (!encoding && typeof init.body === 'string') {
    json = init.body
  } else {
    return init
  }
  const body: unknown = JSON.parse(json)
  if (!isRecord(body) && !compressed) return init
  const shaped = isRecord(body)
    ? shapePiCodexBody(body, headers, session, false)
    : body
  // The standard Responses HTTP request no longer uses pi-ai's beta header.
  headers.delete('openai-beta')
  headers.delete('content-encoding')
  headers.delete('content-length')
  return { ...init, headers, body: JSON.stringify(shaped) }
}
