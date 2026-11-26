import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { constants } from 'node:os'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const OPENCODE_PACKAGE_ROOT = resolve(PROJECT_ROOT, 'packages', 'opencode')
const PLUGINS_DIR = resolve(PROJECT_ROOT, '.opencode', 'plugins')
const SYMLINK_PATH = resolve(PLUGINS_DIR, 'openai-auth.js')
const TARGET = '../../packages/opencode/dist/index.js' // relative from .opencode/plugins/

function createSymlink() {
  mkdirSync(PLUGINS_DIR, { recursive: true })

  const existing = lstatSync(SYMLINK_PATH, { throwIfNoEntry: false })
  if (existing) {
    if (existing.isSymbolicLink() && readlinkSync(SYMLINK_PATH) === TARGET) {
      console.log(`[dev] Symlink already exists: ${SYMLINK_PATH} -> ${TARGET}`)
      return
    }
    throw new Error(`[dev] Refusing to replace ${SYMLINK_PATH}`)
  }

  // OpenCode discovers project plugins at this path, not in a scratch folder.
  // Only this invocation's own link is eligible for automatic cleanup.
  symlinkSync(TARGET, SYMLINK_PATH)
  const created = lstatSync(SYMLINK_PATH, { bigint: true })
  console.log(`[dev] Created symlink: ${SYMLINK_PATH} -> ${TARGET}`)
  return () => {
    const current = lstatSync(SYMLINK_PATH, {
      bigint: true,
      throwIfNoEntry: false,
    })
    if (
      !current?.isSymbolicLink() ||
      current.dev !== created.dev ||
      current.ino !== created.ino ||
      current.ctimeNs !== created.ctimeNs ||
      readlinkSync(SYMLINK_PATH) !== TARGET
    )
      return
    unlinkSync(SYMLINK_PATH)
    console.log('[dev] Removed symlink')
  }
}

// --- Main ---

// 1. Build first
console.log('[dev] Running initial OpenCode build...')
const opencodeBuild = Bun.spawnSync(['tsc', '-p', 'tsconfig.build.json'], {
  cwd: OPENCODE_PACKAGE_ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})
function exitStatus(
  code: number | null,
  signal: number | NodeJS.Signals | null | undefined,
) {
  return signal
    ? 128 + (typeof signal === 'number' ? signal : constants.signals[signal])
    : (code ?? 1)
}

if (opencodeBuild.exitCode !== 0 || opencodeBuild.signalCode) {
  console.error('[dev] OpenCode build failed, aborting')
  process.exit(exitStatus(opencodeBuild.exitCode, opencodeBuild.signalCode))
}

// 2. Create symlink
const removeOwnSymlink = createSymlink()

// 3. Start tsc --watch
console.log('[dev] Starting tsc --watch for OpenCode...')
console.log('[dev] Restart OpenCode to pick up the linked plugin.')
try {
  const opencodeChild = Bun.spawn(
    ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'],
    {
      cwd: OPENCODE_PACKAGE_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  const interrupt = () => opencodeChild.kill('SIGINT')
  const terminate = () => opencodeChild.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const code = await opencodeChild.exited
    process.exitCode = exitStatus(code, opencodeChild.signalCode)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
} finally {
  try {
    removeOwnSymlink?.()
  } catch (error) {
    console.error('[dev] Could not remove dev symlink:', error)
    process.exitCode ||= 1
  }
}
