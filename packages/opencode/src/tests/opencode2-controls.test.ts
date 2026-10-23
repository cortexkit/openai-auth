import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandApplyRequest } from '@cortexkit/common-auth/commands'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { PoolStore } from '@cortexkit/common-auth/store'
import {
  type IngestAccount,
  loadAccounts,
  type OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import { createOpenCodeMenu, type OpenCodeMenuContext } from '../commands'
import { refreshSettings, resetSettingsForTest } from '../config'
import { openAccountPool } from '../core/pool-accounts'
import { setLogLevel } from '../logger'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { createControlPlaneMenu } from '../v2/menu'
import { setupOpenAIAuth } from '../v2/setup'
import { acquireSessionPins } from '../v2/shared-pins'
import {
  fakeOpenCode2Host,
  poolFiles,
  quotaMap,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { restoreEnv, unsetEnv } from './setup-env'

const roots: string[] = []
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  resetNotificationsForTest()
  setLogLevel(undefined)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture(enrolled = false) {
  const root = mkdtempSync(join(tmpdir(), 'oc2-controls-'))
  roots.push(root)
  const files = poolFiles(root)
  seedPool(files, 'main-first', [
    { id: 'main' },
    { id: 'alpha' },
    { id: 'beta' },
  ])
  const writes: string[] = []
  const effects = {
    logins: [] as unknown[],
    polls: [] as string[],
    orders: [] as string[][],
    enrollments: 0,
  }
  let finish!: (account: IngestAccount) => void
  let fail!: (error: Error) => void
  let connected = enrolled
  const store = openAccountPool(files.paths(), {
    pull: async () => {
      effects.polls.push('local')
      return {
        limits: [
          {
            scope: 'all',
            label: 'primary',
            kind: 'reading',
            checkedAt: 1_800_000_000_000,
            usedPercent: 20,
          },
        ],
      }
    },
  })
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
            'disable',
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
  const roster = ['alpha', 'beta'].map((id) => ({
    routeId: `vault:${id}`,
    credentialId: `chatgpt:${id}`,
    credentialType: 'oauth',
    accountIdentity: `chatgpt-${id}`,
    state: 'active',
    enabled: true,
    addedAt: 1,
    quota: quotaMap(10),
  }))
  const vault = {
    authority: async () => (connected ? 'vault' : 'local'),
    status: async () => ({
      host: 'opencode',
      name: 'openai-auth-opencode',
      enrollment: connected ? { state: 'approved' } : { state: 'idle' },
      accounts: connected ? roster : [],
    }),
    identities: () =>
      new Set(connected ? roster.map((row) => row.accountIdentity) : []),
    routes: () =>
      connected
        ? roster.map((row) => ({
            id: row.routeId,
            kind: 'oauth',
            quota: row.quota,
          }))
        : [],
    snapshot: () => ({
      version: 1,
      complete: true,
      rows: connected ? roster : [],
      declined: [],
    }),
    refresh: async () => {},
    reorder: async (ids: readonly string[]) => {
      effects.orders.push([...ids])
      return { ids, outcome: 'reordered' as const }
    },
    connectStep: async () => {
      effects.enrollments++
      throw new Error('unexpected enrollment')
    },
    disconnect: async () => {
      effects.enrollments++
    },
    decline: async () => {
      effects.enrollments++
    },
    accept: async () => {
      effects.enrollments++
    },
    pollQuota: async (id: string) => {
      effects.polls.push(id)
      return { ok: true }
    },
  } as unknown as OpenAiVault
  const context: OpenCodeMenuContext = {
    accountStoragePath: files.configPath,
    accountStatePath: files.statePath,
    packageVersion: 'test',
    loadAccounts,
    store: () => guarded,
    migration: async () => ({ migrated: true }),
    vault,
    beginAccountLogin: async (options) => {
      effects.logins.push(options)
      return {
        url: 'https://auth.example/login',
        instructions: 'Sign in.',
        completion: new Promise<IngestAccount>((resolve, reject) => {
          finish = resolve
          fail = reject
        }),
      }
    },
    refreshAllQuota: async () => {
      effects.polls.push('all')
      return []
    },
    getStickyRouting: async () => 'alpha',
    clearStickyRouting: async () => true,
    now: () => 1_800_000_000_000,
  }
  const bytes = () => [
    readFileSync(files.configPath, 'utf8'),
    readFileSync(files.statePath, 'utf8'),
  ]
  return {
    files,
    context,
    writes,
    effects,
    bytes,
    menu: () => createControlPlaneMenu(context),
    enroll: (value: boolean) => {
      connected = value
    },
    finish: (account = completedAccount()) => finish(account),
    fail: (error = new Error('secret-access secret-refresh')) => fail(error),
  }
}

function completedAccount(): IngestAccount {
  return {
    id: 'new',
    type: 'oauth',
    access: 'secret-access',
    refresh: 'secret-refresh',
    enabled: true,
    addedAt: 1,
    lastUsed: 1,
    accountId: 'chatgpt-new',
  }
}
const invocation = { sessionId: 'S', notify() {} }
const rows = [
  {
    name: 'disable',
    sectionId: 'accounts',
    actionId: 'disable',
    itemId: 'alpha',
  },
  {
    name: 'enable',
    sectionId: 'accounts',
    actionId: 'enable',
    itemId: 'alpha',
  },
  {
    name: 'remove',
    sectionId: 'accounts',
    actionId: 'remove',
    itemId: 'alpha',
    confirmed: true,
  },
  {
    name: 'browser add',
    sectionId: 'accounts',
    actionId: 'add',
    values: { headless: false },
  },
  {
    name: 'headless add',
    sectionId: 'accounts',
    actionId: 'add',
    values: { headless: true },
  },
  {
    name: 'move',
    sectionId: 'accounts',
    actionId: 'move',
    itemId: 'alpha',
    values: { position: '1' },
  },
  {
    name: 'order',
    sectionId: 'routing',
    actionId: 'order',
    values: { order: 'beta, alpha, main' },
  },
  {
    name: 'mode',
    sectionId: 'routing',
    actionId: 'mode',
    values: { mode: 'fallback-first' },
  },
  {
    name: 'quota item',
    sectionId: 'quota',
    actionId: 'check',
    itemId: 'alpha',
  },
  { name: 'quota all', sectionId: 'quota', actionId: 'check' },
  {
    name: 'floors',
    sectionId: 'limits',
    actionId: 'floors',
    itemId: 'alpha',
    values: { primary: 25, secondary: 10 },
  },
  {
    name: 'killswitch',
    sectionId: 'limits',
    actionId: 'killswitch',
    values: { enabled: true },
  },
  { name: 'clear-pin', sectionId: 'session', actionId: 'clear-pin' },
  {
    name: 'logging',
    sectionId: 'diagnostics',
    actionId: 'logging',
    values: { level: 'debug' },
  },
  {
    name: 'dump',
    sectionId: 'diagnostics',
    actionId: 'dump',
    values: { enabled: true },
  },
] as const

for (const enrolled of [false, true]) {
  for (const row of rows) {
    test(`OpenCode 2 controls matrix ${enrolled ? 'vault' : 'local'} ${row.name}`, async () => {
      const actual = fixture(enrolled)
      const oracle = fixture(enrolled)
      writeFileSync(oracle.files.configPath, actual.bytes()[0]!)
      writeFileSync(oracle.files.statePath, actual.bytes()[1]!)
      if (row.name === 'enable') {
        for (const f of [actual, oracle])
          await f.context.store().disable('alpha', 'fixture')
      }
      actual.writes.length = oracle.writes.length = 0
      const request: CommandApplyRequest = {
        command: 'openai',
        ...row,
        ...('itemId' in row &&
        enrolled &&
        ['quota', 'limits'].includes(row.sectionId)
          ? { itemId: 'vault:alpha' }
          : {}),
        ...(enrolled && row.name === 'order'
          ? { values: { order: 'vault:beta, vault:alpha' } }
          : {}),
      }
      const expected = await createOpenCodeMenu(oracle.context).apply(
        request,
        invocation,
      )
      const got = await actual.menu().apply({ ...request, sessionId: 'S' })
      expect({ ok: got.ok, code: got.code, text: got.text }).toEqual({
        ok: expected.ok,
        code: expected.code,
        text: expected.text,
      })
      expect(actual.bytes()).toEqual(oracle.bytes())
      expect(actual.writes).toEqual(oracle.writes)
      expect(actual.effects).toEqual(oracle.effects)
      if (row.name === 'quota item')
        expect(actual.effects.polls).toEqual(
          enrolled ? ['vault:alpha'] : ['local'],
        )
      if (row.name === 'quota all')
        expect(actual.effects.polls).toEqual(
          enrolled ? ['vault:alpha', 'vault:beta'] : ['all'],
        )
      if (
        !enrolled ||
        ['quota', 'limits', 'session', 'diagnostics'].includes(row.sectionId) ||
        row.name === 'mode' ||
        row.name === 'order'
      )
        expect(got.ok).toBe(true)
      else expect(got.code).toBe('vault-local-action')
    })
  }
}

for (const id of ['main', 'pending', 'missing', '../invalid']) {
  test(`OpenCode 2 removal refuses ${id}`, async () => {
    const f = fixture()
    let itemId = id
    if (id === 'pending') {
      itemId = 'alpha'
      const config = JSON.parse(readFileSync(f.files.configPath, 'utf8'))
      config.openaiAuthPool.pending = {
        rowId: 'alpha',
        operation: 'rotate',
        rowFingerprint: null,
        slotFingerprint: 'slot',
        credentialFingerprint: 'credential',
        carryLegacyMain: false,
        recordedAt: 1,
      }
      writeFileSync(f.files.configPath, JSON.stringify(config))
    }
    const before = f.bytes()
    const result = await f.menu().apply({
      command: 'openai',
      sectionId: 'accounts',
      actionId: 'remove',
      itemId,
      confirmed: true,
    })
    expect(result.ok).toBe(false)
    expect(f.bytes()).toEqual(before)
  })
}

test('OpenCode 2 removal requires confirmation and stale ids refuse', async () => {
  const f = fixture()
  const menu = f.menu()
  await menu.open('S')
  const before = f.bytes()
  const request = {
    command: 'openai',
    sectionId: 'accounts',
    actionId: 'remove',
    itemId: 'alpha',
  }
  expect(await menu.apply(request)).toMatchObject({
    ok: false,
    code: 'needs-confirmation',
  })
  expect(f.bytes()).toEqual(before)
  expect(f.writes).toEqual([])
  expect((await menu.apply({ ...request, confirmed: true })).ok).toBe(true)
  const removed = f.bytes()
  f.writes.length = 0
  expect((await menu.apply({ ...request, confirmed: true })).ok).toBe(false)
  expect(f.writes).toEqual([])
  expect(f.bytes()).toEqual(removed)
})

test('OpenCode 2 stale authority refuses captured local action and resumes after unenroll', async () => {
  const f = fixture()
  const menu = f.menu()
  await menu.open('S')
  const before = f.bytes()
  const request = {
    command: 'openai',
    sectionId: 'accounts',
    itemId: 'alpha',
    actionId: 'disable',
  }
  f.enroll(true)
  expect(await menu.apply(request)).toMatchObject({
    ok: false,
    code: 'vault-local-action',
  })
  expect(f.writes).toEqual([])
  expect(f.bytes()).toEqual(before)
  f.enroll(false)
  expect((await menu.apply(request)).ok).toBe(true)
  expect(f.bytes()).not.toEqual(before)
})

async function notification(session = 'S') {
  // The login's store write is asynchronous; the notification is its completion signal.
  for (let i = 0; i < 100; i++) {
    const messages = drainNotifications(0, session)
    if (messages.length) return messages[0]!.payload
    await Bun.sleep(10)
  }
  throw new Error('login did not notify')
}

for (const ending of [
  'close',
  'reload',
  'switch',
  'main',
  'failure',
  'cancel',
  'enroll',
] as const) {
  test(`OpenCode 2 menu login completion ${ending}`, async () => {
    const f = fixture()
    let menu = f.menu()
    const before = f.bytes()
    expect(
      (
        await menu.apply({
          command: 'openai',
          sectionId: 'accounts',
          actionId: 'add',
          sessionId: 'S',
          values: { headless: true, label: 'Work' },
        })
      ).ok,
    ).toBe(true)
    expect(f.bytes()).toEqual(before)
    expect(f.writes).toEqual([])
    expect(f.effects.logins).toEqual([
      { headless: true, label: 'Work', version: 'test' },
    ])
    if (ending === 'reload') menu = f.menu()
    if (ending === 'switch') await menu.open('T')
    if (ending === 'enroll') f.enroll(true)
    if (ending === 'failure') f.fail()
    else if (ending === 'cancel') f.fail(new Error('Login cancelled'))
    else
      f.finish({
        ...completedAccount(),
        ...(ending === 'main' ? { accountId: 'chatgpt-main' } : {}),
      })
    const message = await notification()
    expect(drainNotifications(0, 'T')).toEqual([])
    expect(JSON.stringify(message)).not.toContain('secret-access')
    expect(JSON.stringify(message)).not.toContain('secret-refresh')
    if (['main', 'failure', 'cancel', 'enroll'].includes(ending)) {
      expect(f.writes).toEqual([])
      expect(f.bytes()).toEqual(before)
      if (ending === 'main' || ending === 'enroll')
        expect(message).toEqual({
          command: 'openai',
          notify: {
            message:
              ending === 'main'
                ? 'Adding the account failed: that account is already your main account, so it was not added again'
                : 'Adding the account failed: Nothing was changed: accounts are managed in the vault with ck. Disconnect to use local accounts.',
            kind: 'error',
          },
        })
    } else {
      expect(f.writes).toEqual(['add'])
      expect(f.files.readConfig().accounts.map((row) => row.id)).toEqual([
        'main',
        'alpha',
        'beta',
        'new',
      ])
    }
  })
}

for (const enrolled of [false, true]) {
  test(`OpenCode 2 rejects all non-control engine rows in ${enrolled ? 'vault' : 'local'} mode`, async () => {
    const f = fixture(enrolled)
    const capable = await createOpenCodeMenu(f.context).open(invocation)
    const permitted = new Set(
      rows.map(
        (row) =>
          `${row.sectionId}:${row.actionId}:${'itemId' in row ? 'item' : 'section'}`,
      ),
    )
    const requests = capable.menu.sections
      .flatMap((section) => [
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
      .filter(
        (request) =>
          !permitted.has(
            `${request.sectionId}:${request.actionId}:${'itemId' in request ? 'item' : 'section'}`,
          ),
      )
    requests.push(
      { sectionId: 'vault', actionId: 'connect' },
      { sectionId: 'vault', actionId: 'disconnect' },
      ...['enable', 'disable'].map((actionId) => ({
        sectionId: 'vault',
        itemId: 'vault:alpha',
        actionId,
      })),
      ...['cache', 'diagnostics', 'reset'].flatMap((sectionId) =>
        [
          'unknown',
          'preview',
          'redeem',
          'dump',
          'logging',
          'enable',
          'subagents',
          'sustain',
          'window',
          'primary',
          'secondary',
        ]
          .filter(
            (actionId) =>
              (sectionId !== 'diagnostics' ||
                !['logging', 'dump'].includes(actionId)) &&
              (sectionId !== 'cache' ||
                !['enabled', 'subagents', 'sustain', 'window'].includes(
                  actionId,
                )),
          )
          .map((actionId) => ({ sectionId, actionId })),
      ),
      { sectionId: 'accounts', actionId: 'future-action' },
      { sectionId: 'future-section', actionId: 'enable' },
    )
    const before = f.bytes()
    expect(requests.length).toBeGreaterThan(30)
    for (const request of requests) {
      const result = await f.menu().apply({
        command: 'openai',
        ...request,
        confirmed: true,
        values: { enabled: true, token: 'secret-access' },
      })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('secret-access')
    }
    expect(f.writes).toEqual([])
    expect(f.effects).toEqual({
      logins: [],
      polls: [],
      orders: [],
      enrollments: 0,
    })
    expect(f.bytes()).toEqual(before)
  })
}

for (const enrolled of [false, true]) {
  test(`OpenCode 2 diagnostics exposes the shared log controls in ${enrolled ? 'vault' : 'local'} mode`, async () => {
    const f = fixture(enrolled)
    const expected = await createOpenCodeMenu(f.context).open(invocation)
    const actual = await f.menu().open('S')
    const diagnostics = actual.menu.sections.find((s) => s.id === 'diagnostics')
    expect(diagnostics).toEqual(
      expected.menu.sections.find((s) => s.id === 'diagnostics'),
    )
    expect(diagnostics?.actions.map((action) => action.id)).toEqual([
      'dump',
      'logging',
    ])
  })
}

test('OpenCode 2 diagnostics refuses item actions and request dumps', async () => {
  const f = fixture()
  const before = f.bytes()
  for (const actionId of ['logging', 'dump', 'unknown']) {
    for (const itemId of [undefined, '', 'main', 'missing']) {
      if (['logging', 'dump'].includes(actionId) && itemId === undefined)
        continue
      const result = await f.menu().apply({
        sectionId: 'diagnostics',
        actionId,
        ...(itemId !== undefined ? { itemId } : {}),
        values: { level: 'trace', enabled: true },
        confirmed: true,
      })
      expect(result.ok).toBe(false)
      expect(result.text).toBe('Not available on OpenCode 2 yet.')
    }
  }
  expect(f.writes).toEqual([])
  expect(f.bytes()).toEqual(before)
})

test('OpenCode 2 dump toggle persists and displays its warning in local and vault menus', async () => {
  const previous = process.env.OPENCODE_OPENAI_AUTH_FILE
  const dump = process.env.CORTEXKIT_OPENAI_AUTH_DUMP
  unsetEnv('CORTEXKIT_OPENAI_AUTH_DUMP')
  try {
    for (const enrolled of [false, true]) {
      const f = fixture(enrolled)
      process.env.OPENCODE_OPENAI_AUTH_FILE = f.files.configPath
      resetSettingsForTest()
      const on = await f.menu().apply({
        sectionId: 'diagnostics',
        actionId: 'dump',
        values: { enabled: true },
      })
      expect(on.ok).toBe(true)
      expect(on.text).toContain(
        'Body dumps may contain prompt and session content. Turn this off after debugging.',
      )
      expect(refreshSettings().dump).toBe(true)
      expect(
        JSON.parse(readFileSync(f.files.configPath, 'utf8')).dump.enabled,
      ).toBe(true)
      const opened = await f.menu().open('S')
      expect(
        opened.menu.sections
          .find((section) => section.id === 'diagnostics')
          ?.actions.find((action) => action.id === 'dump')?.label,
      ).toBe('Turn request dumps off')
      const off = await f.menu().apply({
        sectionId: 'diagnostics',
        actionId: 'dump',
        values: { enabled: false },
      })
      expect(off.ok).toBe(true)
      expect(off.text).toBe('Request dumps are off.')
      expect(refreshSettings().dump).toBe(false)
    }
  } finally {
    restoreEnv('OPENCODE_OPENAI_AUTH_FILE', previous)
    restoreEnv('CORTEXKIT_OPENAI_AUTH_DUMP', dump)
    resetSettingsForTest()
  }
})

async function setupLocation(f: ReturnType<typeof fixture>, directory: string) {
  const host = fakeOpenCode2Host({ directory })
  const dispose = await setupOpenAIAuth(host.ctx, {
    paths: f.files.paths,
    sidebarStateFile: join(f.files.dir, 'sidebar.json'),
    heartbeat: false,
    poolMigration: false,
    beginLogin: f.context.beginAccountLogin,
    fetch: Object.assign(
      async () => {
        throw new Error('offline')
      },
      { preconnect() {} },
    ),
    vault: { stateDir: join(f.files.dir, 'vault'), pollIntervalMs: 0 },
  })
  cleanups.push(dispose)
  const client = createRpcClient(
    (await resolveRpcDir(directory)).dir,
    process.pid,
  )
  return { host, client, dispose }
}

test('OpenCode 2 two locations share menu pins and live routing settings', async () => {
  const f = fixture()
  const a = await setupLocation(f, join(f.files.dir, 'A'))
  const b = await setupLocation(f, join(f.files.dir, 'B'))
  expect(a.host.commands[0]).toBe(b.host.commands[0])
  const route = async (host: typeof a.host, sessionID: string) => {
    const draft = await host.fire('http.request', {
      ...scope(sessionID),
      request: new Request('http://codex.test/v1/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer api-key' },
        body: '{}',
      }),
    })
    return draft.request.headers.get('authorization')
  }
  // The request hooks replace only the plugin's non-secret marker with an account token.
  const placeholder = placeholderSecret('openai')
  const headers = async (host: typeof a.host, sessionID: string) => {
    await host.fire('model.request', {
      ...scope(sessionID),
      headers: { authorization: `Bearer ${placeholder}` },
    })
    const draft = await host.fire('http.request', {
      ...scope(sessionID),
      request: new Request('http://codex.test/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${placeholder}` },
        body: '{}',
      }),
    })
    return draft.request.headers.get('authorization')
  }
  const pins = acquireSessionPins(f.files.paths())
  expect(await headers(a.host, 'S')).toBe('Bearer main-token')
  const apply = (
    client: typeof a.client,
    request: Omit<CommandApplyRequest, 'command'>,
  ) => client.apply({ command: 'openai', ...request })
  expect(
    (
      await apply(a.client, {
        sectionId: 'routing',
        actionId: 'mode',
        values: { mode: 'sticky-balanced' },
      })
    ).ok,
  ).toBe(true)
  await headers(a.host, 'S')
  await headers(b.host, 'T')
  const t = pins.get('T')
  expect(pins.get('S')).toBeDefined()
  expect(t).toBeDefined()
  expect(
    (
      await apply(b.client, {
        sectionId: 'session',
        actionId: 'clear-pin',
        sessionId: 'S',
      })
    ).ok,
  ).toBe(true)
  expect(pins.get('S')).toBeUndefined()
  expect(pins.get('T')).toBe(t)
  await headers(b.host, 'S')
  expect(pins.get('S')).toBeDefined()
  expect(
    (
      await apply(a.client, {
        sectionId: 'session',
        actionId: 'clear-pin',
        sessionId: 'S',
      })
    ).ok,
  ).toBe(true)
  expect(pins.get('S')).toBeUndefined()
  expect(pins.get('T')).toBe(t)
  expect(
    (
      await apply(a.client, {
        sectionId: 'routing',
        actionId: 'mode',
        values: { mode: 'fallback-first' },
      })
    ).ok,
  ).toBe(true)
  await b.client.pending(0, 'T')
  await b.host.commands[0]!.execute({ sessionID: 'T' })
  const messages = await b.client.pending(0, 'T')
  expect(JSON.stringify(messages)).toContain('Fallback first')
  expect(await headers(b.host, 'new-session')).toBe('Bearer alpha-token')
  expect(
    (
      await apply(a.client, {
        sectionId: 'limits',
        itemId: 'alpha',
        actionId: 'floors',
        values: { primary: 95 },
      })
    ).ok,
  ).toBe(true)
  expect(
    (
      await apply(a.client, {
        sectionId: 'limits',
        actionId: 'killswitch',
        values: { enabled: true },
      })
    ).ok,
  ).toBe(true)
  expect(await headers(b.host, 'after-floor')).toBe('Bearer beta-token')
  await b.host.commands[0]!.execute({ sessionID: 'T' })
  expect(JSON.stringify(await b.client.pending(0, 'T'))).toContain('≥95%')
  expect(pins.get('T')).toBe(t)
  // An API-key request bypasses account selection and keeps its bearer.
  expect(await route(b.host, 'api-session')).toBe('Bearer api-key')
})

test('OpenCode 2 setup menu login inserts one non-main row after location reload', async () => {
  const f = fixture()
  const directory = join(f.files.dir, 'A')
  const a = await setupLocation(f, directory)
  const before = f.bytes()
  expect(
    (
      await a.client.apply({
        command: 'openai',
        sectionId: 'accounts',
        actionId: 'add',
        sessionId: 'S',
        values: { headless: false },
      })
    ).ok,
  ).toBe(true)
  expect(f.bytes()).toEqual(before)
  await a.dispose()
  const b = await setupLocation(f, directory)
  await b.client.pending(0, 'T')
  f.finish()
  const message = await notification()
  expect(JSON.stringify(message)).toContain('Added new')
  expect(JSON.stringify(message)).not.toContain('secret-')
  expect(await b.client.pending(0, 'T')).toEqual([])
  expect(f.files.readConfig().accounts.map((row) => row.id)).toEqual([
    'main',
    'alpha',
    'beta',
    'new',
  ])
  expect(f.files.readState().accounts.main?.access).toBe('main-token')
})
