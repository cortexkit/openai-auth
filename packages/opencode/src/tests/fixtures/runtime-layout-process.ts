// One plugin process deciding its runtime layout, for the runtime-layout
// tests: runs `prepareRuntimeLayout` with the inherited environment, prints
// the layout and the paths it resolved (or the error that stopped it) as one
// JSON line, and with `hold` stays alive until it is killed (a live process
// on that layout).
import { dirname } from 'node:path'
import { getAccountPaths, getCodexSessionsPath } from '../../core/account-paths'
import { prepareRuntimeLayout } from '../../core/runtime-layout'

const mode = process.argv[2] ?? 'once'
let line: Record<string, unknown>
try {
  const layout = await prepareRuntimeLayout({
    version: process.env.RUNTIME_LAYOUT_TEST_VERSION ?? '1.7.0',
    log: { info() {}, warn() {} },
  })
  const statePath = getAccountPaths().statePath
  line = {
    layout,
    pid: process.pid,
    statePath,
    runtimeDir: dirname(getCodexSessionsPath('opencode2')),
  }
} catch (error) {
  line = { error: error instanceof Error ? error.message : String(error) }
}
process.stdout.write(`${JSON.stringify(line)}\n`)
if (mode === 'hold') setInterval(() => {}, 60_000)
