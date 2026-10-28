import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  drainVaultQuota,
  type VaultRosterRow,
} from '@cortexkit/common-auth/claustrum'
import type {
  CommandApplyRequest,
  CommandInvocation,
} from '@cortexkit/common-auth/commands'
import { installOpenCode2Auth } from '@cortexkit/common-auth/opencode2'
import {
  formatQuota,
  projectQuota,
  type QuotaMap,
} from '@cortexkit/common-auth/quota'
import {
  loadAccounts,
  OpenAiVault,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum'
import {
  createOpenCodeMenu,
  menuText,
  type OpenCodeMenuContext,
} from '../commands'
import { getSettings } from '../config'
import { openAccountPool } from '../core/pool-accounts'
import { sectionOptions } from '../tui/command-dialogs'
import { openControlDialog } from '../tui/v2-dialog'
import { createOpenAIAdapter, type PoolAccess } from '../v2/adapter'
import { createControlPlaneMenu } from '../v2/menu'
import { SessionPins } from '../v2/pins'
import { fakeOpenCode2Host, scope } from './fixtures/opencode2-host'
import {
  quotaMap as fixtureQuotaMap,
  readJson,
  seedPool,
} from './fixtures/pool-install'

const now = Date.UTC(2026, 9, 9, 16, 9)
const invocation: CommandInvocation = { notify() {} }
let dir: string
let files: { configFile: string; stateFile: string }
let polls: string[]
let roster: VaultRosterRow[]

function quotaMap(used: number, checkedAt: number) {
  const quota = fixtureQuotaMap(used, checkedAt)
  quota.limits[0]!.resetsAt = new Date(now + 2 * 60 * 60_000).toISOString()
  return quota
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-command-menu-'))
  files = {
    configFile: join(dir, 'config.json'),
    stateFile: join(dir, 'state.json'),
  }
  polls = []
  roster = ['main', 'ufuk', 'live'].map((id) => ({
    routeId: `vault:chatgpt-${id}`,
    credentialId: `chatgpt:openai:${id}`,
    credentialType: 'oauth',
    accountIdentity: `chatgpt-${id}`,
    state: 'active',
    label:
      id === 'main'
        ? 'vault-user@example.com'
        : id === 'ufuk'
          ? 'gmail'
          : 'live',
    enabled: true,
    addedAt: 1,
    quota: quotaMap(
      id === 'main' ? 7 : 85,
      id === 'main' ? now - 3 * 86_400_000 : now,
    ) as QuotaMap,
  }))
  seedPool(files, [
    { id: 'main', quota: quotaMap(7, now - 3 * 86_400_000) },
    { id: 'ufuk', quota: quotaMap(85, now) },
  ])
  const config = readJson(files.configFile)
  delete (config.accounts as Array<Record<string, unknown>>)[0]?.label
  writeFileSync(files.configFile, JSON.stringify(config))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function vault(connected = true): OpenAiVault {
  return {
    authority: async () => (connected ? 'vault' : 'local'),
    status: async () => ({
      host: 'opencode',
      name: 'openai-auth-opencode',
      enrollment: connected
        ? {
            state: 'approved',
            name: 'openai-auth-opencode',
            consumerId: 'test',
            scopes: [],
          }
        : { state: 'idle' },
      discovered: connected,
      accounts: connected ? roster : [],
    }),
    identities: () =>
      new Set(connected ? roster.map((row) => row.accountIdentity!) : []),
    routes: () =>
      connected
        ? roster
            .filter((row) => row.enabled && row.state === 'active')
            .map((row) => ({
              id: row.routeId,
              kind: 'oauth',
              identity: row.accountIdentity,
              quota: row.quota,
            }))
        : [],
    snapshot: () => ({
      version: 1,
      complete: true,
      rows: connected ? roster : [],
      declined: [],
    }),
    refresh: async () => undefined,
    pollQuota: async (id: string) => {
      polls.push(id)
      return { ok: true }
    },
  } as unknown as OpenAiVault
}
function context(connected = true): OpenCodeMenuContext {
  return {
    accountStoragePath: files.configFile,
    accountStatePath: files.stateFile,
    packageVersion: 'test',
    quotaManager: new QuotaManager({
      configPath: files.configFile,
      storage: null,
    }),
    loadAccounts,
    store: () =>
      openAccountPool({
        configPath: files.configFile,
        statePath: files.stateFile,
      }),
    migration: async () => ({ migrated: true }),
    beginAccountLogin: async () => {
      throw new Error('OAuth was not requested')
    },
    vault: vault(connected),
    now: () => now,
    resolveResetTarget: async () => {
      throw new Error('reset target is unavailable')
    },
    refreshResetTargetQuota: async () => ({ account: 'main', ok: true }),
    fetchImpl: fetch,
    randomUUID: () => 'uuid',
  }
}
async function sections(connected = true) {
  return (await createOpenCodeMenu(context(connected)).open(invocation)).menu
    .sections
}

describe('vault command menu', () => {
  test('both OpenCode menus wait for the first vault answer without an empty-access hint', async () => {
    const gate = Promise.withResolvers<void>()
    const daemon = await startMockDaemon({
      directory: dir,
      credentials: {},
      grants: [],
      listReplyGate: gate.promise,
    })
    const remote = new OpenAiVault({
      host: 'opencode',
      stateDir: join(dir, 'vault'),
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
    })
    mkdirSync(join(dir, 'vault'), { recursive: true })
    writeFileSync(
      remote.paths.tokenPath,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    const ctx = { ...context(), vault: remote }
    try {
      const started = Date.now()
      const first = await createOpenCodeMenu(ctx).open(invocation)
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
      expect(daemon.lists).toBe(1)
      const second = await createOpenCodeMenu({ ...ctx, readOnly: true }).open(
        invocation,
      )
      for (const payload of [first, second]) {
        const section = payload.menu.sections.find((s) => s.id === 'vault')!
        expect(section.lines).toContain(
          "Connected · waiting for the vault's first answer",
        )
        expect(section.lines?.join('\n')).not.toMatch(
          /0 accounts|ck auth grant|reclassify/,
        )
        expect(section.items).toEqual([])
        expect(section.actions.map((a) => a.id)).toEqual(['disconnect'])
        expect(
          payload.menu.sections.find((s) => s.id === 'accounts')?.items,
        ).toEqual([])
        for (const id of ['accounts', 'quota', 'limits', 'routing']) {
          expect(
            payload.menu.sections.find((s) => s.id === id)?.actions,
          ).toEqual([])
        }
      }
      expect(await remote.status()).toMatchObject({
        discovered: false,
        accounts: [],
      })
      gate.resolve()
      await remote.refresh()
      expect(await remote.status()).toMatchObject({
        discovered: true,
        accounts: [],
      })
      for (const readOnly of [false, true]) {
        const { menu } = await createOpenCodeMenu({ ...ctx, readOnly }).open(
          invocation,
        )
        const section = menu.sections.find((s) => s.id === 'vault')!
        expect(section.lines).toContain('Connected · 0 accounts')
        expect(section.lines?.join('\n')).toContain(
          'The vault has no grant letting openai-auth-opencode read OpenAI accounts.',
        )
      }
    } finally {
      gate.resolve()
      remote.close()
      await daemon.stop()
    }
  }, 10_000)

  test('vault order by displayed name writes the roster and the next request follows it on both OpenCode menus', async () => {
    const daemon = await startMockDaemon({
      directory: dir,
      credentials: {
        a: vaultLogin('account-a', { wire: { email: 'alice@example.com' } }),
        b: vaultLogin('account-b', { wire: { email: 'bob@example.com' } }),
      },
    })
    const remote = new OpenAiVault({
      host: 'opencode',
      stateDir: join(dir, 'vault'),
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
    })
    mkdirSync(join(dir, 'vault'), { recursive: true })
    writeFileSync(
      remote.paths.tokenPath,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    const ctx = { ...context(), vault: remote }
    const localBefore = [files.configFile, files.stateFile].map((file) =>
      readFileSync(file),
    )
    try {
      await remote.refresh()
      for (const route of remote.routes()) {
        const receipt = await remote.authorize(route.id)
        expect(receipt).toBeDefined()
        await remote.recordSnapshot(
          route.id,
          {
            primary: {
              usedPercent: 10,
              remainingPercent: 90,
              checkedAt: Date.now(),
              windowMinutes: 300,
            },
          },
          false,
          receipt!,
        )
      }
      for (const readOnly of [false, true]) {
        // The server control-plane menu supplies the writable OpenCode 2 menu.
        const menu = createOpenCodeMenu(ctx)
        const v2 = createControlPlaneMenu(ctx)
        const opened = readOnly
          ? await v2.open('ses_1')
          : await menu.open(invocation)
        expect(
          opened.menu.sections.find((s) => s.id === 'routing')!.lines,
        ).toContain('Vault account order: alice@example.com, bob@example.com')
        const input = {
          command: 'openai',
          sectionId: 'routing',
          actionId: 'order',
          values: { order: 'bob@example.com, alice@example.com' },
        }
        const applied = readOnly
          ? await v2.apply(input)
          : await menu.apply(input, invocation)
        expect(applied.ok).toBe(true)
        const saved = JSON.parse(readFileSync(remote.paths.rosterPath, 'utf8'))
        expect(saved.rows.map((row: VaultRosterRow) => row.email)).toEqual([
          'bob@example.com',
          'alice@example.com',
        ])
        const host = fakeOpenCode2Host()
        const openai = createOpenAIAdapter({
          source: {
            rateLimitMarks: () => new Map(),
            refreshBackoffFor: () => new Map(),
          } as unknown as PoolAccess,
          vault: remote,
          pins: new SessionPins(),
          storage: async () => ({
            version: 1,
            accounts: [],
            routing: { mode: 'ordered' },
          }),
        })
        const installation = await installOpenCode2Auth(
          host.ctx,
          openai.adapter,
        )
        try {
          const draft = { ...scope(), headers: {} as Record<string, string> }
          await host.fire('model.request', draft)
          expect(new Headers(draft.headers).get('chatgpt-account-id')).toBe(
            'account-b',
          )
        } finally {
          await installation.dispose()
        }
        await remote.reorder(
          [...remote.snapshot()!.rows].reverse().map((row) => row.routeId),
        )
      }
      expect(
        [files.configFile, files.stateFile].map((file) => readFileSync(file)),
      ).toEqual(localBefore)
      const menu = createOpenCodeMenu(ctx)
      await menu.open(invocation)
      await drainVaultQuota(remote.paths.rosterPath)
      const vaultBefore = readFileSync(remote.paths.rosterPath)
      await remote.disconnect()
      const stale = await menu.apply(
        {
          command: 'openai',
          sectionId: 'routing',
          actionId: 'order',
          values: { order: 'bob@example.com, alice@example.com' },
        },
        invocation,
      )
      expect(stale.ok).toBe(false)
      expect(readFileSync(remote.paths.rosterPath)).toEqual(vaultBefore)
      expect(
        [files.configFile, files.stateFile].map((file) => readFileSync(file)),
      ).toEqual(localBefore)
      writeFileSync(
        remote.paths.tokenPath,
        JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
        { mode: 0o600 },
      )
      const staleLocal = await menu.apply(
        {
          command: 'openai',
          sectionId: 'routing',
          actionId: 'order',
          values: { order: 'ufuk, main' },
        },
        invocation,
      )
      expect(staleLocal.ok).toBe(false)
      expect(readFileSync(remote.paths.rosterPath)).toEqual(vaultBefore)
      expect(
        [files.configFile, files.stateFile].map((file) => readFileSync(file)),
      ).toEqual(localBefore)
    } finally {
      remote.close()
      await daemon.stop()
    }
  })

  test('Routing shows the default vault account placement without renaming any route', async () => {
    roster[1]!.credentialId = 'chatgpt:openai'
    const menu = createOpenCodeMenu(context())
    for (const mode of ['main-first', 'fallback-first', 'ordered'] as const) {
      expect(
        (
          await menu.apply(
            {
              command: 'openai',
              sectionId: 'routing',
              actionId: 'mode',
              values: { mode },
            },
            invocation,
          )
        ).ok,
      ).toBe(true)
      const routing = (await menu.open(invocation)).menu.sections.find(
        (section) => section.id === 'routing',
      )!
      expect(routing.lines).toContain(
        'Vault account order: vault-user@example.com, gmail, live',
      )
      if (mode !== 'ordered')
        expect(routing.lines).toContain(
          mode === 'main-first'
            ? 'Tried in order: gmail, vault-user@example.com, live'
            : 'Tried in order: vault-user@example.com, live, gmail',
        )
      expect(routing.lines).not.toContain(
        'No default vault account, so this mode orders like Ordered',
      )
      const v2 = await createOpenCodeMenu({
        ...context(),
        readOnly: true,
      }).open(invocation)
      expect(
        v2.menu.sections.find((section) => section.id === 'routing')!.lines,
      ).toEqual(routing.lines)
    }
  })

  test('Routing explains alias-only placement modes but not Ordered or sticky-balanced', async () => {
    const menu = createOpenCodeMenu(context())
    for (const mode of [
      'main-first',
      'fallback-first',
      'ordered',
      'sticky-balanced',
    ] as const) {
      await menu.apply(
        {
          command: 'openai',
          sectionId: 'routing',
          actionId: 'mode',
          values: { mode },
        },
        invocation,
      )
      const routing = (await menu.open(invocation)).menu.sections.find(
        (section) => section.id === 'routing',
      )!
      expect(
        routing.lines.includes(
          'No default vault account, so this mode orders like Ordered',
        ),
      ).toBe(mode === 'main-first' || mode === 'fallback-first')
      expect(
        routing.lines.some((line) => line.startsWith('Tried in order:')),
      ).toBe(false)
      const v2 = await createOpenCodeMenu({
        ...context(),
        readOnly: true,
      }).open(invocation)
      expect(
        v2.menu.sections.find((section) => section.id === 'routing')!.lines,
      ).toEqual(routing.lines)
    }
    expect(
      (await sections(false)).find((section) => section.id === 'routing')!
        .lines,
    ).not.toContain(
      'No default vault account, so this mode orders like Ordered',
    )
  })

  test('dialog quota text matches the shared formatter and each row checks only its account', async () => {
    roster[0]!.email = 'known@example.com'
    const quota = (await sections()).find((section) => section.id === 'quota')!
    expect(quota.items.map((item) => item.id)).toEqual(
      roster.map((row) => row.routeId),
    )
    for (const row of roster) {
      const item = quota.items.find((item) => item.id === row.routeId)!
      expect(item.label).toBe(row.email || row.label)
      expect(item.group).toBe('Accounts')
      expect(item.status).toBe(
        formatQuota(projectQuota(row.quota), { now, form: 'compact' }),
      )
      expect(item.detail).toBe(formatQuota(projectQuota(row.quota), { now }))
      expect(
        sectionOptions(quota).find(
          (option) => option.value === `item:${row.routeId}`,
        ),
      ).toEqual(
        expect.objectContaining({
          category: 'Accounts',
          footer: item.status,
          description: item.detail,
        }),
      )
      expect(item.actions.map((action) => action.label)).toEqual([
        'Check this account',
      ])
    }
    const result = await createOpenCodeMenu(context()).apply(
      {
        command: 'openai',
        sectionId: 'quota',
        itemId: roster[0]!.routeId,
        actionId: 'check',
        values: {},
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(polls).toEqual([roster[0]!.routeId])
    expect(quota.actions[0]?.knobs).toEqual([])
  })
  // Vault mode is exclusive: while connected, the vault's accounts are the
  // only ones listed, and no local row appears, set aside or otherwise.
  test('in vault mode accounts list only the vault accounts', async () => {
    const accounts = (await sections()).find(
      (section) => section.id === 'accounts',
    )!
    expect(accounts.lines).toEqual([
      '3 vault accounts',
      '3 can route',
      'Accounts are managed in the vault with ck. Disconnect to use local accounts.',
    ])
    expect(accounts.items.map((item) => item.id)).toEqual(
      roster.map((row) => row.routeId),
    )
    expect(
      accounts.items.find((item) => item.id === roster[2]!.routeId)?.detail,
    ).toContain('active · enabled')
  })
  test('quota lists the same accounts and dates stale readings in Quota', async () => {
    const menu = await sections()
    const accounts = menu.find((section) => section.id === 'accounts')!
    const quota = menu.find((section) => section.id === 'quota')!
    expect(quota.items.map((item) => item.id)).toEqual(
      roster.map((row) => row.routeId),
    )
    expect(accounts.items.map((item) => item.id)).toEqual(
      quota.items.map((item) => item.id),
    )
    for (const section of [quota]) {
      expect(
        section.items.find((item) => item.id === roster[0]!.routeId)?.detail,
      ).toContain('checked 3d ago')
      expect(
        section.items.find((item) => item.id === roster[1]!.routeId)?.detail,
      ).not.toContain('ago')
    }
  })
  test('in vault mode no local row is listed in Accounts, Quota or Limits', async () => {
    const menu = await sections()
    for (const id of ['accounts', 'quota', 'limits']) {
      const ids = menu
        .find((section) => section.id === id)
        ?.items.map((item) => item.id)
      expect(ids).toEqual(roster.map((row) => row.routeId))
      expect(ids).not.toContain('main')
      expect(ids).not.toContain('ufuk')
    }
  })
  test('cold and declined vault accounts are listed but not counted as routable', async () => {
    roster[0]!.state = 'needs_reauth'
    roster[1]!.enabled = false
    const accounts = (await sections()).find(
      (section) => section.id === 'accounts',
    )!
    expect(accounts.lines).toEqual([
      '3 vault accounts',
      '1 can route',
      'Accounts are managed in the vault with ck. Disconnect to use local accounts.',
    ])
    expect(accounts.items.map((item) => item.id)).toEqual(
      roster.map((row) => row.routeId),
    )
    const quota = (await sections()).find((section) => section.id === 'quota')!
    expect(quota.items.map((item) => item.id)).toEqual([roster[2]!.routeId])
    expect(quota.lines).toEqual([
      `${roster[0]!.label} (needs_reauth): ${formatQuota(projectQuota(roster[0]!.quota), { now, form: 'compact' })}`,
      `${roster[1]!.label} (disabled): ${formatQuota(projectQuota(roster[1]!.quota), { now, form: 'compact' })}`,
    ])
  })
  test('vault floors use the request route key and leave credentials untouched', async () => {
    const before = readFileSync(files.stateFile, 'utf8')
    const result = await createOpenCodeMenu(context()).apply(
      {
        command: 'openai',
        sectionId: 'limits',
        itemId: roster[0]!.routeId,
        actionId: 'floors',
        values: { primary: 25, secondary: 10 },
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(readJson(files.configFile).killswitch).toEqual(
      expect.objectContaining({
        accounts: expect.objectContaining({
          [roster[0]!.routeId]: { primary: 25, secondary: 10 },
        }),
      }),
    )
    expect(
      result.menu.sections
        .find((section) => section.id === 'limits')
        ?.items.find((item) => item.id === roster[0]!.routeId)?.status,
    ).toBe('5h ≥25% · secondary ≥10%')
    expect(readFileSync(files.stateFile, 'utf8')).toBe(before)
  })
  test('reset offers no local credential actions in vault mode', async () => {
    const reset = (await sections()).find((section) => section.id === 'reset')!
    expect(reset.items).toEqual([])
    expect(reset.actions).toEqual([])
    expect(reset.lines).toEqual([
      'Accounts are managed in the vault with ck. Disconnect to use local accounts.',
    ])
  })
  test('vault mode hides local-writing dialog actions and disconnect restores them unchanged', async () => {
    const ctx = context()
    const command = createOpenCodeMenu(ctx)
    const connected = (await command.open(invocation)).menu
    const accounts = connected.sections.find(
      (section) => section.id === 'accounts',
    )!
    expect(accounts.actions.map((action) => action.id)).toEqual([])
    expect(accounts.items.every((item) => item.actions.length === 0)).toBe(true)
    expect(
      connected.sections
        .find((section) => section.id === 'routing')!
        .actions.map((action) => action.id),
    ).toEqual(['mode', 'order'])
    expect(
      connected.sections
        .find((section) => section.id === 'limits')!
        .items[0]!.actions.map((action) => action.id),
    ).toContain('floors')
    expect(
      connected.sections
        .find((section) => section.id === 'vault')!
        .actions.map((action) => action.id),
    ).toEqual(['disconnect'])
    ctx.vault = vault(false)
    const disconnected = (await createOpenCodeMenu(ctx).open(invocation)).menu
    const localCtx = { ...ctx }
    delete localCtx.vault
    const local = (await createOpenCodeMenu(localCtx).open(invocation)).menu
    expect(
      disconnected.sections.filter((section) => section.id !== 'vault'),
    ).toEqual(local.sections.filter((section) => section.id !== 'vault'))
    expect(
      disconnected.sections
        .find((section) => section.id === 'accounts')!
        .actions.map((action) => action.id),
    ).toEqual(['add'])
    expect(
      disconnected.sections
        .find((section) => section.id === 'routing')!
        .actions.map((action) => action.id),
    ).toEqual(['mode', 'order'])
  })
  test('stale local dialog writes in vault mode refuse with a fixed message and byte-identical pool files', async () => {
    const ctx = context(false)
    let connected = false
    const localVault = ctx.vault!
    const remoteVault = vault()
    ctx.vault = new Proxy(localVault, {
      get: (_target, key) =>
        Reflect.get(connected ? remoteVault : localVault, key),
    })
    let logins = 0
    ctx.beginAccountLogin = async () => {
      logins++
      throw new Error('OAuth must not start in vault mode')
    }
    const command = createOpenCodeMenu(ctx)
    expect(
      (await command.open(invocation)).menu.sections[0]!.actions[0]!.id,
    ).toBe('add')
    connected = true
    const before = [files.configFile, files.stateFile].map((file) =>
      readFileSync(file),
    )
    for (const request of [
      { sectionId: 'accounts', actionId: 'add' },
      ...['disable', 'enable', 'move', 'remove'].map((actionId) => ({
        sectionId: 'accounts',
        itemId: 'ufuk',
        actionId,
      })),
      ...['preview', 'spend', 'retry'].map((actionId) => ({
        sectionId: 'reset',
        itemId: 'ufuk',
        actionId,
      })),
      { sectionId: 'limits', itemId: 'ufuk', actionId: 'floors' },
    ]) {
      const result = await command.apply(
        { command: 'openai', confirmed: true, ...request },
        invocation,
      )
      expect(result.ok).toBe(false)
      expect(result.code).toBe('vault-local-action')
      expect(result.text).toBe(
        'Nothing was changed: accounts are managed in the vault with ck. Disconnect to use local accounts.',
      )
      expect(
        [files.configFile, files.stateFile].map((file) => readFileSync(file)),
      ).toEqual(before)
    }
    expect(logins).toBe(0)
  })
  test('disconnected output is byte-identical apart from unlabelled row names', async () => {
    const ctx = context(false)
    const rendered = menuText(
      (await createOpenCodeMenu(ctx).open(invocation)).menu,
    )
    expect(rendered).toBe(`## OpenAI accounts

### Accounts
2 accounts, 2 enabled
- main: OAuth · chatgpt-main
- ufuk: OAuth · chatgpt-ufuk

### Quota
- main: 5h 93% left, resets 2h · checked 3d ago
- ufuk: 5h 15% left, resets 2h

### Routing
Mode: Main first
Roster order: main, ufuk

### Limits
Killswitch off
- main: no floors
- ufuk: no floors

### Cache
Keep-warm unavailable

### Diagnostics
Dumps off
Dump directory: ${getSettings().dumpDir}
Log level: info

### Reset credits
Restore exhausted quota
- Main account
- ufuk

### This session
No current session

### Vault
Not connected
OpenCode (openai-auth-opencode): not connected to the Claustrum vault.

Open the OpenCode TUI to change these settings.`)
  })
  test('unlabelled rows use their ids even without a vault object', async () => {
    const ctx = context(false)
    delete ctx.vault
    const config = readFileSync(files.configFile, 'utf8')
    const state = readFileSync(files.stateFile, 'utf8')
    const menu = (await createOpenCodeMenu(ctx).open(invocation)).menu
    for (const id of ['accounts', 'quota', 'limits']) {
      expect(
        menu.sections.find((section) => section.id === id)?.items[0]?.label,
      ).toBe('main')
    }
    expect(
      menu.sections.find((section) => section.id === 'accounts')?.items[0]
        ?.detail,
    ).toBe('OAuth · chatgpt-main')
    expect(readFileSync(files.configFile, 'utf8')).toBe(config)
    expect(readFileSync(files.stateFile, 'utf8')).toBe(state)
  })
  test('slot ids and order are unchanged when replacements are active', async () => {
    expect((await sections()).map((section) => section.id)).toEqual(
      (await sections(false)).map((section) => section.id),
    )
  })
  test('in vault mode a local row the vault does not hold is neither listed, counted nor offered for a quota check', async () => {
    roster = roster.filter((row) => row.accountIdentity !== 'chatgpt-ufuk')
    const menu = await sections()
    const accounts = menu.find((section) => section.id === 'accounts')!
    expect(accounts.items.map((item) => item.id)).not.toContain('ufuk')
    expect(accounts.lines).toEqual([
      '2 vault accounts',
      '2 can route',
      'Accounts are managed in the vault with ck. Disconnect to use local accounts.',
    ])
    const check = menu
      .find((section) => section.id === 'quota')
      ?.actions.find((action) => action.id === 'check')
    expect(check?.knobs).toEqual([])
    expect(
      menu
        .find((section) => section.id === 'quota')
        ?.items.map((item) => item.id),
    ).toEqual(roster.map((row) => row.routeId))
  })
  test("Check now in vault mode polls each vault account once and never runs the host's local quota check", async () => {
    roster = roster.filter((row) => row.accountIdentity !== 'chatgpt-ufuk')
    const ctx = context()
    let localChecks = 0
    ctx.refreshAllQuota = async () => {
      localChecks++
      return []
    }
    const config = readFileSync(files.configFile, 'utf8')
    const state = readFileSync(files.stateFile, 'utf8')
    const result = await createOpenCodeMenu(ctx).apply(
      {
        command: 'openai',
        sectionId: 'quota',
        actionId: 'check',
        values: { account: '*' },
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(polls).toEqual(roster.map((row) => row.routeId))
    expect(localChecks).toBe(0)
    expect(readFileSync(files.configFile, 'utf8')).toBe(config)
    expect(readFileSync(files.stateFile, 'utf8')).toBe(state)
  })
  test('stale age includes the oldest reading even when another window is fresh', async () => {
    roster[0]!.quota!.limits.push({
      scope: 'all',
      label: 'secondary',
      kind: 'reading',
      usedPercent: 2,
      checkedAt: now,
    })
    const quota = (await sections()).find((section) => section.id === 'quota')!
    expect(
      quota.items.find((item) => item.id === roster[0]!.routeId)?.detail,
    ).toContain('checked 3d ago')
    const reading = roster[0]!.quota!.limits[0]!
    if (reading.kind !== 'reading') throw new Error('fixture has no reading')
    reading.checkedAt = now - 15 * 60_000
    const atBoundary = (await sections()).find(
      (section) => section.id === 'quota',
    )!
    expect(
      atBoundary.items.find((item) => item.id === roster[0]!.routeId)?.detail,
    ).not.toContain('ago')
    reading.checkedAt--
    const older = (await sections()).find((section) => section.id === 'quota')!
    expect(
      older.items.find((item) => item.id === roster[0]!.routeId)?.detail,
    ).toContain('checked 15m ago')
  })
})

test('OpenCode 2 vault read-only projection preserves wave-one data and reset precedence without polling', async () => {
  const ctx = context(true)
  const before = [
    readFileSync(files.configFile, 'utf8'),
    readFileSync(files.stateFile, 'utf8'),
  ]
  const expected = await createOpenCodeMenu(ctx).open({
    ...invocation,
    sessionId: 'session-a',
  })
  let refreshes = 0
  ctx.vault!.refresh = async () => {
    refreshes++
  }
  const menu = createOpenCodeMenu({
    ...ctx,
    readOnly: true,
    unavailableSections: ['cache', 'diagnostics', 'reset'],
  })
  const actual = await menu.open({ ...invocation, sessionId: 'session-a' })
  expect(actual.menu.sections.map((s) => s.id)).toEqual(
    expected.menu.sections.map((s) => s.id),
  )
  for (const section of expected.menu.sections) {
    const got = actual.menu.sections.find((s) => s.id === section.id)!
    if (section.id === 'reset') expect(got).toEqual(section)
    else if (['cache', 'diagnostics'].includes(section.id))
      expect(got).toEqual({
        ...section,
        lines: ['Not available on OpenCode 2 yet.'],
        items: [],
        actions: [],
      })
    else expect(got).toEqual(section)
    const requests = [
      { sectionId: section.id },
      ...section.actions.map((action) => ({
        sectionId: section.id,
        actionId: action.id,
      })),
      ...section.items.flatMap((item) =>
        item.actions.map((action) => ({
          sectionId: section.id,
          itemId: item.id,
          actionId: action.id,
        })),
      ),
    ]
    for (const request of requests)
      expect(
        (
          await menu.apply(
            { command: 'openai', ...request } as CommandApplyRequest,
            invocation,
          )
        ).ok,
      ).toBe(false)
  }
  expect(refreshes).toBe(0)
  expect(polls).toEqual([])
  expect([
    readFileSync(files.configFile, 'utf8'),
    readFileSync(files.stateFile, 'utf8'),
  ]).toEqual(before)
})

describe('prepaid credits in /openai Quota', () => {
  // quotaCreditsText's three wordings, each published on the main account;
  // the other accounts report no credits and show none.
  const cases = [
    {
      credits: { hasCredits: false, unlimited: true, checkedAt: now },
      text: 'Unlimited',
    },
    {
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: 1234.6,
        overageLimitReached: false,
        checkedAt: now,
      },
      text: '1235 credits',
    },
    {
      credits: { hasCredits: true, unlimited: false, checkedAt: now },
      text: 'Available',
    },
  ]

  /** What OpenCode 2's native dialog lists for the Quota section. */
  async function opencode2QuotaOptions(ctx: OpenCodeMenuContext) {
    const payload = await createControlPlaneMenu(ctx).open('S')
    let options: Array<{
      title: string
      description?: string
      footer?: string
    }> = []
    let step = 0
    const dialog = {
      async select(input: { options: typeof options }) {
        step++
        if (step === 1) return 'quota'
        // Step 2 lists the section; leaving it returns to the sections,
        // where step 3 closes the dialog.
        if (step === 2) options = input.options
        return undefined
      },
    } as unknown as Parameters<typeof openControlDialog>[0]
    await openControlDialog(dialog, payload, async () => {
      throw new Error('must not apply')
    })
    return options
  }

  async function surfaces(ctx: OpenCodeMenuContext, name: string) {
    const menu = (await createOpenCodeMenu(ctx).open(invocation)).menu
    const quota = menu.sections.find((section) => section.id === 'quota')!
    return {
      // OpenCode 1's text output and its TUI dialog.
      text: (menuText(menu).split('### Quota\n')[1] ?? '')
        .split('\n###')[0]
        ?.split('\n')
        .find((line) => line.startsWith(`- ${name}: `)),
      dialog: sectionOptions(quota).find((option) => option.title === name)
        ?.description,
      opencode2: (await opencode2QuotaOptions(ctx)).find(
        (option) => option.title === name,
      )?.description,
    }
  }

  test('OpenCode 2 shows each account quota once, as OpenCode 1 does', async () => {
    for (const connected of [false, true]) {
      const ctx = context(connected)
      const menu = (await createOpenCodeMenu(ctx).open(invocation)).menu
      const quota = menu.sections.find((section) => section.id === 'quota')!
      const opencode1 = sectionOptions(quota)
      const opencode2 = await opencode2QuotaOptions(ctx)
      for (const item of quota.items) {
        const native = opencode2.find((option) => option.title === item.label)
        // The full form is the option's text and the compact form its
        // right-hand footer, exactly as OpenCode 1's dialog lists it.
        expect(native).toMatchObject({
          description: item.detail,
          footer: item.status,
        })
        expect(native?.description).toBe(
          opencode1.find((option) => option.title === item.label)?.description,
        )
        // The window figure (`5h 93% left`) appears once, not once per form.
        const figure = item.status?.split(' · ')[0] ?? ''
        expect(figure).toMatch(/^5h \d+% left$/)
        expect(native?.description?.split(figure)).toHaveLength(2)
      }
    }
  })

  test('local accounts show their prepaid credits on OpenCode 1 and OpenCode 2', async () => {
    for (const { credits, text } of cases) {
      const config = readJson(files.configFile) as {
        commonAuthPool: { rows: Record<string, { quota: QuotaMap }> }
      }
      config.commonAuthPool.rows.main!.quota.credits = credits
      writeFileSync(files.configFile, JSON.stringify(config))
      const ctx = context(false)
      const main = await surfaces(ctx, 'main')
      expect(main.text).toBe(
        `- main: 5h 93% left, resets 2h · checked 3d ago · prepaid ${text}`,
      )
      expect(main.dialog).toEndWith(` · prepaid ${text}`)
      expect(main.opencode2).toEndWith(` · prepaid ${text}`)
      const ufuk = await surfaces(ctx, 'ufuk')
      expect(ufuk.text).toBe('- ufuk: 5h 15% left, resets 2h')
      expect(ufuk.dialog).not.toContain('prepaid')
      expect(ufuk.opencode2).not.toContain('prepaid')
    }
  })

  test('vault accounts show their prepaid credits on OpenCode 1 and OpenCode 2', async () => {
    for (const { credits, text } of cases) {
      roster[0]!.quota = { ...roster[0]!.quota!, credits }
      // An account the vault will not serve is a line, not an option.
      roster[2]!.state = 'needs_reauth'
      roster[2]!.quota = { ...roster[2]!.quota!, credits }
      const ctx = context(true)
      const main = await surfaces(ctx, 'vault-user@example.com')
      expect(main.text).toEndWith(` · prepaid ${text}`)
      expect(main.dialog).toEndWith(` · prepaid ${text}`)
      expect(main.opencode2).toEndWith(` · prepaid ${text}`)
      const gmail = await surfaces(ctx, 'gmail')
      expect(gmail.text).not.toContain('prepaid')
      expect(gmail.opencode2).not.toContain('prepaid')
      const quota = (await sections()).find(
        (section) => section.id === 'quota',
      )!
      expect(quota.lines).toEqual([
        `live (needs_reauth): 5h 15% left · prepaid ${text}`,
      ])
    }
  })
})
