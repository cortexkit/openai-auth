// Renders the expanded sidebar on OpenCode 2 (the `sidebar.content` slot) and
// OpenCode 1 (the `sidebar_content` slot) at every width the plugin may be
// given, from 42 cells down to 16 (a default OpenCode sidebar gives it 36 or
// 37), and checks each quota row:
// it stays on one line, keeps a space between the "N% left" figure and the
// reset time, and when the row is too narrow drops the reset first, then
// shortens the bar. The pacing line under a row is cut with … rather than
// wrapped. Both hosts must draw the same characters and colors. Run as a
// script with the shared Solid/OpenTUI runtime preloaded (see
// tui-quota-render.test.ts); it prints `expanded-quota-rows-render passed` on
// success. Set SHOW_FRAMES=1 to print the quota rows drawn at each width.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RGBA } from '@opentui/core'
import { type JSX, testRender } from '@opentui/solid'

const root = mkdtempSync(join(tmpdir(), 'openai-expanded-rows-render-'))
const stateFile = join(root, 'sidebar.json')
const prefsFile = join(root, 'preferences.jsonc')
process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = stateFile
process.env.OPENCODE_TUI_PREFERENCES_FILE = prefsFile
process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(root, 'credentials.json')
writeFileSync(
  prefsFile,
  JSON.stringify({
    'openai-auth': {
      collapsed: false,
      sections: { pacing: true, routing: false, health: false },
    },
  }),
)

const { default: plugin } = await import(
  new URL('../../tui/entry.mjs', import.meta.url).href
)
const now = Date.now()
Date.now = () => now
const MINUTE = 60_000
const HOUR = 60 * MINUTE

// The 5h window resets in 4h39m with 20% used 21 minutes in, so pacing
// projects a deficit and draws a "deficit … · out in …" line under it. The 7d
// window is untouched with the longest reset text the sidebar draws (6d23h),
// too early in the window for pacing.
publish({
  main: {
    killed: false,
    quota: {
      checkedAt: now,
      primary: {
        usedPercent: 20,
        remainingPercent: 80,
        windowMinutes: 300,
        resetsAt: new Date(now + 4 * HOUR + 39 * MINUTE + 30_000).toISOString(),
        checkedAt: now,
      },
      secondary: {
        usedPercent: 0,
        remainingPercent: 100,
        windowMinutes: 10080,
        resetsAt: new Date(
          now + 6 * 24 * HOUR + 23 * HOUR + 30 * MINUTE,
        ).toISOString(),
        checkedAt: now,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: 1234.6,
        checkedAt: now,
      },
    },
  },
  fallbacks: [],
  activeId: 'main',
  route: 'main-first',
})

