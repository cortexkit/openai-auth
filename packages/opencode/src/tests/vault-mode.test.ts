// Vault mode on OpenCode's request path: while this host is enrolled with the
// Claustrum vault, the vault's accounts are the only candidates. No pool row
// routes, not even one signing in as an account the vault does not hold; the
// pool source refreshes, polls and offers a bearer for none of them; and the
// sidebar file lists the vault accounts in place of the local ones.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultRosterRow } from '@cortexkit/common-auth/claustrum'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import type {
  AccountPaths,
  AccountStorage,
} from '@cortexkit/openai-auth-core/internal'
import { PoolAccountSource } from '../core/pool-account-source'
import {
  type NoCredentialCause,
  type PoolRequestContext,
  type PoolVaultRoutes,
  servePoolRequest,
} from '../core/pool-request'
import { buildVaultSidebarMachineState } from '../core/pool-sidebar'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarState,
  hashSidebarSessionId,
  resolveActiveAccount,
  resolveSessionSidebarRouting,
  type SidebarState,
  setSidebarMachineState,
  setSidebarState,
} from '../sidebar-state'
import { renderedQuotas } from '../tui.tsx'
import { HOUR, quotaMap, seedPool } from './fixtures/pool-install'

let dir: string
let paths: AccountPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-vault-mode-'))
  paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function files(): string[] {
  return [paths.configPath, paths.statePath].map((path) =>
    readFileSync(path, 'utf8'),
  )
}

describe('the request path in vault mode', () => {
  /**
   * A request over healthy pool rows the vault does not hold. The source is
   * given no vault-mode switch, so only the request path's own rule keeps
   * the rows out.
   */
  async function serve(
    vault: PoolVaultRoutes,
    storage: AccountStorage | null = null,
    mode: PoolRequestContext['mode'] = 'fallback-first',
    status = 200,
  ) {
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'main', quota: quotaMap(10) },
      { id: 'spare', quota: quotaMap(5) },
    ])
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async () => {
        throw new Error('no refresh expected')
      },
      pullQuota: async () => undefined,
    })
    await source.load()
    const sent: string[] = []
    const causes: Array<NoCredentialCause | undefined> = []
    const ctx: PoolRequestContext = {
      source,
      vault,
      storage,
      mode,
      sessionId: undefined,
      body: '{}',
      replayable: true,
      now: Date.now,
      send: async (target, token) => {
        sent.push(`${target.id}:${token}`)
        return new Response('ok', { status })
      },
      recordQuota: () => {},
      placePin: () => undefined,
      blocked: (_block, _quotas, cause) => {
        causes.push(cause)
        return new Response('refused', { status: 401 })
      },
      resetCredits: () => undefined,
      isAbort: () => false,
      log: { debug: () => {} },
    }
    try {
      const result = await servePoolRequest(ctx)
      return { result, sent, causes }
    } finally {
      source.dispose()
      await source.settled()
    }
  }

  function vaultWith(
    routes: ReturnType<PoolVaultRoutes['routes']>,
    cause: 'vault-unreachable' | 'vault-empty' = 'vault-empty',
  ): PoolVaultRoutes {
    return {
      routes: () => routes,
      awaitRoster: async () => {},
      noRouteCause: () => cause,
      send: async (id, dispatch) => dispatch(`vault-token-${id}`, {} as never),
      requestReading: () => {},
    }
  }

  it('main-first places the default vault account first and fallback-first places it last', async () => {
    const main = {
      id: 'vault:chatgpt:openai~default',
      credentialId: 'chatgpt:openai',
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }
    const alias = {
      id: 'vault:chatgpt:openai:work~alias',
      credentialId: 'chatgpt:openai:work',
      kind: 'oauth' as const,
      quota: quotaMap(10),
    }
    const first = await serve(vaultWith([alias, main]), null, 'main-first')
    expect(first.result.servedId).toBe(main.id)
    expect(first.sent).toEqual([`${main.id}:vault-token-${main.id}`])
    const last = await serve(
      vaultWith([main, alias]),
      null,
      'fallback-first',
      429,
    )
    expect(last.sent).toEqual([
      `${alias.id}:vault-token-${alias.id}`,
      `${main.id}:vault-token-${main.id}`,
    ])
    expect(last.result.servedId).toBe(main.id)
  })

  it('alias-only vault placements keep Ordered order and never serve the local main', async () => {
    const routes = [
      'vault:chatgpt:openai:work',
      'vault:chatgpt:openai:home',
    ].map((id) => ({ id, kind: 'oauth' as const, quota: quotaMap(10) }))
    for (const mode of ['ordered', 'main-first', 'fallback-first'] as const) {
      const { sent } = await serve(vaultWith(routes), null, mode, 429)
      expect(sent).toEqual(routes.map(({ id }) => `${id}:vault-token-${id}`))
    }
  })

  it('an unshadowed local row never routes in vault mode: only vault accounts are candidates', async () => {
    const { result, sent } = await serve(
      vaultWith([{ id: 'vault:work', kind: 'oauth', quota: quotaMap(50) }]),
    )
    expect(result.servedId).toBe('vault:work')
    expect(sent).toEqual(['vault:work:vault-token-vault:work'])
  })

  for (const cause of ['vault-unreachable', 'vault-empty'] as const) {
    it(`a vault with no account to serve (${cause}) refuses the request with nothing sent`, async () => {
      const { result, sent, causes } = await serve(vaultWith([], cause))
      expect(result.response.status).toBe(401)
      expect(sent).toEqual([])
      expect(causes).toEqual([cause])
    })
  }
  it('vault quota admission is not misreported as an empty roster', async () => {
    const { sent, causes } = await serve(
      vaultWith([{ id: 'vault:work', kind: 'oauth', quota: quotaMap(90) }]),
      {
        version: 1,
        accounts: [],
        killswitch: {
          enabled: true,
          schema: 'floors-v1',
          defaults: { primary: 25, secondary: 0 },
        },
      },
    )
    expect(sent).toEqual([])
    expect(causes).toEqual([undefined])
  })
})

