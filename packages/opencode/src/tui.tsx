/** @jsxImportSource @opentui/solid */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatQuota,
  quotaTextParts,
  quotaWindowParts,
} from '@cortexkit/common-auth/quota'
import type { Plugin } from '@opencode/plugin/tui'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { RGBA } from '@opentui/core'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
} from 'solid-js'
import { createLogger } from './logger.js'
import { type ApplyRequest, isNotifyPayload } from './rpc/protocol.js'
import { createRpcClient, DEFAULT_RPC_TIMEOUT_MS } from './rpc/rpc-client.js'
import { resolveRpcDir } from './rpc/rpc-dir.js'
import {
  type AccountQuota,
  accountCreditsText,
  accountServesOnCredits,
  type CollapsedAccountLine,
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

// biome-ignore lint/suspicious/noExplicitAny: opentui border prop not typed in plugin tui surface
const SINGLE_BORDER = { type: 'single' } as any

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

// Tone -> theme token. Theme tokens only — never hardcoded colors. Fallbacks
// resolve to other theme tokens so the sidebar always tracks the active theme.
function toneColor(theme: ThemeCurrent, tone: Tone): ThemeColor {
  switch (tone) {
    case 'ok':
      return theme.success ?? theme.accent
    case 'warn':
      return theme.warning ?? theme.accent
    case 'err':
      return theme.error ?? theme.accent
    case 'muted':
      return theme.textMuted ?? theme.text
    case 'accent':
      return theme.accent ?? theme.text
    default:
      return theme.text
  }
}

function usageTone(usedPct: number, appearance: AppearancePrefs): Tone {
  if (usedPct < appearance.warnThreshold) return 'ok'
  if (usedPct < appearance.errorThreshold) return 'warn'
  return 'err'
}

interface BarSegment {
  text: string
  tone: Tone
}

const PACE_RESERVE_CHAR = '\u2592'
const PACE_DEFICIT_CHAR = '\u2593'

// Variant C pacing bar: normal fill up to min(used, pace), then a pace
// segment covering the gap — headroom being banked (reserve, ok tone) or the
// overshoot itself (deficit, err tone) — then empty cells. Without pacing the
// bar renders as a single fill+empty pair, identical to the pre-pacing look.
// Empty text nodes still occupy a phantom cell in the opentui flex row, so
// zero-length segments are dropped from every return path (plain and pacing).
function quotaBarSegments(
  usedPct: number,
  appearance: AppearancePrefs,
  pacing: QuotaPacing | null,
): BarSegment[] {
  const width = appearance.barWidth
  const cells = (pct: number) =>
    Math.max(0, Math.min(Math.round((pct / 100) * width), width))
  const usedCells = cells(usedPct)
  const fillTone = usageTone(usedPct, appearance)
  const plain: BarSegment[] = [
    { text: appearance.barFilledChar.repeat(usedCells), tone: fillTone },
    {
      text: appearance.barEmptyChar.repeat(width - usedCells),
      tone: fillTone,
    },
  ]
  if (!pacing) return plain.filter((segment) => segment.text.length > 0)
  const paceCells = cells(pacing.pacePercent)
  const lo = Math.min(usedCells, paceCells)
  const hi = Math.max(usedCells, paceCells)
  if (hi === lo) return plain.filter((segment) => segment.text.length > 0)
  const overspent = usedCells > paceCells
  return (
    [
      { text: appearance.barFilledChar.repeat(lo), tone: fillTone },
      {
        text: (overspent ? PACE_DEFICIT_CHAR : PACE_RESERVE_CHAR).repeat(
          hi - lo,
        ),
        tone: overspent ? 'err' : 'ok',
      },
      { text: appearance.barEmptyChar.repeat(width - hi), tone: fillTone },
    ] as BarSegment[]
  ).filter((segment) => segment.text.length > 0)
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

// --- Reusable components (aft-style) ---------------------------------------

function SectionHeader(props: {
  theme: ThemeCurrent
  title: string
  marginTop?: number
}) {
  return (
    <box width='100%' marginTop={props.marginTop ?? 1}>
      <text fg={props.theme.text}>
        <b>{props.title}</b>
      </text>
    </box>
  )
}

function StatRow(props: {
  theme: ThemeCurrent
  label: string
  value: string
  tone?: Tone
}) {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme.textMuted}>{props.label}</text>
      <text fg={toneColor(props.theme, props.tone ?? 'text')}>
        <b>{props.value}</b>
      </text>
    </box>
  )
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

// One account in the collapsed view: label left; narrow quota text and the
// status dot right (red ⊘ when killed). The session's account keeps the
// usage tone; other accounts, and any account whose reading is stale, are
// drawn muted. The row measures its own width so only the label is cut (with
// …) when the line does not fit; the quota text is never cut.
function CollapsedAccountRow(props: {
  theme: ThemeCurrent
  line: CollapsedAccountLine
  tone: Tone
}) {
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const dim = () => props.line.stale || !props.line.active
  const label = () => {
    const columns = width()
    if (columns <= 0) return props.line.name
    // The value side is the text plus ` ●`, or a lone `—`; one column
    // separates it from the label.
    const value =
      props.line.text === null ? 1 : displayWidth(props.line.text) + 2
    return fitCollapsedLabel(props.line.name, columns - value - 1)
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
      <text
        fg={toneColor(props.theme, dim() ? 'muted' : 'text')}
        wrapMode='none'
        flexShrink={1}
      >
        {label()}
      </text>
      <Show
        when={props.line.text !== null}
        fallback={<text fg={props.theme.textMuted}>{'\u2014'}</text>}
      >
        <box flexDirection='row' flexShrink={0}>
          <Show
            when={!dim()}
            fallback={
              <text fg={toneColor(props.theme, 'muted')}>
                {props.line.text}
              </text>
            }
          >
            <text fg={toneColor(props.theme, props.tone)}>
              <b>{props.line.text}</b>
            </text>
          </Show>
          <text
            fg={toneColor(
              props.theme,
              props.line.killed ? 'err' : dim() ? 'muted' : props.tone,
            )}
          >
            {props.line.killed ? ' \u2298' : ' \u25cf'}
          </text>
        </box>
      </Show>
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
const MIN_QUOTA_BAR_CELLS = 3

export interface QuotaRowFit {
  /** Cells of usage bar to draw; 0 draws no bar. */
  barCells: number
  showReset: boolean
}

/**
 * How an expanded quota row fits on one line `columns` cells wide. The row is
 * the padded label, the bar, the " N% left" figure and, at the right edge, the
 * reset time. When it does not fit, the reset time goes first, then the bar
 * shrinks (to no fewer than MIN_QUOTA_BAR_CELLS cells, else it is dropped).
 * The label and the figure are never cut. `columns` of 0 means the row has not
 * been measured yet, and everything is drawn.
 */
export function fitQuotaRow(input: {
  columns: number
  label: string
  barWidth: number
  figure: string
  resetText?: string
}): QuotaRowFit {
  const { columns, barWidth } = input
  const reset = input.resetText ? displayWidth(input.resetText) : 0
  if (columns <= 0) return { barCells: barWidth, showReset: reset > 0 }
  const fixed = displayWidth(input.label) + displayWidth(input.figure)
  // The reset sits at the right edge with at least one blank cell before it,
  // so it never runs into the figure.
  if (reset > 0 && fixed + barWidth + 1 + reset <= columns)
    return { barCells: barWidth, showReset: true }
  const room = columns - fixed
  if (room >= barWidth) return { barCells: barWidth, showReset: false }
  return {
    barCells: room >= MIN_QUOTA_BAR_CELLS ? room : 0,
    showReset: false,
  }
}

// Quota window row: muted label left, tone-colored usage bar and shared quota text.
// When pacing data is present, the bar
// gains a pace segment and an off-pace window adds a muted subline with the
// reserve/deficit delta and the projected runout.
// The row measures its own width and never wraps: fitQuotaRow decides what is
// left out when it is too narrow, and the pacing subline is cut with ….
function QuotaRow(props: {
  theme: ThemeCurrent
  appearance: AppearancePrefs
  label: string
  labelWidth: number
  text: string
  resetText?: string
  window: { usedPercent: number; resetsAt?: string } | undefined
  pacing: QuotaPacing | null
}) {
  const used = () => props.window?.usedPercent ?? 0
  const [columns, setColumns] = createSignal(0)
  let row: { width: number } | undefined
  const label = () => props.label.padEnd(props.labelWidth)
  const figure = () => ` ${props.text.slice(props.label.length + 1)}`
  const fit = () =>
    fitQuotaRow({
      columns: columns(),
      label: label(),
      barWidth: props.appearance.barWidth,
      figure: figure(),
      resetText: props.resetText,
    })
  // Memos, so a new measured width that leaves the fit unchanged (as the
  // first measurement usually does) does not rebuild the bar's text nodes:
  // rebuilt nodes are blank until the next frame is drawn.
  const barCells = createMemo(() => fit().barCells)
  const showReset = createMemo(() => fit().showReset)
  const fittedPaceLine = () => {
    const line = paceLine()
    if (line === null || columns() <= 0) return line
    // The subline is indented by the label column; cut it to the rest.
    return fitCollapsedLabel(line, columns() - props.labelWidth)
  }
  const paceLine = () => {
    const pacing = props.pacing
    if (!pacing || pacing.state === 'on-pace') return null
    const pct = Math.round(Math.abs(pacing.deltaPercent))
    if (pacing.state === 'reserve') return `reserve ${pct}% \u00b7 lasts`
    return pacing.runsOutAt
      ? `deficit ${pct}% \u00b7 out in ${formatResetIn(pacing.runsOutAt)}`
      : `deficit ${pct}% \u00b7 lasts`
  }
  return (
    <Show
      when={props.window}
      fallback={
        <box width='100%' flexDirection='row'>
          <text fg={props.theme.textMuted}>
            {props.label.padEnd(props.labelWidth)}
          </text>
          <text fg={props.theme.textMuted}>{'\u2014'}</text>
        </box>
      }
    >
      {/* Bars show usage; the adjacent figure shows quota left, as in the dialog. */}
      <box
        ref={(element: { width: number }) => {
          row = element
        }}
        onSizeChange={() => setColumns(row?.width ?? 0)}
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
      >
        <box flexDirection='row' flexShrink={0}>
          <text fg={props.theme.textMuted} wrapMode='none'>
            {label()}
          </text>
          <For
            each={quotaBarSegments(
              used(),
              { ...props.appearance, barWidth: barCells() },
              props.pacing,
            )}
          >
            {(segment) => (
              <text fg={toneColor(props.theme, segment.tone)} wrapMode='none'>
                {segment.text}
              </text>
            )}
          </For>
          <text
            fg={toneColor(props.theme, usageTone(used(), props.appearance))}
            wrapMode='none'
          >
            {figure()}
          </text>
        </box>
        <Show when={showReset()}>
          <text fg={props.theme.textMuted} wrapMode='none' flexShrink={0}>
            {props.resetText}
          </text>
        </Show>
      </box>
      {/* Keyed, so a cut to a new width draws a new text node: on Bun 1.3
          an existing node kept drawing the text it was created with. */}
      <Show when={fittedPaceLine()} keyed>
        {(line) => (
          <box width='100%' flexDirection='row'>
            <text fg={props.theme.textMuted}>
              {''.padEnd(props.labelWidth)}
            </text>
            <text
              fg={toneColor(
                props.theme,
                props.pacing?.state === 'deficit' ? 'warn' : 'muted',
              )}
              wrapMode='none'
            >
              {line}
            </text>
          </box>
        )}
      </Show>
    </Show>
  )
}

// Account block: header row (name + status word) then per-window quota rows.
// Pacing is computed here — per window, against the wall clock at render time
// (re-evaluated on every state poll) — and disabled by passing false.
function AccountBlock(props: {
  theme: ThemeCurrent
  appearance: AppearancePrefs
  name: string
  quota: AccountQuota | null
  killed: boolean
  vaultState?: string
  hostDisabled?: boolean
  active: boolean
  pacingEnabled: boolean
  labelWidth: number
  resetCredits?: number
  marginTop?: number
}) {
  const statusWord = () =>
    props.killed ? 'blocked' : props.active ? 'active' : 'idle'
  const statusTone = (): Tone =>
    props.killed ? 'err' : props.active ? 'ok' : 'muted'
  const rows = () =>
    buildQuotaRowsForDisplay(
      props.quota,
      Date.now(),
      props.pacingEnabled,
      props.labelWidth,
    )
  return (
    <box width='100%' flexDirection='column' marginTop={props.marginTop ?? 0}>
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <text fg={props.theme.text}>
          <b>{props.name}</b>
        </text>
        <text fg={toneColor(props.theme, statusTone())}>
          <b>{statusWord()}</b>
        </text>
      </box>
      <Show when={props.vaultState}>
        <text fg={props.theme.warning}>{props.vaultState}</text>
      </Show>
      <Show when={props.hostDisabled}>
        <text fg={props.theme.textMuted}>off in /openai</text>
      </Show>
      <Show
        when={isQuotaLoaded(props.quota)}
        fallback={<text fg={props.theme.textMuted}>{'checking\u2026'}</text>}
      >
        <Show
          when={rows().length > 0}
          fallback={<text fg={props.theme.textMuted}>{'\u2014'}</text>}
        >
          <For each={rows()}>
            {(row) => (
              <QuotaRow
                theme={props.theme}
                appearance={props.appearance}
                label={row.label}
                labelWidth={row.labelWidth}
                text={row.text}
                resetText={row.resetText}
                window={row.window}
                pacing={row.pacing}
              />
            )}
          </For>
        </Show>
      </Show>
      <For
        each={quotaTextParts(sidebarQuotaProjection(props.quota, Date.now()), {
          now: Date.now(),
          form: 'compact',
        }).filter((part) => part.startsWith('checked '))}
      >
        {(age) => <text fg={props.theme.textMuted}>{age}</text>}
      </For>
      <For
        each={getAccountMetadataRows(
          props.resetCredits,
          props.quota?.spendControl,
          accountCreditsText(props.quota),
          props.active && accountServesOnCredits(props.quota, Date.now()),
        )}
      >
        {(row) => (
          <AccountMetaRow
            theme={props.theme}
            label={row.label}
            value={row.value}
          />
        )}
      </For>
    </box>
  )
}

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

  const headerLabel = () => {
    const name = prefs().header.label
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`
  }
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

  return (
    <box
      width='100%'
      flexDirection='column'
      border={SINGLE_BORDER}
      borderColor={theme().borderActive}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Header: ▼/▶ OPENAI badge (click to collapse) + version, or LIMITED badge */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui renders to a terminal, not the DOM — ARIA roles do not apply */}
      <box
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
        alignItems='center'
        onMouseDown={() => {
          if (hasData()) props.controller.toggleCollapsed()
        }}
      >
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme().accent}>
          <text fg={theme().background}>
            <b>{headerLabel()}</b>
          </text>
        </box>
        <Show
          when={degraded()}
          fallback={
            <Show when={prefs().header.showVersion && PLUGIN_VERSION !== ''}>
              <text fg={theme().textMuted}>{`v${PLUGIN_VERSION}`}</text>
            </Show>
          }
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme().warning}
          >
            <text fg={theme().background}>
              <b>{'LIMITED'}</b>
            </text>
          </box>
        </Show>
      </box>

      {/* Collapsed: one line per account, narrow quota text + dot (red ⊘ when killed) */}
      <Show when={collapsed() && hasData()}>
        <Index each={collapsedLines()}>
          {(line) => (
            <CollapsedAccountRow
              theme={theme()}
              line={line()}
              tone={activeQuotaTone()}
            />
          )}
        </Index>
      </Show>

      {/* Expanded: full sections. Also render when there's no data so the
          sidebar can never go blank if data clears while collapsed. */}
      <Show when={!collapsed() || !hasData()}>
        <Show
          when={hasData()}
          fallback={
            <box marginTop={1} width='100%'>
              <text fg={theme().textMuted}>{'Waiting for quota\u2026'}</text>
            </box>
          }
        >
          {/* Quota */}
          <Show when={prefs().sections.quota}>
            <SectionHeader theme={theme()} title='Quota' />
            <Show
              when={!vaultMode()}
              fallback={
                <For each={vaultAccounts()}>
                  {(account, index) => (
                    <AccountBlock
                      theme={theme()}
                      appearance={prefs().appearance}
                      name={account.label ?? account.id}
                      quota={account.quota}
                      killed={account.killed}
                      vaultState={account.vaultState}
                      hostDisabled={!account.enabled}
                      active={sessionRouting().activeId === account.id}
                      pacingEnabled={prefs().sections.pacing}
                      labelWidth={quotaLabelWidth()}
                      resetCredits={account.resetCredits}
                      marginTop={index() === 0 ? 0 : 1}
                    />
                  )}
                </For>
              }
            >
              <AccountBlock
                theme={theme()}
                appearance={prefs().appearance}
                name='main'
                quota={state().main?.quota ?? null}
                killed={state().main?.killed ?? false}
                active={sessionRouting().activeId === 'main'}
                pacingEnabled={prefs().sections.pacing}
                labelWidth={quotaLabelWidth()}
                resetCredits={state().main?.resetCredits}
              />
              <Show when={prefs().sections.fallbackAccounts}>
                <For each={enabledFallbacks()}>
                  {(fb) => (
                    <AccountBlock
                      theme={theme()}
                      appearance={prefs().appearance}
                      name={fb.label ?? fb.id}
                      quota={fb.quota}
                      killed={fb.killed}
                      active={sessionRouting().activeId === fb.id}
                      pacingEnabled={prefs().sections.pacing}
                      labelWidth={quotaLabelWidth()}
                      resetCredits={fb.resetCredits}
                      marginTop={1}
                    />
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </Show>

        {/* Routing */}
        <Show when={prefs().sections.routing}>
          <SectionHeader theme={theme()} title='Routing' />
          <For each={buildRoutingRowsForDisplay(state(), props.sessionId)}>
            {(row) => (
              <StatRow
                theme={theme()}
                label={row.label}
                value={row.value}
                tone={row.tone}
              />
            )}
          </For>
        </Show>

        {/* Plan and credits — whichever are present */}
        <For each={getQuotaMetadataRows(state())}>
          {(row) => (
            <StatRow
              theme={theme()}
              label={row.label}
              value={row.value}
              tone='text'
            />
          )}
        </For>

        {/* Health — only when something is wrong */}
        <Show when={degraded() && prefs().sections.health}>
          <SectionHeader theme={theme()} title='Health' />
          <Show when={quotaBackedOff()}>
            <StatRow
              theme={theme()}
              label='Quota API'
              value={`backoff ${formatUntil(state().main?.quotaBackoffUntil)}`}
              tone='warn'
            />
          </Show>
          <Show when={refreshBackedOff()}>
            <StatRow
              theme={theme()}
              label='Token refresh'
              value={`backoff ${formatUntil(state().main?.refreshBackoffUntil)}`}
              tone='warn'
            />
          </Show>
        </Show>
        <Show when={killedNames().length > 0}>
          <StatRow
            theme={theme()}
            label='Killswitch'
            value={`${killedNames().join(', ')} blocked`}
            tone='err'
          />
        </Show>
      </Show>
    </box>
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
