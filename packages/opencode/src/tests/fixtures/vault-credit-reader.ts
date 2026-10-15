import { OpenAiVault } from '@cortexkit/openai-auth-core/internal'
import { buildVaultSidebarMachineState } from '../../core/pool-sidebar'
import { setSidebarMachineState } from '../../sidebar-state'

const [stateDir, connectionFile, sidebarFile, timestamp] = process.argv.slice(2)
if (!stateDir || !connectionFile || !sidebarFile || !timestamp)
  throw new Error(
    'expected state directory, connection file, sidebar file and time',
  )
const now = Number(timestamp)
const vault = new OpenAiVault({
  host: 'opencode',
  stateDir,
  connectionFile: () => connectionFile,
  pollIntervalMs: 0,
  now: () => now,
  fetchImpl: () => {
    throw new Error('a second consumer must use persisted quota, not poll it')
  },
})
try {
  await vault.refresh()
  await setSidebarMachineState(
    buildVaultSidebarMachineState(
      vault.snapshot()?.rows ?? [],
      new Set(vault.routes().map((row) => row.id)),
      null,
      now,
    ),
    sidebarFile,
  )
} finally {
  vault.close()
}
