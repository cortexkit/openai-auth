#!/usr/bin/env bun
// Refuses any dependency that resolves outside this repository, in every
// package.json and in bun.lock. A dependency on a sibling checkout builds
// locally from whatever happens to be on disk there, and fails or silently
// differs everywhere else (CI, other machines, a release build).
// Usage: bun scripts/check-local-deps.mjs [repo-root]
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const root = realpathSync(
  resolve(process.argv[2] ?? import.meta.dir, process.argv[2] ? '.' : '..'),
)
const sections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
]
const offenders = []
let manifests = 0

function outside(path) {
  const fromRoot = relative(root, path)
  return (
    fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
  )
}
function inspect(spec, file, field, name, base) {
  if (typeof spec !== 'string' || spec.startsWith('workspace:')) return
  let local
  // Only these forms are filesystem paths. Registry ranges, `npm:` aliases,
  // `user/repo` shorthand and git URLs also contain `/` but never point at a
  // local directory.
  if (/^(file|link|portal):/.test(spec))
    local = spec.slice(spec.indexOf(':') + 1)
  else if (
    isAbsolute(spec) ||
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('~/')
  )
    local = spec
  else return
  const path = local.startsWith('~/')
    ? resolve(homedir(), local.slice(2))
    : resolve(base, local)
  let real
  try {
    real = realpathSync(path)
  } catch (error) {
    offenders.push({
      file,
      field,
      name,
      spec,
      problem: `cannot resolve ${path}: ${error.message}`,
    })
    return
  }
  if (outside(real))
    offenders.push({
      file,
      field,
      name,
      spec,
      problem: `resolves outside the repository to ${real}`,
    })
}
function inspectTree(value, file, field, base) {
  if (!value || typeof value !== 'object') return
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string') inspect(spec, file, field, name, base)
    else inspectTree(spec, file, field, base)
  }
}
// bun.lock is JSON with trailing commas, which JSON.parse rejects. Drop a
// comma that only whitespace separates from a closing `}` or `]`, outside
// strings.
function stripTrailingCommas(text) {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
    } else if (char === ',') {
      let next = index + 1
      while (/\s/.test(text[next] ?? '')) next += 1
      if (text[next] !== '}' && text[next] !== ']') output += char
    } else output += char
  }
  return output
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name === 'package.json') {
      manifests += 1
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      for (const section of sections)
        inspectTree(manifest[section], path, section, dirname(path))
    }
  }
}
walk(root)
const lock = join(root, 'bun.lock')
try {
  const contents = readFileSync(lock, 'utf8')
  const json = JSON.parse(stripTrailingCommas(contents))
  // Each `workspaces` entry copies a package.json's dependency specs, which
  // are relative to that package's directory (the entry's key, "" for the
  // root). The `packages` section repeats the same resolutions without their
  // protocol, so the workspace entries are the ones to check.
  for (const [workspace, manifest] of Object.entries(json.workspaces ?? {})) {
    const base = resolve(root, workspace)
    for (const section of sections) {
      const field = `workspaces[${workspace}].${section}`
      for (const [name, spec] of Object.entries(manifest[section] ?? {}))
        inspect(spec, lock, field, name, base)
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
// A scan that read nothing would pass vacuously (a wrong root, a renamed
// layout), so an empty census is a failure of the check itself.
if (manifests === 0) {
  console.error(`no package.json found under ${root}; nothing was checked`)
  process.exit(2)
}
if (offenders.length) {
  for (const item of offenders)
    console.error(
      `${item.file}: ${item.field} ${item.name} ${item.spec} ${item.problem}`,
    )
  process.exit(1)
}
console.log(
  `local dependencies stay within repository (${manifests} package.json checked)`,
)
