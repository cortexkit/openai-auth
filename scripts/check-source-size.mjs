import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 5000
const EXCEPTIONS = [
  {
    path: 'packages/opencode/src/index.ts',
    maxLines: 5536,
    reason:
      'OpenCode 1 plugin entry; may not grow; split by area when next worked in',
  },
]

// Exempt *.test.*, *.spec.*, test/, tests/, fixture/ and fixtures/; tui-compiled/ is generated.
function exempt(path) {
  return (
    /\.d\.ts$/.test(path) ||
    /\.(?:test|spec)\.[^/]+$/.test(path) ||
    /(?:^|\/)(?:test|tests|fixture|fixtures)\//.test(path) ||
    path.startsWith('packages/opencode/src/tui-compiled/')
  )
}

export function checkSourceSize(root, trackedFiles, exceptions = EXCEPTIONS) {
  const errors = []
  const tracked = new Set(trackedFiles)
  const caps = new Map(exceptions.map((entry) => [entry.path, entry]))
  for (const entry of exceptions) {
    if (!tracked.has(entry.path))
      errors.push(`Stale exception: ${entry.path} is not tracked`)
  }
  for (const path of trackedFiles) {
    if (!/\.(?:ts|tsx|mts|mjs|js|cjs)$/.test(path) || exempt(path)) continue
    let contents
    try {
      contents = readFileSync(resolve(root, path), 'utf8')
    } catch (error) {
      errors.push(`Cannot read ${path}: ${error.message}`)
      continue
    }
    const lines =
      contents.length === 0
        ? 0
        : contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0)
    const exception = caps.get(path)
    if (exception && lines < LIMIT) {
      errors.push(
        `Stale exception: ${path} has ${lines} lines (under ${LIMIT})`,
      )
    } else if (exception && lines > exception.maxLines) {
      errors.push(
        `${path}: ${lines} lines exceeds exception cap ${exception.maxLines}`,
      )
    } else if (!exception && lines >= LIMIT) {
      errors.push(`${path}: ${lines} lines (limit: fewer than ${LIMIT})`)
    }
  }
  return errors
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  const errors = checkSourceSize(root, files)
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Source file size check passed')
  }
}
