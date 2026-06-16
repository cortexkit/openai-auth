// Hand-rolled WebSocket client over raw TCP/TLS sockets.
//
// Purpose: native WebSocket implementations fix the HTTP upgrade header ORDER and
// own the RFC 6455 frame codec, so they cannot speak the wire the way Codex's
// Rust tokio-tungstenite client does. This client writes the upgrade bytes and
// frames by hand, giving full control of header order + framing, which surfaces
// Codex-style incremental streaming that native WebSocket implementations can
// suppress.
//
// Opt-in via CORTEXKIT_OPENAI_AUTH_RAW_WS=1. permessage-deflate is intentionally NOT
// negotiated; plain text frames keep the codec simple.
//
// Implements only the subset of the WebSocket interface the plugin consumes:
// addEventListener/removeEventListener for "open"|"message"|"error"|"close",
// send(string), close(), and a `url` field. Text frames only on receive.

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

import { dumpDiagnostic } from './dump'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// Codex (tokio-tungstenite) application-header order. WS control headers
// (host/connection/upgrade/sec-websocket-version/sec-websocket-key) are written
// first by us in Codex's exact order; Sec-WebSocket-Extensions would go last but
// we omit it (no permessage-deflate).
const CODEX_APP_HEADER_ORDER = [
  'chatgpt-account-id',
  'authorization',
  'user-agent',
  'originator',
  'openai-beta',
  'version',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
  'x-client-request-id',
  'session-id',
  'thread-id',
  'x-codex-window-id',
]

type Listener = (event: unknown) => void

