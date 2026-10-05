#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const root = resolve(
  process.argv[2] ?? import.meta.dir,
  process.argv[2] ? '.' : '..',
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

function outside(path) {
  const resolved = resolve(path)
  return resolved !== root && !resolved.startsWith(root + sep)
}
function inspect(spec, file, field, name, base) {
  if (typeof spec !== 'string' || spec.startsWith('workspace:')) return
  let local
  if (/^(file|link|portal):/.test(spec))
    local = spec.slice(spec.indexOf(':') + 1)
  else if (
    spec.startsWith('/') ||
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    (!spec.startsWith('@') && spec.includes('/') && !/^[\d^~*<>=]/.test(spec))
  )
    local = spec
  else return
  if (outside(resolve(base, local)))
    offenders.push({ file, field, name, spec, path: resolve(base, local) })
}
function inspectTree(value, file, field, base) {
  if (!value || typeof value !== 'object') return
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string') inspect(spec, file, field, name, base)
    else inspectTree(spec, file, field, base)
  }
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name === 'package.json') {
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
  for (const match of contents.matchAll(/"((?:file|link|portal):[^"]+)"/g)) {
    inspect(match[1], lock, 'bun.lock', match[1], root)
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (offenders.length) {
  for (const item of offenders)
    console.error(
      `${item.file}: ${item.field} ${item.name} ${item.spec} resolves to ${item.path}`,
    )
  process.exit(1)
}
console.log('local dependencies stay within repository')
