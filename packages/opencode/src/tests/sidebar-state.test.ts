import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { acquireRefreshFileLock } from '../core/refresh-file-lock'
import { flushForTest, setLogLevel } from '../logger'
import {
  ACTIVE_ROUTING_MAX_AGE_MS,
  type AccountQuota,
  clearSidebarStickyAssignment,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  exhaustedQuotaResetAt,
  formatWindowLabel,
  getCollapsedQuotaSummary,
  getPresentQuotaWindows,
  getSidebarState,
  getSidebarStateFile,
  hashSidebarSessionId,
  isQuotaExhausted,
  isUsableRoutingEntry,
  normalizeSidebarState,
  pruneActiveRouting,
  pruneStickyAssignments,
  removeSidebarActiveRouting,
  resolveActiveAccount,
  resolveSessionSidebarRouting,
  resolveSidebarStickyAssignment,
  type SidebarAccountState,
  type SidebarState,
  STICKY_ASSIGNMENT_MAX_ENTRIES,
  setSidebarLegacyRouting,
  setSidebarMachineState,
  setSidebarState,
  upsertSidebarActiveRouting,
} from '../sidebar-state'
import { FLOOR_SIDEBAR_STATE_FILE } from './setup-env.ts'

// computeQuotaPacing takes an explicit windowMs, independent of the slot
// carrying it — these are test-local reference durations, not the
// production label/pacing ruler (which derives from window length).
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

const quota = (used: number, checkedAt?: number): AccountQuota => ({
  primary: {
    usedPercent: used,
    remainingPercent: 100 - used,
    ...(checkedAt === undefined ? {} : { checkedAt }),
  },
  secondary: { usedPercent: used, remainingPercent: 100 - used },
})

const main = (
  q: AccountQuota | null,
  killed = false,
): SidebarState['main'] => ({ quota: q, killed })

const fb = (
  overrides: Partial<SidebarAccountState> & { id: string },
): SidebarAccountState => ({
  label: undefined,
  quota: null,
  killed: false,
  enabled: true,
  ...overrides,
})

function make(overrides: Partial<SidebarState>): SidebarState {
  return { ...DEFAULT_SIDEBAR_STATE, ...overrides }
}

// ---------------------------------------------------------------------------
// normalizeSidebarState / getSidebarState — malformed-input hardening
//
// These guard the fix for the crash: `state().main.quota` / `state().fallbacks.filter`
// threw when getSidebarState() returned a partial/old/malformed file without
// validating shape. normalizeSidebarState() must guarantee a well-formed
// SidebarState for every possible input.
// ---------------------------------------------------------------------------

describe('normalizeSidebarState', () => {
  // (a) empty object — no main, no fallbacks
  test('empty object {} returns well-formed default shape', () => {
    const result = normalizeSidebarState({})
    expect(result.main).toBeDefined()
    expect(result.main.quota).toBeNull()
    expect(result.main.killed).toBe(false)
    expect(Array.isArray(result.fallbacks)).toBe(true)
    expect(result.fallbacks).toHaveLength(0)
    expect(result.route).toBe('main')
    expect(result.lastUpdated).toBe(0)
  })

  // (b) exact crash trigger — arbitrary keys, no main key
  test('{"SENTINEL":true} (exact crash trigger) returns well-formed default shape', () => {
    const result = normalizeSidebarState({ SENTINEL: true })
    expect(result.main).toBeDefined()
    expect(result.main.quota).toBeNull()
    expect(result.main.killed).toBe(false)
    expect(Array.isArray(result.fallbacks)).toBe(true)
  })

  // (c) main present but no quota field
  test('{"main":{}} — main present but no quota — fills in quota:null, killed:false', () => {
    const result = normalizeSidebarState({ main: {} })
    expect(result.main.quota).toBeNull()
    expect(result.main.killed).toBe(false)
  })

  test('main account identity is preserved only when it is a string', () => {
    const valid = normalizeSidebarState({
      main: { quota: null, mainAccountId: 'chatgpt-main' },
    })
    const malformed = normalizeSidebarState({
      main: { quota: null, mainAccountId: 42 },
    })

    expect(valid.main.mainAccountId).toBe('chatgpt-main')
    expect(malformed.main.mainAccountId).toBeUndefined()
  })

  test('fallback account identity is preserved only when it is a string', () => {
    const result = normalizeSidebarState({
      fallbacks: [
        { id: 'fb1', accountId: 'chatgpt-fb1' },
        { id: 'fb2', accountId: 42 },
      ],
    })

    expect(result.fallbacks[0]?.accountId).toBe('chatgpt-fb1')
    expect(result.fallbacks[1]?.accountId).toBeUndefined()
  })

  // (d) fallbacks is a non-array value
  test('{"fallbacks":"notarray"} — fallbacks coerced to []', () => {
    const result = normalizeSidebarState({ fallbacks: 'notarray' })
    expect(Array.isArray(result.fallbacks)).toBe(true)
    expect(result.fallbacks).toHaveLength(0)
  })

  // (e) non-object primitives
  test('"hello" (string) returns DEFAULT_SIDEBAR_STATE', () => {
    const result = normalizeSidebarState('hello')
    expect(result).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  test('42 (number) returns DEFAULT_SIDEBAR_STATE', () => {
    const result = normalizeSidebarState(42)
    expect(result).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  test('null returns DEFAULT_SIDEBAR_STATE', () => {
    const result = normalizeSidebarState(null)
    expect(result).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  // (f) valid full state round-trips unchanged
  test('valid full state round-trips with all fields preserved', () => {
    const full: SidebarState = {
      main: {
        quota: {
          primary: {
            usedPercent: 42,
            remainingPercent: 58,
            windowMinutes: 10_080,
          },
          secondary: { usedPercent: 17, remainingPercent: 83 },
        },
        mainAccountId: 'chatgpt-main',
        killed: true,
        quotaBackedOff: true,
        quotaBackoffUntil: 1234567890,
        refreshBackedOff: false,
        refreshBackoffUntil: 9876543210,
        resetCredits: 4,
      },
      fallbacks: [
        {
          id: 'fb1',
          label: 'work',
          accountId: 'chatgpt-fb1',
          quota: { primary: { usedPercent: 5, remainingPercent: 95 } },
          killed: false,
          enabled: true,
          resetCredits: 2,
        },
      ],
      activeId: 'fb1',
      route: 'fallback',
      activeRouting: {
        'sess-fb1': {
          activeId: 'fb1',
          route: 'fallback',
          updatedAt: 1718000000000,
        },
      },
      planType: 'pro',
      credits: 100,
      lastUpdated: 1718000000000,
    }
    const result = normalizeSidebarState(full)
    expect(result.main.quota?.primary?.usedPercent).toBe(42)
    expect(result.main.quota?.primary?.windowMinutes).toBe(10_080)
    expect(result.main.quota?.secondary?.usedPercent).toBe(17)
    expect(result.main.killed).toBe(true)
    expect(result.main.quotaBackedOff).toBe(true)
    expect(result.main.quotaBackoffUntil).toBe(1234567890)
    expect(result.main.refreshBackedOff).toBe(false)
    expect(result.main.refreshBackoffUntil).toBe(9876543210)
    expect(result.main.resetCredits).toBe(4)
    expect(result.main.mainAccountId).toBe('chatgpt-main')
    expect(result.fallbacks).toHaveLength(1)
    const fb0 = result.fallbacks[0]!
    expect(fb0.id).toBe('fb1')
    expect(fb0.label).toBe('work')
    expect(fb0.accountId).toBe('chatgpt-fb1')
    expect(fb0.resetCredits).toBe(2)
    expect(result.activeId).toBe('fb1')
    expect(result.route).toBe('fallback')
    expect(result.activeRouting).toEqual({
      'sess-fb1': {
        activeId: 'fb1',
        route: 'fallback',
        updatedAt: 1718000000000,
      },
    })
    expect(result.planType).toBe('pro')
    expect(result.credits).toBe(100)
    expect(result.lastUpdated).toBe(1718000000000)
  })

  test('normalizes reset credits independently for main and fallback accounts', () => {
    const valid = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      main: {
        quota: {
          primary: {
            usedPercent: 20,
            remainingPercent: 80,
            windowMinutes: 10_080,
          },
        },
        killed: false,
        resetCredits: 4,
      },
      fallbacks: [
        {
          id: 'fb1',
          quota: null,
          killed: false,
          enabled: true,
          resetCredits: 2,
        },
      ],
    })
    expect(valid.main.quota?.primary?.windowMinutes).toBe(10_080)
    expect(valid.main.resetCredits).toBe(4)
    expect(valid.fallbacks[0]?.resetCredits).toBe(2)

    const malformed = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      main: {
        quota: null,
        killed: false,
        resetCredits: Number.POSITIVE_INFINITY,
      },
      fallbacks: [
        {
          id: 'fb1',
          quota: null,
          killed: false,
          enabled: true,
          resetCredits: -1,
        },
      ],
      resetCredits: '4',
    })
    expect(malformed.main.resetCredits).toBeUndefined()
    expect(malformed.fallbacks[0]?.resetCredits).toBeUndefined()
    expect(
      (malformed as SidebarState & { resetCredits?: number }).resetCredits,
    ).toBeUndefined()
  })

  test('preserves valid active routing entries by session id', () => {
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      activeRouting: {
        'sess-main': {
          activeId: 'main',
          route: 'main-first',
          updatedAt: 100,
        },
        'sess-fallback': {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: 200,
        },
      },
    })

    expect(result.activeRouting).toEqual({
      'sess-main': {
        activeId: 'main',
        route: 'main-first',
        updatedAt: 100,
      },
      'sess-fallback': {
        activeId: 'fallback-1',
        route: 'fallback-first',
        updatedAt: 200,
      },
    })
  })

  test('drops malformed active routing entries without rejecting valid siblings', () => {
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      activeRouting: {
        valid: { activeId: 'main', route: 'main-first', updatedAt: 100 },
        missingActive: { route: 'main-first', updatedAt: 100 },
        wrongRoute: { activeId: 'main', route: 7, updatedAt: 100 },
        infiniteTime: {
          activeId: 'main',
          route: 'main-first',
          updatedAt: Number.POSITIVE_INFINITY,
        },
        scalar: 'main',
      },
    })

    expect(result.activeRouting).toEqual({
      valid: { activeId: 'main', route: 'main-first', updatedAt: 100 },
    })
  })

  test('omits active routing for old files and non-object values', () => {
    expect(
      normalizeSidebarState(DEFAULT_SIDEBAR_STATE).activeRouting,
    ).toBeUndefined()
    expect(
      normalizeSidebarState({
        ...DEFAULT_SIDEBAR_STATE,
        activeRouting: ['sess-main'],
      }).activeRouting,
    ).toBeUndefined()
  })

  test('old files without active routing retain legacy active id and route', () => {
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
    expect(result.activeRouting).toBeUndefined()
    expect(result.activeId).toBe('fallback-1')
    expect(result.route).toBe('fallback-first')
  })

  test('normalizes sticky assignments without retaining malformed siblings', () => {
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      stickyAssignments: {
        [hashSidebarSessionId('valid-session')]: {
          accountId: 'fallback-1',
          assignedAt: 100,
          lastSeenAt: 200,
          inputBytes: 300,
          quotaCheckedAt: 400,
        },
        missingAccount: { assignedAt: 100, lastSeenAt: 200, inputBytes: 300 },
        invalidTimestamp: {
          accountId: 'fallback-1',
          assignedAt: Number.NaN,
          lastSeenAt: 200,
          inputBytes: 300,
        },
        negativeBytes: {
          accountId: 'fallback-1',
          assignedAt: 100,
          lastSeenAt: 200,
          inputBytes: -1,
        },
      },
    })

    expect(result.stickyAssignments).toEqual({
      [hashSidebarSessionId('valid-session')]: {
        accountId: 'fallback-1',
        assignedAt: 100,
        lastSeenAt: 200,
        inputBytes: 300,
        quotaCheckedAt: 400,
      },
    })
  })

  test('old files without sticky assignments remain valid', () => {
    expect(
      normalizeSidebarState(DEFAULT_SIDEBAR_STATE).stickyAssignments,
    ).toBeUndefined()
  })
})

