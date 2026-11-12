import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { installPackedPackages } from './fixtures/opencode2-pack'

// Loads the packed Pi extension the way Pi does: an npm install of the tarball
// with its runtime dependencies, then an import of its entry under Node. The
// source tests never touch the bundle, so a dependency the bundle cannot
// resolve at run time (1.15.0 bundled jsonc-parser's UMD build, which requires
// './impl/format' and fails to load) passes every other suite.

const root = resolve(import.meta.dir, '../../../..')
const piDir = join(root, 'packages', 'pi')
if (!existsSync(join(piDir, 'dist', 'index.js')))
  throw new Error(
    'packages/pi/dist/index.js is missing: run `bun run build` first',
  )
const consumer = installPackedPackages([piDir])
afterAll(() => rmSync(dirname(consumer), { recursive: true, force: true }))

// Pi itself supplies these peers. Link the workspace's copies rather than
// download them; they are what the extension is built and tested against.
for (const name of ['pi-ai', 'pi-coding-agent', 'pi-tui']) {
  const target = join(consumer, 'node_modules', '@earendil-works', name)
  mkdirSync(dirname(target), { recursive: true })
  if (!existsSync(target))
    symlinkSync(join(root, 'node_modules', '@earendil-works', name), target)
}

describe('Pi packaging', () => {
  test('the packed extension loads under Node with only its declared dependencies', () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        "const m = await import('@cortexkit/pi-openai-auth'); console.log(typeof m.default)",
      ],
      { cwd: consumer, encoding: 'utf8' },
    )
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('function')
  })
})
