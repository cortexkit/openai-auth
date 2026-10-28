import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RGBA } from '@opentui/core'
import { type JSX, testRender } from '@opentui/solid'
import { createSignal } from 'solid-js'
import type { SidebarState } from '../../sidebar-state'

const root = mkdtempSync(join(tmpdir(), 'openai-sidebar-render-'))
const stateFile = join(root, 'sidebar.json')
const prefsFile = join(root, 'preferences.jsonc')
const accountFile = join(root, 'accounts.json')
const credentialFile = join(root, 'credentials.json')
process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = stateFile
process.env.OPENCODE_TUI_PREFERENCES_FILE = prefsFile
process.env.OPENCODE_OPENAI_AUTH_FILE = accountFile
process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = credentialFile
writeFileSync(accountFile, '{"sentinel":"account store must not change"}')
writeFileSync(credentialFile, '{"sentinel":"credentials must not change"}')
let requests = 0
globalThis.fetch = Object.assign(
  () => {
    requests++
    throw new Error('Rendering must not preview, redeem, refresh or fetch')
  },
  {
    preconnect() {
      requests++
      throw new Error('Rendering must not connect')
    },
  },
)
const prefs = { 'openai-auth': { sections: { pacing: false } } }
writeFileSync(prefsFile, JSON.stringify(prefs))

// The preload supplies one shared Solid/OpenTUI runtime, as a real host does.
// Loading ./tui afterward selects the precompiled variant against that runtime.
const { default: plugin } = await import(
  new URL('../../tui/entry.mjs', import.meta.url).href
)
const { watchTuiPreferences } = await import(
  new URL('../../tui-compiled/runtime/tui-preferences.js', import.meta.url).href
)
const now = Date.now()
Date.now = () => now
const quota = {
  primary: {
    usedPercent: 40,
    remainingPercent: 60,
    windowMinutes: 300,
    resetsAt: new Date(now + 4 * 60 * 60_000).toISOString(),
  },
  secondary: { usedPercent: 70, remainingPercent: 30, windowMinutes: 10080 },
}
const credits = 3
const local = {
  lastUpdated: now,
  main: { quota, killed: false, resetCredits: credits },
  fallbacks: [
    { id: 'other', label: 'Spare', enabled: true, quota, killed: false },
  ],
  activeId: 'main',
  route: 'sticky',
  activeRouting: {
    second: { activeId: 'other', route: 'sticky', updatedAt: now },
  },
}
const vaultMode = process.argv[2] === 'vault'
const initial: SidebarState = vaultMode
  ? {
      ...local,
      main: { quota: null, killed: false },
      fallbacks: [],
      vaultAccounts: [
        {
          id: 'vault:one',
          label: 'Vault One',
          enabled: true,
          quota,
          killed: false,
          resetCredits: credits,
        },
        {
          id: 'vault:two',
          label: 'Vault Two',
          enabled: true,
          quota,
          killed: false,
        },
      ],
      activeId: 'vault:one',
      activeRouting: {
        second: { activeId: 'vault:two', route: 'sticky', updatedAt: now },
      },
    }
  : local
let sequence = now
const publish = (state: unknown) =>
  writeFileSync(
    stateFile,
    JSON.stringify({ ...(state as object), lastUpdated: ++sequence }),
  )
publish(initial)

