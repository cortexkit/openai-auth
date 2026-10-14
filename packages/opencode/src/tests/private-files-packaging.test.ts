import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const packages = join(import.meta.dir, '../../../..', 'packages')
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
      expect(manifest.dependencies['@cortexkit/private-files']).toBe('^0.1.0')
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
})
