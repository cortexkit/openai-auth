/**
 * Golden check for the Claustrum handle/tombstone fixtures.
 *
 * The script compares the local fixtures under
 * `packages/opencode/src/tests/fixtures/claustrum-golden/` against the bytes
 * published at the upstream commit recorded in `SOURCE.json`. Drift is
 * reported on stderr and exits non-zero so CI can fail the gate.
 *
 * Run via `bun run check:claustrum-golden` (see package.json scripts).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const fixtureDir = join(
  import.meta.dir,
  '..',
  'src',
  'tests',
  'fixtures',
  'claustrum-golden',
)
const source = JSON.parse(
  await readFile(join(fixtureDir, 'SOURCE.json'), 'utf8'),
) as {
  repo: string
  ref: string
  paths: Record<string, string>
}

function rejectSource(reason: string): never {
  console.error(`INVALID SOURCE.json: ${reason}`)
  process.exit(1)
}

if (!source.repo) rejectSource('repo is missing')
if (!source.ref) rejectSource('ref is missing')
if (!/^[0-9a-f]{40}$/.test(source.ref)) {
  rejectSource('ref must be a 40-hex SHA')
}
const paths = Object.entries(source.paths ?? {})
if (paths.length === 0) rejectSource('paths must contain at least one entry')

for (const [name] of paths) {
  try {
    await readFile(join(fixtureDir, `${name}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      rejectSource(`vendored file is missing: ${name}.json`)
    }
    throw error
  }
}

let drifted = false
for (const [name, sourcePath] of paths) {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${sourcePath}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${name} golden: ${response.status} ${url}`)
  }
  const remote = Buffer.from(await response.arrayBuffer())
  const local = await readFile(join(fixtureDir, `${name}.json`))
  if (Buffer.compare(remote, local) !== 0) {
    console.error(`DRIFT: ${name}.json differs from ${url}`)
    drifted = true
    continue
  }
  console.log(`${name}.json: IDENTICAL (${source.ref})`)
}

if (drifted) process.exitCode = 1
