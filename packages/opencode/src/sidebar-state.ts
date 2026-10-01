export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  checkedAt?: number
  resetsAt?: string
  windowMinutes?: number
}

export interface SpendControlReading {
  limit: number
  used: number
  remaining: number
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  unit?: string
  source?: string
  reached: boolean
}

export interface AccountQuota {
  checkedAt?: number
  primary?: QuotaWindow
  secondary?: QuotaWindow
  spendControl?: SpendControlReading
  // The source reported that no credit budget exists; see OAuthQuotaSnapshot.
  spendControlCleared?: true
  resetCreditsAvailable?: number
}

export type QuotaWindowKey = 'primary' | 'secondary'

const QUOTA_WINDOW_KEYS: readonly QuotaWindowKey[] = ['primary', 'secondary']
const LEGACY_WINDOW_MINUTES: Record<QuotaWindowKey, number> = {
  primary: 300,
  secondary: 10_080,
}

function compactUnit(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 10) / 10)
}

// Derives a short human label ("5h", "1d", "7d") from a window length in
// minutes. Snapshots written before dynamic windows carry no length, so retain
// their historical primary=5h and secondary=7d meanings.
export function formatWindowLabel(
  windowMinutes: number | undefined,
  fallbackKey: QuotaWindowKey,
): string {
  const minutes =
    windowMinutes !== undefined &&
    Number.isFinite(windowMinutes) &&
    windowMinutes > 0
      ? windowMinutes
      : LEGACY_WINDOW_MINUTES[fallbackKey]
  if (minutes < 60) return `${compactUnit(minutes)}m`
  if (minutes < 1_440) return `${compactUnit(minutes / 60)}h`
  return `${compactUnit(minutes / 1_440)}d`
}

export interface PresentQuotaWindow {
  key: QuotaWindowKey
  label: string
  window: QuotaWindow
  windowMs: number | null
}

// Present windows only — an absent slot means "not applicable", not
// "unknown", so it must never synthesize a placeholder row here.
export function getPresentQuotaWindows(
  quota: AccountQuota | null,
): PresentQuotaWindow[] {
  if (!quota) return []
  const rows: PresentQuotaWindow[] = []
  for (const key of QUOTA_WINDOW_KEYS) {
    const window = quota[key]
    if (!window) continue
    const configuredMinutes = window.windowMinutes
    const windowMinutes =
      configuredMinutes !== undefined &&
      Number.isFinite(configuredMinutes) &&
      configuredMinutes > 0
        ? configuredMinutes
        : LEGACY_WINDOW_MINUTES[key]
    rows.push({
      key,
      label: formatWindowLabel(windowMinutes, key),
      window,
      windowMs: windowMinutes * 60_000,
    })
  }
  return rows
}

export interface SidebarAccountState {
  id: string
  label: string | undefined
  /** ChatGPT identity of the account this quota belongs to. */
  accountId?: string
  quota: AccountQuota | null
  killed: boolean
  enabled: boolean
  resetCredits?: number
  custody?: SidebarAccountCustody
}

export type SidebarCustodyState = 'vault' | 'needsLogin' | 'local' | 'inert'

export type SidebarCustodyReason = CustodyInertReason | 'corrupt'

export interface SidebarAccountCustody {
  state: SidebarCustodyState
  reason?: SidebarCustodyReason
  recordVersion?: number
}

export interface ActiveRoutingEntry {
  activeId: string
  route: string
  updatedAt: number
}

export type ActiveRoutingMap = Record<string, ActiveRoutingEntry>

export interface StickyAssignment {
  accountId: string
  wireAccountId?: string
  assignedAt: number
  lastSeenAt: number
  inputBytes: number
  quotaCheckedAt?: number
}

export type StickyAssignmentMap = Record<string, StickyAssignment>

export interface StickyAssignmentChoice {
  accountId: string
  quotaCheckedAt?: number
}

export interface ResolveStickyAssignmentInput {
  sessionId: string
  requestBytes: number
  now: number
  validPinnedAccountIds: readonly string[]
  excludeAccountIds?: readonly string[]
  quotaCheckedAtByAccount: Readonly<Record<string, number | undefined>>
  wireAccountIdByAccount?: Readonly<Record<string, string | undefined>>
  choose: (
    pendingBytes: ReadonlyMap<string, number>,
  ) => StickyAssignmentChoice | undefined
}

export interface SidebarState {
  main: {
    quota: AccountQuota | null
    /** ChatGPT identity of the main account this quota belongs to. */
    mainAccountId?: string
    custody?: SidebarAccountCustody
    killed: boolean
    quotaBackedOff?: boolean
    quotaBackoffUntil?: number
    refreshBackedOff?: boolean
    refreshBackoffUntil?: number
    resetCredits?: number
  }
  fallbacks: SidebarAccountState[]
  /** @deprecated Compatibility field for readers that do not consume activeRouting. */
  activeId: string | undefined
  /** Machine-global routing mode and compatibility value for older readers. */
  route: string
  activeRouting?: ActiveRoutingMap
  stickyAssignments?: StickyAssignmentMap
  planType?: string
  credits?: number
  lastUpdated: number
  /**
   * True when the accounts come from the shared account pool (a migrated
   * install): `main` is then the pool row `main` and `fallbacks` are the
   * other rows in roster order. Absent on any other install.
   */
  accountPool?: boolean
}

import { createHash } from 'node:crypto'
import { constants, copyFileSync, mkdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createSidebarFile,
  type SidebarFile,
  type SidebarFileHooks,
} from '@cortexkit/common-auth/sidebar-file'
import {
  CUSTODY_INERT_REASONS,
  type CustodyInertReason,
  type CustodyVerdict,
} from './core/custody-state'
import { createLogger } from './logger'

const logSb = createLogger('sidebar')

const STATE_FILE_ENV = 'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'
// The file holds session pins that live for seven days, so it belongs in the
// user's state directory, beside the RPC port files, not in a temp folder the
// system cleans. Resolved per call so XDG_STATE_HOME set after load is honoured.
function defaultStateFile(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'cortexkit', 'openai-auth', 'sidebar-state.json')
}
// Where versions before this one kept the file. Read once, never written.
let legacySidebarStateFile = join(
  tmpdir(),
  'opencode-openai-auth',
  'sidebar-state.json',
)
/** Test seam: point the one-time import at a fixture instead of the temp folder. */
export function setLegacySidebarStateFileForTest(file: string): void {
  legacySidebarStateFile = file
  importedDefaultFiles.clear()
}
const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/
export const STICKY_ASSIGNMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const STICKY_ASSIGNMENT_MAX_ENTRIES = 256
const STICKY_ASSIGNMENT_LAST_SEEN_TOUCH_MS = 60 * 60 * 1000

export function hashSidebarSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

function normalizeResetCredits(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function resetCreditsField(value: unknown): { resetCredits?: number } {
  const credits = normalizeResetCredits(value)
  return credits !== undefined ? { resetCredits: credits } : {}
}

const CUSTODY_STATES = new Set<SidebarCustodyState>([
  'vault',
  'needsLogin',
  'local',
  'inert',
])

const CUSTODY_REASONS = new Set<SidebarCustodyReason>([
  ...CUSTODY_INERT_REASONS,
  'corrupt',
])

/**
 * Tolerant reader for the per-fallback `custody` projection. Unknown state
 * or reason values are dropped (NOT replaced with a default — a stale state
 * file with an experimental `vaultHealing` value must not silently render
 * as `local`, it must render as no-projection-at-all). Valid values round-
 * trip byte-identical. The output contains only `state` and `reason`.
 */
function normalizeSidebarCustody(
  value: unknown,
): SidebarAccountCustody | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const c = value as Record<string, unknown>
  if (
    typeof c.state !== 'string' ||
    !CUSTODY_STATES.has(c.state as SidebarCustodyState)
  ) {
    return undefined
  }
  const state = c.state as SidebarCustodyState
  const out: SidebarAccountCustody = { state }
  if (
    typeof c.reason === 'string' &&
    CUSTODY_REASONS.has(c.reason as SidebarCustodyReason)
  ) {
    out.reason = c.reason as SidebarCustodyReason
  }
  return out
}

