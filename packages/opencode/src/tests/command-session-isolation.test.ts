import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
// Snapshot the REAL oauth module before mock.module runs; bun's mock.module
// leaks process-wide and mock.restore() does not undo it, so afterAll re-installs
// this plain-object snapshot to protect later test files.
import * as oauthLiveNamespace from '../core/oauth'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'

const oauthRealExports = { ...oauthLiveNamespace }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function makePluginInput(directory: string): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory,
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

// ---------------------------------------------------------------------------
// Concurrency: the command hook must not share mutable session state across
// sessions. The add-flow snapshots ctx.sessionId/notify only AFTER an
// `await beginAccountLogin()`, so a second session's modal command landing in
// that window would, with a shared context, re-route the first session's OAuth
// feedback to the wrong TUI. The hook now builds a per-invocation context.
// ---------------------------------------------------------------------------

describe('command hook session isolation', () => {
  let tmpDir: string
  let configFile: string
  let originalFetch: typeof globalThis.fetch
  const originalConfigEnv = process.env.OPENCODE_OPENAI_AUTH_FILE
  const originalStateEnv = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE

  beforeEach(async () => {
    resetNotificationsForTest()
    tmpDir = await mkdtemp(join(tmpdir(), 'oa-session-iso-'))
    configFile = join(tmpDir, 'openai-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(tmpDir, 'state.json')
    // Seed an empty store so loadAccounts/saveAccounts in the add-flow succeed
    // and no mainAccountId is set (the added account is a normal fallback).
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      }),
    )
    originalFetch = globalThis.fetch
    // Loader may seed quota in the background; keep it off the network.
    globalThis.fetch = (async () =>
      new Response('{}')) as unknown as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    mock.restore()
    if (originalConfigEnv === undefined)
      delete process.env.OPENCODE_OPENAI_AUTH_FILE
    else process.env.OPENCODE_OPENAI_AUTH_FILE = originalConfigEnv
    if (originalStateEnv === undefined)
      delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    else process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = originalStateEnv
    try {
      await rm(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  afterAll(() => {
    mock.module('../core/oauth', () => oauthRealExports)
  })

  test('a second session interleaving inside the add await-window does not steal the add notification', async () => {
    // beginAccountLogin stays pending until we release it, holding session A
    // inside the add-flow's await-window; its completion is also gated so we
    // control exactly when the success notification fires.
    const beginGate = deferred<{
      url: string
      instructions: string
      completion: Promise<unknown>
    }>()
    const completionGate = deferred<unknown>()

    mock.module('../core/oauth', () => ({
      ...oauthRealExports,
      beginAccountLogin: mock(() => beginGate.promise),
    }))

    const { CodexAuthPlugin } = await import('../index')
    const plugin = await CodexAuthPlugin(makePluginInput(''), {
      experimentalWebSockets: false,
    })

    const loaderResult = await plugin.auth?.loader?.(
      async () => ({
        type: 'oauth',
        provider: 'openai',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 3600_000,
      }),
      { id: 'openai', label: 'OpenAI', models: [] } as never,
    )

    const hook = (
      plugin as unknown as {
        'command.execute.before'?: (input: {
          command: string
          arguments: string
          sessionID: string
        }) => Promise<void>
      }
    )['command.execute.before']
    if (!hook) throw new Error('command.execute.before hook missing')

    // Session A: /openai-account add — suspends on the gated beginAccountLogin.
    const aDone = hook({
      command: 'openai-account',
      arguments: 'add',
      sessionID: 'sess-A',
    }).catch(() => {})
    await tick()

    // Session B: /openai-quota lands while A is suspended. With a shared context
    // this would rebind sessionId/notify to 'sess-B'.
    await hook({
      command: 'openai-quota',
      arguments: '',
      sessionID: 'sess-B',
    }).catch(() => {})

    // Release A's login with a completion we control, then finish A's hook.
    beginGate.resolve({
      url: 'https://auth.openai.com/oauth/authorize?mock=1',
      instructions: 'Open the URL',
      completion: completionGate.promise,
    })
    await aDone

    // The OAuth flow resolves: the detached .then() fires notify(), which must
    // route to the session that issued the add (A), not the interleaver (B).
    const now = Date.now()
    completionGate.resolve({
      id: 'fallback-A',
      label: undefined,
      type: 'oauth',
      provider: 'openai',
      access: 'fb-access',
      refresh: 'fb-refresh',
      expires: now + 3600_000,
      accountId: 'chatgpt-new-acct',
      enabled: true,
      addedAt: now,
      lastUsed: now,
      lastRefreshedAt: now,
    })
    // The detached completion does lock-based RMW file I/O before it notifies,
    // so poll for the notification rather than guessing a fixed number of ticks.
    let added: ReturnType<typeof drainNotifications>[number] | undefined
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      added = drainNotifications(0).find((n) =>
        n.payload.text.includes('Account Added'),
      )
      if (added) break
      await tick()
    }
    expect(added).toBeDefined()
    expect(added?.sessionId).toBe('sess-A')

    await loaderResult?.dispose?.()
  })
})
