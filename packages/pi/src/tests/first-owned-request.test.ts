import { expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import * as fileLocks from '@cortexkit/common-auth/fs'
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

function firstOwnedClock(mode: string) {
  const child = process.env.PI_FIRST_OWNED_CHILD === mode
  const startedAt = child
    ? Number(process.env.PI_FIRST_OWNED_STARTED_AT)
    : Date.now()
  const prefix = 'FIRST_OWNED_PHASE '
  const history: string[] = []
  let reporting = false
  const record = (line: string) => {
    history.push(line)
    // An opt-in journal retains comparison timings without printing passing runs.
    if (process.env.PI_FIRST_OWNED_PHASE_LOG)
      appendFileSync(process.env.PI_FIRST_OWNED_PHASE_LOG, `${mode}: ${line}\n`)
    if (reporting) console.error(`[Pi first-owned ${mode}] ${line}`)
  }
  // A passing fixture stays quiet; a near-timeout fixture reports its pending
  // phase before Bun can interrupt the parent while a child is still running.
  const timer = child
    ? undefined
    : setTimeout(() => {
        reporting = true
        console.error(
          `[Pi first-owned ${mode} past 4000ms]\n${history.join('\n')}`,
        )
      }, 4000)
  timer?.unref()
  return {
    startedAt,
    phase(name: string) {
      const owner = child
        ? `child ${process.env.PI_FIRST_OWNED_RESTART} pid=${process.pid}`
        : 'parent'
      const line = `+${Date.now() - startedAt}ms ${owner}: ${name}`
      if (child) console.log(`${prefix}${line}`)
      else record(line)
    },
    receive(line: string) {
      if (!line.startsWith(prefix)) return false
      record(line.slice(prefix.length))
      return true
    },
    close() {
      clearTimeout(timer)
    },
  }
}

async function traceFirstOwnedLocks(clock: ReturnType<typeof firstOwnedClock>) {
  if (!process.env.PI_FIRST_OWNED_TRACE_LOCKS) return
  const locks = (await import(
    new URL(
      'refresh-file-lock.js',
      import.meta.resolve('@cortexkit/common-auth/fs'),
    ).href
  )) as Pick<typeof fileLocks, 'acquireRefreshFileLock'>
  const acquire = locks.acquireRefreshFileLock
  const held = new Map<string, { name: string; write: string }>()
  const pending = new Set<string>()
  const contended = new Set<string>()
  const spy = spyOn(locks, 'acquireRefreshFileLock').mockImplementation(
    async (options) => {
      if (
        !['claustrum-roster', 'claustrum-roster-write'].includes(options.name)
      )
        return acquire(options)
      const stack = new Error().stack ?? ''
      const write = stack.includes('quota-writer') ? 'quota flush' : 'discovery'
      const key = `${options.name} ${write}`
      if (!pending.has(key)) {
        pending.add(key)
        clock.phase(`lease acquire begin ${key}`)
      }
      const lock = await acquire({
        ...options,
        onContended() {
          try {
            const holder = JSON.parse(
              readFileSync(
                fileLocks.lockPathFor(options.path, options.name),
                'utf8',
              ),
            ) as { ownerId?: string }
            const contention = `${key} owner=${holder.ownerId}`
            if (!contended.has(contention)) {
              contended.add(contention)
              clock.phase(`lease contended ${contention}`)
            }
          } catch {
            // A lease can disappear between the contention callback and its read.
          }
          options.onContended?.()
        },
      })
      if (lock) {
        pending.delete(key)
        const owner = lock.ownerId
        held.set(owner, { name: options.name, write })
        clock.phase(`lease acquired ${key} owner=${owner}`)
        const release = lock.release.bind(lock)
        lock.release = async () => {
          clock.phase(`lease release begin ${key} owner=${owner}`)
          try {
            await release()
            held.delete(owner)
            clock.phase(`lease release complete ${key} owner=${owner}`)
          } catch (error) {
            clock.phase(
              `lease release failed ${key} owner=${owner}: ${String(error)}`,
            )
            throw error
          }
        }
      }
      return lock
    },
  )
  // Keep the observer through process exit: synchronous close can start a
  // write after the test callback has returned, but cannot join its release.
  process.once('exit', () => {
    clock.phase(
      `process exit held=${JSON.stringify([...held])} pending=${JSON.stringify([...pending])}`,
    )
    spy.mockRestore()
  })
}

for (const mode of ['local', 'vault'] as const) {
  const name = `fresh-process Pi ${mode} first owned request and projection change acquire no registry`
  test(name, async () => {
    const clock = firstOwnedClock(mode)
    clock.phase('test callback entered (static imports complete)')
    if (process.env.PI_FIRST_OWNED_CHILD !== mode) {
      const home = mkdtempSync(join(tmpdir(), 'pi-first-owned-'))
      mkdirSync(join(home, 'daemon'))
      // Pi restarts while the daemon stays live; its transport belongs to the
      // parent, separate from the roster persisted by each Pi child.
      let daemon: Awaited<ReturnType<typeof startMockDaemon>> | undefined
      try {
        clock.phase('daemon start begin')
        daemon =
          mode === 'vault'
            ? await startMockDaemon({
                directory: join(home, 'daemon'),
                credentials: { 'oauth:openai:first': vaultLogin('first') },
              })
            : undefined
        clock.phase('daemon ready')
        for (let restart = 0; restart < 2; restart++) {
          clock.phase(`restart ${restart} spawn begin`)
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
                PI_FIRST_OWNED_STARTED_AT: String(clock.startedAt),
                PI_FIRST_OWNED_RESTART: String(restart),
              },
            },
          )
          child.once('spawn', () =>
            clock.phase(`restart ${restart} spawned pid=${child.pid}`),
          )
          child.once('exit', (code, signal) =>
            clock.phase(
              `restart ${restart} exit code=${code} signal=${signal}`,
            ),
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
              if (clock.receive(line)) continue
              if (!line.startsWith('VAULT_CONTROL ')) continue
              if (!daemon) throw new Error('vault control without a daemon')
              const action = line.slice('VAULT_CONTROL '.length)
              clock.phase(`restart ${restart} vault control ${action}`)
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
            clock.phase(`restart ${restart} close complete`)
            if (mode === 'vault' && process.env.PI_FIRST_OWNED_TRACE_LOCKS) {
              const roster = vaultPaths(
                vaultStateDir(join(home, 'request', 'state.json')),
                'pi',
              ).rosterPath
              try {
                clock.phase(
                  `restart ${restart} persisted claustrum-roster-write lease ${JSON.stringify(readFileSync(fileLocks.lockPathFor(roster, 'claustrum-roster-write'), 'utf8'))}`,
                )
              } catch {
                clock.phase(
                  `restart ${restart} no persisted claustrum-roster-write lease`,
                )
              }
            }
          } finally {
            if (child.exitCode === null) child.kill()
          }
          expect(stdout).toContain('FIRST_OWNED_OK sends=2 acquire=0 reload=0')
        }
      } finally {
        clock.phase('daemon stop begin')
        try {
          await daemon?.stop()
          clock.phase('daemon stop complete')
          rmSync(home, { recursive: true, force: true })
        } finally {
          clock.close()
        }
      }
      return
    }
    const dir = process.env.PI_FIRST_OWNED_DIR!
    mkdirSync(dir, { recursive: true })
    const paths = {
      configPath: join(dir, 'pool.json'),
      statePath: join(dir, 'state.json'),
    }
    await traceFirstOwnedLocks(clock)
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
        clock.phase(`provider response ${sent.length + 1}`)
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
        clock.phase('quota poll waiting for release')
        await pollReady
        clock.phase('quota poll released')
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
    clock.phase('runtime import begin')
    const { PiOpenAIRuntime } = await import('../runtime.ts')
    clock.phase('runtime import complete')
    const replies =
      mode === 'vault' ? createInterface({ input: process.stdin }) : undefined
    const incoming = replies?.[Symbol.asyncIterator]()
    const control = async (action: 'second' | 'empty' | 'restore') => {
      clock.phase(`vault control ${action} begin`)
      console.log(`VAULT_CONTROL ${action}`)
      const reply = await incoming?.next()
      if (reply?.value !== 'ok')
        throw new Error('parent did not acknowledge vault change')
      clock.phase(`vault control ${action} acknowledged`)
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
    clock.phase('extension import begin')
    const extension = await import('../index.ts')
    clock.phase('extension import complete')
    const factory = spyOn(extension, 'createPiOpenAIRuntime').mockReturnValue(
      runtime,
    )
    const syncSlot = spyOn(runtime, 'syncVaultSlot').mockResolvedValue()
    const dispose = spyOn(runtime.pool, 'dispose')
    let shutdown: (() => Promise<void>) | undefined
    try {
      clock.phase('extension registration begin')
      await extension.default({
        registerCommand() {},
        registerProvider() {},
        on(name: string, handler: () => Promise<void>) {
          if (name === 'session_shutdown') shutdown = handler
        },
      } as never)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(shutdown).toBeDefined()
      clock.phase('extension registration complete')
    } finally {
      factory.mockRestore()
    }
    let requests = 0
    const send = async (success = true) => {
      const request = ++requests
      clock.phase(`owned request ${request} begin`)
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
      for await (const event of stream) {
        if (!events.length)
          clock.phase(`owned request ${request} first event ${event.type}`)
        events.push(event)
        if (event.type === 'error')
          clock.phase(
            `owned request ${request} refusal ${event.error.errorMessage}`,
          )
      }
      clock.phase(`owned request ${request} complete`)
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
      clock.phase('credential setup begin')
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
      clock.phase('credential setup complete')
      const first = send()
      await Promise.race([pollEntered, first])
      clock.phase('first request poll joined or request settled')
      releasePoll()
      await first
      expect(sent).toEqual([
        { token: `Bearer ${chatgptAccessToken('first')}`, identity: 'first' },
      ])
      expect(acquires).toBe(0)
      expect(reloads).toBe(0)
      clock.phase('first request registry check complete')
      if (mode === 'vault') {
        await control('second')
        clock.phase('projection refresh begin')
        const refresh = vault.refresh()
        const probe = process.env.PI_FIRST_OWNED_TRACE_LOCKS
          ? setTimeout(() => {
              clock.phase('pending projection request probe begin')
              void send(false).catch((error) =>
                clock.phase(`projection probe failed: ${String(error)}`),
              )
            }, 1000)
          : undefined
        try {
          await refresh
        } finally {
          clearTimeout(probe)
        }
        clock.phase('projection refresh complete')
      } else {
        clock.phase('projection mutation begin')
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
        clock.phase('projection mutation complete')
      }
      await send()
      expect(sent[1]).toEqual({
        token: `Bearer ${chatgptAccessToken('second')}`,
        identity: 'second',
      })
      expect(acquires).toBe(0)
      expect(reloads).toBe(0)
      clock.phase('projection registry check complete')
      if (mode === 'vault') {
        await control('empty')
        clock.phase('empty refresh begin')
        await vault.refresh()
        clock.phase('empty refresh complete')
      } else await pool.remove('second')
      await send(false)
      expect(sent).toHaveLength(2)
      expect(acquires).toBe(0)
      expect(reloads).toBe(0)
      clock.phase('empty registry check complete')
      console.log('FIRST_OWNED_OK sends=2 acquire=0 reload=0')
      // Leave a valid persisted roster for the next fresh process, rather than
      // making its startup depend on recovery from the empty-roster refusal.
      if (mode === 'vault') {
        await control('restore')
        clock.phase('restart roster restore begin')
        await vault.refresh()
        clock.phase('restart roster restore complete')
      }
    } finally {
      releasePoll()
      try {
        clock.phase('session_shutdown begin')
        await shutdown?.()
        clock.phase('session_shutdown complete')
        expect(dispose).toHaveBeenCalledTimes(1)
      } finally {
        acquire.mockRestore()
        syncSlot.mockRestore()
        clock.phase('vault close begin')
        vault.close()
        clock.phase('vault close complete')
        dispose.mockRestore()
        replies?.close()
        if (replies) process.stdin.destroy()
        clock.phase('child cleanup complete')
        clock.close()
      }
    }
  })
}