function normalizeActiveRouting(value: unknown): ActiveRoutingMap | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const normalized: ActiveRoutingMap = {}
  for (const [sessionId, rawEntry] of Object.entries(value)) {
    if (
      rawEntry === null ||
      typeof rawEntry !== 'object' ||
      Array.isArray(rawEntry)
    ) {
      continue
    }
    const entry = rawEntry as Record<string, unknown>
    if (
      typeof entry.activeId !== 'string' ||
      typeof entry.route !== 'string' ||
      typeof entry.updatedAt !== 'number' ||
      !Number.isFinite(entry.updatedAt)
    ) {
      continue
    }
    normalized[sessionId] = {
      activeId: entry.activeId,
      route: entry.route,
      updatedAt: entry.updatedAt,
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeStickyAssignments(
  value: unknown,
): StickyAssignmentMap | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const normalized: StickyAssignmentMap = {}
  for (const [sessionHash, rawAssignment] of Object.entries(value)) {
    if (
      !SESSION_HASH_PATTERN.test(sessionHash) ||
      rawAssignment === null ||
      typeof rawAssignment !== 'object' ||
      Array.isArray(rawAssignment)
    ) {
      continue
    }
    const assignment = rawAssignment as Record<string, unknown>
    if (
      typeof assignment.accountId !== 'string' ||
      assignment.accountId.length === 0 ||
      typeof assignment.assignedAt !== 'number' ||
      !Number.isFinite(assignment.assignedAt) ||
      assignment.assignedAt < 0 ||
      typeof assignment.lastSeenAt !== 'number' ||
      !Number.isFinite(assignment.lastSeenAt) ||
      assignment.lastSeenAt < 0 ||
      typeof assignment.inputBytes !== 'number' ||
      !Number.isFinite(assignment.inputBytes) ||
      assignment.inputBytes < 0
    ) {
      continue
    }
    const quotaCheckedAt = assignment.quotaCheckedAt
    if (
      quotaCheckedAt !== undefined &&
      (typeof quotaCheckedAt !== 'number' ||
        !Number.isFinite(quotaCheckedAt) ||
        quotaCheckedAt < 0)
    ) {
      continue
    }
    const wireAccountId = assignment.wireAccountId
    normalized[sessionHash] = {
      accountId: assignment.accountId,
      assignedAt: assignment.assignedAt,
      lastSeenAt: assignment.lastSeenAt,
      inputBytes: assignment.inputBytes,
      ...(quotaCheckedAt === undefined ? {} : { quotaCheckedAt }),
      ...(typeof wireAccountId === 'string' ? { wireAccountId } : {}),
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function getSidebarStateFile(): string {
  const override = process.env[STATE_FILE_ENV]
  if (override) return override
  const file = defaultStateFile()
  // Every reader and writer resolves the path here, so importing on first
  // resolution covers the TUI, the cache and the write queue alike.
  if (!importedDefaultFiles.has(file)) {
    importedDefaultFiles.add(file)
    importLegacySidebarState(file, legacySidebarStateFile)
  }
  return file
}

const importedDefaultFiles = new Set<string>()

/**
 * Seed the default state file from the old temp-folder copy, once, so pins
 * survive the move. Copy only: older plugin versions still running keep
 * writing the old file until they restart. COPYFILE_EXCL makes two processes
 * racing here harmless, and any failure just means starting with no pins.
 */
function importLegacySidebarState(file: string, legacyFile: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    copyFileSync(legacyFile, file, constants.COPYFILE_EXCL)
  } catch {
    // Absent legacy file, already imported, or unreadable: nothing to carry.
  }
}

export function projectCustodyForSidebar(
  verdict: CustodyVerdict,
): SidebarAccountCustody {
  switch (verdict.kind) {
    case 'LOCAL':
      return { state: 'local' }
    case 'VAULT':
      return { state: 'vault' }
    case 'INERT':
      return { state: 'inert', reason: verdict.reason }
    case 'NEEDS_LOGIN':
      return verdict.reason === 'corrupt'
        ? { state: 'needsLogin', reason: 'corrupt' }
        : { state: 'needsLogin' }
  }
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  main: { quota: null, killed: false },
  fallbacks: [],
  activeId: undefined,
  route: 'main',
  lastUpdated: 0,
}

/**
 * Normalize an arbitrary parsed value into a well-formed SidebarState.
 *
 * JSON.parse + `as SidebarState` is an unchecked cast — a partial, old, or
 * malformed state file passes through and the TUI's `state().main.quota` /
 * `state().fallbacks.filter(...)` throw at runtime. This helper guarantees
 * every required field is present and correctly typed before the value leaves
 * the I/O boundary, so a bad file can never crash the host TUI.
 */
export function normalizeSidebarState(raw: unknown): SidebarState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_SIDEBAR_STATE
  }

  const r = raw as Record<string, unknown>

  // main — must be an object with at least quota and killed
  const rawMain = r.main
  let main: SidebarState['main']
  if (
    rawMain !== null &&
    typeof rawMain === 'object' &&
    !Array.isArray(rawMain)
  ) {
    const m = rawMain as Record<string, unknown>
    main = {
      quota: ('quota' in m ? m.quota : null) as AccountQuota | null,
      killed: typeof m.killed === 'boolean' ? m.killed : false,
      ...(typeof m.mainAccountId === 'string'
        ? { mainAccountId: m.mainAccountId }
        : {}),
      ...(() => {
        const custody = normalizeSidebarCustody(m.custody)
        return custody ? { custody } : {}
      })(),
      // Preserve optional backoff fields if present
      ...(typeof m.quotaBackedOff === 'boolean'
        ? { quotaBackedOff: m.quotaBackedOff }
        : {}),
      ...(typeof m.quotaBackoffUntil === 'number'
        ? { quotaBackoffUntil: m.quotaBackoffUntil }
        : {}),
      ...(typeof m.refreshBackedOff === 'boolean'
        ? { refreshBackedOff: m.refreshBackedOff }
        : {}),
      ...(typeof m.refreshBackoffUntil === 'number'
        ? { refreshBackoffUntil: m.refreshBackoffUntil }
        : {}),
      ...resetCreditsField(m.resetCredits),
    }
  } else {
    main = { quota: null, killed: false }
  }

  // fallbacks — must be an array; keep entries that are objects with a string
  // id, and normalize each entry's inner fields so the TUI never reads a
  // wrong-typed value (e.g. a string `enabled`) off a malformed file.
  const rawFallbacks = r.fallbacks
  const fallbacks: SidebarAccountState[] = Array.isArray(rawFallbacks)
    ? rawFallbacks
        .filter(
          (entry): entry is Record<string, unknown> =>
            entry !== null &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            typeof (entry as Record<string, unknown>).id === 'string',
        )
        .map((e) => {
          const custody = normalizeSidebarCustody(e.custody)
          return {
            id: e.id as string,
            label: typeof e.label === 'string' ? e.label : undefined,
            ...(typeof e.accountId === 'string'
              ? { accountId: e.accountId }
              : {}),
            quota: ('quota' in e ? e.quota : null) as AccountQuota | null,
            killed: typeof e.killed === 'boolean' ? e.killed : false,
            enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
            ...resetCreditsField(e.resetCredits),
            ...(custody ? { custody } : {}),
          }
        })
    : []

  // activeId — string or undefined
  const activeId = typeof r.activeId === 'string' ? r.activeId : undefined

  // route — string, default 'main'
  const route =
    typeof r.route === 'string' ? r.route : DEFAULT_SIDEBAR_STATE.route

  // lastUpdated — number, default 0
  const lastUpdated = typeof r.lastUpdated === 'number' ? r.lastUpdated : 0

  // Optional top-level fields
  const planType = typeof r.planType === 'string' ? r.planType : undefined
  const credits = typeof r.credits === 'number' ? r.credits : undefined
  const activeRouting = normalizeActiveRouting(r.activeRouting)
  const stickyAssignments = normalizeStickyAssignments(r.stickyAssignments)
  return {
    main,
    fallbacks,
    activeId,
    route,
    lastUpdated,
    ...(activeRouting !== undefined ? { activeRouting } : {}),
    ...(stickyAssignments !== undefined ? { stickyAssignments } : {}),
    ...(planType !== undefined ? { planType } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(r.accountPool === true ? { accountPool: true } : {}),
  }
}

export async function getSidebarState(
  stateFile = getSidebarStateFile(),
): Promise<SidebarState> {
  try {
    const raw = await readFile(stateFile, 'utf8')
    return normalizeSidebarState(JSON.parse(raw))
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

export const ACTIVE_ROUTING_MAX_AGE_MS = 60 * 60 * 1000
export const ACTIVE_ROUTING_MAX_ENTRIES = 128

export type SidebarRoutingAccount = {
  id: string
  enabled?: boolean
  killed?: boolean
}

export function isUsableRoutingEntry(
  entry: ActiveRoutingEntry,
  accounts: readonly SidebarRoutingAccount[] | undefined,
  now = Date.now(),
): boolean {
  const fresh =
    entry.updatedAt >= now - ACTIVE_ROUTING_MAX_AGE_MS && entry.updatedAt <= now
  if (!fresh) return false
  if (accounts === undefined) return true
  return (
    entry.activeId === 'main' ||
    accounts.some(
      (account) =>
        account.enabled !== false &&
        account.killed !== true &&
        account.id === entry.activeId,
    )
  )
}

// The credit budget's own exhaustion signal, shared by admission and sticky
// migration so both agree on what "spent" means. `reached` is the provider's
// authoritative boolean — the percentage is only a display approximation — and
// the check fails open on a missing or lapsed reset exactly like a rate-limit
// window, so a stale or corrupt reading never blocks.
export function spendControlExhaustedResetAt(
  quota: AccountQuota | null | undefined,
  now = Date.now(),
): { resetsAt: string; resetAtMs: number } | undefined {
  const spendControl = quota?.spendControl
  if (
    spendControl?.reached !== true ||
    typeof spendControl.resetsAt !== 'string'
  ) {
    return undefined
  }
  const resetAtMs = Date.parse(spendControl.resetsAt)
  if (!Number.isFinite(resetAtMs) || resetAtMs <= now) return undefined
  return { resetsAt: spendControl.resetsAt, resetAtMs }
}

// Earliest future reset among the quota's exhausted windows, or undefined when
// no present window is exhausted. Every present window is evaluated — matching
// the admission policy, which rejects an account when ANY live window is below
// its threshold — and each check fails open: a missing/malformed usage, a
// missing/unparsable reset, or a reset already in the past never counts as
// exhausted, so a stale or corrupt snapshot can never block routing.
export function exhaustedQuotaResetAt(
  quota: AccountQuota | null | undefined,
  now = Date.now(),
): { resetsAt: string; resetAtMs: number } | undefined {
  let earliest: { resetsAt: string; resetAtMs: number } | undefined
  for (const key of QUOTA_WINDOW_KEYS) {
    const window = quota?.[key]
    if (
      typeof window?.resetsAt !== 'string' ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 100
    ) {
      continue
    }
    const resetAtMs = Date.parse(window.resetsAt)
    if (!Number.isFinite(resetAtMs) || resetAtMs <= now) continue
    if (!earliest || resetAtMs < earliest.resetAtMs) {
      earliest = { resetsAt: window.resetsAt, resetAtMs }
    }
  }
  // The credit budget is a third axis on its own reset clock (a month, not
  // 5h/7d), judged by the same shared signal sticky migration uses.
  const spendReset = spendControlExhaustedResetAt(quota, now)
  if (spendReset && (!earliest || spendReset.resetAtMs < earliest.resetAtMs)) {
    earliest = spendReset
  }
  return earliest
}

export function isQuotaExhausted(
  quota: AccountQuota | null | undefined,
  now = Date.now(),
): boolean {
  return exhaustedQuotaResetAt(quota, now) !== undefined
}

export function resolveSessionStickyAccount(
  state: SidebarState,
  sessionId: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!sessionId || state.route !== 'sticky-balanced') return undefined
  const assignment = state.stickyAssignments?.[hashSidebarSessionId(sessionId)]
  if (
    !assignment ||
    assignment.lastSeenAt < now - STICKY_ASSIGNMENT_MAX_AGE_MS
  ) {
    return undefined
  }
  if (assignment.accountId === 'main') {
    return state.main?.killed || isQuotaExhausted(state.main?.quota, now)
      ? undefined
      : 'main'
  }
  const fallback = state.fallbacks?.find(
    (account) => account.id === assignment.accountId,
  )
  if (
    !fallback ||
    fallback.enabled === false ||
    fallback.killed === true ||
    isQuotaExhausted(fallback.quota, now)
  ) {
    return undefined
  }
  return fallback.id
}

export function resolveSessionSidebarRouting(
  state: SidebarState,
  sessionId?: string,
  now = Date.now(),
): { activeId: string; route: string } {
  if (!sessionId) {
    return { activeId: state.activeId ?? 'main', route: state.route }
  }
  const own = sessionId ? state.activeRouting?.[sessionId] : undefined
  const ownQuota =
    own?.activeId === 'main'
      ? state.main.quota
      : state.fallbacks.find((account) => account.id === own?.activeId)?.quota
  if (
    own &&
    isUsableRoutingEntry(own, state.fallbacks, now) &&
    !isQuotaExhausted(ownQuota, now)
  ) {
    return { activeId: own.activeId, route: own.route }
  }

  const stickyAccountId = resolveSessionStickyAccount(state, sessionId, now)
  if (stickyAccountId) {
    return { activeId: stickyAccountId, route: state.route }
  }

  const enabledFallbacks = state.fallbacks.filter(
    (account) => account.enabled && !account.killed,
  )
  const fallback =
    enabledFallbacks.find((account) => !isQuotaExhausted(account.quota, now)) ??
    enabledFallbacks[0]
  return {
    activeId:
      state.route === 'fallback-first' && fallback ? fallback.id : 'main',
    route: state.route,
  }
}

export function pruneActiveRouting(
  activeRouting: ActiveRoutingMap | undefined,
  accounts: readonly SidebarRoutingAccount[] | undefined,
  now = Date.now(),
  removedSessionId?: string,
): ActiveRoutingMap | undefined {
  if (!activeRouting) return undefined
  const kept = Object.entries(activeRouting).filter(
    ([sessionId, entry]) =>
      sessionId !== removedSessionId &&
      isUsableRoutingEntry(entry, accounts, now),
  )
  const bounded =
    kept.length <= ACTIVE_ROUTING_MAX_ENTRIES
      ? kept
      : kept
          .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
          .slice(0, ACTIVE_ROUTING_MAX_ENTRIES)
  return bounded.length > 0 ? Object.fromEntries(bounded) : undefined
}

export function pruneStickyAssignments(
  assignments: StickyAssignmentMap | undefined,
  validAccountIds: ReadonlySet<string> | undefined,
  now = Date.now(),
  removedSessionHash?: string,
): StickyAssignmentMap | undefined {
  if (!assignments) return undefined
  let accountNotInRoster = 0
  let expired = 0
  let explicitRemoval = 0
  const kept: [string, StickyAssignment][] = []
  for (const [sessionHash, assignment] of Object.entries(assignments)) {
    if (sessionHash === removedSessionHash) {
      explicitRemoval += 1
      continue
    }
    if (assignment.lastSeenAt < now - STICKY_ASSIGNMENT_MAX_AGE_MS) {
      expired += 1
      continue
    }
    if (
      validAccountIds !== undefined &&
      !validAccountIds.has(assignment.accountId)
    ) {
      accountNotInRoster += 1
      continue
    }
    kept.push([sessionHash, assignment])
  }
  const removed = accountNotInRoster + expired + explicitRemoval
  if (removed > 0) {
    logSb.debug('pruned sticky assignments', {
      pid: process.pid,
      removed,
      reasons: {
        'account-not-in-roster': accountNotInRoster,
        expired,
        'explicit-removal': explicitRemoval,
      },
    })
  }
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

function limitStickyAssignments(
  assignments: StickyAssignmentMap,
  protectedSessionHash: string,
): StickyAssignmentMap {
  const overflow =
    Object.keys(assignments).length - STICKY_ASSIGNMENT_MAX_ENTRIES
  if (overflow <= 0) return assignments
  const evicted = new Set(
    Object.entries(assignments)
      .filter(([sessionHash]) => sessionHash !== protectedSessionHash)
      .sort(
        ([leftHash, left], [rightHash, right]) =>
          left.lastSeenAt - right.lastSeenAt ||
          leftHash.localeCompare(rightHash),
      )
      .slice(0, overflow)
      .map(([sessionHash]) => sessionHash),
  )
  return Object.fromEntries(
    Object.entries(assignments).filter(
      ([sessionHash]) => !evicted.has(sessionHash),
    ),
  )
}

function stickyAssignmentsEqual(
  left: StickyAssignmentMap | undefined,
  right: StickyAssignmentMap | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const leftEntries = Object.entries(left)
  if (leftEntries.length !== Object.keys(right).length) return false
  return leftEntries.every(([sessionHash, assignment]) =>
    Object.is(right[sessionHash], assignment),
  )
}

function isValidStickyAssignment(
  assignment: StickyAssignment | undefined,
  validPinnedAccountIds: ReadonlySet<string>,
  excludedAccountIds: ReadonlySet<string>,
  now: number,
): assignment is StickyAssignment {
  return (
    assignment !== undefined &&
    validPinnedAccountIds.has(assignment.accountId) &&
    !excludedAccountIds.has(assignment.accountId) &&
    assignment.lastSeenAt >= now - STICKY_ASSIGNMENT_MAX_AGE_MS
  )
}

function stickyAssignmentNeedsMetadataUpdate(
  assignment: StickyAssignment,
  requestBytes: number,
  now: number,
  wireAccountId: string | undefined,
): boolean {
  return (
    requestBytes > assignment.inputBytes ||
    now - assignment.lastSeenAt >= STICKY_ASSIGNMENT_LAST_SEEN_TOUCH_MS ||
    (assignment.wireAccountId === undefined && wireAccountId !== undefined)
  )
}

function hasStickyIdentityMismatch(
  assignment: StickyAssignment,
  wireAccountId: string | undefined,
): boolean {
  // True only when both sides know their ChatGPT account and those accounts
  // differ, which means the slot this session was placed on now holds a
  // different account than it did at placement.
  //
  // An unknown on either side deliberately reports no mismatch. A session is
  // pinned to keep its prompt cache warm, and treating missing data as a
  // change would place sessions again for no reason and throw those caches
  // away — worse than leaving a rare wrong pin in place until real evidence
  // arrives.
  return (
    typeof assignment.wireAccountId === 'string' &&
    typeof wireAccountId === 'string' &&
    assignment.wireAccountId !== wireAccountId
  )
}

function readonlyPendingBytes(
  pendingBytes: Map<string, number>,
): ReadonlyMap<string, number> {
  const snapshot = new Map(pendingBytes)
  const view: ReadonlyMap<string, number> = {
    get size() {
      return snapshot.size
    },
    has: (key: string) => snapshot.has(key),
    get: (key: string) => snapshot.get(key),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (
      callback: (
        value: number,
        key: string,
        map: ReadonlyMap<string, number>,
      ) => void,
      thisArg?: unknown,
    ) => {
      snapshot.forEach((value, key) => {
        callback.call(thisArg, value, key, view)
      })
    },
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
  }
  return Object.freeze(view)
}

function pendingBytesForAssignments(
  assignments: StickyAssignmentMap | undefined,
  quotaCheckedAtByAccount: Readonly<Record<string, number | undefined>>,
  excludedSessionHash?: string,
): ReadonlyMap<string, number> {
  const pendingBytes = new Map<string, number>()
  for (const [sessionHash, assignment] of Object.entries(assignments ?? {})) {
    if (sessionHash === excludedSessionHash) continue
    if (
      assignment.quotaCheckedAt !==
      quotaCheckedAtByAccount[assignment.accountId]
    ) {
      continue
    }
    pendingBytes.set(
      assignment.accountId,
      (pendingBytes.get(assignment.accountId) ?? 0) + assignment.inputBytes,
    )
  }
  return readonlyPendingBytes(pendingBytes)
}

function usableRoutingAccountIds(
  accounts: readonly SidebarRoutingAccount[] | undefined,
): ReadonlySet<string> | undefined {
  if (accounts === undefined) return undefined
  return new Set([
    'main',
    ...accounts
      .filter((account) => account.enabled !== false && account.killed !== true)
      .map((account) => account.id),
  ])
}

// Serialization chain: concurrent calls are queued so a stale background
// write cannot land after a newer one and corrupt the file. It spans every
// state file, as it always has, so drainSidebarWrites waits for all of them.
let sidebarWriteChain: Promise<void> = Promise.resolve()

type SidebarMergeHooks = Pick<SidebarFileHooks, 'beforeRecheck'>

function enqueueSidebarWrite(operation: () => Promise<void>): Promise<void> {
  const result = sidebarWriteChain.then(operation)
  sidebarWriteChain = result.catch(() => {})
  return result
}

// One shared-library sidebar file per path. It takes the 'sidebar-write' lock
// for every write and re-merges when an older, unlocked writer changed the file
// meanwhile. Only this plugin's default directory is made private (0700); a
// directory an operator or caller named keeps its permissions.
const sidebarFiles = new Map<string, SidebarFile<SidebarState>>()

function sidebarFileFor(file: string): SidebarFile<SidebarState> {
  let sidebarFile = sidebarFiles.get(file)
  if (!sidebarFile) {
    sidebarFile = createSidebarFile<SidebarState>({
      path: file,
      defaultValue: DEFAULT_SIDEBAR_STATE,
      normalize: normalizeSidebarState,
      secureDir: file === defaultStateFile(),
      logger: logSb,
    })
    sidebarFiles.set(file, sidebarFile)
  }
  return sidebarFile
}

// Files whose last write failed. A file that keeps failing (a lock another
// process holds, a full or read-only disk) is retried by its writers, so only
// the first failure of a run is logged at warn; the rest go to debug until a
// write succeeds again.
const failingSidebarFiles = new Set<string>()

async function logWriteFailure(
  file: string,
  write: Promise<void>,
): Promise<void> {
  try {
    await write
  } catch (e) {
    const fields = {
      pid: process.pid,
      error: e instanceof Error ? e.message : String(e),
    }
    if (failingSidebarFiles.has(file)) {
      logSb.debug('sidebar write failed again', fields)
    } else {
      failingSidebarFiles.add(file)
      logSb.warn('sidebar write failed', fields)
    }
    throw e
  }
  if (failingSidebarFiles.delete(file)) {
    logSb.info('sidebar write recovered', { pid: process.pid })
  }
}

/**
 * Write sidebar state to disk, serialized through a promise chain so
 * concurrent callers never interleave or let a stale write land last.
 *
 * @param state  The state to persist.
 * @param file   Explicit path override — callers that bind the path at init
 *               time (e.g. the index.ts loader) pass this so late callbacks
 *               always write to the path that was current when the loader ran,
 *               even if the env changes underneath them during tests.
 *               Defaults to getSidebarStateFile() (per-call resolution).
 */
export function setSidebarState(
  state: SidebarState,
  file = getSidebarStateFile(),
): Promise<void> {
  return enqueueSidebarWrite(() =>
    logWriteFailure(
      file,
      sidebarFileFor(file).write(normalizeSidebarState(state)),
    ),
  )
}

function readSidebarState(file: string): Promise<SidebarState> {
  return sidebarFileFor(file).read()
}

function writeMergedSidebarState(
  file: string,
  merge: (latest: SidebarState) => SidebarState | undefined,
  hooks?: SidebarMergeHooks,
): Promise<void> {
  // Every state reaches disk normalized, as each write has always been.
  return logWriteFailure(
    file,
    sidebarFileFor(file).update((latest) => {
      const next = merge(latest)
      return next === undefined ? undefined : normalizeSidebarState(next)
    }, hooks),
  )
}

export type SidebarMachineState = Pick<
  SidebarState,
  'main' | 'fallbacks' | 'planType' | 'credits' | 'lastUpdated' | 'accountPool'
> & { route: string }

// The freshest signal across every timestamp a snapshot carries: either window
// (primary/secondary) or the legacy top-level stamp. A retired primary window
// (null) with a fresh secondary must still outrank an older incoming primary, so
// the comparison takes the max rather than the first present value.
function latestQuotaCheckedAt(quota: AccountQuota | null): number | undefined {
  let latest: number | undefined
  for (const checkedAt of [
    quota?.primary?.checkedAt,
    quota?.secondary?.checkedAt,
    quota?.checkedAt,
  ]) {
    if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
      latest = latest === undefined ? checkedAt : Math.max(latest, checkedAt)
    }
  }
  return latest
}

function freshestQuota(
  incoming: AccountQuota | null,
  existing: AccountQuota | null,
): AccountQuota | null {
  const incomingCheckedAt = latestQuotaCheckedAt(incoming)
  const existingCheckedAt = latestQuotaCheckedAt(existing)
  if (
    existingCheckedAt !== undefined &&
    (incomingCheckedAt === undefined || existingCheckedAt > incomingCheckedAt)
  ) {
    return existing
  }
  return incoming
}

// True when both sides assert the same stable account identity. An unknown
// identity on either side is NOT a confirmed match — merging windows across an
// unconfirmed identity could combine two accounts' quota, so the caller
// whole-picks instead.
function sameAccountIdentity(
  incoming: string | undefined,
  existing: string | undefined,
): boolean {
  return (
    incoming !== undefined && existing !== undefined && incoming === existing
  )
}

// A window's checkedAt when it is a usable timestamp, else undefined — so an
// absent or invalid stamp sorts oldest and a timestamped window always wins
// over an untimestamped one. The optional fallback is the enclosing snapshot's
// checkedAt, used when the window itself carries no usable stamp (files written
// by versions that did not propagate the entry timestamp onto each present
// window): a present window with no stamp is still "live", so it must sort by
// SOME timestamp — the snapshot's is the next-best signal.
function finiteWindowCheckedAt(
  window: QuotaWindow | undefined,
  fallback?: number,
): number | undefined {
  const checkedAt = window?.checkedAt
  if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
    return checkedAt
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return fallback
  }
  return undefined
}

// Fresher of two same-slot windows. When both sides report the window, the
// window's own stamp decides (falling back to each side's snapshot stamp when
// the window itself has none). When the slots disagree on presence, the FRESHER
// snapshot's slot is authoritative — a quota snapshot reports every live window,
// so an absent slot there means the wire retired it, which a stale window on the
// other side must not resurrect (and a fresher snapshot's present window must
// not be dropped by a stale window-less write).
function freshestWindow(
  incoming: QuotaWindow | undefined,
  existing: QuotaWindow | undefined,
  existingSnapshotIsFresher: boolean,
  incomingSnapshotCheckedAt: number | undefined,
  existingSnapshotCheckedAt: number | undefined,
): QuotaWindow | undefined {
  if (incoming && existing) {
    const incomingAt = finiteWindowCheckedAt(
      incoming,
      incomingSnapshotCheckedAt,
    )
    const existingAt = finiteWindowCheckedAt(
      existing,
      existingSnapshotCheckedAt,
    )
    if (
      existingAt !== undefined &&
      (incomingAt === undefined || existingAt > incomingAt)
    ) {
      return existing
    }
    return incoming
  }
  return existingSnapshotIsFresher ? existing : incoming
}

// Merge two same-account snapshots window-by-window: each slot keeps the
// fresher of the two sides, so a newer primary on one side and a newer
// secondary on the other both survive instead of one side's whole snapshot
// replacing the other's. The snapshot stamp becomes the freshest window stamp
// of the merged result. Only safe when both snapshots share an account identity
// (sameAccountIdentity) — an identity switch must whole-pick (freshestQuota) so
// windows from two accounts are never combined.
// The fresher side decides the budget when it knows anything about it: its own
// reading, or its report that no budget exists. Only when it says nothing (a
// header or WebSocket push, which never carries spend control) does the other
// side's reading survive, and even then not if that side reported none.
function mergeSpendControl(
  fresher: AccountQuota,
  older: AccountQuota,
): SpendControlReading | undefined {
  if (fresher.spendControl !== undefined) return fresher.spendControl
  if (fresher.spendControlCleared === true) return undefined
  return older.spendControl
}

function mergeQuotaByWindow(
  incoming: AccountQuota | null,
  existing: AccountQuota | null,
): AccountQuota | null {
  if (!incoming) return existing
  if (!existing) return incoming
  const incomingAt = latestQuotaCheckedAt(incoming)
  const existingAt = latestQuotaCheckedAt(existing)
  const existingSnapshotIsFresher =
    existingAt !== undefined &&
    (incomingAt === undefined || existingAt > incomingAt)
  const primary = freshestWindow(
    incoming.primary,
    existing.primary,
    existingSnapshotIsFresher,
    incoming.checkedAt,
    existing.checkedAt,
  )
  const secondary = freshestWindow(
    incoming.secondary,
    existing.secondary,
    existingSnapshotIsFresher,
    incoming.checkedAt,
    existing.checkedAt,
  )
  const spendControl = existingSnapshotIsFresher
    ? mergeSpendControl(existing, incoming)
    : mergeSpendControl(incoming, existing)
  const spendControlCleared =
    spendControl === undefined &&
    (incoming.spendControlCleared === true ||
      existing.spendControlCleared === true)
  let checkedAt: number | undefined
  for (const stamp of [
    finiteWindowCheckedAt(primary),
    finiteWindowCheckedAt(secondary),
  ]) {
    if (stamp !== undefined) {
      checkedAt = checkedAt === undefined ? stamp : Math.max(checkedAt, stamp)
    }
  }
  // Both budget fields are decided above, so neither may leak in from the
  // spread: an older incoming budget must not survive a fresher "no budget".
  const {
    spendControl: _incomingSpendControl,
    spendControlCleared: _incomingCleared,
    ...incomingRest
  } = incoming
  return {
    ...incomingRest,
    primary,
    secondary,
    ...(spendControl !== undefined ? { spendControl } : {}),
    ...(spendControlCleared ? { spendControlCleared: true as const } : {}),
    checkedAt: checkedAt ?? incoming.checkedAt,
  }
}

export function setSidebarMachineState(
  machineState: SidebarMachineState,
  file = getSidebarStateFile(),
  hooks?: SidebarMergeHooks,
): Promise<void> {
  return enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(
      file,
      (latest) => {
        const latestFallbacks = new Map(
          latest.fallbacks.map((account) => [account.id, account]),
        )
        // A same-identity merge combines the freshest of each window across the
        // two sides; a differing or unknown identity whole-picks the fresher
        // snapshot so windows from two accounts are never combined.
        const mainSameIdentity = sameAccountIdentity(
          machineState.main.mainAccountId,
          latest.main.mainAccountId,
        )
        const mergedMainQuota = mainSameIdentity
          ? mergeQuotaByWindow(machineState.main.quota, latest.main.quota)
          : freshestQuota(machineState.main.quota, latest.main.quota)
        const now = Date.now()
        const stickyAssignments = pruneStickyAssignments(
          latest.stickyAssignments,
          usableRoutingAccountIds(machineState.fallbacks),
          now,
        )
        return {
          ...latest,
          ...machineState,
          main: {
            ...machineState.main,
            quota: mergedMainQuota,
            // On a whole-pick the identity follows the winning snapshot, so a
            // reader never pairs one account's id with another account's quota
            // (a re-login race would otherwise resurrect the stale-account bug).
            // On a same-identity merge both sides already agree, so the incoming
            // id is the shared one.
            mainAccountId: mainSameIdentity
              ? machineState.main.mainAccountId
              : mergedMainQuota === latest.main.quota &&
                  mergedMainQuota !== machineState.main.quota
                ? latest.main.mainAccountId
                : machineState.main.mainAccountId,
          },
          fallbacks: machineState.fallbacks.map((account) => {
            const existing = latestFallbacks.get(account.id)
            const fallbackSameIdentity = sameAccountIdentity(
              account.accountId,
              existing?.accountId,
            )
            const mergedQuota = fallbackSameIdentity
              ? mergeQuotaByWindow(account.quota, existing?.quota ?? null)
              : freshestQuota(account.quota, existing?.quota ?? null)
            return {
              ...account,
              quota: mergedQuota,
              accountId: fallbackSameIdentity
                ? account.accountId
                : mergedQuota === existing?.quota &&
                    mergedQuota !== account.quota
                  ? existing?.accountId
                  : account.accountId,
            }
          }),
          activeId: latest.activeId,
          activeRouting: latest.activeRouting,
          stickyAssignments,
          lastUpdated: Math.max(now, latest.lastUpdated + 1),
          // Taken from the snapshot being written, never carried over from the
          // file: it says where this snapshot's accounts came from.
          accountPool: machineState.accountPool === true ? true : undefined,
        }
      },
      hooks,
    )
  })
}