describe('sticky assignments', () => {
  const now = 2 * 7 * 24 * 60 * 60 * 1000

  test('hashes session ids without retaining the source identifier', () => {
    expect(hashSidebarSessionId('session-a')).toMatch(/^[a-f0-9]{64}$/)
    expect(hashSidebarSessionId('session-a')).not.toContain('session-a')
    expect(hashSidebarSessionId('session-a')).toBe(
      hashSidebarSessionId('session-a'),
    )
  })

  test('unknown roster keeps fresh fallback pins while expiry and explicit removal still prune', () => {
    const result = pruneStickyAssignments(
      {
        freshFallback: {
          accountId: 'fallback-1',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 1,
        },
        expired: {
          accountId: 'fallback-2',
          assignedAt: 1,
          lastSeenAt: now - 7 * 24 * 60 * 60 * 1000 - 1,
          inputBytes: 2,
        },
        explicitlyRemoved: {
          accountId: 'fallback-3',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 3,
        },
      },
      undefined,
      now,
      'explicitlyRemoved',
    )

    expect(result).toEqual({
      freshFallback: {
        accountId: 'fallback-1',
        assignedAt: now,
        lastSeenAt: now,
        inputBytes: 1,
      },
    })
  })

  test('prunes expired, disabled, and explicitly removed assignments', () => {
    const result = pruneStickyAssignments(
      {
        stale: {
          accountId: 'main',
          assignedAt: 1,
          lastSeenAt: now - 7 * 24 * 60 * 60 * 1000 - 1,
          inputBytes: 1,
        },
        disabled: {
          accountId: 'disabled-fallback',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 2,
        },
        removed: {
          accountId: 'main',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 3,
        },
        keep: {
          accountId: 'main',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 4,
        },
      },
      new Set(['main']),
      now,
      'removed',
    )

    expect(result).toEqual({
      keep: {
        accountId: 'main',
        assignedAt: now,
        lastSeenAt: now,
        inputBytes: 4,
      },
    })
  })

  test('logs pruned sticky assignments by reason without raw session ids', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-prune-log-'))
    const logFile = join(tempDir, 'sidebar.log')
    const originalLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
    await flushForTest()
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    setLogLevel('debug')

    try {
      pruneStickyAssignments(
        {
          'raw-session-account': {
            accountId: 'removed-fallback',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 1,
          },
          'raw-session-expired': {
            accountId: 'main',
            assignedAt: 1,
            lastSeenAt: now - 7 * 24 * 60 * 60 * 1000 - 1,
            inputBytes: 2,
          },
          'raw-session-explicit': {
            accountId: 'main',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 3,
          },
        },
        new Set(['main']),
        now,
        'raw-session-explicit',
      )
      await flushForTest()

      const text = readFileSync(logFile, 'utf8')
      expect(text).toContain('[sidebar] pruned sticky assignments')
      expect(text).toContain('"removed":3')
      expect(text).toContain('"account-not-in-roster":1')
      expect(text).toContain('"expired":1')
      expect(text).toContain('"explicit-removal":1')
      expect(text).not.toContain('raw-session-')
    } finally {
      await flushForTest()
      setLogLevel(undefined)
      if (originalLogFile === undefined) {
        delete process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
      } else {
        process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = originalLogFile
      }
    }
  })

  test('returns a fresh valid sticky assignment without choosing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-resolve-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'fresh-session'
    const assignment = {
      accountId: 'account-a',
      assignedAt: now - 1,
      lastSeenAt: now,
      inputBytes: 128,
      quotaCheckedAt: 10,
    }
    await setSidebarState(
      make({
        stickyAssignments: { [hashSidebarSessionId(sessionId)]: assignment },
        lastUpdated: now,
      }),
      file,
    )

    const result = await resolveSidebarStickyAssignment(
      {
        sessionId,
        requestBytes: 128,
        now,
        validPinnedAccountIds: ['account-a'],
        quotaCheckedAtByAccount: { 'account-a': 10 },
        choose: () => {
          throw new Error('choose must not run for a fresh valid assignment')
        },
      },
      file,
    )

    expect(result).toEqual(assignment)
  })

  test('replaces excluded, expired, and disabled sticky assignments', async () => {
    const cases = [
      {
        name: 'excluded',
        lastSeenAt: now,
        validPinnedAccountIds: ['account-a', 'account-b'],
        excludeAccountIds: ['account-a'],
      },
      {
        name: 'expired',
        lastSeenAt: now - SEVEN_DAY_MS - 1,
        validPinnedAccountIds: ['account-a', 'account-b'],
      },
      {
        name: 'disabled',
        lastSeenAt: now,
        validPinnedAccountIds: ['account-b'],
      },
    ]

    for (const scenario of cases) {
      const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-replace-'))
      const file = join(tempDir, 'sidebar-state.json')
      const sessionId = `${scenario.name}-session`
      await setSidebarState(
        make({
          stickyAssignments: {
            [hashSidebarSessionId(sessionId)]: {
              accountId: 'account-a',
              assignedAt: now - 100,
              lastSeenAt: scenario.lastSeenAt,
              inputBytes: 100,
              quotaCheckedAt: 10,
            },
          },
          lastUpdated: now,
        }),
        file,
      )
      let chooseCalls = 0

      const result = await resolveSidebarStickyAssignment(
        {
          sessionId,
          requestBytes: 200,
          now,
          validPinnedAccountIds: scenario.validPinnedAccountIds,
          ...(scenario.excludeAccountIds
            ? { excludeAccountIds: scenario.excludeAccountIds }
            : {}),
          quotaCheckedAtByAccount: { 'account-a': 10, 'account-b': 20 },
          choose: () => {
            chooseCalls += 1
            return { accountId: 'account-b', quotaCheckedAt: 20 }
          },
        },
        file,
      )

      expect(chooseCalls).toBe(1)
      expect(result).toEqual({
        accountId: 'account-b',
        assignedAt: now,
        lastSeenAt: now,
        inputBytes: 200,
        quotaCheckedAt: 20,
      })
    }
  })

  test('evicts the least recently seen assignment when adding beyond the sticky cap', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-cap-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'current-session'
    const entries = Object.fromEntries(
      Array.from({ length: STICKY_ASSIGNMENT_MAX_ENTRIES }, (_, index) => {
        const entrySessionId = `existing-${index}`
        return [
          hashSidebarSessionId(entrySessionId),
          {
            accountId: 'account-a',
            assignedAt: now - index,
            lastSeenAt: now - index,
            inputBytes: 1,
          },
        ]
      }),
    )
    await setSidebarState(make({ stickyAssignments: entries }), file)

    await resolveSidebarStickyAssignment(
      {
        sessionId,
        requestBytes: 10,
        now,
        validPinnedAccountIds: ['account-a', 'account-b'],
        quotaCheckedAtByAccount: { 'account-a': 10, 'account-b': 20 },
        choose: () => ({ accountId: 'account-b', quotaCheckedAt: 20 }),
      },
      file,
    )

    const assignments = (await getSidebarState(file)).stickyAssignments
    expect(Object.keys(assignments ?? {})).toHaveLength(
      STICKY_ASSIGNMENT_MAX_ENTRIES,
    )
    expect(assignments?.[hashSidebarSessionId('existing-255')]).toBeUndefined()
    expect(assignments?.[hashSidebarSessionId(sessionId)]).toMatchObject({
      accountId: 'account-b',
      lastSeenAt: now,
    })
  })

  test('does not lower sticky assignment input-byte high water', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-high-water-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'high-water-session'
    await setSidebarState(
      make({
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'account-a',
            assignedAt: now - 1,
            lastSeenAt: now,
            inputBytes: 200,
            quotaCheckedAt: 10,
          },
        },
      }),
      file,
    )

    await resolveSidebarStickyAssignment(
      {
        sessionId,
        requestBytes: 100,
        now,
        validPinnedAccountIds: ['account-a'],
        quotaCheckedAtByAccount: { 'account-a': 10 },
        choose: () => {
          throw new Error('choose must not run for a valid assignment')
        },
      },
      file,
    )

    expect(
      (await getSidebarState(file)).stickyAssignments?.[
        hashSidebarSessionId(sessionId)
      ]?.inputBytes,
    ).toBe(200)
  })

  test('raises sticky assignment input-byte high water', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-high-water-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'raise-high-water-session'
    await setSidebarState(
      make({
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'account-a',
            assignedAt: now - 1,
            lastSeenAt: now,
            inputBytes: 100,
            quotaCheckedAt: 10,
          },
        },
      }),
      file,
    )

    const result = await resolveSidebarStickyAssignment(
      {
        sessionId,
        requestBytes: 200,
        now,
        validPinnedAccountIds: ['account-a'],
        quotaCheckedAtByAccount: { 'account-a': 10 },
        choose: () => {
          throw new Error('choose must not run for a valid assignment')
        },
      },
      file,
    )

    expect(result?.inputBytes).toBe(200)
    expect(
      (await getSidebarState(file)).stickyAssignments?.[
        hashSidebarSessionId(sessionId)
      ]?.inputBytes,
    ).toBe(200)
  })

  test('touches sticky assignment last-seen time only after one hour', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-last-seen-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'last-seen-session'
    const initialLastSeenAt = now - 30 * 60 * 1000
    await setSidebarState(
      make({
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'account-a',
            assignedAt: now - 1,
            lastSeenAt: initialLastSeenAt,
            inputBytes: 100,
            quotaCheckedAt: 10,
          },
        },
      }),
      file,
    )

    await resolveSidebarStickyAssignment(
      {
        sessionId,
        requestBytes: 100,
        now,
        validPinnedAccountIds: ['account-a'],
        quotaCheckedAtByAccount: { 'account-a': 10 },
        choose: () => {
          throw new Error('choose must not run for a valid assignment')
        },
      },
      file,
    )
    expect(
      (await getSidebarState(file)).stickyAssignments?.[
        hashSidebarSessionId(sessionId)
      ]?.lastSeenAt,
    ).toBe(initialLastSeenAt)

    const afterOneHour = now + 31 * 60 * 1000
    await resolveSidebarStickyAssignment(
      {
        sessionId,
        requestBytes: 100,
        now: afterOneHour,
        validPinnedAccountIds: ['account-a'],
        quotaCheckedAtByAccount: { 'account-a': 10 },
        choose: () => {
          throw new Error('choose must not run for a valid assignment')
        },
      },
      file,
    )
    expect(
      (await getSidebarState(file)).stickyAssignments?.[
        hashSidebarSessionId(sessionId)
      ]?.lastSeenAt,
    ).toBe(afterOneHour)
  })

  test('clears only one hashed sticky assignment', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-clear-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'session-to-clear'
    const otherSessionId = 'session-to-keep'
    await setSidebarState(
      make({
        activeRouting: {
          routing: { activeId: 'main', route: 'main-first', updatedAt: now },
        },
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'account-a',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 100,
          },
          [hashSidebarSessionId(otherSessionId)]: {
            accountId: 'account-b',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 200,
          },
        },
        lastUpdated: now,
      }),
      file,
    )
    const before = await getSidebarState(file)

    expect(await clearSidebarStickyAssignment(sessionId, file)).toBe(true)
    const after = await getSidebarState(file)
    const {
      stickyAssignments: _beforeAssignments,
      lastUpdated: _beforeUpdated,
      ...beforeRest
    } = before
    const { stickyAssignments, lastUpdated, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)
    expect(lastUpdated).toBeGreaterThan(before.lastUpdated)
    expect(stickyAssignments).toEqual({
      [hashSidebarSessionId(otherSessionId)]: {
        accountId: 'account-b',
        assignedAt: now,
        lastSeenAt: now,
        inputBytes: 200,
      },
    })

    const rawAfterFirstClear = readFileSync(file, 'utf8')
    const serializedAssignments =
      JSON.parse(rawAfterFirstClear).stickyAssignments
    expect(Object.keys(serializedAssignments)).toEqual([
      hashSidebarSessionId(otherSessionId),
    ])
    expect(Object.keys(serializedAssignments)[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(rawAfterFirstClear).not.toContain(sessionId)
    expect(rawAfterFirstClear).not.toContain(otherSessionId)

    expect(await clearSidebarStickyAssignment(sessionId, file)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(rawAfterFirstClear)
  })

  test('concurrent resolution for one new session returns one assignment', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-same-session-'))
    const file = join(tempDir, 'sidebar-state.json')
    const sessionId = 'same-new-session'
    let releaseFirstWrite: (() => void) | undefined
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let firstWriteEntered: (() => void) | undefined
    const firstWriteReached = new Promise<void>((resolve) => {
      firstWriteEntered = resolve
    })
    let chooseCalls = 0
    const input = {
      sessionId,
      requestBytes: 100,
      now,
      validPinnedAccountIds: ['account-a'],
      quotaCheckedAtByAccount: { 'account-a': 10 },
      choose: () => {
        chooseCalls += 1
        return { accountId: 'account-a', quotaCheckedAt: 10 }
      },
    }

    const first = resolveSidebarStickyAssignment(input, file, {
      beforeRecheck: async () => {
        firstWriteEntered?.()
        await firstWriteReleased
      },
    })
    await firstWriteReached
    const second = resolveSidebarStickyAssignment(input, file)
    releaseFirstWrite?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(chooseCalls).toBe(1)
    expect(secondResult).toEqual(firstResult)
    expect(
      Object.keys((await getSidebarState(file)).stickyAssignments ?? {}),
    ).toEqual([hashSidebarSessionId(sessionId)])
  })

  test('disperses a thundering herd through shared pending bytes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-herd-'))
    const file = join(tempDir, 'sidebar-state.json')
    let releaseFirstWrite: (() => void) | undefined
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let firstWriteEntered: (() => void) | undefined
    const firstWriteReached = new Promise<void>((resolve) => {
      firstWriteEntered = resolve
    })
    let secondPendingBytes: ReadonlyMap<string, number> | undefined

    const first = resolveSidebarStickyAssignment(
      {
        sessionId: 'herd-first',
        requestBytes: 400,
        now,
        validPinnedAccountIds: ['account-a', 'account-b'],
        quotaCheckedAtByAccount: { 'account-a': 10, 'account-b': 10 },
        choose: () => ({ accountId: 'account-a', quotaCheckedAt: 10 }),
      },
      file,
      {
        beforeRecheck: async () => {
          firstWriteEntered?.()
          await firstWriteReleased
        },
      },
    )
    await firstWriteReached
    const second = resolveSidebarStickyAssignment(
      {
        sessionId: 'herd-second',
        requestBytes: 250,
        now,
        validPinnedAccountIds: ['account-a', 'account-b'],
        quotaCheckedAtByAccount: { 'account-a': 10, 'account-b': 10 },
        choose: (pendingBytes) => {
          secondPendingBytes = pendingBytes
          return pendingBytes.get('account-a') === 400
            ? { accountId: 'account-b', quotaCheckedAt: 10 }
            : { accountId: 'account-a', quotaCheckedAt: 10 }
        },
      },
      file,
    )
    releaseFirstWrite?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult?.accountId).toBe('account-a')
    expect(secondPendingBytes?.get('account-a')).toBe(400)
    expect(secondResult?.accountId).toBe('account-b')
  })

  test('drops pending bytes when an account has a fresh quota snapshot', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-pending-'))
    const file = join(tempDir, 'sidebar-state.json')
    await setSidebarState(
      make({
        stickyAssignments: {
          [hashSidebarSessionId('prior-session')]: {
            accountId: 'account-a',
            assignedAt: now - 1,
            lastSeenAt: now,
            inputBytes: 400,
            quotaCheckedAt: 10,
          },
        },
      }),
      file,
    )
    let pendingBytes: ReadonlyMap<string, number> | undefined

    const result = await resolveSidebarStickyAssignment(
      {
        sessionId: 'fresh-snapshot-session',
        requestBytes: 100,
        now,
        validPinnedAccountIds: ['account-a', 'account-b'],
        quotaCheckedAtByAccount: { 'account-a': 11, 'account-b': 10 },
        choose: (pending) => {
          pendingBytes = pending
          return pending.get('account-a') === undefined
            ? { accountId: 'account-a', quotaCheckedAt: 11 }
            : { accountId: 'account-b', quotaCheckedAt: 10 }
        },
      },
      file,
    )

    expect(pendingBytes?.get('account-a')).toBeUndefined()
    expect(result?.accountId).toBe('account-a')
  })
})

