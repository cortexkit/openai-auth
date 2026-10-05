import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checker = join(
  import.meta.dir,
  '../../../../scripts/check-local-deps.mjs',
)
function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'local-deps-'))
  try {
    mkdirSync(join(root, 'packages/x'), { recursive: true })
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
function check(root: string) {
  return spawnSync('bun', [checker, root], { encoding: 'utf8' })
}
function manifest(root: string, deps: object) {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: deps }),
  )
}

describe('local dependency build gate', () => {
  it('rejects file dependencies outside the repository and names the offender', () => {
    fixture((root) => {
      manifest(root, { sibling: 'file:../sibling' })
      const result = check(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('dependencies sibling file:../sibling')
      expect(result.stderr).toContain(join(root, '..', 'sibling'))
    })
  })

  it('allows local file and workspace dependencies', () => {
    fixture((root) => {
      manifest(root, { x: 'file:./packages/x', workspace: 'workspace:*' })
      const result = check(root)
      expect(result.status).toBe(0)
    })
  })

  it('checks bun.lock local protocols against repository root', () => {
    fixture((root) => {
      manifest(root, {})
      writeFileSync(
        join(root, 'bun.lock'),
        JSON.stringify({ packages: { external: 'file:../sibling' } }),
      )
      const result = check(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('bun.lock')
      expect(result.stderr).toContain('file:../sibling')
    })
  })
})
