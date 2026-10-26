import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/tui'
import { flushForTest } from '../logger'
import type { OpenDialogPayload, RpcNotification } from '../rpc/protocol'
import type { RpcClient } from '../rpc/rpc-client'
import { setupTui } from '../tui/v2'
import { restoreEnv } from './setup-env'

// The toast text the TUI shows after SLOW_SERVER_POLL_FAILURES (3)
// consecutive failed polls (see `SLOW_SERVER_MESSAGE` in `tui/v2`).
const SLOW_SERVER_TOAST =
  'Waiting for the OpenAI plugin: the OpenCode server is slow.'
// The per-poll budget the TUI passes as the pending call's own timeout
// (see `PENDING_POLL_TIMEOUT_MS` in `tui/v2`).
const POLL_TIMEOUT_MS = 15_000
// Poll failures log at most one line per minute
// (see `POLL_FAILURE_LOG_INTERVAL_MS` in `tui/v2`).
const LOG_INTERVAL_MS = 60_000

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  await flushForTest()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const menuPayload: OpenDialogPayload = {
  command: 'openai',
  menu: { command: 'openai', title: 'OpenAI accounts', sections: [] },
}

function menuNotification(id: number, sessionId: string): RpcNotification {
  return { id, type: 'open-dialog', payload: menuPayload, sessionId }
}

