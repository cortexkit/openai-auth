import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushForTest, setLogLevel } from '../logger'
import { isTuiConnected, resetNotificationsForTest } from '../rpc/notifications'
import type { OpenDialogPayload } from '../rpc/protocol'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { installControlPlane } from '../v2/control-plane'
import { fakeOpenCode2Host } from './fixtures/opencode2-host'
import { restoreEnv } from './setup-env'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  await flushForTest()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  resetNotificationsForTest()
  setLogLevel(undefined)
})

async function start() {
  await flushForTest()
  const directory = mkdtempSync(join(tmpdir(), 'oc2-command-connect-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const previousLog = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
  cleanups.push(() => restoreEnv('OPENCODE_OPENAI_AUTH_LOG_FILE', previousLog))
  const logFile = join(directory, 'command.log')
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
  setLogLevel('warn')
  const host = fakeOpenCode2Host({ directory })
  const opened: string[] = []
  const payload: OpenDialogPayload = {
    command: 'openai',
    menu: { command: 'openai', title: 'OpenAI accounts', sections: [] },
  }
  const dispose = await installControlPlane(host.ctx, {
    async open(sessionId) {
      opened.push(sessionId)
      return payload
    },
    async apply() {
      throw new Error('not used')
    },
  })
  cleanups.push(dispose)
  const client = createRpcClient(
    (await resolveRpcDir(directory)).dir,
    process.pid,
  )
  return { host, client, opened, payload, logFile, dispose }
}

test('OpenCode 2 command delivers the menu when the first session poll arrives late', async () => {
  const f = await start()
  const command = f.host.commands[0]!.execute({ sessionID: 'fresh' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(f.opened).toEqual([])
  const first = await f.client.pending(0, 'fresh')
  await command
  const next = await f.client.pending(0, 'fresh')
  expect([...first, ...next].map((entry) => entry.payload)).toEqual([f.payload])
  expect(f.opened).toEqual(['fresh'])
  expect(f.host.turns).toEqual([])
})

test('OpenCode 2 command refusal for a missing TUI queues one notice and adds no session input', async () => {
  const f = await start()
  const began = performance.now()
  const command = f.host.commands[0]!.execute({
    sessionID: 'private-session-id',
  }).then(() => performance.now() - began)
  // A poll of another session (or without a session) cannot connect this one.
  await f.client.pending(0, 'other')
  await f.client.pending(0)
  const elapsed = await command
  expect(elapsed).toBeGreaterThanOrEqual(1_900)
  expect(elapsed).toBeLessThan(3_000)
  expect(f.opened).toEqual([])
  expect(f.host.turns).toEqual([])
  // The refusal leaves exactly one notice for the session, which the TUI
  // shows as a toast at its next successful poll. Draining past it prunes
  // it, so it is shown once; it never enters the conversation.
  const refused = await f.client.pending(0, 'private-session-id')
  expect(refused).toHaveLength(1)
  expect(refused[0]!.payload).toEqual({
    command: 'openai',
    notify: {
      message: '/openai timed out waiting for the terminal UI. Run it again.',
      kind: 'warning',
    },
  })
  expect(await f.client.pending(refused[0]!.id, 'private-session-id')).toEqual(
    [],
  )
  await flushForTest()
  const log = readFileSync(f.logFile, 'utf8')
  // The sessionless poll also emits an RPC warning; count only command refusals.
  const lines = log
    .split('\n')
    .filter((line) => line.includes('/openai needs the terminal UI'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(
    '/openai needs the terminal UI (session state: no TUI poll within 2 s).',
  )
  expect(log).not.toContain('private-session-id')
})

test('OpenCode 2 command opens immediately for an already-connected session', async () => {
  const f = await start()
  await f.client.pending(0, 'connected')
  expect(isTuiConnected('connected')).toBe(true)
  const began = performance.now()
  await f.host.commands[0]!.execute({ sessionID: 'connected' })
  expect(performance.now() - began).toBeLessThan(500)
  const messages = await f.client.pending(0, 'connected')
  expect(messages.map((entry) => entry.payload)).toEqual([f.payload])
  expect(f.opened).toEqual(['connected'])
  expect(f.host.turns).toEqual([])
})

test('OpenCode 2 command cancels its first-poll wait when the location closes', async () => {
  const f = await start()
  const command = f.host.commands[0]!.execute({ sessionID: 'closing' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const began = performance.now()
  await f.dispose()
  await command
  expect(performance.now() - began).toBeLessThan(500)
  expect(f.opened).toEqual([])
  expect(f.host.turns).toEqual([])
  await flushForTest()
  expect(readFileSync(f.logFile, 'utf8')).toContain(
    'session state: location closed',
  )
})
