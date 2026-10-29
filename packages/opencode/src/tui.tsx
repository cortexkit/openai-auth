/** @jsxImportSource @opentui/solid */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatQuota,
  quotaTextParts,
  quotaWindowParts,
} from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  type Tone as FrameTone,
  type PaceView,
  SidebarFrame,
  SidebarSection,
  SidebarStatRow,
  SidebarTextRow,
} from '@cortexkit/common-auth/quota-sidebar'
import type { Plugin } from '@opencode/plugin/tui'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { RGBA } from '@opentui/core'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { createLogger } from './logger.js'
import { type ApplyRequest, isNotifyPayload } from './rpc/protocol.js'
import { createRpcClient, DEFAULT_RPC_TIMEOUT_MS } from './rpc/rpc-client.js'
import { resolveRpcDir } from './rpc/rpc-dir.js'
import {
  type AccountQuota,
  accountCreditsText,
  accountServesOnCredits,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  displayWidth,
  fitCollapsedLabel,
  getCollapsedAccountLines,
  getCollapsedQuotaSummary,
  getPresentQuotaWindows,
  getSidebarState,
  type QuotaPacing,
  type QuotaWindow,
  resolveActiveAccount,
  resolveSessionSidebarRouting,
  resolveSessionStickyAccount,
  type SidebarState,
  type SpendControlReading,
  sidebarQuotaProjection,
} from './sidebar-state.js'
import { openCommandDialog } from './tui/command-dialogs.js'
import {
  POLL_FAILURE_LOG_INTERVAL_MS,
  pollFailureClass,
  SLOW_SERVER_MESSAGE,
  SLOW_SERVER_POLL_FAILURES,
  setupTui,
  type TuiTransportOptions,
} from './tui/v2.js'
import {
  type AppearancePrefs,
  computeEffectiveOrder,
  DEFAULT_SLOT_ORDER,
  type OpenaiAuthTuiPrefs,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveOpenaiAuthPrefs,
  watchTuiPreferences,
} from './tui-preferences.js'

const RPC_POLL_MS = 500
let rpcPollStarted = false
const log = createLogger('rpc-tui')

const ID = 'cortexkit.openai-auth'

/** One drawer action as the RPC apply request carries it, with its session. */
export function buildApplyRequest(
  request: Omit<ApplyRequest, 'sessionId'>,
  sessionId?: string,
): ApplyRequest {
  return { ...request, ...(sessionId !== undefined ? { sessionId } : {}) }
}

/**
 * How long the drawer waits for one action: a reset-credit redemption polls
 * the provider and can take most of this.
 */
const MENU_APPLY_TIMEOUT_MS = 90_000

// Read package metadata from the development source or either generated TUI
// variant. Avoid a JSON import because package.json sits outside the declaration
// build's rootDir.
const PLUGIN_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const packageFile of [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
    join(here, '..', '..', '..', 'package.json'),
  ]) {
    try {
      const raw = readFileSync(packageFile, 'utf8')
      const version = (JSON.parse(raw) as { version?: string }).version
      if (version) return version
    } catch {
      // Try the path for the other TUI entry layout.
    }
  }
  return ''
})()

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text'
type ThemeCurrent = Pick<
  TuiPluginApi['theme']['current'],
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'background'
  | 'borderActive'
  | 'success'
  | 'warning'
  | 'error'
>
type ThemeColor = ThemeCurrent['text']

type HostColor = { readonly base?: ThemeColor; readonly muted?: ThemeColor }
type SidebarHostTheme = {
  readonly text?: HostColor & {
    readonly action?: { readonly primary?: HostColor }
    readonly feedback?: Partial<
      Record<'success' | 'warning' | 'error', HostColor>
    >
  }
  readonly background?: HostColor & { readonly raised?: HostColor }
  readonly border?: HostColor
}

