// Keep-warm on OpenCode 2: the process-wide manager each location holds
// (`v2/cache-keep.ts`), driven with a fake clock and fake timers. The first
// half drives `acquireCacheKeep` with stand-in locations; the second half runs
// the real setup on the fake host, capturing at the post-installer seam.

import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheKeepManager } from '@cortexkit/common-auth/cachekeep'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { CACHE_KEEP_CAPS } from '../core/cachekeep'
import { drainNotifications } from '../rpc/notifications'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import {
  acquireCacheKeep,
  type CacheKeepCaptureInput,
  type CacheKeepLease,
  type CacheKeepLocation,
  type CacheKeepSettingsView,
} from '../v2/cache-keep'
import { CodexHttpState, codexReplayRequest } from '../v2/codex-wire'
import { acquireFrameMirror, FrameMirror } from '../v2/frame-mirror'
import { acquireSessionAccounts } from '../v2/session-accounts'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const MINUTE = 60_000
// Local noon, so a clock window can be put around it in any time zone.
const START = new Date(2026, 0, 5, 12, 0, 0).getTime()
const LIVE_TOKEN = 'secret-live-request-token'

const leases: CacheKeepLease[] = []
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Sent = {
  url: string
  method: string | undefined
  headers: Headers
  body: Record<string, unknown>
}

/** Fake timers: counts how often an interval is armed and cleared. */
function fakeTimers() {
  const timers = {
    armed: [] as number[],
    cleared: 0,
    setIntervalImpl: ((_callback: () => void, ms: number) => {
      timers.armed.push(ms)
      return { unref() {} }
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {
      timers.cleared++
    }) as unknown as typeof clearInterval,
  }
  return timers
}

/** A stand-in location: pool rows, a vault, the account registry, settings. */
function fakeLocation() {
  const sent: Sent[] = []
  const warnings: string[] = []
  const state = {
    authority: 'local' as 'local' | 'vault' | 'unreadable',
    owned: new Set<string>(),
    rows: new Map<string, { token: string; identity?: string }>(),
    receiptIdentity: new Map<string, string>(),
    receipts: 0,
    vaultSends: 0,
    accessReads: 0,
    accounts: new Map<string, string>(),
    parents: new Map<string, string>(),
    settings: {
      enabled: true,
      subagents: false,
      sustain: false,
      window: undefined,
    } as CacheKeepSettingsView,
    status: 200,
    // When set, a send waits for it and ignores the abort signal.
    gate: undefined as Promise<void> | undefined,
    sending: 0,
  }
  const location: CacheKeepLocation = {
    source: {
      accessFor: async (id) => {
        state.accessReads++
        const row = state.rows.get(id)
        return row
          ? {
              row: { id, identity: row.identity } as never,
              token: row.token,
            }
          : undefined
      },
    },
    storage: async () => null,
    vault: {
      authority: async () => state.authority,
      owns: (routeId) => state.owned.has(routeId),
      send: async (routeId, dispatch) => {
        state.vaultSends++
        state.receipts++
        return dispatch(`receipt-token-${state.receipts}`, {
          accountIdentity: state.receiptIdentity.get(routeId),
        } as never)
      },
    },
    accounts: { activeAccount: (id) => state.accounts.get(id) },
    settings: () => state.settings,
    parentOf: async (id) => state.parents.get(id),
    fetch: (async (url: string, init?: RequestInit) => {
      state.sending++
      if (state.gate) await state.gate
      sent.push({
        url: String(url),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      })
      return new Response('{}', { status: state.status })
    }) as unknown as typeof fetch,
    log: {
      debug() {},
      warn: (message) => {
        warnings.push(message)
      },
    },
  }
  return { location, state, sent, warnings }
}

function storePaths() {
  const dir = join(tmpdir(), `oc2-cache-keep-${randomUUID()}`)
  return { configPath: join(dir, 'c.json'), statePath: join(dir, 's.json') }
}

function acquire(
  location: CacheKeepLocation,
  options: {
    paths?: ReturnType<typeof storePaths>
    timers?: ReturnType<typeof fakeTimers>
    clock?: { now: number }
    joinTimeoutMs?: number
  } = {},
) {
  const timers = options.timers ?? fakeTimers()
  const clock = options.clock ?? { now: START }
  const lease = acquireCacheKeep(options.paths ?? storePaths(), location, {
    now: () => clock.now,
    codexResponsesUrl: 'https://fallback.invalid/responses',
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    ...(options.joinTimeoutMs !== undefined
      ? { joinTimeoutMs: options.joinTimeoutMs }
      : {}),
  })
  leases.push(lease)
  return { lease, timers, clock }
}

/** One owned agent-loop request as it leaves the installer. */
function captured(
  sessionID: string,
  options: {
    accountId?: string
    mode?: 'local' | 'vault'
    model?: string
    identity?: string
    headers?: Record<string, string>
    kind?: string
    body?: string
  } = {},
): CacheKeepCaptureInput {
  const accountId = options.accountId ?? 'A'
  const mode = options.mode ?? 'local'
  return {
    sessionID,
    kind: options.kind ?? 'primary',
    request: new Request('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LIVE_TOKEN}`,
        cookie: 'private-cookie',
        'content-type': 'application/json',
        'chatgpt-account-id': options.identity ?? `chatgpt-${accountId}`,
        'session-id': `thread-${sessionID}`,
        'thread-id': `thread-${sessionID}`,
        'x-codex-turn-metadata': '{"turn_id":"t1"}',
        ...options.headers,
      },
      body:
        options.body ??
        JSON.stringify({
          model: options.model ?? 'gpt-5.5',
          input: [{ role: 'user', content: 'hello' }],
          prompt_cache_key: `thread-${sessionID}`,
          stream: true,
          store: true,
          max_output_tokens: 100,
        }),
    }),
    attempt: {
      attemptId: randomUUID(),
      sessionID,
      accountId,
      data:
        mode === 'vault'
          ? { kind: 'vault', routeId: accountId, receipt: {} }
          : { kind: 'pool', token: LIVE_TOKEN, credentialEpoch: 1 },
    } as never,
  }
}

