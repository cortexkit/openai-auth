import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkSourceSize } from '../../../../scripts/check-source-size.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture(path: string, lines: number) {
  const root = mkdtempSync(join(tmpdir(), 'source-size-'))
  roots.push(root)
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'line\n'.repeat(lines))
  return root
}

test('rejects a source file at the limit but exempts tests', () => {
  const root = fixture('large.ts', 5000)
  writeFileSync(join(root, 'large.test.ts'), 'line\n'.repeat(5000))
  expect(checkSourceSize(root, ['large.ts', 'large.test.ts'], [])).toEqual([
    'large.ts: 5000 lines (limit: fewer than 5000)',
  ])
})

test('enforces an exception cap and removes stale exceptions', () => {
  const root = fixture('large.ts', 5000)
  const exceptions = [{ path: 'large.ts', maxLines: 5000, reason: 'legacy' }]
  expect(checkSourceSize(root, ['large.ts'], exceptions)).toEqual([])
  writeFileSync(join(root, 'large.ts'), 'line\n'.repeat(5001))
  expect(checkSourceSize(root, ['large.ts'], exceptions)).toEqual([
    'large.ts: 5001 lines exceeds exception cap 5000',
  ])
  writeFileSync(join(root, 'large.ts'), 'line\n'.repeat(4999))
  expect(checkSourceSize(root, ['large.ts'], exceptions)).toEqual([
    'Stale exception: large.ts has 4999 lines (under 5000)',
  ])
  expect(checkSourceSize(root, [], exceptions)).toEqual([
    'Stale exception: large.ts is not tracked',
  ])
})