export function upsertSidebarActiveRouting(
  input: { sessionId: string } & ActiveRoutingEntry,
  accounts: readonly SidebarRoutingAccount[] | undefined,
  file = getSidebarStateFile(),
  hooks?: SidebarMergeHooks,
): Promise<void> {
  return enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(
      file,
      (latest) => {
        const activeRouting = pruneActiveRouting(
          {
            ...latest.activeRouting,
            [input.sessionId]: {
              activeId: input.activeId,
              route: input.route,
              updatedAt: input.updatedAt,
            },
          },
          accounts,
          Date.now(),
        )
        const stickyAssignments = pruneStickyAssignments(
          latest.stickyAssignments,
          usableRoutingAccountIds(accounts),
          Date.now(),
        )
        return {
          ...latest,
          activeId: input.activeId,
          route: input.route,
          activeRouting,
          stickyAssignments,
          lastUpdated: Math.max(Date.now(), latest.lastUpdated + 1),
        }
      },
      hooks,
    )
  })
}

export function setSidebarLegacyRouting(
  input: ActiveRoutingEntry,
  file = getSidebarStateFile(),
): Promise<void> {
  return enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(file, (latest) => ({
      ...latest,
      activeId: input.activeId,
      route: input.route,
      lastUpdated: Math.max(Date.now(), latest.lastUpdated + 1),
    }))
  })
}

