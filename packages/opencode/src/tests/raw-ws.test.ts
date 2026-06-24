import { describe, expect, it } from 'bun:test'
import { RawWebSocket } from '../raw-ws-bun'

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
})
