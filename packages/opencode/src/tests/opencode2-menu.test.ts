import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandApplyRequest } from '@cortexkit/common-auth/commands'
import type { PoolStore } from '@cortexkit/common-auth/store'
import { migrationNoticeMenu, scrubKnobs } from '@cortexkit/openai-auth-core'
import {
  loadAccounts,
  OpenAiVault,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import { createOpenCodeMenu, type OpenCodeMenuContext } from '../commands'
import { openAccountPool } from '../core/pool-accounts'
import { poolFiles, seedPool } from './fixtures/opencode2-host'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture(empty = false) {
  const root = mkdtempSync(join(tmpdir(), 'oc2-menu-'))
  roots.push(root)
  const files = poolFiles(root)
  seedPool(files, 'main-first', empty ? [] : [{ id: 'main' }, { id: 'alpha' }])
  const writes: string[] = []
  const store = openAccountPool(files.paths())
  const guarded = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (
          [
            'add',
            'replace',
            'remove',
            'enable',
            'reorder',
            'updateSettings',
            'requestReading',
            'initialize',
            'recordQuota',
          ].includes(String(key))
        )
          writes.push(String(key))
        return value.apply(target, args)
      }
    },
  }) as PoolStore
  const forbidden = () => {
    throw new Error('unexpected login or fetch')
  }
  const context: OpenCodeMenuContext = {
    accountStoragePath: files.configPath,
    accountStatePath: files.statePath,
    packageVersion: 'test',
    quotaManager: new QuotaManager({
      configPath: files.configPath,
      storage: null,
    }),
    loadAccounts,
    store: () => guarded,
    migration: async () => ({ migrated: true }),
    beginAccountLogin: forbidden,
    refreshAllQuota: forbidden,
    getStickyRouting: async () => 'alpha',
    clearStickyRouting: forbidden,
    resolveResetTarget: forbidden,
    refreshResetTargetQuota: forbidden,
    fetchImpl: Object.assign(forbidden, { preconnect() {} }),
    now: () => 1_800_000_000_000,
    randomUUID: () => 'unused',
    vault: new OpenAiVault({
      host: 'opencode',
      stateDir: join(root, 'vault'),
      pollIntervalMs: 0,
    }),
  }
  const bytes = () => [
    readFileSync(files.configPath, 'utf8'),
    readFileSync(files.statePath, 'utf8'),
  ]
  const menu = () =>
    createOpenCodeMenu({
      ...context,
      readOnly: true,
      unavailableSections: ['cache', 'diagnostics', 'reset'],
    })
  return { files, context, writes, bytes, menu }
}

const invocation = { sessionId: 'session-a', notify() {} }

for (const empty of [false, true]) {
  test(`OpenCode 2 read-only menu matches OpenCode 1 wave-one sections (${empty ? 'empty' : 'local'})`, async () => {
    const f = fixture(empty)
    const before = f.bytes()
    const expected = await createOpenCodeMenu(f.context).open(invocation)
    const actual = await f.menu().open(invocation)
    const credentialFields: string[] = []
    expect(scrubKnobs(actual, 'payload', credentialFields)).toEqual(actual)
    expect(credentialFields).toEqual([])
    expect(JSON.stringify(actual)).not.toContain('main-token')
    expect(JSON.stringify(actual)).not.toContain('alpha-refresh')
    expect(actual.menu.sections.map((s) => s.id)).toEqual(
      expected.menu.sections.map((s) => s.id),
    )
    for (const section of expected.menu.sections) {
      const got = actual.menu.sections.find((s) => s.id === section.id)
      if (['cache', 'diagnostics', 'reset'].includes(section.id)) {
        expect(got).toEqual({
          ...section,
          lines: ['Not available on OpenCode 2 yet.'],
          items: [],
          actions: [],
        })
      } else expect(got).toEqual(section)
    }
    expect(f.writes).toEqual([])
    expect(f.bytes()).toEqual(before)
  })
}

test('OpenCode 2 read-only applies refuse every exposed action and later-wave section ids', async () => {
  const f = fixture()
  const before = f.bytes()
  const payload = await createOpenCodeMenu(f.context).open(invocation)
  const requests = payload.menu.sections.flatMap((section) => [
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
  ])
  for (const sectionId of ['cache', 'diagnostics', 'reset']) {
    requests.push({ sectionId, actionId: 'unknown' })
    requests.push({ sectionId, actionId: undefined as unknown as string })
  }
  expect(requests.length).toBeGreaterThan(20)
  for (const request of requests) {
    const result = await f
      .menu()
      .apply({ command: 'openai', ...request }, invocation)
    expect(result.ok).toBe(false)
  }
  expect(f.writes).toEqual([])
  expect(f.bytes()).toEqual(before)
})

test('OpenCode 2 unmigrated menu and apply retain the exact migration notice and bytes', async () => {
  const f = fixture()
  writeFileSync(
    f.files.configPath,
    JSON.stringify({ version: 1, accounts: [] }),
  )
  const blockers = [{ pid: 42, version: 'old' }]
  f.context.migration = async () => ({ migrated: false, blockers })
  const before = f.bytes()
  const expected = { command: 'openai', menu: migrationNoticeMenu(blockers) }
  expect(await f.menu().open(invocation)).toEqual(expected)
  const result = await f
    .menu()
    .apply(
      { command: 'openai', sectionId: 'accounts', actionId: 'add' },
      invocation,
    )
  expect(result).toEqual({
    ...expected,
    ok: false,
    text: 'Nothing was changed: the accounts have not moved to the new layout yet.',
  })
  expect(f.writes).toEqual([])
  expect(f.bytes()).toEqual(before)
})

test('OpenCode 2 knob scrubbing removes credential-shaped fields recursively', () => {
  const found: string[] = []
  expect(
    scrubKnobs(
      {
        label: 'safe',
        accessToken: 'secret',
        nested: [
          {
            refresh_token: 'secret',
            credential: { access: 'secret' },
            headless: true,
          },
        ],
      },
      'knob',
      found,
    ),
  ).toEqual({ label: 'safe', nested: [{ headless: true }] })
  expect(found.length).toBeGreaterThan(0)
})

test('OpenCode 2 unavailable sections refuse section-only applies even without the read-only gate', async () => {
  const f = fixture()
  const before = f.bytes()
  const menu = createOpenCodeMenu({
    ...f.context,
    unavailableSections: ['cache', 'diagnostics', 'reset'],
  })
  const capable = await createOpenCodeMenu(f.context).open(invocation)
  for (const section of capable.menu.sections.filter((s) =>
    ['cache', 'diagnostics', 'reset'].includes(s.id),
  )) {
    const actions = [
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
    for (const request of actions) {
      const result = await menu.apply(
        { command: 'openai', ...request },
        invocation,
      )
      expect(result.ok).toBe(false)
      expect(result.code).toBe('unavailable')
    }
  }
  for (const sectionId of ['cache', 'diagnostics', 'reset']) {
    for (const actionId of [undefined, 'preview', 'enable', 'dump']) {
      const result = await menu.apply(
        {
          command: 'openai',
          sectionId,
          ...(actionId === undefined ? {} : { actionId }),
        } as CommandApplyRequest,
        invocation,
      )
      expect(result.ok).toBe(false)
      expect(result.code).toBe('unavailable')
    }
  }
  expect(f.writes).toEqual([])
  expect(f.bytes()).toEqual(before)
})
