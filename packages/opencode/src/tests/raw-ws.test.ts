import { describe, expect, it } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { RawWebSocket } from '../raw-ws-bun'
import { RawWebSocket as NodeRawWebSocket } from '../raw-ws-node'

describe('RawWebSocket Bun', () => {
  it('queues handshake write and handles partial writes', async () => {
    const writtenChunks: Uint8Array[] = []
    let drainCallback: (() => void) | undefined

    const mockSocket = {
      write(data: Uint8Array) {
        // Simulate a partial write: write only the first 10 bytes
        const toWrite = Math.min(data.length, 10)
        writtenChunks.push(data.slice(0, toWrite))
        return toWrite
      },
      end() {},
    }

    const mockConnect = async (opts: any) => {
      drainCallback = opts.socket.drain
      // Call open callback synchronously
      opts.socket.open(mockSocket)
      return mockSocket
    }

    // Mock global Bun.connect
    const originalConnect = (globalThis as any).Bun?.connect
    if ((globalThis as any).Bun) {
      ;(globalThis as any).Bun.connect = mockConnect
    }

    try {
      const _ws = new RawWebSocket('ws://localhost:8080', {
        'chatgpt-account-id': 'acc-123',
      })

      // Wait for microtasks
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The first write should have written 10 bytes
      expect(writtenChunks.length).toBe(1)
      expect(writtenChunks[0]!.length).toBe(10)

      // Now trigger drain to write the next chunk
      if (drainCallback) {
        drainCallback()
      }

      // The second write should have written another 10 bytes
      expect(writtenChunks.length).toBe(2)
      expect(writtenChunks[1]!.length).toBe(10)
    } finally {
      if ((globalThis as any).Bun) {
        ;(globalThis as any).Bun.connect = originalConnect
      }
    }
  })

  it('preserves status and structured usage-limit details from a rejected upgrade', async () => {
    let dataCallback: ((socket: unknown, data: Uint8Array) => void) | undefined
    const mockSocket = {
      write(data: Uint8Array) {
        return data.length
      },
      end() {},
    }
    const mockConnect = async (opts: any) => {
      dataCallback = opts.socket.data
      opts.socket.open(mockSocket)
      return mockSocket
    }
    const originalConnect = (globalThis as any).Bun?.connect
    if ((globalThis as any).Bun) {
      ;(globalThis as any).Bun.connect = mockConnect
    }

    try {
      const ws = new RawWebSocket('ws://localhost:8080', {})
      const errorEvent = new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener('error', (event) =>
          resolve(event as Record<string, unknown>),
        )
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const body = JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          plan_type: 'team',
          resets_at: 1_784_958_366,
          eligible_promo: null,
          resets_in_seconds: 514_504,
        },
      })
      dataCallback?.(
        mockSocket,
        new TextEncoder().encode(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        ),
      )

      expect(await errorEvent).toMatchObject({
        status: 429,
        error: {
          type: 'usage_limit_reached',
          resets_at: 1_784_958_366,
        },
      })
    } finally {
      if ((globalThis as any).Bun) {
        ;(globalThis as any).Bun.connect = originalConnect
      }
    }
  })

  it('fails a malformed rejected-upgrade status line instead of remaining CONNECTING', async () => {
    let dataCallback: ((socket: unknown, data: Uint8Array) => void) | undefined
    let ended = false
    const mockSocket = {
      write(data: Uint8Array) {
        return data.length
      },
      end() {
        ended = true
      },
    }
    const mockConnect = async (opts: any) => {
      dataCallback = opts.socket.data
      opts.socket.open(mockSocket)
      return mockSocket
    }
    const originalConnect = (globalThis as any).Bun?.connect
    if ((globalThis as any).Bun) {
      ;(globalThis as any).Bun.connect = mockConnect
    }

    try {
      const ws = new RawWebSocket('ws://localhost:8080', {})
      const errorEvent = new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener('error', (event) =>
          resolve(event as Record<string, unknown>),
        )
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      dataCallback?.(
        mockSocket,
        new TextEncoder().encode('NOT HTTP\r\nHeader: value\r\n\r\n'),
      )

      expect(
        await Promise.race([
          errorEvent,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('timed out waiting for upgrade error')),
              100,
            ),
          ),
        ]),
      ).toMatchObject({ message: 'WS upgrade failed: NOT HTTP' })
      expect(ws.readyState).toBe(3)
      expect(ended).toBe(true)
    } finally {
      if ((globalThis as any).Bun) {
        ;(globalThis as any).Bun.connect = originalConnect
      }
    }
  })
})

