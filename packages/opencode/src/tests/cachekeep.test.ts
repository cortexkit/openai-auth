import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import { getConfigPath } from '../config'
import {
  buildKeepwarmBody,
  buildKeepwarmCapture,
  createCacheKeepManager,
  getCacheKeepWindow,
  openaiCacheKeepProfile,
  routedAccountForSession,
  ttlForModel,
} from '../core/cachekeep'
import { CodexAuthPlugin } from '../index'
import {
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  getSidebarState,
  hashSidebarSessionId,
  type SidebarState,
} from '../sidebar-state'
import { rpcServerRegistry } from './fixtures/rpc-registry'

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
// ttlForModel
// ---------------------------------------------------------------------------
describe('ttlForModel', () => {
  const defaultTtl = 5 * 60 * 1000
  const longTtl = 30 * 60 * 1000

  test('returns 30min for gpt-5.6-sol body', () => {
    const body = JSON.stringify({ model: 'gpt-5.6-sol' })
    expect(ttlForModel(body, defaultTtl)).toBe(longTtl)
  })

  test('returns 30min for gpt-5.6-luna body', () => {
    const body = JSON.stringify({ model: 'gpt-5.6-luna' })
    expect(ttlForModel(body, defaultTtl)).toBe(longTtl)
  })

  test('returns 30min for gpt-5.6-terra body', () => {
    const body = JSON.stringify({ model: 'gpt-5.6-terra' })
    expect(ttlForModel(body, defaultTtl)).toBe(longTtl)
  })

  test('returns 30min for bare gpt-5.6 id', () => {
    const body = JSON.stringify({ model: 'gpt-5.6' })
    expect(ttlForModel(body, defaultTtl)).toBe(longTtl)
  })

  test('returns default for gpt-5.60 body (substring match would false-positive)', () => {
    // Hypothetical sibling id whose digits also contain "5.6" must not pick up
    // the gpt-5.6 cache TTL.
    const body = JSON.stringify({ model: 'gpt-5.60' })
    expect(ttlForModel(body, defaultTtl)).toBe(defaultTtl)
  })

  test('returns default for gpt-5.6x body (substring match would false-positive)', () => {
    const body = JSON.stringify({ model: 'gpt-5.6x' })
    expect(ttlForModel(body, defaultTtl)).toBe(defaultTtl)
  })

  test('returns default for gpt-5.5 body', () => {
    const body = JSON.stringify({ model: 'gpt-5.5' })
    expect(ttlForModel(body, defaultTtl)).toBe(defaultTtl)
  })

  test('returns default for gpt-5.4-mini body', () => {
    const body = JSON.stringify({ model: 'gpt-5.4-mini' })
    expect(ttlForModel(body, defaultTtl)).toBe(defaultTtl)
  })

  test('returns default for malformed JSON', () => {
    expect(ttlForModel('{not-json', defaultTtl)).toBe(defaultTtl)
  })

  test('returns default for body missing model field', () => {
    const body = JSON.stringify({ input: [{ role: 'user', content: 'hi' }] })
    expect(ttlForModel(body, defaultTtl)).toBe(defaultTtl)
  })

  test('returns default when model is not a string', () => {
    const body = JSON.stringify({ model: 42 })
    expect(ttlForModel(body, defaultTtl)).toBe(defaultTtl)
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
    const mgr = createCacheKeepManager({
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
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: body,
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    const status = mgr.status()
    expect(status.tracked).toBe(1)
    expect(status.targets[0]!.sessionKey).toBe('sess-1')
    expect(status.targets[0]!.accountId).toBe('main')
  })

  test('gpt-5.6 body uses 30-min cacheExpiresAt; non-5.6 body keeps 5-min', () => {
    const longTtl = 30 * 60 * 1000
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
    })
    mgr.track({
      sessionKey: 'sess-56',
      bodyText: JSON.stringify({ input: 'sol', model: 'gpt-5.6-sol' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'sess-55',
      bodyText: JSON.stringify({ input: 'old', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    const status = mgr.status()
    const solTarget = status.targets.find((t) => t.sessionKey === 'sess-56')!
    const oldTarget = status.targets.find((t) => t.sessionKey === 'sess-55')!
    expect(solTarget.cacheExpiresAt).toBe(clock.now() + longTtl)
    expect(oldTarget.cacheExpiresAt).toBe(clock.now() + TTL_MS)
  })

  test('gpt-5.6 profile is captured at track(): 30-min TTL for 5.6 bodies, default for 5.5/5.4/5.60', () => {
    // The profile is evaluated once at capture and kept on the target, so the
    // TTL each target reports is what its warms will use.
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
    })
    mgr.track({
      sessionKey: 'sol',
      bodyText: JSON.stringify({ input: 'sol', model: 'gpt-5.6-sol' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'luna',
      bodyText: JSON.stringify({ input: 'l', model: 'gpt-5.6-luna' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'bare',
      bodyText: JSON.stringify({ input: 'b', model: 'gpt-5.6' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'v55',
      bodyText: JSON.stringify({ input: '55', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'v54',
      bodyText: JSON.stringify({ input: '54', model: 'gpt-5.4-mini' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'v560',
      bodyText: JSON.stringify({ input: '560', model: 'gpt-5.60' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    mgr.track({
      sessionKey: 'malformed',
      bodyText: '{not-json',
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    const ttl = (key: string) =>
      mgr.status().targets.find((t) => t.sessionKey === key)!.ttlMs
    expect(ttl('sol')).toBe(30 * 60 * 1000)
    expect(ttl('luna')).toBe(30 * 60 * 1000)
    expect(ttl('bare')).toBe(30 * 60 * 1000)
    expect(ttl('v55')).toBe(TTL_MS)
    expect(ttl('v54')).toBe(TTL_MS)
    expect(ttl('v560')).toBe(TTL_MS)
    expect(ttl('malformed')).toBe(TTL_MS)
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
        'x-session-affinity': 'affinity-session',
        'x-parent-session-id': 'parent-session',
      },
      isSubagent: true,
    })
    expect(capture?.replayHeaders['x-opencode-session']).toBeUndefined()
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
        version: '0.144.0',
        'x-codex-beta-features': 'terminal_resize_reflow',
        'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
        'x-codex-window-id': 'window-1',
        'x-openai-internal-codex-responses-lite': 'true',
      }),
      body,
    })

    expect(capture).toEqual({
      sessionKey: 'main-session',
      bodyText: body,
      replayHeaders: {
        'session-id': 'main-session',
        'user-agent': 'codex-test',
        version: '0.144.0',
        'x-codex-beta-features': 'terminal_resize_reflow',
        'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
        'x-codex-window-id': 'window-1',
        'x-openai-internal-codex-responses-lite': 'true',
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
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-fallback',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'work-alt',
      meta: {
        replayHeaders: { 'ChatGPT-Account-Id': 'stale-storage-id' },
        chatgptAccountId: '8c97f046-7e21-409b-9829-0488897e475b',
      },
    })

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(refreshFallback).toHaveBeenCalledWith('work-alt')
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect(new Headers(init.headers).get('ChatGPT-Account-Id')).toBe(
      '8c97f046-7e21-409b-9829-0488897e475b',
    )
  })

  test('subagent warm sends the real ChatGPT account id header', async () => {
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sub-sess',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'work-alt',
      isSubagent: true,
      meta: {
        replayHeaders: { 'ChatGPT-Account-Id': 'stale-storage-id' },
        chatgptAccountId: 'real-chatgpt-account-id',
      },
    })

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(refreshFallback).toHaveBeenCalledWith('work-alt')
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect(new Headers(init.headers).get('ChatGPT-Account-Id')).toBe(
      'real-chatgpt-account-id',
    )
  })

  test('main warm uses real ChatGPT account id when present and omits stale replay header when absent', async () => {
    const withAccount = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    withAccount.track({
      sessionKey: 'sess-main-account',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {}, chatgptAccountId: 'main-chatgpt-id' },
    })
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await withAccount.tick()
    let fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    let init = fetchCall[1] as RequestInit
    expect(new Headers(init.headers).get('ChatGPT-Account-Id')).toBe(
      'main-chatgpt-id',
    )

    fetchImpl = mock(
      async () => new Response(JSON.stringify({ usage: {} })),
    ) as unknown as typeof fetch
    const withoutAccount = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    withoutAccount.track({
      sessionKey: 'sess-main-no-account',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: {
        replayHeaders: { 'ChatGPT-Account-Id': 'stale-main' },
        chatgptAccountId: undefined,
      },
    })
    clock.advance(TTL_MS - LEAD_MS + 1000)
    await withoutAccount.tick()
    fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    init = fetchCall[1] as RequestInit
    expect(new Headers(init.headers).get('ChatGPT-Account-Id')).toBeNull()
  })

  test('gpt-5.6 session: post-warm reset uses per-target 30-min TTL (not 5-min)', async () => {
    const longTtl = 30 * 60 * 1000
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS, // constructor default
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-56',
      bodyText: JSON.stringify({ input: 'sol', model: 'gpt-5.6-sol' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    // Sanity: initial expiry is now + 30 min, not now + 5 min
    const initialExpiry = mgr.status().targets[0]!.cacheExpiresAt
    expect(initialExpiry).toBe(clock.now() + longTtl)

    // Advance into the 30-min LEAD window
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()

    // Warm should have fired
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // Post-warm reset uses the per-target 30-min TTL, not the 5-min constructor default
    expect(mgr.status().targets[0]!.cacheExpiresAt).toBe(clock.now() + longTtl)
  })

  // ---- Piece B: gpt-5.6 subagent 2-warm cap -------------------------

  test('gpt-5.6 subagent warms exactly twice then is dropped from the map', async () => {
    const longTtl = 30 * 60 * 1000
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: longTtl,
      leadMs: LEAD_MS,
      maxSubagentIdleMs: 60 * 60 * 1000, // large so the idle prune doesn't fire first
      getSustain: () => true,
    })
    mgr.track({
      sessionKey: 'sub-56',
      bodyText: JSON.stringify({
        input: 'subagent-turn',
        model: 'gpt-5.6-sol',
      }),
      accountId: 'main',
      isSubagent: true,
      meta: { replayHeaders: {} },
    })

    // Lead window 1 → warm #1
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(1)

    // Lead window 2 → warm #2 → drop
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(mgr.status().tracked).toBe(0)

    // Lead window 3 → target is gone, no further fire
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('gpt-5.6 subagent is NOT idle-pruned before its 2 warms (cap governs)', async () => {
    const longTtl = 30 * 60 * 1000
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: longTtl,
      leadMs: LEAD_MS,
      maxSubagentIdleMs: 30 * 60 * 1000, // same as TTL — would prune pre-change
      getSustain: () => true,
    })
    mgr.track({
      sessionKey: 'sub-56',
      bodyText: JSON.stringify({
        input: 'subagent-turn',
        model: 'gpt-5.6-sol',
      }),
      accountId: 'main',
      isSubagent: true,
      meta: { replayHeaders: {}, chatgptAccountId: undefined },
    })

    // Advance past maxSubagentIdleMs (30 min) — pre-change the idle prune would
    // kill the target here, before it can warm even once. Post-change the
    // 2-warm cap governs instead, so the target survives and gets its first warm.
    clock.advance(31 * 60 * 1000)
    await mgr.tick()

    expect(mgr.status().tracked).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('gpt-5.6 subagent stuck on persistently failing warms is reclaimed at the long idle bound (no leak)', async () => {
    // With every warm returning non-2xx, warmCount never reaches the 2-warm cap
    // so the cap can't reclaim this target. The pre-fix pruneStale had an
    // unconditional skip for 5.6 subagents — the target would live forever
    // and retry on a dead session every tick. Post-fix it is reclaimed at a
    // longer idle bound (~75 min) that still allows both warms on the happy
    // path (which completes at ~58 min) but eventually reclaims a stuck one.
    const longTtl = 30 * 60 * 1000
    fetchImpl = mock(
      async () => new Response('fail', { status: 500 }),
    ) as unknown as typeof fetch
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: longTtl,
      leadMs: LEAD_MS,
      maxSubagentIdleMs: 30 * 60 * 1000,
      getSustain: () => true,
    })
    mgr.track({
      sessionKey: 'sub-56-stuck',
      bodyText: JSON.stringify({
        input: 'subagent-turn',
        model: 'gpt-5.6-sol',
      }),
      accountId: 'main',
      isSubagent: true,
      meta: { replayHeaders: {}, chatgptAccountId: undefined },
    })

    // Advance past the long 5.6 subagent idle bound (2 * 30min TTL + 15min ≈ 75min).
    clock.advance(76 * 60 * 1000)
    // Track another session so pruneStale runs (called inside track()).
    mgr.track({
      sessionKey: 'trigger',
      bodyText: JSON.stringify({ input: 'trigger' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    expect(mgr.status().tracked).toBe(1)
    expect(mgr.status().targets[0]!.sessionKey).toBe('trigger')
  })

  test('non-5.6 subagent is still idle-pruned at maxSubagentIdleMs (unchanged)', async () => {
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
      maxSubagentIdleMs: 30 * 60 * 1000,
    })
    mgr.track({
      sessionKey: 'sub-55',
      bodyText: JSON.stringify({ input: 'subagent-turn', model: 'gpt-5.5' }),
      accountId: 'main',
      isSubagent: true,
      meta: { replayHeaders: {}, chatgptAccountId: undefined },
    })

    clock.advance(31 * 60 * 1000) // past 30-min subagent cap
    // Track another session so pruneStale runs (it's called inside track())
    mgr.track({
      sessionKey: 'other',
      bodyText: JSON.stringify({ input: 'other' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    // Sub-55 should be pruned; only the 'other' target remains
    expect(mgr.status().tracked).toBe(1)
    expect(mgr.status().targets[0]!.sessionKey).toBe('other')
  })

  test('gpt-5.6 main target is unchanged (not dropped after 2 warms)', async () => {
    const longTtl = 30 * 60 * 1000
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: longTtl,
      leadMs: LEAD_MS,
      maxIdleWarmMs: 60 * 60 * 1000,
    })
    mgr.track({
      sessionKey: 'main-56',
      bodyText: JSON.stringify({ input: 'main-turn', model: 'gpt-5.6-sol' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    // 2 lead windows → 2 warms
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // Main target survives the 2-warm cap (cap applies to subagents only)
    expect(mgr.status().tracked).toBe(1)
    expect(mgr.status().targets[0]!.sessionKey).toBe('main-56')
  })

  test('warmCount resets when track() re-captures the same subagent session', async () => {
    const longTtl = 30 * 60 * 1000
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: longTtl,
      leadMs: LEAD_MS,
      maxSubagentIdleMs: 60 * 60 * 1000,
    })
    const body = JSON.stringify({
      input: 'subagent-turn',
      model: 'gpt-5.6-sol',
    })
    mgr.track({
      sessionKey: 'sub-56',
      bodyText: body,
      accountId: 'main',
      isSubagent: true,
      meta: { replayHeaders: {}, chatgptAccountId: undefined },
    })

    // First warm
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Re-capture the same session — warmCount resets to 0, fresh lifecycle
    mgr.track({
      sessionKey: 'sub-56',
      bodyText: body,
      accountId: 'main',
      isSubagent: true,
      meta: { replayHeaders: {}, chatgptAccountId: undefined },
    })

    // Next warm
    clock.advance(longTtl - LEAD_MS + 1000)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // warmCount is now 1 (after reset, after 1 more warm) — NOT dropped
    expect(mgr.status().tracked).toBe(1)
  })

  test('logs cost from mock usage', async () => {
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

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
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-prompt-tokens',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

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
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: {
        replayHeaders: {
          'session-id': 'sess-1',
          'user-agent': 'codex-test',
          version: '0.144.0',
          'x-codex-beta-features': 'terminal_resize_reflow',
          'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
        },
        chatgptAccountId: undefined,
      },
    })

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.fromEntries(new Headers(init.headers))).toMatchObject({
      authorization: 'Bearer main-token',
      'content-type': 'application/json',
      'session-id': 'sess-1',
      'user-agent': 'codex-test',
      version: '0.144.0',
      'x-codex-beta-features': 'terminal_resize_reflow',
      'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
    })
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
    const mgr = createCacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-sse',
      bodyText: JSON.stringify({
        input: 'test',
        model: 'gpt-5.5',
        stream: true,
      }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
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
    const mgr = createCacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-sse-event-line',
      bodyText: JSON.stringify({
        input: 'test',
        model: 'gpt-5.5',
        stream: true,
      }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
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
    const mgr = createCacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-sse-sniff',
      bodyText: JSON.stringify({
        input: 'test',
        model: 'gpt-5.5',
        stream: true,
      }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
    clock.advance(TTL_MS - LEAD_MS + 1000)

    await mgr.tick()

    expect(log.debug).toHaveBeenCalledWith(
      'cachekeep warm response',
      expect.objectContaining({
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
    const mgr = createCacheKeepManager({
      fetchImpl: sseFetch,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-sse-no-usage',
      bodyText: JSON.stringify({
        input: 'test',
        model: 'gpt-5.5',
        stream: true,
      }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })
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
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(getMainToken).toHaveBeenCalled()
    // Verify auth header was set
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init = fetchCall[1] as RequestInit
    const authHeader = new Headers(init.headers).get('authorization')
    expect(authHeader).toBe('Bearer resolved-main-token')
  })

  test('uses refreshFallback for non-main accountId', async () => {
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-2',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'acct-1',
      meta: { replayHeaders: {} },
    })

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    expect(refreshFallback).toHaveBeenCalledWith('acct-1')
    const fetchCall2 = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as unknown[]
    const init2 = fetchCall2[1] as RequestInit
    expect(new Headers(init2.headers).get('authorization')).toBe(
      'Bearer resolved-acct-1',
    )
  })

  test('skips warm and sets backoff if no token resolves', async () => {
    getMainToken = mock(async () => {
      throw new Error('no token')
    })
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken,
      refreshFallback,
      codexResponsesUrl: CODEX_URL,
      logger: log,
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'sess-1',
      bodyText: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      accountId: 'main',
      meta: { replayHeaders: {} },
    })

    clock.advance(TTL_MS - LEAD_MS + 1000)
    await mgr.tick()

    // fetchImpl should NOT have been called (no token to make the request)
    expect(fetchImpl).not.toHaveBeenCalled()
    // backoffUntil should be set
    expect(mgr.status().targets[0]!.backoffUntil).toBeDefined()
  })

  test('session.deleted event removes target by threadID and prevents further warm fires', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (_url: any, _init: any) => {
      return new Response('{}')
    }) as any

    try {
      const configFile = process.env.OPENCODE_OPENAI_AUTH_FILE
      if (configFile) {
        await writeFile(
          configFile,
          JSON.stringify({
            version: 1,
            main: { type: 'opencode', provider: 'openai' },
            accounts: [],
            cachekeep: {
              enabled: true,
            },
          }),
        )
      }

      const plugin = await CodexAuthPlugin({
        client: {
          auth: { set: async () => {} },
          session: { promptAsync: async () => {} },
        } as any,
        project: { id: 'test' } as any,
        directory: '',
        worktree: '/some/worktree',
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {} as any,
      })

      const loaderResult = await plugin.auth?.loader?.(
        async () => ({
          type: 'oauth',
          provider: 'openai',
          access: 'access-token',
          refresh: 'refresh-token',
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as any,
      )

      if (!loaderResult?.fetch) throw new Error('No fetch override')

      const cacheKeepGlobal = globalThis as any
      const mgr = cacheKeepGlobal.__openaiAuthCacheKeepManagers?.get(
        getConfigPath(),
      )
      expect(mgr).toBeDefined()

      const mockFetch = mock(async () => new Response('{}'))
      mgr.fetchImpl = mockFetch

      const opencodeSessionId = 'opencode-sess-123'
      await loaderResult.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'session-id': opencodeSessionId,
          'x-opencode-session': opencodeSessionId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: 'test', model: 'gpt-5.5' }),
      })

      await drainSidebarWrites()
      expect(
        (await getSidebarState()).activeRouting?.[opencodeSessionId],
      ).toBeDefined()

      expect(mgr.status().tracked).toBe(1)
      const trackedTarget = mgr.status().targets[0]
      expect(trackedTarget.sessionKey).not.toBe(opencodeSessionId)

      await plugin.event?.({
        event: {
          type: 'session.deleted',
          properties: {
            info: {
              id: opencodeSessionId,
            },
          },
        },
      } as any)

      await drainSidebarWrites()
      expect(
        (await getSidebarState()).activeRouting?.[opencodeSessionId],
      ).toBeUndefined()

      expect(mgr.status().tracked).toBe(0)

      clock.advance(TTL_MS - LEAD_MS + 1000)
      await mgr.tick()
      expect(mockFetch).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('RPC server dispose', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oa-rpc-dispose-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('loader options do not expose an RPC lifecycle dispose hook', async () => {
    const originalRpcDir = process.env.OPENCODE_OPENAI_AUTH_RPC_DIR
    process.env.OPENCODE_OPENAI_AUTH_RPC_DIR = tempDir

    try {
      const plugin = await CodexAuthPlugin({
        client: {
          auth: { set: async () => {} },
          session: { promptAsync: async () => {} },
        } as any,
        project: { id: 'test' } as any,
        directory: '/some/project/dir',
        worktree: '/some/worktree',
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {} as any,
      })

      const loaderResult = await plugin.auth?.loader?.(
        async () => ({
          type: 'oauth',
          provider: 'openai',
          access: 'access',
          refresh: 'refresh',
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as any,
      )

      // Verify port file exists in tempDir
      const files = await readdir(tempDir)
      expect(
        files.some((f) => f.startsWith('port-') && f.endsWith('.json')),
      ).toBe(true)

      expect(loaderResult?.dispose).toBeUndefined()
      await plugin.dispose?.()
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_RPC_DIR = originalRpcDir
    }
  })

  test('plugin dispose clears the RPC registry entry and unlinks the port file', async () => {
    const originalRpcDir = process.env.OPENCODE_OPENAI_AUTH_RPC_DIR
    process.env.OPENCODE_OPENAI_AUTH_RPC_DIR = tempDir

    try {
      const plugin = await CodexAuthPlugin({
        client: {
          auth: { set: async () => {} },
          session: { promptAsync: async () => {} },
        } as any,
        project: { id: 'test' } as any,
        directory: '/some/project/dir',
        worktree: '/some/worktree',
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {} as any,
      })

      await plugin.auth?.loader?.(
        async () => ({
          type: 'oauth',
          provider: 'openai',
          access: 'access',
          refresh: 'refresh',
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as any,
      )

      // Verify port file exists in tempDir
      let files = await readdir(tempDir)
      expect(
        files.some((f) => f.startsWith('port-') && f.endsWith('.json')),
      ).toBe(true)

      expect(rpcServerRegistry()?.size ?? 0).toBeGreaterThan(0)

      await plugin.dispose?.()

      files = await readdir(tempDir)
      expect(
        files.some((f) => f.startsWith('port-') && f.endsWith('.json')),
      ).toBe(false)
      expect(rpcServerRegistry()?.size ?? 0).toBe(0)
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_RPC_DIR = originalRpcDir
    }
  })
})

describe('Header stripping', () => {
  test('strips x-api-key and api-key headers case-insensitively', async () => {
    const originalFetch = globalThis.fetch
    let lastFetchHeaders: Headers | undefined

    globalThis.fetch = (async (url: any, init: any) => {
      lastFetchHeaders = new Headers(init?.headers)
      return new Response('{}')
    }) as any

    try {
      const plugin = await CodexAuthPlugin({
        client: {
          auth: { set: async () => {} },
          session: { promptAsync: async () => {} },
        } as any,
        project: { id: 'test' } as any,
        directory: '',
        worktree: '/some/worktree',
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {} as any,
      })

      const loaderResult = await plugin.auth?.loader?.(
        async () => ({
          type: 'oauth',
          provider: 'openai',
          access: 'access-token',
          refresh: 'refresh-token',
          expires: Date.now() + 3600_000,
        }),
        {
          id: 'openai',
          label: 'OpenAI',
          models: [],
        } as any,
      )

      if (!loaderResult?.fetch) throw new Error('No fetch override')

      // Test with Headers object
      const headersObj = new Headers({
        'X-API-Key': 'secret-x-key',
        'api-key': 'secret-key',
        Authorization: 'Bearer old-token',
      })
      await loaderResult.fetch('https://api.openai.com/v1/responses', {
        headers: headersObj,
      })

      expect(lastFetchHeaders?.has('x-api-key')).toBe(false)
      expect(lastFetchHeaders?.has('api-key')).toBe(false)
      expect(lastFetchHeaders?.get('authorization')).toBe('Bearer access-token')

      // Test with plain object
      await loaderResult.fetch('https://api.openai.com/v1/responses', {
        headers: {
          'X-API-KEY': 'secret-x-key',
          'API-KEY': 'secret-key',
          Authorization: 'Bearer old-token',
        } as any,
      })

      expect(lastFetchHeaders?.has('x-api-key')).toBe(false)
      expect(lastFetchHeaders?.has('api-key')).toBe(false)
      expect(lastFetchHeaders?.get('authorization')).toBe('Bearer access-token')

      // Test with array of pairs
      await loaderResult.fetch('https://api.openai.com/v1/responses', {
        headers: [
          ['X-Api-Key', 'secret-x-key'],
          ['Api-Key', 'secret-key'],
          ['Authorization', 'Bearer old-token'],
        ] as any,
      })

      expect(lastFetchHeaders?.has('x-api-key')).toBe(false)
      expect(lastFetchHeaders?.has('api-key')).toBe(false)
      expect(lastFetchHeaders?.get('authorization')).toBe('Bearer access-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ---------------------------------------------------------------------------
// CacheKeepWindow helpers
// ---------------------------------------------------------------------------

function windowStorage(cachekeep: AccountStorage['cachekeep']): AccountStorage {
  // Only the cachekeep field is exercised by getCacheKeepWindow; everything
  // else is filler so the type narrows correctly.
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    accounts: [],
    cachekeep,
  }
}

describe('getCacheKeepWindow', () => {
  test('returns undefined for null storage', () => {
    expect(getCacheKeepWindow(null)).toBeUndefined()
  })

  test('returns undefined when storage has no cachekeep block', () => {
    expect(getCacheKeepWindow(windowStorage(undefined))).toBeUndefined()
  })

  test('returns the parsed window for a valid same-day pair', () => {
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 9, endHour: 18 })),
    ).toEqual({ startHour: 9, endHour: 18 })
  })

  test('returns the parsed window for a valid overnight wrap pair', () => {
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 22, endHour: 6 })),
    ).toEqual({ startHour: 22, endHour: 6 })
  })

  test('returns undefined when start and end are equal', () => {
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 9, endHour: 9 })),
    ).toBeUndefined()
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 0, endHour: 0 })),
    ).toBeUndefined()
  })

  test('returns undefined when hours are out of 0-23 range', () => {
    expect(
      getCacheKeepWindow(windowStorage({ startHour: -1, endHour: 9 })),
    ).toBeUndefined()
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 24, endHour: 9 })),
    ).toBeUndefined()
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 9, endHour: 24 })),
    ).toBeUndefined()
  })

  test('returns undefined when hours are non-integer', () => {
    // Number(9.5) = 9.5 — Number.isInteger rejects it.
    expect(
      getCacheKeepWindow(windowStorage({ startHour: 9.5, endHour: 18 })),
    ).toBeUndefined()
    // NaN propagates through Number() — Number.isInteger(NaN) is false.
    expect(
      getCacheKeepWindow(windowStorage({ startHour: NaN, endHour: 18 })),
    ).toBeUndefined()
  })

  test('returns undefined when either hour is missing', () => {
    expect(getCacheKeepWindow(windowStorage({ startHour: 9 }))).toBeUndefined()
    expect(getCacheKeepWindow(windowStorage({ endHour: 18 }))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Session routing: which account a warm may use
// ---------------------------------------------------------------------------
describe('routedAccountForSession', () => {
  const now = 1700000000000
  const pinned = (accountId: string, lastSeenAt = now): SidebarState => ({
    ...DEFAULT_SIDEBAR_STATE,
    route: 'sticky-balanced',
    stickyAssignments: {
      [hashSidebarSessionId('sess')]: {
        accountId,
        assignedAt: lastSeenAt,
        lastSeenAt,
        inputBytes: 1,
      },
    },
  })

  test('sticky-balanced: the session pin is the routed account', () => {
    expect(routedAccountForSession(pinned('fb-2'), 'sess', now)).toBe('fb-2')
  })

  test('sticky-balanced: no pin, a stale pin or no session id is no binding', () => {
    expect(
      routedAccountForSession(pinned('fb-2'), 'other', now),
    ).toBeUndefined()
    expect(
      routedAccountForSession(
        pinned('fb-2', now - 8 * 24 * 60 * 60 * 1000),
        'sess',
        now,
      ),
    ).toBeUndefined()
    expect(
      routedAccountForSession(pinned('fb-2'), undefined, now),
    ).toBeUndefined()
  })

  test('ordered modes: the route recorded for the session under the current mode', () => {
    const state: SidebarState = {
      ...DEFAULT_SIDEBAR_STATE,
      route: 'fallback-first',
      activeRouting: {
        sess: { activeId: 'fb-1', route: 'fallback-first', updatedAt: now },
        earlier: { activeId: 'main', route: 'main-first', updatedAt: now },
      },
    }
    expect(routedAccountForSession(state, 'sess', now)).toBe('fb-1')
    // Recorded under another mode: says nothing about the next request.
    expect(routedAccountForSession(state, 'earlier', now)).toBeUndefined()
    expect(routedAccountForSession(state, 'unrouted', now)).toBeUndefined()
  })
})

describe('CacheKeepManager active account', () => {
  const body = JSON.stringify({ input: 'test', model: 'gpt-5.5' })

  function setup(active: (routingSessionId: string | undefined) => unknown) {
    const clock = fakeNow()
    const fetchImpl = mock(
      async () => new Response('{}'),
    ) as unknown as typeof fetch
    const activeAccount = mock(active as never) as unknown as (
      routingSessionId: string | undefined,
    ) => string | undefined
    const mgr = createCacheKeepManager({
      fetchImpl,
      getMainToken: async () => 'main-token',
      refreshFallback: async (id) => `${id}-token`,
      codexResponsesUrl: CODEX_URL,
      activeAccount,
      logger: fakeLogger(),
      now: clock.now,
      ttlMs: TTL_MS,
      leadMs: LEAD_MS,
    })
    mgr.track({
      sessionKey: 'thread-1',
      bodyText: body,
      accountId: 'fb-2',
      meta: { replayHeaders: {}, routingSessionId: 'opencode-session' },
    })
    clock.advance(TTL_MS - LEAD_MS + 1000)
    return { mgr, fetchImpl, activeAccount }
  }

  test('a session now routed to another account is not warmed on the old one', async () => {
    const { mgr, fetchImpl, activeAccount } = setup(() => 'fb-1')
    await mgr.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(mgr.status().tracked).toBe(0)
    // Asked by the router's session id, not the cache key.
    expect(activeAccount).toHaveBeenCalledWith('opencode-session')
  })

  test('a session still routed to the captured account is warmed there', async () => {
    const { mgr, fetchImpl } = setup(() => 'fb-2')
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const init = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0]![1] as RequestInit
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer fb-2-token',
    )
  })

  test('a session with no routing binding keeps the captured account', async () => {
    const { mgr, fetchImpl } = setup(() => undefined)
    await mgr.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(mgr.status().tracked).toBe(1)
  })
})

describe('openaiCacheKeepProfile', () => {
  const body56 = JSON.stringify({ model: 'gpt-5.6-sol', input: [] })

  test('gpt-5.6 main session: 30-min TTL, no warm cap', () => {
    expect(
      openaiCacheKeepProfile({ bodyText: body56, isSubagent: false }),
    ).toEqual({ ttlMs: 30 * 60 * 1000 })
  })

  test('gpt-5.6 subagent: two warms and a 75-min idle bound', () => {
    expect(
      openaiCacheKeepProfile({ bodyText: body56, isSubagent: true }),
    ).toEqual({
      ttlMs: 30 * 60 * 1000,
      maxWarms: 2,
      maxIdleMs: 75 * 60 * 1000,
    })
  })

  test('other models keep the manager defaults', () => {
    expect(
      openaiCacheKeepProfile({
        bodyText: JSON.stringify({ model: 'gpt-5.5' }),
        isSubagent: true,
      }),
    ).toBeUndefined()
  })
})
