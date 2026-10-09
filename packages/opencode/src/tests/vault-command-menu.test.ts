import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import type { CommandInvocation } from '@cortexkit/common-auth/commands'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
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
import { quotaMap, readJson, seedPool } from './fixtures/pool-install'

const now = Date.UTC(2026, 9, 9, 16, 9)
const invocation: CommandInvocation = { notify() {} }
let dir: string
let files: { configFile: string; stateFile: string }
let polls: string[]
let roster: VaultRosterRow[]

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
  test('all three packages require the published replacement-slot release', () => {
    for (const name of ['core', 'opencode', 'pi']) {
      const manifest = JSON.parse(
        readFileSync(
          join(import.meta.dir, '../../../..', `packages/${name}/package.json`),
          'utf8',
        ),
      )
      expect(manifest.devDependencies['@cortexkit/common-auth']).toBe('^0.11.7')
    }
  })
  test('accounts name the vault owner and exclude set-aside locals from routing count', async () => {
    const accounts = (await sections()).find(
      (section) => section.id === 'accounts',
    )!
    expect(accounts.lines.join('\n')).toContain(
      '3 account(s) can route, 2 local row(s) set aside.',
    )
    expect(accounts.items.map((item) => item.id)).toEqual([
      'main',
      'ufuk',
      ...roster.map((row) => row.routeId),
    ])
    expect(accounts.items.find((item) => item.id === 'main')?.detail).toContain(
      'set aside (served by vault beatricelau0414@gmail.com)',
    )
    expect(
      accounts.items.find((item) => item.id === roster[2]!.routeId)?.detail,
    ).toContain('active · enabled')
  })
  test('quota lists the same accounts and dates stale readings in both sections', async () => {
    const menu = await sections()
    const accounts = menu.find((section) => section.id === 'accounts')!
    const quota = menu.find((section) => section.id === 'quota')!
    expect(quota.items.map((item) => item.id)).toEqual([
      'main',
      'ufuk',
      ...roster.map((row) => row.routeId),
    ])
    for (const section of [accounts, quota]) {
      expect(
        section.items.find((item) => item.id === 'main')?.detail,
      ).toContain('quota read 3d ago')
      expect(
        section.items.find((item) => item.id === roster[0]!.routeId)?.detail,
      ).toContain('quota read 3d ago')
      expect(
        section.items.find((item) => item.id === 'ufuk')?.detail,
      ).not.toContain('ago')
    }
  })
  test('a reading older than fifteen minutes is never displayed as current', async () => {
    const quota = (await sections()).find((section) => section.id === 'quota')!
    expect(quota.items.find((item) => item.id === 'main')?.detail).toContain(
      'quota read 3d ago',
    )
  })
  test('an unlabelled local is named by its roster id when connected', async () => {
    expect(
      (await sections()).find((section) => section.id === 'accounts')?.items[0]
        ?.label,
    ).toBe('main')
  })
  test('cold and declined vault accounts still shadow locals but are not counted', async () => {
    roster[0]!.state = 'needs_login'
    roster[1]!.enabled = false
    const accounts = (await sections()).find(
      (section) => section.id === 'accounts',
    )!
    expect(accounts.lines.join('\n')).toContain(
      '1 account(s) can route, 2 local row(s) set aside.',
    )
    expect(accounts.items.find((item) => item.id === 'ufuk')?.detail).toContain(
      'served by vault gmail',
    )
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
        ?.items.find((item) => item.id === roster[0]!.routeId)?.detail,
    ).toBe('floors: primary 25%, secondary 10%')
    expect(readFileSync(files.stateFile, 'utf8')).toBe(before)
  })
  test('reset labels set-aside locals without admitting vault accounts', async () => {
    const reset = (await sections()).find((section) => section.id === 'reset')!
    expect(reset.items.map((item) => item.id)).toEqual(['main', 'ufuk'])
    expect(reset.items[0]?.label).toContain(
      'set aside (served by vault beatricelau0414@gmail.com)',
    )
  })
  test('disconnected output is byte-identical to the local-only menu', async () => {
    const ctx = context(false)
    const rendered = menuText(
      (await createOpenCodeMenu(ctx).open(invocation)).menu,
    )
    expect(rendered).toBe(`## OpenAI accounts

### Accounts
2 account(s), 2 enabled.
- chatgpt-main: OAuth · enabled · chatgpt-main · primary 93% left
- ufuk: OAuth · enabled · chatgpt-ufuk · primary 15% left

### Quota
Scope: all.
- chatgpt-main: primary 93% left
- ufuk: primary 15% left

### Routing
Mode: Main first.
Roster order: main, ufuk.

### Limits
Killswitch: off.
With the killswitch on, an account whose quota falls below one of its floors is not used.
- chatgpt-main: no floors
- ufuk: no floors

### Cache
Cache keep-warm is not available in this process.

### Diagnostics
Request dumps: off, written to ${getSettings().dumpDir}.
Log level: info.

### Reset credits
A reset credit restores an exhausted account's quota. Preview fetches the account's current quota and credits.
- Main account
- ufuk

### This session
No current session.

### Vault
OpenCode (openai-auth-opencode): not connected to the Claustrum vault.

Open the OpenCode TUI to change these settings.`)
  })
  test('slot ids and order are unchanged when replacements are active', async () => {
    expect((await sections()).map((section) => section.id)).toEqual(
      (await sections(false)).map((section) => section.id),
    )
  })
  test('an unshadowed local keeps its management actions and counts beside vault accounts', async () => {
    roster = roster.filter((row) => row.accountIdentity !== 'chatgpt-ufuk')
    const accounts = (await sections()).find(
      (section) => section.id === 'accounts',
    )!
    const local = accounts.items.find((item) => item.id === 'ufuk')!
    expect(accounts.lines).toEqual([
      '3 account(s) can route, 1 local row(s) set aside.',
    ])
    expect(local.label).toBe('ufuk')
    expect(local.detail).toBe(
      'OAuth · enabled · chatgpt-ufuk · primary 15% left',
    )
    expect(local.actions.map((action) => action.id)).toEqual([
      'disable',
      'move',
      'remove',
    ])
    const result = await createOpenCodeMenu(context()).apply(
      {
        command: 'openai',
        sectionId: 'accounts',
        itemId: 'ufuk',
        actionId: 'move',
        values: { position: '1' },
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(
      (readJson(files.configFile).accounts as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    ).toEqual(['ufuk', 'main'])
  })
  test('a host-wide check polls each vault account only once beside unshadowed locals', async () => {
    roster = roster.filter((row) => row.accountIdentity !== 'chatgpt-ufuk')
    const ctx = context()
    ctx.refreshAllQuota = async () => {
      for (const row of roster) await ctx.vault!.pollQuota(row.routeId)
      return []
    }
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
    ).toContain('quota read 3d ago')
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
    ).toContain('quota read 15m ago')
  })
})
