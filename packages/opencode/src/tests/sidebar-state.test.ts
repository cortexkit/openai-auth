import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireRefreshFileLock } from '../core/refresh-file-lock'
import {
  ACTIVE_ROUTING_MAX_AGE_MS,
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  formatWindowLabel,
  getCollapsedQuotaSummary,
  getPresentQuotaWindows,
  getSidebarState,
  getSidebarStateFile,
  isUsableRoutingEntry,
  normalizeSidebarState,
  pruneActiveRouting,
  removeSidebarActiveRouting,
  resolveActiveAccount,
  type SidebarAccountState,
  type SidebarState,
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

const quota = (used: number): AccountQuota => ({
  primary: { usedPercent: used, remainingPercent: 100 - used },
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
    expect(result.fallbacks).toHaveLength(1)
    const fb0 = result.fallbacks[0]!
    expect(fb0.id).toBe('fb1')
    expect(fb0.label).toBe('work')
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