// OpenCode 2 supplies semantic tokens, not OpenCode 1's flat palette. Missing
// tokens use siblings; the neutral defaults cover even an empty host theme.
export function sidebarThemeFromHost(theme: SidebarHostTheme): ThemeCurrent {
  const text =
    theme.text?.base ??
    theme.text?.muted ??
    theme.text?.action?.primary?.base ??
    RGBA.fromHex('#ffffff')
  const accent = theme.text?.action?.primary?.base ?? text
  return {
    text,
    textMuted: theme.text?.muted ?? text,
    accent,
    background:
      theme.background?.base ??
      theme.background?.raised?.base ??
      RGBA.fromHex('#000000'),
    borderActive: theme.border?.base ?? accent,
    success:
      theme.text?.feedback?.success?.base ??
      theme.text?.feedback?.success?.muted ??
      accent,
    warning:
      theme.text?.feedback?.warning?.base ??
      theme.text?.feedback?.warning?.muted ??
      accent,
    error:
      theme.text?.feedback?.error?.base ??
      theme.text?.feedback?.error?.muted ??
      accent,
  }
}

function usageTone(usedPct: number, appearance: AppearancePrefs): Tone {
  if (usedPct < appearance.warnThreshold) return 'ok'
  if (usedPct < appearance.errorThreshold) return 'warn'
  return 'err'
}

function frameTone(tone: Tone): FrameTone {
  switch (tone) {
    case 'ok':
      return 'success'
    case 'warn':
      return 'warning'
    case 'err':
      return 'error'
    case 'muted':
      return 'textMuted'
    default:
      return tone
  }
}

function paceView(pacing: QuotaPacing | null): PaceView | undefined {
  if (!pacing) return undefined
  const pct = Math.round(Math.abs(pacing.deltaPercent))
  const text =
    pacing.state === 'on-pace'
      ? ''
      : pacing.state === 'reserve'
        ? `reserve ${pct}% \u00b7 lasts`
        : pacing.runsOutAt
          ? `deficit ${pct}% \u00b7 out in ${formatResetIn(pacing.runsOutAt)}`
          : `deficit ${pct}% \u00b7 lasts`
  return {
    text,
    tone: pacing.state === 'deficit' ? 'warning' : 'textMuted',
    overlay: {
      kind: pacing.deltaPercent > 0 ? 'deficit' : 'reserve',
      percent: pacing.pacePercent,
    },
  }
}

export function formatResetIn(resetsAt: string | undefined): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) {
    const rm = mins % 60
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
  }
  const days = Math.floor(hrs / 24)
  const rh = hrs % 24
  return rh > 0 ? `${days}d${rh}h` : `${days}d`
}

function formatUntil(until: number | undefined): string {
  if (!until) return ''
  const ms = until - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
}

// One of an account's own rows under its quota bars (budget amounts, prepaid
// credits, reset credits): muted label left, value right. Like the quota rows
// it stays on one line: it measures its own width and, when both do not fit,
// cuts only the label (with …), keeping one blank cell before the value.
function AccountMetaRow(props: {
  theme: ThemeCurrent
  label: string
  value: string
}) {
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const label = () => {
    const columns = width()
    if (columns <= 0) return props.label
    return fitCollapsedLabel(
      props.label,
      columns - displayWidth(props.value) - 1,
    )
  }
  return (
    <box
      ref={(element: { width: number }) => {
        row = element
      }}
      onSizeChange={() => setWidth(row?.width ?? 0)}
      width='100%'
      flexDirection='row'
      justifyContent='space-between'
    >
      <text fg={props.theme.textMuted} wrapMode='none' flexShrink={1}>
        {label()}
      </text>
      <text fg={props.theme.text} wrapMode='none' flexShrink={0}>
        <b>{props.value}</b>
      </text>
    </box>
  )
}

export interface QuotaDisplayRow {
  key: 'primary' | 'secondary' | 'spendControl'
  label: string
  labelWidth: number
  text: string
  resetText?: string
  window: QuotaWindow
  pacing: QuotaPacing | null
}

const SPEND_CONTROL_LABEL = 'credits'

