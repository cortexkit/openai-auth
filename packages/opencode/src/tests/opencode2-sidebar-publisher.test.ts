import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { CommandApplyRequest } from '@cortexkit/common-auth/commands'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum'
import { getResolvedSettingsView } from '../config'
import { PoolAccountSource } from '../core/pool-account-source'
import { acquireOpenCodeVault } from '../core/shared-vault'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import * as sidebarState from '../sidebar-state'
import {
  getSidebarState,
  resolveSessionSidebarRouting,
  setSidebarMachineState,
  upsertSidebarActiveRouting,
} from '../sidebar-state'
import { setupOpenAIAuth } from '../v2/setup'
import { acquireSessionPins } from '../v2/shared-pins'
import {
  fakeOpenCode2Host,
  poolFiles,
  type RoutingModeSeed,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { usageBody } from './fixtures/pool-install'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type SharedFixture = {
  legacyMode: RoutingModeSeed
  secondLegacyMode?: RoutingModeSeed
}

async function fixture(
  connectionFile?: () => string,
  twoLocations = true,
  accounts = ['main', 'alpha', 'beta'],
  observation: { intervalMs?: number } = { intervalMs: 250 },
  shared?: SharedFixture,
) {
  const sources = new Set<PoolAccountSource>()
  const originalSubscribe = PoolAccountSource.prototype.subscribe
  const subscribe = spyOn(
    PoolAccountSource.prototype,
    'subscribe',
  ).mockImplementation(function (
    this: PoolAccountSource,
    listener: () => void,
  ) {
    sources.add(this)
    return originalSubscribe.call(this, listener)
  })
  cleanups.push(() => subscribe.mockRestore())
  const files = poolFiles()
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  const rows = accounts.map((id) => ({
    id,
    identity: `${id}-identity`,
    usedPercent: 20,
  }))
  seedPool(files, shared?.legacyMode ?? 'sticky-balanced', rows)
  const secondFiles = shared?.secondLegacyMode ? poolFiles() : files
  if (shared?.secondLegacyMode) {
    cleanups.push(() =>
      rmSync(secondFiles.dir, { recursive: true, force: true }),
    )
    seedPool(secondFiles, shared.secondLegacyMode, rows)
  }
  if (shared) {
    const name = 'OPENCODE_OPENAI_AUTH_SETTINGS_FILE'
    const previous = process.env[name]
    const settingsFile = join(files.dir, 'settings.jsonc')
    writeFileSync(
      settingsFile,
      JSON.stringify({ routing_mode: 'sticky-balanced' }),
    )
    process.env[name] = settingsFile
    cleanups.push(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
  const file = join(files.dir, 'sidebar.json')
  const calls: string[] = []
  const fetchImpl = Object.assign(
    async (input: unknown) => {
      calls.push(String(input))
      if (!String(input).includes('/wham/usage'))
        throw new Error('unexpected request')
      return new Response(usageBody(10))
    },
    { preconnect() {} },
  ) as typeof fetch
  const start = async (directory: string, pool = files) => {
    const host = fakeOpenCode2Host({ directory: join(files.dir, directory) })
    const dispose = await setupOpenAIAuth(host.ctx, {
      paths: pool.paths,
      sidebarStateFile: file,
      sidebarObservationIntervalMs: observation.intervalMs,
      heartbeat: false,
      poolMigration: false,
      fetch: fetchImpl,
      vault: {
        stateDir: join(files.dir, 'vault'),
        pollIntervalMs: 0,
        ...(connectionFile ? { connectionFile } : {}),
      },
    })
    cleanups.push(dispose)
    const client = createRpcClient(
      (await resolveRpcDir(join(files.dir, directory))).dir,
      process.pid,
    )
    return { host, client, dispose }
  }
  const a = await start('a')
  const b = twoLocations ? await start('b', secondFiles) : a
  const observer = acquireOpenCodeVault(
    {
      host: 'opencode',
      stateDir: join(files.dir, 'vault'),
      pollIntervalMs: 0,
      ...(connectionFile ? { connectionFile } : {}),
    },
    files.paths(),
  )
  try {
    await observer.firstRoster
    // Startup quota work belongs to setup, not to the passive publisher under test.
    await Promise.all([...sources].map((source) => source.settled()))
    await until(async () => existsSync(file))
  } finally {
    observer.release()
    subscribe.mockRestore()
  }
  return { files, secondFiles, file, calls, a, b, start }
}

const publishers = (globalThis as unknown as Record<PropertyKey, unknown>)[
  Symbol.for('@cortexkit/openai-auth/opencode2-sidebar-publishers')
] as Map<string, { settled(): Promise<void> }>

function sidebarSettled(file: string) {
  const publisher = publishers.get(resolve(file))
  if (!publisher) throw new Error('No sidebar publisher for the fixture')
  return publisher.settled()
}

function sidebarObserver() {
  const intervals = spyOn(globalThis, 'setInterval')
  cleanups.push(() => intervals.mockRestore())
  const intervalMs = 60_001
  return {
    intervalMs,
    async tick(file: string) {
      const callback = intervals.mock.calls.find(
        ([, delay]) => delay === intervalMs,
      )?.[0]
      if (!callback) throw new Error('No sidebar observation timer')
      callback()
      await sidebarSettled(file)
    },
  }
}

async function mainFirst(client: ReturnType<typeof createRpcClient>) {
  expect(
    await client.apply({
      command: 'openai',
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'main-first' },
    }),
  ).toMatchObject({ ok: true })
}

function placePin(files: ReturnType<typeof poolFiles>, sessionId: string) {
  acquireSessionPins(files.paths()).place({
    sessionId,
    requestBytes: 100,
    validPinnedAccountIds: ['main'],
    excludeAccountIds: [],
    quotaCheckedAtByAccount: {},
    wireAccountIdByAccount: {},
    persist: true,
    select: () => ({ accountId: 'main', source: 'weighted' }),
  })
}

async function vaultFixture(
  observation: ReturnType<typeof sidebarObserver>,
  shared?: SharedFixture,
) {
  const daemonFiles = poolFiles()
  cleanups.push(() => rmSync(daemonFiles.dir, { recursive: true, force: true }))
  const daemon = await startMockDaemon({
    directory: daemonFiles.dir,
    credentials: {
      'chatgpt:openai': vaultLogin('chatgpt-vault-main'),
      'chatgpt:openai:other': vaultLogin('chatgpt-vault-other'),
    },
  })
  cleanups.push(() => daemon.stop())
  const connectionFile = () => daemon.connectionFile
  const f = await fixture(connectionFile, true, ['main'], observation, shared)
  const options = {
    host: 'opencode' as const,
    stateDir: join(f.files.dir, 'vault'),
    connectionFile,
    pollIntervalMs: 0,
  }
  const observer = acquireOpenCodeVault(options, f.files.paths())
  cleanups.push(() => observer.release())
  expect(
    (
      await observer.vault.waitForApproval({
        sleep: async () => daemon.approve('request-1'),
      })
    ).state,
  ).toBe('approved')
  await observer.vault.refresh()
  if (f.secondFiles !== f.files) {
    const other = acquireOpenCodeVault(options, f.secondFiles.paths())
    cleanups.push(() => other.release())
    await other.vault.refresh()
  }
  await observation.tick(f.file)
  expect((await getSidebarState(f.file)).vaultDiscovered).toBe(true)
  return { ...f, vault: observer.vault }
}

async function changed(file: string, previous: number) {
  await until(async () => (await getSidebarState(file)).lastUpdated > previous)
  return getSidebarState(file)
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('sidebar did not publish the observed change')
    await Bun.sleep(10)
  }
}

async function request(
  host: ReturnType<typeof fakeOpenCode2Host>,
  sessionID: string,
) {
  const headers = { authorization: `Bearer ${placeholderSecret('openai')}` }
  await host.fire('model.request', { ...scope(sessionID), headers })
  return host.fire('http.request', {
    ...scope(sessionID),
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers,
      body: '{}',
    }),
  })
}