/** A location serving session `ses` on pool row A, signed in as chatgpt-A. */
function served(ses = 'ses') {
  const fake = fakeLocation()
  fake.state.rows.set('A', { token: 'A-token-1', identity: 'chatgpt-A' })
  fake.state.accounts.set(ses, 'A')
  return fake
}

async function advance(
  lease: CacheKeepLease,
  clock: { now: number },
  ms: number,
) {
  clock.now += ms
  await lease.manager.tick()
}

describe('OpenCode 2 keep-warm caps', () => {
  test('CACHE_KEEP_CAPS equal the installed common-auth defaults', () => {
    const manager = new CacheKeepManager({
      adapter: { buildBody: () => '', send: async () => new Response() },
      now: () => START,
      setIntervalImpl: fakeTimers().setIntervalImpl,
    })
    try {
      for (let index = 0; index <= CACHE_KEEP_CAPS.maxTargets; index++)
        manager.track({ sessionKey: `s${index}`, bodyText: '{}' })
      expect(manager.status().tracked).toBe(CACHE_KEEP_CAPS.maxTargets)
      expect(
        manager.track({
          sessionKey: 'big',
          bodyText: 'x'.repeat(CACHE_KEEP_CAPS.maxBytes + 1),
        }),
      ).toEqual({ tracked: false, reason: 'body-exceeds-max-bytes' })
      expect(
        manager.track({
          sessionKey: 'fits',
          bodyText: 'x'.repeat(CACHE_KEEP_CAPS.maxBytes),
        }),
      ).toEqual({ tracked: true })
    } finally {
      manager.stop()
    }
  })

  test('the OpenCode 2 manager effective caps equal the frame mirror caps', async () => {
    const mirror = new FrameMirror()
    const fake = fakeLocation()
    const { lease } = acquire(fake.location)
    for (let i = 0; i <= mirror.caps.maxTargets; i++)
      await lease.capture(captured(`ses_${i}`))
    expect(lease.manager.status().tracked).toBe(mirror.caps.maxTargets)
    await lease.capture(
      captured('too-large', { body: 'x'.repeat(mirror.caps.maxBytes + 1) }),
    )
    expect(
      lease.manager.status().targets.some((t) => t.sessionKey === 'too-large'),
    ).toBe(false)
    await lease.capture(
      captured('fits', { body: 'x'.repeat(mirror.caps.maxBytes) }),
    )
    expect(lease.manager.status().targets.map((t) => t.sessionKey)).toEqual([
      'fits',
    ])
  })

  test('the OpenCode 2 manager evicts the least recently used session past maxTargets', async () => {
    const fake = fakeLocation()
    const { lease, clock } = acquire(fake.location)
    for (let index = 0; index <= CACHE_KEEP_CAPS.maxTargets; index++) {
      clock.now += 1
      await lease.capture(captured(`ses_${index}`))
    }
    const keys = lease.manager.status().targets.map((t) => t.sessionKey)
    expect(keys).toHaveLength(CACHE_KEEP_CAPS.maxTargets)
    expect(keys).not.toContain('ses_0')
    expect(keys).toContain(`ses_${CACHE_KEEP_CAPS.maxTargets}`)
  })

  test('the manager ticks once a minute, the shared default its warm lead is built on', async () => {
    const { lease, timers } = acquire(served().location)
    await lease.capture(captured('ses'))
    expect(timers.armed).toEqual([60_000])
  })
})

