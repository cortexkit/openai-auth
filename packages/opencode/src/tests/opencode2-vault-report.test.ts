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

import { describe, expect, it } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  installOpenCode2Auth,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
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
        snapshot: () => undefined,
        authorize: async () => receipt(),
        reportFailure: async (served, status) => {
          reports.push({ receipt: served, status })
        },
        recordSnapshot: async () => {},
        requestReading: () => {},
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