describe('session sidebar routing with sticky assignments', () => {
  const now = 2 * 7 * 24 * 60 * 60 * 1000

  function stickyState(overrides: Partial<SidebarState> = {}): SidebarState {
    return make({
      route: 'sticky-balanced',
      fallbacks: [
        fb({
          id: 'fallback-1',
          enabled: true,
          killed: false,
          quota: quota(20),
        }),
        fb({
          id: 'fallback-2',
          enabled: true,
          killed: false,
          quota: quota(30),
        }),
      ],
      ...overrides,
    })
  }

  test('uses a usable active routing entry before a sticky pin', () => {
    const sessionId = 'active-routing-wins'
    const result = resolveSessionSidebarRouting(
      stickyState({
        activeRouting: {
          [sessionId]: {
            activeId: 'fallback-1',
            route: 'sticky-balanced',
            updatedAt: now,
          },
        },
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'fallback-2',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 1,
          },
        },
      }),
      sessionId,
      now,
    )

    expect(result).toEqual({ activeId: 'fallback-1', route: 'sticky-balanced' })
  })

  test('uses a hashed usable sticky pin when no active routing entry survives', () => {
    const sessionId = 'hashed-sticky-session'
    const result = resolveSessionSidebarRouting(
      stickyState({
        stickyAssignments: {
          [sessionId]: {
            accountId: 'fallback-1',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 1,
          },
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'fallback-2',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 2,
          },
        },
      }),
      sessionId,
      now,
    )

    expect(result).toEqual({ activeId: 'fallback-2', route: 'sticky-balanced' })
  })

  test('falls back to the existing mode routing when no usable sticky pin exists', () => {
    const sessionId = 'stale-sticky-session'
    const result = resolveSessionSidebarRouting(
      stickyState({
        stickyAssignments: {
          [hashSidebarSessionId(sessionId)]: {
            accountId: 'fallback-2',
            assignedAt: 1,
            lastSeenAt: now - 7 * 24 * 60 * 60 * 1000 - 1,
            inputBytes: 1,
          },
        },
      }),
      sessionId,
      now,
    )

    expect(result).toEqual({ activeId: 'main', route: 'sticky-balanced' })
  })

  test('leaves non-sticky routing modes unchanged even when a sticky pin exists', () => {
    const sessionId = 'non-sticky-session'
    const assignment = {
      [hashSidebarSessionId(sessionId)]: {
        accountId: 'fallback-2',
        assignedAt: now,
        lastSeenAt: now,
        inputBytes: 1,
      },
    }

    expect(
      resolveSessionSidebarRouting(
        stickyState({ route: 'main-first', stickyAssignments: assignment }),
        sessionId,
        now,
      ),
    ).toEqual({ activeId: 'main', route: 'main-first' })
    expect(
      resolveSessionSidebarRouting(
        stickyState({ route: 'fallback-first', stickyAssignments: assignment }),
        sessionId,
        now,
      ),
    ).toEqual({ activeId: 'fallback-1', route: 'fallback-first' })
  })

  test('does not display a sticky pin whose account is exhausted, disabled, or killed', () => {
    const cases = [
      {
        name: 'exhausted',
        fallback: fb({
          id: 'fallback-2',
          enabled: true,
          killed: false,
          quota: {
            primary: {
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: new Date(now + 60_000).toISOString(),
            },
          },
        }),
      },
      {
        name: 'disabled',
        fallback: fb({
          id: 'fallback-2',
          enabled: false,
          killed: false,
          quota: quota(20),
        }),
      },
      {
        name: 'killed',
        fallback: fb({
          id: 'fallback-2',
          enabled: true,
          killed: true,
          quota: quota(20),
        }),
      },
    ]
    for (const scenario of cases) {
      const sessionId = `${scenario.name}-sticky-session`
      const result = resolveSessionSidebarRouting(
        stickyState({
          fallbacks: [
            fb({
              id: 'fallback-1',
              enabled: true,
              killed: false,
              quota: quota(20),
            }),
            scenario.fallback,
          ],
          stickyAssignments: {
            [hashSidebarSessionId(sessionId)]: {
              accountId: 'fallback-2',
              assignedAt: now,
              lastSeenAt: now,
              inputBytes: 1,
            },
          },
        }),
        sessionId,
        now,
      )

      expect(result).toEqual({ activeId: 'main', route: 'sticky-balanced' })
    }
  })
})

