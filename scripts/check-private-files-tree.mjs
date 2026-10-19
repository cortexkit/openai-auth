#!/usr/bin/env bun
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'))
const requireStore = process.argv.includes('--require-store')
const requireSubc = process.argv.includes('--require-subc')
const requireCommonAuth = process.argv.includes('--require-common-auth')
const copies = new Map()
const stores = new Map()
const subc = new Map()
const commonAuth = new Map()

const tracked = {
  '@cortexkit/private-files': copies,
  '@cortexkit/store': stores,
  '@cortexkit/subc-client': subc,
  '@cortexkit/common-auth': commonAuth,
}
const visitedModules = new Set()
const visitedPackages = new Set()

// Counts only the copies the installed tree actually reaches. Bun keeps every
// version it ever installed under node_modules/.bun, and a long-lived checkout
// accumulates old ones nothing links to; counting those directories would fail
// on any developer machine while a fresh CI install passes.
function installed(directory) {
  const real = realpathSync(directory)
  if (visitedModules.has(real)) return
  visitedModules.add(real)
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith('.')) continue
    const path = join(directory, entry)
    if (entry.startsWith('@')) {
      if (!isDirectory(path)) continue
      for (const name of readdirSync(path))
        visitPackage(join(path, name), `${entry}/${name}`)
    } else visitPackage(path, entry)
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function visitPackage(path, name) {
  let real
  try {
    real = realpathSync(path)
  } catch {
    return
  }
  if (!isDirectory(real) || visitedPackages.has(real)) return
  visitedPackages.add(real)
  const found = tracked[name]
  if (found) {
    const manifest = JSON.parse(
      readFileSync(join(real, 'package.json'), 'utf8'),
    )
    found.set(real, manifest.version)
  }
  // npm-style trees nest a package's own dependencies under it.
  const nested = join(real, 'node_modules')
  if (existsSync(nested)) installed(nested)
  // Bun's isolated layout puts them beside it in the enclosing node_modules.
  const enclosing = name.includes('/') ? dirname(dirname(real)) : dirname(real)
  if (basename(enclosing) === 'node_modules') installed(enclosing)
}

function workspace(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (['.git', '.cortexkit', '.evidence'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.name === 'node_modules') installed(path)
    else workspace(path)
  }
}

workspace(root)
if (copies.size !== 1 || !/^0\.2\.\d+$/.test([...copies.values()][0] ?? '')) {
  console.error(
    'Expected exactly one physical @cortexkit/private-files at 0.2.x',
  )
  console.error([...copies.entries()])
  process.exit(1)
}
if (
  (requireStore && stores.size === 0) ||
  [...stores.values()].some(
    (version) => !Bun.semver.satisfies(version, '>=0.2.3'),
  )
) {
  console.error('Expected installed @cortexkit/store versions to be >=0.2.3')
  console.error([...stores.entries()])
  process.exit(1)
}
if (
  requireSubc &&
  (subc.size !== 1 ||
    !Bun.semver.satisfies([...subc.values()][0] ?? '', '^0.22.0'))
) {
  console.error(
    'Expected exactly one physical @cortexkit/subc-client at 0.22.x',
  )
  console.error([...subc.entries()])
  process.exit(1)
}
if ((requireCommonAuth && commonAuth.size !== 1) || commonAuth.size > 1) {
  console.error(
    `${requireCommonAuth ? 'Expected exactly one' : 'Expected at most one'} physical @cortexkit/common-auth, found ${commonAuth.size}`,
  )
  console.error([...commonAuth.entries()])
  process.exit(1)
}
console.log(
  `private-files tree ok (${copies.size} physical copy: ${[...copies.values()]}; ${stores.size} store copies: ${[...stores.values()]})`,
)
console.log(
  `common-auth tree ok (${commonAuth.size} physical copy: ${[...commonAuth.values()]})`,
)
if (requireSubc)
  console.log(
    `subc-client tree ok (${subc.size} physical copy: ${[...subc.values()]})`,
  )
