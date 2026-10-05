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
    mkdirSync(join(root, 'packages/core'), { recursive: true })
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
function lock(root: string, coreSpec: string, rootSpec?: string) {
  writeFileSync(
    join(root, 'bun.lock'),
    `{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "dependencies": { "root-dep": "${rootSpec ?? '1.0.0'}", }, },
        "packages/core": { "dependencies": { "@cortexkit/common-auth": "${coreSpec}", }, },
      },
      "packages": { "@cortexkit/common-auth": ["@cortexkit/common-auth@../../x.tgz", {}], },
    }`,
  )
}

describe('local dependency build gate', () => {
  it('fails as unchecked when it finds no package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-deps-empty-'))
    try {
      const result = check(root)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('nothing was checked')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects file dependencies outside the repository and names the offender', () => {
    fixture((root) => {
      manifest(root, { sibling: 'file:../sibling' })
      const result = check(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('dependencies sibling file:../sibling')
      expect(result.stderr).toContain(join(root, '..', 'sibling'))
    })
  })

  it('allows local file, workspace, registry, and git dependency specs', () => {
    fixture((root) => {
      manifest(root, {
        x: 'file:./packages/core',
        workspace: 'workspace:*',
        repository: 'user/repo',
        npmAlias: 'npm:@scope/pkg@1',
        gitRepository: 'git+https://example.com/repo.git',
      })
      const result = check(root)
      expect(result.status).toBe(0)
    })
  })

  it('resolves lockfile file specs from their workspace directories', () => {
    fixture((root) => {
      manifest(root, {})
      lock(root, 'file:../../x.tgz')
      const result = check(root)
      expect(result.status).toBe(0)
    })
  })

  it('rejects out-of-root lockfile specs and names the package workspace', () => {
    fixture((root) => {
      manifest(root, {})
      lock(root, 'file:../../../outside.tgz')
      const result = check(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('workspaces[packages/core].dependencies')
      expect(result.stderr).toContain(
        '@cortexkit/common-auth file:../../../outside.tgz',
      )
    })
  })

  it('rejects a root workspace lockfile dependency outside the repository', () => {
    fixture((root) => {
      manifest(root, {})
      lock(root, '1.0.0', 'file:../sibling')
      const result = check(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'workspaces[].dependencies root-dep file:../sibling',
      )
    })
  })
})
