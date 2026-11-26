import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checker = join(
  import.meta.dir,
  '../../../../scripts/check-private-files-tree.mjs',
)

test('classifies a tracked package reached first under an alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-files-tree-'))
  try {
    const modules = join(root, 'node_modules')
    const pkg = join(
      modules,
      '.bun',
      'private-files',
      'node_modules',
      '@cortexkit',
      'private-files',
    )
    mkdirSync(pkg, { recursive: true })
    mkdirSync(join(modules, '@alias'))
    writeFileSync(join(pkg, 'package.json'), '{"version":"0.2.3"}')
    symlinkSync(pkg, join(modules, '@alias', 'private-files'), 'junction')

    const result = spawnSync(process.execPath, [checker, root], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 physical copy: 0.2.3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