function fakeTimers() {
  const callbacks: Array<() => void> = []
  return {
    callbacks,
    setIntervalImpl: ((callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length as unknown as NodeJS.Timeout
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  }
}

function fakeContext(
  sessionId: string,
  directory: string,
  toasts: Array<{ message: string; sessionID?: string }>,
) {
  return {
    ui: {
      slot: () => () => {},
      dialog: { clear: () => {} },
      router: { current: () => ({ type: 'session', sessionID: sessionId }) },
      toast: {
        show: (input: { message: string; sessionID?: string }) => {
          toasts.push(input)
        },
      },
    },
    data: {
      session: { get: () => ({ location: { directory } }) },
    },
  } as unknown as Plugin.Context
}

function fakeClient(options: {
  failuresLeft: { count: number }
  timeouts: Array<number | undefined>
  menu: RpcNotification[]
  failure?: () => Error
  onPending?: () => void
}): RpcClient {
  let menuSent = false
  return {
    async pending(
      _lastReceivedId: number,
      _sessionId?: string,
      timeoutMs?: number,
    ) {
      options.onPending?.()
      options.timeouts.push(timeoutMs)
      if (options.failuresLeft.count > 0) {
        options.failuresLeft.count--
        throw options.failure?.() ?? new Error('socket hang up')
      }
      // Like the real server: once the client reads past the menu, later
      // polls come back empty instead of redelivering it.
      if (menuSent) return []
      menuSent = true
      return options.menu
    },
    async apply() {
      throw new Error('not used')
    },
  }
}

/** Flushes the poll's promise chain without waiting on any wall clock. */
async function settle() {
  for (let i = 0; i < 5; i++) await Bun.sleep(0)
}

async function logFile(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'oc2-tui-slow-server-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'tui.log')
  const previous = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
  cleanups.push(() => restoreEnv('OPENCODE_OPENAI_AUTH_LOG_FILE', previous))
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = file
  return file
}

test('OpenCode 2 TUI shows one slow-server toast after failed polls, then opens the menu', async () => {
  await logFile()
  const toasts: Array<{ message: string; sessionID?: string }> = []
  const opened: OpenDialogPayload[] = []
  const timeouts: Array<number | undefined> = []
  const failuresLeft = { count: 4 }
  const timers = fakeTimers()
  const dispose = await setupTui(
    fakeContext('slow-session', 'slow-directory', toasts),
    {
      createRpcClient: () =>
        fakeClient({
          failuresLeft,
          timeouts,
          menu: [menuNotification(7, 'slow-session')],
        }),
      openDialog: async (payload) => {
        opened.push(payload)
      },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    },
  )
  cleanups.push(dispose)
  try {
    // The initial poll runs at setup; the rest are driven by hand.
    await settle()
    expect(timeouts).toEqual([POLL_TIMEOUT_MS])
    expect(toasts).toEqual([])
    timers.callbacks[0]!()
    await settle()
    timers.callbacks[0]!()
    await settle()
    // Three consecutive failures: exactly one toast, through the host surface.
    expect(toasts).toEqual([
      { message: SLOW_SERVER_TOAST, sessionID: 'slow-session' },
    ])
    expect(opened).toEqual([])
    // A fourth failure must not stack another toast.
    timers.callbacks[0]!()
    await settle()
    expect(toasts).toHaveLength(1)
    // The next poll succeeds: the menu opens, with no further toast.
    timers.callbacks[0]!()
    await settle()
    expect(opened).toEqual([menuPayload])
    expect(toasts).toHaveLength(1)
    // A later success keeps quiet too.
    timers.callbacks[0]!()
    await settle()
    expect(toasts).toHaveLength(1)
    // Every poll passed the longer timeout, not the shared 2 s default.
    expect(timeouts).toEqual(Array(timeouts.length).fill(POLL_TIMEOUT_MS))
  } finally {
    dispose()
  }
})

test('OpenCode 2 TUI counts an empty poll that takes its whole timeout as failed', async () => {
  const file = await logFile()
  const toasts: Array<{ message: string; sessionID?: string }> = []
  // The poll measures elapsed time with Date.now, so the test moves the
  // same clock the poll reads: slow calls take the poll's whole timeout.
  let now = 2_000_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  cleanups.push(() => clock.mockRestore())
  // Calls 0, 1, 2, 4 and 5 answer empty only after the timeout elapses, as
  // a real socket timeout does; call 3 answers empty at once, like a
  // healthy idle server, and must not count as a failure.
  const slowCalls = new Set([0, 1, 2, 4, 5])
  let calls = 0
  const timers = fakeTimers()
  const dispose = await setupTui(
    fakeContext('slow-empty-session', 'slow-empty-directory', toasts),
    {
      createRpcClient: () =>
        fakeClient({
          failuresLeft: { count: 0 },
          timeouts: [],
          menu: [],
          onPending: () => {
            if (slowCalls.has(calls)) now += POLL_TIMEOUT_MS
            calls++
          },
        }),
      openDialog: async () => {},
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    },
  )
  cleanups.push(dispose)
  try {
    // The initial poll runs at setup; the rest are driven by hand.
    await settle()
    for (let i = 0; i < 5; i++) {
      timers.callbacks[0]!()
      await settle()
    }
    // Three consecutive slow empty polls: exactly one toast. The fast empty
    // poll in the middle reset the stretch, so the last two slows stay quiet.
    expect(toasts).toEqual([
      { message: SLOW_SERVER_TOAST, sessionID: 'slow-empty-session' },
    ])
    // The slow polls logged with the timeout error class only: no request
    // URL, no bearer token. The minute boundary falls inside the stretch,
    // so exactly two lines were written.
    await flushForTest()
    const logged = readFileSync(file, 'utf8')
    const failures = logged
      .split('\n')
      .filter((line) => line.includes('poll failed'))
    expect(failures).toHaveLength(2)
    expect(logged).toContain('"error":"Error"')
    expect(logged).not.toContain('pending-notifications')
  } finally {
    dispose()
  }
})

test('OpenCode 2 TUI logs poll failures at most once a minute with the error class only', async () => {
  const file = await logFile()
  // A message shaped like the real failure surface: the log must never carry
  // the request URL or the bearer token, only the error's class.
  const failure = () =>
    new Error(
      'request to http://127.0.0.1:41127/rpc/pending-notifications failed: Bearer token-abc-123',
    )
  const toasts: Array<{ message: string; sessionID?: string }> = []
  const failuresLeft = { count: 100 }
  const timers = fakeTimers()
  let now = 1_000_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  cleanups.push(() => clock.mockRestore())
  const dispose = await setupTui(
    fakeContext('log-session', 'log-directory', toasts),
    {
      createRpcClient: () =>
        fakeClient({ failuresLeft, timeouts: [], menu: [], failure }),
      openDialog: async () => {},
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    },
  )
  cleanups.push(dispose)
  try {
    await settle()
    for (let i = 0; i < 4; i++) {
      timers.callbacks[0]!()
      await settle()
    }
    // Five rapid failures: one log line, one toast, no token in the file.
    await flushForTest()
    const first = readFileSync(file, 'utf8')
    expect(
      first.split('\n').filter((line) => line.includes('poll failed')),
    ).toHaveLength(1)
    expect(first).toContain('"error":"Error"')
    expect(first).not.toContain('token-abc-123')
    expect(first).not.toContain('pending-notifications')
    expect(toasts).toHaveLength(1)
    // Still inside the minute: more failures stay silent.
    for (let i = 0; i < 3; i++) {
      timers.callbacks[0]!()
      await settle()
    }
    await flushForTest()
    expect(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('poll failed')),
    ).toHaveLength(1)
    // Past the minute: the next failure logs again, without another toast.
    now += LOG_INTERVAL_MS
    timers.callbacks[0]!()
    await settle()
    await flushForTest()
    expect(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('poll failed')),
    ).toHaveLength(2)
    expect(toasts).toHaveLength(1)
  } finally {
    dispose()
  }
})
