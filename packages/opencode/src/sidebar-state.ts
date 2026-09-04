export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  checkedAt?: number
  resetsAt?: string
  windowMinutes?: number
}

export interface AccountQuota {
  checkedAt?: number
  primary?: QuotaWindow
  secondary?: QuotaWindow
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
  /** Vault-custody projection (fallback accounts only). Six states; the
   *  enroll-pending reasons are `EnrollPendingReason` — see
   *  `projectCustodyForSidebar`. The main slot is
   *  always rendered as frozen-local and never carries this field. */
  custody?: SidebarAccountCustody
}

export type SidebarCustodyState =
  | 'vault'
  | 'vaultReauth'
  | 'vaultGone'
  | 'needsLogin'
  | 'enrollPending'
  | 'local'

export type SidebarCustodyReason =
  | 'unavailable'
  | 'gone'
  | 'identityMismatch'
  | 'nullClaim'
  | 'completionDisarmed'

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
}

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireRefreshFileLock } from './core/refresh-file-lock'
import { createLogger } from './logger'

const logSb = createLogger('sidebar')

const STATE_FILE_ENV = 'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'
const DEFAULT_STATE_DIR = join(tmpdir(), 'opencode-openai-auth')
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, 'sidebar-state.json')
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
  'vaultReauth',
  'vaultGone',
  'needsLogin',
  'enrollPending',
  'local',
])

const CUSTODY_REASONS = new Set<SidebarCustodyReason>([
  'unavailable',
  'gone',
  'identityMismatch',
  'nullClaim',
  'completionDisarmed',
])

/**
 * Tolerant reader for the per-fallback `custody` projection. Unknown state
 * or reason values are dropped (NOT replaced with a default — a stale state
 * file with an experimental `vaultHealing` value must not silently render
 * as `local`, it must render as no-projection-at-all). Valid values round-
 * trip byte-identical. The output never contains a handle or a token; the
 * only emitted fields are `state`, `reason`, and `recordVersion`.
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
  if (typeof c.recordVersion === 'number' && Number.isFinite(c.recordVersion)) {
    out.recordVersion = c.recordVersion
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
  return process.env[STATE_FILE_ENV] || DEFAULT_STATE_FILE
}

/**
 * Shape of the cache inputs the custody projection consumes. Defined as a
 * structural type (not a class import) so the projection stays pure and
 * testable: production wires a `ClaustrumCredentialCache`; tests wire a
 * fake. Only the read surface is referenced — never the credential material.
 */
export interface CustodyCacheReadView {
  isBlocked(handle: string): boolean
  isReauth(handle: string, now?: number): boolean
  peekMetadata(
    handle: string,
  ): Promise<{ recordVersion: number; expiresAtMs: number } | undefined>
}

export interface ProjectCustodyInput {
  /** Local oauth account (for tombstone / refresh-token checks). */
  tombstoned: boolean
  /** Whether the plugin-wide claustrum storage toggle is on. */
  storageEnabled: boolean
  /** Whether the manifest has a case-exact entry for this account id. */
  enrolled: boolean
  /** Handle from the manifest entry (required to query cache state). */
  handle?: string
  /** Latched enroll failure reason from the process-local store. */
  enrollPendingReason?:
    | 'unavailable'
    | 'gone'
    | 'identityMismatch'
    | 'nullClaim'
    | 'completionDisarmed'
  /** Live read-only view of the cache; absent on unenrolled/tombstone-false. */
  cache?: CustodyCacheReadView
  /** Caller-supplied "now" so tests can drive the reauth fence deterministically. */
  now?: number
}

/**
 * Project a fallback account into a six-state custody view for the sidebar.
 *
 * Order of checks (high priority first):
 *   1. Latched enroll-pending reason — the sweep set a reason; render it.
 *   2. Excluded (tombstoned + storage off) — the operator must relink the
 *      account; the vault refuses to serve.
 *   3. Custodied (tombstoned + storage on + enrolled) — consult the cache:
 *      blocked → `vaultGone`, reauth-bound → `vaultReauth`, live resident
 *      record → `vault` with the served recordVersion, otherwise
 *      `vaultReauth` (no record yet; the operator must wait for the next
 *      successful `get`).
 *   4. Custody-refuse (tombstoned + storage on + NOT enrolled) — the manifest
 *      does not recognize the account, so it reads as `needsLogin` to the
 *      operator. Same UX as excluded; the underlying reason differs.
 *   5. Ordinary fallback / enrolling without a failure — `local`.
 *
 * The projection is display-only. The output never contains a handle, a
 * token, a payload, or any sentinel string.
 */