function publish(state: Record<string, unknown>) {
  writeFileSync(stateFile, JSON.stringify({ lastUpdated: now, ...state }))
}

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
type Claim = {
  render(input: { readonly sessionID: string }): JSX.Element
}
let claim: Claim | undefined
let slotOwner: { destroy?: () => void } = {}
const polls = new Map<number, () => Promise<void>>()
const interval = globalThis.setInterval
const clear = globalThis.clearInterval
const timers = new Set<number>()
// Take over the sidebar's state-file poll so it refreshes on demand.
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
  theme,
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
const HEIGHT = 24
const FULL_WIDTH = 42
const view = await testRender(() => claim?.render({ sessionID: 'session' }), {
  width: FULL_WIDTH,
  height: HEIGHT,
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
const v1 = await testRender(() => v1Render?.(), {
  width: FULL_WIDTH,
  height: HEIGHT,
})

/** Resize both sidebars and draw them until each row has measured itself. */
async function drawAt(width: number) {
  view.resize(width, HEIGHT)
  v1.resize(width, HEIGHT)
  // The first pass lays the rows out; the next ones draw them fitted to the
  // width each row measured.
  for (let pass = 0; pass < 3; pass++) {
    await view.renderOnce()
    await v1.renderOnce()
  }
  assert.equal(view.captureCharFrame(), v1.captureCharFrame())
  assert.deepEqual(view.captureSpans(), v1.captureSpans())
}

/**
 * The frame's lines without the sidebar's one-column padding on each side, so
 * every line is the `columns` the rows lay themselves out in.
 */
function contentLines(width: number): string[] {
  return view
    .captureCharFrame()
    .split('\n')
    .map((line) =>
      Array.from(line)
        .slice(1, width - 1)
        .join(''),
    )
}

const BAR = /[█░▒▓]/g
// What the rows draw at full size: label column, 10-cell bar, figure, reset.
const rows = [
  { label: '5h', figure: '80% left', reset: '4h39m', usedCells: 2 },
  { label: '7d', figure: '100% left', reset: '6d23h', usedCells: 0 },
] as const
const LABEL_WIDTH = 3
// quotaCreditsText's wording for the published balance of 1234.6.
const CREDITS = '1235 credits'
const BAR_WIDTH = 10
const MIN_BAR = 3

await Promise.all([...polls.values()].map((refresh) => refresh()))
try {
  for (let width = FULL_WIDTH; width >= 16; width--) {
    await drawAt(width)
    const columns = width - 2
    const lines = contentLines(width)
    const frame = view.captureCharFrame()
    if (process.env.SHOW_FRAMES) {
      const first = lines.findIndex((line) => line.startsWith('5h'))
      const shown = lines.slice(first, first + 4)
      console.log(`width ${width}:\n${shown.map((l) => `|${l}|`).join('\n')}`)
    }
    const at = `at width ${width}: ${frame}`
    assert.ok(
      !lines.some((line) => /left\S/.test(line)),
      `quota figure runs into the reset ${at}`,
    )
    for (const row of rows) {
      const drawn = lines.filter((line) => line.startsWith(`${row.label} `))
      assert.equal(drawn.length, 1, `the ${row.label} row is missing ${at}`)
      const line = drawn[0] ?? ''
      const next = lines[lines.indexOf(line) + 1] ?? ''
      // A wrapped row continues on the next line; that line would then be
      // neither the pacing line, the next row, nor blank.
      assert.match(
        next.trim(),
        /^(?:deficit .*|7d .*|.* 1235 credits|)$/,
        `the ${row.label} row wraps onto a second line ${at}`,
      )
      assert.ok(
        line.includes(` ${row.figure}`),
        `the ${row.label} row lost its figure ${at}`,
      )
      // Drop order: the reset goes first, then the bar shrinks, keeping at
      // least MIN_BAR cells or none at all.
      const fixed = LABEL_WIDTH + 1 + row.figure.length
      const fitsWhole = fixed + BAR_WIDTH + 1 + row.reset.length <= columns
      const room = columns - fixed
      const bar = room >= BAR_WIDTH ? BAR_WIDTH : room >= MIN_BAR ? room : 0
      const expectedBar = '█'.repeat(Math.round((row.usedCells * bar) / 10))
      const left = `${row.label} ${expectedBar.padEnd(bar, '░')} ${row.figure}`
      const expected = fitsWhole
        ? `${left}${' '.repeat(columns - left.length - row.reset.length)}${row.reset}`
        : left.padEnd(columns)
      assert.equal(
        line.replace(/[▒▓]/g, '█'),
        expected,
        `the ${row.label} row is not laid out as expected ${at}`,
      )
      assert.equal(line.match(BAR)?.length ?? 0, bar)
      // OpenCode gives the plugin 36 cells (OpenCode 1 once the sidebar
      // scrollbar shows) or 37 (OpenCode 2). At those widths and wider an
      // ordinary row draws whole: full bar, figure, one blank cell at least,
      // reset.
      if (width >= 36)
        assert.ok(
          bar === BAR_WIDTH && line.endsWith(` ${row.reset}`),
          `the ${row.label} row is not drawn whole ${at}`,
        )
    }
    if (width === FULL_WIDTH)
      for (const row of rows)
        assert.ok(frame.includes(row.reset), `no ${row.reset} ${at}`)

    // The account's prepaid credits: one line whose value is never cut and
    // keeps a blank cell before it. When both do not fit, the label is cut
    // with ….
    const credits = lines.filter((line) => line.trimEnd().endsWith(CREDITS))
    assert.equal(credits.length, 1, `the prepaid row is missing ${at}`)
    const creditsLine = credits[0] ?? ''
    assert.match(
      creditsLine,
      /^(?:prepaid|[a-z]*…) +1235 credits$/,
      `the prepaid row runs its label into the value ${at}`,
    )
    assert.equal(
      (lines[lines.indexOf(creditsLine) + 1] ?? '').trim(),
      '',
      `the prepaid row wraps onto a second line ${at}`,
    )
    if (width >= 36)
      assert.equal(
        creditsLine,
        `prepaid${' '.repeat(columns - 7 - CREDITS.length)}${CREDITS}`,
        `the prepaid row is not drawn whole ${at}`,
      )

    // The pacing line: whole when it fits, else cut to one line with ….
    const pacing = lines.filter((line) => line.trim().startsWith('deficit'))
    assert.equal(pacing.length, 1, `the pacing line is missing ${at}`)
    const pace = (pacing[0] ?? '').trimEnd()
    const full = /^ {3}deficit \d+% · out in \d+h\d+m$/
    if (!full.test(pace)) {
      assert.ok(
        pace.endsWith('…') && pace.length === columns,
        `the pacing line is not cut with an ellipsis ${at}`,
      )
    }
    if (width === FULL_WIDTH) assert.match(pace, full)
  }

  // The session's account has used up its 5h window and is serving on its
  // prepaid credits: the prepaid row says so, on one line, at the widths
  // OpenCode gives the plugin (36 and 37 cells). A later `lastUpdated`, so
  // the sidebar's poll takes the new file.
  publish({
    lastUpdated: now + 1,
    main: {
      killed: false,
      quota: {
        checkedAt: now,
        primary: {
          usedPercent: 100,
          remainingPercent: 0,
          windowMinutes: 300,
          resetsAt: new Date(now + 2 * HOUR).toISOString(),
          checkedAt: now,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: 1234.6,
          checkedAt: now,
        },
      },
    },
    fallbacks: [],
    activeId: 'main',
    route: 'main-first',
  })
  await Promise.all([...polls.values()].map((refresh) => refresh()))
  for (const width of [37, 36]) {
    await drawAt(width)
    const columns = width - 2
    const lines = contentLines(width)
    const at = `at width ${width}: ${view.captureCharFrame()}`
    const serving = lines.filter((line) => line.trimEnd().endsWith(CREDITS))
    assert.equal(serving.length, 1, `the prepaid row is missing ${at}`)
    const line = serving[0] ?? ''
    const label = 'serving on credits'
    assert.equal(
      line,
      `${label}${' '.repeat(columns - label.length - CREDITS.length)}${CREDITS}`,
      `the serving-on-credits row is not drawn whole on one line ${at}`,
    )
    assert.equal(
      (lines[lines.indexOf(line) + 1] ?? '').trim(),
      '',
      `the serving-on-credits row wraps onto a second line ${at}`,
    )
  }
} finally {
  cleanup()
  await view.dispose()
  await v1.dispose()
  for (const timer of timers) clear(timer)
  globalThis.setInterval = interval
  globalThis.clearInterval = clear
  rmSync(root, { recursive: true, force: true })
}
console.log('expanded-quota-rows-render passed')
// OpenCode 1 keeps its preferences watcher for the process lifetime.
process.exit(0)