describe('OpenCode 2 keep-warm capture and replay', () => {
  for (const [model, ttl] of [
    ['gpt-5.5', 5 * MINUTE],
    ['gpt-5.6', 30 * MINUTE],
  ] as const) {
    test(`host keep-alive retires ${model} until a real capture, without leaking counters or backoff`, async () => {
      const fake = served()
      const { lease, clock } = acquire(fake.location)
      await lease.capture(captured('ses', { model }))
      await advance(lease, clock, ttl - MINUTE)
      expect(fake.sent).toHaveLength(1)
      fake.state.status = 503
      await advance(lease, clock, ttl - MINUTE)
      expect(lease.manager.status().targets[0]).toMatchObject({
        warmCount: 1,
        failures: 1,
      })
      await lease.capture(
        captured('ses', {
          kind: 'generate',
          body: JSON.stringify({
            model,
            input: [
              { role: 'user', content: 'previous real turn' },
              {
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'This is a keep-alive request. Stay warm.',
                  },
                ],
              },
            ],
          }),
        }),
      )
      expect(lease.manager.status().tracked).toBe(0)
      const sends = fake.sent.length
      await advance(lease, clock, ttl)
      expect(fake.sent).toHaveLength(sends)
      fake.state.status = 200
      await lease.capture(captured('ses', { model }))
      expect(lease.manager.status().targets[0]).toMatchObject({
        warmCount: 0,
        failures: 0,
      })
      expect(lease.manager.status().targets[0]?.backoffUntil).toBeUndefined()
      await advance(lease, clock, ttl - MINUTE)
      expect(fake.sent).toHaveLength(sends + 1)
      expect(fake.sent.at(-1)?.body.input).toEqual([
        { role: 'user', content: 'hello' },
      ])
    })
  }

  test('host keep-alive recognition requires generate, the same session and a final user prefix', async () => {
    const fake = served()
    const { lease } = acquire(fake.location)
    await lease.capture(captured('ses'))
    const body = (role: string, text: string) =>
      JSON.stringify({ input: [{ role, content: text }] })
    for (const input of [
      captured('other', {
        kind: 'generate',
        body: body('user', 'This is a keep-alive request.'),
      }),
      captured('ses', {
        kind: 'title',
        body: body('user', 'This is a keep-alive request.'),
      }),
      captured('ses', {
        kind: 'generate',
        body: body('assistant', 'This is a keep-alive request.'),
      }),
      captured('ses', {
        kind: 'generate',
        body: body('user', 'Not This is a keep-alive request.'),
      }),
      captured('ses', { kind: 'generate', body: '{invalid' }),
      captured('ses', {
        kind: 'generate',
        body: JSON.stringify({
          input: [
            { role: 'user', content: 'This is a keep-alive request.' },
            { role: 'assistant', content: 'done' },
          ],
        }),
      }),
    ]) {
      await lease.capture(input)
      expect(lease.manager.status().targets.map((t) => t.sessionKey)).toEqual([
        'ses',
      ])
    }
    await lease.capture(
      captured('ses', {
        kind: 'generate',
        body: body('user', 'This is a keep-alive request.'),
      }),
    )
    expect(lease.manager.status().tracked).toBe(0)
  })

  test('host keep-alive is never captured as user activity', async () => {
    const fake = served()
    const { lease } = acquire(fake.location)
    await lease.capture(
      captured('ses', {
        kind: 'generate',
        body: JSON.stringify({
          input: [{ role: 'user', content: 'This is a keep-alive request.' }],
        }),
      }),
    )
    expect(lease.manager.status().tracked).toBe(0)
    expect(lease.manager.status().running).toBe(false)
  })

  test('captures the final request keyed by the host session and holds no token', async () => {
    const fake = served('ses_host')
    const { lease } = acquire(fake.location)
    await lease.capture(captured('ses_host'))
    const [target] = lease.manager.status().targets
    expect(target).toMatchObject({ sessionKey: 'ses_host', accountId: 'A' })
    // The manager's own record, body and metadata included.
    const held = JSON.stringify([
      ...(lease.manager as unknown as { targets: Map<string, unknown> })
        .targets,
    ])
    expect(held).not.toContain(LIVE_TOKEN)
    expect(held).not.toContain('private-cookie')
    expect(held).toContain('chatgpt-A')
  })

  test('a 5-minute model warms just before 5 minutes with store:false, no caps and a fresh token', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    expect(lease.manager.status().targets[0]!.ttlMs).toBe(5 * MINUTE)
    await advance(lease, clock, 3 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    await advance(lease, clock, MINUTE)
    expect(fake.sent).toHaveLength(1)
    const [warm] = fake.sent
    expect(warm!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(warm!.headers.get('authorization')).toBe('Bearer A-token-1')
    expect(warm!.headers.get('chatgpt-account-id')).toBe('chatgpt-A')
    expect(warm!.headers.get('session-id')).toBe('thread-ses')
    expect(warm!.headers.get('x-codex-turn-metadata')).toBe('{"turn_id":"t1"}')
    expect(warm!.headers.has('cookie')).toBe(false)
    expect(warm!.body).toMatchObject({
      store: false,
      prompt_cache_key: 'thread-ses',
    })
    expect(warm!.body).not.toHaveProperty('max_output_tokens')
  })

  test('a 30-minute model warms just before 30 minutes', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses', { model: 'gpt-5.6' }))
    expect(lease.manager.status().targets[0]!.ttlMs).toBe(30 * MINUTE)
    await advance(lease, clock, 25 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(1)
  })

  test('only owned agent-loop requests are captured, and only while keep-warm is on', async () => {
    const fake = served()
    const { lease } = acquire(fake.location)
    await lease.capture(captured('ses', { kind: 'title' }))
    await lease.capture({
      ...captured('ses'),
      attempt: { ...captured('ses').attempt, data: undefined } as never,
    })
    fake.state.settings.enabled = false
    await lease.capture(captured('ses'))
    expect(lease.manager.status().tracked).toBe(0)
  })

  test('a failed warm logs one warning and backs off for ten minutes', async () => {
    const fake = served()
    fake.state.status = 500
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses', { model: 'gpt-5.6' }))
    await advance(lease, clock, 29 * MINUTE)
    expect(fake.sent).toHaveLength(1)
    expect(fake.warnings).toEqual(['cachekeep failed'])
    const [target] = lease.manager.status().targets
    expect(target!.failures).toBe(1)
    expect(target!.backoffUntil).toBe(clock.now + 10 * MINUTE)
    await advance(lease, clock, MINUTE)
    expect(fake.sent).toHaveLength(1)
  })

  test('the clock window gates capture and warming', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    fake.state.settings.window = { startHour: 1, endHour: 2 }
    await lease.capture(captured('ses'))
    expect(lease.manager.status().tracked).toBe(0)
    fake.state.settings.window = { startHour: 9, endHour: 18 }
    await lease.capture(captured('ses'))
    expect(lease.manager.status().tracked).toBe(1)
    fake.state.settings.window = { startHour: 1, endHour: 2 }
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
  })

  for (const sustain of [false, true]) {
    test(`a main session ${sustain ? 'keeps warming' : 'stops'} past the one-hour idle cap with sustain ${sustain ? 'on' : 'off'}`, async () => {
      const fake = served()
      fake.state.settings.sustain = sustain
      const { lease, clock } = acquire(fake.location)
      await lease.capture(captured('ses', { model: 'gpt-5.6' }))
      for (let minute = 1; minute <= 90; minute++)
        await advance(lease, clock, MINUTE)
      expect(lease.manager.status().tracked).toBe(sustain ? 1 : 0)
      expect(fake.sent).toHaveLength(sustain ? 3 : 2)
    })
  }
})

