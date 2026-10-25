// Renders the collapsed sidebar on OpenCode 2 (the `sidebar.content` slot)
// and OpenCode 1 (the `sidebar_content` slot) side by side in a 42-column
// frame, the sidebar width OpenCode uses, and checks both draw the same
// characters and colors. Run as a script with the shared Solid/OpenTUI
// runtime preloaded (see tui-quota-render.test.ts); it prints
// `collapsed-sidebar-render passed` on success.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RGBA } from '@opentui/core'
import { type JSX, testRender } from '@opentui/solid'
import type { SidebarState } from '../../sidebar-state'

const root = mkdtempSync(join(tmpdir(), 'openai-collapsed-render-'))
const stateFile = join(root, 'sidebar.json')
const prefsFile = join(root, 'preferences.jsonc')
process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = stateFile
process.env.OPENCODE_TUI_PREFERENCES_FILE = prefsFile
process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(root, 'credentials.json')
writeFileSync(
  prefsFile,
  JSON.stringify({
    'openai-auth': { collapsed: true, sections: { pacing: false } },
  }),
)

const { default: plugin } = await import(
  new URL('../../tui/entry.mjs', import.meta.url).href
)
const now = Date.now()
Date.now = () => now
const WIDTH = 42
const HOUR = 60 * 60_000

/** A reading of both general windows, taken `ageMs` ago. */
function reading(primaryUsed: number, secondaryUsed: number, ageMs = 0) {
  const checkedAt = now - ageMs
  return {
    checkedAt,
    primary: {
      usedPercent: primaryUsed,
      remainingPercent: 100 - primaryUsed,
      windowMinutes: 300,
      checkedAt,
    },
    secondary: {
      usedPercent: secondaryUsed,
      remainingPercent: 100 - secondaryUsed,
      windowMinutes: 10080,
      checkedAt,
    },
  }
}
const account = (
  id: string,
  label: string,
  quota: ReturnType<typeof reading> | null,
  extra: Record<string, unknown> = {},
) => ({ id, label, enabled: true, quota, killed: false, ...extra })

let sequence = now
const publish = (state: Partial<SidebarState>) =>
  writeFileSync(
    stateFile,
    JSON.stringify({
      main: { quota: null, killed: false },
      fallbacks: [],
      activeId: 'main',
      route: 'main-first',
      ...state,
      lastUpdated: ++sequence,
    }),
  )
publish({ main: { quota: reading(40, 70), killed: false } })

const color = (hex: string) => RGBA.fromHex(hex)
const theme = {
  text: color('#f0f0f0'),
  textMuted: color('#888888'),
  accent: color('#55aaff'),
  background: color('#101010'),
  borderActive: color('#55aaff'),
  success: color('#00cc55'),
  warning: color('#ffaa00'),
  error: color('#ff0055'),
}
const hostTheme = {
  text: {
    base: color('#f0f0f0'),
    muted: color('#888888'),
    feedback: {
      success: { base: color('#00cc55') },
      warning: { base: color('#ffaa00') },
      error: { base: color('#ff0055') },
    },
    action: { primary: { base: color('#55aaff') } },
  },
  background: { base: color('#101010') },
  border: { base: color('#55aaff') },
}
type Claim = {
  render(input: { readonly sessionID: string }): JSX.Element
}
let claim: Claim | undefined
let slotOwner: { destroy?: () => void } = {}
const polls = new Map<number, () => Promise<void>>()
const interval = globalThis.setInterval
const clear = globalThis.clearInterval
const timers = new Set<number>()
// Take over the sidebar's state-file poll so each step refreshes on demand.
globalThis.setInterval = ((
  fn: () => Promise<void>,
  ms: number,
  ...args: unknown[]
) => {
  const timer = interval(fn, ms === 1500 ? 60_000 : ms, ...args)
  timers.add(Number(timer))
  if (ms === 1500) polls.set(Number(timer), fn)
  return timer
}) as typeof setInterval
globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
  polls.delete(Number(timer))
  timers.delete(Number(timer))
  clear(timer)
}) as typeof clearInterval
const on = () => () => {}
const cleanup = await plugin.setup({
  theme: hostTheme,
  data: { on },
  ui: {
    router: { current: () => ({ type: 'home' }) },
    slot(next: Claim) {
      claim = next
      const owner = {}
      slotOwner = owner
      return () => (owner as typeof slotOwner).destroy?.()
    },
  },
})
const view = await testRender(() => claim?.render({ sessionID: 'session' }), {
  width: WIDTH,
  height: 14,
})
slotOwner.destroy = () => view.renderer.destroy()
let v1Render: (() => JSX.Element) | undefined
await plugin.tui({
  theme: { current: theme },
  event: { on },
  state: { path: { directory: root } },
  route: { current: () => ({ type: 'home' }) },
  slots: {
    register(input: {
      slots: {
        sidebar_content: (
          _: unknown,
          props: { readonly session_id: string },
        ) => JSX.Element
      }
    }) {
      v1Render = () =>
        input.slots.sidebar_content(null, { session_id: 'session' })
    },
  },
})
const v1 = await testRender(() => v1Render?.(), { width: WIDTH, height: 14 })

