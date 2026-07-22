export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  windowMinutes?: number
}

export interface AccountQuota {
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
  quota: AccountQuota | null
  killed: boolean
  enabled: boolean
  resetCredits?: number
}

export interface ActiveRoutingEntry {
  activeId: string
  route: string
  updatedAt: number
}

export type ActiveRoutingMap = Record<string, ActiveRoutingEntry>

export interface SidebarState {
  main: {
    quota: AccountQuota | null
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
  planType?: string
  credits?: number
  lastUpdated: number
}

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireRefreshFileLock } from './core/refresh-file-lock'
import { createLogger } from './logger'

const logSb = createLogger('sidebar')

const STATE_FILE_ENV = 'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'
const DEFAULT_STATE_DIR = join(tmpdir(), 'opencode-openai-auth')
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, 'sidebar-state.json')

function normalizeResetCredits(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function resetCreditsField(value: unknown): { resetCredits?: number } {
  const credits = normalizeResetCredits(value)
  return credits !== undefined ? { resetCredits: credits } : {}
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

export function getSidebarStateFile(): string {
  return process.env[STATE_FILE_ENV] || DEFAULT_STATE_FILE
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
        .map((e) => ({
          id: e.id as string,
          label: typeof e.label === 'string' ? e.label : undefined,
          quota: ('quota' in e ? e.quota : null) as AccountQuota | null,
          killed: typeof e.killed === 'boolean' ? e.killed : false,
          enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
          ...resetCreditsField(e.resetCredits),
        }))
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
  return {
    main,
    fallbacks,
    activeId,
    route,
    lastUpdated,
    ...(activeRouting !== undefined ? { activeRouting } : {}),
    ...(planType !== undefined ? { planType } : {}),
    ...(credits !== undefined ? { credits } : {}),
  }
}

export async function getSidebarState(): Promise<SidebarState> {
  try {
    const raw = await readFile(getSidebarStateFile(), 'utf8')
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
  accounts: readonly SidebarRoutingAccount[],
  now = Date.now(),
): boolean {
  const fresh =
    entry.updatedAt >= now - ACTIVE_ROUTING_MAX_AGE_MS && entry.updatedAt <= now
  if (!fresh) return false
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

export function isQuotaExhausted(
  quota: AccountQuota | null | undefined,
  now = Date.now(),
): boolean {
  const primary = quota?.primary
  if (
    typeof primary?.resetsAt !== 'string' ||
    !Number.isFinite(primary.usedPercent) ||
    primary.usedPercent < 100
  ) {
    return false
  }
  const resetsAt = Date.parse(primary.resetsAt)
  return Number.isFinite(resetsAt) && resetsAt > now
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
  accounts: readonly SidebarRoutingAccount[],
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
  await mkdir(dirname(file), { recursive: true })
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

async function writeMergedSidebarState(
  file: string,
  merge: (latest: SidebarState) => SidebarState,
  hooks?: SidebarMergeHooks,
): Promise<void> {
  const lock = await acquireSidebarWriteLock(file)
  try {
    // The file lock serializes current writers. Rechecking also preserves data
    // from older plugin processes that do not participate in this lock.
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt += 1) {
      const rawBefore = await readRawSidebar(file)
      const next = merge(parseSidebarState(rawBefore))
      if (attempt === 0) await hooks?.beforeRecheck?.()
      const rawRecheck = await readRawSidebar(file)
      if (rawRecheck !== rawBefore) continue
      await doWriteSidebarState(next, file)
      return
    }

    const latest = await readSidebarState(file)
    await doWriteSidebarState(merge(latest), file)
  } finally {
    await lock.release()
  }
}

export type SidebarMachineState = Pick<
  SidebarState,
  'main' | 'fallbacks' | 'planType' | 'credits' | 'lastUpdated'
> & { route: string }

export function setSidebarMachineState(
  machineState: SidebarMachineState,
  file = getSidebarStateFile(),
  hooks?: SidebarMergeHooks,
): Promise<void> {
  return enqueueSidebarWrite(async () => {
    await writeMergedSidebarState(
      file,
      (latest) => ({
        ...latest,
        ...machineState,
        activeId: latest.activeId,
        activeRouting: latest.activeRouting,
        lastUpdated: Math.max(Date.now(), latest.lastUpdated + 1),
      }),
      hooks,
    )
  })
}

export function upsertSidebarActiveRouting(
  input: { sessionId: string } & ActiveRoutingEntry,
  accounts: readonly SidebarRoutingAccount[],
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
        return {
          ...latest,
          activeId: input.activeId,
          route: input.route,
          activeRouting,
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
  accounts: readonly SidebarRoutingAccount[],
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
        return {
          ...latest,
          activeRouting,
          lastUpdated: Math.max(Date.now(), latest.lastUpdated + 1),
        }
      },
      hooks,
    )
  })
}

async function doWriteSidebarState(
  state: SidebarState,
  file: string,
): Promise<void> {
  const tempPath = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tempPath, JSON.stringify(state), 'utf8')
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