describe('OpenCode 2 keep-warm subagents', () => {
  const subagents = {
    'x-opencode-parent-session-id header': () =>
      captured('ses', {
        headers: { 'x-opencode-parent-session-id': 'ses_parent' },
      }),
    'x-parent-session-id header': () =>
      captured('ses', { headers: { 'x-parent-session-id': 'ses_parent' } }),
    'session parentID': (fake: ReturnType<typeof served>) => {
      fake.state.parents.set('ses', 'ses_parent')
      return captured('ses')
    },
  }
  for (const [how, request] of Object.entries(subagents)) {
    test(`a subagent named by its ${how} is tracked only while subagent warming is on`, async () => {
      const fake = served()
      const { lease } = acquire(fake.location)
      await lease.capture(request(fake))
      expect(lease.manager.status().tracked).toBe(0)
      fake.state.settings.subagents = true
      await lease.capture(request(fake))
      expect(lease.manager.status().targets[0]).toMatchObject({
        sessionKey: 'ses',
        isSubagent: true,
      })
    })
  }

  test('a 30-minute subagent retires after two warms', async () => {
    const fake = served()
    fake.state.settings.subagents = true
    fake.state.parents.set('ses', 'ses_parent')
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses', { model: 'gpt-5.6' }))
    await advance(lease, clock, 29 * MINUTE)
    expect(lease.manager.status().tracked).toBe(1)
    await advance(lease, clock, 29 * MINUTE)
    expect(fake.sent).toHaveLength(2)
    expect(lease.manager.status().tracked).toBe(0)
  })

  test('turning subagent warming off drops a subagent target unsent', async () => {
    const fake = served()
    fake.state.settings.subagents = true
    fake.state.parents.set('ses', 'ses_parent')
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    fake.state.settings.subagents = false
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    expect(lease.manager.status().tracked).toBe(0)
  })
})

describe('OpenCode 2 keep-warm active account', () => {
  test('a session with no recorded account sends nothing until its next capture, then warms', async () => {
    const fake = served()
    fake.state.accounts.delete('ses')
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    expect(lease.manager.status().tracked).toBe(0)
    fake.state.accounts.set('ses', 'A')
    await advance(lease, clock, 5 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    await lease.capture(captured('ses'))
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(1)
  })

  test('a session now served by another row sends to neither account', async () => {
    const fake = served()
    fake.state.rows.set('B', { token: 'B-token', identity: 'chatgpt-B' })
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    fake.state.accounts.set('ses', 'B')
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    expect(fake.state.accessReads).toBe(0)
    expect(lease.manager.status().tracked).toBe(0)
  })
})

describe('OpenCode 2 keep-warm credentials', () => {
  test('a refreshed token for the same login warms with the new token', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    await advance(lease, clock, 4 * MINUTE)
    fake.state.rows.set('A', { token: 'A-token-2', identity: 'chatgpt-A' })
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent.map((s) => s.headers.get('authorization'))).toEqual([
      'Bearer A-token-1',
      'Bearer A-token-2',
    ])
  })

  test('another login under the same row sends nothing and drops the target', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    fake.state.rows.set('A', { token: 'other-token', identity: 'chatgpt-Z' })
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    expect(lease.manager.status().tracked).toBe(0)
    expect(fake.warnings).toEqual([])
  })

  test('a vault receipt for another login sends nothing and drops the target', async () => {
    const fake = served()
    fake.state.authority = 'vault'
    fake.state.owned.add('V')
    fake.state.accounts.set('ses', 'V')
    fake.state.receiptIdentity.set('V', 'chatgpt-Z')
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses', { accountId: 'V', mode: 'vault' }))
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.state.vaultSends).toBe(1)
    expect(fake.sent).toHaveLength(0)
    expect(lease.manager.status().tracked).toBe(0)
  })

  test('after enrolling, a local capture sends nothing and backs off; a vault capture warms with a fresh receipt each time', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    fake.state.authority = 'vault'
    fake.state.owned.add('V')
    fake.state.receiptIdentity.set('V', 'chatgpt-V')
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    expect(fake.state.accessReads).toBe(0)
    expect(lease.manager.status().targets[0]!.failures).toBe(1)

    fake.state.accounts.set('ses', 'V')
    await lease.capture(captured('ses', { accountId: 'V', mode: 'vault' }))
    await advance(lease, clock, 4 * MINUTE)
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent.map((s) => s.headers.get('authorization'))).toEqual([
      'Bearer receipt-token-1',
      'Bearer receipt-token-2',
    ])
    expect(fake.state.accessReads).toBe(0)
  })

  test('a local capture is never warmed with a vault receipt, even for a vault route with the same id', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    fake.state.authority = 'vault'
    fake.state.owned.add('A')
    fake.state.receiptIdentity.set('A', 'chatgpt-A')
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
    expect(lease.manager.status().targets[0]!.failures).toBe(1)
  })

  for (const owned of [false, true]) {
    test(`after disconnecting, a vault capture sends nothing and backs off (route ${owned ? 'still' : 'no longer'} listed); a local capture warms`, async () => {
      const fake = served()
      fake.state.authority = 'vault'
      fake.state.owned.add('V')
      fake.state.receiptIdentity.set('V', 'chatgpt-V')
      fake.state.accounts.set('ses', 'V')
      // A pool row with the vault route's id must not be used for it.
      fake.state.rows.set('V', { token: 'V-pool-token', identity: 'chatgpt-V' })
      const { lease, clock } = acquire(fake.location)
      await lease.capture(captured('ses', { accountId: 'V', mode: 'vault' }))
      fake.state.authority = 'local'
      if (!owned) fake.state.owned.delete('V')
      await advance(lease, clock, 4 * MINUTE)
      expect(fake.sent).toHaveLength(0)
      expect(fake.state.vaultSends).toBe(0)
      expect(fake.state.accessReads).toBe(0)
      expect(lease.manager.status().targets[0]!.failures).toBe(1)

      fake.state.accounts.set('ses', 'A')
      await lease.capture(captured('ses'))
      await advance(lease, clock, 4 * MINUTE)
      expect(fake.sent.map((s) => s.headers.get('authorization'))).toEqual([
        'Bearer A-token-1',
      ])
    })
  }
})

