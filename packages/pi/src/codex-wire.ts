import { zstdDecompressSync } from 'node:zlib'
import {
  isRecord,
  moveInstructionsToDeveloperMessage,
  restoreReplayedCallStatus,
} from '@cortexkit/openai-auth-core/internal'

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

function shapeFullBody(body: Record<string, unknown>) {
  const input = restoreReplayedCallStatus(body.input, body.model)
  if (input !== body.input) body.input = input
  moveInstructionsToDeveloperMessage(body)
}

export function shapePiCodexWebSocketFrame(data: string): string {
  // pi-ai has already compared its logical input and chosen full or delta.
  const frame: unknown = JSON.parse(data)
  if (!isRecord(frame) || frame.type !== 'response.create') return data
  if (
    typeof frame.previous_response_id === 'string' &&
    frame.previous_response_id
  ) {
    delete frame.instructions
  } else {
    shapeFullBody(frame)
  }
  return JSON.stringify(frame)
}

export function shapePiCodexHttpRequest(
  init: RequestInit | undefined,
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
  if (isRecord(body)) shapeFullBody(body)
  const shaped = JSON.stringify(body)
  if (!compressed && shaped === json) return init
  headers.delete('content-encoding')
  headers.delete('content-length')
  return { ...init, headers, body: shaped }
}