export function removeSidebarActiveRouting(
  sessionId: string,
  accounts: readonly SidebarRoutingAccount[] | undefined,
  file = getSidebarStateFile(),
  hooks?: SidebarMergeHooks,
): Promise<void> {
  return enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(
      file,
      (latest) => {
        const now = Date.now()
        const activeRouting = pruneActiveRouting(
          latest.activeRouting,
          accounts,
          now,
          sessionId,
        )
        const stickyAssignments = pruneStickyAssignments(
          latest.stickyAssignments,
          usableRoutingAccountIds(accounts),
          now,
          hashSidebarSessionId(sessionId),
        )
        return {
          ...latest,
          activeRouting,
          stickyAssignments,
          lastUpdated: Math.max(Date.now(), latest.lastUpdated + 1),
        }
      },
      hooks,
    )
  })
}

/**
 * True when the session's recorded pin can be used as-is: still valid for this
 * request, not placed on a slot that now holds a different ChatGPT account,
 * and carrying no metadata that needs refreshing.
 */
function stickyAssignmentIsCurrent(
  existing: StickyAssignment | undefined,
  input: ResolveStickyAssignmentInput,
): existing is StickyAssignment {
  return (
    isValidStickyAssignment(
      existing,
      new Set(input.validPinnedAccountIds),
      new Set(input.excludeAccountIds),
      input.now,
    ) &&
    !hasStickyIdentityMismatch(
      existing,
      input.wireAccountIdByAccount?.[existing.accountId],
    ) &&
    !stickyAssignmentNeedsMetadataUpdate(
      existing,
      input.requestBytes,
      input.now,
      input.wireAccountIdByAccount?.[existing.accountId],
    )
  )
}

