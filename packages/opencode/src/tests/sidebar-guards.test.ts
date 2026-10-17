import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import { isQuotaMap, type QuotaMap } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import { poolKillswitchVerdicts } from '@cortexkit/openai-auth-core/pool-routing'
import {
  buildPoolSidebarMachineState,
  buildVaultSidebarMachineState,
} from '../core/pool-sidebar'
import { buildSidebarMachineState } from '../index'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarState,
  hashSidebarSessionId,
  normalizeSidebarState,
  resolveSessionSidebarRouting,
  setSidebarMachineState,
  setSidebarState,
  upsertSidebarActiveRouting,
} from '../sidebar-state'
import { renderedQuotas } from '../tui'
import { quotaMap } from './fixtures/pool-install'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function file() {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-guards-'))
  directories.push(directory)
  return join(directory, 'sidebar.json')
}
function vaultRow(
  id: string,
  extra: Partial<VaultRosterRow> = {},
): VaultRosterRow {
  return {
    routeId: `vault:${id}`,
    credentialId: `chatgpt:openai:${id}`,
    credentialType: 'oauth',
    label: id,
    state: 'active',
    enabled: true,
    addedAt: 1,
    quota: quotaMap(90) as QuotaMap,
    ...extra,
  }
}

test('sidebar guards retain unavailable vault accounts separately from the host toggle', async () => {
  const path = file()
  const rows = [
    vaultRow('ready'),
    vaultRow('login', {
      state: 'needs_reauth',
      enabled: false,
      email: 'private@example.com',
      label: 'private@example.com',
    }),
    vaultRow('disabled', { state: 'retired' }),
    vaultRow('corrupt', { state: 'corrupt' }),
    vaultRow('unknown', { state: 'future-state-with-private-data' }),
    vaultRow('stale', { stale: true }),
    vaultRow('declined', { enabled: false }),
  ]
  await setSidebarMachineState(
    buildVaultSidebarMachineState(
      rows,
      new Set(['vault:ready']),
      null,
      Date.now(),
    ),
    path,
  )
  const state = await getSidebarState(path)
  expect(
    state.vaultAccounts?.map(({ id, enabled, routable, vaultState }) => [
      id,
      enabled,
      routable,
      vaultState,
    ]),
  ).toEqual([
    ['vault:ready', true, true, undefined],
    ['vault:login', false, false, 'needs sign-in'],
    ['vault:disabled', true, false, 'turned off in vault'],
    ['vault:corrupt', true, false, 'unavailable'],
    ['vault:unknown', true, false, 'unavailable'],
    ['vault:stale', true, false, 'unavailable'],
    ['vault:declined', false, false, undefined],
  ])
  expect(renderedQuotas(state)).toHaveLength(rows.length)
  expect(
    state.vaultAccounts?.every((row) => row.quota?.primary?.usedPercent === 90),
  ).toBe(true)
  expect(resolveSessionSidebarRouting(state, 'new').activeId).toBe(
    'vault:ready',
  )
  const raw = readFileSync(path, 'utf8')
  expect(raw).not.toContain('private@example.com')
  expect(raw).not.toContain('future-state-with-private-data')
  expect(
    normalizeSidebarState({
      ...state,
      vaultAccounts: [
        {
          ...state.vaultAccounts?.[0],
          vaultState: { secret: 'bad' },
          routable: 'false',
        },
      ],
    }).vaultAccounts?.[0]?.vaultState,
  ).toBeUndefined()
})

test('sidebar guards pool and vault killed flags match routing verdicts', () => {
  const now = Date.now()
  const store: AccountStorage = {
    version: 1,
    accounts: [],
    quota: { failClosedOnUnknownQuota: true },
    killswitch: {
      schema: 'floors-v1',
      enabled: true,
      defaults: { primary: 20 },
    },
  }
  const rows = ['main', 'blocked', 'healthy', 'unknown', 'expired'].map(
    (id) => ({
      id,
      enabled: true,
      label: id,
      ...(id === 'unknown'
        ? {}
        : { quota: quotaMap(id === 'healthy' ? 10 : 90, now) }),
    }),
  ) as PoolRow[]
  const expired = rows.find((row) => row.id === 'expired')!
  expired.quota = {
    limits: [
      {
        ...quotaMap(90, now).limits[0]!,
        kind: 'reading',
        resetsAt: new Date(now - 1).toISOString(),
      },
    ],
  }
  for (const enabled of [true, false]) {
    store.killswitch!.enabled = enabled
    const verdicts = poolKillswitchVerdicts(rows, store, now)
    const pool = buildPoolSidebarMachineState(rows, store, now)
    expect([
      pool.main.killed,
      ...pool.fallbacks.map((row) => row.killed),
    ]).toEqual(
      enabled
        ? [true, true, false, true, true]
        : [false, false, false, false, false],
    )
    expect(pool.main.killed).toBe(verdicts.get('main') === false)
    for (const account of pool.fallbacks)
      expect(account.killed).toBe(verdicts.get(account.id) === false)
    const vaultRows = rows.map((row) =>
      vaultRow(row.id, {
        quota: isQuotaMap(row.quota) ? row.quota : undefined,
      }),
    )
    const vault = buildVaultSidebarMachineState(
      vaultRows,
      new Set(vaultRows.map((row) => row.routeId)),
      store,
      now,
    )
    expect(vault.vaultAccounts?.map((row) => row.killed)).toEqual([
      pool.main.killed,
      ...pool.fallbacks.map((row) => row.killed),
    ])
  }
})

