import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  normalizeSidebarState,
  removeSidebarActiveRouting,
  resolveSessionSidebarRouting,
  type SidebarState,
  setSidebarMachineState,
  upsertSidebarActiveRouting,
} from '../sidebar-state'

function state(overrides: Partial<SidebarState>): SidebarState {
  return { ...DEFAULT_SIDEBAR_STATE, ...overrides }
}

const now = 2 * 60 * 60 * 1000

describe('session sidebar routing', () => {
  test('selects each session own usable routing entry', () => {
    const shared = state({
      fallbacks: [
        {
          id: 'fallback-1',
          label: 'Fallback',
          quota: null,
          killed: false,
          enabled: true,
        },
      ],
      activeRouting: {
        'sess-a': { activeId: 'main', route: 'main-first', updatedAt: now },
        'sess-b': {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    })

    expect(resolveSessionSidebarRouting(shared, 'sess-a', now)).toEqual({
      activeId: 'main',
      route: 'main-first',
    })
    expect(resolveSessionSidebarRouting(shared, 'sess-b', now)).toEqual({
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
  })

  test('quota dialog highlights the requesting session account', async () => {
    const shared = state({
      activeId: 'main',
      fallbacks: [
        {
          id: 'fallback-1',
          label: 'Fallback',
          quota: null,
          killed: false,
          enabled: true,
        },
      ],
      activeRouting: {
        'sess-a': { activeId: 'main', route: 'main-first', updatedAt: now },
        'sess-b': {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    })
    const tui = (await import('../tui')) as unknown as {
      resolveQuotaDialogActiveId?: (
        state: SidebarState,
        sessionId: string | undefined,
        now: number,
      ) => string | undefined
    }

    expect(typeof tui.resolveQuotaDialogActiveId).toBe('function')
    expect(tui.resolveQuotaDialogActiveId?.(shared, 'sess-b', now)).toBe(
      'fallback-1',
    )
    expect(tui.resolveQuotaDialogActiveId?.(shared, undefined, now)).toBe(
      'main',
    )
  })

  test('derives fallback-first when the session entry is absent', () => {
    const shared = state({
      route: 'fallback-first',
      fallbacks: [
        {
          id: 'disabled',
          label: undefined,
          quota: null,
          killed: false,
          enabled: false,
        },
        {
          id: 'fallback-1',
          label: 'Fallback',
          quota: null,
          killed: false,
          enabled: true,
        },
      ],
    })

    expect(resolveSessionSidebarRouting(shared, 'missing', now)).toEqual({
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
  })

  test('does not derive a killed fallback for a missing session', () => {
    const shared = state({
      route: 'fallback-first',
      fallbacks: [
        {
          id: 'killed',
          label: 'Killed fallback',
          quota: null,
          killed: true,
          enabled: true,
        },
      ],
    })

    expect(resolveSessionSidebarRouting(shared, 'missing', now)).toEqual({
      activeId: 'main',
      route: 'fallback-first',
    })
  })

  test('present entry for a removed fallback derives instead of highlighting it', () => {
    const shared = state({
      route: 'fallback-first',
      fallbacks: [
        {
          id: 'fallback-2',
          label: 'Live fallback',
          quota: null,
          killed: false,
          enabled: true,
        },
      ],
      activeRouting: {
        'sess-a': {
          activeId: 'removed-fallback',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    })

    expect(resolveSessionSidebarRouting(shared, 'sess-a', now)).toEqual({
      activeId: 'fallback-2',
      route: 'fallback-first',
    })
  })

  test('stale present entry follows the absent-entry derive path', () => {
    const shared = state({
      route: 'main-first',
      activeRouting: {
        'sess-a': {
          activeId: 'main',
          route: 'fallback-first',
          updatedAt: 0,
        },
      },
    })
    expect(resolveSessionSidebarRouting(shared, 'sess-a', now)).toEqual({
      activeId: 'main',
      route: 'main-first',
    })
  })

  test('derives main when fallback-first has no enabled fallback', () => {
    const shared = state({ route: 'fallback-first', fallbacks: [] })
    expect(resolveSessionSidebarRouting(shared, 'missing', now)).toEqual({
      activeId: 'main',
      route: 'fallback-first',
    })
  })

  test('keeps read, write, machine refresh, and deletion aligned by session id', async () => {
    const file = join(
      mkdtempSync(join(tmpdir(), 'oai-sidebar-routing-live-')),
      'sidebar-state.json',
    )
    const accounts = [{ id: 'fallback-1', enabled: true }]
    const writeNow = Date.now()
    await setSidebarMachineState(
      {
        main: { quota: null, killed: false },
        fallbacks: [
          {
            id: 'fallback-1',
            label: 'Fallback',
            quota: null,
            killed: false,
            enabled: true,
          },
        ],
        route: 'fallback-first',
        lastUpdated: writeNow - 3,
      },
      file,
    )
    await upsertSidebarActiveRouting(
      {
        sessionId: 'sess-fallback',
        activeId: 'fallback-1',
        route: 'fallback-first',
        updatedAt: writeNow - 2,
      },
      accounts,
      file,
    )
    await upsertSidebarActiveRouting(
      {
        sessionId: 'sess-main',
        activeId: 'main',
        route: 'main-first',
        updatedAt: writeNow - 1,
      },
      accounts,
      file,
    )
    await drainSidebarWrites()

    let written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
    expect(
      resolveSessionSidebarRouting(written, 'sess-fallback', writeNow),
    ).toEqual({ activeId: 'fallback-1', route: 'fallback-first' })
    expect(
      resolveSessionSidebarRouting(written, 'sess-main', writeNow),
    ).toEqual({ activeId: 'main', route: 'main-first' })

    await setSidebarMachineState(
      {
        main: { quota: null, killed: false, resetCredits: 4 },
        fallbacks: [
          {
            id: 'fallback-1',
            label: 'Fallback',
            quota: null,
            killed: false,
            enabled: true,
            resetCredits: 2,
          },
        ],
        route: 'fallback-first',
        lastUpdated: writeNow,
      },
      file,
    )
    await drainSidebarWrites()
    written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
    expect(Object.keys(written.activeRouting ?? {}).sort()).toEqual([
      'sess-fallback',
      'sess-main',
    ])

    await removeSidebarActiveRouting('sess-fallback', accounts, file)
    await drainSidebarWrites()
    written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
    expect(written.activeRouting?.['sess-fallback']).toBeUndefined()
    expect(written.activeRouting?.['sess-main']).toBeDefined()
    expect(resolveSessionSidebarRouting(written, 'missing', writeNow)).toEqual({
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
  })
})