const frame = () => view.captureCharFrame()
/** Refresh both sidebars from the state file and draw them until settled. */
async function step(state: Partial<SidebarState>) {
  publish(state)
  await Promise.all([...polls.values()].map((refresh) => refresh()))
  // The second and third passes draw the labels cut to the width each row
  // measured in the first.
  for (let pass = 0; pass < 3; pass++) {
    await view.renderOnce()
    await v1.renderOnce()
  }
  assert.equal(frame(), v1.captureCharFrame())
  assert.deepEqual(view.captureSpans(), v1.captureSpans())
}
/** The frame's account lines (between the header and the bottom border). */
const accountLines = () =>
  frame()
    .split('\n')
    .map((line) => line.replace(/[│]/g, '').trim())
    .filter((line) => / (?:●|⊘)$|—$/.test(line))
/**
 * The width of an account row, from the first line drawn: a line whose quota
 * text sits at the right edge and label at the left spans the whole row.
 */
const row = () => accountLines()[0]?.length ?? 0
/** The styled spans of the frame line containing `text`, borders left out. */
function spansOf(text: string) {
  const line = view.captureSpans().lines.find((line) =>
    line.spans
      .map((span) => span.text)
      .join('')
      .includes(text),
  )
  assert.ok(line, `no line contains ${text}: ${frame()}`)
  return line.spans.filter((span) => span.text.replace(/[│\s]/g, '') !== '')
}
const same = (left: RGBA, right: RGBA) => left.equals(right)
/** Asserts every visible character of the line is drawn muted. */
function assertDim(text: string) {
  for (const span of spansOf(text))
    assert.ok(same(span.fg, theme.textMuted), `"${span.text}" is not muted`)
}
/** Asserts the line's quota text and dot carry `tone`, the label plain text. */
function assertActive(label: string, tone: RGBA) {
  const spans = spansOf(label)
  const quota = spans.find((span) => span.text.includes('% '))
  const dot = spans.find((span) => span.text.includes('●'))
  const name = spans.find((span) => span.text.includes(label))
  assert.ok(quota && dot && name, `missing parts of ${label}: ${frame()}`)
  assert.ok(same(quota.fg, tone), 'the quota text is not in the usage tone')
  assert.ok(same(dot.fg, tone), 'the dot is not in the usage tone')
  assert.ok(same(name.fg, theme.text), 'the label is not plain text')
}
const NARROW = '5h 60% · 7d 30% left'
const fresh = reading(40, 70)
const route = (activeId: string, mode = 'main-first') => ({
  route: mode,
  activeRouting: {
    session: { activeId, route: mode, updatedAt: now },
  },
})

