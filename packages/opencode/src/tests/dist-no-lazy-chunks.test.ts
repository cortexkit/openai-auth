import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// OpenCode loads this plugin from dist/ and keeps the process running while dist/
// may be rebuilt (a local checkout in development, an in-place upgrade). The
// build deletes dist/ and writes chunks under new hashed names, so a chunk the
// running process has not loaded yet is gone when it asks for it. A lazily
// imported chunk therefore fails for the rest of that process's life: a
// dynamic import of the quota normalizer did exactly that and left every vault
// quota poll failing with ENOENT until OpenCode restarted. Every chunk must be
// loaded when the entry loads, so the bundle may contain no relative import().

const DIST = join(import.meta.dir, '..', '..', 'dist')

/** Relative dynamic imports in a bundle file's source. */
export function lazyChunkImports(source: string): string[] {
  return [...source.matchAll(/\bimport\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g)].map(
    (match) => match[2]!,
  )
}

function bundleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return bundleFiles(path)
    return name.endsWith('.js') ? [path] : []
  })
}

describe('plugin bundle loads every chunk at startup', () => {
  test('the scan finds a planted relative dynamic import', () => {
    expect(
      lazyChunkImports(
        'const a = await import("./quota-normalize-abc.js"); import("node:fs")',
      ),
    ).toEqual(['./quota-normalize-abc.js'])
  })

  test('dist contains no relative dynamic import', () => {
    if (!existsSync(DIST)) {
      throw new Error(
        'Built plugin bundle is missing: dist/ (run `bun run build` first)',
      )
    }
    const found = bundleFiles(DIST).flatMap((file) =>
      lazyChunkImports(readFileSync(file, 'utf8')).map(
        (spec) => `${file}: ${spec}`,
      ),
    )
    expect(found).toEqual([])
  })
})
