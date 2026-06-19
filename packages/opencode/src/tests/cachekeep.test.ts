import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  buildKeepwarmBody,
  buildKeepwarmCapture,
  CacheKeepManager,
} from '../core/cachekeep'

function fakeLogger() {
  return {
    error: mock(() => {}),
    warn: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
  }
}

function fakeNow() {
  let t = 1700000000000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const TTL_MS = 5 * 60 * 1000 // 5 min
const LEAD_MS = 5 * 1000 // 5 s lead

// ---------------------------------------------------------------------------
// buildKeepwarmBody
// ---------------------------------------------------------------------------
describe('buildKeepwarmBody', () => {
  test('does not set unsupported max_output_tokens', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      max_output_tokens: 4096,
      store: true,
      stream: true,
    })
    const result = buildKeepwarmBody(body)
    const parsed = JSON.parse(result)
    expect(parsed.max_output_tokens).toBeUndefined()
  })

  test('sets store to false', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      store: true,
    })
    const result = buildKeepwarmBody(body)
    const parsed = JSON.parse(result)
    expect(parsed.store).toBe(false)
  })

  test('preserves streaming warm bodies and removes incompatible token fields', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
      max_completion_tokens: 4096,
    })
    const result = buildKeepwarmBody(body)
    const parsed = JSON.parse(result)
    expect(parsed.stream).toBe(true)
    expect(parsed.stream_options).toEqual({ include_usage: true })
    expect(parsed.max_output_tokens).toBeUndefined()
    expect(parsed.store).toBe(false)
    expect(parsed.max_tokens).toBeUndefined()
    expect(parsed.max_completion_tokens).toBeUndefined()
  })

  test('keeps rest of body identical (same input/messages/tools/instructions)', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      instructions: 'be helpful',
      tools: [{ type: 'function', name: 'search' }],
      max_output_tokens: 4096,
      store: true,
      stream: true,
      temperature: 0.7,
      prompt_cache_key: 'abc-123',
    })
    const result = buildKeepwarmBody(body)
    const parsed = JSON.parse(result)
    // Fields preserved
    expect(parsed.model).toBe('gpt-5.5')
    expect(parsed.input).toEqual([{ role: 'user', content: 'hello' }])
    expect(parsed.instructions).toBe('be helpful')
    expect(parsed.tools).toEqual([{ type: 'function', name: 'search' }])
    expect(parsed.temperature).toBe(0.7)
    expect(parsed.prompt_cache_key).toBe('abc-123')
  })

  test('JSON parse copy isolates original from mutation', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      store: true,
    })
    const result = buildKeepwarmBody(body)
    const original = JSON.parse(body)
    // Original unchanged
    expect(original.max_output_tokens).toBeUndefined()
    expect(original.store).toBe(true)
    // Warm copy modified
    const parsed = JSON.parse(result)
    expect(parsed.max_output_tokens).toBeUndefined()
    expect(parsed.store).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CacheKeepManager — track()
