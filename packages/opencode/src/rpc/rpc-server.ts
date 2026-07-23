import { randomBytes, timingSafeEqual } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { join } from 'node:path'
import { createLogger } from '../logger'
import type { drainNotifications } from './notifications'
import { writePortFile } from './port-file'
import type { ApplyRequest, ApplyResult } from './protocol'

const log = createLogger('rpc')

export interface RpcServerHandle {
  port: number
  token: string
  stop: () => Promise<void>
}

export interface RpcServerOptions {
  dir: string
  drain: typeof drainNotifications
  apply: (request: ApplyRequest) => Promise<ApplyResult>
  timeoutMs?: number
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
  // Safety net, not a per-command SLA: it must outlast the slowest legitimate
  // apply (a reset redemption is bounded by a 60s consume call), so the socket
  // is never destroyed out from under a handler that is still working. Fast
  // commands respond in milliseconds regardless; per-command deadlines belong
  // to the client, which passes its own timeout.
  const timeoutMs = options.timeoutMs ?? 90_000
  const server = createServer((req, res) => {
    req.setTimeout(timeoutMs, () => {
      req.socket.destroy()
    })
    void dispatch(req, res)
  })
  server.requestTimeout = timeoutMs
  server.headersTimeout = timeoutMs

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
        const messages = options.drain(
          Number(params.lastReceivedId ?? 0),
          typeof params.sessionId === 'string' ? params.sessionId : undefined,
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
  try {
    await writePortFile(options.dir, { port, token, pid: process.pid })
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
      await unlink(join(options.dir, `port-${process.pid}.json`)).catch(
        () => {},
      )
    },
  }
}
