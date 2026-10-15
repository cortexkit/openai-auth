import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPackedPackages } from './fixtures/opencode2-pack'

const packages = join(import.meta.dir, '../../../..', 'packages')
const installedTreeCheck = join(
  packages,
  '../scripts/check-private-files-tree.mjs',
)
const externalImport = /import\s*\(\s*['"]@cortexkit\/private-files['"]\s*\)/
// These strings belong to private-files' native loader, not common-auth's wrapper.
const loaderSignatures = [
  'private-files-win32-',
  'Invalid private-files N-API interface',
  'N-API v8 prebuild',
]

function assertExternalTree(root: string) {
  const sources = readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => /\.(?:js|mjs|tsx)$/.test(file))
    .map((file) => readFileSync(join(root, file), 'utf8'))
  expect(sources.length).toBeGreaterThan(0)
  expect(sources.some((source) => externalImport.test(source))).toBe(true)
  for (const source of sources) {
    for (const signature of loaderSignatures) {
      expect(source).not.toContain(signature)
    }
  }
  expect(
    readdirSync(root, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.node')),
  ).toEqual([])
}

describe('private-files packaging boundary', () => {
  for (const host of ['opencode', 'pi']) {
    test(`${host} ships private-files as a runtime dependency and keeps its loader external`, () => {
      const root = join(packages, host)
      const manifest = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      )
      expect(manifest.dependencies['@cortexkit/private-files']).toBe('^0.2.1')
      assertExternalTree(join(root, 'dist'))
    })
  }
  for (const variant of ['raw', 'runtime']) {
    test(`TUI ${variant} keeps private-files external`, () => {
      assertExternalTree(
        join(packages, 'opencode', 'src', 'tui-compiled', variant),
      )
    })
  }

  test('npm-packed hosts share one private-files 0.2.x dependency without an inlined loader', () => {
    const consumer = installPackedPackages(
      ['opencode', 'pi'].map((host) => join(packages, host)),
    )
    try {
      const tree = spawnSync(process.execPath, [installedTreeCheck, consumer], {
        encoding: 'utf8',
      })
      expect(tree.status).toBe(0)
      expect(tree.stderr).toBe('')
      expect(tree.stdout).toContain('1 physical copy: 0.2.')
      const privateFiles = join(
        consumer,
        'node_modules',
        '@cortexkit',
        'private-files',
      )
      for (const host of ['opencode', 'pi']) {
        const root = join(
          consumer,
          'node_modules',
          '@cortexkit',
          `${host}-openai-auth`,
        )
        const probe = spawnSync(
          'node',
          [
            '--input-type=module',
            '--eval',
            "console.log(import.meta.resolve('@cortexkit/private-files')); await import('@cortexkit/private-files')",
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: { PATH: process.env.PATH ?? '' },
          },
        )
        expect(probe.status).toBe(0)
        expect(probe.stderr).toBe('')
        // Node resolves through symlinks (macOS /var is /private/var), so
        // compare against the real path of the installed package.
        expect(fileURLToPath(probe.stdout.trim())).toStartWith(
          `${realpathSync(privateFiles)}${sep}`,
        )
        assertExternalTree(join(root, 'dist'))
      }
    } finally {
      rmSync(dirname(consumer), { recursive: true, force: true })
    }
  }, 120_000)
})
