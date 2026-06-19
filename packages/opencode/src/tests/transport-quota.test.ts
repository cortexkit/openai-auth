import { describe, expect, it } from 'bun:test'
import type { OAuthQuotaSnapshot } from '../core/accounts.ts'
import { normalizeQuotaHeaders, normalizeWsFrame } from '../quota-normalize.ts'

/**
 * Minimal WebSocket stub that can drive streamResponsesWebSocket.
 *
 * The stub keeps a listeners Map so `addEventListener('message', fn)` from
 * `attach()` wires the real `onMessage` handler. Calling `write(data)` then
 * pushes a MessageEvent through that handler, exactly as a real socket would.
 */
function wsStub() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const self = {
    url: 'wss://chatgpt.com/backend-api/codex/responses',
    readyState: 1, // WebSocket.OPEN
    addEventListener(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    removeEventListener(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn)
    },
    close() {},
    send(_data: string) {},
    /** Push a text frame into the registered 'message' handler. */
    write(data: string) {
      const fns = listeners.get('message')
      if (!fns) return
      const event = { data } as MessageEvent
      for (const fn of fns) fn(event)
    },
  }
  return self as WebSocket & { write: (data: string) => void }
}

// ---------------------------------------------------------------------------
// (a) ws.ts emits onQuota on a codex.rate_limits frame AND does NOT relay it
// ---------------------------------------------------------------------------

describe('ws codex.rate_limits → onQuota', () => {
  it('emits onQuota when a codex.rate_limits frame arrives, and does NOT relay it as model output', async () => {
    const { streamResponsesWebSocket } = await import('../ws.ts')
    let quotaSnapshot: OAuthQuotaSnapshot | undefined
    const relayedLines: string[] = []

    const socket = wsStub()
    const response = streamResponsesWebSocket({
      socket: socket as unknown as WebSocket,
      body: { model: 'gpt-5.5' },
      onQuota: (s) => {
        quotaSnapshot = s as OAuthQuotaSnapshot
      },
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // Wait a tick for the ReadableStream start() to call attach() →
    // register onMessage → send response.create
    await new Promise((r) => setTimeout(r, 10))

    // Emit the codex.rate_limits frame
    socket.write(
      JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: {
          primary: { used_percent: 25, window_minutes: 300, reset_at: 1 },
        },
      }),
    )

    // Emit a regular data event
    socket.write(
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'hello',
      }),
    )

    // Emit terminal to close the stream
    socket.write(
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', usage: {} },
      }),
    )

    // Collect SSE output
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      relayedLines.push(decoder.decode(value))
    }

    // onQuota was called with the correct snapshot
    expect(quotaSnapshot).toBeDefined()
    expect(quotaSnapshot!.primary?.usedPercent).toBe(25)

    // codex.rate_limits was NOT relayed as SSE output
    const allOutput = relayedLines.join('')
    expect(allOutput).not.toContain('codex.rate_limits')
    // But the regular data was relayed
    expect(allOutput).toContain('hello')
  })

  it('no onQuota registered → codex.rate_limits frame is silently dropped', async () => {
    const { streamResponsesWebSocket } = await import('../ws.ts')
    const relayedLines: string[] = []

    const socket = wsStub()
    const response = streamResponsesWebSocket({
      socket: socket as unknown as WebSocket,
      body: { model: 'gpt-5.5' },
      // onQuota NOT set
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    await new Promise((r) => setTimeout(r, 10))

    socket.write(
      JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: {
          primary: { used_percent: 25, window_minutes: 300, reset_at: 1 },
        },
      }),
    )
    socket.write(
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', usage: {} },
      }),
    )

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      relayedLines.push(decoder.decode(value))
    }

    const allOutput = relayedLines.join('')
    expect(allOutput).not.toContain('codex.rate_limits')
    expect(allOutput).toContain('[DONE]')
  })

  it('normalizeWsFrame maps the frame into the snapshot shape', () => {
    const snapshot = normalizeWsFrame({
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 25, window_minutes: 300, reset_at: 1 },
        secondary: { used_percent: 5, window_minutes: 10080, reset_at: 2 },
      },
      plan_type: 'plus',
    })
    expect(snapshot.primary?.usedPercent).toBe(25)
    expect(snapshot.primary?.remainingPercent).toBe(75)
    expect(snapshot.secondary?.usedPercent).toBe(5)
    expect(snapshot.secondary?.remainingPercent).toBe(95)
  })
})

// ---------------------------------------------------------------------------
// (b) HTTP path: x-codex-* response headers → setMain push (conditional)
// ---------------------------------------------------------------------------