describe('RawWebSocket Node', () => {
  it('fails a malformed rejected-upgrade status line instead of remaining CONNECTING', async () => {
    let peer: Socket | undefined
    const server = createServer((socket) => {
      peer = socket
      socket.once('data', () => {
        socket.write('NOT HTTP\r\nHeader: value\r\n\r\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a TCP port')
    }
    const ws = new NodeRawWebSocket(`ws://127.0.0.1:${address.port}`, {})

    try {
      const event = await Promise.race([
        new Promise<Record<string, unknown>>((resolve) => {
          ws.addEventListener('error', (error) =>
            resolve(error as Record<string, unknown>),
          )
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('timed out waiting for upgrade error')),
            500,
          ),
        ),
      ])
      expect(event).toMatchObject({ message: 'WS upgrade failed: NOT HTTP' })
      expect(ws.readyState).toBe(3)
    } finally {
      ws.close()
      peer?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('rejected upgrade finalization', () => {
  it('finalizes a truncated rejected-upgrade body when the Bun socket closes', async () => {
    let dataCallback: ((socket: unknown, data: Uint8Array) => void) | undefined
    let closeCallback: (() => void) | undefined
    const mockSocket = {
      write(data: Uint8Array) {
        return data.length
      },
      end() {},
    }
    const mockConnect = async (opts: any) => {
      dataCallback = opts.socket.data
      closeCallback = opts.socket.close
      opts.socket.open(mockSocket)
      return mockSocket
    }
    const originalConnect = (globalThis as any).Bun?.connect
    if ((globalThis as any).Bun) {
      ;(globalThis as any).Bun.connect = mockConnect
    }

    const partialBody = '{"error":{"type":"usage_limit_reached"'
    try {
      const ws = new RawWebSocket('ws://localhost:8080', {})
      let errorEmitted = false
      let closeEvents = 0
      const errorEvent = new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener('error', (event) => {
          errorEmitted = true
          resolve(event as Record<string, unknown>)
        })
      })
      ws.addEventListener('close', () => closeEvents++)
      await new Promise((resolve) => setTimeout(resolve, 0))
      dataCallback?.(
        mockSocket,
        new TextEncoder().encode(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${partialBody.length + 100}\r\n\r\n${partialBody}`,
        ),
      )
      await Promise.resolve()
      expect(errorEmitted).toBe(false)
      closeCallback?.()

      expect(
        await Promise.race([
          errorEvent,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('timed out waiting for upgrade error')),
              100,
            ),
          ),
        ]),
      ).toMatchObject({ status: 429, body: partialBody })
      expect(closeEvents).toBe(0)
    } finally {
      if ((globalThis as any).Bun) {
        ;(globalThis as any).Bun.connect = originalConnect
      }
    }
  })

  it('accumulates a fragmented close-delimited body until the Bun socket closes', async () => {
    let dataCallback: ((socket: unknown, data: Uint8Array) => void) | undefined
    let closeCallback: (() => void) | undefined
    const mockSocket = {
      write(data: Uint8Array) {
        return data.length
      },
      end() {},
    }
    const mockConnect = async (opts: any) => {
      dataCallback = opts.socket.data
      closeCallback = opts.socket.close
      opts.socket.open(mockSocket)
      return mockSocket
    }
    const originalConnect = (globalThis as any).Bun?.connect
    if ((globalThis as any).Bun) {
      ;(globalThis as any).Bun.connect = mockConnect
    }

    const firstBody = '{"error":{"type":"usage_limit_reached",'
    const secondBody = '"resets_at":1784958366}}'
    try {
      const ws = new RawWebSocket('ws://localhost:8080', {})
      let errorEmitted = false
      const errorEvent = new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener('error', (event) => {
          errorEmitted = true
          resolve(event as Record<string, unknown>)
        })
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      dataCallback?.(
        mockSocket,
        new TextEncoder().encode(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n${firstBody}`,
        ),
      )
      await Promise.resolve()
      expect(errorEmitted).toBe(false)

      dataCallback?.(mockSocket, new TextEncoder().encode(secondBody))
      await Promise.resolve()
      expect(errorEmitted).toBe(false)
      closeCallback?.()

      expect(
        await Promise.race([
          errorEvent,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('timed out waiting for upgrade error')),
              100,
            ),
          ),
        ]),
      ).toMatchObject({
        status: 429,
        body: `${firstBody}${secondBody}`,
        error: {
          type: 'usage_limit_reached',
          resets_at: 1_784_958_366,
        },
      })
    } finally {
      if ((globalThis as any).Bun) {
        ;(globalThis as any).Bun.connect = originalConnect
      }
    }
  })

  it('finalizes an empty rejected-upgrade body (no Content-Length) when the Bun socket closes', async () => {
    let dataCallback: ((socket: unknown, data: Uint8Array) => void) | undefined
    let closeCallback: (() => void) | undefined
    const mockSocket = {
      write(data: Uint8Array) {
        return data.length
      },
      end() {},
    }
    const mockConnect = async (opts: any) => {
      dataCallback = opts.socket.data
      closeCallback = opts.socket.close
      opts.socket.open(mockSocket)
      return mockSocket
    }
    const originalConnect = (globalThis as any).Bun?.connect
    if ((globalThis as any).Bun) {
      ;(globalThis as any).Bun.connect = mockConnect
    }

    try {
      const ws = new RawWebSocket('ws://localhost:8080', {})
      let errorEmitted = false
      const errorEvent = new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener('error', (event) => {
          errorEmitted = true
          resolve(event as Record<string, unknown>)
        })
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      // Status line + headers only: no Content-Length and no body. The client
      // cannot know the body is complete until the socket closes.
      dataCallback?.(
        mockSocket,
        new TextEncoder().encode(
          'HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n',
        ),
      )
      await Promise.resolve()
      expect(errorEmitted).toBe(false)
      closeCallback?.()

      expect(
        await Promise.race([
          errorEvent,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('timed out waiting for upgrade error')),
              100,
            ),
          ),
        ]),
      ).toMatchObject({ status: 429, body: '' })
    } finally {
      if ((globalThis as any).Bun) {
        ;(globalThis as any).Bun.connect = originalConnect
      }
    }
  })
})

