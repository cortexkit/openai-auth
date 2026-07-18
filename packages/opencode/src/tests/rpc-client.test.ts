import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpcClient, DEFAULT_RPC_TIMEOUT_MS } from '../rpc/rpc-client'
import { startRpcServer } from '../rpc/rpc-server'

let stop: (() => Promise<void>) | null = null
let dir: string

afterEach(async () => {
  await stop?.()
  stop = null
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('rpc-client', () => {
  test('keeps the default call timeout at two seconds', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(2_000)
  })

  test('apply honors a per-call timeout override', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcclient-'))
    const server = await startRpcServer({
      dir,
      timeoutMs: 2_000,
      drain: () => [],
      apply: async () => {
        await Bun.sleep(300)
        return { text: 'completed', knobs: { stage: 'result' } }
      },
    })
    stop = server.stop
    const client = createRpcClient(dir, process.pid)
    const request = {
      command: 'openai-reset',
      arguments: 'confirm account id',
    } as const

    expect(await client.apply(request, 100)).toEqual({
      text: 'apply failed',
      knobs: {},
    })
    expect(await client.apply(request, 1_000)).toEqual({
      text: 'completed',
      knobs: { stage: 'result' },
    })
  })
})