describe('OpenCode 2 keep-warm holders', () => {
  test('different stores get different managers', () => {
    const a = acquire(fakeLocation().location)
    const b = acquire(fakeLocation().location)
    expect(a.lease.manager).not.toBe(b.lease.manager)
  })

  test('a forgotten session stops at once', async () => {
    const fake = served()
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    lease.forget('ses')
    await advance(lease, clock, 4 * MINUTE)
    expect(fake.sent).toHaveLength(0)
  })

  test('the last release joins the warm in flight', async () => {
    const fake = served()
    const gate = Promise.withResolvers<void>()
    fake.state.gate = gate.promise
    const { lease, clock } = acquire(fake.location)
    await lease.capture(captured('ses'))
    clock.now += 4 * MINUTE
    const tick = lease.manager.tick()
    while (fake.state.sending === 0) await Bun.sleep(1)
    let released = false
    const release = lease.release().then(() => {
      released = true
    })
    await Bun.sleep(20)
    expect(released).toBe(false)
    gate.resolve()
    await release
    await tick
    expect(released).toBe(true)
  })

  test('the last release stops waiting for a hung warm at the join limit', async () => {
    const fake = served()
    fake.state.gate = new Promise<void>(() => {})
    const { lease, clock } = acquire(fake.location, { joinTimeoutMs: 30 })
    await lease.capture(captured('ses'))
    clock.now += 4 * MINUTE
    void lease.manager.tick()
    while (fake.state.sending === 0) await Bun.sleep(1)
    const started = performance.now()
    await lease.release()
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

// ---------------------------------------------------------------------------
// The real setup on the fake host
// ---------------------------------------------------------------------------

const registry = (globalThis as Record<symbol, unknown>)[
  Symbol.for('@cortexkit/openai-auth/opencode2-cache-keep')
] as Map<string, { manager: CacheKeepManager<unknown> }>

function managerOf(files: ReturnType<typeof poolFiles>) {
  const key = JSON.stringify([files.configPath, files.statePath])
  return registry.get(key)?.manager
}

async function startLocation(
  files: ReturnType<typeof poolFiles>,
  shared: { clock: { now: number }; timers: ReturnType<typeof fakeTimers> },
  directory?: string,
  parents?: Map<string, string>,
) {
  const host = fakeOpenCode2Host({ directory, parents })
  const codex = new CodexHttpState({
    now: () => shared.clock.now,
    uuid: randomUUID,
  })
  const warms: Sent[] = []
  const stop = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    codex,
    heartbeat: false,
    now: () => shared.clock.now,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    cacheKeep: {
      setIntervalImpl: shared.timers.setIntervalImpl,
      clearIntervalImpl: shared.timers.clearIntervalImpl,
    },
    fetch: Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).endsWith('/responses'))
          return new Response('{}', { status: 503 })
        warms.push({
          url: String(url),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return new Response('{}', { status: 200 })
      },
      { preconnect: () => {} },
    ) as typeof fetch,
    vault: {
      stateDir: join(files.dir, 'vault'),
      connectionFile: () => join(files.dir, 'no-vault.json'),
      pollIntervalMs: 0,
    },
  })
  let stopped = false
  const dispose = async () => {
    if (stopped) return
    stopped = true
    await stop?.()
  }
  cleanups.push(dispose)
  const request = (
    sessionID: string,
    kind: 'primary' | 'title' = 'primary',
    headers: Record<string, string> = {},
  ) =>
    host.fire('http.request', {
      ...scope(sessionID, kind),
      request: new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${placeholderSecret('openai')}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: [{ role: 'user', content: 'hi' }],
          max_output_tokens: 50,
        }),
      }),
    })
  return { host, warms, request, dispose, codex }
}