describe('RawWebSocket Node rejected-upgrade matrix', () => {
  const usageLimitBody = JSON.stringify({
    error: {
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      resets_at: 1_784_958_366,
    },
  })

  async function withUpgradeServer(
    handler: (socket: Socket) => void,
    run: (url: string) => Promise<void>,
  ) {
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a TCP port')
    }
    try {
      await run(`ws://127.0.0.1:${address.port}`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  function awaitErrorEvent(ws: NodeRawWebSocket, timeoutMs = 1000) {
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener('error', (error) =>
          resolve(error as Record<string, unknown>),
        )
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('timed out waiting for upgrade error')),
          timeoutMs,
        ),
      ),
    ])
  }

  it('preserves status and body from a complete 429 (Content-Length)', async () => {
    await withUpgradeServer(
      (socket) => {
        socket.once('data', () => {
          socket.write(
            `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${usageLimitBody.length}\r\n\r\n${usageLimitBody}`,
            () => socket.destroy(),
          )
        })
      },
      async (url) => {
        const ws = new NodeRawWebSocket(url, {})
        try {
          expect(await awaitErrorEvent(ws)).toMatchObject({
            status: 429,
            error: {
              type: 'usage_limit_reached',
              resets_at: 1_784_958_366,
            },
          })
        } finally {
          ws.close()
        }
      },
    )
  })

  it('finalizes a partial 429 body when the socket closes early', async () => {
    const partialBody = '{"error":{"type":"usage_limit_reached"'
    await withUpgradeServer(
      (socket) => {
        socket.once('data', () => {
          // Advertise more bytes than we actually send, then drop the connection.
          socket.write(
            `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${partialBody.length + 100}\r\n\r\n${partialBody}`,
            () => socket.destroy(),
          )
        })
      },
      async (url) => {
        const ws = new NodeRawWebSocket(url, {})
        try {
          expect(await awaitErrorEvent(ws)).toMatchObject({
            status: 429,
            body: partialBody,
          })
        } finally {
          ws.close()
        }
      },
    )
  })

  it('accumulates a chunked 429 body (no Content-Length) until close', async () => {
    const firstBody = '{"error":{"type":"usage_limit_reached",'
    const secondBody = '"resets_at":1784958366}}'
    await withUpgradeServer(
      (socket) => {
        socket.once('data', () => {
          socket.write(
            `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n${firstBody}`,
          )
          setTimeout(() => {
            socket.write(secondBody, () => socket.destroy())
          }, 10)
        })
      },
      async (url) => {
        const ws = new NodeRawWebSocket(url, {})
        try {
          expect(await awaitErrorEvent(ws)).toMatchObject({
            status: 429,
            body: `${firstBody}${secondBody}`,
            error: {
              type: 'usage_limit_reached',
              resets_at: 1_784_958_366,
            },
          })
        } finally {
          ws.close()
        }
      },
    )
  })

  it('finalizes an empty 429 (no body) when the socket closes', async () => {
    await withUpgradeServer(
      (socket) => {
        socket.once('data', () => {
          socket.write(
            'HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n',
            () => socket.destroy(),
          )
        })
      },
      async (url) => {
        const ws = new NodeRawWebSocket(url, {})
        try {
          expect(await awaitErrorEvent(ws)).toMatchObject({
            status: 429,
            body: '',
          })
        } finally {
          ws.close()
        }
      },
    )
  })
})
