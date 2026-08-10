import { describe, expect, test } from 'bun:test'
import { hashSidebarSessionId, type SidebarState } from '../sidebar-state.ts'
import {
  buildApplyRequest,
  buildQuotaRowsForDisplay,
  buildRoutingRowsForDisplay,
  getQuotaMetadataRows,
  isQuotaLoaded,
} from '../tui.tsx'

describe('dynamic quota TUI rows', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0)

  test('one 7-day primary window produces one 7d row paced over seven days', () => {
    const rows = buildQuotaRowsForDisplay(
      {
        primary: {
          usedPercent: 60,
          remainingPercent: 40,
          windowMinutes: 10_080,
          resetsAt: new Date(now + 3.5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
      now,
      true,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('primary')
    expect(rows[0]?.label).toBe('7d')
    expect(rows[0]?.pacing?.pacePercent).toBeCloseTo(50, 5)
  })

  test('two present windows produce two rows and zero windows produce none', () => {
    expect(
      buildQuotaRowsForDisplay(
        {
          primary: {
            usedPercent: 3,
            remainingPercent: 97,
            windowMinutes: 300,
          },
          secondary: {
            usedPercent: 20,
            remainingPercent: 80,
            windowMinutes: 10_080,
          },
        },
        now,
        false,
      ).map((row) => row.label),
    ).toEqual(['5h', '7d'])
    expect(buildQuotaRowsForDisplay({}, now, true)).toEqual([])
  })

  test('distinguishes an unloaded quota from a loaded snapshot with no windows', () => {
    expect(isQuotaLoaded(null)).toBe(false)
    expect(isQuotaLoaded({})).toBe(true)
  })

  test('a lengthless old window retains its historical label and pacing', () => {
    const rows = buildQuotaRowsForDisplay(
      {
        primary: {
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: new Date(now + 60_000).toISOString(),
        },
      },
      now,
      true,
    )
    expect(rows[0]?.label).toBe('5h')
    expect(rows[0]?.pacing).not.toBeNull()
  })

  test('global metadata excludes legacy reset credits', () => {
    const base: SidebarState = {
      main: { quota: null, killed: false },
      fallbacks: [],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    }
    const legacy = { ...base, resetCredits: 4 } as SidebarState & {
      resetCredits: number
    }
    expect(getQuotaMetadataRows(legacy)).not.toContainEqual(
      expect.objectContaining({ label: 'resets' }),
    )
  })

  test('account metadata renders only its own reset-credit count', async () => {
    const tui = (await import('../tui.tsx')) as unknown as {
      getAccountMetadataRows?: (
        resetCredits?: number,
      ) => Array<{ label: string; value: string }>
    }
    expect(typeof tui.getAccountMetadataRows).toBe('function')
    expect(tui.getAccountMetadataRows?.(4)).toEqual([
      { label: 'resets', value: '4' },
    ])
    expect(tui.getAccountMetadataRows?.(2)).toEqual([
      { label: 'resets', value: '2' },
    ])
    expect(tui.getAccountMetadataRows?.()).toEqual([])
  })

  test('modal routing apply sends sessionId on its RPC request', () => {
    expect(buildApplyRequest('openai-routing', 'reset', 'session-a')).toEqual({
      command: 'openai-routing',
      arguments: 'reset',
      sessionId: 'session-a',
    })
  })

  test('sticky-balanced routing renders a compact pin row only when the session has a usable pin', () => {
    const sessionId = 'sticky-render-session'
    const state: SidebarState = {
      main: { quota: null, killed: false },
      fallbacks: [
        {
          id: 'fallback-1',
          label: 'Work',
          quota: null,
          killed: false,
          enabled: true,
        },
      ],
      activeId: undefined,
      route: 'sticky-balanced',
      stickyAssignments: {
        'not-the-session-hash': {
          accountId: 'fallback-1',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 1,
        },
      },
      lastUpdated: now,
    }

    expect(buildRoutingRowsForDisplay(state, sessionId, now)).toEqual([
      { label: 'Route', value: 'sticky-balanced', tone: 'accent' },
    ])

    state.stickyAssignments = {
      [hashSidebarSessionId(sessionId)]: {
        accountId: 'fallback-1',
        assignedAt: now,
        lastSeenAt: now,
        inputBytes: 1,
      },
    }
    expect(buildRoutingRowsForDisplay(state, sessionId, now)).toEqual([
      { label: 'Route', value: 'sticky-balanced', tone: 'accent' },
      { label: 'Pin', value: 'Work', tone: 'accent' },
    ])
  })

  test('non-sticky routing renders the existing route row without a pin row', () => {
    const state: SidebarState = {
      main: { quota: null, killed: false },
      fallbacks: [],
      activeId: 'main',
      route: 'main-first',
      lastUpdated: now,
    }

    expect(buildRoutingRowsForDisplay(state, 'session-a', now)).toEqual([
      { label: 'Route', value: 'main-first', tone: 'accent' },
    ])
  })
})
