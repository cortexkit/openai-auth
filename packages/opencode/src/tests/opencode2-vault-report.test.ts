// Which 401s the OpenCode 2 adapter reports to the vault. Only a send the vault
// authorized is reported, once, against the record version in that send's
// receipt; a 401 on a local pool account is the pool's own business. The vault
// rotates a refreshable credential on every report it applies. The shared vault
// consumer also refuses a report for a send it never authorized, so this check
// is the first of two layers: without it the adapter would still log a false
// "vault account answered 401" warning and re-read the vault's account list.
//
// The vault here is a stand-in that records every call the adapter makes to
// it; the adapter runs behind the real installer on a fake OpenCode 2 host.

import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaustrumConsumer,
  type ClaustrumScopedAttempt,
} from '@cortexkit/common-auth/claustrum'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolView } from '../core/pool-account-source'
import { createOpenAIAdapter, type PoolAccess } from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const HOUR = 3600_000
const VAULT_ROUTE = 'oauth:openai:vault'

function healthyQuota(): QuotaMap {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt: Date.now(),
        usedPercent: 10,
        resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
  }
}

const mainRow: PoolRow = {
  id: 'main',
  type: 'oauth',
  enabled: true,
  candidate: true,
  hasEntry: true,
  needsFirstReading: false,
  credentialEpoch: 1,
  identity: 'chatgpt-main',
  credential: {
    type: 'oauth',
    access: 'main-token',
    refresh: 'main-refresh',
    expires: Date.now() + 24 * HOUR,
  },
  quota: healthyQuota(),
}

