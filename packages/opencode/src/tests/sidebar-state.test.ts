import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  formatWindowLabel,
  getCollapsedQuotaSummary,
  getPresentQuotaWindows,
  getSidebarState,
  getSidebarStateFile,
  normalizeSidebarState,
  resolveActiveAccount,
  type SidebarAccountState,
  type SidebarState,
  setSidebarState,
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

  test('uses the stable slot only as a fallback for old snapshots', () => {
    expect(formatWindowLabel(undefined, 'primary')).toBe('primary')
    expect(formatWindowLabel(undefined, 'secondary')).toBe('secondary')
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

  test('old snapshots use slot labels and do not invent pacing rulers', () => {
    const rows = getPresentQuotaWindows({
      primary: { usedPercent: 20, remainingPercent: 80 },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'primary',
      label: 'primary',
      windowMs: null,
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
