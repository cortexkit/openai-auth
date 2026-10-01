// A migrated install on disk, a fake network, and the plugin loaded over
// them, for tests of the surfaces a migrated install serves from the account
// pool. The layout matches the one pool-request.test.ts writes.

import { readFileSync, writeFileSync } from 'node:fs'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../../index.ts'

export const HOUR = 3600_000

export const PLACEHOLDER = {
  type: 'oauth' as const,
  access: '',
  refresh: 'common-auth-placeholder:v1:openai',
  expires: 0,
}

export type PoolMode = 'main-first' | 'fallback-first' | 'sticky-balanced'

export interface PoolFiles {
  configFile: string
  stateFile: string
}

/** A pool quota map with one primary reading. */
export function quotaMap(usedPercent: number, checkedAt = Date.now()) {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent,
        resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
  }
}

export interface PoolRowSeed {
  id: string
  quota?: ReturnType<typeof quotaMap>
  expires?: number
  enabled?: boolean
}

/** Writes a migrated install: roster, pool entries, credentials in the state file. */
export function seedPool(
  files: PoolFiles,
  rows: PoolRowSeed[],
  settings: Record<string, unknown> = {},
) {
  writeFileSync(
    files.configFile,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode: 'main-first' },
      refresh: { refreshBeforeExpiryMinutes: 5 },
      ...settings,
      accounts: rows.map((row) => ({
        id: row.id,
        type: 'oauth',
        label: row.id,
        enabled: row.enabled ?? true,
        accountId: `chatgpt-${row.id}`,
        addedAt: 1,
      })),
      commonAuthPool: {
        schemaVersion: 1,
        rows: Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              credentialEpoch: 1,
              needsFirstReading: row.quota === undefined,
              ...(row.quota ? { quota: row.quota } : {}),
            },
          ]),
        ),
      },
      openaiAuthPool: { migratedAt: Date.now() - 60_000 },
    }),
  )
  writeFileSync(
    files.stateFile,
    JSON.stringify({
      version: 1,
      accounts: Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            access: `${row.id}-token`,
            refresh: `${row.id}-refresh`,
            expires: row.expires ?? Date.now() + 24 * HOUR,
          },
        ]),
      ),
    }),
  )
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export interface Wire {
  /** Bearer of every model request, in order. */
  sends: string[]
  /** Bearer of every quota poll, in order. */
  polls: string[]
  /** Refresh token of every token refresh, in order. */
  refreshTokens: string[]
}

export function usageBody(usedPercent: number) {
  return JSON.stringify({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18_000,
        reset_at: Math.floor((Date.now() + 2 * HOUR) / 1000),
      },
    },
  })
}

/** Replaces the network: token refreshes, quota polls and model requests. */
export function installWire(
  options: { usage?: (bearer: string) => Response } = {},
): Wire {
  const wire: Wire = { sends: [], polls: [], refreshTokens: [] }
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    const bearer = new Headers(init?.headers).get('authorization') ?? ''
    if (target.includes('/oauth/token')) {
      const refreshToken =
        new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? ''
      wire.refreshTokens.push(refreshToken)
      return new Response(
        JSON.stringify({
          access_token: `refreshed-${refreshToken}`,
          refresh_token: `rotated-${refreshToken}`,
          expires_in: 3600,
          id_token: 'id',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (target.includes('/wham/usage')) {
      wire.polls.push(bearer)
      return options.usage
        ? options.usage(bearer)
        : new Response(usageBody(10), { status: 200 })
    }
    if (target.includes('/responses')) {
      wire.sends.push(bearer)
      return new Response('{}', { status: 200 })
    }
    return new Response('unavailable', { status: 503 })
  }) as unknown as typeof globalThis.fetch
  return wire
}

export function mockPluginInput(
  onPrompt: (text: string) => void = () => {},
): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: {
        promptAsync: async (request: {
          body?: { parts?: Array<{ text?: string }> }
        }) => {
          onPrompt(request.body?.parts?.[0]?.text ?? '')
        },
      },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

/** Runs the plugin's auth loader with `slot` in OpenCode's login slot. */
export async function loadPlugin(
  options: Parameters<typeof CodexAuthPlugin>[1] = {},
  slot: Record<string, unknown> = { ...PLACEHOLDER },
  onPrompt?: (text: string) => void,
): Promise<Hooks> {
  const hooks = await CodexAuthPlugin(mockPluginInput(onPrompt), {
    experimentalWebSockets: false,
    ...options,
  })
  const authHook = hooks.auth
  if (!authHook?.loader) throw new Error('No auth loader')
  await authHook.loader(
    (async () => ({ ...slot })) as never,
    { id: 'openai', label: 'OpenAI', models: [] } as unknown as Parameters<
      NonNullable<(typeof authHook)['loader']>
    >[1],
  )
  return hooks
}

export async function waitFor<T>(
  read: () => T | undefined,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))