async function websocket(
  location: Awaited<ReturnType<typeof startLocation>>,
  sessionID = 'ses_ws',
  headers: Record<string, string> = {},
) {
  await location.host.fire('experimental.ws.handshake', {
    ...scope(sessionID),
    url: 'wss://chatgpt.com/backend-api/codex/responses',
    headers: {
      authorization: `Bearer ${placeholderSecret('openai')}`,
      ...headers,
    },
  })
  return {
    send: async (body: Record<string, unknown>) => {
      const draft = { ...scope(sessionID), frame: JSON.stringify(body) }
      await location.host.fire('experimental.ws.send', draft)
      return JSON.parse(draft.frame)
    },
    complete: async (id: string, output: unknown[] = []) => {
      for (const item of output)
        await location.host.fire('experimental.ws.receive', {
          ...scope(sessionID),
          frame: JSON.stringify({ type: 'response.output_item.done', item }),
        })
      await location.host.fire('experimental.ws.receive', {
        ...scope(sessionID),
        frame: JSON.stringify({ type: 'response.completed', response: { id } }),
      })
    },
  }
}

describe('OpenCode 2 WebSocket keep-warm', () => {
  test('replay builds HTTP headers before the manager sanitizes the request', () => {
    const state = new CodexHttpState({ now: () => START, uuid: randomUUID })
    state.get('ses_ws')
    const input = [{ role: 'user', content: 'hello' }]
    state.advanceFrame('ses_ws', { type: 'response.create', input })
    const bodyText = JSON.stringify({ model: 'gpt-5.5', input, stream: true })
    const request = codexReplayRequest(
      { sessionID: 'ses_ws', responseID: 'r1', bodyText },
      'wss://chatgpt.com/backend-api/codex/responses',
      new Headers({
        authorization: 'Bearer private',
        cookie: 'private',
        'chatgpt-account-id': 'chatgpt-main',
      }),
      state,
    )!
    expect(request.headers.get('accept')).toBe('text/event-stream')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(request.headers.has('authorization')).toBe(false)
    expect(request.headers.has('cookie')).toBe(false)
    expect(request.headers.get('chatgpt-account-id')).toBe('chatgpt-main')
    expect(request.method).toBe('POST')
  })

  test('two HTTP warms preserve the WebSocket turn, history and next tool-output input', async () => {
    const files = keepWarmPool()
    const shared = { clock: { now: START }, timers: fakeTimers() }
    const location = await startLocation(files, shared)
    await location.request('ses_ws')
    const ws = await websocket(location)
    const input = [{ role: 'user', content: 'read café \\u0061 1.25' }]
    const first = await ws.send({
      type: 'response.create',
      model: 'gpt-5.5',
      input,
      instructions: 'help',
      tools: [],
      store: true,
      max_output_tokens: 12,
      max_tokens: 13,
    })
    const output = [
      { type: 'reasoning', encrypted_content: 'opaque' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read',
        arguments: '{}',
      },
    ]
    await ws.complete('r1', output)
    const metadata = location.codex.get('ses_ws')
    const before = structuredClone(metadata)
    const beforeTurn = structuredClone(location.codex.frameTurns.get('ses_ws')!)
    const manager = managerOf(files)!
    expect(manager.status().tracked).toBe(1)
    for (let n = 0; n < 2; n++) {
      shared.clock.now += 4 * MINUTE
      await manager.tick()
    }
    expect(location.warms).toHaveLength(2)
    expect(metadata).toEqual(before)
    expect(location.codex.frameTurns.get('ses_ws')).toEqual(beforeTurn)
    for (const warm of location.warms) {
      expect(warm.method).toBe('POST')
      expect(warm.url).toBe('https://chatgpt.com/backend-api/codex/responses')
      expect(warm.body).toMatchObject({
        model: 'gpt-5.5',
        instructions: 'help',
        input: [...input, ...output],
        stream: true,
        store: false,
        prompt_cache_key: metadata.threadID,
      })
      for (const key of [
        'type',
        'previous_response_id',
        'max_output_tokens',
        'max_tokens',
        'max_completion_tokens',
      ])
        expect(warm.body).not.toHaveProperty(key)
      expect(warm.headers.get('accept')).toBe('text/event-stream')
      expect(warm.headers.get('session-id')).toBe(metadata.threadID)
      expect(
        JSON.parse(warm.headers.get('x-codex-turn-metadata')!),
      ).toMatchObject({
        turn_id: beforeTurn.turnID,
        turn_started_at_unix_ms: beforeTurn.turnStartedAt,
      })
      expect(warm.body.client_metadata).not.toHaveProperty(
        'x-codex-turn-metadata',
      )
      expect(warm.body.client_metadata).not.toHaveProperty(
        'x-codex-ws-stream-request-start-ms',
      )
    }
    const delta = [
      { type: 'function_call_output', call_id: 'call_1', output: 'file' },
    ]
    const next = await ws.send({
      type: 'response.create',
      model: 'gpt-5.5',
      previous_response_id: 'r1',
      input: delta,
    })
    const turn = (body: typeof next) =>
      JSON.parse(body.client_metadata['x-codex-turn-metadata'])
    expect(turn(next).turn_id).toBe(turn(first).turn_id)
    expect(turn(next).turn_started_at_unix_ms).toBe(
      turn(first).turn_started_at_unix_ms,
    )
    expect(next.input).toEqual(delta)
    const http = await location.request('ses_ws')
    expect(
      JSON.parse(http.request.headers.get('x-codex-turn-metadata')!),
    ).toMatchObject({
      turn_id: before.turnID,
      turn_started_at_unix_ms: before.turnStartedAt,
    })
    expect(location.host.turns).toEqual([])
  })

  test('an unavailable WebSocket baseline retires its warm until a full frame completes', async () => {
    const files = keepWarmPool()
    const shared = { clock: { now: START }, timers: fakeTimers() }
    const location = await startLocation(files, shared)
    const ws = await websocket(location)
    const full = {
      type: 'response.create',
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }
    await ws.send(full)
    await ws.complete('r1')
    expect(managerOf(files)!.status().tracked).toBe(1)
    await ws.send({ ...full, previous_response_id: 'missing' })
    await ws.complete('r2')
    shared.clock.now += 4 * MINUTE
    await managerOf(files)!.tick()
    expect(managerOf(files)!.status().tracked).toBe(0)
    expect(location.warms).toHaveLength(0)
    await ws.send(full)
    await ws.complete('r3')
    shared.clock.now += 4 * MINUTE
    await managerOf(files)!.tick()
    expect(location.warms).toHaveLength(1)
  })

  test('a rerouted WebSocket session never warms the old captured account', async () => {
    const files = keepWarmPool()
    const shared = { clock: { now: START }, timers: fakeTimers() }
    const location = await startLocation(files, shared)
    const ws = await websocket(location)
    await ws.send({
      type: 'response.create',
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    })
    await ws.complete('r1')
    expect(managerOf(files)!.status().tracked).toBe(1)
    acquireSessionAccounts(files.paths()).record('ses_ws', 'B')
    shared.clock.now += 4 * MINUTE
    await managerOf(files)!.tick()
    expect(location.warms).toHaveLength(0)
    expect(managerOf(files)!.status().tracked).toBe(0)
  })

  for (const parent of [
    'x-opencode-parent-session-id',
    'x-parent-session-id',
    'parentID',
  ]) {
    for (const optedIn of [false, true]) {
      test(`WebSocket subagent via ${parent} warms only with opt-in ${optedIn}`, async () => {
        const files = keepWarmPool()
        const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
        config.cacheKeep.subagents = optedIn
        writeFileSync(files.configPath, JSON.stringify(config))
        const shared = { clock: { now: START }, timers: fakeTimers() }
        const location = await startLocation(
          files,
          shared,
          undefined,
          parent === 'parentID'
            ? new Map([['ses_child', 'parent']])
            : undefined,
        )
        const ws = await websocket(
          location,
          'ses_child',
          parent === 'parentID' ? {} : { [parent]: 'parent' },
        )
        await ws.send({
          type: 'response.create',
          model: 'gpt-5.5',
          input: [{ role: 'user', content: 'hi' }],
        })
        await ws.complete('r1')
        shared.clock.now += 4 * MINUTE
        await managerOf(files)!.tick()
        expect(location.warms).toHaveLength(optedIn ? 1 : 0)
        if (optedIn)
          expect(managerOf(files)!.status().targets[0]!.isSubagent).toBe(true)
      })
    }
  }
})

