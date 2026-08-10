import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainNotifications } from '../rpc/notifications'
import { createRpcClient } from '../rpc/rpc-client'
import { type RpcServerHandle, startRpcServer } from '../rpc/rpc-server'

let dir: string | undefined
let server: RpcServerHandle | undefined

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

test('RPC client preserves sessionId through the server apply callback', async () => {
  dir = await mkdtemp(join(tmpdir(), 'oa-rpcclient-'))
  const received: Array<{ sessionId?: string }> = []
  server = await startRpcServer({
    dir,
    drain: drainNotifications,
    apply: async (request) => {
      received.push(request)
      return { text: 'ok', knobs: {} }
    },
  })

  const client = createRpcClient(dir, process.pid)
  await Promise.all([
    client.apply({
      command: 'openai-routing',
      arguments: 'reset',
      sessionId: 'session-a',
    }),
    client.apply({
      command: 'openai-routing',
      arguments: 'reset',
      sessionId: 'session-b',
    }),
  ])

  expect(received.map((request) => request.sessionId).sort()).toEqual([
    'session-a',
    'session-b',
  ])
})