export interface StickyAssignmentPlan {
  /** The pin the session should use, or undefined when nothing is eligible. */
  assignment: StickyAssignment | undefined
  /** The state to persist, or undefined when `latest` already records it. */
  next: SidebarState | undefined
}

/**
 * Decide a session's pin from one state snapshot, without touching the file.
 *
 * This is the whole placement decision: prune dead pins, keep a still-valid
 * pin (refreshing its metadata), or place the session afresh through
 * `input.choose` weighted by the bytes other sessions already committed to
 * each account. The locked file merge and the request path both use it, so
 * the two cannot drift apart.
 */
export function planSidebarStickyAssignment(
  latest: SidebarState,
  input: ResolveStickyAssignmentInput,
): StickyAssignmentPlan {
  const sessionHash = hashSidebarSessionId(input.sessionId)
  const validPinnedAccountIds = new Set(input.validPinnedAccountIds)
  const excludedAccountIds = new Set(input.excludeAccountIds)
  const stickyAssignments = pruneStickyAssignments(
    latest.stickyAssignments,
    validPinnedAccountIds,
    input.now,
  )
  const assignmentsPruned = !stickyAssignmentsEqual(
    latest.stickyAssignments,
    stickyAssignments,
  )
  const current = stickyAssignments?.[sessionHash]
  const currentIdentityMismatch =
    current !== undefined &&
    hasStickyIdentityMismatch(
      current,
      input.wireAccountIdByAccount?.[current.accountId],
    )
  if (
    isValidStickyAssignment(
      current,
      validPinnedAccountIds,
      excludedAccountIds,
      input.now,
    ) &&
    !currentIdentityMismatch
  ) {
    const metadataNeedsUpdate = stickyAssignmentNeedsMetadataUpdate(
      current,
      input.requestBytes,
      input.now,
      input.wireAccountIdByAccount?.[current.accountId],
    )
    const assignment = metadataNeedsUpdate
      ? {
          ...current,
          inputBytes: Math.max(current.inputBytes, input.requestBytes),
          ...(current.wireAccountId === undefined &&
          input.wireAccountIdByAccount?.[current.accountId] !== undefined
            ? {
                wireAccountId:
                  input.wireAccountIdByAccount?.[current.accountId],
              }
            : {}),
          ...(input.now - current.lastSeenAt >=
          STICKY_ASSIGNMENT_LAST_SEEN_TOUCH_MS
            ? { lastSeenAt: input.now }
            : {}),
        }
      : current
    if (!assignmentsPruned && !metadataNeedsUpdate) {
      return { assignment, next: undefined }
    }
    return {
      assignment,
      next: {
        ...latest,
        stickyAssignments: {
          ...stickyAssignments,
          [sessionHash]: assignment,
        },
        lastUpdated: Math.max(input.now, latest.lastUpdated + 1),
      },
    }
  }

  const choice = input.choose(
    pendingBytesForAssignments(
      stickyAssignments,
      input.quotaCheckedAtByAccount,
      // Pending bytes weigh how much traffic each account is already
      // committed to, so the session being placed must not weigh its own
      // stale entry: that entry belongs to the account it is moving off,
      // and counting it would bias placement away from a perfectly good
      // destination. Other sessions' entries still count.
      currentIdentityMismatch ? sessionHash : undefined,
    ),
  )
  if (!choice) {
    if (!assignmentsPruned) return { assignment: undefined, next: undefined }
    return {
      assignment: undefined,
      next: {
        ...latest,
        stickyAssignments,
        lastUpdated: Math.max(input.now, latest.lastUpdated + 1),
      },
    }
  }

  const assignment: StickyAssignment = {
    accountId: choice.accountId,
    assignedAt: input.now,
    lastSeenAt: input.now,
    inputBytes: input.requestBytes,
    ...(choice.quotaCheckedAt === undefined
      ? {}
      : { quotaCheckedAt: choice.quotaCheckedAt }),
    ...(input.wireAccountIdByAccount?.[choice.accountId] === undefined
      ? {}
      : {
          wireAccountId: input.wireAccountIdByAccount?.[choice.accountId],
        }),
  }
  return {
    assignment,
    next: {
      ...latest,
      stickyAssignments: limitStickyAssignments(
        {
          ...stickyAssignments,
          [sessionHash]: assignment,
        },
        sessionHash,
      ),
      lastUpdated: Math.max(input.now, latest.lastUpdated + 1),
    },
  }
}

