// How `OpenAiVault` learns that the vault's accounts or insula's usage
// changed. With common-auth 0.21.0 the consumer holds a claustrum
// `auth.watch_scoped` and an insula `usage.watch` open, so an idle host stops
// listing the vault every poll and stops reading insula every minute; without
// a watch it polls exactly as before. A watch that loses its connection also
// starts the vault outage at once, so the next send is served the kept token
// without waiting on the vault.
//
// Everything runs against the mock daemon over a real socket. Time is
// simulated: the vault's clock and timers are replaced, so a minute of
// five-second polls runs in milliseconds and nothing fires on its own.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAiVault } from '../vault'
import {
  chatgptAccessToken,
  type MockDaemon,
  type MockWatchMode,
  startMockDaemon,
  vaultLogin,
} from './fixtures/mock-claustrum'

const POLL_MS = 5_000

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A clock and timer queue the test advances by hand. */
class SimulatedTime {
  now = Date.now()
  #next = 1
  readonly #timers = new Map<
    number,
    { at: number; delay: number; run: () => void }
  >()

  readonly setTimeout = ((run: () => void, delay = 0) => {
    const id = this.#next++
    this.#timers.set(id, { at: this.now + delay, delay, run })
    return { id, unref() {}, ref() {} }
  }) as unknown as typeof setTimeout

  readonly clearTimeout = ((timer: { id?: number } | undefined) => {
    if (timer?.id !== undefined) this.#timers.delete(timer.id)
  }) as unknown as typeof clearTimeout

  /** Whether a timer of exactly `delay` is waiting (the poll's is POLL_MS). */
  has(delay: number): boolean {
    for (const timer of this.#timers.values())
      if (timer.delay === delay) return true
    return false
  }

  /** Moves the clock forward and runs every timer that is then due. */
  advance(ms: number): void {
    this.now += ms
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.at <= this.now)
      .sort(([, a], [, b]) => a.at - b.at)
    for (const [id, timer] of due) {
      this.#timers.delete(id)
      timer.run()
    }
  }
}

async function waitFor(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function setup(
  options: {
    watch?: MockWatchMode
    usageWatch?: MockWatchMode
    insula?: boolean
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'openai-watch-'))
  const daemon: MockDaemon = await startMockDaemon({
    directory: dir,
    credentials: {
      a: vaultLogin('account-a'),
      b: vaultLogin('account-b'),
    },
  })
  daemon.watch = options.watch ?? 'accept'
  daemon.usageWatch = options.usageWatch ?? 'unsupported'
  const time = new SimulatedTime()
  if (options.insula)
    daemon.insula = {
      reply: {
        result: [
          {
            provider: 'codex',
            account: 'account-a',
            fetchedAt: new Date(time.now).toISOString(),
            source: 'vault',
            usage: { primary: { usedPercent: 10, windowMinutes: 300 } },
          },
        ],
      },
    }
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'vault'),
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: POLL_MS,
    now: () => time.now,
    setTimeoutImpl: time.setTimeout,
    clearTimeoutImpl: time.clearTimeout,
  })
  cleanups.push(async () => {
    vault.close()
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'vault'), { mode: 0o700 })
  await writeFile(
    vault.paths.tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  vault.start()
  // The first poll lists the vault, then opens the watches; the next poll's
  // timer is set once it has finished.
  await waitFor('the first poll', () => time.has(POLL_MS))
  return {
    vault,
    daemon,
    time,
    /** Runs one background poll and waits until it has finished. */
    async poll() {
      if (!time.has(POLL_MS)) throw new Error('no poll is scheduled')
      time.advance(POLL_MS)
      await waitFor('the poll to finish', () => time.has(POLL_MS))
    },
  }
}