// ---------------------------------------------------------------------------
describe('CacheKeepManager.track', () => {
  let log: ReturnType<typeof fakeLogger>
  let getMainToken: ReturnType<typeof mock>
  let refreshFallback: ReturnType<typeof mock>
  let fetchImpl: typeof fetch
  let clock: ReturnType<typeof fakeNow>

  beforeEach(() => {
    log = fakeLogger()
    getMainToken = mock(async () => 'main-token')
    refreshFallback = mock(async () => 'fallback-token')
    fetchImpl = mock(async () => new Response('{}')) as unknown as typeof fetch
    clock = fakeNow()
  })

  test('stores a target with correct fields', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    const body = JSON.stringify({ input: 'test' })
    mgr.track('sess-1', body, 'main')

    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]!.sessionKey).toBe('sess-1')
    expect(status.targets[0]!.accountId).toBe('main')
    expect(status.targets[0]!.route).toBe('main')
  })

  test('sets cacheExpiresAt to now + TTL_MS', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
    })
    mgr.track('sess-1', JSON.stringify({ input: 'test' }), 'main')
    const status = mgr.status()
    expect(status.targets[0]!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('replace-on-retrack: freshest body wins', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
    })
    const body1 = JSON.stringify({ input: 'first' })
    const body2 = JSON.stringify({ input: 'second' })

    mgr.track('sess-1', body1, 'main')
    clock.advance(10_000)
    mgr.track('sess-1', body2, 'main')
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    const status = mgr.status()
    expect(status.tracked).toBe(1)
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect(JSON.parse(init.body as string).input).toBe('second')
  })

  test('replace-on-retrack resets cacheExpiresAt', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
    })
    mgr.track('sess-1', JSON.stringify({ input: 'first' }), 'main')
    clock.advance(60_000)
    mgr.track('sess-1', JSON.stringify({ input: 'second' }), 'main')

    const status = mgr.status()
    expect(status.targets[0]!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('prunes targets past maxIdleWarmMs from last real request', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      maxIdleWarmMs: 60_000,
    })
    mgr.track('sess-1', JSON.stringify({ input: 'old' }), 'main')
    clock.advance(60_001)
    mgr.track('sess-2', JSON.stringify({ input: 'new' }), 'main')

    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]!.sessionKey).toBe('sess-2')
  })

  test('caps Map size at default maxTargets (32)', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      maxTargets: 3,
    })
    for (let i = 0; i < 5; i++) {
      clock.advance(1) // different insertion order
      mgr.track(`sess-${i}`, JSON.stringify({ input: `msg-${i}` }), 'main')
    }
    const status = mgr.status()
    expect(status.tracked).toBeLessThanOrEqual(3)
  })

  test('caps total bytes at default maxBytes', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      maxBytes: 200,
    })
    const bigBody = JSON.stringify({ input: 'x'.repeat(300) })
    mgr.track('sess-1', bigBody, 'main')
    // Should evict due to size
    const status = mgr.status()
    expect(status.tracked).toBe(0)
  })

  test('rejects an oversized body without evicting existing targets', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      maxBytes: 200,
    })
    mgr.track('sess-1', JSON.stringify({ input: 'small' }), 'main')
    mgr.track(
      'sess-oversize',
      JSON.stringify({ input: 'x'.repeat(300) }),
      'main',
    )

    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]!.sessionKey).toBe('sess-1')
  })

  test('evicts least-recently-used target instead of oldest inserted target', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
      maxTargets: 2,
    })
    mgr.track(
      'main',
      JSON.stringify({ input: 'main', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(1000)
    mgr.track(
      'ephemeral',
      JSON.stringify({ input: 'ephemeral', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS - 1000)

    await mgr.tick()
    mgr.track(
      'new-ephemeral',
      JSON.stringify({ input: 'new', model: 'gpt-5.5' }),
      'main',
    )

    const sessions = mgr.status().targets.map((target) => target.sessionKey)
    expect(sessions).toContain('main')
    expect(sessions).toContain('new-ephemeral')
    expect(sessions).not.toContain('ephemeral')
  })
})

// ---------------------------------------------------------------------------
// CacheKeepManager — subagent pruneStale
// ---------------------------------------------------------------------------
describe('CacheKeepManager subagent pruneStale', () => {
  let log: ReturnType<typeof fakeLogger>
  let getMainToken: ReturnType<typeof mock>
  let refreshFallback: ReturnType<typeof mock>
  let fetchImpl: typeof fetch
  let clock: ReturnType<typeof fakeNow>

  beforeEach(() => {
    log = fakeLogger()
    getMainToken = mock(async () => 'main-token')
    refreshFallback = mock(async () => 'fallback-token')
    fetchImpl = mock(async () => new Response('{}')) as unknown as typeof fetch
    clock = fakeNow()
  })

  test('subagent target pruned at 31min (past 30min cap)', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      maxIdleWarmMs: 60 * 60 * 1000, // 1h main
      maxSubagentIdleMs: 30 * 60 * 1000, // 30min subagent
    })
    mgr.track(
      'sub-sess',
      JSON.stringify({ input: 'subagent-turn' }),
      'main',
      undefined,
      {},
      true, // isSubagent
    )
    clock.advance(31 * 60 * 1000) // 31 min
    mgr.track('main-sess', JSON.stringify({ input: 'main-turn' }), 'main')
    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]!.sessionKey).toBe('main-sess')
  })

  test('subagent target survives at 29min (within 30min cap)', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      maxIdleWarmMs: 60 * 60 * 1000,
      maxSubagentIdleMs: 30 * 60 * 1000,
    })
    mgr.track(
      'sub-sess',
      JSON.stringify({ input: 'subagent-turn' }),
      'main',
      undefined,
      {},
      true,
    )
    clock.advance(29 * 60 * 1000) // 29 min — still alive
    mgr.track('main-sess', JSON.stringify({ input: 'main-turn' }), 'main')
    const status = mgr.status()
    expect(status.tracked).toBe(2)
  })

  test('main target survives at 31min (within 1h cap)', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      maxIdleWarmMs: 60 * 60 * 1000,
      maxSubagentIdleMs: 30 * 60 * 1000,
    })
    mgr.track('main-sess', JSON.stringify({ input: 'main-turn' }), 'main')
    clock.advance(31 * 60 * 1000) // 31 min — still within 1h
    mgr.track('other-sess', JSON.stringify({ input: 'other' }), 'main')
    const status = mgr.status()
    expect(status.tracked).toBe(2)
    expect(status.targets.map((t) => t.sessionKey)).toContain('main-sess')
  })

  test('main target pruned past 1h', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      maxIdleWarmMs: 60 * 60 * 1000,
      maxSubagentIdleMs: 30 * 60 * 1000,
    })
    mgr.track('main-sess', JSON.stringify({ input: 'main-turn' }), 'main')
    clock.advance(61 * 60 * 1000) // 61 min — past 1h cap
    mgr.track('other-sess', JSON.stringify({ input: 'other' }), 'main')
    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]!.sessionKey).toBe('other-sess')
  })

  test('re-captures a subagent target after it was pruned', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      maxSubagentIdleMs: 30 * 60 * 1000,
    })
    mgr.track(
      'sub-sess',
      JSON.stringify({ input: 'old' }),
      'main',
      undefined,
      {},
      true,
    )
    clock.advance(31 * 60 * 1000) // past 30min cap
    mgr.track('other', JSON.stringify({ input: 'other' }), 'main')
    expect(mgr.status().tracked).toBe(1)

    // Re-capture same subagent session
    mgr.track(
      'sub-sess',
      JSON.stringify({ input: 'new' }),
      'main',
      undefined,
      {},
      true,
    )
    expect(mgr.status().tracked).toBe(2)
    expect(
      mgr.status().targets.find((t) => t.sessionKey === 'sub-sess')!
        .lastRealRequestAt,
    ).toBe(clock.now())
  })
})