const color = (hex: string) => RGBA.fromHex(hex)
const dark = {
  text: color('#f0f0f0'),
  textMuted: color('#888888'),
  accent: color('#55aaff'),
  background: color('#101010'),
  borderActive: color('#55aaff'),
  success: color('#00cc55'),
  warning: color('#ffaa00'),
  error: color('#ff0055'),
}
const light = {
  text: color('#101010'),
  textMuted: color('#555555'),
  accent: color('#0044cc'),
  background: color('#f0f0f0'),
  borderActive: color('#663399'),
  success: color('#006622'),
  warning: color('#aa5500'),
  error: color('#aa0022'),
}
const [theme, setTheme] = createSignal(dark)
const hostDark = {
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
const hostLight = {
  text: {
    base: color('#101010'),
    muted: color('#555555'),
    action: { primary: { base: color('#0044cc') } },
    feedback: {
      success: { base: color('#006622') },
      warning: { base: color('#aa5500') },
      error: { base: color('#aa0022') },
    },
  },
  background: { base: color('#f0f0f0') },
  border: { base: color('#663399') },
}
const [hostTheme, setHostTheme] = createSignal(hostDark)
const [session, setSession] = createSignal('first')
type Claim = {
  append: string
  render(input: { readonly sessionID: string }): JSX.Element
}
let claim: Claim | undefined
let registrations = 0
let live = 0
let slotOwner: { destroy?: () => void } = {}
const polls = new Map<number, () => Promise<void>>()
const interval = globalThis.setInterval
const clear = globalThis.clearInterval
const timers = new Set<number>()
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
const listeners = new Set<() => void>()
const context = {
  get theme() {
    return hostTheme()
  },
  data: {
    on(_type: string, listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
  ui: {
    router: { current: () => ({ type: 'home' }) },
    slot(next: Claim) {
      claim = next
      const owner = {}
      slotOwner = owner
      registrations++
      live++
      return () => {
        live--
        ;(owner as typeof slotOwner).destroy?.()
      }
    },
  },
}
const cleanup = await plugin.setup(context)
assert.equal(live, 1)
assert.equal(claim?.append, 'sidebar.content')
const view = await testRender(
  () =>
    claim?.render({
      get sessionID() {
        return session()
      },
    }),
  { width: 60, height: 65 },
)
slotOwner.destroy = () => view.renderer.destroy()
let v1Render: (() => JSX.Element) | undefined
await plugin.tui({
  theme: {
    get current() {
      return theme()
    },
  },
  event: { on: context.data.on },
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
        input.slots.sidebar_content(null, {
          get session_id() {
            return session()
          },
        })
    },
  },
})
const v1 = await testRender(() => v1Render?.(), { width: 60, height: 65 })
const frame = () => view.captureCharFrame()
const tick = async () => {
  assert.equal(polls.size, 2)
  await Promise.all([...polls.values()].map((refresh) => refresh()))
  await view.renderOnce()
  await v1.renderOnce()
}
const parity = () => {
  assert.equal(frame(), v1.captureCharFrame())
  assert.deepEqual(view.captureSpans(), v1.captureSpans())
}
const waitFrame = (target: typeof view, predicate: (text: string) => boolean) =>
  new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      target.renderer.off('frame', check)
      target.renderer.stop()
      reject(
        new Error(`Sidebar frame did not update: ${target.captureCharFrame()}`),
      )
    }, 2000)
    const check = () => {
      if (!predicate(target.captureCharFrame())) return
      clearTimeout(deadline)
      target.renderer.off('frame', check)
      target.renderer.stop()
      resolve()
    }
    target.renderer.on('frame', check)
    target.renderer.start()
  })
