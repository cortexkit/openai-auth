import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandApplyRequest } from '@cortexkit/common-auth/commands'
import { loadAccounts } from '@cortexkit/openai-auth-core/internal'
import type { PluginInput } from '@opencode-ai/plugin'
import { createOpenCodeMenu, type OpenCodeMenuContext } from '../../commands'
import { openAccountPool } from '../../core/pool-accounts'
import { OpenAIAuthPlugin } from '../../index'
import { createLogger, flushForTest, getLogFile } from '../../logger'
import { opencode1HostSlot } from '../../v2/host-slot'
import { createControlPlaneMenu } from '../../v2/menu'
import { setupOpenAIAuth } from '../../v2/setup'
import { fakeOpenCode2Host, poolFiles } from './opencode2-host'

const [version, root, next] = process.argv.slice(2)
if (!root) throw new Error('missing logging fixture directory')
const files = poolFiles(root)
const offline: typeof fetch = Object.assign(
  async () => {
    throw new Error('offline logging fixture')
  },
  { preconnect() {} },
) as typeof fetch
globalThis.fetch = offline

let cleanup: (() => unknown) | undefined
if (version === '2') {
  cleanup = await setupOpenAIAuth(fakeOpenCode2Host().ctx, {
    paths: files.paths,
    sidebarStateFile: join(root, 'sidebar.json'),
    slot: opencode1HostSlot(join(root, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
  })
} else {
  const input = {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    },
    project: { id: 'logging-fixture', name: 'logging-fixture' },
    directory: root,
    worktree: root,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost:0'),
    $: {},
  } as unknown as PluginInput
  const hooks = await OpenAIAuthPlugin(input)
  if (!hooks.auth?.loader) throw new Error('missing OpenCode 1 auth loader')
  await hooks.auth.loader(
    async () => ({
      type: 'oauth',
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires: Date.now() + 3600_000,
    }),
    { id: 'openai', models: {} } as never,
  )
}

const context: OpenCodeMenuContext = {
  accountStoragePath: files.configPath,
  accountStatePath: files.statePath,
  packageVersion: 'test',
  loadAccounts,
  store: () => openAccountPool(files.paths()),
  migration: async () => ({ migrated: true }),
}
const menu =
  version === '2'
    ? createControlPlaneMenu(context)
    : {
        open: (sessionId: string) =>
          createOpenCodeMenu(context).open({ sessionId, notify() {} }),
        apply: (request: Omit<CommandApplyRequest, 'command'>) =>
          createOpenCodeMenu(context).apply(
            { command: 'openai', ...request },
            { sessionId: 'S', notify() {} },
          ),
      }
const levels = ['error', 'warn', 'info', 'debug', 'trace'] as const
const log = createLogger('logging-fixture')
async function probe(stage: string) {
  for (const level of levels) log[level](`level-probe-${stage}-${level}`)
  await flushForTest()
  const text = readFileSync(getLogFile(), 'utf8')
  const section = (await menu.open('S')).menu.sections.find(
    (s) => s.id === 'diagnostics',
  )
  return {
    emitted: levels.filter((level) =>
      text.includes(`level-probe-${stage}-${level}`),
    ),
    section,
  }
}
const startup = await probe('startup')
let applied: Awaited<ReturnType<typeof probe>> | undefined
if (next) {
  const result = await menu.apply({
    sectionId: 'diagnostics',
    actionId: 'logging',
    values: { level: next },
  })
  if (!result.ok) throw new Error(`logging action refused: ${result.text}`)
  applied = await probe('applied')
}
log.error('redaction-probe Bearer fixture-bearer-secret', {
  authorization: 'Bearer fixture-header-secret',
  cookie: 'fixture-cookie-secret',
  accessToken: 'fixture-access-secret',
  refreshToken: 'fixture-refresh-secret',
  email: 'fixture-person@example.test',
  'chatgpt-account-id': 'fixture-chatgpt-secret',
  orgName: 'fixture-organization-secret',
  accountId: 'main',
})
await flushForTest()
const redacted = readFileSync(getLogFile(), 'utf8')
  .split('\n')
  .find((line) => line.includes('redaction-probe'))
await cleanup?.()
console.log(JSON.stringify({ startup, applied, redacted }))
// OpenCode 1 owns background services for its host's lifetime; this child is
// the host, and exiting is the restart boundary the parent test exercises.
process.exit(0)