describe('getSidebarState — malformed file never throws', () => {
  test('file containing {} returns well-formed state (no throw)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-norm-'))
    const file = join(tempDir, 'sidebar-state.json')
    writeFileSync(file, '{}', 'utf8')

    const savedEnv = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = file
    try {
      const result = await getSidebarState()
      expect(result.main).toBeDefined()
      expect(result.main.quota).toBeNull()
      expect(Array.isArray(result.fallbacks)).toBe(true)
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        savedEnv ?? FLOOR_SIDEBAR_STATE_FILE
    }
  })

  test('file containing {"SENTINEL":true} returns well-formed state (no throw)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-norm-'))
    const file = join(tempDir, 'sidebar-state.json')
    writeFileSync(file, '{"SENTINEL":true}', 'utf8')

    const savedEnv = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = file
    try {
      const result = await getSidebarState()
      expect(result.main).toBeDefined()
      expect(result.main.quota).toBeNull()
      expect(result.main.killed).toBe(false)
      expect(Array.isArray(result.fallbacks)).toBe(true)
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        savedEnv ?? FLOOR_SIDEBAR_STATE_FILE
    }
  })
})

describe('sidebar write failures', () => {
  test('rejects the failed operation but keeps the write queue usable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-write-'))
    const nonDirectory = join(tempDir, 'not-a-directory')
    writeFileSync(nonDirectory, 'blocker', 'utf8')
    const invalidFile = join(nonDirectory, 'sidebar-state.json')
    const validFile = join(tempDir, 'sidebar-state.json')
    const savedEnv = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE

    try {
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = invalidFile
      await expect(setSidebarState(DEFAULT_SIDEBAR_STATE)).rejects.toThrow()

      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = validFile
      await setSidebarState(DEFAULT_SIDEBAR_STATE)
      expect(existsSync(validFile)).toBe(true)
    } finally {
      await drainSidebarWrites()
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        savedEnv ?? FLOOR_SIDEBAR_STATE_FILE
    }
  })
})