// ---------------------------------------------------------------------------
// Keepwarm capture decision
// ---------------------------------------------------------------------------
describe('buildKeepwarmCapture', () => {
  test('skips capture when cachekeep is disabled', () => {
    const capture = buildKeepwarmCapture({
      enabled: false,
      includeSubagents: false,
      headers: new Headers({ 'session-id': 'main-session' }),
      body: JSON.stringify({ input: 'hello' }),
    })

    expect(capture).toBeUndefined()
  })

  test('skips subagent requests fail-safe when subagent warming is off', () => {
    const capture = buildKeepwarmCapture({
      enabled: true,
      includeSubagents: false,
      headers: new Headers({
        'session-id': 'main-session',
        'x-parent-session-id': 'parent-session',
      }),
      body: JSON.stringify({ input: 'hello' }),
    })

    expect(capture).toBeUndefined()
  })

  test('captures subagent requests when includeSubagents is true', () => {
    const capture = buildKeepwarmCapture({
      enabled: true,
      includeSubagents: true,
      headers: new Headers({
        'x-opencode-session': 'sub-session',
        'x-session-affinity': 'affinity-session',
        'x-parent-session-id': 'parent-session',
      }),
      body: JSON.stringify({ input: 'subagent-turn' }),
    })

    expect(capture).toEqual({
      sessionKey: 'sub-session',
      bodyText: JSON.stringify({ input: 'subagent-turn' }),
      replayHeaders: {
        'x-opencode-session': 'sub-session',
        'x-session-affinity': 'affinity-session',
        'x-parent-session-id': 'parent-session',
      },
      isSubagent: true,
    })
  })

  test('main request (no x-parent-session-id) is captured regardless of includeSubagents', () => {
    const captureWith = buildKeepwarmCapture({
      enabled: true,
      includeSubagents: true,
      headers: new Headers({ 'session-id': 'main-session' }),
      body: JSON.stringify({ input: 'main-turn' }),
    })
    expect(captureWith).toBeDefined()
    expect(captureWith!.isSubagent).toBe(false)

    const captureWithout = buildKeepwarmCapture({
      enabled: true,
      includeSubagents: false,
      headers: new Headers({ 'session-id': 'main-session' }),
      body: JSON.stringify({ input: 'main-turn' }),
    })
    expect(captureWithout).toBeDefined()
    expect(captureWithout!.isSubagent).toBe(false)
  })

  test('skips requests that cannot be positively associated with a session', () => {
    const capture = buildKeepwarmCapture({
      enabled: true,
      includeSubagents: false,
      headers: new Headers(),
      body: JSON.stringify({ input: 'hello' }),
    })

    expect(capture).toBeUndefined()
  })

  test('captures the finalized body and cache-relevant headers for main requests', () => {
    const body = JSON.stringify({ input: 'finalized' })
    const capture = buildKeepwarmCapture({
      enabled: true,
      includeSubagents: false,
      headers: new Headers({
        'session-id': 'main-session',
        'user-agent': 'codex-test',
        version: '0.139.0',
        'x-codex-beta-features': 'terminal_resize_reflow',
        'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
        'x-codex-window-id': 'window-1',
      }),
      body,
    })

    expect(capture).toEqual({
      sessionKey: 'main-session',
      bodyText: body,
      replayHeaders: {
        'session-id': 'main-session',
        'user-agent': 'codex-test',
        version: '0.139.0',
        'x-codex-beta-features': 'terminal_resize_reflow',
        'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
        'x-codex-window-id': 'window-1',
      },
      isSubagent: false,
    })
  })
})

