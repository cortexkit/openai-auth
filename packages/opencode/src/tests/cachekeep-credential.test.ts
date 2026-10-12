import { expect, test } from 'bun:test'
import {
  createCacheKeepManager,
  type OpenAICacheKeepAdapterOptions,
} from '../core/cachekeep'

for (const custody of ['local', 'vault'] as const) {
  for (const failure of ['http', 'throw', 'read'] as const) {
    test(`keep-warm ${custody} ${failure} diagnostics scrub the exact warm credential before logging`, async () => {
      const token = 'opaque-warm-attempt-secret'
      const split = `${token.slice(0, 12)}\r\n${token.slice(12)}`
      const logs: unknown[] = []
      const record = (...args: unknown[]) => {
        logs.push(args)
      }
      const logger = {
        error: record,
        warn: record,
        info: record,
        debug: record,
        trace: record,
      }
      let now = 1_700_000_000_000
      let sends = 0
      let authorized = 0
      let reads = 0
      const vault: OpenAICacheKeepAdapterOptions['vault'] =
        custody === 'vault'
          ? {
              owns: (id) => id === 'vault-warm',
              authority: async () => 'local',
              send: async (_id, dispatch) => {
                authorized++
                return dispatch(token, {} as never)
              },
            }
          : undefined
      const manager = createCacheKeepManager({
        vault,
        logger,
        now: () => now,
        ttlMs: 300_000,
        leadMs: 5_000,
        getMainToken: async () => token,
        refreshFallback: async () => token,
        codexResponsesUrl: 'https://example.invalid/responses',
        fetchImpl: (async (_input, init) => {
          sends++
          expect(new Headers(init?.headers).get('authorization')).toBe(
            `Bearer ${token}`,
          )
          const diagnostic = `Refused ${token}; wrapped ${split}`
          if (failure === 'throw') throw new Error(diagnostic)
          if (failure === 'read')
            return new Response(
              new ReadableStream<Uint8Array>({
                pull() {
                  reads++
                  throw new Error(diagnostic)
                },
              }),
            )
          return new Response(diagnostic, { status: 429 })
        }) as typeof fetch,
      })
      try {
        manager.track({
          sessionKey: 'warm-audit',
          accountId: custody === 'vault' ? 'vault-warm' : 'main',
          bodyText: '{"model":"legacy-model","input":"hello"}',
          meta: { replayHeaders: {} },
        })
        now += 295_000
        await manager.tick()
        expect(sends).toBe(1)
        expect(authorized).toBe(custody === 'vault' ? 1 : 0)
        const retained = JSON.stringify(logs)
        expect(retained).not.toContain(token)
        expect(retained).not.toContain(token.slice(12))
        if (failure !== 'read') expect(retained).toContain('[credential]')
        else expect(reads).toBe(1)
        expect(JSON.stringify(manager.status())).not.toContain(token)
      } finally {
        manager.stop()
      }
    })
  }
}