describe('resolveActiveAccount', () => {
  test('activeId "main" resolves to the main account', () => {
    const state = make({ activeId: 'main', main: main(quota(20)) })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.name).toBe('main')
    expect(active.quota?.primary?.usedPercent).toBe(20)
    expect(active.killed).toBe(false)
  })

  test('activeId matching an enabled fallback resolves to that fallback (label name)', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [fb({ id: 'fb1', label: 'work', quota: quota(40) })],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('fb1')
    expect(active.name).toBe('work')
    expect(active.quota?.primary?.usedPercent).toBe(40)
  })

  test('fallback without a label uses its id as the name', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [fb({ id: 'fb1', label: undefined, quota: quota(5) })],
    })
    expect(resolveActiveAccount(state).name).toBe('fb1')
  })

  test('activeId matching a DISABLED fallback falls back to main', () => {
    const state = make({
      activeId: 'fb1',
      main: main(quota(12)),
      fallbacks: [
        fb({ id: 'fb1', label: 'work', quota: quota(40), enabled: false }),
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota?.primary?.usedPercent).toBe(12)
  })

  test('undefined activeId resolves to main', () => {
    const state = make({ activeId: undefined, main: main(quota(7)) })
    expect(resolveActiveAccount(state).id).toBe('main')
  })

  test('unmatched activeId resolves to main', () => {
    const state = make({
      activeId: 'ghost',
      main: main(null),
      fallbacks: [fb({ id: 'fb1', label: 'work', quota: quota(40) })],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota).toBeNull()
  })

  test('carries through the killed flag for the active main account', () => {
    const state = make({ activeId: 'main', main: main(quota(95), true) })
    expect(resolveActiveAccount(state).killed).toBe(true)
  })

  test('carries through the killed flag for the active fallback account', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [
        fb({ id: 'fb1', label: 'work', quota: quota(99), killed: true }),
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('fb1')
    expect(active.killed).toBe(true)
  })
})

describe('formatWindowLabel', () => {
  test.each([
    [59, '59m'],
    [60, '1h'],
    [300, '5h'],
    [1_440, '1d'],
    [10_080, '7d'],
  ])('%i minutes formats as %s', (minutes, expected) => {
    expect(formatWindowLabel(minutes, 'primary')).toBe(expected)
  })

  test('preserves historical labels for snapshots without window lengths', () => {
    expect(formatWindowLabel(undefined, 'primary')).toBe('5h')
    expect(formatWindowLabel(undefined, 'secondary')).toBe('7d')
  })
})

describe('getCollapsedQuotaSummary', () => {
  test('renders one 7-day primary window without a phantom 5h label', () => {
    const summary = getCollapsedQuotaSummary({
      primary: {
        usedPercent: 20,
        remainingPercent: 80,
        windowMinutes: 10_080,
      },
    })
    expect(summary.text).toBe('7d: 20%')
  })

  test('renders both present windows from their lengths', () => {
    const summary = getCollapsedQuotaSummary({
      primary: {
        usedPercent: 3.4,
        remainingPercent: 96.6,
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 20.2,
        remainingPercent: 79.8,
        windowMinutes: 10_080,
      },
    })
    expect(summary.text).toBe('5h: 3% 7d: 20%')
  })

  test('returns no text and no rows when no windows are present', () => {
    expect(getCollapsedQuotaSummary(null).text).toBeNull()
    expect(getCollapsedQuotaSummary({}).text).toBeNull()
    expect(getPresentQuotaWindows({})).toEqual([])
  })

  test('old snapshots retain their historical labels and pacing rulers', () => {
    const rows = getPresentQuotaWindows({
      primary: { usedPercent: 20, remainingPercent: 80 },
      secondary: { usedPercent: 30, remainingPercent: 70 },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      key: 'primary',
      label: '5h',
      windowMs: FIVE_HOUR_MS,
    })
    expect(rows[1]).toMatchObject({
      key: 'secondary',
      label: '7d',
      windowMs: SEVEN_DAY_MS,
    })
  })
})

describe('computeQuotaPacing', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0, 0)

  function fiveHourWindow(elapsedMs: number, usedPercent: number) {
    return {
      window: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: new Date(now + FIVE_HOUR_MS - elapsedMs).toISOString(),
      },
      elapsedMs,
    }
  }

  test('reserve: under even-burn pace, lasts until reset', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 4, 5)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing).not.toBeNull()
    expect(pacing?.pacePercent).toBeCloseTo(25, 5)
    expect(pacing?.deltaPercent).toBeCloseTo(-20, 5)
    expect(pacing?.state).toBe('reserve')
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('deficit: over pace, projects runout before reset', () => {
    const elapsed = FIVE_HOUR_MS / 4
    const { window } = fiveHourWindow(elapsed, 50)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.pacePercent).toBeCloseTo(25, 5)
    expect(pacing?.deltaPercent).toBeCloseTo(25, 5)
    expect(pacing?.state).toBe('deficit')
    const start = now - elapsed
    expect(pacing?.runsOutAt).toBe(new Date(start + elapsed * 2).toISOString())
  })

  test('screenshot case: 7d window, 12h elapsed, 17% used', () => {
    const elapsed = 12 * 60 * 60 * 1000
    const window = {
      usedPercent: 17,
      remainingPercent: 83,
      resetsAt: new Date(now + SEVEN_DAY_MS - elapsed).toISOString(),
    }
    const pacing = computeQuotaPacing(window, SEVEN_DAY_MS, now)
    expect(pacing?.deltaPercent).toBeCloseTo(17 - (12 / 168) * 100, 5)
    expect(pacing?.state).toBe('deficit')
    expect(pacing?.runsOutAt).not.toBeNull()
    const runsOutMs = new Date(pacing?.runsOutAt as string).getTime() - now
    const expectedMs = (elapsed * 100) / 17 - elapsed
    expect(runsOutMs).toBeCloseTo(expectedMs, -4)
  })

  test('on-pace when |delta| < 1', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 4, 25.5)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('on-pace')
  })

  test('zero usage is reserve and lasts', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 2, 0)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('reserve')
    expect(pacing?.deltaPercent).toBeCloseTo(-50, 5)
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('projection landing exactly at reset means lasts', () => {
    const elapsed = FIVE_HOUR_MS / 2
    const { window } = fiveHourWindow(elapsed, 50)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('on-pace')
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('null when resetsAt missing or invalid', () => {
    expect(
      computeQuotaPacing(
        { usedPercent: 10, remainingPercent: 90 },
        FIVE_HOUR_MS,
        now,
      ),
    ).toBeNull()
    expect(
      computeQuotaPacing(
        { usedPercent: 10, remainingPercent: 90, resetsAt: 'garbage' },
        FIVE_HOUR_MS,
        now,
      ),
    ).toBeNull()
  })

  test('null in the early-window noise guard', () => {
    const fourMinutes = 4 * 60 * 1000
    const { window } = fiveHourWindow(fourMinutes, 3)
    expect(computeQuotaPacing(window, FIVE_HOUR_MS, now)).toBeNull()
    const oneHour = 60 * 60 * 1000
    const sevenDay = {
      usedPercent: 3,
      remainingPercent: 97,
      resetsAt: new Date(now + SEVEN_DAY_MS - oneHour).toISOString(),
    }
    expect(computeQuotaPacing(sevenDay, SEVEN_DAY_MS, now)).toBeNull()
  })

  test('null when elapsed reaches or exceeds the window', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS, 80)
    expect(computeQuotaPacing(window, FIVE_HOUR_MS, now)).toBeNull()
    const past = {
      usedPercent: 80,
      remainingPercent: 20,
      resetsAt: new Date(now - 1000).toISOString(),
    }
    expect(computeQuotaPacing(past, FIVE_HOUR_MS, now)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Sidebar isolation regression tests
//
// These guard against the confirmed bug where the test suite overwrote the
// operator's live /tmp/opencode-openai-auth/sidebar-state.json.
// ---------------------------------------------------------------------------

describe('sidebar isolation: getSidebarStateFile never returns the live default while the preload floor is active', () => {
  // The DEFAULT_STATE_FILE constant inside sidebar-state.ts points to the
  // operator's live TUI file. With the preload floor active, the env is
  // always set to a temp path, so getSidebarStateFile() must never return
  // the live default.
  const LIVE_DEFAULT = join(
    tmpdir(),
    'opencode-openai-auth',
    'sidebar-state.json',
  )

  test('getSidebarStateFile() returns the floor temp path, not the live default', () => {
    // The preload (setup-env.ts) sets OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    // to a unique temp path before any test runs.
    const resolved = getSidebarStateFile()
    expect(resolved).not.toBe(LIVE_DEFAULT)
    expect(resolved).toBe(FLOOR_SIDEBAR_STATE_FILE)
  })

  test('a write after env restore goes to the floor temp path, not the live default', async () => {
    const tempA = mkdtempSync(join(tmpdir(), 'oai-sb-iso-a-'))
    const fileA = join(tempA, 'sidebar-state.json')

    // Record the mtime of the live default BEFORE the test (it may already
    // exist from a prior run — we only care that THIS test doesn't modify it).
    const { statSync } = await import('node:fs')
    const mtimeBefore = existsSync(LIVE_DEFAULT)
      ? statSync(LIVE_DEFAULT).mtimeMs
      : null

    // Simulate a test's beforeEach: override to a per-test temp path
    const savedEnv = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = fileA

    const state: SidebarState = {
      ...DEFAULT_SIDEBAR_STATE,
      lastUpdated: 1,
    }
    await setSidebarState(state)
    await drainSidebarWrites()

    // Simulate afterEach: restore to the floor (not delete)
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
      savedEnv ?? FLOOR_SIDEBAR_STATE_FILE

    // Write again — should go to the floor, not the live default
    const state2: SidebarState = {
      ...DEFAULT_SIDEBAR_STATE,
      lastUpdated: 2,
    }
    await setSidebarState(state2)
    await drainSidebarWrites()

    // The live default must NOT have been created or modified by this test.
    if (mtimeBefore === null) {
      // It didn't exist before — it must still not exist.
      expect(existsSync(LIVE_DEFAULT)).toBe(false)
    } else {
      // It existed before — its mtime must be unchanged (we didn't touch it).
      const mtimeAfter = statSync(LIVE_DEFAULT).mtimeMs
      expect(mtimeAfter).toBe(mtimeBefore)
    }
  })
})

describe('sidebar isolation: setSidebarState serializes concurrent writes', () => {
  test('5 concurrent writes with different lastUpdated values — last-chained state wins', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-serial-'))
    const file = join(tempDir, 'sidebar-state.json')

    const savedEnv = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = file

    try {
      // Fire 5 concurrent writes — the serialization chain must ensure the
      // last-enqueued write (lastUpdated=5) is what lands on disk.
      const writes = [1, 2, 3, 4, 5].map((n) =>
        setSidebarState({ ...DEFAULT_SIDEBAR_STATE, lastUpdated: n }),
      )
      await Promise.all(writes)
      await drainSidebarWrites()

      const { readFileSync } = await import('node:fs')
      const written = JSON.parse(readFileSync(file, 'utf8')) as SidebarState
      // The last-enqueued write must have landed — no torn/interleaved state.
      expect(written.lastUpdated).toBe(5)
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        savedEnv ?? FLOOR_SIDEBAR_STATE_FILE
    }
  })
})

describe('sidebar atomic write', () => {
  test('writes state atomically and cleans up temp files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-atomic-'))
    const file = join(tempDir, 'sidebar-state.json')

    const savedEnv = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = file

    try {
      const state: SidebarState = {
        ...DEFAULT_SIDEBAR_STATE,
        lastUpdated: 999,
      }
      await setSidebarState(state)
      await drainSidebarWrites()

      const { readFileSync, readdirSync } = await import('node:fs')
      const written = JSON.parse(readFileSync(file, 'utf8')) as SidebarState
      expect(written.lastUpdated).toBe(999)

      // Check that no temp files are left in the directory
      const files = readdirSync(tempDir)
      expect(files).toEqual(['sidebar-state.json'])
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE =
        savedEnv ?? FLOOR_SIDEBAR_STATE_FILE
    }
  })
})

describe('active routing validity and pruning', () => {
  const accounts = [{ id: 'fallback-1', enabled: true }]
  const now = 2 * 60 * 60 * 1000

  test('accepts fresh main and enabled-fallback entries only', () => {
    expect(
      isUsableRoutingEntry(
        { activeId: 'main', route: 'main-first', updatedAt: now },
        accounts,
        now,
      ),
    ).toBe(true)
    expect(
      isUsableRoutingEntry(
        {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: now,
        },
        accounts,
        now,
      ),
    ).toBe(true)
    expect(
      isUsableRoutingEntry(
        {
          activeId: 'fallback-default-enabled',
          route: 'fallback-first',
          updatedAt: now,
        },
        [{ id: 'fallback-default-enabled' }],
        now,
      ),
    ).toBe(true)
    expect(
      isUsableRoutingEntry(
        {
          activeId: 'removed-fallback',
          route: 'fallback-first',
          updatedAt: now,
        },
        accounts,
        now,
      ),
    ).toBe(false)
    expect(
      isUsableRoutingEntry(
        {
          activeId: 'main',
          route: 'main-first',
          updatedAt: now - ACTIVE_ROUTING_MAX_AGE_MS - 1,
        },
        accounts,
        now,
      ),
    ).toBe(false)
  })

  test('drops invalid accounts and an explicitly deleted session', () => {
    const result = pruneActiveRouting(
      {
        keep: { activeId: 'main', route: 'main-first', updatedAt: now },
        removedAccount: {
          activeId: 'removed-fallback',
          route: 'fallback-first',
          updatedAt: now,
        },
        deletedSession: {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
      accounts,
      now,
      'deletedSession',
    )

    expect(result).toEqual({
      keep: { activeId: 'main', route: 'main-first', updatedAt: now },
    })
  })

  test('caps usable entries at the 128 newest', () => {
    const entries = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [
        `sess-${index}`,
        {
          activeId: 'main',
          route: 'main-first',
          updatedAt: now - index,
        },
      ]),
    )
    const result = pruneActiveRouting(entries, accounts, now)
    expect(Object.keys(result ?? {})).toHaveLength(128)
    expect(result?.['sess-0']).toBeDefined()
    expect(result?.['sess-129']).toBeUndefined()
  })
})