describe('vault watch', () => {
  test('an idle vault with an open watch lists the vault only when a notice shows a change', async () => {
    const env = await setup()
    await waitFor('the vault watch', () => env.daemon.openWatches.vault === 1)
    await waitFor(
      'the watch to be accepted',
      () => env.vault.watchState().vault === 'watching',
    )
    expect(env.daemon.lists).toBe(1)

    // A simulated minute of polls with no change: no list at all.
    for (let poll = 0; poll < 12; poll++) await env.poll()
    expect(env.daemon.lists).toBe(1)
    expect(env.daemon.watches).toBe(1)

    // A change the vault announces: exactly one discovery, which finds it.
    env.daemon.credentials.c = vaultLogin('account-c')
    env.daemon.notifyVault()
    await waitFor('the new account', () => env.vault.routes().length === 3)
    expect(env.daemon.lists).toBe(2)

    // A notice whose view is the one already discovered lists nothing.
    env.daemon.notifyVault()
    for (let poll = 0; poll < 12; poll++) await env.poll()
    expect(env.daemon.lists).toBe(2)
  })

  test('with an open watch the vault is still listed once every five minutes', async () => {
    const env = await setup()
    await waitFor('the vault watch', () => env.daemon.openWatches.vault === 1)
    await waitFor(
      'the watch to be accepted',
      () => env.vault.watchState().vault === 'watching',
    )
    expect(env.daemon.lists).toBe(1)
    for (let poll = 0; poll < 59; poll++) await env.poll()
    expect(env.daemon.lists).toBe(1)
    await env.poll()
    expect(env.daemon.lists).toBe(2)
  })

  for (const mode of ['unsupported', 'not_accepting'] as const) {
    test(`a vault that answers the watch ${mode} is listed on every poll, as before watches`, async () => {
      const env = await setup({ watch: mode })
      await waitFor('the watch request', () => env.daemon.watches === 1)
      await waitFor(
        'the watch to fall back',
        () => env.vault.watchState().vault === 'fallback',
      )
      const lists = env.daemon.lists
      for (let poll = 0; poll < 12; poll++) await env.poll()
      expect(env.daemon.lists).toBe(lists + 12)
      expect(env.daemon.watches).toBe(1)
    })
  }
})

describe('insula usage watch', () => {
  test('an idle vault with an open usage watch reads insula only when insula announces a change', async () => {
    const env = await setup({ insula: true, usageWatch: 'accept' })
    await waitFor('the usage watch', () => env.daemon.openWatches.usage === 1)
    await waitFor(
      'the usage watch to be accepted',
      () => env.vault.watchState().insula === 'watching',
    )
    // The first poll's read, and the one the watch's first notice makes.
    await waitFor('both reads', () => env.daemon.insulaReads === 2)
    const reads = env.daemon.insulaReads

    // Two simulated minutes with no change: no read at all.
    for (let poll = 0; poll < 24; poll++) await env.poll()
    expect(env.daemon.insulaReads).toBe(reads)

    env.daemon.notifyUsage('codex')
    await waitFor('the read', () => env.daemon.insulaReads === reads + 1)
    // A notice for another provider needs no read.
    env.daemon.notifyUsage('claude')
    for (let poll = 0; poll < 2; poll++) await env.poll()
    expect(env.daemon.insulaReads).toBe(reads + 1)
    expect(env.daemon.usageWatches).toBe(1)
  })

  test('an insula without usage.watch is read once a minute, as before watches', async () => {
    const env = await setup({ insula: true, usageWatch: 'unsupported' })
    await waitFor(
      'the usage watch request',
      () => env.daemon.usageWatches === 1,
    )
    await waitFor(
      'the usage watch to fall back',
      () => env.vault.watchState().insula === 'fallback',
    )
    const reads = env.daemon.insulaReads
    for (let poll = 0; poll < 24; poll++) await env.poll()
    expect(env.daemon.insulaReads).toBe(reads + 2)
  })
})

describe('vault outage seen by the watch', () => {
  test('once the daemon stops, the next send is served the kept token without waiting on the vault', async () => {
    const env = await setup()
    await waitFor('the vault watch', () => env.daemon.openWatches.vault === 1)
    await waitFor(
      'the watch to be accepted',
      () => env.vault.watchState().vault === 'watching',
    )
    const route = env.vault.routes().find((row) => row.identity === 'account-a')
    if (!route) throw new Error('missing route')
    const tokens: string[] = []
    const send = () =>
      env.vault.send(
        route.id,
        async (token) => {
          tokens.push(token)
          return new Response(null, { status: 200 })
        },
        { site: 'model' },
      )
    expect((await send())?.status).toBe(200)
    expect(env.daemon.gets).toHaveLength(1)

    await env.daemon.stop()
    // The watch's connection drops with the daemon, which starts the outage.
    await waitFor(
      'the watch to lose its connection',
      () => env.vault.watchState().vault !== 'watching',
    )
    const started = performance.now()
    expect((await send())?.status).toBe(200)
    // Reaching a stopped daemon costs the client about three seconds of
    // reconnecting; a kept token is served without trying.
    expect(performance.now() - started).toBeLessThan(500)
    expect(tokens).toEqual([
      chatgptAccessToken('account-a'),
      chatgptAccessToken('account-a'),
    ])
    expect(env.daemon.gets).toHaveLength(1)
    expect(env.vault.keptReceiptState().active).toBe(true)
  })
})