test('OpenCode 2 publisher: setup and real quota observations publish without a test file write', async () => {
  const f = await fixture(undefined, false, ['main'])
  expect(existsSync(f.file)).toBe(true)
  const initial = await getSidebarState(f.file)
  expect(initial.accountPool).toBe(true)
  const draft = await request(f.a.host, 'quota-session')
  const before = (await getSidebarState(f.file)).lastUpdated
  await f.a.host.fire('http.response', {
    ...scope('quota-session'),
    request: draft.request,
    response: new Response('{}', {
      headers: {
        'x-codex-primary-used-percent': '37',
        'x-codex-primary-window-minutes': '300',
      },
    }),
  })
  await changed(f.file, before)
  await until(
    async () =>
      (await getSidebarState(f.file)).main.quota?.primary?.usedPercent === 37,
  )
})

test('OpenCode 2 publisher: pin clear preserves two other sessions and subagent routing', async () => {
  const f = await fixture()
  const pins = acquireSessionPins(f.files.paths())
  for (const [sessionId, accountId] of [
    ['parent', 'alpha'],
    ['other', 'beta'],
    ['subagent', 'main'],
  ] as const) {
    pins.place({
      sessionId,
      requestBytes: 100,
      validPinnedAccountIds: ['main', 'alpha', 'beta'],
      excludeAccountIds: [],
      quotaCheckedAtByAccount: {},
      wireAccountIdByAccount: {},
      persist: true,
      select: () => ({ accountId, source: 'weighted' }),
    })
  }
  await until(
    async () =>
      Object.keys((await getSidebarState(f.file)).activeRouting ?? {})
        .length === 3,
  )
  const state = await getSidebarState(f.file)
  const parent = resolveSessionSidebarRouting(state, 'parent')
  const other = resolveSessionSidebarRouting(state, 'other')
  const subagent = resolveSessionSidebarRouting(state, 'subagent')
  expect(
    new Set([parent.activeId, other.activeId, subagent.activeId]).size,
  ).toBe(3)
  expect(
    (
      await f.b.client.apply({
        command: 'openai',
        sectionId: 'session',
        actionId: 'clear-pin',
        sessionId: 'parent',
      })
    ).ok,
  ).toBe(true)
  const next = await changed(f.file, state.lastUpdated)
  expect(next.activeRouting?.parent).toBeUndefined()
  expect(resolveSessionSidebarRouting(next, 'parent').activeId).toBe('main')
  expect(resolveSessionSidebarRouting(next, 'other')).toEqual(other)
  expect(resolveSessionSidebarRouting(next, 'subagent')).toEqual(subagent)
})