test('upsert creates a missing sidebar state directory before locking', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-missing-dir-'))
  const file = join(tempDir, 'missing', 'sidebar-state.json')
  const now = Date.now()

  expect(existsSync(file)).toBe(false)

  await upsertSidebarActiveRouting(
    {
      sessionId: 'sess-a',
      activeId: 'main',
      route: 'main-first',
      updatedAt: now,
    },
    [],
    file,
  )
  await drainSidebarWrites()

  expect(existsSync(file)).toBe(true)
  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeRouting).toEqual({
    'sess-a': { activeId: 'main', route: 'main-first', updatedAt: now },
  })
})

test('upsert preserves fresh fallback pins when the roster is unknown', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-unknown-roster-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const fallbackPinHash = hashSidebarSessionId('fresh-fallback-pin')
  await setSidebarState(
    make({
      stickyAssignments: {
        [fallbackPinHash]: {
          accountId: 'fallback-1',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 1,
        },
      },
    }),
    file,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'request-session',
      activeId: 'main',
      route: 'main-first',
      updatedAt: now,
    },
    undefined,
    file,
  )
  await drainSidebarWrites()

  expect(
    normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
      .stickyAssignments,
  ).toEqual({
    [fallbackPinHash]: {
      accountId: 'fallback-1',
      assignedAt: now,
      lastSeenAt: now,
      inputBytes: 1,
    },
  })
})

test('upsert treats an empty roster as authoritative and prunes fallback pins', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-empty-roster-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const fallbackPinHash = hashSidebarSessionId('empty-roster-fallback-pin')
  await setSidebarState(
    make({
      stickyAssignments: {
        [fallbackPinHash]: {
          accountId: 'fallback-1',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 1,
        },
      },
    }),
    file,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'request-session',
      activeId: 'main',
      route: 'main-first',
      updatedAt: now,
    },
    [],
    file,
  )
  await drainSidebarWrites()

  expect(
    normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
      .stickyAssignments,
  ).toBeUndefined()
})

test('upsert prunes only fallback pins absent from an authoritative roster', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-populated-roster-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const retainedHash = hashSidebarSessionId('retained-fallback-pin')
  const prunedHash = hashSidebarSessionId('pruned-fallback-pin')
  await setSidebarState(
    make({
      stickyAssignments: {
        [retainedHash]: {
          accountId: 'fallback-present',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 1,
        },
        [prunedHash]: {
          accountId: 'fallback-removed',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 2,
        },
      },
    }),
    file,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'request-session',
      activeId: 'main',
      route: 'main-first',
      updatedAt: now,
    },
    [{ id: 'fallback-present', enabled: true }],
    file,
  )
  await drainSidebarWrites()

  expect(
    normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
      .stickyAssignments,
  ).toEqual({
    [retainedHash]: {
      accountId: 'fallback-present',
      assignedAt: now,
      lastSeenAt: now,
      inputBytes: 1,
    },
  })
})

test('removal with an unknown roster preserves other pins and removes its explicit hash', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-unknown-removal-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  await setSidebarState(
    make({
      stickyAssignments: {
        [hashSidebarSessionId('removed-session')]: {
          accountId: 'fallback-1',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 1,
        },
        [hashSidebarSessionId('other-session')]: {
          accountId: 'fallback-2',
          assignedAt: now,
          lastSeenAt: now,
          inputBytes: 2,
        },
      },
    }),
    file,
  )

  await removeSidebarActiveRouting('removed-session', undefined, file)
  await drainSidebarWrites()

  expect(
    normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
      .stickyAssignments,
  ).toEqual({
    [hashSidebarSessionId('other-session')]: {
      accountId: 'fallback-2',
      assignedAt: now,
      lastSeenAt: now,
      inputBytes: 2,
    },
  })
})

test('setSidebarState leaves an existing foreign directory permission unchanged', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-private-'))
  const dir = join(tempDir, 'existing')
  const file = join(dir, 'sidebar-state.json')
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  writeFileSync(file, JSON.stringify(DEFAULT_SIDEBAR_STATE), { mode: 0o644 })
  chmodSync(file, 0o644)

  await setSidebarState(make({ lastUpdated: 1 }), file)
  await drainSidebarWrites()

  expect(statSync(dirname(file)).mode & 0o777).toBe(0o755)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('upserting session B preserves session A and refreshes legacy fields', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-routing-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  await setSidebarState(
    make({
      fallbacks: [fb({ id: 'fallback-1', enabled: true })],
      activeRouting: {
        'sess-a': { activeId: 'main', route: 'main-first', updatedAt: now - 1 },
      },
      lastUpdated: now - 1,
    }),
    file,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'sess-b',
      activeId: 'fallback-1',
      route: 'fallback-first',
      updatedAt: now,
    },
    [{ id: 'fallback-1', enabled: true }],
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeRouting).toEqual({
    'sess-a': { activeId: 'main', route: 'main-first', updatedAt: now - 1 },
    'sess-b': {
      activeId: 'fallback-1',
      route: 'fallback-first',
      updatedAt: now,
    },
  })
  expect(written.activeId).toBe('fallback-1')
  expect(written.route).toBe('fallback-first')
})

test('upsert waits for a foreign writer lock and merges its session entry', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-file-lock-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const accounts = [
    { id: 'fallback-foreign', enabled: true },
    { id: 'fallback-local', enabled: true },
  ]
  const fallbacks = [
    fb({ id: 'fallback-foreign', enabled: true }),
    fb({ id: 'fallback-local', enabled: true }),
  ]
  await setSidebarState(make({ fallbacks, lastUpdated: now }), file)
  const foreignLock = await acquireRefreshFileLock({
    name: 'sidebar-write',
    path: file,
    ttlMs: 10_000,
  })
  if (!foreignLock) throw new Error('failed to acquire foreign writer lock')

  const localWrite = upsertSidebarActiveRouting(
    {
      sessionId: 'local',
      activeId: 'fallback-local',
      route: 'fallback-first',
      updatedAt: now,
    },
    accounts,
    file,
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  writeFileSync(
    file,
    JSON.stringify(
      make({
        fallbacks,
        activeRouting: {
          foreign: {
            activeId: 'fallback-foreign',
            route: 'fallback-first',
            updatedAt: now,
          },
        },
        lastUpdated: now + 1,
      }),
    ),
    'utf8',
  )
  await foreignLock.release()
  await localWrite
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeRouting).toEqual({
    foreign: {
      activeId: 'fallback-foreign',
      route: 'fallback-first',
      updatedAt: now,
    },
    local: {
      activeId: 'fallback-local',
      route: 'fallback-first',
      updatedAt: now,
    },
  })
})

test('upsert re-merges when a foreign session write lands before commit', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-cross-process-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const accounts = [
    { id: 'fallback-foreign', enabled: true },
    { id: 'fallback-local', enabled: true },
  ]
  const fallbacks = [
    fb({ id: 'fallback-foreign', enabled: true }),
    fb({ id: 'fallback-local', enabled: true }),
  ]
  await setSidebarState(make({ fallbacks, lastUpdated: now }), file)
  let injections = 0
  const upsertWithHook = upsertSidebarActiveRouting as unknown as (
    input: Parameters<typeof upsertSidebarActiveRouting>[0],
    routingAccounts: Parameters<typeof upsertSidebarActiveRouting>[1],
    stateFile: string,
    hooks: { beforeRecheck: () => void },
  ) => Promise<void>

  await upsertWithHook(
    {
      sessionId: 'local',
      activeId: 'fallback-local',
      route: 'fallback-first',
      updatedAt: now,
    },
    accounts,
    file,
    {
      beforeRecheck: () => {
        injections += 1
        writeFileSync(
          file,
          JSON.stringify(
            make({
              fallbacks,
              activeRouting: {
                foreign: {
                  activeId: 'fallback-foreign',
                  route: 'fallback-first',
                  updatedAt: now,
                },
              },
              lastUpdated: now + 1,
            }),
          ),
          'utf8',
        )
      },
    },
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(injections).toBe(1)
  expect(written.activeRouting).toEqual({
    foreign: {
      activeId: 'fallback-foreign',
      route: 'fallback-first',
      updatedAt: now,
    },
    local: {
      activeId: 'fallback-local',
      route: 'fallback-first',
      updatedAt: now,
    },
  })
})

test('machine write re-merges a foreign session entry without creating its own', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-machine-cross-process-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const fallbacks = [fb({ id: 'fallback-foreign', enabled: true })]
  const existingRouting = {
    existing: { activeId: 'main', route: 'main-first', updatedAt: now },
  }
  await setSidebarState(
    make({ fallbacks, activeRouting: existingRouting, lastUpdated: now }),
    file,
  )
  let injections = 0
  const setMachineWithHook = setSidebarMachineState as unknown as (
    machineState: Parameters<typeof setSidebarMachineState>[0],
    stateFile: string,
    hooks: { beforeRecheck: () => void },
  ) => Promise<void>

  await setMachineWithHook(
    {
      main: { quota: quota(25), killed: false },
      fallbacks,
      route: 'fallback-first',
      lastUpdated: now,
    },
    file,
    {
      beforeRecheck: () => {
        injections += 1
        writeFileSync(
          file,
          JSON.stringify(
            make({
              fallbacks,
              activeRouting: {
                ...existingRouting,
                foreign: {
                  activeId: 'fallback-foreign',
                  route: 'fallback-first',
                  updatedAt: now,
                },
              },
              lastUpdated: now + 1,
            }),
          ),
          'utf8',
        )
      },
    },
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(injections).toBe(1)
  expect(written.main.quota).toEqual(quota(25))
  expect(written.route).toBe('fallback-first')
  expect(written.activeRouting).toEqual({
    ...existingRouting,
    foreign: {
      activeId: 'fallback-foreign',
      route: 'fallback-first',
      updatedAt: now,
    },
  })
})