try {
  // Two accounts: one line each, in placement order, only the session's
  // account in the usage tone (70% used is past the 50% warning threshold).
  await step({
    main: { quota: fresh, killed: false },
    fallbacks: [account('spare', 'Spare', reading(10, 20))],
    ...route('main'),
  })
  assert.match(frame(), /▶ OPENAI/)
  assert.deepEqual(accountLines(), [
    `main ${' '.repeat(row() - 'main '.length - NARROW.length - 2)}${NARROW} ●`,
    `Spare ${' '.repeat(row() - 'Spare '.length - NARROW.length - 2)}5h 90% · 7d 80% left ●`,
  ])
  assertActive('main', theme.warning)
  assertDim('Spare')
  assert.doesNotMatch(frame(), /Quota|Routing|resets/)

  // Fallback-first puts main last; the session's account follows its route.
  await step({
    main: { quota: fresh, killed: false },
    fallbacks: [account('spare', 'Spare', reading(10, 20))],
    ...route('spare', 'fallback-first'),
  })
  assert.deepEqual(
    accountLines().map((line) => line.split(' ')[0]),
    ['Spare', 'main'],
  )
  assertActive('Spare', theme.success)
  assertDim('main')

  // Three accounts, and one without a reading shows the muted dash.
  await step({
    main: { quota: fresh, killed: false },
    fallbacks: [
      account('spare', 'Spare', reading(10, 20)),
      account('work', 'Work', null),
    ],
    ...route('main'),
  })
  assert.equal(accountLines().length, 3)
  assert.match(accountLines()[2] ?? '', /^Work\s+—$/)
  assertDim('Work')

  // Vault mode lists the vault accounts only.
  await step({
    vaultAccounts: [
      account('vault:one', 'Vault One', reading(10, 20)),
      account('vault:two', 'Vault Two', fresh),
    ],
    ...route('vault:two'),
  })
  assert.deepEqual(
    accountLines().map((line) => line.split(/\s{2,}/)[0]),
    ['Vault One', 'Vault Two'],
  )
  assert.doesNotMatch(frame(), /main/)
  assertActive('Vault Two', theme.warning)
  assertDim('Vault One')

  // A stale reading dims the whole line, even the session's account, and
  // the narrow text never says how old it is.
  await step({
    main: { quota: reading(40, 70, 3 * HOUR), killed: false },
    fallbacks: [account('spare', 'Spare', reading(10, 20))],
    ...route('main'),
  })
  assert.match(accountLines()[0] ?? '', new RegExp(`^main\\s+${NARROW} ●$`))
  assert.doesNotMatch(frame(), /checked/)
  assertDim('main')

  // A killed account keeps the red ⊘, whether or not it serves the session.
  await step({
    main: { quota: fresh, killed: true },
    fallbacks: [account('spare', 'Spare', reading(10, 20), { killed: true })],
    ...route('main'),
  })
  for (const label of ['main', 'Spare']) {
    const mark = spansOf(label).find((span) => span.text.includes('⊘'))
    assert.ok(mark && same(mark.fg, theme.error), `${label} has no red ⊘`)
  }

  // A label too long for the 42-column sidebar is cut with … and the quota
  // text stays whole.
  const long = 'a-very-long-account-label@example.com'
  await step({
    main: { quota: fresh, killed: false },
    fallbacks: [account('long', long, fresh)],
    ...route('main'),
  })
  const [full, cut = ''] = accountLines()
  // The cut line ends in the whole quota text, and its label was cut to
  // exactly the room left: one column before the quota text, and the line as
  // wide as main's, which fills the row.
  assert.ok(cut.endsWith(`${NARROW} ●`), cut)
  assert.match(cut, /^a-very-long-[^… ]+… 5h 60%/)
  assert.equal(cut.length, full?.length)
  assert.ok(!frame().includes(long))
  assert.ok(cut.length < WIDTH, cut)
} finally {
  cleanup()
  await view.dispose()
  await v1.dispose()
  for (const timer of timers) clear(timer)
  globalThis.setInterval = interval
  globalThis.clearInterval = clear
  rmSync(root, { recursive: true, force: true })
}
console.log('collapsed-sidebar-render passed')
// OpenCode 1 keeps its preferences watcher for the process lifetime.
process.exit(0)