test('OpenCode 2 publisher: routing floor killswitch and successful apply publish passively', async () => {
  const f = await fixture(undefined, false)
  await until(
    async () =>
      (await getSidebarState(f.file)).main.quota?.primary?.usedPercent === 10,
  )
  const refresh = spyOn(PoolAccountSource.prototype, 'prepareTokens')
  cleanups.push(() => refresh.mockRestore())
  const operations: Omit<CommandApplyRequest, 'command'>[] = [
    {
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'fallback-first' },
    },
    {
      sectionId: 'limits',
      actionId: 'floors',
      itemId: 'alpha',
      values: { primary: 95 },
    },
    { sectionId: 'limits', actionId: 'killswitch', values: { enabled: true } },
    { sectionId: 'accounts', actionId: 'disable', itemId: 'beta' },
  ]
  for (const operation of operations) {
    const before = (await getSidebarState(f.file)).lastUpdated
    expect(
      (await f.a.client.apply({ command: 'openai', ...operation })).ok,
    ).toBe(true)
    await changed(f.file, before)
  }
  const state = await getSidebarState(f.file)
  expect(state.route).toBe('fallback-first')
  expect(state.fallbacks.map((row) => row.id)).toEqual(['alpha'])
  expect(state.fallbacks[0]?.killed).toBe(true)
  expect(f.calls.every((url) => url.includes('/wham/usage'))).toBe(true)
  expect(refresh).not.toHaveBeenCalled()
})

