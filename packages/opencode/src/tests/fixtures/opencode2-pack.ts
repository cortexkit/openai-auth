// Packs `@cortexkit/opencode-openai-auth` from its current build output and
// installs the tarball into a scratch consumer directory, the way npm lays a
// package out (`node_modules/<name>` from the tarball's `package/` folder).
// No dependency is installed beside it: the server and root bundles inline
// everything they import, which is what the packaging test checks.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const PACKAGE_DIR = resolve(import.meta.dir, '../../..')
export const PACKAGE_NAME = '@cortexkit/opencode-openai-auth'

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`,
    )
  return result.stdout
}

/** The consumer directory; its `node_modules` holds only this package. */
export function installPackedPlugin(
  root = mkdtempSync(join(tmpdir(), 'oai-pack-')),
): { consumer: string; packageDir: string } {
  if (!existsSync(join(PACKAGE_DIR, 'dist', 'v2', 'server.js')))
    throw new Error(
      'packages/opencode/dist/v2/server.js is missing: run `bun run build` first',
    )
  const packs = join(root, 'packs')
  mkdirSync(packs, { recursive: true })
  // --ignore-scripts: packing must not rebuild; it packs the build under test.
  run(
    'bun',
    ['pm', 'pack', '--destination', packs, '--ignore-scripts', '--quiet'],
    PACKAGE_DIR,
  )
  const tarball = readdirSync(packs).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error(`bun pm pack wrote no tarball into ${packs}`)
  const consumer = join(root, 'consumer')
  const packageDir = join(consumer, 'node_modules', ...PACKAGE_NAME.split('/'))
  mkdirSync(packageDir, { recursive: true })
  run(
    'tar',
    ['-xzf', join(packs, tarball), '-C', packageDir, '--strip-components=1'],
    root,
  )
  return { consumer, packageDir }
}
