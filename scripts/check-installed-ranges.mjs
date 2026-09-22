#!/usr/bin/env bun
// Refuses to build when an installed dependency does not satisfy the range its
// workspace declares.
//
// `bun install --frozen-lockfile` does not check this. It only asks whether a
// package.json implies changes to the lockfile; it never checks the lockfile
// against the manifests. Measured on this repo: with `packages/core` declaring
// `@cortexkit/claustrum-client` as exactly "0.3.0", swapping the lockfile's
// entry to 0.2.0 plus that version's genuine integrity hash installs 0.2.0 and
// exits 0. Pinning the manifest does not help, because the manifest is never
// consulted.
//
// That matters more than usual here because the build inlines dependencies.
// Whatever version is installed at build time is the version every user runs,
// and nothing on their side resolves it again. So this runs first in `build`,
// where it guards the exact tree that gets bundled and published.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const SECTIONS = ['dependencies', 'devDependencies']
// Ranges that name no registry version, so there is nothing to compare.
const UNVERSIONED = /^(workspace:|file:|link:|git|github:|https?:|npm:)/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workspaceDirs() {
  const dirs = [root]
  const packages = join(root, 'packages')
  for (const name of readdirSync(packages)) {
    if (existsSync(join(packages, name, 'package.json')))
      dirs.push(join(packages, name))
  }
  return dirs
}

// Node's own lookup: the nearest node_modules/<name> walking up from the
// workspace. Reading package.json directly avoids `exports` maps that do not
// expose it.
function installedVersion(fromDir, name) {
  let dir = fromDir
  while (true) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) return readJson(manifest).version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const problems = []
let checked = 0
for (const dir of workspaceDirs()) {
  const manifest = readJson(join(dir, 'package.json'))
  const label = manifest.name ?? dir
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (UNVERSIONED.test(range)) continue
      const version = installedVersion(dir, name)
      checked += 1
      if (version === undefined) {
        problems.push(`${label}: ${name} (${range}) is not installed`)
      } else if (!Bun.semver.satisfies(version, range)) {
        problems.push(
          `${label}: ${name} is installed at ${version}, outside the declared ${range}`,
        )
      }
    }
  }
}

if (problems.length > 0) {
  console.error(
    'Installed dependencies do not match their declared ranges. The lockfile has',
  )
  console.error(
    'drifted from package.json; this build would bundle the wrong versions.',
  )
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`installed ranges ok (${checked} dependencies checked)`)
