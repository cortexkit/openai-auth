import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TerminalScreen } from './terminal-screen'

/** Runs the packed entries in the pinned OpenCode version's terminal renderer. */
export async function controlPlaneProbe(input: {
  cli: string
  consumer: string
  root: string
  env: Record<string, string>
  /** Make the host dispose the TUI plugin and set it up again before phase 4. */
  hostResetup?: boolean
}) {
  const directory = join(input.root, 'project')
  const plugin = join(input.consumer, 'control-plane-probe')
  const trace = join(input.root, 'control-plane.jsonl')
  mkdirSync(directory, { recursive: true })
  mkdirSync(plugin, { recursive: true })
  writeFileSync(trace, '')
  writeFileSync(
    join(plugin, 'package.json'),
    JSON.stringify({
      name: 'openai-control-plane-probe',
      type: 'module',
      exports: { './server': './server.js', './tui': './tui.js' },
      'oc-plugin': ['server', 'tui'],
    }),
  )
  const record = `import { appendFileSync } from 'node:fs'
const record = (event, data = {}) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ event, ...data }) + '\\n')`
  writeFileSync(
    join(plugin, 'server.js'),
    `import { createOpenAIAuthPlugin } from '@cortexkit/opencode-openai-auth/server'
${record}
export default { id: 'openai-control-plane-probe', async setup(ctx) {
  record('server', { location: ctx.location })
  const menu = { command: 'openai', title: 'OpenAI P0 connection', sections: [{
    id: 'connection', slot: 'extra', title: 'Connection', lines: [], items: [],
    actions: [{ id: 'apply', label: 'Check connection', knobs: [] }],
  }] }
  const dispose = await createOpenAIAuthPlugin({ heartbeat: false, controlPlane: {
    async open(sessionId) { record('open', { sessionId, directory: ctx.location.directory }); return { command: 'openai', menu } },
    async apply(request) {
      record('apply', { request, directory: ctx.location.directory })
      return { command: 'openai', ok: false, code: 'unavailable', text: 'P0: nothing was changed', menu }
    },
  } }).setup(ctx)
  record('server-ready', { directory: ctx.location.directory })
  return dispose
} }
`,
  )
  writeFileSync(
    join(plugin, 'tui.js'),
    `import plugin from '@cortexkit/opencode-openai-auth/tui'
import { readFileSync, watch } from 'node:fs'
${record}
record('tui-import', { keys: Object.keys(plugin) })
// OpenCode may dispose this TUI plugin and run its setup again on the same
// loaded module, for example after a location reload, and it does so only on
// some runs. The probe's state is kept on globalThis so such a repeated setup
// mounts openai-auth on the new context and the proof sequence keeps running
// once per process instead of starting over.
const probe = (globalThis[Symbol.for('openai-auth.p0-probe')] ??= {
  setups: 0, slots: 0, dialogs: 0, generation: 0, phase: 0, finish: undefined,
  // The live host context and its mount; undefined between a host dispose
  // and the host's next setup.
  current: undefined, waiters: [], started: false,
  // Live 500 ms RPC poll intervals, each with the mount generation that made it.
  polls: new Map(),
})
const clearIntervalOriginal = globalThis.clearInterval
globalThis.clearInterval = (handle) => { probe.polls.delete(handle); return clearIntervalOriginal(handle) }
/** The live host context, waiting for the host's next setup after it disposed one. */
const live = () => probe.current ? Promise.resolve(probe.current) : new Promise(resolve => probe.waiters.push(resolve))
const mount = async (instance) => {
  const ctx = instance.ctx
  const current = ++probe.generation
  const observed = Object.create(ctx)
  Object.defineProperty(observed, 'ui', { value: { ...ctx.ui, slot(claim) {
    // A context the host has disposed takes no new slots; a real host never
    // mounts on one, so this mount is dropped once setup returns.
    if (instance.closed) { record('slot-skipped', { generation: current }); return () => {} }
    probe.slots++; record('slot', { slots: probe.slots, anchor: claim.append, numericOrder: 'order' in claim })
    const remove = ctx.ui.slot({ ...claim, render(input) { record('render', { phase: probe.phase, sessionId: input.sessionID }); return claim.render(input) } })
    return () => { probe.slots--; remove(); record('slot', { slots: probe.slots }) }
  } } })
  const original = globalThis.setInterval
  globalThis.setInterval = (fn, ms, ...args) => {
    const handle = original(() => {
      if (ms === 500) record('tick', { generation: current })
      fn(...args)
    }, ms)
    if (ms === 500) probe.polls.set(handle, current)
    return handle
  }
  try {
    return await plugin.setup(observed, {
      async openDialog(payload, apply) {
        try {
          probe.dialogs++; record('dialog', { phase: probe.phase, dialogs: probe.dialogs, title: payload.menu.title, generation: current })
          const actionId = await ctx.ui.dialog.select({ title: payload.menu.title + ' ' + probe.phase, options: [{ title: 'Check connection', value: 'apply' }] })
          probe.dialogs--
          if (actionId === undefined) throw new Error('proof dialog cancelled' + (instance.closed ? ' by a host dispose' : ''))
          const result = await apply({ command: 'openai', sectionId: 'connection', actionId })
          record('result', { phase: probe.phase, result, slots: probe.slots, dialogs: probe.dialogs })
          probe.finish?.()
        } catch (error) { record('failure', { message: String(error) }) }
      },
    })
  } finally { globalThis.setInterval = original }
}
const sequence = async () => { try {
  // Each step reads the context that is live when it runs.
  const ctx = async () => (await live()).ctx
  const a = await (await ctx()).client.session.create()
  const b = await (await ctx()).client.session.create()
  const c = await (await ctx()).client.session.create({ location: { directory: ${JSON.stringify(join(input.root, 'other-project'))} } })
  record('sessions', { a: a.id, b: b.id, c: c.id })
  const invoke = async (session, fresh = false) => {
    const phase = ++probe.phase
    const navigate = async () => {
      await (await ctx()).data.session.sync(session.id)
      ;(await ctx()).ui.router.navigate({ type: 'session', sessionID: session.id })
    }
    if (!fresh) {
      await navigate()
      await new Promise(resolve => setTimeout(resolve, 1100))
    }
    const commands = await (await ctx()).client.command.list({ location: { directory: session.location.directory } })
    record('commands', { phase, count: commands.data.filter(x => x.name === 'openai').length, slots: probe.slots })
    const done = new Promise(resolve => { probe.finish = resolve })
    const command = (await ctx()).client.session.command({ sessionID: session.id, name: 'openai', text: '' })
    if (fresh) {
      // Dispatch from home before navigating, so the new session has no TUI poll yet.
      record('fresh-session-command', { sessionId: session.id })
      await new Promise(resolve => setTimeout(resolve, 150))
      await navigate()
    }
    await command
    await done
  }
  await invoke(a, true)
  const before = (await ctx()).themeMode
  ;(await ctx()).keymap.dispatch('theme.switch_mode')
  await invoke(b)
  record('theme', { before, after: (await ctx()).themeMode })
  await invoke(c)
  const countBoth = async (stage) => {
    for (const session of [a, c]) {
      const result = await (await ctx()).client.command.list({ location: { directory: session.location.directory } })
      record('location-count', { stage, directory: session.location.directory, count: result.data.filter(x => x.name === 'openai').length })
    }
  }
  await countBoth('both-set-up')
  const readyCount = () => readFileSync(${JSON.stringify(trace)}, 'utf8').split('\\n').filter(line => line.includes('"event":"server-ready"')).length
  const previousReady = readyCount()
  await (await ctx()).client.location.reload()
  // Location reload returns before asynchronous plugin setup. Listing each
  // location activates it; its setup-complete event is the readiness barrier.
  for (const session of [a, c]) await (await ctx()).client.command.list({ location: { directory: session.location.directory } })
  await new Promise(resolve => {
    const check = () => { if (readyCount() >= previousReady + 2) { watcher.close(); resolve() } }
    const watcher = watch(${JSON.stringify(trace)}, check)
    check()
  })
  await countBoth('location-reloaded')
  // The probe's own remount, on whichever host context is live now.
  const instance = await live()
  instance.dispose?.()
  record('reload', { oldGeneration: probe.generation })
  instance.dispose = await mount(instance)
  // The host disposed this context while the remount ran: its next setup
  // holds the live mount, so this one is released.
  if (instance.closed) instance.dispose?.()
  if (${JSON.stringify(input.hostResetup === true)}) {
    // Editing this plugin's source makes OpenCode reload it: the host runs
    // the current setup's cleanup and calls setup again on a new context, as
    // it sometimes does by itself after a location reload.
    const setups = probe.setups
    record('force-host-resetup', { setups })
    appendFileSync(${JSON.stringify(join(plugin, 'tui.js'))}, '\\n// edited by the probe so the host reloads this plugin\\n')
    await new Promise(resolve => {
      const check = () => probe.setups > setups && probe.current ? resolve() : setTimeout(check, 50)
      check()
    })
  }
  await invoke(c)
  // A host dispose just before this point leaves no live mount until the
  // host's next setup; the final counts are taken with one in place.
  await live()
  record('done', { slots: probe.slots, dialogs: probe.dialogs, generation: probe.generation, setups: probe.setups, polls: [...probe.polls.values()] })
} catch (error) { record('failure', { message: String(error), stack: error.stack }) } }
export default { id: plugin.id, async setup(ctx) {
  const setup = ++probe.setups
  record('tui', { setup, keys: Object.keys(ctx), ui: Object.keys(ctx.ui) })
  const instance = { ctx, setup, closed: false, dispose: undefined }
  instance.dispose = await mount(instance)
  probe.current = instance
  for (const resolve of probe.waiters.splice(0)) resolve(instance)
  if (!probe.started) { probe.started = true; void sequence() }
  return () => {
    record('host-dispose', { setup })
    instance.closed = true
    if (probe.current === instance) probe.current = undefined
    instance.dispose?.()
  }
} }
`,
  )
  mkdirSync(join(input.root, 'other-project'), { recursive: true })
  const config = join(input.env.XDG_CONFIG_HOME ?? '', 'opencode')
  mkdirSync(config, { recursive: true })
  writeFileSync(
    join(config, 'opencode.json'),
    JSON.stringify({ plugins: [plugin] }),
  )
  let output = ''
  // OpenTUI repaints only changed cells, so a dialog title whose text differs
  // from what was on screen only in its phase digit never appears whole in
  // the byte stream. Titles are read from the emulated screen instead, and
  // every row it has shown is kept for the test's assertions.
  const screen = new TerminalScreen(140, 45)
  const shown = new Set<string>()
  // The phase whose dialog Enter answers next; phases run one after another.
  let waiting = 1
  const dialogTraced = (phase: number) =>
    readFileSync(trace, 'utf8')
      .split('\n')
      .some((line) => {
        // A line still being appended is not a complete record yet.
        try {
          const entry = JSON.parse(line)
          return entry.event === 'dialog' && entry.phase === phase
        } catch {
          return false
        }
      })
  const title = (phase: number) => `OpenAI P0 connection ${phase}`
  // Presses Enter once the plugin has traced the waiting phase's dialog and
  // its title is on screen, so the key reaches the open dialog. Both screen
  // output and trace appends call it: either may complete the condition.
  const answerDialog = (write: (key: string) => void) => {
    if (waiting > 4 || !screen.shows(title(waiting))) return
    if (!dialogTraced(waiting)) return
    waiting++
    write('\r')
  }
  const process = Bun.spawn([input.cli, '--standalone'], {
    cwd: directory,
    env: { ...input.env, TERM: 'xterm-256color' },
    terminal: {
      cols: 140,
      rows: 45,
      data(terminal, data) {
        const text = Buffer.from(data).toString()
        output += text
        screen.write(data)
        for (const line of screen.lines()) if (line) shown.add(line)
        if (text.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
        answerDialog((key) => terminal.write(key))
      },
    },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watcher.close()
        const stage =
          waiting <= 4
            ? `waiting on phase ${waiting}'s dialog (dialog event in trace: ${dialogTraced(waiting)}, title on screen: ${screen.shows(title(waiting))})`
            : 'all four dialogs were answered; waiting for the done event'
        reject(
          new Error(
            `P0 did not finish, ${stage}:\n${readFileSync(trace, 'utf8')}\n--- screen ---\n${screen.lines().join('\n')}\n--- output tail ---\n${output.slice(-6000)}`,
          ),
        )
      }, 20_000)
      const check = () => {
        answerDialog((key) => process.terminal?.write(key))
        const text = readFileSync(trace, 'utf8')
        if (
          !text.includes('"event":"done"') &&
          !text.includes('"event":"failure"')
        )
          return
        clearTimeout(timer)
        watcher.close()
        resolve()
      }
      const watcher = watch(trace, check)
      check()
    })
    return {
      output,
      /** Every row the screen has shown, once each, in first-seen order. */
      screen: [...shown].join('\n'),
      trace: readFileSync(trace, 'utf8'),
    }
  } finally {
    process.kill()
    await process.exited
    process.terminal?.close()
  }
}
