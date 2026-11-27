// The OpenCode 2 session-deletion subscription: setup asks the host for only
// `session.deleted` events, and a deleted session still loses its routing pin,
// its frame-mirror snapshot and its keep-warm target.

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
    // Only the deletion loop filters; every requested type across every
    // subscription is exactly the deletion event.
    const requested = subscribe.mock.calls.map(
      ([options]) =>
        (options as { types?: readonly string[] } | undefined)?.types ?? [],
    )
    expect(requested.flatMap((types) => [...types])).toEqual([
      'session.deleted',
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