export function projectCustodyForSidebar(
  input: ProjectCustodyInput,
): SidebarAccountCustody {
  if (input.enrollPendingReason) {
    return { state: 'enrollPending', reason: input.enrollPendingReason }
  }
  if (input.tombstoned && !input.storageEnabled) {
    return { state: 'needsLogin' }
  }
  if (input.tombstoned && input.storageEnabled) {
    if (!input.enrolled) {
      return { state: 'needsLogin' }
    }
    const handle = input.handle
    const cache = input.cache
    if (handle && cache?.isBlocked(handle)) {
      return { state: 'vaultGone' }
    }
    if (handle && cache?.isReauth(handle, input.now)) {
      return { state: 'vaultReauth' }
    }
    return { state: 'vaultReauth' }
  }
  return { state: 'local' }
}

/**
 * Async companion used by the build path: resolves the resident record and
 * upgrades the `vaultReauth` fallback to a `vault` with recordVersion when
 * a live credential is present. Sync callers (and the normalizer) use
 * `projectCustodyForSidebar` directly.
 */
export async function projectCustodyForSidebarAsync(
  input: ProjectCustodyInput,
): Promise<SidebarAccountCustody> {
  if (input.enrollPendingReason) {
    return { state: 'enrollPending', reason: input.enrollPendingReason }
  }
  if (input.tombstoned && !input.storageEnabled) {
    return { state: 'needsLogin' }
  }
  if (input.tombstoned && input.storageEnabled) {
    if (!input.enrolled) {
      return { state: 'needsLogin' }
    }
    const handle = input.handle
    const cache = input.cache
    if (handle && cache?.isBlocked(handle)) {
      return { state: 'vaultGone' }
    }
    if (handle && cache?.isReauth(handle, input.now)) {
      return { state: 'vaultReauth' }
    }
    if (handle && cache) {
      const peeked = await cache.peekMetadata(handle)
      if (peeked) {
        return { state: 'vault', recordVersion: peeked.recordVersion }
      }
    }
    return { state: 'vaultReauth' }
  }
  return { state: 'local' }
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
// write cannot land after a newer one and corrupt the file.
let sidebarWriteChain: Promise<void> = Promise.resolve()
const MAX_MERGE_ATTEMPTS = 3
const SIDEBAR_WRITE_LOCK_TTL_MS = 10_000
const SIDEBAR_WRITE_LOCK_WAIT_MS = 15_000

interface SidebarMergeHooks {
  beforeRecheck?: () => void | Promise<void>
}

function enqueueSidebarWrite(operation: () => Promise<void>): Promise<void> {
  const result = sidebarWriteChain.then(operation)
  sidebarWriteChain = result.catch(() => {})
  return result
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
  return enqueueSidebarWrite(() => doWriteSidebarState(state, file))
}

async function readSidebarState(file: string): Promise<SidebarState> {
  try {
    return parseSidebarState(await readRawSidebar(file))
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

async function readRawSidebar(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw error
  }
}

function parseSidebarState(raw: string): SidebarState {
  if (raw === '') return DEFAULT_SIDEBAR_STATE
  try {
    return normalizeSidebarState(JSON.parse(raw))
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

async function acquireSidebarWriteLock(file: string) {
  await ensureSidebarStateDirectory(file)
  const deadline = Date.now() + SIDEBAR_WRITE_LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    const lock = await acquireRefreshFileLock({
      name: 'sidebar-write',
      path: file,
      ttlMs: SIDEBAR_WRITE_LOCK_TTL_MS,
      renew: true,
    })
    if (lock) return lock
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the sidebar state write lock')
}

async function ensureSidebarStateDirectory(file: string): Promise<void> {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (file !== DEFAULT_STATE_FILE) return
  await chmod(dir, 0o700).catch((error) => {
    logSb.warn('sidebar directory permission remediation failed', {
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

async function writeMergedSidebarState(
  file: string,
  merge: (latest: SidebarState) => SidebarState | undefined,
  hooks?: SidebarMergeHooks,
): Promise<void> {
  const lock = await acquireSidebarWriteLock(file)
  try {
    // The file lock serializes current writers. Rechecking also preserves data
    // from older plugin processes that do not participate in this lock.
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt += 1) {
      const rawBefore = await readRawSidebar(file)
      const next = merge(parseSidebarState(rawBefore))
      if (!next) return
      if (attempt === 0) await hooks?.beforeRecheck?.()
      const rawRecheck = await readRawSidebar(file)
      if (rawRecheck !== rawBefore) continue
      await doWriteSidebarState(next, file)
      return
    }

    const latest = await readSidebarState(file)
    const next = merge(latest)
    if (next) await doWriteSidebarState(next, file)
  } finally {
    await lock.release()
  }
}

export type SidebarMachineState = Pick<
  SidebarState,
  'main' | 'fallbacks' | 'planType' | 'credits' | 'lastUpdated'
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
  let checkedAt: number | undefined
  for (const stamp of [
    finiteWindowCheckedAt(primary),
    finiteWindowCheckedAt(secondary),
  ]) {
    if (stamp !== undefined) {
      checkedAt = checkedAt === undefined ? stamp : Math.max(checkedAt, stamp)
    }
  }
  return {
    ...incoming,
    primary,
    secondary,
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

export async function resolveSidebarStickyAssignment(
  input: ResolveStickyAssignmentInput,
  file = getSidebarStateFile(),
  hooks?: SidebarMergeHooks,
): Promise<StickyAssignment | undefined> {
  const sessionHash = hashSidebarSessionId(input.sessionId)
  const validPinnedAccountIds = new Set(input.validPinnedAccountIds)
  const excludedAccountIds = new Set(input.excludeAccountIds)
  const existing = (await readSidebarState(file)).stickyAssignments?.[
    sessionHash
  ]
  if (
    isValidStickyAssignment(
      existing,
      validPinnedAccountIds,
      excludedAccountIds,
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
  ) {
    return existing
  }

  let resolved: StickyAssignment | undefined
  await enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(
      file,
      (latest) => {
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
          resolved = assignment
          if (!assignmentsPruned && !metadataNeedsUpdate) return undefined
          return {
            ...latest,
            stickyAssignments: {
              ...stickyAssignments,
              [sessionHash]: assignment,
            },
            lastUpdated: Math.max(input.now, latest.lastUpdated + 1),
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
          resolved = undefined
          if (!assignmentsPruned) return undefined
          return {
            ...latest,
            stickyAssignments,
            lastUpdated: Math.max(input.now, latest.lastUpdated + 1),
          }
        }

        resolved = {
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
          ...latest,
          stickyAssignments: limitStickyAssignments(
            {
              ...stickyAssignments,
              [sessionHash]: resolved,
            },
            sessionHash,
          ),
          lastUpdated: Math.max(input.now, latest.lastUpdated + 1),
        }
      },
      hooks,
    )
  })
  return resolved
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

async function doWriteSidebarState(
  state: SidebarState,
  file: string,
): Promise<void> {
  const tempPath = `${file}.${randomUUID()}.tmp`
  try {
    await ensureSidebarStateDirectory(file)
    await writeFile(tempPath, JSON.stringify(normalizeSidebarState(state)), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tempPath, file)
  } catch (e) {
    await rm(tempPath, { force: true }).catch(() => {})
    logSb.warn('sidebar write failed', {
      pid: process.pid,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

/**
 * Await all pending sidebar writes. Tests call this before restoring env
 * vars in teardown so no in-flight write can re-resolve getSidebarStateFile()
 * after the env is changed.
 */
export function drainSidebarWrites(): Promise<void> {
  return sidebarWriteChain
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
