// The OpenCode 2 session-event subscriptions: setup listens for only
// `session.deleted`, while the auth installer also takes the run-end events
// that release held retries. A deleted session still loses its routing pin,
// its frame-mirror snapshot and its keep-warm target, and an interrupted run
// releases a held same-account retry so the next primary request chooses
// fresh.

import { expect, spyOn, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import * as cacheKeep from '../v2/cache-keep'
import { FrameMirror } from '../v2/frame-mirror'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  type RequestKind,
  scope,
  seedPool,
} from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const offline: typeof fetch = Object.assign(
  async () => {
    throw new Error('offline in tests')
  },
  { preconnect: () => {} },
) as typeof fetch

type Host = ReturnType<typeof fakeOpenCode2Host>

async function httpRequest(
  host: Host,
  sessionID = 'ses_1',
  kind: RequestKind = 'primary',
) {
  const draft = {
    ...scope(sessionID, kind),
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  return draft.request
}

async function poolRequestHeaders(
  host: Host,
  sessionID = 'ses_1',
  kind: RequestKind = 'primary',
) {
  const draft = {
    ...scope(sessionID, kind),
    headers: {
      Authorization: `Bearer ${PLACEHOLDER}`,
      'chatgpt-account-id': 'acct-HOST',
    } as Record<string, string>,
  }
  await host.fire('model.request', draft)
  const request = await httpRequest(host, sessionID, kind)
  return Object.fromEntries(request.headers)
}

const bearer = (headers: Record<string, string>) =>
  Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1]

test('session deletion arrives through a filtered subscription and forgets the session', async () => {
  const files = poolFiles()
  seedPool(files, 'sticky-balanced', [
    { id: 'a', usedPercent: 10 },
    { id: 'b', usedPercent: 90 },
  ])
  const keepForgets: string[] = []
  const acquireKeep = cacheKeep.acquireCacheKeep
  const keepSpy = spyOn(cacheKeep, 'acquireCacheKeep').mockImplementation(((
    ...args: Parameters<typeof acquireKeep>
  ) => {
    const lease = acquireKeep(...args)
    const forget = lease.forget
    return {
      ...lease,
      forget: (sessionID: string) => {
        keepForgets.push(sessionID)
        forget(sessionID)
      },
    }
  }) as typeof acquireKeep)
  const mirrorForget = spyOn(FrameMirror.prototype, 'forget')
  const host = fakeOpenCode2Host()
  const ctx: Parameters<typeof setupOpenAIAuth>[0] = host.ctx
  const subscribe = spyOn(ctx.event, 'subscribe')
  const stop = await setupOpenAIAuth(ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
  })
  try {
    // The installer takes deletion plus the run-end events that release held
    // retries; setup's own loop takes only deletion.
    const requested = subscribe.mock.calls.map(
      ([options]) =>
        (options as { types?: readonly string[] } | undefined)?.types ?? [],
    )
    expect(requested).toEqual([
      [
        'session.deleted',
        'session.execution.succeeded',
        'session.execution.failed',
        'session.execution.interrupted',
      ],
      ['session.deleted'],
    ])
    const filtered = subscribe.mock.calls.find(([options]) =>
      (options as { types?: readonly string[] } | undefined)?.types?.includes(
        'session.deleted',
      ),
    )
    expect(
      (filtered?.[0] as { signal?: unknown } | undefined)?.signal,
    ).toBeInstanceOf(AbortSignal)

    // The session pins to row a while it has the most room.
    expect(bearer(await poolRequestHeaders(host, 'ses_gone'))).toBe(
      'Bearer a-token',
    )
    // Row b now has far more room, so the pin would keep row a only if the
    // deletion was missed.
    seedPool(files, 'sticky-balanced', [
      { id: 'a', usedPercent: 80 },
      { id: 'b', usedPercent: 5 },
    ])
    await host.publish('session.deleted', { sessionID: 'ses_gone' })
    expect(bearer(await poolRequestHeaders(host, 'ses_gone'))).toBe(
      'Bearer b-token',
    )
    expect(keepForgets).toContain('ses_gone')
    expect(mirrorForget.mock.calls).toContainEqual(['ses_gone'])
  } finally {
    await stop?.()
    subscribe.mockRestore()
    mirrorForget.mockRestore()
    keepSpy.mockRestore()
    rmSync(files.dir, { recursive: true, force: true })
  }
})