/**
 * Resolve a session's pin against the file itself: an unlocked read serves a
 * current pin, anything else is decided and written under the sidebar lock.
 * The request path does not use this (it cannot wait on the lock); see
 * `planSidebarStickyAssignment` and `persistSidebarStickyAssignment`.
 */
export async function resolveSidebarStickyAssignment(
  input: ResolveStickyAssignmentInput,
  file = getSidebarStateFile(),
  hooks?: SidebarMergeHooks,
): Promise<StickyAssignment | undefined> {
  const sessionHash = hashSidebarSessionId(input.sessionId)
  const existing = (await readSidebarState(file)).stickyAssignments?.[
    sessionHash
  ]
  if (stickyAssignmentIsCurrent(existing, input)) return existing

  let resolved: StickyAssignment | undefined
  await enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(
      file,
      (latest) => {
        const plan = planSidebarStickyAssignment(latest, input)
        resolved = plan.assignment
        return plan.next
      },
      hooks,
    )
  })
  return resolved
}

/**
 * Decide a session's pin in memory from a snapshot, for the request path.
 * Returns the plan without reading or writing the file; the caller persists
 * `plan.next` in the background when it is defined.
 */
export function planSidebarStickyAssignmentFromSnapshot(
  state: SidebarState,
  input: ResolveStickyAssignmentInput,
): StickyAssignmentPlan {
  const existing =
    state.stickyAssignments?.[hashSidebarSessionId(input.sessionId)]
  // Mirrors resolveSidebarStickyAssignment: a current pin is used as-is even
  // when other sessions' pins would be pruned, so a steady session never
  // causes a write on its own account.
  if (stickyAssignmentIsCurrent(existing, input)) {
    return { assignment: existing, next: undefined }
  }
  return planSidebarStickyAssignment(state, input)
}

