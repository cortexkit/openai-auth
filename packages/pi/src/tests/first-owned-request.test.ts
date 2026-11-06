import { expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import * as limits from '@cortexkit/common-auth/limits'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  OpenAiVault,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import {
  type Api,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import {
  chatgptAccessToken,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { VAULT_PLACEHOLDER_KEY } from '../vault-slot.ts'

const MODEL: Model<Api> = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
}

function sentinel(): Response {
  return new Response(
    [
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","status":"in_progress","content":[]}}',
      'data: {"type":"response.output_text.delta","item_id":"m1","delta":"FIRST_OWNED_SENTINEL"}',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"FIRST_OWNED_SENTINEL"}]}}',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

for (const mode of ['local', 'vault'] as const) {
  const name = `fresh-process Pi ${mode} first owned request and projection change acquire no registry`
  test(name, async () => {
    if (process.env.PI_FIRST_OWNED_CHILD !== mode) {
      const home = mkdtempSync(join(tmpdir(), 'pi-first-owned-'))
      mkdirSync(join(home, 'daemon'))
      // Pi restarts while the daemon stays live; its transport belongs to the
      // parent, separate from the roster persisted by each Pi child.
      const daemon =
        mode === 'vault'
          ? await startMockDaemon({
              directory: join(home, 'daemon'),
              credentials: { 'oauth:openai:first': vaultLogin('first') },
            })
          : undefined
      try {
        for (let restart = 0; restart < 2; restart++) {
          const child = spawn(
            process.execPath,
            ['test', './src/tests/first-owned-request.test.ts', '-t', name],
            {
              cwd: join(import.meta.dir, '../..'),
              env: {
                ...process.env,
                HOME: home,
                PI_CODING_AGENT_DIR: join(home, 'agent'),
                PI_FIRST_OWNED_CHILD: mode,
                PI_FIRST_OWNED_DIR: join(home, 'request'),
                PI_FIRST_OWNED_CONNECTION: daemon?.connectionFile,
              },
            },
          )
          let stdout = ''
          let stderr = ''
          child.stderr.setEncoding('utf8')
          child.stderr.on('data', (data) => {
            stderr += data
          })
          const exited = new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('close', resolve)
          })
          try {
            for await (const line of createInterface({ input: child.stdout })) {
              stdout += `${line}\n`
              if (!line.startsWith('VAULT_CONTROL ')) continue
              if (!daemon) throw new Error('vault control without a daemon')
              const action = line.slice('VAULT_CONTROL '.length)
              if (action === 'second') {
                delete daemon.credentials['oauth:openai:first']
                daemon.credentials['oauth:openai:second'] = vaultLogin('second')
              } else if (action === 'empty')
                delete daemon.credentials['oauth:openai:second']
              else if (action === 'restore')
                daemon.credentials['oauth:openai:first'] = vaultLogin('first')
              else throw new Error(`unknown vault control ${action}`)
              child.stdin.write('ok\n')
            }
            if ((await exited) !== 0)
              throw new Error(`restart=${restart}\n${stdout}\n${stderr}`)
          } finally {
            if (child.exitCode === null) child.kill()
          }
          expect(stdout).toContain('FIRST_OWNED_OK sends=2 acquire=0 reload=0')
        }
      } finally {
        await daemon?.stop()
        rmSync(home, { recursive: true, force: true })
      }
      return
    }
    const dir = process.env.PI_FIRST_OWNED_DIR!
    mkdirSync(dir, { recursive: true })
    const paths = {
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'state.json'),
    }
    const now = Date.now()
    const sent: Array<{ token: string | null; identity: string | null }> = []
    let releasePoll!: () => void
    let enterPoll!: () => void
    const pollEntered = new Promise<void>((resolve) => {
      enterPoll = resolve
    })
    const pollReady = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/codex/responses')) {
        const headers = new Headers(init?.headers)
        sent.push({
          token: headers.get('authorization'),
          identity: headers.get('chatgpt-account-id'),
        })
        return sentinel()
      }
      if (url.endsWith('/wham/usage')) {
        // Quota is deliberately pending when routing joins it. Release in the
        // same event loop turn, not through a warm-up request or a timed sleep.
        enterPoll()
        await pollReady
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18_000,
              reset_at: Math.floor(now / 1000) + 3600,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604_800,
              reset_at: Math.floor(now / 1000) + 7200,
            },
          },
        })
      }
      throw new Error(`unexpected provider URL ${url}`)
    }) as typeof fetch
    let acquires = 0
    let reloads = 0
    const acquire = spyOn(limits, 'acquireLimitsRegistry').mockImplementation(
      (() => {
        acquires++
        return Promise.resolve({
          ready: Promise.resolve(),
          reload() {
            reloads++
            return Promise.resolve()
          },
        })
      }) as never,
    )
    const { PiOpenAIRuntime } = await import('../runtime.ts')
    const replies =
      mode === 'vault' ? createInterface({ input: process.stdin }) : undefined
    const incoming = replies?.[Symbol.asyncIterator]()
    const control = async (action: 'second' | 'empty' | 'restore') => {
      console.log(`VAULT_CONTROL ${action}`)
      const reply = await incoming?.next()
      if (reply?.value !== 'ok')
        throw new Error('parent did not acknowledge vault change')
    }
    const vault = new OpenAiVault({
      host: 'pi',
      stateDir: vaultStateDir(paths.statePath),
      fetchImpl: () => fetchImpl,
      now: () => now,
      pollIntervalMs: 0,
      ...(mode === 'vault'
        ? { connectionFile: () => process.env.PI_FIRST_OWNED_CONNECTION! }
        : {}),
    })
    const pool = openPoolStore({
      provider: 'openai',
      ...paths,
      quota: quotaCodec,
    })
    const runtime = new PiOpenAIRuntime({
      streamSimple,
      createStream: createAssistantMessageEventStream,
      paths: () => paths,
      fetchImpl,
      now: () => now,
      vault,
    })
    // Exercise Pi's registered shutdown ordering before reusing its roster.
    const extension = await import('../index.ts')
    const factory = spyOn(extension, 'createPiOpenAIRuntime').mockReturnValue(
      runtime,
    )
    const syncSlot = spyOn(runtime, 'syncVaultSlot').mockResolvedValue()
    const dispose = spyOn(runtime.pool, 'dispose')
    let shutdown: (() => Promise<void>) | undefined
    try {
      await extension.default({
        registerCommand() {},
        registerProvider() {},
        on(name: string, handler: () => Promise<void>) {
          if (name === 'session_shutdown') shutdown = handler
        },
      } as never)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(shutdown).toBeDefined()
    } finally {
      factory.mockRestore()
    }
    const send = async (success = true) => {
      const events: AssistantMessageEvent[] = []
      const stream = runtime.stream(
        MODEL,
        {
          messages: [{ role: 'user', content: 'first request', timestamp: 0 }],
        },
        {
          apiKey: mode === 'vault' ? VAULT_PLACEHOLDER_KEY : undefined,
          transport: 'sse',
          fetch: fetchImpl,
        },
      )
      for await (const event of stream) events.push(event)
      if (!success) {
        expect(events[0]?.type).toBe('error')
        return
      }
      expect(
        events.some(
          (event) =>
            event.type === 'text_delta' &&
            event.delta === 'FIRST_OWNED_SENTINEL',
        ),
      ).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
    }
    try {
      if (mode === 'vault') {
        const stateDir = vaultStateDir(paths.statePath)
        mkdirSync(stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(
          vaultPaths(stateDir, 'pi').tokenPath,
          JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
          { mode: 0o600 },
        )
      } else
        await pool.add({
          id: 'first',
          identity: 'first',
          credential: {
            type: 'oauth',
            access: chatgptAccessToken('first'),
            refresh: 'refresh-first',
            expires: now + 3_600_000,
          },
        })
      const first = send()
      await Promise.race([pollEntered, first])
      releasePoll()
      await first
      expect(sent).toEqual([
        { token: `Bearer ${chatgptAccessToken('first')}`, identity: 'first' },
      ])
      expect(acquires).toBe(0)
      expect(reloads).toBe(0)
      if (mode === 'vault') {
        await control('second')
        await vault.refresh()
      } else {
        await pool.remove('first')
        await pool.add({
          id: 'second',
          identity: 'second',
          credential: {
            type: 'oauth',
            access: chatgptAccessToken('second'),
            refresh: 'refresh-second',
            expires: now + 3_600_000,
          },
        })
      }
      await send()
      expect(sent[1]).toEqual({
        token: `Bearer ${chatgptAccessToken('second')}`,
        identity: 'second',
      })
      expect(acquires).toBe(0)
      expect(reloads).toBe(0)
      if (mode === 'vault') {
        await control('empty')
        await vault.refresh()
      } else await pool.remove('second')
      await send(false)
      expect(sent).toHaveLength(2)
      expect(acquires).toBe(0)
      expect(reloads).toBe(0)
      console.log('FIRST_OWNED_OK sends=2 acquire=0 reload=0')
      // Leave a valid persisted roster for the next fresh process, rather than
      // making its startup depend on recovery from the empty-roster refusal.
      if (mode === 'vault') {
        await control('restore')
        await vault.refresh()
      }
    } finally {
      releasePoll()
      try {
        await shutdown?.()
        expect(dispose).toHaveBeenCalledTimes(1)
      } finally {
        acquire.mockRestore()
        syncSlot.mockRestore()
        vault.close()
        dispose.mockRestore()
        replies?.close()
        if (replies) process.stdin.destroy()
      }
    }
  })
}