export class RawWebSocket {
  url: string
  readyState = 0 // CONNECTING
  private socket:
    | {
        write(data: Uint8Array | string): boolean | number
        end(): void
        destroy?(): void
      }
    | undefined
  private readonly sessionID: string | undefined
  private listeners: Record<string, Set<Listener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }
  private rxBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private handshakeDone = false
  private expectedAccept = ''
  // message reassembly across fragmented frames
  private fragOpcode = 0
  private fragChunks: Uint8Array<ArrayBufferLike>[] = []

  constructor(
    url: string,
    headers: Record<string, string>,
    options?: { sessionID?: string },
  ) {
    this.url = url
    this.sessionID = options?.sessionID
    void this.connect(url, headers)
  }

  addEventListener(
    type: string,
    fn: Listener,
    _opts?: { once?: boolean },
  ): void {
    this.listeners[type]?.add(fn)
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type]?.delete(fn)
  }
  private emit(type: string, event: unknown): void {
    for (const fn of [...(this.listeners[type] ?? [])]) {
      try {
        fn(event)
      } catch {
        // listener errors must not crash the socket loop
      }
    }
  }

  private async connect(
    url: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const u = new URL(url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'))
    const host = u.hostname
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    const path = `${u.pathname}${u.search}`
    const keyBytes = crypto.getRandomValues(new Uint8Array(16))
    const key = Buffer.from(keyBytes).toString('base64')
    const acceptDigest = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(key + WS_GUID),
    )
    this.expectedAccept = Buffer.from(new Uint8Array(acceptDigest)).toString(
      'base64',
    )

    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
    // Build the upgrade in Codex's exact byte order.
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Connection: Upgrade`,
      `Upgrade: websocket`,
      `Sec-WebSocket-Version: 13`,
      `Sec-WebSocket-Key: ${key}`,
    ]
    for (const name of CODEX_APP_HEADER_ORDER) {
      if (lower[name] !== undefined)
        lines.push(`${canonical(name)}: ${lower[name]}`)
    }
    for (const [k, v] of Object.entries(headers)) {
      if (
        !CODEX_APP_HEADER_ORDER.includes(k.toLowerCase()) &&
        k.toLowerCase() !== 'content-length'
      ) {
        lines.push(`${k}: ${v}`)
      }
    }
    const request = `${lines.join('\r\n')}\r\n\r\n`

    try {
      void this.log('connect_start', {
        host,
        port,
        tls: u.protocol === 'https:',
      })
      const onOpen = () => {
        this.socket?.write(request)
      }
      const socket =
        u.protocol === 'https:'
          ? tlsConnect({ host, port, servername: host }, onOpen)
          : netConnect({ host, port }, onOpen)
      this.socket = socket
      socket.on('data', (data) => {
        this.onData(
          typeof data === 'string' ? Buffer.from(data, 'binary') : data,
        )
      })
      socket.on('error', (e) => {
        this.readyState = 3
        const message = e instanceof Error ? e.message : String(e)
        void this.log('socket_error', { message })
        this.emit('error', { message })
      })
      socket.on('close', (hadError) => {
        this.readyState = 3
        void this.log('socket_close', { hadError })
        this.emit('close', { code: 1006, reason: 'socket closed' })
      })
    } catch (e) {
      this.readyState = 3
      void this.log('connect_exception', {
        message: e instanceof Error ? e.message : String(e),
      })
      this.emit('error', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  private onData(d: Uint8Array): void {
    this.rxBuffer = concat(this.rxBuffer, d)
    if (!this.handshakeDone) {
      const text = Buffer.from(this.rxBuffer).toString('latin1')
      const idx = text.indexOf('\r\n\r\n')
      if (idx === -1) return
      const headerText = text.slice(0, idx)
      const statusLine = headerText.split('\r\n')[0] ?? ''
      const acceptMatch = headerText.match(/sec-websocket-accept:\s*(\S+)/i)
      if (!statusLine.includes(' 101')) {
        this.readyState = 3
        this.socket?.destroy?.()
        void this.log('upgrade_failed', { statusLine })
        this.emit('error', { message: `WS upgrade failed: ${statusLine}` })
        return
      }
      if (!acceptMatch || acceptMatch[1] !== this.expectedAccept) {
        this.readyState = 3
        this.socket?.destroy?.()
        void this.log('accept_mismatch', { statusLine })
        this.emit('error', {
          message: 'WS upgrade Sec-WebSocket-Accept mismatch',
        })
        return
      }
      this.handshakeDone = true
      this.readyState = 1
      this.rxBuffer = this.rxBuffer.slice(idx + 4)
      void this.log('open', { statusLine })
      this.emit('open', {})
    }
    this.drainFrames()
  }

  private drainFrames(): void {
    // RFC 6455 frame parsing for server->client (never masked).
    for (;;) {
      const buf = this.rxBuffer
      if (buf.length < 2) return
      const b0 = buf[0]!
      const b1 = buf[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = (buf[2]! << 8) | buf[3]!
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = 0
        for (let i = 0; i < 8; i++) len = len * 256 + buf[2 + i]!
        offset = 10
      }
      if (masked) offset += 4 // shouldn't happen server->client
      if (buf.length < offset + len) return
      const payload = buf.slice(offset, offset + len)
      this.rxBuffer = buf.slice(offset + len)
      this.handleFrame(fin, opcode, payload)
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Uint8Array): void {
    if (opcode === 0x9) {
      // ping -> pong (echo payload), masked
      this.writeFrame(0xa, payload)
      return
    }
    if (opcode === 0xa) return // pong
    if (opcode === 0x8) {
      // close
      let code = 1005
      let reason = ''
      if (payload.length >= 2) {
        code = (payload[0]! << 8) | payload[1]!
        reason = Buffer.from(payload.slice(2)).toString('utf-8')
      }
      this.readyState = 3
      try {
        this.socket?.end()
      } catch {
        /* ignore */
      }
      this.emit('close', { code, reason })
      return
    }
    // data frame: 0x1 text, 0x2 binary, 0x0 continuation
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragOpcode = opcode
      this.fragChunks = [payload]
    } else if (opcode === 0x0) {
      this.fragChunks.push(payload)
    }
    if (!fin) return
    const full = concatAll(this.fragChunks)
    this.fragChunks = []
    if (this.fragOpcode === 0x1) {
      const text = Buffer.from(full).toString('utf-8')
      this.emit('message', { data: text })
    }
  }

  send(data: string): void {
    if (this.readyState !== 1) return
    this.writeFrame(0x1, new TextEncoder().encode(data))
  }

  private writeFrame(opcode: number, payload: Uint8Array): void {
    const len = payload.length
    const mask = crypto.getRandomValues(new Uint8Array(4))
    let header: number[]
    if (len < 126) header = [0x80 | opcode, 0x80 | len]
    else if (len < 65536)
      header = [0x80 | opcode, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]
    else {
      header = [0x80 | opcode, 0x80 | 127]
      for (let i = 7; i >= 0; i--) header.push((len / 2 ** (8 * i)) & 0xff)
    }
    const masked = new Uint8Array(len)
    for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!
    const frame = new Uint8Array(header.length + 4 + len)
    frame.set(header, 0)
    frame.set(mask, header.length)
    frame.set(masked, header.length + 4)
    try {
      this.socket?.write(frame)
    } catch {
      /* socket gone */
    }
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 2
    try {
      this.writeFrame(0x8, new Uint8Array([0x03, 0xe8])) // 1000
      this.socket?.end()
    } catch {
      /* ignore */
    }
    this.readyState = 3
  }

  private log(event: string, data?: Record<string, unknown>): Promise<void> {
    return dumpDiagnostic({
      component: 'raw-ws-node',
      event,
      sessionID: this.sessionID,
      url: this.url,
      ...data,
    })
  }
}

function canonical(lower: string): string {
  // Match Codex's header casing for the few that aren't all-lowercase on the wire.
  return lower
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
