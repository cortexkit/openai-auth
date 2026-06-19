import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  drainNotifications,
  pushNotification,
  resetNotificationsForTest,
} from '../rpc/notifications'
import { startRpcServer } from '../rpc/rpc-server'

let stop: (() => Promise<void>) | null = null
let dir: string

afterEach(async () => {
  await stop?.()
  stop = null
  if (dir) await rm(dir, { recursive: true, force: true })
  resetNotificationsForTest()
})

describe('rpc-server', () => {
  test('health is open; pending-notifications requires bearer and drains', async () => {
    resetNotificationsForTest()
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    expect((await fetch(`${base}/health`)).status).toBe(200)

    const noAuth = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastReceivedId: 0 }),
    })
    expect(noAuth.status).toBe(401)

    pushNotification({ command: 'openai-quota', text: 'x', knobs: {} }, 's1')
    const ok = await fetch(`${base}/rpc/pending-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ lastReceivedId: 0, sessionId: 's1' }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as {
      messages: Array<{ payload: { command: string } }>
    }
    expect(body.messages[0]?.payload.command).toBe('openai-quota')

    const applyNoAuth = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'openai-quota', arguments: '' }),
    })
    expect(applyNoAuth.status).toBe(401)

    const applyOk = await fetch(`${base}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ command: 'openai-quota', arguments: '' }),
    })
    expect(applyOk.status).toBe(200)
    expect(await applyOk.json()).toEqual({ text: 'ok', knobs: {} })
  })

  test('rejects body exceeding 1 MB byte limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    // ASCII body > 1 MB bytes
    const huge = 'x'.repeat(1_000_001)
    let rejected = false
    try {
      await fetch(`${base}/rpc/apply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ command: 'test', arguments: huge }),
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  test('rejects multibyte body where byte length exceeds limit but string length does not', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-rpcsrv-'))
    const server = await startRpcServer({
      dir,
      drain: drainNotifications,
      apply: async () => ({ text: 'ok', knobs: {} }),
    })
    stop = server.stop
    const base = `http://127.0.0.1:${server.port}`

    // Each CJK char is 3 bytes in UTF-8 but 1 UTF-16 code unit
    const cjk = '好'.repeat(400_000)
    // String length (UTF-16) is ~400k — below the old 1M limit
    expect(cjk.length).toBeLessThan(1_000_000)
    // Byte length (UTF-8) is ~1.2M — above the 1M limit
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(1_000_000)

    const body = JSON.stringify({ command: 'test', arguments: cjk })
    // The full JSON payload byte length must also exceed 1 MB
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1_000_000)

    let rejected = false
    try {
      await fetch(`${base}/rpc/apply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
        body,
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})