describe('HTTP quota push from x-codex-* headers', () => {
  it('full x-codex-* headers → normalizeQuotaHeaders returns a snapshot', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '10',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1781729038',
      'x-codex-secondary-used-percent': '91',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1781766665',
    })
    const snapshot = normalizeQuotaHeaders(h)
    expect(snapshot.primary?.usedPercent).toBe(10)
    expect(snapshot.primary?.remainingPercent).toBe(90)
    expect(snapshot.secondary?.usedPercent).toBe(91)
    expect(snapshot.secondary?.remainingPercent).toBe(9)
  })

  it('absent x-codex-* headers → empty snapshot → setMain push skipped (conditional guard)', () => {
    const h = new Headers({ 'content-type': 'text/event-stream' })
    const snapshot = normalizeQuotaHeaders(h)
    expect(Object.keys(snapshot)).toHaveLength(0)
  })

  it('partial x-codex-* headers → only the present windows', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '50',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1781729038',
    })
    const snapshot = normalizeQuotaHeaders(h)
    expect(snapshot.primary?.usedPercent).toBe(50)
    expect(snapshot.secondary).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (c) single-account-still-works smoke test
// ---------------------------------------------------------------------------

describe('single-account path intact', () => {
  it('normalizeQuotaHeaders works on a standard 200 response header set', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1781729038',
      'x-codex-secondary-used-percent': '15',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1781766665',
      'content-type': 'text/event-stream',
    })
    const snapshot = normalizeQuotaHeaders(h)
    expect(snapshot.primary?.usedPercent).toBe(42)
    expect(snapshot.secondary?.usedPercent).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// BUG 1 regression: createWebSocketFetch threads onQuota →
// streamResponsesWebSocket. A codex.rate_limits frame emitted by a fake
// socket MUST invoke the onQuota callback. This is the test that would have
// caught the dead-WS-quota bug BEFORE live dogfood.
// ---------------------------------------------------------------------------

describe('ws-pool onQuota wiring', () => {
  it('createWebSocketFetch threads onQuota into streamResponsesWebSocket', async () => {
    const { createWebSocketFetch } = await import('../ws-pool.ts')
    let onQuotaCalled = false

    // Registry so tests can reach the FakeWS instance the pool created
    const liveSockets: InstanceType<typeof FakeWS>[] = []

    class FakeWS {
      static OPEN = 1
      url: string
      readyState = 1
      private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

      constructor(url: string) {
        this.url = url
        liveSockets.push(this)
        queueMicrotask(() => this.emit('open', {}))
      }

      addEventListener(
        type: string,
        fn: (...args: unknown[]) => void,
        _opts?: unknown,
      ) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set())
        this.listeners.get(type)!.add(fn)
      }

      removeEventListener(type: string, fn: (...args: unknown[]) => void) {
        this.listeners.get(type)?.delete(fn)
      }

      send(data: string) {
        // Auto-complete prewarm (generate:false body) so the main turn
        // can proceed. Without this the prewarm drain() blocks forever
        // and onQuota is never wired into the active onMessage handler.
        try {
          const body = JSON.parse(data) as Record<string, unknown>
          if (body.generate === false) {
            this.emit('message', {
              data: JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_prewarm', usage: {} },
              }),
            } as MessageEvent)
          }
        } catch {}
      }

      close() {
        liveSockets.splice(liveSockets.indexOf(this), 1)
      }

      private emit(type: string, event: unknown) {
        for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
      }

      write(data: string) {
        this.emit('message', { data } as MessageEvent)
      }
    }

    const OriginalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket

    try {
      const wsf = createWebSocketFetch({
        url: 'https://example.test/backend-api/codex/responses',
        onQuota: () => {
          onQuotaCalled = true
        },
      })

      // Send a WS-bound stream request — triggers socket connect + send
      const responsePromise = wsf(
        'https://example.test/backend-api/codex/responses',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'session-id': 'test_ws_quota',
          },
          body: JSON.stringify({
            model: 'gpt-5.5',
            stream: true,
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            ],
          }),
        },
      )

      // Wait for the pool to connect, attach onMessage, send response.create
      await new Promise((r) => setTimeout(r, 20))

      // Find the pool's FakeWS instance and emit a codex.rate_limits frame
      const ws = liveSockets[0]
      expect(ws).toBeDefined()
      ws?.write(
        JSON.stringify({
          type: 'codex.rate_limits',
          rate_limits: {
            primary: { used_percent: 25, window_minutes: 300, reset_at: 1 },
          },
        }),
      )

      // Small delay for onMessage to process the frame
      await new Promise((r) => setTimeout(r, 5))

      // onQuota MUST have been called — this is the regression test
      expect(onQuotaCalled).toBe(true)

      // Complete the stream to clean up
      ws?.write(
        JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_1', usage: {} },
        }),
      )
      await responsePromise
      wsf.close()
    } finally {
      globalThis.WebSocket = OriginalWebSocket
    }
  })
})
