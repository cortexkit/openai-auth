import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import type { CommandInvocation } from '@cortexkit/common-auth/commands'
import {
  formatQuota,
  projectQuota,
  type QuotaMap,
} from '@cortexkit/common-auth/quota'
import {
  loadAccounts,
  type OpenAiVault,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import {
  createOpenCodeMenu,
  menuText,
  type OpenCodeMenuContext,
} from '../commands'
import { getSettings } from '../config'
import { openAccountPool } from '../core/pool-accounts'
import { sectionOptions } from '../tui/command-dialogs'
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
        ? 'beatricelau0414@gmail.com'
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
  test('all three packages require the published Pi-slot release', () => {
    for (const name of ['core', 'opencode', 'pi']) {
      const manifest = JSON.parse(
        readFileSync(
          join(import.meta.dir, '../../../..', `packages/${name}/package.json`),
          'utf8',
        ),
      )
      expect(manifest.devDependencies['@cortexkit/common-auth']).toBe('^0.14.0')
    }
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
  test('a reading older than fifteen minutes is never displayed as current', async () => {
    const quota = (await sections()).find((section) => section.id === 'quota')!
    expect(
      quota.items.find((item) => item.id === roster[0]!.routeId)?.detail,
    ).toContain('checked 3d ago')
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
    roster[0]!.state = 'needs_login'
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
      `${roster[0]!.label} (needs_login): ${formatQuota(projectQuota(roster[0]!.quota), { now, form: 'compact' })}`,
      `${roster[1]!.label} (disabled): ${formatQuota(projectQuota(roster[1]!.quota), { now, form: 'compact' })}`,
    ])
  })
  test('quota checks use vault polls and never select set-aside local credentials', async () => {
    const result = await createOpenCodeMenu(context()).apply(
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
    ).toEqual(['mode'])
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
      {
        sectionId: 'routing',
        actionId: 'order',
        values: { order: 'ufuk, main' },
      },
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
