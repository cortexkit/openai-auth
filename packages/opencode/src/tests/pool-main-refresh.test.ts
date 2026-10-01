// The slot refresh (`refreshMainWithLease` in index.ts) on a migrated install.
//
// After the migration a real login can land in OpenCode's slot again (a later
// `/login`). Until it is adopted into the pool, the request path serves and
// refreshes it the way it always did: under the `main-refresh` lock, with a
// lease and a backoff record. On a migrated install those go through the
// pool store's settings write, so these tests check that the refresh can read
// back what it wrote and that the settings write does not wait for the
// `main-refresh` lock the refresh already holds.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashRefreshToken,
  loadAccounts,
} from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
import { getAccountPaths } from '../core/account-paths.ts'
import { CodexAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import {
  HOUR,
  installWire,
  mockPluginInput,
  readJson,
  seedPool,
} from './fixtures/pool-install.ts'
import { restoreEnv } from './setup-env'
import {
  FLOOR_AUTH_FILE,
  FLOOR_LOG_FILE,
  FLOOR_SIDEBAR_STATE_FILE,
  FLOOR_STATE_FILE,
} from './setup-env.ts'

let configDir: string
let configFile: string
let stateFile: string
let originalFetch: typeof globalThis.fetch
let hooks: Hooks | undefined

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'oai-pool-main-refresh-'))
  configFile = join(configDir, 'openai-auth.json')
  stateFile = join(configDir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
    configDir,
    'sidebar-state.json',
  )
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(configDir, 'test.log')
  process.env.NODE_ENV = 'test'
  process.env.OPENCODE_CONFIG_DIR = configDir
  originalFetch = globalThis.fetch
  hooks = undefined
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await hooks?.dispose?.()
  await drainSidebarWrites()
  await new Promise((resolve) => setTimeout(resolve, 50))
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = FLOOR_SIDEBAR_STATE_FILE
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
  restoreEnv('OPENCODE_CONFIG_DIR')
  delete process.env.NODE_ENV
  rmSync(configDir, { recursive: true, force: true })
})

type Slot = { type: 'oauth'; access: string; refresh: string; expires: number }

/** Loads the plugin over a slot whose value `slot()` returns at each read. */
async function loadFetch(slot: () => Slot) {
  hooks = await CodexAuthPlugin(mockPluginInput(), {
    experimentalWebSockets: false,
  })
  const loader = hooks.auth?.loader
  if (!loader) throw new Error('No auth loader')
  const loaded = await loader(
    (async () => ({ ...slot() })) as never,
    { id: 'openai', label: 'OpenAI', models: [] } as never,
  )
  return (loaded as Record<string, unknown>).fetch as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>
}

function request(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }),
  }
}

const expiredLogin: Slot = {
  type: 'oauth',
  access: 'later-login-access',
  refresh: 'later-login-refresh',
  expires: Date.now() - 1_000,
}

describe('slot refresh on a migrated install', () => {
  it('refreshes a later login in the slot instead of reading its own lease as another holder', async () => {
    seedPool({ configFile, stateFile }, [{ id: 'fb1' }])
    const wire = installWire()
    const fetchOverride = await loadFetch(() => expiredLogin)

    const started = performance.now()
    const response = await fetchOverride(
      'https://api.openai.com/v1/responses',
      request(),
    )
    const elapsed = performance.now() - started

    expect(response.status).toBe(200)
    expect(wire.refreshTokens).toEqual(['later-login-refresh'])
    expect(wire.sends).toEqual(['Bearer refreshed-later-login-refresh'])
    // The settings writes under the held `main-refresh` lock must not wait
    // for that lock again: the store's lock wait is 15s, so a self-wait
    // would blow far past this bound.
    expect(elapsed).toBeLessThan(5_000)
    // The lease is gone once the refresh finished, wherever it was kept.
    const after = await loadAccounts(getAccountPaths(configFile))
    expect(after?.refresh?.mainRefreshLeaseId).toBeUndefined()
    expect(
      (readJson(configFile).refresh as Record<string, unknown>)
        .mainRefreshLeaseId,
    ).toBeUndefined()
  })

  it('a failed refresh records a backoff the next attempt reads', async () => {
    seedPool({ configFile, stateFile }, [{ id: 'fb1' }])
    const wire = installWire()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) {
        wire.refreshTokens.push('attempt')
        return new Response('{"error":"invalid_grant"}', { status: 400 })
      }
      return realFetch(url as string, init)
    }) as typeof globalThis.fetch
    const fetchOverride = await loadFetch(() => expiredLogin)

    await fetchOverride('https://api.openai.com/v1/responses', request())
    const backoff = (await loadAccounts(getAccountPaths(configFile)))?.refresh
      ?.mainLastRefreshError
    expect(backoff).toBeDefined()
    expect(backoff?.tokenHash).toBe(hashRefreshToken(expiredLogin.refresh))

    // The second request is inside the backoff: no new refresh is sent.
    await fetchOverride('https://api.openai.com/v1/responses', request())
    expect(wire.refreshTokens).toEqual(['attempt'])
  })

  it('a live lease another process holds on the slot token makes this one stand down', async () => {
    seedPool({ configFile, stateFile }, [{ id: 'fb1' }], {
      refresh: {
        refreshBeforeExpiryMinutes: 5,
        mainRefreshLeaseId: 'other-process',
        mainRefreshLeaseUntil: Date.now() + HOUR,
        mainRefreshLeaseTokenHash: hashRefreshToken(expiredLogin.refresh),
      },
    })
    const wire = installWire()
    const fetchOverride = await loadFetch(() => expiredLogin)

    const started = performance.now()
    await fetchOverride('https://api.openai.com/v1/responses', request())

    expect(wire.refreshTokens).toEqual([])
    // It saw the lease before taking the lock and waited for the other
    // process's result (4s) before falling back to the stale token, rather
    // than taking the lock and failing on a lease it could not read.
    expect(performance.now() - started).toBeGreaterThanOrEqual(3_900)
    expect(wire.sends).toEqual(['Bearer later-login-access'])
  })
})
