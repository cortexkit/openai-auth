import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LockOwnershipError, lockPathFor } from '@cortexkit/common-auth/fs'
import type { PluginInput } from '@opencode-ai/plugin'
import * as sidebar from '../../sidebar-state.ts'

const dir = mkdtempSync(join(tmpdir(), 'sidebar-deletion-'))
const file = join(dir, 'sidebar.json')
process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = file
process.env.OPENCODE_OPENAI_AUTH_FILE = join(dir, 'accounts.json')
process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(dir, 'accounts-state.json')
process.env.OPENCODE_CONFIG_DIR = dir
process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(dir, 'plugin.log')
process.env.XDG_STATE_HOME = dir
process.env.XDG_CONFIG_HOME = dir
process.env.OPENCODE_OPENAI_AUTH_DUMP = '0'

const remove = sidebar.removeSidebarActiveRouting
const failures: unknown[] = []
let observeFailure: () => void = () => {}
const failed = new Promise<void>((resolve) => {
  observeFailure = resolve
})
let expire = true
// Inject only the scheduling point: the shared library still acquires the real
// lock, checks its on-disk lease before rename and creates the error itself.
mock.module('../../sidebar-state.ts', () => ({
  ...sidebar,
  removeSidebarActiveRouting: (...args: Parameters<typeof remove>) =>
    remove(args[0], args[1], args[2], {
      beforeRecheck: async () => {
        if (!expire) return
        const path = lockPathFor(file, 'sidebar-write')
        const owner = JSON.parse(readFileSync(path, 'utf8'))
        writeFileSync(path, JSON.stringify({ ...owner, expiresAt: 0 }))
      },
    }).catch((error: unknown) => {
      failures.push({
        realOwnershipError: error instanceof LockOwnershipError,
        name: error instanceof Error ? error.name : String(error),
      })
      observeFailure()
      throw error
    }),
}))

const unhandled: string[] = []
const onUnhandled = (error: unknown) => {
  unhandled.push(error instanceof Error ? error.name : String(error))
}
process.on('unhandledRejection', onUnhandled)
globalThis.fetch = (async () =>
  new Response('{}', { status: 404 })) as unknown as typeof fetch

const { CodexAuthPlugin } = await import('../../index.ts')
const hooks = await CodexAuthPlugin(
  {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: dir,
    worktree: dir,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  },
  { poolMigration: { enabled: false } },
)

try {
  if (!hooks.auth?.loader || !hooks.event) throw new Error('Missing hooks')
  await hooks.auth.loader(
    async () => ({
      type: 'oauth',
      access: 'main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 3_600_000,
    }),
    { id: 'openai', models: {} } as Parameters<typeof hooks.auth.loader>[1],
  )
  await sidebar.drainSidebarWrites()
  const sessionId = 'deleted-session'
  await sidebar.upsertSidebarActiveRouting(
    {
      sessionId,
      activeId: 'main',
      route: 'sticky-balanced',
      updatedAt: Date.now(),
    },
    undefined,
    file,
  )
  const deletion = {
    event: {
      type: 'session.deleted',
      properties: { info: { id: sessionId } },
    },
  } as Parameters<typeof hooks.event>[0]
  // OpenCode's event bus does not await the plugin's event hook.
  void hooks.event(deletion)
  // The event reads the roster before enqueueing its write. Await the observed
  // real failure, rather than assuming the write was queued synchronously.
  await failed
  await sidebar.drainSidebarWrites()
  await new Promise<void>((resolve) => setImmediate(resolve))

  expire = false
  await hooks.event(deletion)
  const state = await sidebar.getSidebarState(file)
  const { flushForTest } = await import('../../logger.ts')
  flushForTest()
  const log = readFileSync(join(dir, 'plugin.log'), 'utf8')
  console.log(
    JSON.stringify({
      failures,
      unhandled,
      removed:
        state.activeRouting?.[sidebar.hashSidebarSessionId(sessionId)] ===
        undefined,
      warned: log.includes('sidebar write failed'),
      recovered: log.includes('sidebar write recovered'),
    }),
  )
} finally {
  process.off('unhandledRejection', onUnhandled)
  await hooks.dispose?.()
  rmSync(dir, { recursive: true, force: true })
}
