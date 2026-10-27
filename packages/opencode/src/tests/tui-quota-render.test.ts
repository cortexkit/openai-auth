import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  formatQuota,
  projectQuota,
  quotaTextParts,
} from '@cortexkit/common-auth/quota'
import { sidebarQuotaFromPoolMap } from '../core/pool-sidebar.ts'
import {
  type AccountQuota,
  accountCreditsText,
  accountServesOnCredits,
  fitCollapsedLabel,
  getCollapsedAccountLines,
  getCollapsedQuotaSummary,
  hashSidebarSessionId,
  type SidebarState,
} from '../sidebar-state.ts'
import {
  buildApplyRequest,
  buildQuotaRowsForDisplay,
  buildRoutingRowsForDisplay,
  computeQuotaLabelWidth,
  fitQuotaRow,
  getAccountMetadataRows,
  getQuotaMetadataRows,
  isQuotaLoaded,
  renderedQuotas,
} from '../tui.tsx'

describe('dynamic quota TUI rows', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0)

  test('sidebar quota rows show the shared reset timing for local and vault accounts', () => {
    const checkedAt = now - 3 * 60 * 60_000
    const primaryReset = new Date(
      now + 2 * 60 * 60_000 + 29 * 60_000 + 59_999,
    ).toISOString()
    const secondaryReset = new Date(
      now + 4 * 60 * 60_000 + 30 * 60_000 + 59_999,
    ).toISOString()
    const localQuota = {
      checkedAt,
      primary: {
        usedPercent: 42,
        remainingPercent: 58,
        windowMinutes: 300,
        resetsAt: primaryReset,
      },
      secondary: {
        usedPercent: 10,
        remainingPercent: 90,
        windowMinutes: 10_080,
        resetsAt: secondaryReset,
      },
    }
    const vaultQuota = sidebarQuotaFromPoolMap({
      limits: [
        {
          scope: 'all',
          label: 'primary',
          kind: 'reading',
          checkedAt,
          usedPercent: 42,
          windowMinutes: 300,
          resetsAt: primaryReset,
        },
        {
          scope: 'all',
          label: 'secondary',
          kind: 'reading',
          checkedAt,
          usedPercent: 10,
          windowMinutes: 10_080,
          resetsAt: secondaryReset,
        },
      ],
    })

    const expected = [
      ['5h', '2h29m'],
      ['7d', '4h30m'],
    ]
    for (const quota of [localQuota, vaultQuota]) {
      expect(
        buildQuotaRowsForDisplay(quota, now, false).map((row) => [
          row.label,
          row.resetText,
        ]),
      ).toEqual(expected)
    }
  })

  test('sidebar reset rows omit missing times and mark resets since the reading', () => {
    const checkedAt = now - 3 * 60 * 60_000
    const rowsWithoutReset = buildQuotaRowsForDisplay(
      {
        checkedAt,
        primary: {
          usedPercent: 42,
          remainingPercent: 58,
          windowMinutes: 300,
        },
      },
      now,
      false,
    )
    const rowsAfterReset = buildQuotaRowsForDisplay(
      {
        checkedAt,
        primary: {
          usedPercent: 42,
          remainingPercent: 58,
          windowMinutes: 300,
          resetsAt: new Date(now - 30_000).toISOString(),
        },
      },
      now,
      false,
    )

    expect(rowsWithoutReset[0]?.resetText).toBeUndefined()
    expect(rowsAfterReset[0]?.resetText).toBe('reset')
    expect(rowsAfterReset[0]?.resetText).not.toContain('resets in')
  })

  test('sidebar quota text matches the shared compact formatter', () => {
    const checkedAt = now - 3 * 60 * 60_000
    const quota = {
      checkedAt,
      primary: { usedPercent: 42, remainingPercent: 58, windowMinutes: 300 },
      secondary: {
        usedPercent: 10,
        remainingPercent: 90,
        windowMinutes: 10080,
      },
    }
    const projection = projectQuota({
      limits: [
        {
          kind: 'reading',
          scope: 'all',
          label: 'primary',
          usedPercent: 42,
          windowMinutes: 300,
          checkedAt,
        },
        {
          kind: 'reading',
          scope: 'all',
          label: 'secondary',
          usedPercent: 10,
          windowMinutes: 10080,
          checkedAt,
        },
      ],
    })
    expect(formatQuota(projection, { now, form: 'compact' })).toBe(
      '5h 58% left · 7d 90% left · checked 3h ago',
    )
    expect(getCollapsedQuotaSummary(quota, now).text).toBe(
      formatQuota(projection, { now, form: 'compact' }),
    )
    expect(
      buildQuotaRowsForDisplay(quota, now, false).map((row) => row.text),
    ).toEqual(quotaTextParts(projection, { now, form: 'compact' }).slice(0, 2))
    expect(
      buildQuotaRowsForDisplay(quota, now, false).map((row) => [
        row.key,
        row.label,
        row.text,
      ]),
    ).toEqual([
      ['primary', '5h', '5h 58% left'],
      ['secondary', '7d', '7d 90% left'],
    ])
  })

  function projectQuotaRow(row: {
    label: string
    labelWidth: number
    text: string
  }): string {
    return `${row.label.padEnd(row.labelWidth)}▓▓▓▓▓▓▓▓ ${row.text.slice(row.label.length + 1)}`
  }

  const twoWindows = {
    primary: { usedPercent: 0, remainingPercent: 100, windowMinutes: 300 },
    secondary: {
      usedPercent: 51,
      remainingPercent: 49,
      windowMinutes: 10_080,
    },
  }
  const withSpendControl = {
    ...twoWindows,
    spendControl: {
      limit: 2500,
      used: 501.7787666320801,
      remaining: 1998.2212333679199,
      usedPercent: 20.071150665283206,
      remainingPercent: 79.9288493347168,
      unit: 'credit',
      source: 'individual_limit',
      reached: false,
    },
  }

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

  test('renders a third credit-budget bar when spend control is present', () => {
    const rows = buildQuotaRowsForDisplay(
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
        spendControl: {
          limit: 2500,
          used: 501.7787666320801,
          remaining: 1998.2212333679199,
          usedPercent: 20.071150665283206,
          remainingPercent: 79.9288493347168,
          resetsAt: '2026-10-01T00:00:00.000Z',
          unit: 'credits',
          source: 'individual_limit',
          reached: false,
        },
      },
      now,
      false,
    )

    expect(
      rows.map((row) => [row.key, row.label, row.window.usedPercent]),
    ).toEqual([
      ['primary', '5h', 3],
      ['secondary', '7d', 20],
      ['spendControl', 'credits', 20.071150665283206],
    ])
  })

  test('renders the existing two-bar sidebar output without spend control', () => {
    const rows = buildQuotaRowsForDisplay(
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
    )

    expect(
      rows.map((row) => [row.key, row.label, row.window.usedPercent]),
    ).toEqual([
      ['primary', '5h', 3],
      ['secondary', '7d', 20],
    ])
    expect(rows.some((row) => row.key === 'spendControl')).toBe(false)
  })

  test('a sidebar with no spend control anywhere keeps the three-column label width', () => {
    const fallback = {
      primary: { usedPercent: 12, remainingPercent: 88, windowMinutes: 300 },
    }
    const labelWidth = computeQuotaLabelWidth([twoWindows, fallback])

    expect(labelWidth).toBe(3)
    expect(
      buildQuotaRowsForDisplay(twoWindows, now, false, labelWidth).map(
        projectQuotaRow,
      ),
    ).toEqual(['5h ▓▓▓▓▓▓▓▓ 100% left', '7d ▓▓▓▓▓▓▓▓ 49% left'])
    expect(
      buildQuotaRowsForDisplay(fallback, now, false, labelWidth).map(
        projectQuotaRow,
      ),
    ).toEqual(['5h ▓▓▓▓▓▓▓▓ 88% left'])
  })

  // The width is only as correct as the set it measures, and the set is built
  // in the sidebar where no test can reach it. A fallback dropped here narrows
  // the column back to the defect this fixed, with every unit test still green.
  test('the measured set covers main and every enabled fallback', () => {
    const measured = renderedQuotas({
      main: { quota: twoWindows },
      fallbacks: [
        { enabled: true, quota: withSpendControl },
        { enabled: false, quota: withSpendControl },
      ],
    })

    expect(measured).toEqual([twoWindows, withSpendControl])
    // A disabled account draws no rows, so counting it would widen the column
    // for a row nobody sees.
    expect(measured).toHaveLength(2)
    expect(computeQuotaLabelWidth(measured)).toBe(8)
  })

  test('one account with spend control widens every account label column', () => {
    const labelWidth = computeQuotaLabelWidth([twoWindows, withSpendControl])

    expect(labelWidth).toBe(8)
    expect(
      buildQuotaRowsForDisplay(twoWindows, now, false, labelWidth).map(
        projectQuotaRow,
      ),
    ).toEqual(['5h      ▓▓▓▓▓▓▓▓ 100% left', '7d      ▓▓▓▓▓▓▓▓ 49% left'])
    expect(
      buildQuotaRowsForDisplay(withSpendControl, now, false, labelWidth).map(
        projectQuotaRow,
      ),
    ).toEqual([
      '5h      ▓▓▓▓▓▓▓▓ 100% left',
      '7d      ▓▓▓▓▓▓▓▓ 49% left',
      'credits ▓▓▓▓▓▓▓▓ 80% left',
    ])
  })

  test('the longest label keeps a separator before its bar', () => {
    const labelWidth = computeQuotaLabelWidth([withSpendControl])
    const creditsRow = buildQuotaRowsForDisplay(
      withSpendControl,
      now,
      false,
      labelWidth,
    ).find((row) => row.key === 'spendControl')

    expect(creditsRow?.label.padEnd(creditsRow.labelWidth)).toBe('credits ')
  })

  test('distinguishes an unloaded quota from a loaded snapshot with no windows', () => {
    expect(isQuotaLoaded(null)).toBe(false)
    expect(isQuotaLoaded({})).toBe(true)
  })

  test('a lengthless old window uses the shared label and retains historical pacing', () => {
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

  test('renders grouped credit amounts with a pluralised unit', () => {
    const rows = getAccountMetadataRows(undefined, {
      limit: 2500,
      used: 501.7787666320801,
      remaining: 1998.22123336792,
      usedPercent: 20.071150665283206,
      remainingPercent: 79.9288493347168,
      unit: 'credit',
      source: 'individual_limit',
      reached: false,
    })
    const rendered = JSON.stringify(rows)

    expect(rows).toContainEqual({
      label: 'credits',
      value: '502 / 2,500 credits',
    })
    expect(rendered).not.toContain('501.7787666320801')
    expect(rendered).not.toContain('$')
  })

  test('a single-credit budget keeps the unit singular', () => {
    expect(
      getAccountMetadataRows(undefined, {
        limit: 1,
        used: 1,
        remaining: 0,
        usedPercent: 100,
        remainingPercent: 0,
        unit: 'credit',
        reached: true,
      }),
    ).toContainEqual({ label: 'credits', value: '1 / 1 credit' })
  })

  test('an account with prepaid credits gets a prepaid row in the Codex wording', () => {
    const prepaid = (credits: unknown) =>
      getAccountMetadataRows(
        undefined,
        undefined,
        accountCreditsText({ credits } as AccountQuota),
      )
    const checkedAt = now
    expect(prepaid({ hasCredits: false, unlimited: true, checkedAt })).toEqual([
      { label: 'prepaid', value: 'Unlimited' },
    ])
    expect(
      prepaid({ hasCredits: true, unlimited: false, balance: 87.4, checkedAt }),
    ).toEqual([{ label: 'prepaid', value: '87 credits' }])
    expect(
      prepaid({ hasCredits: true, unlimited: false, balance: 0, checkedAt }),
    ).toEqual([{ label: 'prepaid', value: 'Available' }])
    expect(prepaid({ hasCredits: true, unlimited: false, checkedAt })).toEqual([
      { label: 'prepaid', value: 'Available' },
    ])
    // No credits, no reading of them, or a record the file mangled: no row.
    for (const credits of [
      { hasCredits: false, unlimited: false, balance: 50, checkedAt },
      undefined,
      { hasCredits: 'yes', unlimited: true },
      'Unlimited',
    ])
      expect(prepaid(credits)).toEqual([])
    // The prepaid row sits between the budget and the reset-credit count.
    expect(
      getAccountMetadataRows(
        2,
        {
          limit: 10,
          used: 1,
          remaining: 9,
          usedPercent: 10,
          remainingPercent: 90,
          unit: 'credit',
          reached: false,
        },
        'Unlimited',
      ).map((row) => row.label),
    ).toEqual(['credits', 'prepaid', 'resets'])
  })

  test('the account a session is using on its prepaid credits names that on its prepaid row', () => {
    const credits = {
      hasCredits: true,
      unlimited: false,
      balance: 12,
      checkedAt: now,
    }
    const window = (usedPercent: number) => ({
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
      checkedAt: now,
    })
    const onCredits: AccountQuota = { primary: window(100), credits }
    expect(accountServesOnCredits(onCredits, now)).toBe(true)
    // Free quota left, credits not usable, or the spending cap reached: the
    // account is not serving on credits.
    for (const quota of [
      { primary: window(40), credits },
      { primary: window(100), credits: { ...credits, balance: 0 } },
      {
        primary: window(100),
        credits: { ...credits, checkedAt: now - 20 * 60_000 },
      },
      { primary: window(100) },
      {
        primary: window(100),
        credits,
        spendControl: {
          limit: 10,
          used: 10,
          remaining: 0,
          usedPercent: 100,
          remainingPercent: 0,
          reached: true,
          resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
        },
      },
    ] as AccountQuota[])
      expect(accountServesOnCredits(quota, now)).toBe(false)
    expect(
      getAccountMetadataRows(undefined, undefined, '12 credits', true),
    ).toEqual([{ label: 'serving on credits', value: '12 credits' }])
    expect(getAccountMetadataRows(undefined, undefined, '12 credits')).toEqual([
      { label: 'prepaid', value: '12 credits' },
    ])
  })

  test('a drawer apply sends the sessionId on its RPC request', () => {
    expect(
      buildApplyRequest(
        { command: 'openai', sectionId: 'session', actionId: 'clear-pin' },
        'session-a',
      ),
    ).toEqual({
      command: 'openai',
      sectionId: 'session',
      actionId: 'clear-pin',
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

describe('collapsed sidebar: one line per account', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0)
  const quota = (used: number, ageMs = 0) => ({
    checkedAt: now - ageMs,
    primary: {
      usedPercent: used,
      remainingPercent: 100 - used,
      windowMinutes: 300,
      checkedAt: now - ageMs,
    },
    secondary: {
      usedPercent: 10,
      remainingPercent: 90,
      windowMinutes: 10080,
      checkedAt: now - ageMs,
    },
  })
  const fallback = (id: string, used: number | null, extra = {}) => ({
    id,
    label: id.toUpperCase(),
    enabled: true,
    quota: used === null ? null : quota(used),
    killed: false,
    ...extra,
  })
  const base: SidebarState = {
    main: { quota: quota(42), killed: false },
    fallbacks: [fallback('spare', 20), fallback('work', null)],
    activeId: 'spare',
    route: 'main-first',
    lastUpdated: now,
  }

  test('lists main and every enabled fallback in placement order, the session account active', () => {
    expect(getCollapsedAccountLines(base, { now })).toEqual([
      {
        id: 'main',
        name: 'main',
        killed: false,
        active: false,
        stale: false,
        text: '5h 58% · 7d 90% left',
      },
      {
        id: 'spare',
        name: 'SPARE',
        killed: false,
        active: true,
        stale: false,
        text: '5h 80% · 7d 90% left',
      },
      {
        id: 'work',
        name: 'WORK',
        killed: false,
        active: false,
        stale: false,
        text: null,
      },
    ])
    const last = getCollapsedAccountLines(
      { ...base, route: 'fallback-first' },
      { now },
    )
    expect(last.map((line) => line.id)).toEqual(['spare', 'work', 'main'])
  })

  test('skips disabled fallbacks, and with the fallback section hidden keeps only main and the active one', () => {
    const state = {
      ...base,
      fallbacks: [...base.fallbacks, fallback('off', 5, { enabled: false })],
    }
    expect(
      getCollapsedAccountLines(state, { now }).map((line) => line.id),
    ).toEqual(['main', 'spare', 'work'])
    expect(
      getCollapsedAccountLines(state, { now, showFallbacks: false }).map(
        (line) => line.id,
      ),
    ).toEqual(['main', 'spare'])
  })

  test('vault mode lists only the vault accounts, in placement order', () => {
    const state: SidebarState = {
      ...base,
      main: { quota: null, killed: false },
      fallbacks: [],
      activeId: 'vault:b',
      vaultAccounts: [
        fallback('vault:a', 30),
        {
          ...fallback('vault:b', 60),
          credentialId: 'chatgpt:openai',
        },
      ],
    }
    const lines = getCollapsedAccountLines(state, { now })
    expect(lines.map((line) => [line.id, line.active])).toEqual([
      ['vault:b', true],
      ['vault:a', false],
    ])
  })

  test('a stale reading is marked stale and its narrow text carries no age', () => {
    const [main] = getCollapsedAccountLines(
      { ...base, main: { quota: quota(42, 3 * 60 * 60_000), killed: false } },
      { now },
    )
    expect(main?.stale).toBe(true)
    expect(main?.text).toBe('5h 58% · 7d 90% left')
  })

  test('labels are cut with an ellipsis to the room left, never past it', () => {
    expect(fitCollapsedLabel('Spare', 5)).toBe('Spare')
    expect(fitCollapsedLabel('Spare', 4)).toBe('Spa…')
    expect(fitCollapsedLabel('Spare', 1)).toBe('…')
    expect(fitCollapsedLabel('Spare', 0)).toBe('')
    expect(fitCollapsedLabel('テスト名前', 5)).toBe('テス…')
  })
})

describe('collapsed sidebar frame on OpenCode 1 and OpenCode 2', () => {
  test('renders one line per account with whole quota text in a 42-column frame', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--conditions=browser',
        '--preload',
        '@opentui/solid/runtime-plugin-support',
        'src/tests/fixtures/collapsed-sidebar-render.ts',
      ],
      {
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain('collapsed-sidebar-render passed')
  }, 30_000)
})

describe('expanded sidebar quota rows', () => {
  const row = { label: '7d ', barWidth: 10, figure: ' 100% left' }

  test('a narrow row drops the reset first, then shortens the bar, then drops it', () => {
    const at = (columns: number) =>
      fitQuotaRow({ ...row, columns, resetText: '6d23h' })
    // Label 3 + bar 10 + figure 10 + one blank cell + reset 5 = 29.
    expect(at(29)).toEqual({ barCells: 10, showReset: true })
    expect(at(28)).toEqual({ barCells: 10, showReset: false })
    expect(at(23)).toEqual({ barCells: 10, showReset: false })
    expect(at(22)).toEqual({ barCells: 9, showReset: false })
    expect(at(16)).toEqual({ barCells: 3, showReset: false })
    expect(at(15)).toEqual({ barCells: 0, showReset: false })
    // Not measured yet: everything is drawn.
    expect(at(0)).toEqual({ barCells: 10, showReset: true })
    expect(fitQuotaRow({ ...row, columns: 40 })).toEqual({
      barCells: 10,
      showReset: false,
    })
  })
})

describe('expanded sidebar frame on OpenCode 1 and OpenCode 2', () => {
  test('quota rows stay on one line with a space before the reset at every width from 42 to 18 columns', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--conditions=browser',
        '--preload',
        '@opentui/solid/runtime-plugin-support',
        'src/tests/fixtures/expanded-quota-rows-render.ts',
      ],
      {
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain('expanded-quota-rows-render passed')
  }, 30_000)
})
