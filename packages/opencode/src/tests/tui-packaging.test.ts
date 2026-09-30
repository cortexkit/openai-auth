import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
    // The entry reaches the variants only through the selector the TUI build
    // copies next to them, never through a bare @cortexkit/common-auth import:
    // that package is inlined at build time and not installed with the plugin.
    expect(relativeSpecs(entrySource)).toEqual([
      '../tui-compiled/runtime/selector.js',
    ])
    expect(entrySource).not.toContain('@cortexkit/common-auth')
    expect(entrySource).toContain("'../tui-compiled/raw/tui.tsx'")
    expect(entrySource).toContain("'../tui-compiled/runtime/tui.js'")
    expect(entrySource).not.toContain("import('../tui.tsx')")
  })

  // scripts/build-tui.ts emits the import closure of tui.tsx, computed by the
  // shared TUI build. A source file reachable from tui.tsx but absent from a
  // generated variant would make the TUI fail at load time, so walk the real
  // import graph and require every reachable file in both variants.
  test('every src/ file reachable from tui.tsx is in build-tui shippedSourceFiles', () => {
    const compiledRoot = join(PKG_DIR, 'src', 'tui-compiled')
    if (!existsSync(compiledRoot)) {
      throw new Error(
        'src/tui-compiled is absent — run `bun run build:tui` before this suite, or this test silently proves nothing',
      )
    }
    const reachable = [...collectReachableSrcFiles('src/tui.tsx')]
      .filter((rel) => !rel.startsWith('src/tui-compiled/'))
      .map((rel) => rel.replace(/^src\//, ''))
      .sort()
    expect(reachable.length).toBeGreaterThan(1)

    // raw keeps .tsx for the host's Solid transform; everything else is .js.
    const emittedName = (rel: string, variant: string) =>
      variant === 'raw' && rel.endsWith('.tsx')
        ? rel
        : rel.replace(/\.tsx?$/, '.js')
    const missing = ['raw', 'runtime'].flatMap((variant) =>
      reachable
        .map((rel) => `${variant}/${emittedName(rel, variant)}`)
        .filter((rel) => !existsSync(join(compiledRoot, rel))),
    )
    expect(missing).toEqual([])
  })

  // Presence says nothing about whether the generated tree links: an inlined
  // module can be copied while a name it imports is missing. That shipped once —
  // `bun run build` succeeded, the suite was green, and importing the generated
  // logger threw `export 'createLogger' not found`. Loading the modules is the
  // only check that sees it. Every emitted module that bare Bun can load is
  // imported, in both variants: that covers the inlined core and
  // @cortexkit/common-auth copies, and the selector the entry imports. The
  // modules left out import the host's virtual OpenTUI runtime or raw TSX,
  // which only the host can load.
  test('both generated variants link', async () => {
    const compiledRoot = join(PKG_DIR, 'src', 'tui-compiled')
    if (!existsSync(compiledRoot)) {
      throw new Error(
        'src/tui-compiled is absent — run `bun run build:tui` before this suite, or this test silently proves nothing',
      )
    }
    for (const variant of ['runtime', 'raw']) {
      const variantRoot = join(compiledRoot, variant)
      const loadable = readdirSync(variantRoot, { recursive: true })
        .map(String)
        .filter((rel) => rel.endsWith('.js'))
        .filter(
          (rel) =>
            !/from\s+"opentui:runtime-module:/.test(
              readFileSync(join(variantRoot, rel), 'utf8'),
            ),
        )
        .sort()
      // The generated logger imports the most inlined core and library code,
      // and the selector is what src/tui/entry.mjs imports, so both must be in
      // the imported set for the check below to mean anything.
      expect(loadable).toContain('logger.js')
      expect(loadable).toContain('selector.js')
      for (const rel of loadable) await import(join(variantRoot, rel))
    }
  })

  // Whatever the TUI imports from core must be something core forwards. Naming
  // symbols by hand is what let these drift apart, so the core module the TUI
  // reaches forwards whole modules; this pins that it kept doing so rather than
  // reverting to a list that looks right and is not.
  test('the generated core shim forwards whole modules', () => {
    const shim = readFileSync(
      join(PKG_DIR, '..', 'core', 'src', 'tui-support.ts'),
      'utf8',
    )
    const lines = shim.split('\n').filter((line) => line.startsWith('export'))
    expect(lines.length).toBeGreaterThan(0)
    const named = lines.filter((line) => !/^export \* from '/.test(line))
    expect(named).toEqual([])
  })

  test('the built plugin bundle removes the singular RPC global', () => {
    // The bundle is produced by `bun run build`, which CI runs as a separate
    // step before `bun run test` (see .github/workflows/ci.yml). Reading the
    // bundle directly here keeps the test dependent on the same freshness
    // guarantee CI provides instead of rebuilding inside the test.
    const bundle = join(PKG_DIR, 'dist', 'index.js')
    if (!existsSync(bundle)) {
      throw new Error(
        'Built plugin bundle is missing: dist/index.js (run `bun run build` first)',
      )
    }
    if (statSync(bundle).size < 1_024) {
      throw new Error(
        'Built plugin bundle is unexpectedly small: dist/index.js',
      )
    }

    const source = readFileSync(bundle, 'utf8')
    const registryCount = source.match(/__openaiAuthRpcServers/g)?.length ?? 0
    if (registryCount < 1) {
      throw new Error('Built plugin bundle is missing the RPC registry global')
    }

    const singularCount =
      source.match(/__openaiAuthRpcServer[^s]/g)?.length ?? 0
    if (singularCount !== 0) {
      throw new Error('Built plugin bundle retains the singular RPC global')
    }
  })
})