test('OpenCode 2 publisher: production observer defaults to two seconds', async () => {
  const intervals = spyOn(globalThis, 'setInterval')
  cleanups.push(() => intervals.mockRestore())
  await fixture(undefined, false, ['main'], {})
  expect(
    intervals.mock.calls.filter(([, delay]) => delay === 2_000),
  ).toHaveLength(1)
  expect(
    intervals.mock.calls.filter(([, delay]) => delay === 250),
  ).toHaveLength(0)
})

test('OpenCode 2 publisher: one observer per file survives a location disposal', async () => {
  const intervals = spyOn(globalThis, 'setInterval')
  cleanups.push(() => intervals.mockRestore())
  const f = await fixture()
  expect(
    intervals.mock.calls.filter(([, delay]) => delay === 250),
  ).toHaveLength(1)
  await f.a.dispose()
  const before = (await getSidebarState(f.file)).lastUpdated
  expect(
    (
      await f.b.client.apply({
        command: 'openai',
        sectionId: 'routing',
        actionId: 'mode',
        values: { mode: 'fallback-first' },
      })
    ).ok,
  ).toBe(true)
  expect((await changed(f.file, before)).route).toBe('fallback-first')
})

test('OpenCode 2 publisher: vault locations agree on the changed shared mode despite different old stores', async () => {
  const observation = sidebarObserver()
  const f = await vaultFixture(observation, {
    legacyMode: 'ordered',
    secondLegacyMode: 'main-first',
  })
  const publish = spyOn(sidebarState, 'setSidebarMachineState')
  cleanups.push(() => publish.mockRestore())
  await mainFirst(f.a.client)
  await until(
    async () =>
      getResolvedSettingsView(null, f.secondFiles.configPath).routing?.mode ===
      'main-first',
  )
  publish.mockClear()
  // Both old stores can still be written independently of the shared preferences.
  for (const { configPath } of [f.files, f.secondFiles])
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n`)
  await observation.tick(f.file)
  const states = publish.mock.calls.map(
    ([{ lastUpdated: _, ...state }]) => state,
  )
  expect(states.map((state) => state.route)).toEqual([
    'main-first',
    'main-first',
  ])
  expect(states[0]).toEqual(states[1])
  const settled = readFileSync(f.file, 'utf8')
  await observation.tick(f.file)
  expect(readFileSync(f.file, 'utf8')).toBe(settled)

  // A shared-file edit must also publish if neither old store changes.
  writeFileSync(
    join(f.files.dir, 'settings.jsonc'),
    JSON.stringify({
      routing_mode: 'fallback-first',
      killswitch_enabled: true,
      quota_fail_closed_on_unknown: true,
    }),
  )
  for (const { configPath } of [f.files, f.secondFiles])
    await until(
      async () =>
        getResolvedSettingsView(null, configPath).routing?.mode ===
        'fallback-first',
    )
  await observation.tick(f.file)
  const next = await getSidebarState(f.file)
  expect(next.route).toBe('fallback-first')
  expect(next.vaultAccounts?.map((row) => row.killed)).toEqual([true, true])
})

test('OpenCode 2 publisher: an equivalent vault refresh does not rewrite the sidebar', async () => {
  const observation = sidebarObserver()
  const f = await vaultFixture(observation)
  const before = readFileSync(f.file, 'utf8')
  const roster = f.vault.snapshot()
  const rosterInode = statSync(f.vault.paths.rosterPath).ino
  const publish = spyOn(sidebarState, 'setSidebarMachineState')
  cleanups.push(() => publish.mockRestore())
  await f.vault.refresh()
  expect(f.vault.snapshot()).toEqual(roster)
  expect(f.vault.snapshot()).not.toBe(roster)
  expect(statSync(f.vault.paths.rosterPath).ino).toBe(rosterInode)
  await observation.tick(f.file)
  await observation.tick(f.file)
  expect(publish).not.toHaveBeenCalled()
  expect(readFileSync(f.file, 'utf8')).toBe(before)
})

test('OpenCode 2 publisher retries a rejected observation write on the next unchanged tick', async () => {
  const observation = sidebarObserver()
  // With no accounts, a deferred startup quota write can't change the
  // config file between ticks and trigger another publication.
  const f = await fixture(undefined, false, [], observation)
  await observation.tick(f.file)
  const publish = spyOn(
    sidebarState,
    'setSidebarMachineState',
  ).mockRejectedValueOnce(new Error('sidebar write failed'))
  cleanups.push(() => publish.mockRestore())
  writeFileSync(
    f.files.configPath,
    `${readFileSync(f.files.configPath, 'utf8')}\n`,
  )
  await observation.tick(f.file)
  expect(publish).toHaveBeenCalledTimes(1)
  await observation.tick(f.file)
  expect(publish).toHaveBeenCalledTimes(2)
  await observation.tick(f.file)
  expect(publish).toHaveBeenCalledTimes(2)
})

test('OpenCode 2 publisher: a pin notification after a mode change uses the current route', async () => {
  const f = await fixture()
  await mainFirst(f.a.client)
  placePin(f.files, 'pin-after-change')
  await sidebarSettled(f.file)
  expect(
    (await getSidebarState(f.file)).activeRouting?.['pin-after-change']?.route,
  ).toBe('main-first')
})

test('OpenCode 2 publisher: setup only replays existing pins in sticky mode', async () => {
  const f = await fixture(undefined, false)
  placePin(f.files, 'earlier-pin')
  await sidebarSettled(f.file)
  await sidebarState.removeSidebarActiveRouting(
    'earlier-pin',
    undefined,
    f.file,
  )
  await f.start('sticky-project')
  await sidebarSettled(f.file)
  expect(
    (await getSidebarState(f.file)).activeRouting?.['earlier-pin']?.route,
  ).toBe('sticky-balanced')

  await mainFirst(f.a.client)
  await sidebarState.removeSidebarActiveRouting(
    'earlier-pin',
    undefined,
    f.file,
  )
  await f.start('main-first-project')
  await sidebarSettled(f.file)
  expect(
    (await getSidebarState(f.file)).activeRouting?.['earlier-pin'],
  ).toBeUndefined()
})

test('OpenCode 2 publisher: real enrollment and disconnect publish exclusive vault state without local polling', async () => {
  const daemonFiles = poolFiles()
  cleanups.push(() => rmSync(daemonFiles.dir, { recursive: true, force: true }))
  const daemon = await startMockDaemon({
    directory: daemonFiles.dir,
    credentials: {},
  })
  cleanups.push(() => daemon.stop())
  const f = await fixture(() => daemon.connectionFile, false, ['main', 'alpha'])
  const observer = acquireOpenCodeVault(
    {
      host: 'opencode',
      stateDir: join(f.files.dir, 'vault'),
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
    },
    f.files.paths(),
  )
  cleanups.push(() => observer.release())
  await until(
    async () =>
      (await getSidebarState(f.file)).main.quota?.primary?.usedPercent === 10,
  )
  const fetches = f.calls.length
  const pins = acquireSessionPins(f.files.paths())
  pins.place({
    sessionId: 'old-local-main',
    requestBytes: 1,
    validPinnedAccountIds: ['main'],
    excludeAccountIds: [],
    quotaCheckedAtByAccount: {},
    wireAccountIdByAccount: {},
    persist: true,
    select: () => ({ accountId: 'main', source: 'weighted' }),
  })
  await until(
    async () =>
      (await getSidebarState(f.file)).activeRouting?.['old-local-main']
        ?.activeId === 'main',
  )
  const poll = spyOn(PoolAccountSource.prototype, 'requestReading')
  const refresh = spyOn(PoolAccountSource.prototype, 'prepareTokens')
  cleanups.push(() => {
    poll.mockRestore()
    refresh.mockRestore()
  })
  let before = (await getSidebarState(f.file)).lastUpdated
  expect(
    (
      await observer.vault.waitForApproval({
        sleep: async () => daemon.approve('request-1'),
      })
    ).state,
  ).toBe('approved')
  await until(
    async () => (await getSidebarState(f.file)).vaultAccounts !== undefined,
  )
  const enrolled = await changed(f.file, before)
  expect(enrolled.vaultAccounts).toEqual([])
  expect(enrolled.main.quota).toBeNull()
  expect(enrolled.main.mainAccountId).toBeUndefined()
  expect(enrolled.fallbacks).toEqual([])
  expect(enrolled.activeRouting?.['old-local-main']).toBeUndefined()
  expect(
    Object.values(enrolled.stickyAssignments ?? {}).map((pin) => pin.accountId),
  ).not.toContain('main')
  expect(
    resolveSessionSidebarRouting(enrolled, 'old-local-main').activeId,
  ).toBe('vault')
  expect(f.calls.length).toBe(fetches)
  expect(poll).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  before = enrolled.lastUpdated
  await observer.vault.disconnect()
  await until(
    async () => (await getSidebarState(f.file)).vaultAccounts === undefined,
  )
  const local = await changed(f.file, before)
  expect(local.accountPool).toBe(true)
  expect(local.main.mainAccountId).toBe('main-identity')
  expect(local.fallbacks.map((row) => row.id)).toEqual(['alpha'])
  expect(f.calls.length).toBe(fetches)
})

test('OpenCode 2 publisher: OpenCode 1 and two locations retain independent quota windows and routes', async () => {
  const f = await fixture()
  await request(f.a.host, 'v2-a')
  await request(f.b.host, 'v2-b')
  const before = await getSidebarState(f.file)
  // Use the production OpenCode 1 writers as the competing producer, not a raw file overwrite.
  await Promise.all([
    setSidebarMachineState(
      {
        main: {
          ...before.main,
          quota: {
            ...before.main.quota,
            checkedAt: Date.now() + 100,
            secondary: {
              usedPercent: 43,
              remainingPercent: 57,
              windowMinutes: 10080,
              checkedAt: Date.now() + 100,
            },
          },
        },
        fallbacks: before.fallbacks,
        route: before.route,
        accountPool: true,
        lastUpdated: Date.now(),
      },
      f.file,
    ),
    upsertSidebarActiveRouting(
      {
        sessionId: 'v1',
        activeId: 'beta',
        route: 'sticky-balanced',
        updatedAt: Date.now(),
      },
      undefined,
      f.file,
    ),
    f.a.client.apply({
      command: 'openai',
      sectionId: 'routing',
      actionId: 'mode',
      values: { mode: 'main-first' },
    }),
    f.b.client.apply({
      command: 'openai',
      sectionId: 'limits',
      actionId: 'floors',
      itemId: 'alpha',
      values: { primary: 25 },
    }),
  ])
  const state = await getSidebarState(f.file)
  expect(state.main.quota?.primary).toBeDefined()
  expect(state.main.quota?.secondary?.usedPercent).toBe(43)
  expect(Object.keys(state.activeRouting ?? {}).sort()).toEqual([
    'v1',
    'v2-a',
    'v2-b',
  ])
  await f.a.dispose()
  const stamp = state.lastUpdated
  await f.b.client.apply({
    command: 'openai',
    sectionId: 'routing',
    actionId: 'mode',
    values: { mode: 'fallback-first' },
  })
  expect((await changed(f.file, stamp)).route).toBe('fallback-first')
})
