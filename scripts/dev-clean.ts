import { lstatSync, readlinkSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SYMLINK_PATH = resolve(
  import.meta.dirname,
  '..',
  '.opencode',
  'plugins',
  'openai-auth.js',
)

const relativeTarget = '../../packages/opencode/dist/index.js'
const target = resolve(dirname(SYMLINK_PATH), relativeTarget)
const entry = lstatSync(SYMLINK_PATH, { throwIfNoEntry: false })
const link = entry?.isSymbolicLink() && readlinkSync(SYMLINK_PATH)
if (!entry) {
  console.log('[dev:clean] No symlink found, nothing to clean')
} else if (link === relativeTarget || link === target) {
  unlinkSync(SYMLINK_PATH)
  console.log('[dev:clean] Removed symlink')
} else {
  console.error(
    `[dev:clean] Refusing to remove ${SYMLINK_PATH}: not a link to ${target}`,
  )
  process.exitCode = 1
}