test('every polled write path strictly advances the sidebar version at the same wall-clock time', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-version-'))
  const file = join(tempDir, 'sidebar-state.json')
  const fixedNow = 1_700_000_000_000
  const realDateNow = Date.now
  Date.now = () => fixedNow

  try {
    await setSidebarState(make({ lastUpdated: fixedNow }), file)
    await setSidebarMachineState(
      {
        main: { quota: null, killed: false },
        fallbacks: [],
        route: 'main-first',
        lastUpdated: fixedNow,
      },
      file,
    )
    const machineVersion = JSON.parse(readFileSync(file, 'utf8')).lastUpdated

    await upsertSidebarActiveRouting(
      {
        sessionId: 'sess-a',
        activeId: 'main',
        route: 'main-first',
        updatedAt: fixedNow,
      },
      [],
      file,
    )
    const upsertVersion = JSON.parse(readFileSync(file, 'utf8')).lastUpdated

    await setSidebarLegacyRouting(
      { activeId: 'main', route: 'main-first', updatedAt: fixedNow },
      file,
    )
    const legacyVersion = JSON.parse(readFileSync(file, 'utf8')).lastUpdated

    await removeSidebarActiveRouting('sess-a', [], file)
    const removalVersion = JSON.parse(readFileSync(file, 'utf8')).lastUpdated

    expect([
      machineVersion,
      upsertVersion,
      legacyVersion,
      removalVersion,
    ]).toEqual([fixedNow + 1, fixedNow + 2, fixedNow + 3, fixedNow + 4])
  } finally {
    Date.now = realDateNow
    await drainSidebarWrites()
  }
})

test('delayed upsert preserves a newer foreign session entry', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-stale-now-'))
  const file = join(tempDir, 'sidebar-state.json')
  const newerTime = Date.now() - 100
  const delayedRequestTime = newerTime - 100
  const accounts = [
    { id: 'fallback-foreign', enabled: true },
    { id: 'fallback-local', enabled: true },
  ]
  await setSidebarState(
    make({
      activeRouting: {
        foreign: {
          activeId: 'fallback-foreign',
          route: 'fallback-first',
          updatedAt: newerTime,
        },
      },
    }),
    file,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'local',
      activeId: 'fallback-local',
      route: 'fallback-first',
      updatedAt: delayedRequestTime,
    },
    accounts,
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeRouting).toEqual({
    foreign: {
      activeId: 'fallback-foreign',
      route: 'fallback-first',
      updatedAt: newerTime,
    },
    local: {
      activeId: 'fallback-local',
      route: 'fallback-first',
      updatedAt: delayedRequestTime,
    },
  })
})

test('every keyed upsert prunes stale and removed-account siblings', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-upsert-prune-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  await setSidebarState(
    make({
      activeRouting: {
        stale: {
          activeId: 'main',
          route: 'main-first',
          updatedAt: now - ACTIVE_ROUTING_MAX_AGE_MS - 1,
        },
        removedAccount: {
          activeId: 'removed-fallback',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    }),
    file,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'live',
      activeId: 'main',
      route: 'main-first',
      updatedAt: now,
    },
    [],
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeRouting).toEqual({
    live: { activeId: 'main', route: 'main-first', updatedAt: now },
  })
})

test('machine writes preserve routing while retaining reset-credit fields', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-machine-'))
  const file = join(tempDir, 'sidebar-state.json')
  await setSidebarState(
    make({
      activeId: 'fallback-1',
      route: 'fallback-first',
      activeRouting: {
        'sess-a': {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: 100,
        },
      },
    }),
    file,
  )

  await setSidebarMachineState(
    {
      main: { ...main(quota(25)), resetCredits: 4 },
      fallbacks: [fb({ id: 'fallback-1', resetCredits: 2 })],
      route: 'fallback-first',
      lastUpdated: 200,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.resetCredits).toBe(4)
  expect(written.fallbacks[0]?.resetCredits).toBe(2)
  expect(written.activeId).toBe('fallback-1')
  expect(written.activeRouting?.['sess-a']?.activeId).toBe('fallback-1')
})

test('every routing writer preserves sticky assignments', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-rmw-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const stickyAssignments = {
    [hashSidebarSessionId('session-a')]: {
      accountId: 'fallback-1',
      assignedAt: now,
      lastSeenAt: now,
      inputBytes: 128,
    },
  }

  await setSidebarState(
    make({
      fallbacks: [fb({ id: 'fallback-1', enabled: true })],
      stickyAssignments,
    }),
    file,
  )
  await setSidebarMachineState(
    {
      main: main(null),
      fallbacks: [fb({ id: 'fallback-1', enabled: true })],
      route: 'main-first',
      lastUpdated: now,
    },
    file,
  )
  expect((await getSidebarState(file)).stickyAssignments).toEqual(
    stickyAssignments,
  )

  await upsertSidebarActiveRouting(
    {
      sessionId: 'routing-session',
      activeId: 'fallback-1',
      route: 'fallback-first',
      updatedAt: now,
    },
    [{ id: 'fallback-1', enabled: true }],
    file,
  )
  expect((await getSidebarState(file)).stickyAssignments).toEqual(
    stickyAssignments,
  )

  await setSidebarLegacyRouting(
    { activeId: 'main', route: 'main-first', updatedAt: now },
    file,
  )
  expect((await getSidebarState(file)).stickyAssignments).toEqual(
    stickyAssignments,
  )

  await removeSidebarActiveRouting(
    'routing-session',
    [{ id: 'fallback-1', enabled: true }],
    file,
  )
  await drainSidebarWrites()
  expect((await getSidebarState(file)).stickyAssignments).toEqual(
    stickyAssignments,
  )
})

test('routing writers prune disabled and killed sticky assignments', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-sticky-prune-rmw-'))
  const now = Date.now()
  const accounts = [
    { id: 'disabled', enabled: false },
    { id: 'killed', enabled: true, killed: true },
    { id: 'healthy', enabled: true },
  ]
  const fallbacks = accounts.map((account) => fb(account))
  const expectedStickyAssignments = {
    [hashSidebarSessionId('healthy-session')]: {
      accountId: 'healthy',
      assignedAt: now,
      lastSeenAt: now,
      inputBytes: 128,
    },
  }

  async function seed(file: string) {
    await setSidebarState(
      make({
        fallbacks,
        stickyAssignments: {
          [hashSidebarSessionId('disabled-session')]: {
            accountId: 'disabled',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 128,
          },
          [hashSidebarSessionId('killed-session')]: {
            accountId: 'killed',
            assignedAt: now,
            lastSeenAt: now,
            inputBytes: 128,
          },
          ...expectedStickyAssignments,
        },
      }),
      file,
    )
  }

  const machineFile = join(tempDir, 'machine.json')
  await seed(machineFile)
  await setSidebarMachineState(
    {
      main: main(null),
      fallbacks,
      route: 'main-first',
      lastUpdated: now,
    },
    machineFile,
  )
  expect((await getSidebarState(machineFile)).stickyAssignments).toEqual(
    expectedStickyAssignments,
  )

  const upsertFile = join(tempDir, 'upsert.json')
  await seed(upsertFile)
  await upsertSidebarActiveRouting(
    {
      sessionId: 'routing-session',
      activeId: 'healthy',
      route: 'fallback-first',
      updatedAt: now,
    },
    accounts,
    upsertFile,
  )
  expect((await getSidebarState(upsertFile)).stickyAssignments).toEqual(
    expectedStickyAssignments,
  )

  const removeFile = join(tempDir, 'remove.json')
  await seed(removeFile)
  await removeSidebarActiveRouting('routing-session', accounts, removeFile)
  await drainSidebarWrites()
  expect((await getSidebarState(removeFile)).stickyAssignments).toEqual(
    expectedStickyAssignments,
  )
})

test('machine writes cannot clobber fresher main and fallback quota from disk', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-quota-fresh-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const stale = now - 10 * 60_000
  await setSidebarState(
    make({
      main: main(quota(10, now)),
      fallbacks: [fb({ id: 'fallback-1', quota: quota(20, now) })],
      activeRouting: {
        session: {
          activeId: 'fallback-1',
          route: 'fallback-first',
          updatedAt: now,
        },
      },
    }),
    file,
  )

  await setSidebarMachineState(
    {
      main: main(quota(90, stale)),
      fallbacks: [fb({ id: 'fallback-1', quota: quota(80, stale) })],
      route: 'main-first',
      lastUpdated: now + 1,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.quota?.primary).toMatchObject({
    usedPercent: 10,
    checkedAt: now,
  })
  expect(written.fallbacks[0]?.quota?.primary).toMatchObject({
    usedPercent: 20,
    checkedAt: now,
  })
  expect(written.route).toBe('main-first')
  expect(written.activeRouting?.session?.activeId).toBe('fallback-1')
})

