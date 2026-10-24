import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TerminalScreen } from './terminal-screen'

/** Runs the packed entries in the pinned OpenCode version's terminal renderer. */
export async function controlPlaneProbe(input: {
  cli: string
  consumer: string
  root: string
  env: Record<string, string>
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
export default { id: plugin.id, async setup(ctx) {
  record('tui', { keys: Object.keys(ctx), ui: Object.keys(ctx.ui) })
  let slots = 0, dialogs = 0, generation = 0, phase = 0, finish
  const observed = Object.create(ctx)
  Object.defineProperty(observed, 'ui', { value: { ...ctx.ui, slot(claim) {
    slots++; record('slot', { slots, anchor: claim.append, numericOrder: 'order' in claim })
    const remove = ctx.ui.slot({ ...claim, render(input) { record('render', { phase, sessionId: input.sessionID }); return claim.render(input) } })
    return () => { slots--; remove(); record('slot', { slots }) }
  } } })
  const mount = async () => {
    const current = ++generation
    const original = globalThis.setInterval
    globalThis.setInterval = (fn, ms, ...args) => original(() => {
      if (ms === 500) record('tick', { generation: current })
      fn(...args)
    }, ms)
    try {
      return await plugin.setup(observed, {
        async openDialog(payload, apply) {
          try {
            dialogs++; record('dialog', { phase, dialogs, title: payload.menu.title })
            const actionId = await ctx.ui.dialog.select({ title: payload.menu.title + ' ' + phase, options: [{ title: 'Check connection', value: 'apply' }] })
            dialogs--
            if (actionId === undefined) throw new Error('proof dialog cancelled')
            const result = await apply({ command: 'openai', sectionId: 'connection', actionId })
            record('result', { phase, result, slots, dialogs })
            finish?.()
          } catch (error) { record('failure', { message: String(error) }) }
        },
      })
    } finally { globalThis.setInterval = original }
  }
  let dispose = await mount()
  void (async () => { try {
    const a = await ctx.client.session.create()
    const b = await ctx.client.session.create()
    const c = await ctx.client.session.create({ location: { directory: ${JSON.stringify(join(input.root, 'other-project'))} } })
    record('sessions', { a: a.id, b: b.id, c: c.id })
    const invoke = async (session) => {
      phase++
      await ctx.data.session.sync(session.id)
      ctx.ui.router.navigate({ type: 'session', sessionID: session.id })
      await new Promise(resolve => setTimeout(resolve, 1100))
      const commands = await ctx.client.command.list({ location: { directory: session.location.directory } })
      record('commands', { phase, count: commands.data.filter(x => x.name === 'openai').length, slots })
      const done = new Promise(resolve => { finish = resolve })
      await ctx.client.session.command({ sessionID: session.id, name: 'openai', text: '' })
      await done
    }
    await invoke(a)
    const before = ctx.themeMode
    ctx.keymap.dispatch('theme.switch_mode')
    await invoke(b)
    record('theme', { before, after: ctx.themeMode })
    await invoke(c)
    const countBoth = async (stage) => {
      for (const session of [a, c]) {
        const result = await ctx.client.command.list({ location: { directory: session.location.directory } })
        record('location-count', { stage, directory: session.location.directory, count: result.data.filter(x => x.name === 'openai').length })
      }
    }
    await countBoth('both-set-up')
    const readyCount = () => readFileSync(${JSON.stringify(trace)}, 'utf8').split('\\n').filter(line => line.includes('"event":"server-ready"')).length
    const previousReady = readyCount()
    await ctx.client.location.reload()
    // Location reload returns before asynchronous plugin setup. Listing each
    // location activates it; its setup-complete event is the readiness barrier.
    for (const session of [a, c]) await ctx.client.command.list({ location: { directory: session.location.directory } })
    await new Promise(resolve => {
      const check = () => { if (readyCount() >= previousReady + 2) { watcher.close(); resolve() } }
      const watcher = watch(${JSON.stringify(trace)}, check)
      check()
    })
    await countBoth('location-reloaded')
    dispose()
    record('reload', { oldGeneration: generation })
    dispose = await mount()
    await invoke(c)
    record('done', { slots, dialogs, generation })
  } catch (error) { record('failure', { message: String(error), stack: error.stack }) } })()
  return () => dispose?.()
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