function keepWarmPool() {
  const files = poolFiles()
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  seedPool(files, 'main-first', [{ id: 'main', access: 'main-pool-token' }])
  const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
  config.cacheKeep = { enabled: true }
  writeFileSync(files.configPath, JSON.stringify(config))
  return files
}

describe('OpenCode 2 keep-warm in setup', () => {
  test('Cache menu settings reach the shared manager and captures in both live locations', async () => {
    const files = keepWarmPool()
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    config.cacheKeep.enabled = false
    writeFileSync(files.configPath, JSON.stringify(config))
    const shared = { clock: { now: START }, timers: fakeTimers() }
    const directory = join(files.dir, 'A')
    const a = await startLocation(files, shared, directory)
    const b = await startLocation(files, shared, join(files.dir, 'B'))
    const mirror = acquireFrameMirror(files.paths())
    const frame = JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'mirror' }],
    })
    mirror.send('ws_off', frame)
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
    const client = createRpcClient(
      (await resolveRpcDir(directory)).dir,
      process.pid,
    )
    const apply = (
      actionId: string,
      values: Record<string, boolean | string>,
    ) =>
      client.apply({ command: 'openai', sectionId: 'cache', actionId, values })
    await client.pending(0, 'ses_on')
    await a.host.commands[0]!.execute({ sessionID: 'ses_on' })
    const opened = drainNotifications(0, 'ses_on').at(-1)!.payload
    if (!('menu' in opened)) throw new Error('expected the OpenAI menu')
    const section = opened.menu.sections.find((s) => s.id === 'cache')!
    expect(section.actions.map((a) => a.id)).toEqual([
      'enabled',
      'subagents',
      'sustain',
      'window',
    ])
    expect(section.lines).not.toContain(
      "Sessions using OpenCode 2's WebSocket are not warmed yet.",
    )
    expect((await apply('unknown', {})).ok).toBe(false)
    expect(
      (
        await client.apply({
          command: 'openai',
          sectionId: 'cache',
          actionId: 'enabled',
          itemId: 'ses_on',
          values: { enabled: true },
        })
      ).ok,
    ).toBe(false)
    await b.request('ses_off')
    const manager = managerOf(files)!
    expect(manager.status().tracked).toBe(0)
    expect((await apply('enabled', { enabled: true })).ok).toBe(true)
    mirror.send('ws_on', frame)
    mirror.receive(
      'ws_on',
      JSON.stringify({ type: 'response.completed', response: { id: 'r1' } }),
    )
    mirror.send('ws_pending', frame)
    expect(mirror.status().sessions).toHaveLength(2)
    await b.request('ses_on')
    expect(manager.status().tracked).toBe(1)
    expect((await apply('subagents', { subagents: true })).ok).toBe(true)
    await b.request('child', 'primary', {
      'x-opencode-parent-session-id': 'ses_on',
    })
    expect(
      manager.status().targets.find((t) => t.sessionKey === 'child')
        ?.isSubagent,
    ).toBe(true)
    expect((await apply('subagents', { subagents: false })).ok).toBe(true)
    manager.remove('child')
    await b.request('child_off', 'primary', {
      'x-opencode-parent-session-id': 'ses_on',
    })
    expect(manager.status().targets.map((t) => t.sessionKey)).toEqual([
      'ses_on',
    ])
    expect((await apply('sustain', { sustain: true })).ok).toBe(true)
    expect(manager.status().sustain).toBe(true)
    expect((await apply('window', { window: '22-6' })).ok).toBe(true)
    expect(manager.status().window).toEqual({ startHour: 22, endHour: 6 })
    await a.request('ses_outside')
    shared.clock.now += 4 * MINUTE
    await manager.tick()
    expect(b.warms).toHaveLength(0)
    expect(manager.status().tracked).toBe(1)
    expect((await apply('window', { window: '' })).ok).toBe(true)
    await manager.tick()
    expect(b.warms).toHaveLength(1)
    expect(
      JSON.parse(readFileSync(files.configPath, 'utf8')).cacheKeep,
    ).toMatchObject({ enabled: true, subagents: false, sustain: true })
    expect((await apply('enabled', { enabled: false })).ok).toBe(true)
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
    mirror.send('ws_off_again', frame)
    expect(mirror.status()).toEqual({ bytes: 0, sessions: [] })
    expect(manager.status().running).toBe(false)
    await b.request('ses_off_again')
    expect(manager.status().tracked).toBe(0)
  })

  test('captures the final owned agent-loop request at the post-installer seam and warms it with the pool token', async () => {
    const files = keepWarmPool()
    const shared = { clock: { now: Date.now() }, timers: fakeTimers() }
    const location = await startLocation(files, shared)
    await location.request('ses_1')
    await location.request('ses_title', 'title')
    await location.host.fire('http.request', {
      ...scope('ses_key'),
      request: new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-user-api-key' },
        body: '{"model":"gpt-5.5","input":[]}',
      }),
    })
    const manager = managerOf(files)!
    expect(manager.status().targets.map((t) => t.sessionKey)).toEqual(['ses_1'])
    expect(manager.status().targets[0]!.accountId).toBe('main')
    const held = JSON.stringify([
      ...(manager as unknown as { targets: Map<string, unknown> }).targets,
    ])
    expect(held).not.toContain('main-pool-token')
    expect(held).not.toContain(placeholderSecret('openai'))

    shared.clock.now += 4 * MINUTE
    await manager.tick()
    expect(location.warms).toHaveLength(1)
    const [warm] = location.warms
    expect(warm!.headers.get('authorization')).toBe('Bearer main-pool-token')
    expect(warm!.headers.get('chatgpt-account-id')).toBe('chatgpt-main')
    expect(warm!.body).toMatchObject({ store: false })
    expect(warm!.body).not.toHaveProperty('max_output_tokens')
    expect(shared.timers.armed).toHaveLength(1)
  })

  test('a session deleted by the host stops warming at once', async () => {
    const files = keepWarmPool()
    const shared = { clock: { now: Date.now() }, timers: fakeTimers() }
    const location = await startLocation(files, shared)
    await location.request('ses_1')
    await location.host.publish('session.deleted', { sessionID: 'ses_1' })
    expect(managerOf(files)!.status().tracked).toBe(0)
  })

  test('two locations hold one manager with one timer; disposing one leaves the other warming', async () => {
    const files = keepWarmPool()
    const shared = { clock: { now: Date.now() }, timers: fakeTimers() }
    const a = await startLocation(files, shared)
    const b = await startLocation(files, shared)
    await a.request('ses_1')
    const manager = managerOf(files)!
    await a.dispose()
    expect(managerOf(files)).toBe(manager)
    // A disposed location's requests are no longer captured for warming.
    await a.request('ses_late')
    expect(manager.status().tracked).toBe(1)
    shared.clock.now += 4 * MINUTE
    await manager.tick()
    expect(a.warms).toHaveLength(0)
    expect(b.warms).toHaveLength(1)
    expect(shared.timers.armed).toHaveLength(1)
    expect(shared.timers.cleared).toBe(0)
    await b.dispose()
    expect(shared.timers.cleared).toBe(1)
    expect(managerOf(files)).toBeUndefined()
  })
})