test('machine write keeps the existing identity when the existing quota wins the merge (re-login race)', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-identity-keep-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  // On disk: the OLD account's quota with a fresh checkedAt.
  await setSidebarState(
    make({
      main: { ...main(quota(10, now)), mainAccountId: 'account-old' },
      fallbacks: [
        fb({ id: 'fallback-1', accountId: 'fb-old', quota: quota(20, now) }),
      ],
    }),
    file,
  )

  // Incoming: the re-logged-in process has no quota yet (null) but a NEW
  // identity. The existing quota is fresher so it wins the merge — the
  // identity must follow it rather than be overwritten with the new
  // account's id, or a reader would judge the new account by the old
  // account's quota.
  await setSidebarMachineState(
    {
      main: { ...main(null), mainAccountId: 'account-new' },
      fallbacks: [fb({ id: 'fallback-1', accountId: 'fb-new', quota: null })],
      route: 'main-first',
      lastUpdated: now + 1,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.quota?.primary?.usedPercent).toBe(10)
  expect(written.main.mainAccountId).toBe('account-old')
  expect(written.fallbacks[0]?.quota?.primary?.usedPercent).toBe(20)
  expect(written.fallbacks[0]?.accountId).toBe('fb-old')
})

test('machine write carries the incoming identity when the incoming quota wins the merge', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-identity-take-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const stale = now - 10 * 60_000
  // On disk: stale quota under the OLD identity.
  await setSidebarState(
    make({
      main: { ...main(quota(10, stale)), mainAccountId: 'account-old' },
    }),
    file,
  )

  // Incoming: a fresher snapshot under the NEW identity wins the merge, and
  // the identity follows it.
  await setSidebarMachineState(
    {
      main: { ...main(quota(50, now)), mainAccountId: 'account-new' },
      fallbacks: [],
      route: 'main-first',
      lastUpdated: now + 1,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.quota?.primary?.usedPercent).toBe(50)
  expect(written.main.mainAccountId).toBe('account-new')
})

test('concurrent machine writes under different identities never pair an identity with the wrong quota', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-identity-race-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const stale = now - 10 * 60_000
  // Two writers race an account switch: whichever quota wins the freshness
  // merge, its OWN identity must win with it — the new identity can never
  // be paired with the old quota.
  await setSidebarState(
    make({
      main: { ...main(quota(10, stale)), mainAccountId: 'account-a' },
    }),
    file,
  )

  // Writer B lands a FRESHER snapshot — B's quota and B's identity win.
  await setSidebarMachineState(
    {
      main: { ...main(quota(60, now)), mainAccountId: 'account-b' },
      fallbacks: [],
      route: 'main-first',
      lastUpdated: now + 1,
    },
    file,
  )
  await drainSidebarWrites()
  let written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.quota?.primary?.usedPercent).toBe(60)
  expect(written.main.mainAccountId).toBe('account-b')

  // A stale write from A arrives afterwards — it cannot resurrect A's quota
  // over B's fresher snapshot, and cannot attach A's identity to B's quota.
  await setSidebarMachineState(
    {
      main: { ...main(quota(10, stale)), mainAccountId: 'account-a' },
      fallbacks: [],
      route: 'main-first',
      lastUpdated: now + 2,
    },
    file,
  )
  await drainSidebarWrites()
  written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.quota?.primary?.usedPercent).toBe(60)
  expect(written.main.mainAccountId).toBe('account-b')
})

test('machine writes select quota freshness independently per account', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-quota-mixed-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const stale = now - 10 * 60_000
  await setSidebarState(
    make({
      fallbacks: [
        fb({ id: 'fallback-a', quota: quota(10, stale) }),
        fb({ id: 'fallback-b', quota: quota(20, now) }),
      ],
    }),
    file,
  )

  await setSidebarMachineState(
    {
      main: main(null),
      fallbacks: [
        fb({ id: 'fallback-a', quota: quota(30, now) }),
        fb({ id: 'fallback-b', quota: quota(40, stale) }),
      ],
      route: 'fallback-first',
      lastUpdated: now + 1,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(
    written.fallbacks.find((row) => row.id === 'fallback-a')?.quota?.primary
      ?.usedPercent,
  ).toBe(30)
  expect(
    written.fallbacks.find((row) => row.id === 'fallback-b')?.quota?.primary
      ?.usedPercent,
  ).toBe(20)
})

test('valid checkedAt beats missing or invalid values while incoming wins ties without timestamps', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-quota-invalid-'))
  const file = join(tempDir, 'sidebar-state.json')
  const now = Date.now()
  const invalidQuota = {
    primary: {
      usedPercent: 90,
      remainingPercent: 10,
      checkedAt: 'not-a-number',
    },
  } as unknown as AccountQuota
  await setSidebarState(
    make({
      main: main(quota(10, now)),
      fallbacks: [
        fb({ id: 'incoming-valid', quota: invalidQuota }),
        fb({ id: 'disk-valid', quota: quota(20, now) }),
        fb({ id: 'both-missing', quota: quota(30) }),
      ],
    }),
    file,
  )

  await setSidebarMachineState(
    {
      main: main(null),
      fallbacks: [
        fb({ id: 'incoming-valid', quota: quota(40, now) }),
        fb({ id: 'disk-valid', quota: invalidQuota }),
        fb({ id: 'both-missing', quota: quota(50) }),
      ],
      route: 'main-first',
      lastUpdated: now + 1,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.main.quota?.primary?.usedPercent).toBe(10)
  expect(
    written.fallbacks.find((row) => row.id === 'incoming-valid')?.quota?.primary
      ?.usedPercent,
  ).toBe(40)
  expect(
    written.fallbacks.find((row) => row.id === 'disk-valid')?.quota?.primary
      ?.usedPercent,
  ).toBe(20)
  expect(
    written.fallbacks.find((row) => row.id === 'both-missing')?.quota?.primary
      ?.usedPercent,
  ).toBe(50)
})

test('headerless request compatibility write does not create a session entry', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-legacy-'))
  const file = join(tempDir, 'sidebar-state.json')
  await setSidebarState(DEFAULT_SIDEBAR_STATE, file)
  await setSidebarLegacyRouting(
    { activeId: 'fallback-1', route: 'fallback-first', updatedAt: 200 },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeId).toBe('fallback-1')
  expect(written.route).toBe('fallback-first')
  expect(written.activeRouting).toBeUndefined()
})

test('machine refresh cannot replace request-authored legacy active id', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oai-sb-compat-'))
  const file = join(tempDir, 'sidebar-state.json')
  await setSidebarState(DEFAULT_SIDEBAR_STATE, file)
  await setSidebarLegacyRouting(
    { activeId: 'fallback-1', route: 'fallback-first', updatedAt: 100 },
    file,
  )
  await setSidebarMachineState(
    {
      main: { quota: null, killed: false, resetCredits: 4 },
      fallbacks: [],
      route: 'main-first',
      lastUpdated: 200,
    },
    file,
  )
  await drainSidebarWrites()

  const written = normalizeSidebarState(JSON.parse(readFileSync(file, 'utf8')))
  expect(written.activeId).toBe('fallback-1')
  expect(written.route).toBe('main-first')
  expect(written.main.resetCredits).toBe(4)
})

describe('isQuotaExhausted / exhaustedQuotaResetAt', () => {
  const now = 1_750_000_000_000
  const future = new Date(now + 3600_000).toISOString()
  const laterFuture = new Date(now + 7200_000).toISOString()
  const past = new Date(now - 3600_000).toISOString()

  const windowAt = (
    usedPercent: number,
    resetsAt?: string,
  ): AccountQuota['primary'] => ({
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  })

  test('null, undefined, and empty quotas are never exhausted', () => {
    expect(isQuotaExhausted(null, now)).toBe(false)
    expect(isQuotaExhausted(undefined, now)).toBe(false)
    expect(isQuotaExhausted({}, now)).toBe(false)
    expect(exhaustedQuotaResetAt(null, now)).toBeUndefined()
  })

  test('a primary window at 100% with a future reset is exhausted', () => {
    const quota: AccountQuota = { primary: windowAt(100, future) }
    expect(isQuotaExhausted(quota, now)).toBe(true)
    expect(exhaustedQuotaResetAt(quota, now)).toEqual({
      resetsAt: future,
      resetAtMs: Date.parse(future),
    })
  })

  test('an exhausted SECONDARY window alone exhausts the account', () => {
    const quota: AccountQuota = {
      primary: windowAt(20, future),
      secondary: windowAt(100, laterFuture),
    }
    expect(isQuotaExhausted(quota, now)).toBe(true)
    expect(exhaustedQuotaResetAt(quota, now)).toEqual({
      resetsAt: laterFuture,
      resetAtMs: Date.parse(laterFuture),
    })
  })

  test('with both windows exhausted, the earliest future reset wins', () => {
    const quota: AccountQuota = {
      primary: windowAt(100, laterFuture),
      secondary: windowAt(100, future),
    }
    expect(exhaustedQuotaResetAt(quota, now)).toEqual({
      resetsAt: future,
      resetAtMs: Date.parse(future),
    })
  })

  test.each([
    ['usage below 100%', { primary: windowAt(99, future) }],
    ['missing reset', { primary: windowAt(100) }],
    ['malformed reset', { primary: windowAt(100, 'not-a-date') }],
    ['reset already past', { primary: windowAt(100, past) }],
    [
      'malformed usage',
      {
        primary: {
          usedPercent: Number.NaN,
          remainingPercent: 0,
          resetsAt: future,
        },
      },
    ],
  ])('fails open on %s', (_label, quota) => {
    expect(isQuotaExhausted(quota, now)).toBe(false)
    expect(exhaustedQuotaResetAt(quota, now)).toBeUndefined()
  })

  test('an absent window is not applicable, not unknown', () => {
    // Only secondary present and healthy — no primary to judge.
    const quota: AccountQuota = { secondary: windowAt(30, future) }
    expect(isQuotaExhausted(quota, now)).toBe(false)
  })
})
