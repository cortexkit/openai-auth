#!/usr/bin/env bun
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'))
const requireStore = process.argv.includes('--require-store')
const copies = new Map()
const stores = new Map()

function installed(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Bun's aliases are symlinks; its physical packages live under .bun.
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (
      basename(directory) === '@cortexkit' &&
      (entry.name === 'private-files' || entry.name === 'store')
    ) {
      const manifest = JSON.parse(
        readFileSync(join(path, 'package.json'), 'utf8'),
      )
      const found = entry.name === 'private-files' ? copies : stores
      found.set(realpathSync(path), manifest.version)
    }
    installed(path)
  }
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
console.log(
  `private-files tree ok (${copies.size} physical copy: ${[...copies.values()]}; ${stores.size} store copies: ${[...stores.values()]})`,
)
