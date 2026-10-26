// One plugin process deciding its runtime layout, for the runtime-layout
// tests: runs `prepareRuntimeLayout` with the inherited environment, prints
// the layout and the paths it resolved as one JSON line, and with `hold`
// stays alive until it is killed (a live process on that layout).
import { getAccountPaths, getCodexSessionsPath } from '../../core/account-paths'
import { prepareRuntimeLayout } from '../../core/runtime-layout'

const mode = process.argv[2] ?? 'once'
const layout = await prepareRuntimeLayout({
  version: process.env.RUNTIME_LAYOUT_TEST_VERSION ?? '1.7.0',
  log: { info() {}, warn() {} },
})
process.stdout.write(
  `${JSON.stringify({
    layout,
    pid: process.pid,
    statePath: getAccountPaths().statePath,
    sessions: getCodexSessionsPath('opencode2'),
  })}\n`,
)
if (mode === 'hold') setInterval(() => {}, 60_000)