const poolSource: PoolAccess = (() => {
  const view: PoolView = { active: true, rows: [mainRow] }
  return {
    current: async () => view,
    peek: () => view,
    prepareTokens: async () => {},
    usableToken: () => 'main-token',
    rateLimitMarks: () => new Map<string, number>(),
    refreshBackoffFor: () => new Map<string, number>(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: () => {},
  }
})()

/** The receipt the vault serves for one send, at record version 7. */
function receipt(): ClaustrumScopedAttempt {
  return {
    credentialId: VAULT_ROUTE,
    credentialType: 'oauth',
    accountIdentity: 'chatgpt-vault',
    accountIdentitySource: 'asserted',
    accessToken: 'vault-token',
    recordVersion: 7,
    expiresAtMs: null,
  }
}

async function send(
  host: ReturnType<typeof fakeOpenCode2Host>,
  status: number,
) {
  const draftScope = scope('ses_1', 'primary')
  const headers: Record<string, string> = {
    authorization: `Bearer ${PLACEHOLDER}`,
  }
  await host.fire('model.request', { ...draftScope, headers })
  const draft = {
    ...draftScope,
    request: new Request('https://codex.test/v1/responses', {
      method: 'POST',
      headers,
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  await host.fire('http.response', {
    ...draftScope,
    request: draft.request,
    response: new Response('{}', { status }),
  })
  return draft.request.headers
}

describe('vault failure reports on OpenCode 2', () => {
  it('a 401 on a local pool account reports nothing to the vault; a 401 on a vault account reports once, with the served record version', async () => {
    const reports: Array<{
      receipt: ClaustrumScopedAttempt | undefined
      status: number
    }> = []
    // Before this host connects to the vault, main-first serves the pool row
    // `main`. Once connected (vault mode), only the vault account serves.
    let mode: 'main-first' | 'fallback-first' = 'main-first'
    let enrolled = false
    const openai = createOpenAIAdapter({
      source: poolSource,
      storage: async (): Promise<AccountStorage> => ({
        version: 1,
        accounts: [],
        routing: { mode },
      }),
      pins: new SessionPins(),
      vault: {
        routes: () => [
          {
            id: VAULT_ROUTE,
            kind: 'oauth',
            identity: 'chatgpt-vault',
            quota: healthyQuota(),
          },
        ],
        identities: () => new Set<string>(['chatgpt-vault']),
        enrolled: () => enrolled,
        authority: async () => (enrolled ? 'vault' : 'local'),
        snapshot: () => undefined,
        authorize: async () => receipt(),
        reportFailure: async (served, status) => {
          reports.push({ receipt: served, status })
        },
        recordSnapshot: async () => {},
        reportUsage: () => {},
        requestReading: () => {},
        grantReach: () => undefined,
        name: 'openai-auth-opencode',
      },
    })
    const host = fakeOpenCode2Host()
    await installOpenCode2Auth(host.ctx, openai.adapter)

    // The installer ends an error response's attempt as the response hook
    // runs, and the adapter decides whether to report before its first
    // await, so any report call has been made once the hook returns.
    const pool = await send(host, 401)
    expect(pool.get('authorization')).toBe('Bearer main-token')
    expect(reports).toEqual([])

    mode = 'fallback-first'
    enrolled = true
    const vault = await send(host, 401)
    expect(vault.get('authorization')).toBe('Bearer vault-token')
    expect(reports).toEqual([
      {
        receipt: expect.objectContaining({
          credentialId: VAULT_ROUTE,
          recordVersion: 7,
        }),
        status: 401,
      },
    ])
  })
})

describe('OpenCode 2 reply usage', () => {
  async function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'opencode2-usage-'))
    const target = new OpenAiVault({ host: 'opencode', stateDir: directory })
    let enrolled = false
    let selected = 'a'
    const openai = createOpenAIAdapter({
      source: poolSource,
      storage: async () => ({
        version: 1,
        accounts: [],
        routing: { mode: 'fallback-first' },
      }),
      pins: new SessionPins(),
      vault: {
        routes: () =>
          enrolled
            ? [
                {
                  id: selected,
                  kind: 'oauth',
                  identity: `account-${selected}`,
                  quota: healthyQuota(),
                },
              ]
            : [],
        identities: () => new Set(enrolled ? [`account-${selected}`] : []),
        enrolled: () => enrolled,
        authority: async () => (enrolled ? 'vault' : 'local'),
        snapshot: () => undefined,
        authorize: async (id) => ({
          ...receipt(),
          credentialId: `credential-${id}`,
          accountIdentity: `account-${id}`,
        }),
        reportFailure: async () => {},
        recordSnapshot: async () => {},
        reportUsage: target.reportUsage.bind(target),
        requestReading: () => {},
        grantReach: () => undefined,
        name: target.name,
      },
    })
    const host = fakeOpenCode2Host()
    const installation = await installOpenCode2Auth(host.ctx, openai.adapter)
    openai.attach(installation)
    return {
      host,
      select(id: string) {
        enrolled = true
        selected = id
      },
      close() {
        target.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  }

  async function draft(
    host: ReturnType<typeof fakeOpenCode2Host>,
    session: string,
  ) {
    const requestScope = scope(session, 'primary')
    const headers = { authorization: `Bearer ${PLACEHOLDER}` }
    await host.fire('model.request', { ...requestScope, headers })
    const input = {
      ...requestScope,
      request: new Request('https://codex.test/responses', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    }
    await host.fire('http.request', input)
    return input
  }

  it('HTTP reply usage is allowlisted and remains on its served attempt across concurrent accounts; local replies do not report', async () => {
    const fixture = await setup()
    const report = spyOn(
      ClaustrumConsumer.prototype,
      'reportUsage',
    ).mockImplementation(() => {})
    const reply = () =>
      new Response('{}', {
        headers: {
          'x-codex-primary-used-percent': '42',
          authorization: 'secret',
          'set-cookie': 'secret',
        },
      })
    try {
      const local = await draft(fixture.host, 'local')
      await fixture.host.fire('http.response', { ...local, response: reply() })
      expect(local.request.headers.get('authorization')).toBe(
        'Bearer main-token',
      )
      expect(report).not.toHaveBeenCalled()
      fixture.select('a')
      const first = await draft(fixture.host, 'first')
      fixture.select('b')
      const second = await draft(fixture.host, 'second')
      await fixture.host.fire('http.response', { ...second, response: reply() })
      await fixture.host.fire('http.response', { ...first, response: reply() })
      expect(report.mock.calls.map(([input]) => input)).toEqual(
        ['b', 'a'].map((id) => ({
          routeId: id,
          credentialId: `credential-${id}`,
          reading: {
            provider: 'codex',
            observedAtMs: expect.any(Number),
            account: `account-${id}`,
            headers: { 'x-codex-primary-used-percent': '42' },
          },
        })),
      )
    } finally {
      report.mockRestore()
      fixture.close()
    }
  })

  it('WebSocket reply usage forwards the original frame with its served receipt and isolates a throwing reporter', async () => {
    const fixture = await setup()
    const report = spyOn(
      ClaustrumConsumer.prototype,
      'reportUsage',
    ).mockImplementation(() => {
      throw new Error('reporter failed')
    })
    const frame = {
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 64, window_minutes: 300 },
        secondary: null,
      },
      additional_rate_limits: [],
    }
    const handshake = async (session: string) => {
      const input = {
        ...scope(session),
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
      }
      await fixture.host.fire('model.request', input)
      await fixture.host.fire('experimental.ws.handshake', {
        ...input,
        url: 'ws://codex.test/responses',
      })
    }
    const receive = (session: string) =>
      fixture.host.fire('experimental.ws.receive', {
        ...scope(session),
        frame: JSON.stringify(frame),
      })
    try {
      await handshake('local-ws')
      await receive('local-ws')
      expect(report).not.toHaveBeenCalled()
      fixture.select('a')
      await handshake('first-ws')
      fixture.select('b')
      await handshake('second-ws')
      expect((await receive('second-ws')).frame).toBe(JSON.stringify(frame))
      expect((await receive('first-ws')).frame).toBe(JSON.stringify(frame))
      expect(report.mock.calls.map(([input]) => input)).toEqual(
        ['b', 'a'].map((id) => ({
          routeId: id,
          credentialId: `credential-${id}`,
          reading: {
            provider: 'codex',
            observedAtMs: expect.any(Number),
            account: `account-${id}`,
            frame,
          },
        })),
      )
    } finally {
      report.mockRestore()
      fixture.close()
    }
  })
})