test('sidebar guards legacy killed flags use the routing policy', () => {
  const now = Date.now()
  const store: AccountStorage = {
    version: 1,
    accounts: [
      {
        id: 'spare',
        type: 'oauth',
        refresh: 'never-published',
        enabled: true,
        addedAt: 1,
      },
    ],
    killswitch: {
      schema: 'floors-v1',
      enabled: true,
      defaults: { primary: 20 },
    },
  }
  const qm = new QuotaManager({
    configPath: file(),
    storage: null,
    fetchQuotaFn: () => {
      throw new Error('display must not poll')
    },
  })
  const quota = {
    primary: {
      usedPercent: 90,
      remainingPercent: 10,
      checkedAt: now,
      resetsAt: new Date(now + 3600_000).toISOString(),
    },
  }
  qm.setMain('never-published', {
    quota,
    checkedAt: now,
    refreshAfter: now + 60_000,
  })
  qm.setFallback(
    'spare',
    { quota, checkedAt: now, refreshAfter: now + 60_000 },
    'never-published',
  )
  const machine = buildSidebarMachineState(qm, store, now)
  expect(machine.main.killed).toBe(true)
  expect(machine.fallbacks[0]?.killed).toBe(true)
  store.killswitch!.enabled = false
  expect(buildSidebarMachineState(qm, store, now).main.killed).toBe(false)
})

test('sidebar guards vault writes prune local records and preserve unavailable vault pins', async () => {
  const path = file()
  const now = Date.now()
  const assignments = Object.fromEntries(
    [
      'main',
      'spare',
      'vault:ready',
      'vault:disabled',
      'vault:missing',
      'vault:killed',
    ].map((accountId) => [
      hashSidebarSessionId(accountId),
      { accountId, inputBytes: 1, assignedAt: now, lastSeenAt: now },
    ]),
  )
  await setSidebarState(
    {
      ...DEFAULT_SIDEBAR_STATE,
      activeId: 'main',
      route: 'sticky-balanced',
      stickyAssignments: assignments,
      activeRouting: {
        local: { activeId: 'main', route: 'sticky-balanced', updatedAt: now },
        spare: { activeId: 'spare', route: 'sticky-balanced', updatedAt: now },
        vault: {
          activeId: 'vault:ready',
          route: 'sticky-balanced',
          updatedAt: now,
        },
      },
    },
    path,
  )
  const machine = buildVaultSidebarMachineState(
    [
      vaultRow('ready'),
      vaultRow('disabled', { state: 'retired' }),
      vaultRow('killed'),
    ],
    new Set(['vault:ready', 'vault:killed']),
    {
      routing: { mode: 'sticky-balanced' },
      killswitch: {
        schema: 'floors-v1',
        enabled: true,
        accounts: { 'vault:killed': { primary: 20 } },
      },
    },
    now,
  )
  await setSidebarMachineState(machine, path)
  const state = await getSidebarState(path)
  expect(state.activeId).toBeUndefined()
  expect(
    state.vaultAccounts?.find((account) => account.id === 'vault:killed')
      ?.killed,
  ).toBe(true)
  expect(Object.keys(state.activeRouting ?? {})).toEqual(['vault'])
  expect(
    Object.values(state.stickyAssignments ?? {})
      .map((pin) => pin.accountId)
      .sort(),
  ).toEqual(['vault:disabled', 'vault:missing', 'vault:ready'])
  expect(resolveSessionSidebarRouting(state, 'local').activeId).toBe(
    'vault:ready',
  )
  // Late bookkeeping from a local request must not reintroduce a local account.
  await upsertSidebarActiveRouting(
    {
      sessionId: 'late',
      activeId: 'main',
      route: 'sticky-balanced',
      updatedAt: Date.now(),
    },
    undefined,
    path,
  )
  const late = await getSidebarState(path)
  expect(late.activeRouting?.late).toBeUndefined()
  expect(late.activeId).toBeUndefined()
  expect(late.stickyAssignments).toEqual(state.stickyAssignments)
})