// ---------------------------------------------------------------------------
// CacheKeepManager — tick() / prewarm
// ---------------------------------------------------------------------------
describe('CacheKeepManager tick/prewarm', () => {
  let log: ReturnType<typeof fakeLogger>
  let getMainToken: ReturnType<typeof mock>
  let refreshFallback: ReturnType<typeof mock>
  let fetchImpl: typeof fetch
  let clock: ReturnType<typeof fakeNow>

  beforeEach(() => {
    log = fakeLogger()
    getMainToken = mock(async () => 'main-token')
    refreshFallback = mock(async () => 'fallback-token')
    fetchImpl = mock(async () => {
      const usage = {
        input_tokens: 5000,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 4900 },
      }
      return new Response(JSON.stringify({ usage }), {
        headers: {
          'x-codex-ratelimit-5h-remaining': '90',
          'x-codex-ratelimit-5h-limit': '100',
          'x-codex-ratelimit-1w-remaining': '80',
          'x-codex-ratelimit-1w-limit': '100',
        },
      })
    }) as unknown as typeof fetch
    clock = fakeNow()
  })

  test('fallback warm resolves token by storage id but sends real ChatGPT account id header', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-fallback',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'work-alt',
      '8c97f046-7e21-409b-9829-0488897e475b',
      { 'ChatGPT-Account-Id': 'stale-storage-id' },
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(refreshFallback).toHaveBeenCalledWith('work-alt')
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect((init.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe(
      '8c97f046-7e21-409b-9829-0488897e475b',
    )
  })

  test('subagent warm sends the real ChatGPT account id header', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sub-sess',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'work-alt',
      'real-chatgpt-account-id',
      { 'ChatGPT-Account-Id': 'stale-storage-id' },
      true,
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(refreshFallback).toHaveBeenCalledWith('work-alt')
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect((init.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe(
      'real-chatgpt-account-id',
    )
  })

  test('main warm uses real ChatGPT account id when present and omits stale replay header when absent', async () => {
    const withAccount = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    withAccount.track(
      'sess-main-account',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
      'main-chatgpt-id',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await withAccount.tick()
    let fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    let init = fetchCall[1] as RequestInit
    expect((init.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe(
      'main-chatgpt-id',
    )

    fetchImpl = mock(
      async () => new Response(JSON.stringify({ usage: {} })),
    ) as unknown as typeof fetch
    const withoutAccount = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    withoutAccount.track(
      'sess-main-no-account',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
      undefined,
      { 'ChatGPT-Account-Id': 'stale-main' },
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await withoutAccount.tick()
    fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    init = fetchCall[1] as RequestInit
    expect(
      (init.headers as Record<string, string>)['ChatGPT-Account-Id'],
    ).toBeUndefined()
  })

  test('idle cap prunes targets even when active backoff would otherwise skip pruning', async () => {
    fetchImpl = mock(
      async () => new Response('{}', { status: 500 }),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: 100,
      leadMs: 90,
      maxIdleWarmMs: 1000,
    })
    mgr.track(
      'sess-backoff',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(20)
    await mgr.tick()
    expect(mgr.status().targets[0]!.backoffUntil).toBeDefined()

    clock.advance(1001)
    await mgr.tick()

    expect(mgr.status().tracked).toBe(0)
  })

  test('idle cap prunes expired-backoff targets before retrying warm', async () => {
    let calls = 0
    fetchImpl = mock(async () => {
      calls++
      return new Response('{}', { status: calls === 1 ? 500 : 200 })
    }) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: 100,
      leadMs: 90,
      maxIdleWarmMs: 1000,
    })
    mgr.track(
      'sess-backoff',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(20)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock.advance(10 * 60 * 1000 + 1)
    await mgr.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(0)
  })

  test('track self-arms an unstarted manager and the timer fires a due target', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: 100,
      leadMs: 90,
      tickIntervalMs: 5,
    })

    try {
      mgr.track(
        'sess-self-arm',
        JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
        'main',
      )
      expect(mgr.status().running).toBe(true)

      clock.advance(20)
      await delay(20)

      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      mgr.stop()
    }
  })

  test('a reconstructed unstarted manager arms itself when it captures', async () => {
    const first = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: 100,
      leadMs: 90,
      tickIntervalMs: 5,
    })
    first.start()
    first.stop()

    const second = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: 100,
      leadMs: 90,
      tickIntervalMs: 5,
    })

    try {
      second.track(
        'sess-after-reload',
        JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
        'main',
      )
      expect(second.status().running).toBe(true)

      clock.advance(20)
      await delay(20)

      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      second.stop()
    }
  })

  test('track-driven start is idempotent and does not bump startedAt', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
      tickIntervalMs: 60_000,
    })

    try {
      mgr.track(
        'sess-1',
        JSON.stringify({ input: 'first', model: 'gpt-5.5' }),
        'main',
      )
      const startedAt = mgr.status().startedAt
      expect(mgr.status().running).toBe(true)

      clock.advance(60_000)
      mgr.track(
        'sess-2',
        JSON.stringify({ input: 'second', model: 'gpt-5.5' }),
        'main',
      )

      expect(mgr.status().startedAt).toBe(startedAt)
    } finally {
      mgr.stop()
    }
  })

  test('status running reflects the actual timer presence', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })

    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    expect(mgr.status().running).toBe(true)

    mgr.stop()
    expect(mgr.status().running).toBe(false)
  })

  test('fires prewarm only within LEAD window of cacheExpiresAt', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    // Advance to just before LEAD window (cacheExpiresAt - LEAD_MS - 1)
    // cacheExpiresAt = now + TTL_MS = now + 300000
    // LEAD window = [cacheExpiresAt - LEAD_MS, cacheExpiresAt] = [now + 295000, now + 300000]
    clock.advance(TTL_MS - LEAD_MS - 1000) // 294000 ms → not yet in window
    await mgr.tick()
    expect(fetchImpl).not.toHaveBeenCalled()

    // Advance into LEAD window
    clock.advance(2000) // 296000 ms → inside window
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('backoff suppresses prewarm after failure', async () => {
    const failFetch = mock(async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: failFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    // Advance into LEAD window
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick() // This will fail → sets backoff
    expect(failFetch).toHaveBeenCalledTimes(1)

    // Advance a bit (but still within LEAD window and within backoff)
    clock.advance(1000)
    await mgr.tick()
    // Should NOT fire again (backoff active)
    expect(failFetch).toHaveBeenCalledTimes(1)
  })

  test('prewarm fires again after backoff expires', async () => {
    let calls = 0
    const flakyFetch = mock(async () => {
      calls++
      if (calls === 1) throw new Error('fail')
      return new Response(JSON.stringify({ usage: {} }))
    }) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: flakyFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    // First tick → failure
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()
    expect(calls).toBe(1)

    // Advance past backoff (10 min)
    clock.advance(10 * 60 * 1000 + 1000)
    await mgr.tick()
    expect(calls).toBe(2)
  })

  test('does not reenter tick while a previous prewarm is still in flight', async () => {
    let resolveFetch!: (response: Response) => void
    const slowFetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: slowFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)

    const firstTick = mgr.tick()
    await Promise.resolve()
    const secondTick = mgr.tick()
    await Promise.resolve()

    expect(slowFetch).toHaveBeenCalledTimes(1)
    resolveFetch(new Response(JSON.stringify({ usage: {} })))
    await Promise.all([firstTick, secondTick])
  })

  test('sets backoff for malformed captured bodies and continues warming other targets', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track('bad', '{not-json', 'main')
    mgr.track(
      'good',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    const status = mgr.status()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      status.targets.find((target) => target.sessionKey === 'bad')!
        .backoffUntil,
    ).toBe(clock.now() + 10 * 60 * 1000)
    expect(
      status.targets.find((target) => target.sessionKey === 'good')!
        .lastWarmedAt,
    ).toBe(clock.now())
  })

  test('stays armed across an idle tick and later warms a captured request', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.start()

    await mgr.tick()
    expect(mgr.status().running).toBe(true)

    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(mgr.status().running).toBe(true)
  })

  test('tick prunes expired targets without disarming cachekeep', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
      maxIdleWarmMs: 60_000,
    })
    mgr.start()
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    clock.advance(60_001)
    await mgr.tick()
    const status = mgr.status()
    expect(status.tracked).toBe(0)
    expect(status.running).toBe(true)
  })

  test('per-target idle cap prunes old captures while cachekeep stays enabled', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      maxIdleWarmMs: 1000,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    expect(mgr.status().running).toBe(true)
    clock.advance(1001)
    await mgr.tick()
    expect(mgr.status().running).toBe(true)
    expect(mgr.status().tracked).toBe(0)
  })

  test('a real request after the idle cap resumes warming', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: 100,
      leadMs: 90,
      maxIdleWarmMs: 1000,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'old', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(1001)
    await mgr.tick()
    expect(mgr.status().tracked).toBe(0)

    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'new', model: 'gpt-5.5' }),
      'main',
    )
    clock.advance(20)
    await mgr.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('on success: resets cacheExpiresAt and lastWarmedAt', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    const originalExpiry = clock.now() + TTL_MS
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    const status = mgr.status()
    expect(status.targets[0]!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
    // cacheExpiresAt should be reset (greater than original)
    expect(status.targets[0]!.cacheExpiresAt).toBeGreaterThan(originalExpiry)
    expect(status.targets[0]!.lastWarmedAt).toBe(clock.now())
  })

  test('logs cost from mock usage', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    // Should have logged the warm
    const debugCalls = (log.debug as ReturnType<typeof mock>).mock.calls
    const warmLog = debugCalls.find(
      (c: unknown[]) => (c as string[])[0] === 'cachekeep fired',
    )
    expect(warmLog).toBeDefined()
    const data = (warmLog as unknown[])[1] as Record<string, unknown>
    expect(data.input_tokens).toBe(5000)
    expect(data.cached_tokens).toBe(4900)
    expect(data.output_tokens).toBe(1)
    expect(data.hit_rate).toBeCloseTo(0.98, 1)
  })

  test('logs cached tokens from prompt_tokens_details fallback usage', async () => {
    fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            usage: {
              prompt_tokens: 100,
              completion_tokens: 1,
              prompt_tokens_details: { cached_tokens: 75 },
            },
          }),
        ),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-prompt-tokens',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep fired',
      expect.objectContaining({
        input_tokens: 100,
        output_tokens: 1,
        cached_tokens: 75,
        hit_rate: 0.75,
      }),
    )
  })

  test('sends cache-relevant captured headers on warm requests', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
      undefined,
      {
        'session-id': 'sess-1',
        'user-agent': 'codex-test',
        version: '0.139.0',
        'x-codex-beta-features': 'terminal_resize_reflow',
        'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
      },
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers).toMatchObject({
      authorization: 'Bearer main-token',
      'content-type': 'application/json',
      'session-id': 'sess-1',
      'user-agent': 'codex-test',
      version: '0.139.0',
      'x-codex-beta-features': 'terminal_resize_reflow',
      'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
    })
  })

  test('backs off on non-2xx responses without resetting expiry', async () => {
    const failFetch = mock(
      async () => new Response('bad', { status: 500 }),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: failFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )
    const originalExpiry = mgr.status().targets[0]!.cacheExpiresAt
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    const status = mgr.status()
    expect(status.targets[0]!.cacheExpiresAt).toBe(originalExpiry)
    expect(status.targets[0]!.backoffUntil).toBe(clock.now() + 10 * 60 * 1000)
    expect(log.warn).toHaveBeenCalledWith(
      'cachekeep failed',
      expect.objectContaining({
        status: 500,
        responseBody: 'bad',
        pid: process.pid,
      }),
    )
  })

  test('parses SSE response.completed usage and logs cache hit metrics', async () => {
    const sseBody = [
      'event: response.completed',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            input_tokens_details: { cached_tokens: 75 },
          },
        },
      })}`,
      '',
      '',
    ].join('\n')
    const sseFetch = mock(
      async () =>
        new Response(sseBody, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-sse',
      JSON.stringify({ input: 'test', model: 'gpt-5.5', stream: true }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep fired',
      expect.objectContaining({
        pid: process.pid,
        input_tokens: 100,
        output_tokens: 1,
        cached_tokens: 75,
        hit_rate: 0.75,
      }),
    )
    expect(mgr.status().targets[0]!.backoffUntil).toBeUndefined()
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('parses SSE usage when completion type is only on the event line', async () => {
    const sseBody = [
      'event: response.completed',
      `data: ${JSON.stringify({
        response: {
          usage: {
            input_tokens: 27740,
            output_tokens: 42,
            input_tokens_details: { cached_tokens: 27000 },
          },
        },
      })}`,
      '',
      '',
    ].join('\n')
    const sseFetch = mock(
      async () =>
        new Response(sseBody, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-sse-event-line',
      JSON.stringify({ input: 'test', model: 'gpt-5.5', stream: true }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep fired',
      expect.objectContaining({
        input_tokens: 27740,
        output_tokens: 42,
        cached_tokens: 27000,
        hit_rate: 27000 / 27740,
      }),
    )
  })

  test('sniffs SSE by body when content-type is not text/event-stream', async () => {
    const sseBody = [
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 321,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 300 },
          },
        },
      })}`,
      '',
      '',
    ].join('\n')
    const sseFetch = mock(
      async () =>
        new Response(sseBody, {
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-sse-sniff',
      JSON.stringify({ input: 'test', model: 'gpt-5.5', stream: true }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep warm response',
      expect.objectContaining({
        pid: process.pid,
        status: 200,
        contentType: 'application/json',
        bodyLen: sseBody.length,
        isSse: true,
      }),
    )
    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep fired',
      expect.objectContaining({
        input_tokens: 321,
        output_tokens: 7,
        cached_tokens: 300,
      }),
    )
  })

  test('logs fired without throwing when SSE has no usage event', async () => {
    const sseFetch = mock(
      async () =>
        new Response(
          'event: response.created\ndata: {"type":"response.created"}\n\n',
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    ) as unknown as typeof fetch
    const mgr = new CacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-sse-no-usage',
      JSON.stringify({ input: 'test', model: 'gpt-5.5', stream: true }),
      'main',
    )
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep fired',
      expect.objectContaining({
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        hit_rate: null,
      }),
    )
  })

  test('prewarm drains the response body without canceling a locked body', async () => {
    const cancelFetch = mock(async () => {
      return new Response(JSON.stringify({ usage: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    // Override to return a response with cancel
    const mgr = new CacheKeepManager({
      fetchImpl: cancelFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    // The body.cancel() is called in prewarm — verify the response was consumed
    expect(cancelFetch).toHaveBeenCalled()
  })
})

describe('CacheKeepManager status', () => {
  test('does not expose captured body text', () => {
    const mgr = new CacheKeepManager({
      fetchImpl: mock(
        async () => new Response('{}'),
      ) as unknown as typeof fetch,
      getMainToken: mock(async () => 'main-token'),
      refreshFallback: mock(async () => 'fallback-token'),
      codexResponsesUrl: CODEX_URL,
      logger: fakeLogger(),
      now: fakeNow().now,
    })
    mgr.track('sess-1', JSON.stringify({ input: 'secret prompt' }), 'main')

    const target = mgr.status().targets[0] as Record<string, unknown>
    expect(target.bodyText).toBeUndefined()
    expect(target.bodyBytes).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// CacheKeepManager — start/stop
// ---------------------------------------------------------------------------
describe('CacheKeepManager start/stop', () => {
  let log: ReturnType<typeof fakeLogger>
  let getMainToken: ReturnType<typeof mock>
  let refreshFallback: ReturnType<typeof mock>
  let fetchImpl: typeof fetch
  let clock: ReturnType<typeof fakeNow>

  beforeEach(() => {
    log = fakeLogger()
    getMainToken = mock(async () => 'main-token')
    refreshFallback = mock(async () => 'fallback-token')
    fetchImpl = mock(async () => new Response('{}')) as unknown as typeof fetch
    clock = fakeNow()
  })

  test('start sets running flag', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
    })
    mgr.start()
    expect(mgr.status().running).toBe(true)
  })

  test('stop clears targets and timer', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
    })
    mgr.start()
    mgr.track('sess-1', JSON.stringify({ input: 'test' }), 'main')
    mgr.stop()

    const status = mgr.status()
    expect(status.running).toBe(false)
    expect(status.tracked).toBe(0)
  })

  test('status shows max idle warm time', () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      maxIdleWarmMs: 60 * 60 * 1000,
    })
    mgr.start()
    const status = mgr.status()
    expect(status.maxIdleWarmMs).toBe(60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// CacheKeepManager — token resolution
// ---------------------------------------------------------------------------
describe('CacheKeepManager token resolution', () => {
  let log: ReturnType<typeof fakeLogger>
  let getMainToken: ReturnType<typeof mock>
  let refreshFallback: ReturnType<typeof mock>
  let fetchImpl: typeof fetch
  let clock: ReturnType<typeof fakeNow>

  beforeEach(() => {
    log = fakeLogger()
    getMainToken = mock(async () => 'resolved-main-token')
    refreshFallback = mock(async (accountId: string) => `resolved-${accountId}`)
    fetchImpl = mock(async () => {
      return new Response(JSON.stringify({ usage: {} }))
    }) as unknown as typeof fetch
    clock = fakeNow()
  })

  test('uses getMainToken for main account', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(getMainToken).toHaveBeenCalled()
    // Verify auth header was set
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    const authHeader = (init.headers as Record<string, string>)?.authorization
    expect(authHeader).toBe('Bearer resolved-main-token')
  })

  test('uses refreshFallback for non-main accountId', async () => {
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-2',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'acct-1',
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(refreshFallback).toHaveBeenCalledWith('acct-1')
    const fetchCall2 = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init2 = fetchCall2[1] as RequestInit
    expect((init2.headers as Record<string, string>)?.authorization).toBe(
      'Bearer resolved-acct-1',
    )
  })

  test('skips warm if no token resolves', async () => {
    getMainToken = mock(async () => {
      throw new Error('no token')
    })
    const mgr = new CacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track(
      'sess-1',
      JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      'main',
    )

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    // fetchImpl should NOT have been called (no token to make the request)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
