import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  isQuotaExhausted,
  isUsableRoutingEntry,
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

describe('quota exhaustion guard', () => {
  test('malformed persisted quota values stay fail-open', () => {
    const future = new Date(now + 60_000).toISOString()
    const window = { remainingPercent: 0, checkedAt: now, windowMinutes: 10080 }
    expect(
      isQuotaExhausted(
        {
          primary: {
            ...window,
            usedPercent: Number.NaN,
            resetsAt: future,
          },
        },
        now,
      ),
    ).toBe(false)
    expect(
      isQuotaExhausted(
        {
          primary: {
            ...window,
            usedPercent: '100' as unknown as number,
            resetsAt: future,
          },
        },
        now,
      ),
    ).toBe(false)
    expect(
      isQuotaExhausted(
        {
          primary: {
            ...window,
            usedPercent: 100,
            resetsAt: 'not-a-date',
          },
        },
        now,
      ),
    ).toBe(false)
    expect(
      isQuotaExhausted(
        {
          primary: {
            ...window,
            usedPercent: 100,
            resetsAt: (now + 60_000) as unknown as string,
          },
        },
        now,
      ),
    ).toBe(false)
    expect(
      isQuotaExhausted(
        { primary: { ...window, usedPercent: 100, resetsAt: future } },
        now,
      ),
    ).toBe(true)
  })
})

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

  test('derives a non-exhausted fallback when the session entry targets an exhausted fallback', () => {
    const shared = state({
      route: 'fallback-first',
      fallbacks: [
        {
          id: 'work-alt',
          label: 'Work',
          quota: {
            primary: {
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: new Date(now + 60_000).toISOString(),
            },
          },
          killed: false,
          enabled: true,
        },
        {
          id: 'client-alt',
          label: 'Client',
          quota: {
            primary: {
              usedPercent: 6,
              remainingPercent: 94,
              resetsAt: new Date(now + 60_000).toISOString(),
            },
          },
          killed: false,
          enabled: true,
        },
      ],
      activeRouting: {
        'parent-session': {
          activeId: 'work-alt',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    })

    expect(resolveSessionSidebarRouting(shared, 'parent-session', now)).toEqual(
      { activeId: 'client-alt', route: 'fallback-first' },
    )
  })

  test('derives a fallback when the session entry targets exhausted main', () => {
    const shared = state({
      route: 'fallback-first',
      main: {
        quota: {
          primary: {
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: new Date(now + 60_000).toISOString(),
          },
        },
        killed: false,
      },
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
        'parent-session': {
          activeId: 'main',
          route: 'main-first',
          updatedAt: now,
        },
      },
    })

    expect(resolveSessionSidebarRouting(shared, 'parent-session', now)).toEqual(
      { activeId: 'fallback-1', route: 'fallback-first' },
    )
  })

  test('honors an exhausted entry after its quota window reset has elapsed', () => {
    const shared = state({
      route: 'fallback-first',
      fallbacks: [
        {
          id: 'fallback-1',
          label: 'Fallback',
          quota: {
            primary: {
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: new Date(now - 1).toISOString(),
            },
          },
          killed: false,
          enabled: true,
        },
      ],
      activeRouting: {
        'parent-session': {
          activeId: 'fallback-1',
          route: 'main-first',
          updatedAt: now,
        },
      },
    })

    expect(resolveSessionSidebarRouting(shared, 'parent-session', now)).toEqual(
      { activeId: 'fallback-1', route: 'main-first' },
    )
  })

  test('honors entries when quota is missing or unknown', () => {
    const shared = state({
      fallbacks: [
        {
          id: 'missing-quota',
          label: 'Missing quota',
          quota: {},
          killed: false,
          enabled: true,
        },
        {
          id: 'null-quota',
          label: 'Null quota',
          quota: null,
          killed: false,
          enabled: true,
        },
      ],
      activeRouting: {
        missing: {
          activeId: 'missing-quota',
          route: 'fallback-first',
          updatedAt: now,
        },
        null: {
          activeId: 'null-quota',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    })

    expect(resolveSessionSidebarRouting(shared, 'missing', now).activeId).toBe(
      'missing-quota',
    )
    expect(resolveSessionSidebarRouting(shared, 'null', now).activeId).toBe(
      'null-quota',
    )
  })

  test('keeps the first enabled fallback when every fallback is exhausted', () => {
    const exhaustedQuota = {
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(now + 60_000).toISOString(),
      },
    }
    const shared = state({
      route: 'fallback-first',
      fallbacks: [
        {
          id: 'fallback-1',
          label: 'First',
          quota: exhaustedQuota,
          killed: false,
          enabled: true,
        },
        {
          id: 'fallback-2',
          label: 'Second',
          quota: exhaustedQuota,
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

  test('treats a routing entry targeting a killed fallback as unusable', () => {
    const accounts = [{ id: 'killed-fb', enabled: true, killed: true }]
    const entry = {
      activeId: 'killed-fb',
      route: 'fallback-first',
      updatedAt: now,
    }
    expect(isUsableRoutingEntry(entry, accounts, now)).toBe(false)
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