// Labels a quota snapshot contributes to the sidebar, independent of pacing or
// the wall clock — the label column is sized from these alone.
function quotaRowLabels(quota: AccountQuota | null): string[] {
  const labels = getPresentQuotaWindows(quota).map((row) => row.label)
  if (quota?.spendControl) labels.push(SPEND_CONTROL_LABEL)
  return labels
}

// The label column is a property of the whole sidebar, not of one account's row
// set: every account's bars must start at the same column, so the width is
// derived once from every account rendered (main plus fallbacks) and threaded
// into each account's rows. The +1 keeps a separator before the longest label's
// bar; 3 is the floor the short 5h/7d labels already relied on.
/**
 * Every quota the sidebar will draw, in one list.
 *
 * The label column is shared by all of them, so the width has to be measured
 * over this exact set — measuring a subset is what made stacked accounts
 * disagree about where the bar starts. Named rather than inlined at each call
 * site because the set is the part that can be got wrong, and a call site
 * cannot be tested without the host's rendering runtime.
 */
export function renderedQuotas(state: {
  main?: { quota?: AccountQuota | null } | null
  fallbacks?: ReadonlyArray<{ enabled?: boolean; quota?: AccountQuota | null }>
  vaultAccounts?: ReadonlyArray<{
    enabled?: boolean
    quota?: AccountQuota | null
  }>
}): ReadonlyArray<AccountQuota | null | undefined> {
  // In vault mode only the vault accounts are rendered.
  if (state.vaultAccounts !== undefined)
    return state.vaultAccounts.map((account) => account.quota)
  return [
    state.main?.quota ?? null,
    ...(state.fallbacks ?? [])
      .filter((fallback) => fallback.enabled)
      .map((fallback) => fallback.quota),
  ]
}

export function computeQuotaLabelWidth(
  quotas: ReadonlyArray<AccountQuota | null | undefined>,
): number {
  let width = 3
  for (const quota of quotas) {
    for (const label of quotaRowLabels(quota ?? null)) {
      width = Math.max(width, label.length + 1)
    }
  }
  return width
}

// Maps present quota windows onto display rows and computes pacing against each
// dynamic duration or the historical 5h/7d duration for legacy snapshots.
// `labelWidth` comes from computeQuotaLabelWidth for rendered sidebars; callers
// that only inspect pacing may omit it and get this row set's own width.
export function buildQuotaRowsForDisplay(
  quota: AccountQuota | null,
  now: number,
  pacingEnabled: boolean,
  labelWidth?: number,
): QuotaDisplayRow[] {
  const projection = sidebarQuotaProjection(quota, now)
  const rows: Array<Omit<QuotaDisplayRow, 'labelWidth'>> =
    getPresentQuotaWindows(quota).map((row) => {
      const rowProjection = projection && {
        ...projection,
        budget: undefined,
        limits: projection.limits.filter((limit) => limit.label === row.key),
      }
      const reset = quotaWindowParts(rowProjection, {
        now,
        staleAfterMs: Number.POSITIVE_INFINITY,
      }).windows[0]
      return {
        key: row.key,
        label: row.label,
        window: row.window,
        text: formatQuota(rowProjection, {
          now,
          form: 'compact',
          staleAfterMs: Number.POSITIVE_INFINITY,
        }),
        resetText:
          reset?.resetIn ?? (reset?.resetSinceReading ? 'reset' : undefined),
        pacing:
          pacingEnabled && row.windowMs !== null
            ? computeQuotaPacing(row.window, row.windowMs, now)
            : null,
      }
    })
  const spendControl = quota?.spendControl
  if (spendControl) {
    const rowProjection = projection && { ...projection, limits: [] }
    const reset = quotaWindowParts(rowProjection, {
      now,
      staleAfterMs: Number.POSITIVE_INFINITY,
    }).windows[0]
    rows.push({
      key: 'spendControl',
      label: SPEND_CONTROL_LABEL,
      text: formatQuota(rowProjection, {
        now,
        form: 'compact',
        staleAfterMs: Number.POSITIVE_INFINITY,
      }),
      resetText:
        reset?.resetIn ?? (reset?.resetSinceReading ? 'reset' : undefined),
      window: {
        usedPercent: spendControl.usedPercent,
        remainingPercent: spendControl.remainingPercent,
        resetsAt: spendControl.resetsAt,
      },
      pacing: null,
    })
  }
  const width =
    labelWidth ?? Math.max(3, ...rows.map((row) => row.label.length + 1))
  const parts = quotaTextParts(projection, {
    now,
    form: 'compact',
    staleAfterMs: Number.POSITIVE_INFINITY,
  })
  rows.sort(
    (left, right) => parts.indexOf(left.text) - parts.indexOf(right.text),
  )
  return rows.map((row) => ({ ...row, labelWidth: width }))
}