describe('the pool source in vault mode', () => {
  it('refreshes, polls and offers a bearer for no row, and leaves the files byte-identical; leaving vault mode restores all three', async () => {
    // Both rows' tokens are due for a refresh, neither has been polled, and
    // the vault holds neither account.
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'main', expires: Date.now() + 60_000 },
      { id: 'spare', expires: Date.now() + 60_000 },
    ])
    const before = files()
    const refreshed: string[] = []
    const polled: string[] = []
    let vaultMode = true
    const source = new PoolAccountSource({
      paths: () => paths,
      refreshProvider: async (credential) => {
        refreshed.push(credential.refresh)
        return {
          access: `${credential.refresh}-rotated`,
          refresh: `${credential.refresh}-next`,
          expires: Date.now() + HOUR,
        }
      },
      pullQuota: async (request) => {
        polled.push(request.id)
        return undefined
      },
      vaultIdentities: () => new Set(),
      vaultMode: () => vaultMode,
    })
    try {
      // The first load, the background refresh and poll, a quota check, a
      // request's token step, and the bearer lookups of keep-warm and reset
      // credits.
      const view = await source.load()
      await source.poolStore().pullsSettled()
      await source.refreshDueTokens(null)
      await source.pollRows(null)
      await source.prepareTokens(view.rows, null, { waitForAll: true })
      source.requestReading('spare', true)
      await source.poolStore().pullsSettled()
      for (const row of view.rows) {
        expect(source.usableToken(row)).toBeUndefined()
        expect(await source.accessFor(row.id, null)).toBeUndefined()
      }
      await source.settled()

      expect(refreshed).toEqual([])
      expect(polled).toEqual([])
      expect(files()).toEqual(before)

      // Disconnect: the same source refreshes and polls again, no migration.
      vaultMode = false
      await source.refreshDueTokens(null)
      await source.pollRows(null)
      await source.settled()
      expect(refreshed).toEqual(
        expect.arrayContaining(['main-refresh', 'spare-refresh']),
      )
      expect(polled).toEqual(expect.arrayContaining(['main', 'spare']))
    } finally {
      source.dispose()
      await source.settled()
    }
  })
})

