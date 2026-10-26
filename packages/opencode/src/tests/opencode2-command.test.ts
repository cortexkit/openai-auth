import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrationNoticeMenu } from '@cortexkit/openai-auth-core'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
import type { ApplyRequest } from '../rpc/protocol'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  seedPool,
} from './fixtures/opencode2-host'

const roots: string[] = []
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  resetNotificationsForTest()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function location(
  suffix: string,
  sessions: Map<string, string>,
  migrated = true,
  poolMigration = false,
) {
  const root = mkdtempSync(join(tmpdir(), `oc2-command-${suffix}-`))
  roots.push(root)
  const files = poolFiles(root)
  seedPool(files, 'main-first', [{ id: `account-${suffix}` }])
  // Disabled rows keep setup's independent first-reading poll out of this
  // command-side-effect oracle while still providing location-specific data.
  const config = files.readConfig()
  for (const row of config.accounts) row.enabled = false
  writeFileSync(files.configPath, JSON.stringify(config))
  if (!migrated)
    writeFileSync(
      files.configPath,
      JSON.stringify({ version: 1, accounts: [] }),
    )
  const host = fakeOpenCode2Host({ directory: root, sessions })
  sessions.set(suffix, root)
  let fetches = 0
  let logins = 0
  const blockers = [{ pid: 42, version: 'old', detail: 'fixture' }]
  const dispose = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    heartbeat: false,
    poolMigration,
    fence: async () => ({ open: false, blockers }),
    fetch: Object.assign(
      async () => {
        fetches++
        throw new Error('unexpected fetch')
      },
      { preconnect() {} },
    ),
    beginLogin: async () => {
      logins++
      throw new Error('unexpected login')
    },
    vault: { stateDir: join(root, 'vault'), pollIntervalMs: 0 },
  })
  cleanups.push(dispose)
  const bytes = () => [
    readFileSync(files.configPath, 'utf8'),
    readFileSync(files.statePath, 'utf8'),
  ]
  return {
    root,
    files,
    host,
    dispose,
    bytes,
    blockers,
    effects: () => ({ fetches, logins, turns: host.turns.length }),
  }
}

test('OpenCode 2 command routes one shared definition to isolated directories and sessions after disposal', async () => {
  const sessions = new Map<string, string>()
  const a = await location('a', sessions)
  const b = await location('b', sessions)
  expect(a.host.commands).toHaveLength(1)
  expect(b.host.commands).toHaveLength(1)
  expect(a.host.commands[0]).toBe(b.host.commands[0])
  const before = [a.bytes(), b.bytes()] as const
  const clientA = createRpcClient(
    (await resolveRpcDir(a.root)).dir,
    process.pid,
  )
  const clientB = createRpcClient(
    (await resolveRpcDir(b.root)).dir,
    process.pid,
  )
  await clientA.pending(0, 'a')
  await clientB.pending(0, 'b')
  await a.host.commands[0]!.execute({ sessionID: 'a' })
  expect(await clientB.pending(0, 'b')).toEqual([])
  const messages = await clientA.pending(0, 'a')
  expect(messages).toHaveLength(1)
  expect(JSON.stringify(messages[0]!.payload)).toContain('account-a')
  expect(JSON.stringify(messages[0]!.payload)).not.toContain('account-b')
  const result = await clientA.apply({
    command: 'openai',
    sectionId: 'routing',
    actionId: 'mode',
    sessionId: 'a',
    values: { mode: 'fallback-first' },
  })
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result.menu)).toContain('account-a')
  await a.dispose()
  expect(a.host.commands).toHaveLength(0)
  expect(b.host.commands).toHaveLength(1)
  await b.host.commands[0]!.execute({ sessionID: 'b' })
  const other = await clientB.pending(0, 'b')
  expect(other).toHaveLength(1)
  expect(JSON.stringify(other[0]!.payload)).toContain('account-b')
  const applied = await clientB.apply({
    command: 'openai',
    sectionId: 'reset',
    sessionId: 'b',
  } as ApplyRequest)
  expect(applied.ok).toBe(false)
  expect(JSON.stringify(applied.menu)).toContain('account-b')
  expect(a.bytes()).not.toEqual(before[0])
  expect(b.bytes()).toEqual(before[1])
  expect(a.effects()).toEqual({ fetches: 0, logins: 0, turns: 0 })
  expect(b.effects()).toEqual({ fetches: 0, logins: 0, turns: 0 })
})

test('OpenCode 2 no-TUI execution makes no writes or model turns and spends nothing', async () => {
  const f = await location('headless', new Map())
  const before = f.bytes()
  expect(f.host.commands).toHaveLength(1)
  await f.host.commands[0]!.execute({ sessionID: 'headless' })
  expect(f.bytes()).toEqual(before)
  expect(f.effects()).toEqual({ fetches: 0, logins: 0, turns: 0 })
  // The refusal leaves exactly one notice for the session's TUI; draining
  // past it prunes it, so it is shown once and never enters the conversation.
  const queued = drainNotifications(0, 'headless')
  expect(queued).toHaveLength(1)
  expect(queued[0]!.payload).toEqual({
    command: 'openai',
    notify: {
      message: '/openai timed out waiting for the terminal UI. Run it again.',
      kind: 'warning',
    },
  })
  expect(drainNotifications(queued[0]!.id, 'headless')).toEqual([])
})

test('OpenCode 2 stand-aside registers no command while blocked migration uses the shared notice', async () => {
  const aside = await location('aside', new Map(), false)
  expect(aside.host.commands).toEqual([])
  const pending = await location('pending', new Map(), false, true)
  const before = pending.bytes()
  expect(pending.host.commands).toHaveLength(1)
  const client = createRpcClient(
    (await resolveRpcDir(pending.root)).dir,
    process.pid,
  )
  await client.pending(0, 'pending')
  await pending.host.commands[0]!.execute({ sessionID: 'pending' })
  const messages = await client.pending(0, 'pending')
  expect(messages).toHaveLength(1)
  expect(messages[0]!.payload).toEqual({
    command: 'openai',
    menu: migrationNoticeMenu(pending.blockers),
  })
  const result = await client.apply({
    command: 'openai',
    sectionId: 'accounts',
    actionId: 'add',
    sessionId: 'pending',
  })
  expect(result.ok).toBe(false)
  expect(result.text).toBe(
    'Nothing was changed: the accounts have not moved to the new layout yet.',
  )
  expect(pending.bytes()).toEqual(before)
  expect(pending.effects()).toEqual({ fetches: 0, logins: 0, turns: 0 })
})