export function isQuotaLoaded(quota: AccountQuota | null): boolean {
  return quota !== null
}

export function getQuotaMetadataRows(
  state: SidebarState,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  if (state.planType) rows.push({ label: 'Plan', value: state.planType })
  return rows
}

function formatGroupedAmount(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

// The unit names the budget the amounts are counted in, so it agrees with the
// total rather than staying singular against a plural quantity.
function pluralizeUnit(unit: string, count: number): string {
  if (count === 1) return unit
  return unit.endsWith('s') ? unit : `${unit}s`
}

export function formatSpendControlAmounts(
  spendControl: SpendControlReading,
): string {
  const unit = pluralizeUnit(spendControl.unit ?? 'unit', spendControl.limit)
  return `${formatGroupedAmount(spendControl.used)} / ${formatGroupedAmount(spendControl.limit)} ${unit}`
}

/**
 * The account's own rows under its quota bars: the workspace budget's amounts
 * (`credits`), the prepaid credits (`prepaid`, worded by `accountCreditsText`)
 * and the reset-credit count (`resets`), each only when known. While the
 * account is serving the session on its prepaid credits (its free quota is
 * used up), the prepaid row says so in place of its `prepaid` label.
 */
export function getAccountMetadataRows(
  resetCredits: number | undefined,
  spendControl?: SpendControlReading,
  prepaidCredits?: string,
  servingOnCredits = false,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  if (spendControl) {
    rows.push({
      label: 'credits',
      value: formatSpendControlAmounts(spendControl),
    })
  }
  if (prepaidCredits !== undefined) {
    rows.push({
      label: servingOnCredits ? 'serving on credits' : 'prepaid',
      value: prepaidCredits,
    })
  }
  if (resetCredits !== undefined) {
    rows.push({ label: 'resets', value: String(resetCredits) })
  }
  return rows
}

/** The fewest cells a shortened quota bar keeps; below this it is dropped. */
// --- State plumbing ---------------------------------------------------------

export async function readStateFromFile(): Promise<SidebarState> {
  return getSidebarState()
}

export function resolveQuotaDialogActiveId(
  state: SidebarState,
  sessionId: string | undefined,
  now = Date.now(),
): string | undefined {
  return sessionId
    ? resolveSessionSidebarRouting(state, sessionId, now).activeId
    : state.activeId
}

export interface RoutingDisplayRow {
  label: string
  value: string
  tone: Tone
}

export function buildRoutingRowsForDisplay(
  state: SidebarState,
  sessionId: string | undefined,
  now = Date.now(),
): RoutingDisplayRow[] {
  const routing = resolveSessionSidebarRouting(state, sessionId, now)
  const rows: RoutingDisplayRow[] = [
    { label: 'Route', value: routing.route, tone: 'accent' },
  ]
  const pinnedAccountId = resolveSessionStickyAccount(state, sessionId, now)
  if (pinnedAccountId) {
    const pinnedAccount = resolveActiveAccount({
      ...state,
      activeId: pinnedAccountId,
    })
    rows.push({ label: 'Pin', value: pinnedAccount.name, tone: 'accent' })
  }
  return rows
}

interface SidebarController {
  prefs: () => OpenaiAuthTuiPrefs
  collapsed: () => boolean
  toggleCollapsed: () => void
  dispose: () => void
}

// The TUI may unmount and remount sidebar_content when the user switches
// views (e.g. main -> subagent -> main). A remount re-runs the component
// body, so any signal created inside the component would reset to its
// seed. The controller lives in the plugin closure (process lifetime)
// and owns the durable prefs/collapse signals plus the single shared
// watcher subscription, so collapse and live pref reloads survive the
// remount. No effects or memos here — those need a Solid owner, so the
// poll-interval createEffect stays inside the component.
function createSidebarController(
  initialPrefs: OpenaiAuthTuiPrefs,
): SidebarController {
  const [prefs, setPrefs] = createSignal<OpenaiAuthTuiPrefs>(initialPrefs)
  const seedCollapsed =
    initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
      ? initialPrefs.collapsed
      : initialPrefs.startCollapsed
  const [collapsed, setCollapsed] = createSignal(seedCollapsed)
  let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed
  let lastApplied = JSON.stringify(initialPrefs)

  let disposed = false
  // Remember the last value written to disk, not an unpersisted click. A watcher
  // echo of the previous disk value must not undo a click whose write is pending.
  const unwatch = watchTuiPreferences(() => {
    void (async () => {
      const next = resolveOpenaiAuthPrefs(await readTuiPreferencesFile())
      if (disposed) return
      const serialized = JSON.stringify(next)
      if (serialized === lastApplied) return
      lastApplied = serialized
      setPrefs(next)
      if (
        next.rememberCollapsed &&
        next.collapsed != null &&
        next.collapsed !== lastPersistedCollapsed
      ) {
        lastPersistedCollapsed = next.collapsed
        setCollapsed(next.collapsed)
      }
    })()
  })

  function toggleCollapsed() {
    const next = !collapsed()
    setCollapsed(next)
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], next).then(
        () => {
          lastPersistedCollapsed = next
        },
      )
    }
  }

  return {
    prefs,
    collapsed,
    toggleCollapsed,
    dispose() {
      disposed = true
      unwatch()
    },
  }
}

