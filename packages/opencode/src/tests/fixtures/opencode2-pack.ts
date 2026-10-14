// Packs `@cortexkit/opencode-openai-auth` from its current build output and
// installs it into a scratch npm consumer with its runtime dependencies.
// Native private-file IO stays external to the bundles, so extracting just
// the host's tarball would not reproduce a working consumer installation.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

export function installPackedPackages(
  sources: string[],
  root = mkdtempSync(join(tmpdir(), 'oai-pack-')),
): string {
  const packs = join(root, 'packs')
  mkdirSync(packs, { recursive: true })
  const tarballs = sources.map((source) => {
    // Packing must not rebuild; it packs the build under test.
    const packed = JSON.parse(
      run(
        'npm',
        ['pack', '--pack-destination', packs, '--ignore-scripts', '--json'],
        source,
      ),
    ) as { filename: string }[]
    if (packed.length !== 1 || !packed[0]?.filename)
      throw new Error(`npm pack returned no single tarball for ${source}`)
    return join(packs, packed[0].filename)
  })
  const consumer = join(root, 'consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), '{"private":true}')
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      // Host peers are supplied by OpenCode or Pi, not by these bundles.
      '--legacy-peer-deps',
      ...tarballs,
    ],
    consumer,
  )
  return consumer
}

/** Installs the built plugin and its runtime dependencies into an empty consumer. */
export function installPackedPlugin(
  root = mkdtempSync(join(tmpdir(), 'oai-pack-')),
): { consumer: string; packageDir: string } {
  if (!existsSync(join(PACKAGE_DIR, 'dist', 'v2', 'server.js')))
    throw new Error(
      'packages/opencode/dist/v2/server.js is missing: run `bun run build` first',
    )
  const consumer = installPackedPackages([PACKAGE_DIR], root)
  const packageDir = join(consumer, 'node_modules', ...PACKAGE_NAME.split('/'))
  return { consumer, packageDir }
}