try {
  await tick()
  parity()
  assert.match(frame(), /5h ████░░░░░░ 60% left/)
  assert.match(frame(), /7d ███████░░░ 30% left/)
  assert.match(frame(), /resets\s+3/)
  if (vaultMode) assert.doesNotMatch(frame(), /main|Spare/)
  if (vaultMode) {
    publish({
      ...initial,
      vaultAccounts: initial.vaultAccounts?.map((account, index) => ({
        ...account,
        enabled: index !== 0,
        routable: false,
        vaultState: index === 0 ? 'needs sign-in' : 'unavailable',
        killed: index === 1,
      })),
    })
    await tick()
    parity()
    assert.match(frame(), /Vault One/)
    assert.match(frame(), /needs sign-in/)
    assert.match(frame(), /off in \/openai/)
    assert.match(frame(), /Vault Two\s+blocked/)
    assert.match(frame(), /unavailable/)
    assert.match(frame(), /Killswitch\s+Vault Two blocked/)
    assert.doesNotMatch(frame(), /main|Spare/)
    publish(initial)
    await tick()
  }
  const darkSpans = view.captureSpans()
  setTheme(light)
  setHostTheme(hostLight)
  await view.renderOnce()
  await v1.renderOnce()
  parity()
  assert.notDeepEqual(view.captureSpans(), darkSpans)
  const badge = view
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes('OPENAI'))
  assert.deepEqual(badge?.fg, light.background)
  assert.deepEqual(badge?.bg, light.accent)
  const spans = view.captureSpans().lines.flatMap((line) => line.spans)
  assert.ok(
    spans.some(
      (span) => span.text.includes('60% left') && span.fg.equals(light.success),
    ),
    'mounted quota rows did not receive the new success colour',
  )
  assert.ok(
    spans.some(
      (span) => span.text.includes('30% left') && span.fg.equals(light.warning),
    ),
    'mounted quota rows did not receive the new warning colour',
  )

  publish({
    ...initial,
    main: {
      ...initial.main,
      killed: !vaultMode,
      quotaBackedOff: true,
      quotaBackoffUntil: now + 60_000,
      refreshBackedOff: true,
      refreshBackoffUntil: now + 60_000,
    },
  })
  await tick()
  parity()
  assert.match(frame(), /LIMITED/)
  assert.match(frame(), /Health/)
  assert.match(frame(), /Quota API\s+backoff/)
  assert.match(frame(), /Token refresh\s+backoff/)
  if (!vaultMode) assert.match(frame(), /Killswitch\s+main blocked/)
  publish(initial)
  await tick()
  parity()
  assert.doesNotMatch(frame(), /LIMITED|Health|Killswitch|backoff/)

  const nextQuota = {
    ...quota,
    primary: { ...quota.primary, usedPercent: 20, remainingPercent: 80 },
  }
  publish(
    vaultMode
      ? {
          ...initial,
          vaultAccounts: initial.vaultAccounts?.map((account) => ({
            ...account,
            quota: nextQuota,
            resetCredits: account.id === 'vault:one' ? 8 : undefined,
          })),
        }
      : {
          ...local,
          main: { ...local.main, quota: nextQuota, resetCredits: 8 },
        },
  )
  await tick()
  assert.match(frame(), /5h ██░░░░░░░░ 80% left/)
  assert.match(frame(), /resets\s+8/)
  assert.equal(registrations, 1)
  publish(initial)
  await tick()
  setSession('second')
  await view.renderOnce()
  await v1.renderOnce()
  parity()
  assert.match(
    frame(),
    new RegExp(`${vaultMode ? 'Vault Two' : 'Spare'}\\s+active`),
  )

  const changed = new Promise<void>((resolve) => {
    const stop = watchTuiPreferences(() => {
      stop()
      resolve()
    })
  })
  writeFileSync(
    prefsFile,
    JSON.stringify({
      'openai-auth': {
        ...prefs['openai-auth'],
        sections: { pacing: true },
        collapsed: true,
        forceToTop: true,
        order: -999,
        header: { label: 'LIVE PREFS' },
      },
    }),
  )
  await changed
  await waitFrame(view, (text) => text.includes('▶ LIVE PREFS'))
  await waitFrame(v1, (text) => text.includes('▶ LIVE PREFS'))
  parity()
  assert.doesNotMatch(frame(), /Quota|Routing|resets/)
  // Collapsed, each account's line carries the narrow quota text.
  assert.match(frame(), /5h 60% · 7d 30% left/)
  // Use terminal mouse input on the badge, not a controller-only toggle.
  const persisted = new Promise<void>((resolve) => {
    const stop = watchTuiPreferences(() => {
      stop()
      resolve()
    })
  })
  await view.mockMouse.click(5, 1)
  await waitFrame(view, (text) => text.includes('▼ LIVE PREFS'))
  await persisted
  assert.equal(
    JSON.parse(readFileSync(prefsFile, 'utf8'))['openai-auth'].collapsed,
    false,
  )
  await waitFrame(v1, (text) => text.includes('▼ LIVE PREFS'))
  parity()
  assert.match(frame(), /deficit 20%/)
  assert.equal(registrations, 1)

  for (const missing of [
    'absent',
    'unreadable',
    'data-less',
    'pending-vault',
    'empty-vault',
  ]) {
    if (missing === 'absent') rmSync(stateFile)
    else if (missing === 'unreadable') writeFileSync(stateFile, '{broken')
    else
      publish({
        main: { quota: null, killed: false },
        fallbacks: [],
        ...(missing.endsWith('-vault')
          ? { vaultAccounts: [], vaultDiscovered: missing === 'empty-vault' }
          : {}),
      })
    await tick()
    parity()
    if (missing === 'empty-vault') assert.match(frame(), /No vault accounts/)
    else if (missing === 'pending-vault')
      assert.match(frame(), /Waiting for the vault's first answer/)
    else assert.match(frame(), /Waiting for quota…/)
    assert.doesNotMatch(frame(), /60% left|80% left/)
  }
  const oldRefresh = [...polls.values()][0]
  const reloadCleanup = await plugin.setup(context)
  assert.equal(live, 1)
  assert.equal(polls.size, 1)
  assert.equal(listeners.size, 1)
  await oldRefresh?.()
  assert.equal(polls.size, 1)
  const reloaded = await testRender(
    () =>
      claim?.render({
        get sessionID() {
          return session()
        },
      }),
    { width: 60, height: 65 },
  )
  slotOwner.destroy = () => reloaded.renderer.destroy()
  assert.equal(polls.size, 2)
  cleanup()
  assert.equal(live, 1)
  reloadCleanup()
  assert.equal(live, 0)
  assert.equal(polls.size, 1)
  await reloaded.dispose()
  assert.equal(
    readFileSync(accountFile, 'utf8'),
    '{"sentinel":"account store must not change"}',
  )
  assert.equal(
    readFileSync(credentialFile, 'utf8'),
    '{"sentinel":"credentials must not change"}',
  )
  assert.equal(requests, 0)
} finally {
  cleanup()
  await view.dispose()
  await v1.dispose()
  for (const timer of timers) clear(timer)
  globalThis.setInterval = interval
  globalThis.clearInterval = clear
  rmSync(root, { recursive: true, force: true })
}
console.log('sidebar-render passed')
// OpenCode 1 keeps its preferences watcher for the process lifetime.
process.exit(0)
