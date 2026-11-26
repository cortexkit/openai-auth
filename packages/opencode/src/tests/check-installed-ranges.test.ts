import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The checker reads the repository it sits in (its own directory's parent),
// so each case copies it into a throwaway repository with one declared
// dependency and one installed version.
const checker = join(
  import.meta.dir,
  '../../../../scripts/check-installed-ranges.mjs',
)

function check(
  declared: string,
  installed: string,
  nested = false,
  fixtureInstalled = true,
  installedInParent = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'installed-ranges-'))
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'packages'))
    const from = nested
      ? join(
          root,
          'packages',
          'opencode',
          'src',
          'tests',
          'fixtures',
          'opencode1-host',
        )
      : root
    mkdirSync(from, { recursive: true })
    if (fixtureInstalled)
      mkdirSync(join(from, 'node_modules'), { recursive: true })
    const installDir = join(
      installedInParent ? root : from,
      'node_modules',
      'left-pad',
    )
    copyFileSync(checker, join(root, 'scripts', 'check-installed-ranges.mjs'))
    if (nested) writeFileSync(join(root, 'package.json'), '{"private":true}')
    writeFileSync(
      join(from, 'package.json'),
      JSON.stringify({
        name: nested ? 'nested-host-fixture' : 'fixture',
        dependencies: { 'left-pad': declared },
      }),
    )
    if (fixtureInstalled) {
      mkdirSync(installDir, { recursive: true })
      writeFileSync(
        join(installDir, 'package.json'),
        JSON.stringify({ name: 'left-pad', version: installed }),
      )
    }
    return spawnSync(
      'bun',
      [join(root, 'scripts', 'check-installed-ranges.mjs')],
      { encoding: 'utf8' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('installed range build gate', () => {
  it('refuses an installed version outside the declared range and names it', () => {
    const result = check('^2.0.0', '1.3.0')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'fixture: left-pad is installed at 1.3.0, outside the declared ^2.0.0',
    )
  })

  it('passes an installed version inside the declared range', () => {
    const result = check('^2.0.0', '2.1.0')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'installed ranges ok (1 dependencies checked)',
    )
  })

  it('refuses a nested host fixture installed outside its declared range', () => {
    const result = check('2.0.0', '1.3.0', true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'nested-host-fixture: left-pad is installed at 1.3.0, outside the declared 2.0.0',
    )
  })

  it('checks a nested host fixture without counting its node_modules manifests', () => {
    const result = check('2.0.0', '2.0.0', true)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'installed ranges ok (1 dependencies checked)',
    )
  })

  it('skips a nested host fixture that is not installed, so a build needs no fixtures', () => {
    const result = check('2.0.0', '2.0.0', true, false)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'installed ranges ok (0 dependencies checked)',
    )
  })

  it('does not borrow a missing fixture dependency from the repository', () => {
    const result = check('2.0.0', '2.0.0', true, true, true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'nested-host-fixture: left-pad (2.0.0) is not installed',
    )
  })

  it('checks the declared range of a scoped registry alias', () => {
    const result = check('npm:@scope/real-package@^2.0.0', '1.3.0')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'left-pad is installed at 1.3.0, outside the declared npm:@scope/real-package@^2.0.0',
    )
  })
})
