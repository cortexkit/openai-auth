// Freeze the plugin renderer's full output, including Routing, Health and
// Killswitch, and compare the raw character and span buffers.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RGBA } from '@opentui/core'
import { type JSX, testRender } from '@opentui/solid'
import type { SidebarState } from '../../sidebar-state'

const collapsed = process.argv[2] === 'collapsed'
const root = mkdtempSync(join(tmpdir(), 'openai-sidebar-golden-'))
const stateFile = join(root, 'sidebar.json')
process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = stateFile
process.env.OPENCODE_TUI_PREFERENCES_FILE = join(root, 'preferences.jsonc')
process.env.OPENCODE_OPENAI_AUTH_FILE = join(root, 'accounts.json')
process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(root, 'credentials.json')
writeFileSync(
  process.env.OPENCODE_TUI_PREFERENCES_FILE,
  JSON.stringify({
    'openai-auth': {
      collapsed,
      sections: { pacing: true, routing: true, health: true },
    },
  }),
)
const now = Date.UTC(2026, 6, 16, 12)
Date.now = () => now
const HOUR = 60 * 60_000
const quota = {
  checkedAt: now,
  planType: 'plus',
  primary: {
    usedPercent: 20,
    remainingPercent: 80,
    windowMinutes: 300,
    resetsAt: new Date(now + 4 * HOUR + 39 * 60_000).toISOString(),
    checkedAt: now,
  },
  secondary: {
    usedPercent: 70,
    remainingPercent: 30,
    windowMinutes: 10080,
    resetsAt: new Date(now + 3 * 24 * HOUR).toISOString(),
    checkedAt: now,
  },
  spendControl: {
    limit: 2500,
    used: 502,
    remaining: 1998,
    usedPercent: 20.08,
    remainingPercent: 79.92,
    unit: 'credit',
    reached: false,
  },
  credits: {
    hasCredits: true,
    unlimited: false,
    balance: 1234.6,
    checkedAt: now,
  },
}
const state: SidebarState = {
  lastUpdated: now,
  activeId: 'main',
  route: 'main-first',
  main: {
    quota,
    killed: false,
    resetCredits: 3,
    quotaBackedOff: true,
    quotaBackoffUntil: now + 17 * 60_000,
    refreshBackedOff: true,
    refreshBackoffUntil: now + 2 * HOUR,
  },
  fallbacks: [
    {
      id: 'work',
      label: 'Work account',
      enabled: true,
      killed: true,
      quota: {
        checkedAt: now - 3 * HOUR,
        primary: { ...quota.primary, checkedAt: now - 3 * HOUR },
      },
    },
    { id: 'spare', label: 'Spare', enabled: true, killed: false, quota: null },
  ],
}
writeFileSync(stateFile, JSON.stringify(state))

const { default: plugin } = await import(
  new URL('../../tui/entry.mjs', import.meta.url).href
)
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
    base: theme.text,
    muted: theme.textMuted,
    feedback: {
      success: { base: theme.success },
      warning: { base: theme.warning },
      error: { base: theme.error },
    },
    action: { primary: { base: theme.accent } },
  },
  background: { base: theme.background },
  border: { base: theme.borderActive },
}
type Claim = { render(input: { readonly sessionID: string }): JSX.Element }
let claim: Claim | undefined
let slotOwner: { destroy?: () => void } = {}
const polls = new Map<number, () => Promise<void>>()
const interval = globalThis.setInterval
const clear = globalThis.clearInterval
const timers = new Set<number>()
// Drive the file poll explicitly so every capture uses the same reading.
globalThis.setInterval = ((fn: () => Promise<void>, ms: number) => {
  const timer = interval(fn, ms === 1500 ? 60_000 : ms)
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
const HEIGHT = collapsed ? 8 : 42
const INITIAL_WIDTH = collapsed ? 42 : 30
const view = await testRender(() => claim?.render({ sessionID: 'session' }), {
  width: INITIAL_WIDTH,
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
  width: INITIAL_WIDTH,
  height: HEIGHT,
})

// The OpenCode 2 view mounts before the state poll, so its first frame can
// still lack rows that the poll's reading adds. On macOS, one render pass
// missed the "deficit … out in …" lines under each window and the cut-off
// "…" in the Killswitch row. Render both views until neither frame changes,
// and fail if they never settle.
async function settle() {
  let previous = ''
  for (let pass = 0; pass < 10; pass++) {
    await view.renderOnce()
    await v1.renderOnce()
    const frames = `${view.captureCharFrame()}\u0000${v1.captureCharFrame()}`
    if (frames === previous) return
    previous = frames
  }
  throw new Error('sidebar frames did not settle within 10 render passes')
}

function captureGolden(name: string) {
  assert.equal(view.captureCharFrame(), v1.captureCharFrame())
  assert.deepEqual(view.captureSpans(), v1.captureSpans())
  const file = new URL(`./sidebar-goldens/${name}.json`, import.meta.url)
  const buffer = `${JSON.stringify({ chars: view.captureCharFrame(), spans: view.captureSpans() }, null, 2)}\n`
  if (
    process.env.FREEZE_SIDEBAR_GOLDENS === '1' ||
    process.env.FREEZE_SIDEBAR_GOLDENS === name
  )
    writeFileSync(file, buffer)
  else
    assert.deepEqual(
      JSON.parse(buffer),
      JSON.parse(readFileSync(file, 'utf8')),
      `sidebar golden mismatch: ${name}`,
    )
}

try {
  await Promise.all([...polls.values()].map((refresh) => refresh()))
  if (!collapsed) {
    // Preserve the first layout as well as the settled, resized frames.
    await settle()
    captureGolden('expanded-initial-30')
  }
  for (const width of [16, 36, 37, 42]) {
    view.resize(width, HEIGHT)
    v1.resize(width, HEIGHT)
    await settle()
    const chars = view.captureCharFrame()
    assert.equal(chars, v1.captureCharFrame())
    assert.deepEqual(view.captureSpans(), v1.captureSpans())
    if (!collapsed && width === 42) {
      for (const text of [
        'Routing',
        'Health',
        'Killswitch',
        'prepaid',
        'credits',
      ])
        assert.ok(chars.includes(text), `fixture must show ${text}`)
    }
    captureGolden(`${collapsed ? 'collapsed' : 'expanded'}-${width}`)
  }
  console.log(
    `sidebar-golden-render passed (${collapsed ? 4 : 5} character + span buffers, both hosts)`,
  )
} finally {
  await cleanup?.()
  await view.dispose()
  await v1.dispose()
  globalThis.setInterval = interval
  globalThis.clearInterval = clear
  for (const timer of timers) clear(timer)
  rmSync(root, { recursive: true, force: true })
}
// The legacy TUI entry point keeps a process-lifetime preferences watcher.
process.exit(0)
