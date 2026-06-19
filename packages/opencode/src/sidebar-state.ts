export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
}

export interface AccountQuota {
  primary?: QuotaWindow
  secondary?: QuotaWindow
}

export interface SidebarAccountState {
  id: string
  label: string | undefined
  quota: AccountQuota | null
  killed: boolean
  enabled: boolean
}

export interface SidebarState {
  main: {
    quota: AccountQuota | null
    killed: boolean
    quotaBackedOff?: boolean
    quotaBackoffUntil?: number
    refreshBackedOff?: boolean
    refreshBackoffUntil?: number
  }
  fallbacks: SidebarAccountState[]
  activeId: string | undefined
  route: string
  planType?: string
  credits?: number
  lastUpdated: number
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from './logger'

const logSb = createLogger('sidebar')

const STATE_FILE_ENV = 'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'
const DEFAULT_STATE_DIR = join(tmpdir(), 'opencode-openai-auth')
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, 'sidebar-state.json')

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

  return {
    main,
    fallbacks,
    activeId,
    route,
    lastUpdated,
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

// Serialization chain: concurrent calls are queued so a stale background
// write cannot land after a newer one and corrupt the file.
let sidebarWriteChain: Promise<void> = Promise.resolve()

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
  sidebarWriteChain = sidebarWriteChain
    .then(() => doWriteSidebarState(state, file))
    .catch(() => {})
  return sidebarWriteChain
}

async function doWriteSidebarState(
  state: SidebarState,
  file: string,
): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(state), 'utf8')
  } catch (e) {
    logSb.warn('sidebar write failed', {
      pid: process.pid,
      error: e instanceof Error ? e.message : String(e),
    })
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
  if (primaryUsedPercent == null && secondaryUsedPercent == null) {
    return { primaryUsedPercent, secondaryUsedPercent, text: null }
  }

  return {
    primaryUsedPercent,
    secondaryUsedPercent,
    text: `5h: ${primaryUsedPercent == null ? '\u2014' : `${Math.round(primaryUsedPercent)}%`} 7d: ${secondaryUsedPercent == null ? '\u2014' : `${Math.round(secondaryUsedPercent)}%`}`,
  }
}

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

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