async function sendPrimary(host: Host, sessionID = 'ses_1') {
  const model = {
    ...scope(sessionID),
    model: { providerID: 'openai', id: 'gpt-5.5' },
    headers: {} as Record<string, string>,
  }
  await host.fire('model.request', model)
  const draft = {
    ...scope(sessionID),
    model: model.model,
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PLACEHOLDER}`,
        ...model.headers,
      },
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  return draft
}

async function refuseUsageLimit(
  host: Host,
  draft: Awaited<ReturnType<typeof sendPrimary>>,
) {
  const response = {
    ...scope(draft.sessionID),
    request: draft.request,
    response: Response.json(
      { error: { type: 'usage_limit_reached' } },
      { status: 429 },
    ),
  }
  await host.fire('http.response', response)
  await response.response.text()
  const retry = {
    sessionID: draft.sessionID,
    model: { providerID: 'openai', id: 'gpt-5.5' },
    attempt: 1,
    error: { type: 'api', message: 'usage limit', status: 429 },
    decision: { retry: true, delay: 1234 },
  }
  await host.fire('retry', retry)
  return retry.decision
}

const bearerOf = (request: Request) => request.headers.get('authorization')

test('a post-output WebSocket continuation keeps its HTTP fallback on the same account', async () => {
  const files = poolFiles()
  // Account a starts with the most room, so the session pins to it.
  seedPool(files, 'sticky-balanced', [
    { id: 'a', usedPercent: 10 },
    { id: 'b', usedPercent: 50 },
  ])
  const host = fakeOpenCode2Host()
  const ctx: Parameters<typeof setupOpenAIAuth>[0] = host.ctx
  const stop = await setupOpenAIAuth(ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
  })
  const handshake = async () => {
    const draft = {
      ...scope(),
      url: 'wss://api.openai.com/v1/responses',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
    }
    await host.fire('experimental.ws.handshake', draft)
    return draft.headers
  }
  try {
    // The stream starts on account a over WebSocket and produces output,
    // so the attempt owns the session's post-output pin.
    expect((await handshake()).authorization).toBe('Bearer a-token')
    await host.fire('experimental.ws.send', {
      ...scope(),
      frame: JSON.stringify({ type: 'response.create', input: [] }),
    })
    await host.fire('experimental.ws.receive', {
      ...scope(),
      frame: JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'hello',
      }),
    })
    // The socket dies mid-stream; the host retries the interrupted read and
    // the continuation reconnects on the same account, taking the pin.
    const retry = {
      sessionID: 'ses_1',
      model: { providerID: 'openai', id: 'gpt-5.5' },
      attempt: 1,
      error: { type: 'provider.transport', message: 'socket closed' },
      decision: { retry: true, delay: 1234 },
    }
    await host.fire('retry', retry)
    expect(retry.decision).toEqual({ retry: true, delay: 1234 })
    expect((await handshake()).authorization).toBe('Bearer a-token')
    // Account a then fills up, so a fresh choice would move the session to
    // account b. The HTTP fallback still belongs to the pinned attempt, so
    // it stays on the account that owns the session's output.
    seedPool(files, 'sticky-balanced', [
      { id: 'a', usedPercent: 100 },
      { id: 'b', usedPercent: 10 },
    ])
    expect(bearerOf((await sendPrimary(host)).request)).toBe('Bearer a-token')
  } finally {
    await stop?.()
    rmSync(files.dir, { recursive: true, force: true })
  }
})

test('an interrupted run releases a held same-account retry so the next primary request chooses fresh', async () => {
  const files = poolFiles()
  // One account: the refused send holds the host's wait on that same account.
  seedPool(files, 'sticky-balanced', [{ id: 'a', usedPercent: 10 }])
  const host = fakeOpenCode2Host()
  const ctx: Parameters<typeof setupOpenAIAuth>[0] = host.ctx
  const stop = await setupOpenAIAuth(ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
  })
  try {
    expect(bearerOf((await sendPrimary(host)).request)).toBe('Bearer a-token')
    // A 429 on the only account keeps the host's wait on that same account.
    expect(await refuseUsageLimit(host, await sendPrimary(host))).toEqual({
      retry: true,
      delay: 1234,
    })
    // A new account with plenty of room joins the pool; a fresh choice would
    // take it, while the held retry would stay on the refused account.
    seedPool(files, 'sticky-balanced', [
      { id: 'a', usedPercent: 10 },
      { id: 'b', usedPercent: 5 },
    ])
    // The user interrupts the run: the held retry is released instead of
    // pinning the next primary request to the refused account.
    await host.publish('session.execution.interrupted', {
      sessionID: 'ses_1',
      reason: 'user',
    })
    expect(bearerOf((await sendPrimary(host)).request)).toBe('Bearer b-token')
  } finally {
    await stop?.()
    rmSync(files.dir, { recursive: true, force: true })
  }
})
