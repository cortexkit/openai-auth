import { describe, expect, test } from 'bun:test'
import type { SidebarState } from '../sidebar-state.ts'
import {
  buildQuotaRowsForDisplay,
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

  test('a lengthless old window renders with its slot fallback and no pacing', () => {
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
    expect(rows[0]?.label).toBe('primary')
    expect(rows[0]?.pacing).toBeNull()
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
})