/**
 * Record a pin the request path already decided and used.
 *
 * The merge prunes pins the same way placement does, then writes the given
 * pin, unless another process has since placed the same session later than
 * this one did: that newer pin is kept and this process picks it up on its
 * next refresh. When both describe the same placement, the high-water request
 * size and last-seen time are kept.
 */
export function persistSidebarStickyAssignment(
  input: {
    sessionId: string
    assignment: StickyAssignment
    validPinnedAccountIds: readonly string[]
  },
  file = getSidebarStateFile(),
): Promise<void> {
  const sessionHash = hashSidebarSessionId(input.sessionId)
  const validPinnedAccountIds = new Set(input.validPinnedAccountIds)
  return enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(file, (latest) => {
      const now = Date.now()
      const stickyAssignments = pruneStickyAssignments(
        latest.stickyAssignments,
        validPinnedAccountIds,
        now,
      )
      const current = stickyAssignments?.[sessionHash]
      if (current && current.assignedAt > input.assignment.assignedAt) {
        if (stickyAssignmentsEqual(latest.stickyAssignments, stickyAssignments))
          return undefined
        return {
          ...latest,
          stickyAssignments,
          lastUpdated: Math.max(now, latest.lastUpdated + 1),
        }
      }
      const samePlacement =
        current !== undefined &&
        current.accountId === input.assignment.accountId &&
        current.assignedAt === input.assignment.assignedAt
      const assignment = samePlacement
        ? {
            ...input.assignment,
            inputBytes: Math.max(
              current.inputBytes,
              input.assignment.inputBytes,
            ),
            lastSeenAt: Math.max(
              current.lastSeenAt,
              input.assignment.lastSeenAt,
            ),
          }
        : input.assignment
      return {
        ...latest,
        stickyAssignments: limitStickyAssignments(
          { ...stickyAssignments, [sessionHash]: assignment },
          sessionHash,
        ),
        lastUpdated: Math.max(now, latest.lastUpdated + 1),
      }
    })
  })
}

export async function clearSidebarStickyAssignment(
  sessionId: string,
  file = getSidebarStateFile(),
): Promise<boolean> {
  const sessionHash = hashSidebarSessionId(sessionId)
  let removed = false
  await enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(file, (latest) => {
      const assignments = latest.stickyAssignments
      if (assignments?.[sessionHash] === undefined) {
        removed = false
        return undefined
      }
      removed = true
      const { [sessionHash]: _removed, ...remaining } = assignments
      return {
        ...latest,
        ...(Object.keys(remaining).length > 0
          ? { stickyAssignments: remaining }
          : { stickyAssignments: undefined }),
        lastUpdated: Math.max(Date.now(), latest.lastUpdated + 1),
      }
    })
  })
  return removed
}

/**
 * Await all pending sidebar writes. Tests call this before restoring env
 * vars in teardown so no in-flight write can re-resolve getSidebarStateFile()
 * after the env is changed.
 */
export function drainSidebarWrites(): Promise<void> {
  return sidebarWriteChain
}

// ---------------------------------------------------------------------------
// Request-path access to the sidebar file.
//
// The sidebar file is bookkeeping: display state plus the cross-process pin
// and pending-bytes ledger. A turn must never fail, or wait, because that file
// could not be read, locked or written. The request path therefore reads it
// through a cache and hands every write to a background queue.
// ---------------------------------------------------------------------------

/**
 * Longest a request waits for a lock-free read of a local bookkeeping file
 * before it goes ahead with the previous snapshot. A read of these few-kilobyte
 * files normally takes well under a millisecond; the budget only bounds a
 * pathological disk. The read keeps running and refreshes the cache for the
 * next request.
 */
export const HOT_PATH_READ_BUDGET_MS = 500

/**
 * Settle with `read` if it settles within `budgetMs`, otherwise with the value
 * `stale` returns at that moment. A rejection within the budget is passed on;
 * one after it is dropped, because the caller has already moved on.
 */
export function settleWithinBudget<T>(
  read: Promise<T>,
  budgetMs: number,
  stale: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(stale()), budgetMs)
    timer.unref?.()
    read.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export interface SidebarSnapshot {
  state: SidebarState
  /**
   * `Date.now()` when the read that produced `state` started (0 when no read
   * has completed yet). Anything written to the file before this time is in
   * `state`.
   */
  readAt: number
}

export interface SidebarStateCache {
  /**
   * The snapshot for one request. Costs one `stat` when the file is
   * unchanged. A changed file (or the first call) is read without any lock,
   * waiting at most `HOT_PATH_READ_BUDGET_MS`; past that the previous
   * snapshot is served, or the default state when there is none, which is
   * what an unreadable file has always meant.
   */
  get(): Promise<SidebarSnapshot>
  /** Read the file now and keep the result; for background callers. */
  read(): Promise<SidebarSnapshot>
  /** Re-read in the background if the file changed since the last read. */
  refreshInBackground(): void
}

export function createSidebarStateCache(
  file: string,
  options: { readBudgetMs?: number } = {},
): SidebarStateCache {
  const readBudgetMs = options.readBudgetMs ?? HOT_PATH_READ_BUDGET_MS
  let snapshot: (SidebarSnapshot & { key: string | undefined }) | undefined
  let inflight:
    | { key: string | undefined; promise: Promise<SidebarSnapshot> }
    | undefined

  // Atomic writes replace the file, so the inode changes on every write even
  // when the size and a coarse mtime would not.
  const statKey = (): string | undefined => {
    try {
      const stat = statSync(file)
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return undefined
    }
  }

  const startRead = (key: string | undefined): Promise<SidebarSnapshot> => {
    if (inflight && inflight.key === key) return inflight.promise
    const readAt = Date.now()
    // getSidebarState never rejects: an unreadable file is the default state.
    const promise = getSidebarState(file).then((state) => {
      if (!snapshot || snapshot.readAt <= readAt) {
        snapshot = { state, readAt, key }
      }
      return { state, readAt }
    })
    const entry = { key, promise }
    inflight = entry
    const clear = () => {
      if (inflight === entry) inflight = undefined
    }
    promise.then(clear, clear)
    return promise
  }

  return {
    get() {
      const key = statKey()
      if (snapshot && snapshot.key === key) {
        return Promise.resolve({
          state: snapshot.state,
          readAt: snapshot.readAt,
        })
      }
      return settleWithinBudget(startRead(key), readBudgetMs, () =>
        snapshot
          ? { state: snapshot.state, readAt: snapshot.readAt }
          : { state: DEFAULT_SIDEBAR_STATE, readAt: 0 },
      )
    },
    read() {
      return startRead(statKey())
    },
    refreshInBackground() {
      const key = statKey()
      if (snapshot?.key === key) return
      void startRead(key)
    },
  }
}

/**
 * A pin this process decided and is using, possibly not yet on disk. It keeps
 * the session on the same account in this process even when persisting it
 * failed, and it is dropped once a snapshot read after the pin landed is in
 * hand: from then on the file is authoritative, including a newer placement
 * another process made.
 */
