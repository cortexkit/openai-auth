import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCode2AuthError } from '@cortexkit/common-auth/opencode2'
import type {
  AccountPaths,
  AccountStorage,
} from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source'
import { type PoolRequestContext, servePoolRequest } from '../core/pool-request'
import { createOpenAIAdapter } from '../v2/adapter'
import { SessionPins } from '../v2/pins'
import { scope } from './fixtures/opencode2-host'
import { HOUR, quotaMap, readJson, seedPool } from './fixtures/pool-install'

let dir: string
let paths: AccountPaths
let source: PoolAccountSource
const requestScope = () => ({
  ...scope(),
  providerID: 'openai',
  modelID: 'gpt-5.5',
})
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'request-vault-audit-'))
  paths = {
    configPath: join(dir, 'config.json'),
    statePath: join(dir, 'state.json'),
  }
  seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
    { id: 'main', quota: quotaMap(10) },
    { id: 'B', quota: quotaMap(10) },
    { id: 'C', quota: quotaMap(10) },
  ])
  source = new PoolAccountSource({
    paths: () => paths,
    pullQuota: async () => undefined,
    refreshProvider: async () => ({
      access: 'contradicted-token',
      refresh: 'rotated-refresh',
      expires: Date.now() + HOUR,
      identity: 'another-chatgpt-account',
    }),
  })
  await source.load()
  await source.settled()
})
afterEach(async () => {
  source.dispose()
  await source.settled()
  rmSync(dir, { recursive: true, force: true })
})

async function disable(id: string) {
  const config = readJson(paths.configPath) as {
    accounts: Array<{ id: string; enabled: boolean }>
  }
  config.accounts.find((row) => row.id === id)!.enabled = false
  writeFileSync(paths.configPath, JSON.stringify(config))
  // The menu's afterWrite reload has the same effect on the in-memory source.
  await source.load()
}

function context(
  send: PoolRequestContext['send'],
  storage: AccountStorage | null = null,
): PoolRequestContext {
  return {
    source,
    storage,
    mode: 'main-first',
    sessionId: undefined,
    body: '{}',
    replayable: true,
    now: Date.now,
    send,
    recordQuota: () => {},
    placePin: () => undefined,
    blocked: () => new Response('blocked', { status: 401 }),
    resetCredits: () => undefined,
    isAbort: () => false,
    log: { debug: () => {} },
  }
}

describe('send-time pool eligibility', () => {
  test('OpenCode 1 passes over a fallback disabled while main was sending', async () => {
    const sent: string[] = []
    const result = await servePoolRequest(
      context(async (target, token) => {
        sent.push(token)
        if (target.id === 'main') {
          await disable('B')
          return new Response('fallback', { status: 429 })
        }
        return new Response('ok')
      }),
    )
    expect(sent).toEqual(['main-token', 'C-token'])
    expect(result.servedId).toBe('C')
  })

  test('OpenCode 2 refuses headers for a newly disabled chosen row', async () => {
    const { adapter } = createOpenAIAdapter({
      source,
      storage: async () => null,
      pins: new SessionPins(),
    })
    expect(await adapter.chooseAccount(requestScope())).toBe('main')
    await disable('main')
    await expect(
      adapter.accountHeaders({ ...requestScope(), accountId: 'main' }),
    ).rejects.toBeInstanceOf(OpenCode2AuthError)
  })

  test('OpenCode 2 refuses headers after a refresh contradicts the chosen identity', async () => {
    const { adapter } = createOpenAIAdapter({
      source,
      storage: async () => null,
      pins: new SessionPins(),
    })
    expect(await adapter.chooseAccount(requestScope())).toBe('main')
    await source.refreshDueTokens({
      accounts: [],
      refresh: { refreshBeforeExpiryMinutes: 2000 },
    } as unknown as AccountStorage)
    expect(source.peek().rows.find((row) => row.id === 'main')?.candidate).toBe(
      false,
    )
    await expect(
      adapter.accountHeaders({ ...requestScope(), accountId: 'main' }),
    ).rejects.toBeInstanceOf(OpenCode2AuthError)
  })
})

describe('vault quota floor', () => {
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    quota: { minimumRemaining: { primary: 20 } },
  }
  test('OpenCode 1 applies minimumRemaining to vault routes', async () => {
    await disable('main')
    await disable('B')
    await disable('C')
    const sent: string[] = []
    const ctx = context(async (target) => {
      sent.push(target.id)
      return new Response('ok')
    }, storage)
    ctx.vault = {
      routes: () => [
        { id: 'low', kind: 'oauth', quota: quotaMap(90) },
        { id: 'healthy', kind: 'oauth', quota: quotaMap(10) },
      ],
      identities: () => new Set(),
      requestReading: () => {},
      send: async (id, dispatch) => dispatch(id, {} as never),
    }
    expect((await servePoolRequest(ctx)).servedId).toBe('healthy')
    expect(sent).toEqual(['healthy'])
  })

  test('OpenCode 2 applies minimumRemaining to vault routes', async () => {
    await disable('main')
    await disable('B')
    await disable('C')
    const { adapter } = createOpenAIAdapter({
      source,
      storage: async () => storage,
      pins: new SessionPins(),
      vault: {
        routes: () => [
          { id: 'low', kind: 'oauth', quota: quotaMap(90) },
          { id: 'healthy', kind: 'oauth', quota: quotaMap(10) },
        ],
        identities: () => new Set(),
        requestReading: () => {},
        authorize: async (id: string) => ({ accessToken: id }),
        recordSnapshot: async () => {},
        reportFailure: async () => {},
      } as never,
    })
    expect(await adapter.chooseAccount(requestScope())).toBe('healthy')
  })
})
