import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Evergreen regression checks for the ./tui runtime shim and both generated
// source variants. The package ships only the stable entry plus build output;
// development source must not leak into the tarball.
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

describe('tui packaging (compiled ./tui entry shim)', () => {
  test('manifest ships only the entry shim and generated source tree', () => {
    const pkg = readJson(join(PKG_DIR, 'package.json'))
    const tuiEntry: string = pkg.exports['./tui'].import
    expect(tuiEntry).toBe('./src/tui/entry.mjs')
    expect(pkg.files).toEqual([
      'dist',
      'src/tui/entry.mjs',
      'src/tui-compiled',
      'README.md',
      'LICENSE',
    ])

    const entrySource = readFileSync(join(PKG_DIR, tuiEntry), 'utf8')
    expect(relativeSpecs(entrySource)).toEqual([
      '../tui-compiled/raw/tui.tsx',
      '../tui-compiled/runtime/tui.tsx',
    ])
    expect(entrySource).not.toContain("import('../tui.tsx')")
  })

  // Both generated variants are produced from the static shippedSourceFiles
  // list in scripts/build-tui.ts. A source file reachable from tui.tsx but
  // missing from that list is absent from src/tui-compiled/, and the TUI then
  // fails at load time. Walk the real import graph and require coverage.
  test('every src/ file reachable from tui.tsx is in build-tui shippedSourceFiles', () => {
    const script = readFileSync(
      join(PKG_DIR, 'scripts', 'build-tui.ts'),
      'utf8',
    )
    const arrayMatch = script.match(
      /const shippedSourceFiles = \[([\s\S]*?)\] as const/,
    )
    if (!arrayMatch) {
      throw new Error(
        'scripts/build-tui.ts no longer declares shippedSourceFiles — update this test to match the new build mechanism',
      )
    }
    const shipped = new Set(
      [...arrayMatch[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!),
    )

    // tui-compiled is build output; the graph of interest is the raw source
    // fallback starting at src/tui.tsx (the same graph build-tui compiles).
    const reachable = [...collectReachableSrcFiles('src/tui.tsx')]
      .filter((rel) => !rel.startsWith('src/tui-compiled/'))
      .map((rel) => rel.replace(/^src\//, ''))
      .sort()

    const missing = reachable.filter((rel) => !shipped.has(rel))
    expect(missing).toEqual([])
  })

  // The check above proves every file is present; it says nothing about whether
  // the generated tree links. It cannot: the shared re-export shim is written
  // by the generator, so a file can be shipped while the symbols it imports
  // from that shim are missing. That shipped once — `bun run build` succeeded,
  // the suite was green, and importing the generated logger threw
  // `export 'createLogger' not found`. Loading the modules is the only check
  // that sees it.
  test('both generated variants link', async () => {
    const compiledRoot = join(PKG_DIR, 'src', 'tui-compiled')
    if (!existsSync(compiledRoot)) {
      throw new Error(
        'src/tui-compiled is absent — run `bun run build:tui` before this suite, or this test silently proves nothing',
      )
    }
    // The logger is the deepest core consumer in the shipped set, so it is the
    // one that fails first when the shim goes stale. Importing it pulls the
    // shim and every module the shim forwards.
    for (const variant of ['runtime', 'raw']) {
      const target = join(compiledRoot, variant, 'logger.ts')
      expect(existsSync(target)).toBe(true)
      await import(target)
    }
  })

  // Whatever the shipped sources import from the core shim must be something
  // the shim actually forwards. Naming symbols by hand is what let these drift
  // apart, so the generator forwards whole modules; this pins that it kept
  // doing so rather than reverting to a list that looks right and is not.
  test('the generated core shim forwards whole modules', () => {
    const shim = readFileSync(
      join(PKG_DIR, 'src', 'tui-compiled', 'shared', 'internal.ts'),
      'utf8',
    )
    const lines = shim.split('\n').filter((line) => line.startsWith('export'))
    expect(lines.length).toBeGreaterThan(0)
    const named = lines.filter((line) => !/^export \* from '/.test(line))
    expect(named).toEqual([])
  })
})
