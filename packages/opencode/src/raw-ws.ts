import { RawWebSocket as BunRawWebSocket } from './raw-ws-bun'
import { RawWebSocket as NodeRawWebSocket } from './raw-ws-node'

type BunGlobal = typeof globalThis & {
  Bun?: {
    connect?: unknown
  }
}

function hasBunConnect(): boolean {
  return typeof (globalThis as BunGlobal).Bun?.connect === 'function'
}

export const RawWebSocket = hasBunConnect() ? BunRawWebSocket : NodeRawWebSocket
