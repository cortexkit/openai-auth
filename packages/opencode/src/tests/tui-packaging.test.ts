import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Evergreen regression check: the ./tui export ships raw source
// (exports["./tui"].import === "./src/tui.tsx"), so every src/ file
// transitively reachable from that entry must be listed in package.json
// "files" — otherwise the published tarball is missing modules and the
// ./tui import throws ERR_MODULE_NOT_FOUND at load time.  This test walks
// the import graph dynamically from package.json and asserts no reachable
// src/ file is uncovered.
// ---------------------------------------------------------------------------

const PKG_DIR = join(import.meta.dir!, '..', '..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Collect every relative import/export specifier in a source file.
// Covers:
//   import ... from './x'
//   import type ... from './x'
//   export ... from './x'
//   export type ... from './x'
//   import './x'                (side-effect)
//   import('./x')               (dynamic)
function relativeSpecs(source: string): string[] {
  const seen = new Set<string>()
  // static from-based (single- or multi-line; captures the string body)
  for (const m of source.matchAll(/from\s+(['"])(\.[^'"]*)\1/g)) {
    seen.add(m[2]!)
  }
  // dynamic import() calls
  for (const m of source.matchAll(/import\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g)) {
    seen.add(m[2]!)
  }
  // bare side-effect imports
  for (const m of source.matchAll(/import\s+(['"])(\.[^'"]*)\1/g)) {
    seen.add(m[2]!)
  }
  return [...seen]
}

// Resolve a relative specifier against an importer directory using the
// same resolution rules TypeScript (and Bun's runtime loader) follows
// for .ts/.tsx source files.
function resolveRelSpec(spec: string, fromDir: string): string | null {
  // Order matters: exact match, then .ts / .tsx, then index files,
  // then .js/.jsx→.ts/.tsx rewrites (the source tree uses .js specifiers).
  const candidates = [spec]

  if (spec.endsWith('.js')) {
    const base = spec.slice(0, -3)
    candidates.push(`${base}.ts`, `${base}.tsx`)
  } else if (spec.endsWith('.jsx')) {
    const base = spec.slice(0, -4)
    candidates.push(`${base}.tsx`)
  }

  candidates.push(
    `${spec}.ts`,
    `${spec}.tsx`,
    `${spec}/index.ts`,
    `${spec}/index.tsx`,
  )

  for (const c of candidates) {
    const p = resolve(fromDir, c)
    if (existsSync(p)) return p
  }
  return null
}

// BFS the transitive relative-import graph starting from entryRel (a
// package-relative path like "src/tui.tsx").  Returns the set of posix
// package-relative paths for every src/ file reached.
function collectReachableSrcFiles(entryRel: string): Set<string> {
  const pkgSrc = join(PKG_DIR, 'src')
  const visited = new Set<string>()
  const queue = [entryRel]

  while (queue.length > 0) {
    const f = queue.shift()!
    const abs = resolve(PKG_DIR, f)
    if (visited.has(abs)) continue
    visited.add(abs)

    let source: string
    try {
      source = readFileSync(abs, 'utf8')
    } catch {
      continue
    }

    const fromDir = dirname(abs)
    for (const spec of relativeSpecs(source)) {
      const resolved = resolveRelSpec(spec, fromDir)
      if (resolved?.startsWith(pkgSrc) && !visited.has(resolved)) {
        queue.push(relative(PKG_DIR, resolved))
      }
    }
  }

  // Posix-relative paths (Bun on Windows still uses / in package.json paths)
  return new Set(
    [...visited].map((f) => relative(PKG_DIR, f).replaceAll('\\', '/')),
  )
}

// A reachable src/ file is covered when some "files" entry E satisfies
//   relPath === E   OR   relPath.startsWith(E.replace(/\/$/, '') + '/')
function uncoveredFiles(reachable: Set<string>, files: string[]): string[] {
  return [...reachable]
    .filter((rel) => {
      for (const e of files) {
        const dir = e.replace(/\/$/, '')
        if (rel === e || rel.startsWith(`${dir}/`)) return false // covered
      }
      return true // uncovered
    })
    .sort()
}

describe('tui packaging (raw-source ./tui entry)', () => {
  test('every reachable src/ file is covered by package.json files', () => {
    const pkg = readJson(join(PKG_DIR, 'package.json'))
    const tuiEntry: string = pkg.exports['./tui'].import

    if (!tuiEntry.startsWith('./')) {
      throw new Error(
        `Expected exports["./tui"].import to be a raw-source entry like "./src/tui.tsx", got ${JSON.stringify(tuiEntry)}`,
      )
    }

    // Strip the "./" prefix to get a package-relative path ("src/tui.tsx")
    const entryRel = tuiEntry.slice(2)
    const reachable = collectReachableSrcFiles(entryRel)
    const uncovered = uncoveredFiles(reachable, pkg.files)

    expect(uncovered).toEqual([])
  })
})