function QuotaSidebar(props: {
  api: {
    theme: { readonly current: ThemeCurrent }
    event: {
      on(
        type: 'session.updated' | 'message.updated',
        listener: () => void,
      ): () => void
    }
  }
  controller: SidebarController
  sessionId: string
}) {
  const prefs = props.controller.prefs
  const collapsed = props.controller.collapsed
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  let lastUpdated = 0
  let debounce: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  async function refresh() {
    if (disposed) return
    const next = await readStateFromFile()
    if (!disposed && next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated
      setState(next)
    }
  }

  function scheduleRefresh() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void refresh()
    }, prefs().refreshDebounceMs)
  }

  // Background poller (server and TUI run as separate module instances, so we
  // sync through the state file) plus event-driven refreshes for low latency.
  // The interval rebuilds whenever pollMs changes.
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  const unsubs = [
    props.api.event.on('session.updated', scheduleRefresh),
    props.api.event.on('message.updated', scheduleRefresh),
  ]
  const initialRefresh = setTimeout(refresh, 300)

  onCleanup(() => {
    disposed = true
    clearTimeout(initialRefresh)
    if (debounce) clearTimeout(debounce)
    for (const u of unsubs) u()
  })

  const theme = () => props.api.theme.current
  const enabledFallbacks = () =>
    (state().fallbacks ?? []).filter((f) => f.enabled)
  // Vault mode: the host uses only the vault's accounts, which the file lists
  // in `vaultAccounts`; main and the local fallbacks are not shown.
  const vaultMode = () => state().vaultAccounts !== undefined
  const vaultAccounts = () => state().vaultAccounts ?? []
  const hasData = () =>
    vaultMode()
      ? vaultAccounts().length > 0
      : state().main?.quota != null || enabledFallbacks().length > 0

  const sessionRouting = () =>
    resolveSessionSidebarRouting(state(), props.sessionId)
  const sessionState = (): SidebarState => ({
    ...state(),
    activeId: sessionRouting().activeId,
    route: sessionRouting().route,
  })
  const activeAccount = () => resolveActiveAccount(sessionState())
  const collapsedLines = () =>
    getCollapsedAccountLines(sessionState(), {
      showFallbacks: prefs().sections.fallbackAccounts,
    })
  const quotaLabelWidth = () => computeQuotaLabelWidth(renderedQuotas(state()))
  const activeQuotaSummary = () =>
    getCollapsedQuotaSummary(activeAccount().quota)
  const activePacingDeficit = () => {
    if (!prefs().sections.pacing) return false
    return buildQuotaRowsForDisplay(
      activeAccount().quota,
      Date.now(),
      true,
    ).some((row) => row.pacing?.state === 'deficit')
  }
  const activeQuotaTone = (): Tone => {
    const summary = activeQuotaSummary()
    const values = [
      summary.primaryUsedPercent,
      summary.secondaryUsedPercent,
    ].filter((value): value is number => value != null)
    // Pacing deficit is an advisory projection, not actual quota exhaustion,
    // so it can only BUMP the usage tone up to warn at most — never soften a
    // real warn/err usage reading and never paint a true red.
    const base: Tone =
      values.length > 0
        ? usageTone(Math.max(...values), prefs().appearance)
        : 'muted'
    if (!activePacingDeficit()) return base
    return base === 'ok' || base === 'muted' ? 'warn' : base
  }
  const killedNames = () =>
    [
      !vaultMode() && state().main?.killed ? 'main' : '',
      ...(vaultMode() ? vaultAccounts() : enabledFallbacks())
        .filter((f) => f.killed)
        .map((f) => f.label ?? f.id),
    ].filter(Boolean)

  const quotaBackedOff = () => state().main?.quotaBackedOff === true
  const refreshBackedOff = () => state().main?.refreshBackedOff === true
  const degraded = () =>
    killedNames().length > 0 || quotaBackedOff() || refreshBackedOff()

  const allAccounts = () =>
    vaultMode()
      ? vaultAccounts().map((account) => ({
          ...account,
          label: account.label ?? account.id,
          hostDisabled: !account.enabled,
        }))
      : [
          {
            id: 'main',
            label: 'main',
            quota: state().main?.quota ?? null,
            killed: state().main?.killed ?? false,
            resetCredits: state().main?.resetCredits,
            vaultState: undefined,
            hostDisabled: false,
          },
          ...enabledFallbacks().map((account) => ({
            ...account,
            label: account.label ?? account.id,
            hostDisabled: false,
          })),
        ]
  const accounts = (): AccountView[] => {
    if (!hasData()) return []
    const rawAccounts = allAccounts()
    const selected = collapsed()
      ? collapsedLines().flatMap((line) => {
          const raw = rawAccounts.find((account) => account.id === line.id)
          return raw ? [{ raw, muted: line.stale || !line.active }] : []
        })
      : rawAccounts
          .filter(
            (account) =>
              vaultMode() ||
              account.id === 'main' ||
              prefs().sections.fallbackAccounts,
          )
          .map((raw) => ({ raw, muted: false }))
    return selected.map(({ raw, muted }) => {
      const active = sessionRouting().activeId === raw.id
      const quota = sidebarQuotaProjection(raw.quota, Date.now())
      const parts = quotaWindowParts(quota, {
        now: Date.now(),
        staleAfterMs: Number.POSITIVE_INFINITY,
      }).windows
      return {
        id: raw.id,
        label: raw.label,
        status: {
          text: raw.killed ? 'blocked' : active ? 'active' : 'idle',
          tone: raw.killed ? 'error' : active ? 'success' : 'textMuted',
        },
        blocked: raw.killed,
        indicatorTone: raw.killed
          ? 'error'
          : muted
            ? 'textMuted'
            : frameTone(activeQuotaTone()),
        collapsed: { quotaTone: frameTone(activeQuotaTone()), muted },
        quota,
        groups: [
          {
            rows: buildQuotaRowsForDisplay(
              raw.quota,
              Date.now(),
              prefs().sections.pacing,
            ).flatMap((row) => {
              const part = parts.find((part) => part.name === row.label)
              if (!part) return []
              return [
                {
                  part: {
                    ...part,
                    // Hidden fallback rows still reserve their label column.
                    name: row.label.padEnd(quotaLabelWidth() - 1),
                    figure: row.text.slice(row.label.length + 1),
                    remainingPercent: 100 - row.window.usedPercent,
                  },
                  pace: paceView(row.pacing),
                },
              ]
            }),
          },
        ],
        emptyQuotaText: {
          expanded: isQuotaLoaded(raw.quota) ? '\u2014' : 'checking\u2026',
          collapsed: '\u2014',
        },
      }
    })
  }

  return (
    <SidebarFrame
      header={{
        badge: prefs().header.label,
        version:
          prefs().header.showVersion && PLUGIN_VERSION !== ''
            ? `v${PLUGIN_VERSION}`
            : undefined,
      }}
      accounts={accounts()}
      theme={theme()}
      appearance={prefs().appearance}
      showQuota={prefs().sections.quota}
      now={Date.now()}
      collapsed={collapsed()}
      onToggle={props.controller.toggleCollapsed}
      beforeQuota={(account) => {
        const raw = allAccounts().find((raw) => raw.id === account.id)
        return (
          <>
            <Show when={raw?.vaultState}>
              <SidebarTextRow text={raw?.vaultState ?? ''} tone='warning' />
            </Show>
            <Show when={raw?.hostDisabled}>
              <SidebarTextRow text='off in /openai' />
            </Show>
          </>
        )
      }}
      afterQuota={(account) => {
        const raw = allAccounts().find((raw) => raw.id === account.id)
        return (
          <For
            each={getAccountMetadataRows(
              raw?.resetCredits,
              raw?.quota?.spendControl,
              accountCreditsText(raw?.quota ?? null),
              sessionRouting().activeId === account.id &&
                accountServesOnCredits(raw?.quota ?? null, Date.now()),
            )}
          >
            {(row) => (
              <AccountMetaRow
                theme={theme()}
                label={row.label}
                value={row.value}
              />
            )}
          </For>
        )
      }}
      sections={() => (
        <>
          <Show when={!hasData()}>
            <box marginTop={1} width='100%'>
              <SidebarTextRow
                text={
                  vaultMode()
                    ? state().vaultDiscovered === true
                      ? 'No vault accounts'
                      : "Waiting for the vault's first answer"
                    : 'Waiting for quota\u2026'
                }
              />
            </box>
          </Show>
          <Show when={prefs().sections.routing}>
            <SidebarSection title='Routing'>
              <For each={buildRoutingRowsForDisplay(state(), props.sessionId)}>
                {(row) => (
                  <SidebarStatRow
                    label={row.label}
                    value={row.value}
                    tone={frameTone(row.tone)}
                  />
                )}
              </For>
            </SidebarSection>
          </Show>
          <For each={getQuotaMetadataRows(state())}>
            {(row) => (
              <SidebarStatRow label={row.label} value={row.value} tone='text' />
            )}
          </For>
          <Show when={degraded() && prefs().sections.health}>
            <SidebarSection title='Health'>
              <Show when={quotaBackedOff()}>
                <SidebarStatRow
                  label='Quota API'
                  value={`backoff ${formatUntil(state().main?.quotaBackoffUntil)}`}
                  tone='warning'
                />
              </Show>
              <Show when={refreshBackedOff()}>
                <SidebarStatRow
                  label='Token refresh'
                  value={`backoff ${formatUntil(state().main?.refreshBackoffUntil)}`}
                  tone='warning'
                />
              </Show>
            </SidebarSection>
          </Show>
          <Show when={killedNames().length > 0}>
            <SidebarStatRow
              label='Killswitch'
              value={`${killedNames().join(', ')} blocked`}
              tone='error'
            />
          </Show>
        </>
      )}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  const root = await readTuiPreferencesFile()
  const controller = createSidebarController(resolveOpenaiAuthPrefs(root))
  api.slots.register({
    order: computeEffectiveOrder(root, PLUGIN_KEY, DEFAULT_SLOT_ORDER),
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return (
          <QuotaSidebar
            api={api}
            controller={controller}
            sessionId={props.session_id}
          />
        )
      },
    },
  })

  if (!rpcPollStarted) {
    rpcPollStarted = true
    const myPid = process.pid
    const rpcDir = await resolveRpcDir(api.state.path.directory ?? '')
    const rpcClient = createRpcClient(rpcDir.dir, myPid, (entry) => {
      log.debug('rpc tui pid', {
        myPid,
        matchedPortFilePid: entry?.pid ?? null,
        rpcPort: entry?.port ?? null,
      })
    })
    let lastNotificationId = 0
    let rpcInFlight = false
    // A stretch of consecutive failed polls ends at the next success, which
    // re-arms the slow-server toast.
    let rpcFailures = 0
    let lastRpcFailureLogAt = 0
    // Counts one failed poll: a throw, or an empty answer after taking at
    // least the poll's own timeout (a socket timeout resolves to no messages
    // instead of throwing, so elapsed time is the slow server's only signal).
    const noteRpcPollFailure = (error: unknown) => {
      rpcFailures++
      const now = Date.now()
      if (now - lastRpcFailureLogAt >= POLL_FAILURE_LOG_INTERVAL_MS) {
        lastRpcFailureLogAt = now
        log.warn('OpenAI plugin poll failed', {
          error: pollFailureClass(error),
        })
      }
      if (rpcFailures === SLOW_SERVER_POLL_FAILURES)
        api.ui.toast({ message: SLOW_SERVER_MESSAGE })
    }
    setInterval(() => {
      if (rpcInFlight) return
      const current = (api.route as { current?: unknown }).current
      const resolved =
        typeof current === 'function' ? (current as () => unknown)() : current
      const sessionId = (
        resolved as { params?: { sessionID?: string } } | undefined
      )?.params?.sessionID
      rpcInFlight = true
      const pollStartedAt = Date.now()
      void rpcClient
        .pending(lastNotificationId, sessionId)
        .then((messages) => {
          if (
            messages.length === 0 &&
            Date.now() - pollStartedAt >= DEFAULT_RPC_TIMEOUT_MS
          ) {
            noteRpcPollFailure(
              new Error(
                `RPC pending poll timed out after ${DEFAULT_RPC_TIMEOUT_MS} ms`,
              ),
            )
            return
          }
          rpcFailures = 0
          for (const message of [...messages].sort((a, b) => a.id - b.id)) {
            lastNotificationId = Math.max(lastNotificationId, message.id)
            const payload = message.payload
            if (isNotifyPayload(payload)) {
              api.ui.toast({ message: payload.notify.message })
              continue
            }
            openCommandDialog(api, payload, (request) =>
              rpcClient.apply(
                buildApplyRequest(request, sessionId),
                MENU_APPLY_TIMEOUT_MS,
              ),
            )
          }
        })
        .catch((error) => {
          // The server can be absent while a location starts or is reloaded.
          noteRpcPollFailure(error)
        })
        .finally(() => {
          rpcInFlight = false
        })
    }, RPC_POLL_MS)
  }
}

async function setup(
  context: Plugin.Context,
  options: TuiTransportOptions = {},
) {
  if (options.sidebarText !== undefined || options.sidebar)
    return setupTui(context, options)
  const root = await readTuiPreferencesFile()
  const controller = createSidebarController(resolveOpenaiAuthPrefs(root))
  const api = {
    theme: {
      get current() {
        return sidebarThemeFromHost(context.theme)
      },
    },
    event: {
      on: (type: 'session.updated' | 'message.updated', listener: () => void) =>
        context.data.on(
          type === 'session.updated'
            ? 'session.metadata.updated'
            : 'session.usage.updated',
          listener,
        ),
    },
  }
  return setupTui(context, {
    ...options,
    sidebar: {
      render: (input) => (
        <QuotaSidebar
          api={api}
          controller={controller}
          sessionId={input.sessionID}
        />
      ),
      dispose: controller.dispose,
    },
  })
}

const plugin: TuiPluginModule & { id: string; setup: typeof setup } = {
  id: ID,
  setup,
  tui,
}

export default plugin