describe('the sidebar file in vault mode', () => {
  const quota = quotaMap(30) as QuotaMap
  function row(
    id: string,
    extra: Partial<VaultRosterRow> = {},
  ): VaultRosterRow {
    return {
      routeId: `vault:${id}`,
      credentialId: `oauth:openai:${id}`,
      credentialType: 'oauth',
      accountIdentity: `chatgpt-${id}`,
      state: 'active',
      label: `${id} login`,
      enabled: true,
      addedAt: 1,
      quota,
      ...extra,
    }
  }

  it('predicts the default vault placement for new sessions and preserves route ids through the state file', async () => {
    const file = join(dir, 'sidebar.json')
    const rows = [
      row('work'),
      row('default', { credentialId: 'chatgpt:openai' }),
      row('home'),
    ]
    for (const mode of [
      'main-first',
      'fallback-first',
      'ordered',
      'sticky-balanced',
    ] as const) {
      await setSidebarMachineState(
        buildVaultSidebarMachineState(
          rows,
          new Set(rows.map((entry) => entry.routeId)),
          { routing: { mode } },
          Date.now(),
        ),
        file,
      )
      const state = await getSidebarState(file)
      const expected = mode === 'main-first' ? 'vault:default' : 'vault:work'
      expect(resolveSessionSidebarRouting(state, 'new-session').activeId).toBe(
        expected,
      )
      expect(resolveSessionSidebarRouting(state).activeId).toBe(expected)
      expect(resolveActiveAccount(state).id).toBe(expected)
      expect(
        resolveSessionSidebarRouting({ ...state, activeId: 'vault:home' })
          .activeId,
      ).toBe('vault:home')
      expect(state.vaultAccounts?.map((entry) => entry.id)).toEqual(
        rows.map((entry) => entry.routeId),
      )
    }
    for (const mode of ['main-first', 'fallback-first'] as const) {
      const aliases = [row('work'), row('home')]
      const state = {
        ...DEFAULT_SIDEBAR_STATE,
        ...buildVaultSidebarMachineState(
          aliases,
          new Set(aliases.map((entry) => entry.routeId)),
          { routing: { mode } },
          Date.now(),
        ),
      }
      expect(resolveSessionSidebarRouting(state, 'new-session').activeId).toBe(
        'vault:work',
      )
      expect(resolveActiveAccount(state).id).toBe('vault:work')
    }
  })

  it('lists the vault accounts by email, else vault label, with no local account in the fields an older reader shows', async () => {
    const file = join(dir, 'sidebar.json')
    // What the file held before vault mode: local accounts.
    await setSidebarState(
      {
        ...DEFAULT_SIDEBAR_STATE,
        main: { quota: null, killed: false, mainAccountId: 'chatgpt-main' },
        fallbacks: [
          {
            id: 'spare',
            label: 'spare',
            quota: null,
            killed: false,
            enabled: true,
          },
        ],
        route: 'sticky-balanced',
        stickyAssignments: {
          [hashSidebarSessionId('pinned')]: {
            accountId: 'vault:work',
            assignedAt: Date.now(),
            lastSeenAt: Date.now(),
            inputBytes: 1,
          },
        },
      },
      file,
    )

    await setSidebarMachineState(
      buildVaultSidebarMachineState(
        [
          row('work', { email: 'work@example.com' }),
          row('home'),
          row('cold', { state: 'needs_login' }),
        ],
        new Set(['vault:work', 'vault:home']),
        { routing: { mode: 'sticky-balanced' } },
        Date.now(),
      ),
      file,
    )
    const state = await getSidebarState(file)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >

    expect(
      state.vaultAccounts?.map((account) => [
        account.id,
        account.label,
        account.enabled,
      ]),
    ).toEqual([
      ['vault:work', 'work@example.com', true],
      ['vault:home', 'home login', true],
      ['vault:cold', 'cold login', false],
    ])
    expect(state.vaultAccounts?.[0]?.quota).not.toBeNull()
    expect(state.fallbacks).toEqual([])
    expect(state.main.quota).toBeNull()
    expect(raw.fallbacks).toEqual([])
    expect(JSON.stringify(raw)).not.toContain('chatgpt-main')
    expect(JSON.stringify(raw)).not.toContain('"spare"')
    // A session pinned to a vault account keeps its pin and shows it active.
    expect(state.stickyAssignments?.[hashSidebarSessionId('pinned')]).toEqual(
      expect.objectContaining({ accountId: 'vault:work' }),
    )
    expect(resolveSessionSidebarRouting(state, 'pinned').activeId).toBe(
      'vault:work',
    )
  })
})

describe('the TUI sidebar in vault mode', () => {
  it('renders the serving vault accounts, not main or a local fallback, and marks the session active one', () => {
    const quota = { primary: { usedPercent: 40, remainingPercent: 60 } }
    const state = {
      ...DEFAULT_SIDEBAR_STATE,
      main: {
        quota: { primary: { usedPercent: 1, remainingPercent: 99 } },
        killed: false,
      },
      fallbacks: [],
      vaultAccounts: [
        {
          id: 'vault:work',
          label: 'work@example.com',
          quota,
          killed: false,
          enabled: true,
        },
        {
          id: 'vault:cold',
          label: 'cold login',
          quota: null,
          killed: false,
          enabled: false,
        },
      ],
      route: 'main-first',
      activeRouting: {
        session: {
          activeId: 'vault:work',
          route: 'main-first',
          updatedAt: Date.now(),
        },
      },
    } as SidebarState

    // Only the enabled vault account is rendered; main's leftover quota is not.
    expect(renderedQuotas(state)).toEqual([quota])
    const routing = resolveSessionSidebarRouting(state, 'session')
    expect(routing.activeId).toBe('vault:work')
    expect(
      resolveActiveAccount({ ...state, activeId: routing.activeId }),
    ).toEqual({
      id: 'vault:work',
      name: 'work@example.com',
      quota,
      killed: false,
    })
  })
})
