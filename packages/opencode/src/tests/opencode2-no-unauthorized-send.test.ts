// The OpenCode 2 adapter never lets the host send a request without the
// chosen account's credential. When the account picked for a request has
// nothing to send with by the time its headers are set (a pool row whose
// token ran out or was cleared, a vault account the vault will not serve),
// the request is refused locally with the installer's no-account refusal, so
// the host stops before anything reaches the provider. While an account is
// still being chosen, a pool row without a usable token is passed over for
// the next account, as the OpenCode 1 request path does.

import { describe, expect, it } from 'bun:test'
import {
  installOpenCode2Auth,
  OpenCode2AuthError,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { PoolRow } from '@cortexkit/common-auth/store'
import { createOpenAIAdapter, type PoolAccess } from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, quotaMap, scope } from './fixtures/opencode2-host'

const PLACEHOLDER = placeholderSecret('openai')
const REFUSAL = 'request refused: no account with a usable credential'
const HOUR = 3600_000

function poolRow(id: string): PoolRow {
  return {
    id,
    type: 'oauth',
    enabled: true,
    candidate: true,
    hasEntry: true,
    needsFirstReading: false,
    credentialEpoch: 1,
    identity: `chatgpt-${id}`,
    credential: {
      type: 'oauth',
      access: `${id}-token`,
      refresh: `${id}-refresh`,
      expires: Date.now() + 24 * HOUR,
    },
    quota: quotaMap(10),
  } as PoolRow
}

/**
 * A pool source over fixed rows. `tokenOf` decides, at each call, which
 * bearer a row can send with; undefined means none.
 */
function stubSource(
  rows: PoolRow[],
  tokenOf: (row: PoolRow) => string | undefined,
): PoolAccess {
  const view = { active: true, rows }
  return {
    current: async () => view,
    peek: () => view,
    prepareTokens: async () => {},
    usableToken: (row: PoolRow) => tokenOf(row),
    rateLimitMarks: () => new Map(),
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: () => {},
    markRateLimited: () => {},
  } as unknown as PoolAccess
}

async function install(
  adapter: ReturnType<typeof createOpenAIAdapter>['adapter'],
) {
  const host = fakeOpenCode2Host()
  await installOpenCode2Auth(host.ctx, adapter)
  return host
}

function modelRequestDraft() {
  return {
    ...scope('ses_1', 'primary'),
    headers: {
      Authorization: `Bearer ${PLACEHOLDER}`,
      'chatgpt-account-id': 'acct-HOST',
    } as Record<string, string>,
  }
}

async function expectRefusal(pending: Promise<unknown>) {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(OpenCode2AuthError)
  expect((error as OpenCode2AuthError).kind).toBe('no-account')
  // The message is the fixed refusal text, which names no account id,
  // provider or vault.
  expect((error as OpenCode2AuthError).message).toBe(REFUSAL)
}

describe('OpenCode 2 never sends without the account credential', () => {
  it('refuses locally when the chosen row loses its token between the choice and its headers', async () => {
    const row = poolRow('main')
    // The row holds a token while it is chosen; it is gone (a refresh that
    // cleared it, a logout) by the time the headers are asked for.
    let tokenPresent = true
    const openai = createOpenAIAdapter({
      source: stubSource([row], () =>
        tokenPresent ? 'main-token' : undefined,
      ),
      storage: async () => null,
      pins: new SessionPins(),
    })
    const chosen: Array<string | undefined> = []
    const adapter = {
      ...openai.adapter,
      chooseAccount: async (
        input: Parameters<typeof openai.adapter.chooseAccount>[0],
      ) => {
        const accountId = await openai.adapter.chooseAccount(input)
        chosen.push(accountId)
        tokenPresent = false
        return accountId
      },
    }
    const host = await install(adapter)

    const draft = modelRequestDraft()
    await expectRefusal(host.fire('model.request', draft))
    expect(chosen).toEqual(['main'])
    // The refusal stops the host before it picks a transport; the draft was
    // never given a cleared credential to go out with.
    expect(draft.headers.Authorization).toBe(`Bearer ${PLACEHOLDER}`)

    // A send that skipped `model.request` chooses again; the row still has
    // no token and no other account is left, so it is refused as well.
    const request = {
      ...scope('ses_1', 'primary'),
      request: new Request('http://codex.test/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
        body: '{}',
      }),
    }
    await expect(host.fire('http.request', request)).rejects.toBeInstanceOf(
      OpenCode2AuthError,
    )
    expect(chosen).toEqual(['main', undefined])
  })

  it('passes over a row without a usable token for the next account while choosing', async () => {
    const openai = createOpenAIAdapter({
      source: stubSource([poolRow('main'), poolRow('fb')], (row) =>
        row.id === 'main' ? undefined : `${row.id}-token`,
      ),
      storage: async () => ({ routing: { mode: 'main-first' } }) as never,
      pins: new SessionPins(),
    })
    const host = await install(openai.adapter)
    const draft = modelRequestDraft()
    await host.fire('model.request', draft)
    const headers = new Headers(draft.headers)
    expect(headers.get('authorization')).toBe('Bearer fb-token')
    expect(headers.get('chatgpt-account-id')).toBe('chatgpt-fb')
  })

  it('refuses locally when no row has a usable token', async () => {
    const openai = createOpenAIAdapter({
      source: stubSource([poolRow('main'), poolRow('fb')], () => undefined),
      storage: async () => null,
      pins: new SessionPins(),
    })
    const host = await install(openai.adapter)
    const draft = modelRequestDraft()
    await expect(host.fire('model.request', draft)).rejects.toBeInstanceOf(
      OpenCode2AuthError,
    )
    expect(draft.headers.Authorization).toBe(`Bearer ${PLACEHOLDER}`)
  })

  it('refuses locally when the vault will not serve the chosen vault account at header time', async () => {
    const openai = createOpenAIAdapter({
      source: stubSource([], () => undefined),
      storage: async () => null,
      pins: new SessionPins(),
      vault: {
        routes: () => [],
        identities: () => new Set<string>(),
        enrolled: () => true,
        snapshot: () => undefined,
        authorize: async () => undefined,
        reportFailure: async () => {},
        recordSnapshot: async () => {},
        requestReading: () => {},
      } as never,
    })
    await expectRefusal(
      openai.adapter.accountHeaders({
        ...scope(),
        providerID: 'openai',
        modelID: 'gpt-5.5',
        accountId: 'oauth:openai:vault',
      }) as Promise<unknown>,
    )
  })
})