export interface StickyPinOverlayEntry {
  assignment: StickyAssignment
  /** `Date.now()` after the pin was written to the file. */
  persistedAt?: number
}

export type StickyPinOverlay = Map<string, StickyPinOverlayEntry>

/** Record a pin, keeping the map within the file's own pin limit. */
export function rememberStickyPin(
  overlay: StickyPinOverlay,
  sessionHash: string,
  assignment: StickyAssignment,
): StickyPinOverlayEntry {
  const entry: StickyPinOverlayEntry = { assignment }
  overlay.delete(sessionHash)
  overlay.set(sessionHash, entry)
  while (overlay.size > STICKY_ASSIGNMENT_MAX_ENTRIES) {
    const oldest = overlay.keys().next().value
    if (oldest === undefined) break
    overlay.delete(oldest)
  }
  return entry
}

/** The snapshot's state with this process's not-yet-visible pins applied. */
export function applyStickyPinOverlay(
  snapshot: SidebarSnapshot,
  overlay: StickyPinOverlay,
): SidebarState {
  if (overlay.size === 0) return snapshot.state
  const assignments: StickyAssignmentMap = {
    ...snapshot.state.stickyAssignments,
  }
  let applied = false
  for (const [sessionHash, entry] of overlay) {
    if (
      entry.persistedAt !== undefined &&
      snapshot.readAt > entry.persistedAt
    ) {
      overlay.delete(sessionHash)
      continue
    }
    assignments[sessionHash] = entry.assignment
    applied = true
  }
  if (!applied) return snapshot.state
  return { ...snapshot.state, stickyAssignments: assignments }
}

export interface SidebarBookkeepingQueue {
  /**
   * Start a write now and return without waiting for it. Starting it
   * synchronously puts it on the shared write chain in call order, so
   * `drainSidebarWrites` covers it. A failure is logged once and retried from
   * a timer; a newer write under the same key replaces a pending retry.
   * `label` names the kind of write in logs and must not identify a session.
   */
  enqueue(key: string, label: string, write: () => Promise<void>): void
  /** Forget a pending retry and ignore the outcome of a write in flight. */
  cancel(key: string): void
  /** Stop retrying; writes already started still run. */
  stop(): void
}

export function createSidebarBookkeepingQueue(options: {
  logger: ReturnType<typeof createLogger>
  retryDelayMs?: number
  maxRetryDelayMs?: number
  /** Called after each write that lands. */
  onWritten?: () => void
}): SidebarBookkeepingQueue {
  const baseDelayMs = options.retryDelayMs ?? 500
  const maxDelayMs = options.maxRetryDelayMs ?? 30_000
  const generation = new Map<string, number>()
  const retries = new Map<
    string,
    { label: string; write: () => Promise<void> }
  >()
  // Keys whose last write failed. Only the first failure of a run is logged
  // at warn, so a lock held for a minute does not log once per retry.
  const failing = new Set<string>()
  let sequence = 0
  let delayMs = baseDelayMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const schedule = () => {
    if (timer || stopped || retries.size === 0) return
    timer = setTimeout(() => {
      timer = undefined
      const due = [...retries]
      retries.clear()
      delayMs = Math.min(delayMs * 2, maxDelayMs)
      for (const [key, retry] of due) {
        const current = generation.get(key)
        if (current !== undefined)
          attempt(key, retry.label, retry.write, current)
      }
    }, delayMs)
    timer.unref?.()
  }

  const attempt = (
    key: string,
    label: string,
    write: () => Promise<void>,
    ownGeneration: number,
  ) => {
    let running: Promise<void>
    try {
      running = write()
    } catch (error) {
      running = Promise.reject(error)
    }
    running.then(
      () => {
        if (generation.get(key) !== ownGeneration) return
        generation.delete(key)
        if (failing.delete(key)) {
          options.logger.info('sidebar bookkeeping write recovered', {
            pid: process.pid,
            write: label,
          })
        }
        if (failing.size === 0) delayMs = baseDelayMs
        options.onWritten?.()
      },
      (error: unknown) => {
        if (generation.get(key) !== ownGeneration) return
        const fields = {
          pid: process.pid,
          write: label,
          error: error instanceof Error ? error.message : String(error),
        }
        if (stopped) {
          generation.delete(key)
          options.logger.debug('sidebar bookkeeping write dropped', fields)
          return
        }
        if (failing.has(key)) {
          options.logger.debug('sidebar bookkeeping write failed again', fields)
        } else {
          failing.add(key)
          options.logger.warn(
            'sidebar bookkeeping write failed; retrying in the background',
            fields,
          )
        }
        retries.set(key, { label, write })
        schedule()
      },
    )
  }

  return {
    enqueue(key, label, write) {
      sequence += 1
      generation.set(key, sequence)
      retries.delete(key)
      attempt(key, label, write, sequence)
    },
    cancel(key) {
      generation.delete(key)
      retries.delete(key)
      failing.delete(key)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      retries.clear()
    },
  }
}

// Resolve the currently-active account from activeId for the collapsed sidebar
// view. activeId === 'main' (or undefined/unmatched/disabled) → the main
// account; otherwise the enabled fallback whose id matches.
export function resolveActiveAccount(state: SidebarState): {
  id: string
  name: string
  quota: AccountQuota | null
  killed: boolean
} {
  const activeId = state.activeId
  if (activeId && activeId !== 'main') {
    const fallback = state.fallbacks.find(
      (account) => account.enabled && account.id === activeId,
    )
    if (fallback) {
      return {
        id: fallback.id,
        name: fallback.label ?? fallback.id,
        quota: fallback.quota,
        killed: fallback.killed,
      }
    }
  }
  return {
    id: 'main',
    name: 'main',
    quota: state.main.quota,
    killed: state.main.killed,
  }
}

export function getCollapsedQuotaSummary(quota: AccountQuota | null): {
  primaryUsedPercent: number | null
  secondaryUsedPercent: number | null
  text: string | null
} {
  const primaryUsedPercent = quota?.primary?.usedPercent ?? null
  const secondaryUsedPercent = quota?.secondary?.usedPercent ?? null
  const rows = getPresentQuotaWindows(quota)
  return {
    primaryUsedPercent,
    secondaryUsedPercent,
    text:
      rows.length === 0
        ? null
        : rows
            .map(
              ({ label, window }) =>
                `${label}: ${Math.round(window.usedPercent)}%`,
            )
            .join(' '),
  }
}

const PACING_MIN_ELAPSED_MS = 5 * 60 * 1000
const PACING_MIN_ELAPSED_FRACTION = 0.01
const ON_PACE_DELTA = 1

export interface QuotaPacing {
  pacePercent: number
  deltaPercent: number
  state: 'deficit' | 'reserve' | 'on-pace'
  runsOutAt: string | null
}

// Even-burn pacing for a quota window. The window start is inferred from the
// reset timestamp minus the window length. Two metrics: deltaPercent compares
// usage against a uniform burn-down (positive = deficit), and runsOutAt
// projects the current average burn rate forward — null means the window
// lasts until reset at that rate. Returns null when there is no reset
// timestamp or the elapsed time is too small to give a meaningful rate.
export function computeQuotaPacing(
  window: QuotaWindow,
  windowMs: number,
  now: number,
): QuotaPacing | null {
  if (!window.resetsAt) return null
  const resetsAt = new Date(window.resetsAt).getTime()
  if (!Number.isFinite(resetsAt)) return null
  const start = resetsAt - windowMs
  const elapsed = now - start
  if (elapsed < PACING_MIN_ELAPSED_MS) return null
  if (elapsed < windowMs * PACING_MIN_ELAPSED_FRACTION) return null
  if (elapsed >= windowMs) return null

  const used = window.usedPercent
  const pacePercent = Math.min(Math.max((elapsed / windowMs) * 100, 0), 100)
  const deltaPercent = used - pacePercent
  const state =
    Math.abs(deltaPercent) < ON_PACE_DELTA
      ? 'on-pace'
      : deltaPercent > 0
        ? 'deficit'
        : 'reserve'

  let runsOutAt: string | null = null
  if (used > 0) {
    const msToFull = (elapsed * 100) / used
    const runOut = start + msToFull
    if (runOut < resetsAt) runsOutAt = new Date(runOut).toISOString()
  }

  return { pacePercent, deltaPercent, state, runsOutAt }
}
