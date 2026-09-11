import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { join } from 'node:path'
import { createLogger } from '../logger'
import type { drainNotifications } from './notifications'
import { sweepRpcState, writePortFile } from './port-file'
import type { ApplyRequest, ApplyResult } from './protocol'

const log = createLogger('rpc')

export interface RpcServerHandle {
  port: number
  token: string
  stop: () => Promise<void>
}

export interface RpcServerOptions {
  dir: string
  secureDir?: boolean
  sweepRoot?: string
  drain: typeof drainNotifications
  apply: (request: ApplyRequest) => Promise<ApplyResult>
  // Bounds handler execution via the socket inactivity timer.
  timeoutMs?: number
  // Bounds request delivery only (requestTimeout/headersTimeout).
  receiptTimeoutMs?: number
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

export async function startRpcServer(
  options: RpcServerOptions,
): Promise<RpcServerHandle> {
  const token = randomBytes(32).toString('hex')
  // Two different bounds, deliberately not one value.
  //
  // requestTimeout/headersTimeout bound how long a client may take to DELIVER
  // a request; they do not bound handler execution. A receipt bound of 500ms
  // still returns 200 for a 3s handler. Over loopback with a 1 MiB body cap,
  // seconds is already generous.
  //
  // The inactivity timer is the one that can kill a working handler: it
  // destroys the socket out from under it. It must therefore outlast the
  // slowest legitimate apply — a reset redemption is bounded by a 60s consume
  // call — or the response is lost server-side no matter what deadline the
  // client passed. Fast commands respond in milliseconds regardless.
  //
  // Collapsing these back into a single value reintroduces one of two bugs:
  // a receipt bound that aborts a slow reset, or a socket timer that leaves
  // every endpoint holding a dead connection for 90s.
  const handlerTimeoutMs = options.timeoutMs ?? 90_000
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 2_000
  let warnedMissingNotificationSession = false
  const server = createServer((req, res) => {
    req.setTimeout(handlerTimeoutMs, () => {
      req.socket.destroy()
    })
    void dispatch(req, res)
  })
  server.requestTimeout = receiptTimeoutMs
  server.headersTimeout = receiptTimeoutMs

  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, value: unknown) => {
      // Guard against writing to a socket that was destroyed (e.g. when
      // readBody rejected after req.destroy() on an oversized body).
      if (res.headersSent || res.writableEnded || res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    try {
      const url = req.url ?? ''
      if (req.method === 'GET' && url === '/health')
        return json(200, { ok: true })
      if (req.method !== 'POST' || !url.startsWith('/rpc/'))
        return json(404, { error: 'not found' })
      if (!tokenOk(req.headers.authorization, token))
        return json(401, { error: 'unauthorized' })
      const method = url.slice('/rpc/'.length)
      const body = await readBody(req)
      const params = JSON.parse(body || '{}') as Record<string, unknown>
      if (method === 'pending-notifications') {
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : undefined
        if (sessionId === undefined && !warnedMissingNotificationSession) {
          warnedMissingNotificationSession = true
          log.warn('rpc notification drain missing session id', {
            pid: process.pid,
          })
        }
        const messages = options.drain(
          Number(params.lastReceivedId ?? 0),
          sessionId,
        )
        return json(200, { messages })
      }
      if (method === 'apply') {
        const result = await options.apply(params as unknown as ApplyRequest)
        return json(200, result)
      }
      return json(404, { error: 'unknown method' })
    } catch (error) {
      json(500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('no port'))
    })
  })
  server.unref()
  if (options.sweepRoot) {
    try {
      await sweepRpcState(options.sweepRoot, options.dir)
    } catch (error) {
      log.warn('rpc state sweep failed', {
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  try {
    await writePortFile(
      options.dir,
      { port, token, pid: process.pid },
      { secureDir: options.secureDir },
    )
    log.debug('rpc server pid', {
      pid: process.pid,
      rpcPort: port,
    })
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }

  return {
    port,
    token,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const portFile = join(options.dir, `port-${process.pid}.json`)
      const current = await readFile(portFile, 'utf8')
        .then((raw) => JSON.parse(raw) as { port?: unknown; token?: unknown })
        .catch(() => undefined)
      if (current?.port === port && current.token === token)
        await unlink(portFile).catch(() => {})
    },
  }
}
