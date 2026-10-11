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
  loadAccounts,
  OpenAiVault,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import { createOpenCodeMenu, type OpenCodeMenuContext } from '../commands'
import { createOpenAICacheKeepAdapter } from '../core/cachekeep'
import { openAccountPool } from '../core/pool-accounts'
import { seedPool } from './fixtures/pool-install'

let dir: string
let vault: OpenAiVault
let ctx: OpenCodeMenuContext
const invocation = { notify() {} }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-enrollment-audit-'))
  const files = {
    configFile: join(dir, 'config.json'),
    stateFile: join(dir, 'state.json'),
  }
  seedPool(files, [{ id: 'main' }, { id: 'spare' }])
  vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'vault'),
    pollIntervalMs: 0,
  })
  mkdirSync(join(dir, 'vault'), { mode: 0o700 })
  ctx = {
    accountStoragePath: files.configFile,
    accountStatePath: files.stateFile,
    packageVersion: 'test',
    loadAccounts,
    quotaManager: new QuotaManager({
      configPath: files.configFile,
      storage: null,
    }),
    store: () =>
      openAccountPool({
        configPath: files.configFile,
        statePath: files.stateFile,
      }),
    migration: async () => ({ migrated: true }),
    vault,
    beginAccountLogin: async () => {
      throw new Error('local OAuth must not start')
    },
    refreshAllQuota: async () => {
      throw new Error('local quota must not poll')
    },
    resolveResetTarget: async () => {
      throw new Error('local reset must not resolve')
    },
    refreshResetTargetQuota: async () => {
      throw new Error('local reset must not poll')
    },
    fetchImpl: fetch,
    now: Date.now,
    randomUUID: () => 'test-uuid',
  }
})
afterEach(() => {
  vault.close()
  rmSync(dir, { recursive: true, force: true })
})
function enroll() {
  writeFileSync(
    vault.paths.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
}
function bytes() {
  return [ctx.accountStoragePath, ctx.accountStatePath].map((path) =>
    readFileSync(path),
  )
}

describe('vault enrollment audit', () => {
  test('the synchronous mode guard stays closed until authority reads unchanged enrollment files', async () => {
    expect(vault.enrolled()).toBe(true)
    expect(await vault.authority()).toBe('local')
    expect(vault.enrolled()).toBe(false)
    writeFileSync(vault.paths.statePath, '{broken', { mode: 0o600 })
    expect(vault.enrolled()).toBe(true)
    expect(await vault.authority()).toBe('unreadable')
    expect(vault.enrolled()).toBe(true)
  })
  test('unreadable enrollment hides local dialog actions and refuses stale writes and polls', async () => {
    enroll()
    writeFileSync(vault.paths.statePath, '{broken', { mode: 0o600 })
    const before = bytes()
    const command = createOpenCodeMenu(ctx)
    const menu = (await command.open(invocation)).menu
    for (const id of ['accounts', 'quota', 'limits', 'reset']) {
      const section = menu.sections.find((section) => section.id === id)!
      expect(section.items).toEqual([])
      if (id !== 'limits') expect(section.actions).toEqual([])
    }
    expect(
      menu.sections.find((section) => section.id === 'diagnostics'),
    ).toBeDefined()
    expect(
      menu.sections
        .find((section) => section.id === 'vault')
        ?.actions.map((action) => action.id),
    ).toEqual(['disconnect'])
    for (const request of [
      { sectionId: 'accounts', actionId: 'add' },
      { sectionId: 'accounts', actionId: 'remove', itemId: 'spare' },
      { sectionId: 'quota', actionId: 'check' },
      { sectionId: 'reset', actionId: 'preview', itemId: 'spare' },
    ]) {
      expect(
        (
          await command.apply(
            { command: 'openai', confirmed: true, ...request },
            invocation,
          )
        ).ok,
      ).toBe(false)
    }
    expect(bytes()).toEqual(before)
  })

  test('approved ceremony without a token remains vault-only with Disconnect', async () => {
    writeFileSync(
      vault.paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: vault.name,
        approvedName: vault.name,
        tokenGeneration: 1,
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    )
    const menu = (await createOpenCodeMenu(ctx).open(invocation)).menu
    expect(
      menu.sections.find((section) => section.id === 'accounts')?.items,
    ).toEqual([])
    expect(
      menu.sections
        .find((section) => section.id === 'vault')
        ?.actions.map((action) => action.id),
    ).toEqual(['disconnect'])
  })

  test('an enrolled warm refuses before resolving any local token', async () => {
    enroll()
    let resolutions = 0
    let sends = 0
    const localToken = async () => {
      resolutions++
      return 'local-bearer'
    }
    // Token lookup here has no enrollment check of its own: the warm adapter
    // must refuse before calling it, not just block the eventual network send.
    const adapter = createOpenAICacheKeepAdapter({
      vault,
      codexResponsesUrl: 'https://codex.test/responses',
      fetchImpl: (async () => {
        sends++
        return new Response('{}')
      }) as unknown as typeof fetch,
      getMainToken: localToken,
      refreshFallback: localToken,
    })
    for (const accountId of ['main', 'spare']) {
      await expect(
        adapter.send({
          target: { accountId, meta: { replayHeaders: {} } } as never,
          body: '{}',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('local accounts are not warmed')
    }
    expect(resolutions).toBe(0)
    expect(sends).toBe(0)
  })

  test('enrollment during a local warm token await prevents dispatch', async () => {
    let sends = 0
    const getAuth = async () => {
      enroll()
      return { access: 'local-bearer' }
    }
    const adapter = createOpenAICacheKeepAdapter({
      vault,
      codexResponsesUrl: 'https://codex.test/responses',
      fetchImpl: (async () => {
        sends++
        return new Response('{}')
      }) as unknown as typeof fetch,
      getMainToken: async () => (await getAuth()).access,
      refreshFallback: async () => {
        throw new Error('unexpected fallback')
      },
    })
    await expect(
      adapter.send({
        target: { accountId: 'main', meta: { replayHeaders: {} } } as never,
        body: '{}',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('local accounts are not warmed')
    expect(sends).toBe(0)
  })

  test('a rejected roster refresh renders an error and leaves Disconnect reachable', async () => {
    enroll()
    vault.refresh = async () => {
      throw new Error('roster rejected')
    }
    const menu = (await createOpenCodeMenu(ctx).open(invocation)).menu
    const section = menu.sections.find((section) => section.id === 'vault')!
    expect(section.actions.map((action) => action.id)).toEqual(['disconnect'])
    expect(section.lines.join('\n')).toContain('roster rejected')
  })

  test('a hung roster refresh leaves Disconnect reachable within the roster wait budget', async () => {
    enroll()
    vault.close()
    vault = new OpenAiVault({
      host: 'opencode',
      stateDir: join(dir, 'vault'),
      connectScoped: () => new Promise(() => {}),
    })
    ctx.vault = vault
    const start = Date.now()
    const menu = await Promise.race([
      createOpenCodeMenu(ctx).open(invocation),
      Bun.sleep(3_000).then(() => {
        throw new Error('Disconnect stayed unreachable')
      }),
    ])
    expect(Date.now() - start).toBeLessThan(3_000)
    expect(
      menu.menu.sections
        .find((section) => section.id === 'vault')
        ?.actions.map((action) => action.id),
    ).toEqual(['disconnect'])
  })

  test('vault dialog bypasses an unmigrated local install', async () => {
    enroll()
    writeFileSync(
      ctx.accountStoragePath,
      JSON.stringify({ version: 1, accounts: [] }),
    )
    ctx.migration = async () => ({ migrated: false, blockers: [] })
    const before = bytes()
    const menu = (await createOpenCodeMenu(ctx).open(invocation)).menu
    expect(menu.sections.some((section) => section.id === 'migration')).toBe(
      false,
    )
    expect(
      menu.sections
        .find((section) => section.id === 'vault')
        ?.actions.map((action) => action.id),
    ).toEqual(['disconnect'])
    expect(bytes()).toEqual(before)
  })
})
